/**
 * dsh-ai-reader — 浏览器半侧（client.js）
 * ============================================================================
 * 职责
 *   DSH Web GUI 内的「AI 阅读助手」主面板（`main` key = ai-reader）与左侧栏入口
 *   （`sidebar.panellist` id = ai-reader，order = 20）。整页双栏：
 *     左栏：URL 抓取文章（POST /dsh-ai-reader/article）→ 阅读排版；或「粘贴正文」本地模式。
 *     右栏：AI 解读线程。快捷问题 / 追问走 POST /dsh-ai-reader/analyze（SSE 流式），
 *           自写 Markdown 渲染器增量渲染；支持停止、重试、清空。
 *
 * 注册方式（普通副作用脚本，不能有顶层 import/export）
 *   window.__ModuleLoader__.load({ id:'dsh-ai-reader', factory(require) {...} })
 *   factory 内只 require('react')，不依赖任何 Harness 客户端包；返回
 *   { name:'ai-reader', inject:['slots','locale'], apply }。
 *
 * 核心交互
 *   在左栏文章容器内选中文字 → 浮动「解读这段」按钮（position:fixed，按
 *   range.getBoundingClientRect() 定位并夹在视口内）→ 追加 user 消息（含 > 引用
 *   选段）→ 立即流式分析；Cmd/Ctrl+J 等价点击。流式期间可停止；失败可重试。
 *
 * 知识库联动（CONTRACT §11）
 *   与同机的 dsh-knowledge-base 插件（面板 id 'kb'、HTTP 前缀 /dsh-kb）联动：
 *   右栏「知识库」开关、分析前 search→page 取参考页随 /analyze 发送、回答后渲染
 *   「参考：[标题]」chips、文章加载后自动关联相关知识、文章头「存入知识库」（job
 *   轮询）、点击 chip 在左栏预览 KB 页面。KB 未安装 / 未初始化时全部静默降级。
 *
 * 样式约束
 *   全部样式由组件内渲染的 <style> 提供（选择器统一 .air- 前缀，卸载即移除），
 *   颜色只用第 4 节列出的 --dsw-alias-* / --dsh-* 主题变量，不写死颜色，浅/深色
 *   自动适配。macOS 桌面端顶部留白用 html[data-platform='darwin'] .air-root 处理；
 *   窄窗口（≤980px）左右改上下堆叠。
 *
 * 健壮性约定
 *   - 所有 fetch 均 try/catch，组件不向上抛错（另有 PanelBoundary 兜底）。
 *   - article / thread / split / 阅读偏好放在模块级 cache，面板切换后恢复；阅读偏好另用
 *     try/catch 包住的 localStorage（key dsh-ai-reader:prefs）持久化，不可用时静默降级。
 *   - 不直接注入 HTML 字符串，Markdown 渲染器返回 React 元素。
 *   - 卸载 / 切换 / 清空时 abort 进行中的请求，避免 setState-after-unmount。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-ai-reader',

    /**
     * DSH 客户端插件 factory：注入 react 平台种子模块，组装组件，返回插件三件套。
     * @param {(id: string) => any} require 平台种子模块加载器（此处只用 'react'）。
     * @returns {{ name: string, inject: string[], apply: (ctx: any) => void }}
     */
    factory(require) {
      // ---- 平台种子模块（只允许 react） --------------------------------------
      const React = require('react')
      const { useState, useEffect, useRef, useCallback, useMemo } = React
      const useLayoutEffect = React.useLayoutEffect || useEffect
      const h = React.createElement

      // ---- 恒定标识（与 CONTRACT.md 第 1 节一致） ---------------------------
      const NS = 'ai-reader'
      const PANEL_ID = 'ai-reader'
      const ORIGIN = '/dsh-ai-reader'
      // Reference layout: reading takes about two thirds of the available panel.
      const DEFAULT_SPLIT = 68

      // ---- 模块级缓存：面板切走再切回时恢复现场（会话内；阅读偏好另做持久化） --
      /** @type {{ article: any, thread: any[], split: number, prefs: { fontSize: number, width: number, kbEnabled: boolean, autoSave: boolean } }} */
      const cache = { article: null, thread: [], split: DEFAULT_SPLIT, prefs: { fontSize: 2, width: 2, kbEnabled: true, autoSave: false, webEnabled: true }, readerScroll: null, translation: null, articleEditor: null, kbIngested: {} }

      // ---- 外部打开握手（dsh-ai-browser → AI 阅读助手） ---------------------
      /**
       * 外部插件（AI 浏览器）请求打开一篇文章时的挂起位与已挂载订阅者。
       * 时序：浏览器 dispatch window 事件 'dsh-ai-reader:open' → 这里记录；
       * 阅读面板已挂载就立刻打开，尚未挂载（首次进入）则挂起，等面板挂载后消费。
       * @type {{ pending: { url: string, title: string, from: string } | null, handler: ((request: { url: string, title: string, from: string }) => void) | null }}
       */
      const externalOpen = { pending: null, handler: null }

      const MAX_PROVIDED_HTML_BYTES = 2 * 1024 * 1024

      function publicRssUrl(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 4096) return ''
        try {
          const url = new URL(value.trim())
          if (!/^https?:$/.test(url.protocol) || url.username || url.password) return ''
          const host = url.hostname.toLowerCase().replace(/\.+$/, '')
          if (!host.includes('.') || host.startsWith('[') || host === 'localhost'
            || /\.(?:localhost|local|internal|test|invalid)$/.test(host)) return ''
          if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const parts = host.split('.').map(Number)
            const a = parts[0], b = parts[1]
            if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
              || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0)
              || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return ''
          }
          url.hash = ''
          return url.href
        } catch (error) { return '' }
      }

      function wechatContentUrl(value) {
        if (typeof value !== 'string' || value.length > 4096) return ''
        try {
          const url = new URL(value.trim())
          if (!/^https?:$/.test(url.protocol) || url.username || url.password
            || url.port
            || url.hostname.toLowerCase().replace(/\.$/, '') !== 'mp.weixin.qq.com'
            || !/^\/s(?:\/[^/]+)?\/?$/.test(url.pathname)) return ''
          if (!/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
            && !(/^\/s\/?$/.test(url.pathname) && url.searchParams.get('__biz')
              && /^\d+$/.test(url.searchParams.get('mid') || '') && /^\d+$/.test(url.searchParams.get('idx') || ''))) return ''
          return url.href
        } catch (error) { return '' }
      }

      function publisherContentUrls(feedValue, contentValue) {
        try {
          if (typeof feedValue !== 'string' || typeof contentValue !== 'string' || contentValue.length > 4096) return null
          const feed = new URL(feedValue.trim()), content = new URL(contentValue.trim())
          if (feed.href !== 'https://www.beating.news/' || feed.username || feed.password
            || content.origin !== 'https://www.beating.news' || content.username || content.password
            || !/^\/news\/\d+$/.test(content.pathname) || content.search || content.hash) return null
          return { feedUrl: feed.href, contentUrl: content.href }
        } catch (error) { return null }
      }

      function normalizeProvidedContent(raw, url) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['rss', 'publisher'].includes(raw.kind)
          || !wechatContentUrl(url) || typeof raw.html !== 'string' || !raw.html.trim()) return null
        if (raw.html.length > MAX_PROVIDED_HTML_BYTES || new TextEncoder().encode(raw.html).length > MAX_PROVIDED_HTML_BYTES) return null
        const urls = raw.kind === 'publisher' ? publisherContentUrls(raw.feedUrl, raw.contentUrl) : { feedUrl: publicRssUrl(raw.feedUrl) }
        if (!urls || !urls.feedUrl) return null
        const date = typeof raw.publishedAt === 'string' && raw.publishedAt.length <= 100 ? new Date(raw.publishedAt) : null
        return {
          kind: raw.kind, html: raw.html, ...urls,
          publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : '',
          accountName: typeof raw.accountName === 'string' ? raw.accountName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '',
        }
      }

      /**
       * 记录 / 派发一个外部打开请求；payload 缺失 url 时忽略（绝不抛错）。
       * @param {any} payload window 事件的 detail（{ url, title?, from? }）。
       * @returns {void}
       */
      function dispatchExternalOpen(payload) {
        if (!payload || typeof payload !== 'object') return
        const url = typeof payload.url === 'string' ? payload.url.trim() : ''
        if (!url) return
        const request = {
          url: url,
          title: typeof payload.title === 'string' ? payload.title : '',
          from: typeof payload.from === 'string' ? payload.from : '',
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'content')) {
          const content = normalizeProvidedContent(payload.content, url)
          if (!content) return
          request.content = content
        }
        if (externalOpen.handler) {
          try {
            externalOpen.handler(request)
          } catch (error) {
            // 外部握手失败不影响阅读器本身
          }
          return
        }
        externalOpen.pending = request
      }

      /**
       * 订阅外部打开请求；挂载时先消费此前挂起的请求，返回取消订阅函数。
       * @param {(request: { url: string, title: string, from: string }) => void} handler 打开回调。
       * @returns {() => void} 取消订阅。
       */
      function subscribeExternalOpen(handler) {
        externalOpen.handler = handler
        const pending = externalOpen.pending
        if (pending) {
          externalOpen.pending = null
          try {
            handler(pending)
          } catch (error) {
            // 打开失败由阅读器自身错误条提示
          }
        }
        return function () {
          if (externalOpen.handler === handler) externalOpen.handler = null
        }
      }

      // 消息 id 自增序列（仅用于 React key / 定位，无业务含义）
      let idSequence = 0
      /**
       * 生成一个在本次页面生命周期内唯一的消息 id。
       * @param {string} prefix 前缀（user / assistant）。
       * @returns {string}
       */
      function nextId(prefix) {
        idSequence += 1
        return prefix + '-' + idSequence.toString(36) + '-' + Date.now().toString(36)
      }

      // ---- 阅读偏好：正文字号 / 版心宽度（localStorage 持久化 + 模块级 cache 兜底）--
      const PREFS_STORAGE_KEY = 'dsh-ai-reader:prefs'      /** 正文字号三档：小 14px / 标准 15px / 大 17px（项目选择）（行高随字号 1.75 / 1.8 / 1.85）。 */
      const FONT_PREFS = [
        { level: 1, size: 14, lineHeight: 1.75, labelKey: 'reader.fontSize.small' },
        { level: 2, size: 15, lineHeight: 1.8, labelKey: 'reader.fontSize.normal' },
        { level: 3, size: 17, lineHeight: 1.85, labelKey: 'reader.fontSize.large' },
      ]
      /** 版心宽度三档：窄 620 / 标准 700 / 宽 820（px）。 */
      const WIDTH_PREFS = [
        // gutter 决定正文两侧留白：即使拖窄分栏后可用宽度小于 max-width，
        // 三档也能让行宽产生肉眼可见的变化；宽列场景再由 max-width 封顶。
        { level: 1, width: 620, gutter: 'clamp(24px,8%,72px)', labelKey: 'reader.width.narrow' },
        { level: 2, width: 700, gutter: 'clamp(16px,4%,32px)', labelKey: 'reader.width.normal' },
        { level: 3, width: 820, gutter: 'clamp(12px,2%,28px)', labelKey: 'reader.width.wide' },
      ]

      /**
       * 校验 / 归一化阅读偏好：字号与版心只接受 1/2/3 档，非法值回落到标准档；
       * kbEnabled 只接受 boolean，缺省 / 非法一律 true（知识库默认开启）；
       * autoSave 只接受 boolean，缺省 / 非法一律 false（自动保存默认关闭，契约 §13.3）。
       * @param {any} candidate 任意来源的偏好对象。
       * @returns {{ fontSize: number, width: number, kbEnabled: boolean, autoSave: boolean }}
       */
      function sanitizePrefs(candidate) {
        const source = candidate && typeof candidate === 'object' ? candidate : {}
        const fontSize = Number(source.fontSize)
        const width = Number(source.width)
        return {
          fontSize: fontSize === 1 || fontSize === 2 || fontSize === 3 ? fontSize : 2,
          width: width === 1 || width === 2 || width === 3 ? width : 2,
          kbEnabled: source.kbEnabled === false ? false : true,
          autoSave: source.autoSave === true,
          // 联网检索默认开启（用户 2026-11-01 需求）；显式 false 才关闭。
          webEnabled: source.webEnabled === false ? false : true,
        }
      }

      /**
       * 从 localStorage 读取阅读偏好；不存在 / 损坏 / 不可用时返回 null（静默降级）。
       * @returns {{ fontSize: number, width: number } | null}
       */
      function readStoredPrefs() {
        try {
          if (typeof localStorage === 'undefined' || !localStorage) return null
          const raw = localStorage.getItem(PREFS_STORAGE_KEY)
          if (!raw) return null
          return sanitizePrefs(JSON.parse(raw))
        } catch (error) {
          return null
        }
      }

      /**
       * 保存阅读偏好：写入模块级 cache（跨面板恢复），并尽力写入 localStorage。
       * 存储不可用（隐私模式 / 配额 / 被禁用）时只保留会话内偏好，不抛错。
       * @param {{ fontSize: number, width: number }} prefs 偏好。
       * @returns {{ fontSize: number, width: number }} 归一化后的偏好。
       */
      function saveStoredPrefs(prefs) {
        const safe = sanitizePrefs(prefs)
        cache.prefs = safe
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(safe))
          }
        } catch (error) {
          // localStorage 不可用时静默降级为会话内偏好
        }
        return safe
      }

      // 初始化时读取一次并写回缓存，后续面板挂载直接从 cache 取。
      cache.prefs = readStoredPrefs() || cache.prefs

      // ---- 快捷问题（按钮文案 + 发给模型的固定问法） -------------------------
      const QUICK_ACTIONS = [
        { id: 'summary', labelKey: 'quick.summary', promptKey: 'quick.summary.prompt' },
        { id: 'views', labelKey: 'quick.views', promptKey: 'quick.views.prompt' },
        { id: 'concepts', labelKey: 'quick.concepts', promptKey: 'quick.concepts.prompt' },
        { id: 'style', labelKey: 'quick.style', promptKey: 'quick.style.prompt' },
      ]

      // ======================================================================
      // 本地化字典（key 集合 zh / en 完全一致；所有可见文案都从这里取）
      // ======================================================================
      /** @type {Record<string, string>} 简体中文字典。 */
      const zh = {
        'panel.article': '文章',
        'panel.views': '阅读工作区',
        'panel.label': 'AI 阅读助手',
        'header.tagline': '阅读 · 选中 · 解读',
        'header.modelLoading': '正在连接服务…',
        'header.modelUnavailable': '服务未就绪',
        'header.modelUnknown': '未知模型',
        'header.modelTip': '当前分析模型；单次最多向模型注入约 {n} 字正文',
        'url.placeholder': '粘贴文章链接，回车打开…',
        'url.open': '打开',
        'url.opening': '打开中…',
        'url.empty': '请先输入文章链接',
        'mode.paste': '粘贴正文',
        'mode.url': '返回链接',
        'paste.titlePlaceholder': '标题（可选）',
        'paste.placeholder': '把文章正文粘贴到这里，空行分段…',
        'paste.load': '载入',
        'paste.empty': '请先粘贴一些正文',
        'paste.site': '粘贴文本',
        'paste.untitled': '未命名文章',
        'paste.hint': '支持纯文本和 Markdown。载入后可以选中文字，让 AI 解读。',
        'error.openFailed': '无法打开这篇文章',
        'error.analyzeFailed': 'AI 解读请求失败',
        'error.requestFailed': '请求失败，请稍后重试',
        'error.streamInterrupted': '流式响应中断，请重试',
        'error.emptyAnswer': '模型没有返回内容，请重试',
        'error.llm': '模型调用失败',
        'error.emptyArticle': '文章正文为空，无法分析',
        'error.noArticle': '请先打开一篇文章',
        'error.dismiss': '关闭错误提示',
        'reader.empty.title': '打开一篇文章开始阅读',
        'reader.empty.hint': '把 PDF / Word / PPT / Excel / EPUB / Markdown 文件拖进来，或粘贴链接 / 正文；读到有意思的段落，选中它，让 AI 为你解读。',
        'reader.home': '首页',
        'reader.homeHint': '返回首页：可拖入新文件、打开新链接或粘贴正文',
        'reader.region': '文章正文',
        'reader.table': '表格',
        'reader.loading': '正在抓取并提取正文…',
        'reader.truncated': '正文已截断',
        'reader.source': '原文',
        'reader.byline': '作者 {name}',
        'reader.chars': '约 {n} 字',
        'reader.readingTime': '约 {n} 分钟',
        'reader.shortArticle': '短文',
        'reader.viewImage': '查看大图',
        'reader.fontSize': 'Aa',
        'reader.appearance': '阅读显示',
        'reader.fontSize.title': '正文字号：{label}（点击切换）',
        'reader.fontSize.small': '小',
        'reader.fontSize.normal': '标准',
        'reader.fontSize.large': '大',
        'reader.width': '版心',
        'reader.width.title': '版心宽度：{label}（点击切换）',
        'reader.width.narrow': '窄',
        'reader.width.normal': '标准',
        'reader.width.wide': '宽',
        'file.open': '打开文件',
        'file.dropTitle': '松开以打开文档',
        'file.dropHint': '支持 PDF / Word / PPT / Excel / EPUB / Markdown / 文本 等格式，最大 {n}',
        'file.parsing': '正在解析 {name}…',
        'file.multiple': '一次只能打开一个文件，已选择第一个',
        'file.unsupported': '不支持该文件格式',
        'file.tooLarge': '文件超过 {n}，无法打开',
        'file.extractFailed': '无法提取正文（可能是扫描版 PDF）',
        'file.failed': '打开文件失败，请重试',
        'file.invalid': '无法读取该文件',
        'file.sizeKb': '{n} KB',
        'file.sizeMb': '{n} MB',
        'file.format.pdf': 'PDF',
        'file.format.word': 'Word',
        'file.format.ppt': 'PPT',
        'file.format.excel': 'Excel',
        'file.format.epub': 'EPUB',
        'file.format.markdown': 'Markdown',
        'file.format.text': '文本',
        'file.format.html': 'HTML',
        'file.format.rtf': 'RTF',
        'file.format.odt': 'ODT',
        'file.format.csv': 'CSV',
        'file.format.json': 'JSON',
        'file.format.other': '其他',
        'selection.askLabel': '就选中的内容提问',
        'selection.questionPlaceholder': '问问这段文字（可选）',
        'selection.send': '发送问题',
        'selection.sendHint': '发送；不填问题则直接解读这段',
        'selection.selectedChars': '已选 {n} 字',
        'selection.close': '关闭提问框',
        'excerpt.action': '摘抄',
        'excerpt.note': '摘抄笔记',
        'excerpt.back': '返回阅读',
        'excerpt.backToQuestion': '返回提问',
        'excerpt.preview': '选中的原文',
        'excerpt.tags': '选择标签（至少一个）',
        'excerpt.newTag': '新标签，按回车添加',
        'excerpt.addTag': '添加标签',
        'excerpt.tagInvalid': '标签最多 32 个字符，不能包含换行或制表符',
        'excerpt.tagLimit': '每条摘抄最多选择 8 个标签',
        'excerpt.chooseTags': '请至少选择一个标签；新标签需先添加',
        'excerpt.save': '保存摘抄',
        'excerpt.saving': '保存中…',
        'excerpt.saved': '已追加到 {file}',
        'excerpt.saveFailed': '保存摘抄失败，请重试',
        'excerpt.retry': '重试',
        'excerpt.viewNote': '查看笔记',
        'excerpt.loadFailed': '无法读取摘抄笔记',
        'excerpt.loading': '正在读取摘抄笔记…',
        'excerpt.tagsLoading': '正在读取已有标签…',
        'excerpt.refresh': '刷新摘抄笔记',
        'excerpt.allTags': '全部标签',
        'excerpt.count': '{n} 条摘抄',
        'excerpt.empty': '还没有摘抄',
        'excerpt.emptyHint': '在文章里选中一段文字，点「摘抄」，选择标签后保存。',
        'excerpt.noMatch': '这个标签下还没有摘抄',
        'excerpt.tooLong': '单条摘抄最多 20,000 字，请缩小选区',
        'excerpt.delete': '删除',
        'excerpt.deleteConfirm': '确认删除',
        'excerpt.deleteCancel': '取消',
        'excerpt.deleteHint': '将从摘抄笔记中删除这条内容，此操作无法撤销。',
        'excerpt.deleteLabel': '删除摘抄：{title}',
        'excerpt.deleteConfirmLabel': '确认删除摘抄：{title}',
        'excerpt.deleting': '删除中…',
        'excerpt.deleted': '已删除这条摘抄',
        'excerpt.deleteFailed': '删除失败，请重试',
        'shortcut.hint': '提示：选中正文后按 ⌘J / Ctrl+J 打开提问框。',
        'splitter.label': '调整左右栏宽度',
        'splitter.hint': '拖动调整左右栏宽度，双击恢复默认',
        'right.title': 'AI 解读',
        'right.clear': '清空',
        'right.cleared': '已清空对话',
        'right.undo': '撤销',
        'quick.summary': '全文摘要',
        'quick.summary.prompt': '请用 5~8 条要点总结整篇文章的核心内容，并给出一句话主旨。',
        'quick.views': '核心观点',
        'quick.views.prompt': '请提炼作者的核心观点与论证结构，指出关键证据与可能的薄弱环节。',
        'quick.concepts': '概念解释',
        'quick.concepts.prompt': '请解释这篇文章中出现的关键概念与背景知识，按重要性排序。',
        'quick.style': '写作手法',
        'quick.style.prompt': '请分析这篇文章的结构、叙事/论证技巧与语言风格，并举例。',
        'selection.translate': '翻译',
        'selection.translateHint': '把选中的内容翻译成简体中文',
        'translate.action': '译成中文',
        'translate.hint': '用 AI 把整篇文章翻译成简体中文，显示在左侧阅读区（可切回原文）',
        'translate.loading': '翻译中…',
        'translate.progress': '翻译中 · 第 {part}/{total} 部分',
        'translate.cancelled': '翻译已停止，当前译文不完整。可重新翻译。',
        'translate.cancel': '取消翻译',
        'translate.title': '中文翻译',
        'translate.badge': 'AI 翻译 · 品牌与常用英文术语保留英文',
        'translate.viewOriginal': '查看原文',
        'translate.viewTranslation': '查看译文',
        'translate.retry': '重试翻译',
        'translate.failed': '翻译失败，请重试',
        'translate.empty': '译文为空，请重试',
        'prompt.translatePrefix': '请把下面这段内容翻译成简体中文：',
        'prompt.translateRequirements': '要求：保持原意与语气，不总结、不省略；品牌、公司、产品、人名等项目名保留英文原文（如 DeepSeek 保持 DeepSeek，不要译成「深度求索」）；中国读者习惯直接用英文的术语保留英文，不要强行翻译（如 AI、AGI、LLM、GPU、API、Token、Agent、Prompt、OpenAI、GPT 等）；数学公式、代码、链接保持原样。只输出译文本身，不要添加解释、说明或「译文：」前缀。如果原文本来就是中文，请直接说明「原文已是中文」并用一句话概括。',
        'thread.empty.title': '问问这篇文章',
        'thread.empty.hint': '直接提问，或选中正文里的文字来解读。',
        'thread.aiName': 'AI',
        'thread.thinking': '思考中…',
        'thread.stopped': '已停止',
        'thread.retry': '重试',
        'composer.label': '向 AI 提问',
        'composer.placeholder': '输入你的问题…',
        'composer.placeholderNoArticle': '打开文章后提问',
        'composer.keys': 'Enter 发送 · Shift+Enter 换行',
        'composer.send': '发送',
        'composer.stop': '停止',
        'prompt.selectionPrefix': '请解读我在文章中选中的这段话：',
        'prompt.selectionRequirements': '请说明它的含义与作用、与上下文的关系，以及值得注意的细节与背景。',
        'prompt.selectionQuestion': '我的问题：',
        'crash.title': 'AI 阅读助手暂时无法显示',
        'crash.hint': '请切换面板后重试；如果问题持续，请查看控制台日志。',
        'kb.chip.label': '知识库',
        'kb.chip.on': '解读时参考知识库（点击关闭）',
        'kb.chip.off': '解读时不参考知识库（点击开启）',
        'kb.unavailable': '知识库不可用',
        'kb.related.title': '相关知识 {n}',
        'kb.related.expand': '展开相关知识',
        'kb.related.collapse': '收起相关知识',
        'kb.related.refresh': '刷新相关知识',
        'kb.openPanel': '打开知识库',
        'kb.searching': '检索知识库…',
        'kb.searchMiss': '未找到知识库参考，继续回答…',
        'kb.refs.label': '参考：',
        'kb.preview.back': '关闭知识库预览',
        'kb.preview.loading': '正在读取知识库页面…',
        'kb.preview.failed': '无法读取该知识库页面',
        'kb.preview.retry': '重试',
        'kb.preview.confidence': '置信度 {value}',
        'kb.preview.updated': '更新于 {time}',
        'kb.type.entity': '实体',
        'kb.type.topic': '主题',
        'kb.type.source': '来源',
        'kb.type.synthesis': '综合',
        'kb.type.original': '原文',
        'kb.type.excerpt': '摘抄',
        'kb.ingest.action': '存入知识库',
        'kb.ingest.hint': '把当前文章存入本地知识库',
        'kb.ingest.starting': '提交中…',
        'kb.ingest.checking': '检查是否已收录…',
        'kb.ingest.running': '存入中：{stage}',
        'kb.ingest.runningShort': '存入中…',
        'kb.ingest.done': '已存入 · {n} 页',
        'kb.ingest.exists': '已在知识库',
        'kb.ingest.retry': '重试存入',
        'kb.ingest.failed': '存入知识库失败',
        'kb.ingest.timeout': '存入超时（知识库后台仍会继续编译）',
        'kb.ingest.empty': '文章正文为空，无法存入',
        'kb.passage.action': '加入知识库',
        'kb.passage.hint': '让知识库分析选中的文字并保留出处',
        'kb.passage.unsupported': '选段分析需要新版知识库，请重启 DSH 以加载更新',
        'kb.passage.running': '知识库正在分析选段…',
        'kb.passage.done': '选段已分析并加入知识库',
        'kb.passage.exists': '选段已在知识库中',
        'kb.passage.failed': '选段加入知识库失败',
        'kb.passage.timeout': '等待分析超时，知识库仍可能在后台处理',
        'kb.passage.tooLong': '选段最多可包含 20,000 字，请缩小选区。',
        'kb.passage.view': '查看分析',
        // ---- 保存到本地 / 本地文稿（CONTRACT §13） ----
        'edit.action': '编辑正文',
        'edit.hint': '修改文字或移除图片，保存为本地文稿',
        'edit.title': '编辑正文',
        'edit.help': '直接修改文字；删除按钮可移除整段或图片。修改保存到本地文稿。',
        'edit.undo': '撤销修改',
        'edit.cancel': '取消编辑',
        'edit.save': '保存修改',
        'edit.saving': '保存修改中…',
        'edit.textLabel': '编辑第 {n} 个内容块',
        'edit.cellLabel': '编辑第 {n} 个表格，第 {row} 行第 {col} 列',
        'edit.deleteBlock': '删除第 {n} 个内容块',
        'edit.deleteImage': '删除第 {n} 张图片',
        'edit.delete': '删除',
        'edit.restore': '撤销删除',
        'edit.restoreImage': '还原第 {n} 张图片',
        'edit.restoreBlock': '还原第 {n} 个内容块',
        'edit.removed': '内容已移除',
        'edit.imageUnavailable': '图片预览不可用',
        'edit.empty': '至少保留一段文字或一张图片。',
        'edit.finishFirst': '请先保存或取消当前编辑。',
        'edit.failed': '保存失败，修改仍保留，可重试。',
        'edit.interrupted': '上次保存尚未确认，请重新保存。',
        'edit.local': '本地编辑',
        'reader.rssContent': 'RSS正文',
        'reader.publisherContent': '官网正文',
        'edit.changes': '{n} 处修改',
        'edit.noChanges': '暂无修改',
        'edit.saved': '修改已保存到本地文稿',
        'edit.wait': '当前任务完成后可编辑正文',
        'save.action': '保存到本地',
        'save.hint': '把当前文章完整保存到本地（Markdown + 离线 HTML + JSON）',
        'save.saving': '保存中…',
        'save.done': '已保存',
        'save.retry': '重试保存',
        'save.failed': '保存失败',
        'save.empty': '文章正文为空，无法保存',
        'save.tooLarge': '文章或图片过大，无法保存（上限 {n}）',
        'save.unavailable': '保存功能不可用，请更新或重载插件后重试',
        'save.notice.done': '已保存到 {dir}',
        'save.notice.unchanged': '已保存过，内容未变化',
        'save.notice.images': '· {n} 张图片已内联',
        'save.openFolder': '打开文件夹',
        'save.openLibrary': '查看本地文稿',
        'save.update': '更新保存',
        'save.updateHint': '文章或对话有更新时，再次点击可更新本地文稿与笔记',
        'save.notice.note': '· 含 {n} 轮对话笔记',
        'save.autoSave': '自动保存',
        'save.autoOn': '关闭自动保存（现在每篇文章打开后都会保存到本地）',
        'save.autoOff': '开启自动保存（每篇文章打开后自动保存到本地）',
        'save.autoSaved': '已自动保存',
        'save.dismiss': '关闭保存提示',
        'save.revealFailed': '无法打开文件夹',
        'library.openHint': '本地文稿：{n} 篇',
        'library.title': '本地文稿',
        'library.count': '{n} 篇',
        'library.back': '返回文章',
        'library.refresh': '刷新本地文稿',
        'library.openFolder': '打开文件夹',
        'library.loading': '正在读取本地文稿…',
        'library.emptyTitle': '还没有保存过文章',
        'library.emptyHint': '阅读时点文章头的「保存到本地」，或打开「自动保存」，文章就会完整保存到本地，之后可以在这里重新打开。',
        'library.error': '无法读取本地文稿',
        'library.retry': '重试',
        'library.itemHint': '在阅读器中打开这篇文稿',
        'library.delete': '删除',
        'library.deleteConfirm': '确认删除',
        'library.deleting': '删除中…',
        'library.deleted': '已删除',
        'library.deleteFailed': '删除失败',
        'library.openFailed': '无法打开这篇文稿',
        'library.saveTime': '保存于 {time}',
        'library.chars': '{n} 字',
        'library.images': '{n} 张图',
        'library.blocks': '{n} 块',
        'library.messages': '{n} 轮对话',
        'library.itemActions': '文稿操作',
        // ---- 联网检索（CONTRACT §14） ----
        'web.chip.label': '联网',
        'web.chip.on': '联网检索已开启：回答会参考网络资料（点击关闭）',
        'web.chip.off': '联网检索已关闭（点击开启，回答会参考网络资料）',
        'web.unavailable': '联网服务不可用（DSH 未配置搜索提供方）',
        'web.searching': '联网检索中…',
        'web.missSearching': '联网未找到相关资料，继续回答…',
        'web.searchFailed': '联网检索失败，继续回答…',
        'web.refs.label': '联网参考：',
        'web.failed': '联网检索失败，已直接回答',
        'web.noResult': '联网未找到相关资料',
      }

      /** @type {Record<string, string>} English dictionary (same key set as zh). */
      const en = {
        'panel.article': 'Article',
        'panel.views': 'Reading workspace',
        'panel.label': 'AI Reading Assistant',
        'header.tagline': 'Read · Select · Understand',
        'header.modelLoading': 'Connecting…',
        'header.modelUnavailable': 'Service unavailable',
        'header.modelUnknown': 'Unknown model',
        'header.modelTip': 'Active analysis model; up to about {n} characters of the article are sent per request',
        'url.placeholder': 'Paste an article URL and press Enter…',
        'url.open': 'Open',
        'url.opening': 'Opening…',
        'url.empty': 'Enter an article URL first',
        'mode.paste': 'Paste text',
        'mode.url': 'Back to URL',
        'paste.titlePlaceholder': 'Title (optional)',
        'paste.placeholder': 'Paste the article body here; separate paragraphs with blank lines…',
        'paste.load': 'Load',
        'paste.empty': 'Paste some text first',
        'paste.site': 'Pasted text',
        'paste.untitled': 'Untitled article',
        'paste.hint': 'Supports plain text and Markdown. After loading, select any passage and let AI explain it.',
        'error.openFailed': 'Could not open this article',
        'error.analyzeFailed': 'The analysis request failed',
        'error.requestFailed': 'Request failed. Please try again.',
        'error.streamInterrupted': 'The stream was interrupted. Please retry.',
        'error.emptyAnswer': 'The model returned no content. Please retry.',
        'error.llm': 'The model call failed',
        'error.emptyArticle': 'The article has no body text to analyze',
        'error.noArticle': 'Open an article first',
        'error.dismiss': 'Dismiss error',
        'reader.empty.title': 'Open an article to start reading',
        'reader.empty.hint': 'Drop a PDF / Word / PPT / Excel / EPUB / Markdown file here, or paste a link / text. Select any passage and let AI explain it.',
        'reader.home': 'Home',
        'reader.homeHint': 'Back to home: drop a new file, open a new link, or paste text',
        'reader.region': 'Article body',
        'reader.table': 'Table',
        'reader.loading': 'Fetching and extracting the article…',
        'reader.truncated': 'Article truncated',
        'reader.source': 'Source',
        'reader.byline': 'By {name}',
        'reader.chars': '~{n} characters',
        'reader.readingTime': '~{n} min read',
        'reader.shortArticle': 'Short read',
        'reader.viewImage': 'View full size',
        'reader.fontSize': 'Aa',
        'reader.appearance': 'Reading appearance',
        'reader.fontSize.title': 'Body text size: {label} (click to cycle)',
        'reader.fontSize.small': 'Small',
        'reader.fontSize.normal': 'Standard',
        'reader.fontSize.large': 'Large',
        'reader.width': 'Width',
        'reader.width.title': 'Reading width: {label} (click to cycle)',
        'reader.width.narrow': 'Narrow',
        'reader.width.normal': 'Standard',
        'reader.width.wide': 'Wide',
        'file.open': 'Open file',
        'file.dropTitle': 'Drop to open document',
        'file.dropHint': 'Supports PDF / Word / PPT / Excel / EPUB / Markdown / text and more, up to {n}',
        'file.parsing': 'Parsing {name}…',
        'file.multiple': 'Only one file at a time — using the first',
        'file.unsupported': 'Unsupported file format',
        'file.tooLarge': 'File exceeds {n}',
        'file.extractFailed': 'Could not extract text (it may be a scanned PDF)',
        'file.failed': 'Could not open the file. Please retry.',
        'file.invalid': 'Could not read this file',
        'file.sizeKb': '{n} KB',
        'file.sizeMb': '{n} MB',
        'file.format.pdf': 'PDF',
        'file.format.word': 'Word',
        'file.format.ppt': 'PPT',
        'file.format.excel': 'Excel',
        'file.format.epub': 'EPUB',
        'file.format.markdown': 'Markdown',
        'file.format.text': 'Text',
        'file.format.html': 'HTML',
        'file.format.rtf': 'RTF',
        'file.format.odt': 'ODT',
        'file.format.csv': 'CSV',
        'file.format.json': 'JSON',
        'file.format.other': 'File',
        'selection.askLabel': 'Ask about the selected text',
        'selection.questionPlaceholder': 'Ask about this passage (optional)',
        'selection.send': 'Send question',
        'selection.sendHint': 'Send; leave empty to explain this passage',
        'selection.selectedChars': '{n} chars selected',
        'selection.close': 'Close the ask box',
        'excerpt.action': 'Excerpt',
        'excerpt.note': 'Excerpt notes',
        'excerpt.back': 'Back to reading',
        'excerpt.backToQuestion': 'Back to question',
        'excerpt.preview': 'Selected passage',
        'excerpt.tags': 'Choose at least one tag',
        'excerpt.newTag': 'New tag; press Enter to add',
        'excerpt.addTag': 'Add tag',
        'excerpt.tagInvalid': 'Tags allow up to 32 characters and no line breaks or tabs',
        'excerpt.tagLimit': 'Choose up to 8 tags per excerpt',
        'excerpt.chooseTags': 'Choose at least one tag, and add any new tag first',
        'excerpt.save': 'Save excerpt',
        'excerpt.saving': 'Saving…',
        'excerpt.saved': 'Appended to {file}',
        'excerpt.saveFailed': 'Could not save the excerpt. Try again.',
        'excerpt.retry': 'Retry',
        'excerpt.viewNote': 'View notes',
        'excerpt.loadFailed': 'Could not read excerpt notes',
        'excerpt.loading': 'Loading excerpt notes…',
        'excerpt.tagsLoading': 'Loading existing tags…',
        'excerpt.refresh': 'Refresh excerpt notes',
        'excerpt.allTags': 'All tags',
        'excerpt.count': '{n} excerpts',
        'excerpt.empty': 'No excerpts yet',
        'excerpt.emptyHint': 'Select a passage in an article, choose Excerpt, then select tags and save.',
        'excerpt.noMatch': 'No excerpts with this tag',
        'excerpt.tooLong': 'Select a shorter passage; excerpts allow up to 20,000 characters',
        'excerpt.delete': 'Delete',
        'excerpt.deleteConfirm': 'Confirm delete',
        'excerpt.deleteCancel': 'Cancel',
        'excerpt.deleteHint': 'This excerpt will be removed from your notes. This cannot be undone.',
        'excerpt.deleteLabel': 'Delete excerpt: {title}',
        'excerpt.deleteConfirmLabel': 'Confirm delete excerpt: {title}',
        'excerpt.deleting': 'Deleting…',
        'excerpt.deleted': 'Excerpt deleted',
        'excerpt.deleteFailed': 'Could not delete the excerpt. Try again.',
        'shortcut.hint': 'Tip: with text selected, press ⌘J / Ctrl+J to open the ask box.',
        'splitter.label': 'Resize the panes',
        'splitter.hint': 'Drag to resize the panes; double-click to reset',
        'right.title': 'AI Analysis',
        'right.clear': 'Clear',
        'right.cleared': 'Conversation cleared',
        'right.undo': 'Undo',
        'quick.summary': 'Summary',
        'quick.summary.prompt': 'Summarize the core content of the article in 5–8 bullet points and give its central idea in one sentence.',
        'quick.views': 'Key points',
        'quick.views.prompt': 'Extract the author’s core argument and reasoning structure, identify the key evidence, and point out possible weak spots.',
        'quick.concepts': 'Concepts',
        'quick.concepts.prompt': 'Explain the key concepts and background knowledge in this article, ordered by importance.',
        'quick.style': 'Writing style',
        'quick.style.prompt': 'Analyze the article’s structure, narrative or argumentative techniques, and language style, with examples.',
        'selection.translate': 'Translate',
        'selection.translateHint': 'Translate the selected text into Simplified Chinese',
        'translate.action': 'Translate',
        'translate.hint': 'Translate the whole article into Simplified Chinese in the left reading pane (switch back to the original anytime)',
        'translate.loading': 'Translating…',
        'translate.progress': 'Translating · part {part}/{total}',
        'translate.cancelled': 'Translation stopped. This is a partial translation. You can retry.',
        'translate.cancel': 'Cancel translation',
        'translate.title': 'Chinese translation',
        'translate.badge': 'AI translation · brands and common English terms kept as-is',
        'translate.viewOriginal': 'View original',
        'translate.viewTranslation': 'View translation',
        'translate.retry': 'Retry translation',
        'translate.failed': 'Translation failed. Please try again',
        'translate.empty': 'Empty translation. Please try again',
        'prompt.translatePrefix': 'Translate the following passage into Simplified Chinese:',
        'prompt.translateRequirements': 'Requirements: preserve the original meaning and tone; do not summarize or omit; keep brand, company, product, people and project names in English (e.g. DeepSeek stays DeepSeek, never translate it to 深度求索); keep English terms that Chinese readers commonly use as-is (e.g. AI, AGI, LLM, GPU, API, Token, Agent, Prompt, OpenAI, GPT); keep math formulas, code and links unchanged. Output only the translation itself, with no explanations or "translation:" prefixes. If the passage is already in Chinese, simply say the original is already Chinese and summarize it in one sentence.',
        'thread.empty.title': 'Ask about this article',
        'thread.empty.hint': 'Type a question, or select a passage in the article for an explanation.',
        'thread.aiName': 'AI',
        'thread.thinking': 'Thinking…',
        'thread.stopped': 'Stopped',
        'thread.retry': 'Retry',
        'composer.label': 'Ask AI about the article',
        'composer.placeholder': 'Type your question…',
        'composer.placeholderNoArticle': 'Open an article to ask a question',
        'composer.keys': 'Enter to send · Shift+Enter for a new line',
        'composer.send': 'Send',
        'composer.stop': 'Stop',
        'prompt.selectionPrefix': 'Please explain this passage I selected in the article:',
        'prompt.selectionRequirements': 'Cover what it means and does, how it relates to the surrounding context, and any noteworthy details or background.',
        'prompt.selectionQuestion': 'My question: ',
        'crash.title': 'AI Reading Assistant cannot be displayed right now',
        'crash.hint': 'Switch panels and try again; if the problem persists, check the console log.',
        'kb.chip.label': 'Knowledge',
        'kb.chip.on': 'Knowledge base is used when analyzing (click to turn off)',
        'kb.chip.off': 'Knowledge base is not used when analyzing (click to turn on)',
        'kb.unavailable': 'Knowledge base unavailable',
        'kb.related.title': 'Related knowledge: {n}',
        'kb.related.expand': 'Expand related knowledge',
        'kb.related.collapse': 'Collapse related knowledge',
        'kb.related.refresh': 'Refresh related knowledge',
        'kb.openPanel': 'Open knowledge base',
        'kb.searching': 'Searching knowledge base…',
        'kb.searchMiss': 'No knowledge reference found, continuing…',
        'kb.refs.label': 'References: ',
        'kb.preview.back': 'Close knowledge preview',
        'kb.preview.loading': 'Loading knowledge page…',
        'kb.preview.failed': 'Could not load this knowledge page',
        'kb.preview.retry': 'Retry',
        'kb.preview.confidence': 'Confidence {value}',
        'kb.preview.updated': 'Updated {time}',
        'kb.type.entity': 'Entity',
        'kb.type.topic': 'Topic',
        'kb.type.source': 'Source',
        'kb.type.synthesis': 'Synthesis',
        'kb.type.original': 'Original',
        'kb.type.excerpt': 'Excerpt',
        'kb.ingest.action': 'Save to knowledge base',
        'kb.ingest.hint': 'Save this article to your local knowledge base',
        'kb.ingest.starting': 'Submitting…',
        'kb.ingest.checking': 'Checking knowledge base…',
        'kb.ingest.running': 'Saving: {stage}',
        'kb.ingest.runningShort': 'Saving…',
        'kb.ingest.done': 'Saved · {n} pages',
        'kb.ingest.exists': 'Already in knowledge base',
        'kb.ingest.retry': 'Retry saving',
        'kb.ingest.failed': 'Could not save to knowledge base',
        'kb.ingest.timeout': 'Saving timed out (the knowledge base keeps compiling in the background)',
        'kb.ingest.empty': 'The article has no body text to save',
        'kb.passage.action': 'Add to knowledge base',
        'kb.passage.hint': 'Analyze the selected passage and keep its source',
        'kb.passage.unsupported': 'Passage analysis requires the updated knowledge base. Restart DSH to load it.',
        'kb.passage.running': 'Analyzing the selected passage…',
        'kb.passage.done': 'Passage analyzed and added to the knowledge base',
        'kb.passage.exists': 'Passage is already in the knowledge base',
        'kb.passage.failed': 'Could not add the passage to the knowledge base',
        'kb.passage.timeout': 'Timed out waiting for analysis. It may still be running.',
        'kb.passage.tooLong': 'Select up to 20,000 characters.',
        'kb.passage.view': 'View analysis',
        // ---- Save locally / local library (CONTRACT §13) ----
        'edit.action': 'Edit article',
        'edit.hint': 'Edit text or remove images, then save a local copy',
        'edit.title': 'Editing article',
        'edit.help': 'Edit text directly, or remove a paragraph or image. Changes are saved to your local library.',
        'edit.undo': 'Undo change',
        'edit.cancel': 'Cancel editing',
        'edit.save': 'Save changes',
        'edit.saving': 'Saving changes…',
        'edit.textLabel': 'Edit content block {n}',
        'edit.cellLabel': 'Edit table {n}, row {row}, column {col}',
        'edit.deleteBlock': 'Delete content block {n}',
        'edit.deleteImage': 'Delete image {n}',
        'edit.delete': 'Delete',
        'edit.restore': 'Restore',
        'edit.restoreImage': 'Restore image {n}',
        'edit.restoreBlock': 'Restore content block {n}',
        'edit.removed': 'Content removed',
        'edit.imageUnavailable': 'Image preview unavailable',
        'edit.empty': 'Keep at least one text block or image.',
        'edit.finishFirst': 'Save or cancel your current edits first.',
        'edit.failed': 'Could not save. Your edits are still here; try again.',
        'edit.interrupted': 'The previous save was not confirmed. Save again.',
        'edit.local': 'Locally edited',
        'reader.rssContent': 'RSS content',
        'reader.publisherContent': 'Publisher content',
        'edit.changes': '{n} changes',
        'edit.noChanges': 'No changes yet',
        'edit.saved': 'Changes saved to your local library',
        'edit.wait': 'Finish the current task before editing',
        'save.action': 'Save locally',
        'save.hint': 'Save the complete article locally (Markdown + offline HTML + JSON)',
        'save.saving': 'Saving…',
        'save.done': 'Saved',
        'save.retry': 'Retry saving',
        'save.failed': 'Could not save locally',
        'save.empty': 'The article has no body text to save',
        'save.tooLarge': 'The article or its images are too large to save (limit {n})',
        'save.unavailable': 'Saving is unavailable — reload or update the plugin and try again',
        'save.notice.done': 'Saved to {dir}',
        'save.notice.unchanged': 'Already saved; content unchanged',
        'save.notice.images': '· {n} images embedded',
        'save.openFolder': 'Open folder',
        'save.openLibrary': 'Open local library',
        'save.update': 'Update saved copy',
        'save.updateHint': 'Click again to update the local copy and note after article or conversation changes',
        'save.notice.note': '· {n} conversation turns',
        'save.autoSave': 'Auto-save',
        'save.autoOn': 'Turn off auto-save (every article is saved locally when opened)',
        'save.autoOff': 'Turn on auto-save (save every article locally when opened)',
        'save.autoSaved': 'Auto-saved',
        'save.dismiss': 'Dismiss save notice',
        'save.revealFailed': 'Could not open the folder',
        'library.openHint': 'Local library: {n} saved',
        'library.title': 'Local library',
        'library.count': '{n} saved',
        'library.back': 'Back to article',
        'library.refresh': 'Refresh local library',
        'library.openFolder': 'Open folder',
        'library.loading': 'Loading local library…',
        'library.emptyTitle': 'No saved articles yet',
        'library.emptyHint': 'Use "Save locally" in the article header, or turn on "Auto-save", to keep complete copies of articles here and reopen them later.',
        'library.error': 'Could not read the local library',
        'library.retry': 'Retry',
        'library.itemHint': 'Open this saved article in the reader',
        'library.delete': 'Delete',
        'library.deleteConfirm': 'Confirm delete',
        'library.deleting': 'Deleting…',
        'library.deleted': 'Deleted',
        'library.deleteFailed': 'Could not delete',
        'library.openFailed': 'Could not open this saved article',
        'library.saveTime': 'Saved {time}',
        'library.chars': '{n} chars',
        'library.images': '{n} images',
        'library.blocks': '{n} blocks',
        'library.messages': '{n} conversation entries',
        'library.itemActions': 'Saved article actions',
        // ---- Web search (CONTRACT §14) ----
        'web.chip.label': 'Web',
        'web.chip.on': 'Web search is on — answers may cite web sources (click to turn off)',
        'web.chip.off': 'Web search is off (click to turn on)',
        'web.unavailable': 'Web search unavailable (no search provider configured in DSH)',
        'web.searching': 'Searching the web…',
        'web.missSearching': 'No web results found — answering directly…',
        'web.searchFailed': 'Web search failed — answering directly…',
        'web.refs.label': 'Web sources:',
        'web.failed': 'Web search failed — answered directly',
        'web.noResult': 'No web results found',
      }

      // ======================================================================
      // 通用工具
      // ======================================================================

      /**
       * 把模板里的 {name} 占位替换为参数值；缺少参数时保留占位。
       * @param {string} template 文案模板。
       * @param {Record<string, any>} [params] 参数表。
       * @returns {string}
       */
      function interpolate(template, params) {
        if (!params) return template
        return String(template).replace(/\{(\w+)\}/g, function (match, name) {
          return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        })
      }

      /**
       * 兜底翻译函数：locale 服务不可用（异常装配）时按浏览器语言查本地字典。
       * @param {string} key 文案 key。
       * @param {Record<string, any>} [params] 插值参数。
       * @returns {string}
       */
      function fallbackT(key, params) {
        const language = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : 'zh'
        const dict = language.toLowerCase().indexOf('zh') === 0 ? zh : en
        const text = dict[key] !== undefined ? dict[key] : en[key] !== undefined ? en[key] : key
        return interpolate(text, params)
      }

      /**
       * 从 slot 注入的 props 里取 t；取不到就退化为 fallbackT（绝不让面板渲染失败）。
       * @param {any} props slot 注入的 props。
       * @returns {(key: string, params?: Record<string, any>) => string}
       */
      function resolveT(props) {
        if (props && typeof props.t === 'function') return props.t
        return fallbackT
      }

      /**
       * 把异常转换成可展示的文案。
       * @param {any} error 捕获到的异常。
       * @param {string} fallback 无法提取时的兜底文案。
       * @returns {string}
       */
      function errorMessage(error, fallback) {
        if (error && typeof error.message === 'string' && error.message) return error.message
        if (typeof error === 'string' && error) return error
        return fallback
      }

      /**
       * 只放行 http(s) / mailto 链接，避免把 javascript: 等协议塞进 Markdown。
       * @param {string} raw 原始 URL。
       * @returns {string | null}
       */
      function safeHref(raw) {
        const value = String(raw == null ? '' : raw).trim()
        if (/^https?:\/\//i.test(value)) return value
        if (/^mailto:/i.test(value)) return value
        return null
      }

      function safeArticleHref(value) {
        if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return null
        try { return new URL(value).hostname ? value : null } catch (error) { return null }
      }

      /**
       * 读取 HTTP 错误响应体里的错误文案（Host 统一 { ok:false, error:{ code, message } }）。
       * @param {Response} response fetch 响应。
       * @param {string} fallback 兜底文案。
       * @returns {Promise<string>}
       */
      async function readErrorText(response, fallback) {
        let text = ''
        try {
          text = await response.text()
        } catch (error) {
          return fallback
        }
        if (!text) return fallback
        try {
          const data = JSON.parse(text)
          if (data && data.error && typeof data.error.message === 'string' && data.error.message) return data.error.message
          if (data && typeof data.message === 'string' && data.message) return data.message
        } catch (error) {
          // 非 JSON 响应：退化为截断后的纯文本
        }
        const compact = text.replace(/\s+/g, ' ').trim()
        if (!compact) return fallback
        return compact.length > 240 ? compact.slice(0, 240) + '…' : compact
      }

      /**
       * 解析 SSE 数据块（一个以空行分隔的事件），把 `data:` 负载交给回调。
       * 解析失败静默忽略——增量流里出现半截 JSON 是正常现象。
       * @param {string} raw 原始事件文本。
       * @param {(payload: any) => void} onEvent 负载回调。
       * @returns {void}
       */
      function parseSseBlock(raw, onEvent) {
        const lines = String(raw).split('\n')
        let dataText = ''
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index].replace(/\r$/, '')
          if (line.indexOf('data:') !== 0) continue
          const piece = line.slice(5).replace(/^ /, '')
          dataText += (dataText ? '\n' : '') + piece
        }
        if (!dataText) return
        let payload
        try {
          payload = JSON.parse(dataText)
        } catch (error) {
          return
        }
        if (!payload || typeof payload !== 'object') return
        try {
          onEvent(payload)
        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-ai-reader] SSE 事件处理异常：' + errorMessage(error, 'unknown'))
          }
        }
      }

      /**
       * 创建 SSE 解析器：按 `\n\n` 切事件，处理跨 chunk 的半截事件。
       * @param {(payload: any) => void} onEvent 负载回调。
       * @returns {{ push: (chunk: string) => void, flush: () => void }}
       */
      function createSseParser(onEvent) {
        let buffer = ''
        return {
          push(chunk) {
            if (!chunk) return
            buffer = (buffer + chunk).replace(/\r\n/g, '\n')
            let index = buffer.indexOf('\n\n')
            while (index !== -1) {
              const block = buffer.slice(0, index)
              buffer = buffer.slice(index + 2)
              if (block.trim()) parseSseBlock(block, onEvent)
              index = buffer.indexOf('\n\n')
            }
          },
          flush() {
            if (buffer.trim()) parseSseBlock(buffer, onEvent)
            buffer = ''
          },
        }
      }

      // ======================================================================
      // 文章数据整理（对 Host 返回值做防御式归一化，任何字段缺失都不抛错）
      // ======================================================================

      /** 只接受受限格式字段；纯文本不一致时整块退回 text，避免显示/选区内容错位。 */
      function normalizeArticleRuns(rawRuns, text) {
        if (!Array.isArray(rawRuns) || rawRuns.length === 0 || rawRuns.length > 2048) return null
        const runs = []
        let plain = ''
        let styled = false
        for (const raw of rawRuns) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.text !== 'string') return null
          plain += raw.text
          if (plain.length > text.length) return null
          const run = { text: raw.text }
          for (const flag of ['bold', 'italic', 'underline', 'strike', 'code']) {
            if (raw[flag] === true) { run[flag] = true; styled = true }
          }
          for (const color of ['color', 'backgroundColor']) {
            if (typeof raw[color] === 'string' && /^#[0-9a-f]{6}$/i.test(raw[color])) {
              run[color] = raw[color].toLowerCase()
              styled = true
            }
          }
          const href = safeArticleHref(raw.href)
          if (href) { run.href = href; styled = true }
          runs.push(run)
        }
        return styled && plain === text ? runs : null
      }

      function withArticleRuns(block, rawRuns) {
        const runs = normalizeArticleRuns(rawRuns, block.text)
        if (runs) block.runs = runs
        return block
      }

      /**
       * 归一化一个内容块；未知 kind 返回 null（渲染时忽略）。
       * @param {any} block Host 返回的内容块。
       * @returns {any | null}
       */
      function normalizeBlock(block) {
        if (!block || typeof block !== 'object' || typeof block.kind !== 'string') return null
        const text = typeof block.text === 'string' ? block.text : ''
        switch (block.kind) {
          case 'heading': {
            const level = Math.min(3, Math.max(1, Math.round(Number(block.level) || 1)))
            return withArticleRuns({ kind: 'heading', level: level, text: text }, block.runs)
          }
          case 'paragraph':
          case 'quote':
            return withArticleRuns({ kind: block.kind, text: text }, block.runs)
          case 'list-item':
            return withArticleRuns({ kind: 'list-item', ordered: block.ordered === true, text: text }, block.runs)
          case 'code':
            return { kind: 'code', text: text }
          case 'image':
            return { kind: 'image', src: typeof block.src === 'string' ? block.src : '', alt: typeof block.alt === 'string' ? block.alt : '' }
          case 'table': {
            const rawRows = Array.isArray(block.rows) ? block.rows.slice(0, 200) : []
            const rows = []
            const cellRuns = []
            for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
              const rawRow = rawRows[rowIndex]
              if (!Array.isArray(rawRow)) continue
              const row = []
              for (let cellIndex = 0; cellIndex < Math.min(40, rawRow.length); cellIndex += 1) {
                const cell = rawRow[cellIndex]
                row.push(typeof cell === 'string' ? cell : cell == null ? '' : String(cell))
              }
              if (row.length > 0) {
                rows.push(row)
                if (Array.isArray(block.cellRuns)) {
                  cellRuns.push(row.map(function (cell, column) {
                    return normalizeArticleRuns(block.cellRuns[rowIndex]?.[column], cell)
                  }))
                }
              }
            }
            const table = { kind: 'table', rows: rows, header: block.header !== false }
            if (cellRuns.some(row => row.some(Boolean))) table.cellRuns = cellRuns
            if (Array.isArray(block.alignments)) {
              table.alignments = block.alignments.slice(0, 40).map(value => value === 'right' || value === 'center' ? value : 'left')
            }
            return table
          }
          case 'divider':
            return { kind: 'divider' }
          default:
            return null
        }
      }

      /**
       * 归一化 Host 返回的 article（字段缺失一律降级为空值）。
       * @param {any} raw Host / 本地构造的文章对象。
       * @returns {any | null}
       */
      function normalizeArticle(raw) {
        if (!raw || typeof raw !== 'object') return null
        raw = restorePastedMarkdown(raw)
        const sourceBlocks = Array.isArray(raw.blocks) ? raw.blocks.slice(0, 4000) : []
        const blocks = []
        for (let index = 0; index < sourceBlocks.length; index += 1) {
          const block = normalizeBlock(sourceBlocks[index])
          if (block) blocks.push(block)
        }
        const normalized = {
          url: typeof raw.url === 'string' ? raw.url : '',
          sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
          title: typeof raw.title === 'string' ? raw.title : '',
          site: typeof raw.site === 'string' ? raw.site : '',
          byline: typeof raw.byline === 'string' ? raw.byline : '',
          fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
          truncated: raw.truncated === true,
          blocks: blocks,
          text: typeof raw.text === 'string' ? raw.text : '',
          file: normalizeArticleFile(raw.file),
        }
        if (raw.edited === true) normalized.edited = true
        if (typeof raw.pasteSourceRef === 'string' && /^art-[a-z0-9]+$/.test(raw.pasteSourceRef)) normalized.pasteSourceRef = raw.pasteSourceRef
        const contentUrls = raw.contentSource === 'publisher' ? publisherContentUrls(raw.feedUrl, raw.contentUrl)
          : raw.contentSource === 'rss' ? { feedUrl: publicRssUrl(raw.feedUrl) } : null
        if (contentUrls && contentUrls.feedUrl && wechatContentUrl(normalized.sourceUrl || normalized.url)) {
          normalized.contentSource = raw.contentSource
          normalized.sourceLabel = raw.contentSource === 'publisher' ? '官网同步正文' : '公开RSS正文'
          Object.assign(normalized, contentUrls)
          normalized.accountName = typeof raw.accountName === 'string' ? raw.accountName.slice(0, 200) : ''
          const published = typeof raw.publishedAt === 'string' && raw.publishedAt.length <= 100 ? new Date(raw.publishedAt) : null
          normalized.publishedAt = published && Number.isFinite(published.getTime()) ? published.toISOString() : ''
        }
        return normalized
      }

      /**
       * 归一化本地文件文章附加的 file 元信息（缺失返回 null）。
       * @param {any} rawFile Host 返回的 article.file。
       * @returns {{ name: string, format: string, bytes: number, meta: any } | null}
       */
      function normalizeArticleFile(rawFile) {
        if (!rawFile || typeof rawFile !== 'object') return null
        const meta = rawFile.meta && typeof rawFile.meta === 'object' && !Array.isArray(rawFile.meta) ? rawFile.meta : null
        return {
          name: typeof rawFile.name === 'string' ? rawFile.name : '',
          format: typeof rawFile.format === 'string' ? rawFile.format : '',
          bytes: typeof rawFile.bytes === 'number' && rawFile.bytes >= 0 ? rawFile.bytes : 0,
          sha256: typeof rawFile.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(rawFile.sha256) ? rawFile.sha256.toLowerCase() : '',
          meta: meta,
        }
      }

      /**
       * 由内容块拼出纯文本（Host 已给 text 时优先用 text）。
       * @param {any} article 归一化后的文章。
       * @returns {string}
       */
      function articlePlainText(article) {
        if (!article) return ''
        if (typeof article.text === 'string' && article.text.trim()) return article.text
        const blocks = Array.isArray(article.blocks) ? article.blocks : []
        const parts = []
        for (let index = 0; index < blocks.length; index += 1) {
          const block = blocks[index]
          if (!block) continue
          if (block.kind === 'image' || block.kind === 'divider') continue
          if (block.kind === 'table' && Array.isArray(block.rows)) {
            for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
              const row = block.rows[rowIndex]
              if (Array.isArray(row)) parts.push(row.join(' | '))
            }
            continue
          }
          if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
        }
        return parts.join('\n\n')
      }

      /**
       * 生成 /analyze 请求里 article 字段（只保留契约要求的四个字段）。
       * @param {any} article 归一化后的文章。
       * @returns {{ title: string, site: string, url: string, text: string } | null}
       */
      function toAnalyzeArticle(article) {
        if (!article) return null
        let text = articlePlainText(article)
        if (!text) return null
        // 契约 2.4：/analyze 的 article.text 上限 200000 字符（Host 还会按 maxPromptChars 再截）
        if (text.length > 200000) text = text.slice(0, 200000)
        return {
          title: typeof article.title === 'string' ? article.title : '',
          site: typeof article.site === 'string' ? article.site : '',
          url: typeof article.url === 'string' ? article.url : '',
          text: text,
        }
      }

      /**
       * 统计正文字符数（用于文章头元信息）。
       * @param {any} article 归一化后的文章。
       * @returns {number}
       */
      function articleCharCount(article) {
        return articlePlainText(article).length
      }

      /**
       * 估算阅读时长（分钟，向上取整）：中文按 ~380 字/分钟；英文按词折算
       * （1 个英文词约等于 1.9 个汉字当量）。空文本返回 0。
       * @param {string} text 正文纯文本。
       * @returns {number}
       */
      function readingMinutesFor(text) {
        const source = typeof text === 'string' ? text : ''
        if (!source.trim()) return 0
        const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f]/g
        const cjkMatches = source.match(cjkPattern)
        const cjkCount = cjkMatches ? cjkMatches.length : 0
        const latinMatches = source.replace(cjkPattern, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)
        const wordCount = latinMatches ? latinMatches.length : 0
        const units = cjkCount + wordCount * 1.9
        return Math.ceil(units / 380)
      }

      /**
       * 把选中文字转成 Markdown 引用块（逐行加 "> "）。
       * @param {string} text 选中的原文。
       * @returns {string}
       */
      function quoteLines(text) {
        const lines = String(text == null ? '' : text).split(/\r?\n/)
        const quoted = []
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index].trim()
          if (line) quoted.push('> ' + line)
        }
        return quoted.join('\n')
      }

      // ======================================================================
      // 本地文档上传（CONTRACT §12：拖拽/选择文件 → POST /dsh-ai-reader/file）
      // ======================================================================

      /** /meta 缺失 fileFormats 时的内置兜底扩展名列表（与 Host lib/extract.js 的 111 项一致）。 */
      const FALLBACK_FILE_EXTENSIONS = Object.freeze([
        '.pdf','.docx','.pptx','.xlsx','.docm','.pptm','.xlsm','.odt','.ods','.odp','.odg','.ott','.ots','.otp','.epub','.rtf','.html','.htm','.xhtml','.xht','.shtml','.md','.markdown','.mdown','.mkd','.mdx','.txt','.text','.log','.out','.err','.nfo','.csv','.tsv','.tab','.json','.jsonl','.ndjson','.geojson','.yaml','.yml','.toml','.ini','.cfg','.conf','.properties','.env','.xml','.svg','.plist','.rss','.atom','.js','.mjs','.cjs','.jsx','.ts','.tsx','.vue','.svelte','.py','.pyw','.rb','.php','.java','.kt','.kts','.scala','.groovy','.c','.h','.cc','.cpp','.cxx','.hpp','.hh','.m','.mm','.cs','.go','.rs','.swift','.dart','.lua','.pl','.r','.jl','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd','.sql','.graphql','.gql','.proto','.diff','.patch','.css','.scss','.sass','.less','.styl','.tex','.bib','.rst','.adoc','.asciidoc','.org'
      ])
      /** /meta 缺失 limits.maxUploadBytes 时的兜底上传上限（25MB）。 */
      const DEFAULT_MAX_UPLOAD_BYTES = 26214400
      /** 每块 base64 的字节数（0x8000 避免 String.fromCharCode 参数过多导致栈溢出）。 */
      const BASE64_CHUNK_BYTES = 0x8000

      /** 文件格式 → 本地化徽章文案 key（未列出的走「其他」）。 */
      const FILE_FORMAT_KEYS = {
        pdf: 'file.format.pdf',
        doc: 'file.format.word',
        docx: 'file.format.word',
        docm: 'file.format.word',
        odt: 'file.format.odt',
        ott: 'file.format.odt',
        ppt: 'file.format.ppt',
        pptx: 'file.format.ppt',
        pptm: 'file.format.ppt',
        odp: 'file.format.ppt',
        otp: 'file.format.ppt',
        xls: 'file.format.excel',
        xlsx: 'file.format.excel',
        xlsm: 'file.format.excel',
        ods: 'file.format.excel',
        ots: 'file.format.excel',
        csv: 'file.format.csv',
        tsv: 'file.format.csv',
        tab: 'file.format.csv',
        epub: 'file.format.epub',
        md: 'file.format.markdown',
        markdown: 'file.format.markdown',
        txt: 'file.format.text',
        text: 'file.format.text',
        html: 'file.format.html',
        htm: 'file.format.html',
        rtf: 'file.format.rtf',
        json: 'file.format.json',
      }

      /**
       * 归一化 /meta.fileFormats.supportedExtensions：去空白、补前导点、去重；
       * 缺失或全非法时回退到内置 111 项列表。
       * @param {any} list /meta 返回的扩展名数组。
       * @returns {string[]}
       */
      function normalizeExtensions(list) {
        const result = []
        const seen = {}
        if (Array.isArray(list)) {
          for (let index = 0; index < list.length; index += 1) {
            const item = list[index]
            if (typeof item !== 'string') continue
            let extension = item.trim().toLowerCase()
            if (!extension) continue
            if (extension.charAt(0) !== '.') extension = '.' + extension
            if (extension.length > 1 && !seen[extension]) {
              seen[extension] = true
              result.push(extension)
            }
          }
        }
        if (result.length > 0) return result
        return FALLBACK_FILE_EXTENSIONS.slice()
      }

      /**
       * 文件格式 → 本地化徽章文案。
       * @param {string} format Host 返回的 file.format（如 pdf/docx）。
       * @param {Function} t 翻译函数。
       * @returns {string}
       */
      function fileFormatLabel(format, t) {
        const key = FILE_FORMAT_KEYS[String(format == null ? '' : format).toLowerCase()]
        return t(key || 'file.format.other')
      }

      /**
       * 字节数 → 可读大小（KB / MB，保留 1 位小数），走 t() 文案。
       * @param {number} bytes 字节数。
       * @param {Function} t 翻译函数。
       * @returns {string}
       */
      function formatFileSize(bytes, t) {
        const value = Number(bytes)
        if (!value || value <= 0) return ''
        if (value >= 1024 * 1024) return t('file.sizeMb', { n: (value / (1024 * 1024)).toFixed(1) })
        const kb = value / 1024
        return t('file.sizeKb', { n: kb >= 100 ? String(Math.round(kb)) : kb.toFixed(1) })
      }

      /**
       * 把 File 读成 base64（分块转换，避免大文件触发栈溢出）。
       * @param {{ arrayBuffer: () => Promise<ArrayBuffer> }} file 浏览器 File 对象。
       * @returns {Promise<string>}
       */
      async function readFileAsBase64(file) {
        if (!file || typeof file.arrayBuffer !== 'function') throw new Error('FILE_UNREADABLE')
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        const parts = []
        for (let index = 0; index < bytes.length; index += BASE64_CHUNK_BYTES) {
          const slice = bytes.subarray(index, Math.min(index + BASE64_CHUNK_BYTES, bytes.length))
          parts.push(String.fromCharCode.apply(null, slice))
        }
        if (typeof btoa !== 'function') throw new Error('BASE64_UNAVAILABLE')
        return btoa(parts.join(''))
      }

      /**
       * 解析 /file 失败时的用户文案映射（按契约错误码）。
       * @param {any} error 带 fileCode 的异常。
       * @param {Function} t 翻译函数。
       * @param {number} maxUploadBytes 当前上传上限。
       * @returns {string}
       */
      function fileErrorMessage(error, t, maxUploadBytes) {
        const code = error && typeof error.fileCode === 'string' ? error.fileCode : ''
        if (code === 'UNSUPPORTED') return t('file.unsupported')
        if (code === 'TOO_LARGE') return t('file.tooLarge', { n: formatFileSize(maxUploadBytes, t) })
        if (code === 'EXTRACT_FAILED') return t('file.extractFailed')
        // 网络错误 / 未知错误码：统一通用文案（契约 §12.5.3）
        return t('file.failed')
      }

      // ======================================================================
      // 保存到本地 / 本地文稿（CONTRACT §13）
      // ======================================================================

      /** /meta 缺失 limits.maxSaveBytes 时的兜底保存上限（40MB，与 Host 默认一致）。 */
      const DEFAULT_MAX_SAVE_BYTES = 41943040
      /** 保存成功/失败提示自动消失时长（ms）；失败提示保留到重试或切换文章。 */
      const SAVE_NOTICE_MS = 8000
      /** 本地文稿「确认删除」二次确认窗口（ms）。 */
      const LIBRARY_CONFIRM_MS = 4000
      /** 保存 / 读取文稿的 HTTP 超时（图片内联可能较慢，保存给足 120s）。 */
      const SAVE_HTTP_TIMEOUT_MS = 120000
      const LIBRARY_HTTP_TIMEOUT_MS = 15000

      /**
       * 文章身份键：与组件内 articleKey 保持一致（url → sourceUrl → title），
       * 用于把保存状态绑定到具体文章，避免切换文章后残留「已保存」。
       * @param {any} target 文章对象。
       * @returns {string}
       */
      function articleIdentityKey(target) {
        if (!target || typeof target !== 'object') return ''
        if (typeof target.url === 'string' && target.url) return target.url
        if (typeof target.sourceUrl === 'string' && target.sourceUrl) return target.sourceUrl
        if (target.file && typeof target.file.sha256 === 'string' && target.file.sha256) {
          return 'file:' + target.file.name + '#' + target.file.sha256
        }
        const title = typeof target.title === 'string' ? target.title : ''
        const text = typeof target.text === 'string' ? target.text : ''
        const blocks = Array.isArray(target.blocks) ? target.blocks : []
        if (!title && !text && blocks.length === 0) return ''
        // 粘贴 / 本地文件文章没有 URL：用「标题 + 内容指纹」当身份键，同名不同文不会被误判为同一篇（P2-11）
        return 'title:' + title + '#' + stableHash(text + '|' + blocks.length)
      }

      /**
       * FNV-1a 32 位哈希（base36）：只用于浏览器内的文章身份键，不用于安全用途。
       * @param {unknown} value 任意值（会转成字符串）
       * @returns {string}
       */
      function stableHash(value) {
        const text = String(value == null ? '' : value)
        let hash = 0x811c9dc5
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
        return hash.toString(36)
      }

      // Editing uses immutable source indices; unchanged blocks keep formatting.
      function createArticleEditor(article, savedState) {
        return { key: articleIdentityKey(article), original: article,
          blocks: article.blocks.slice(), removedBlocks: {}, history: [], status: 'editing', error: '',
          savedState: Object.assign({}, savedState),
          sourceRef: savedState && savedState.sourceRef || articleSourceRef(article) }
      }

      function changeArticleEditor(editor, index, block, group) {
        if (!editor || editor.status === 'saving' || index < 0 || index >= editor.blocks.length) return editor
        const before = editor.blocks[index]
        if (before === block) return editor
        const blocks = editor.blocks.slice()
        blocks[index] = block
        const removedBlocks = Object.assign({}, editor.removedBlocks)
        if (block === null) removedBlocks[index] = before
        else delete removedBlocks[index]
        const history = editor.history.slice()
        const last = history[history.length - 1]
        if (group && last && last.group === group && last.index === index) {
          history[history.length - 1] = Object.assign({}, last, { after: block })
        } else {
          history.push({ index: index, before: before, after: block, group: group || '' })
          if (history.length > 50) history.shift()
        }
        return Object.assign({}, editor, { blocks: blocks, removedBlocks: removedBlocks, history: history, error: '' })
      }

      function undoArticleEditor(editor) {
        if (!editor || !editor.history.length || editor.status === 'saving') return editor
        const history = editor.history.slice()
        const change = history.pop()
        const blocks = editor.blocks.slice()
        blocks[change.index] = change.before
        const removedBlocks = Object.assign({}, editor.removedBlocks)
        if (change.before === null) removedBlocks[change.index] = change.after
        else delete removedBlocks[change.index]
        return Object.assign({}, editor, { blocks: blocks, removedBlocks: removedBlocks, history: history, error: '' })
      }

      // Undo is bounded; remaining changes must still be saveable after its oldest entry expires.
      function articleEditorChangeCount(editor) {
        if (!editor) return 0
        return editor.blocks.reduce(function (count, block, index) {
          const original = editor.original.blocks[index]
          return count + (block === original || JSON.stringify(block) === JSON.stringify(original) ? 0 : 1)
        }, 0)
      }

      function buildEditedArticle(editor) {
        const blocks = editor.blocks.filter(function (block) {
          return block && !(typeof block.text === 'string' && !block.text.trim())
        })
        return Object.assign({}, editor.original, { blocks: blocks,
          text: articlePlainText({ blocks: blocks }), edited: true })
      }

      function resizeArticleEditorInput(input) {
        if (!input || !input.style) return
        input.style.height = 'auto'
        input.style.height = Math.max(36, (Number(input.scrollHeight) || 0) + 2) + 'px'
      }

      /**
       * 统计文章块数 / 字符数 / 图片数（本地文稿列表与保存按钮提示用）。
       * @param {any} target 文章对象。
       * @returns {{ chars: number, blocks: number, images: number }}
       */
      function articleSaveStats(target) {
        const blocks = target && Array.isArray(target.blocks) ? target.blocks : []
        let chars = 0
        let images = 0
        for (let index = 0; index < blocks.length; index += 1) {
          const block = blocks[index]
          if (!block || typeof block !== 'object') continue
          if (block.kind === 'image') {
            images += 1
            continue
          }
          if (typeof block.text === 'string') chars += block.text.length
        }
        return { chars: chars, blocks: blocks.length, images: images }
      }

      /**
       * 保存用的稳定来源键（CONTRACT §16.1）：有 url/sourceUrl 的文章由 Host 用 URL 去重，
       * 返回空串；粘贴/无链接文章用「标题 + 正文 + 块数」的 FNV 指纹，保证多次保存/更新笔记复用同一目录。
       * @param {any} target 文章对象
       * @returns {string}
       */
      function articleSourceRef(target) {
        if (!target || typeof target !== 'object') return ''
        if (typeof target.url === 'string' && target.url) return ''
        if (typeof target.sourceUrl === 'string' && target.sourceUrl) return ''
        if (target.pasteSourceRef) return target.pasteSourceRef
        const title = typeof target.title === 'string' ? target.title : ''
        const text = typeof target.text === 'string' ? target.text : ''
        const blocks = Array.isArray(target.blocks) ? target.blocks : []
        return 'art-' + stableHash(title + '|' + text + '|' + blocks.length)
      }

      /**
       * 构造保存用的对话快照（CONTRACT §16.2）：只保留已完成且有内容的 user/assistant 消息，
       * 附带笔记所需的元数据（选段原文、用户问题、知识库与联网来源）。
       * @param {any[]} messages 线程消息
       * @returns {any[]} 可直接发给 Host 的 conversation 数组
       */
      function buildConversationSnapshot(messages) {
        const list = []
        const input = Array.isArray(messages) ? messages : []
        for (let index = 0; index < input.length; index += 1) {
          const message = input[index]
          if (!message || typeof message !== 'object') continue
          const content = typeof message.content === 'string' ? message.content.trim() : ''
          if (!content) continue
          if (message.role === 'user') {
            const item = { role: 'user', content: content.slice(0, 20000) }
            if (typeof message.kind === 'string' && message.kind) item.kind = message.kind
            if (typeof message.display === 'string' && message.display) item.display = message.display.slice(0, 200)
            if (typeof message.quote === 'string' && message.quote) item.quote = message.quote.slice(0, 4000)
            if (typeof message.question === 'string' && message.question) item.question = message.question.slice(0, 2000)
            list.push(item)
          } else if (message.role === 'assistant') {
            // 只保存已完成的回答（含手动停止的已生成部分）；流式/失败占位不写进笔记
            if (message.status !== 'done' && message.status !== 'stopped') continue
            const item = { role: 'assistant', content: content.slice(0, 20000) }
            const knowledge = Array.isArray(message.knowledge) ? message.knowledge : []
            const knowledgeRefs = []
            for (let refIndex = 0; refIndex < knowledge.length; refIndex += 1) {
              const ref = knowledge[refIndex]
              if (!ref || typeof ref.title !== 'string' || !ref.title) continue
              knowledgeRefs.push({ title: ref.title.slice(0, 120), path: typeof ref.path === 'string' ? ref.path.slice(0, 300) : '' })
              if (knowledgeRefs.length >= 5) break
            }
            if (knowledgeRefs.length > 0) item.knowledge = knowledgeRefs
            const webSources = message.web && Array.isArray(message.web.sources) ? message.web.sources : []
            const webRefs = []
            for (let refIndex = 0; refIndex < webSources.length; refIndex += 1) {
              const ref = webSources[refIndex]
              if (!ref || typeof ref.url !== 'string' || !/^https?:\/\//i.test(ref.url)) continue
              webRefs.push({ title: typeof ref.title === 'string' ? ref.title.slice(0, 200) : '', url: ref.url })
              if (webRefs.length >= 4) break
            }
            if (webRefs.length > 0) item.web = { sources: webRefs }
            list.push(item)
          }
        }
        return list.slice(-100)
      }

      /**
       * 从本地文稿恢复对话线程（CONTRACT §16.3）：还原 user 元数据与 assistant 的知识库/联网参考，
       * 全部标记为已完成（不再处于流式状态）。
       * @param {any} raw Host 返回的 conversation 数组
       * @returns {any[]} 线程消息
       */
      function restoreConversationMessages(raw) {
        const list = Array.isArray(raw) ? raw : []
        const out = []
        for (let index = 0; index < list.length; index += 1) {
          const item = list[index]
          if (!item || typeof item !== 'object') continue
          const content = typeof item.content === 'string' ? item.content : ''
          if (!content.trim()) continue
          if (item.role === 'user') {
            const message = { id: nextId('user'), role: 'user', content: content }
            if (typeof item.kind === 'string') message.kind = item.kind
            if (typeof item.display === 'string' && item.display) message.display = item.display
            if (typeof item.quote === 'string') message.quote = item.quote
            if (typeof item.question === 'string') message.question = item.question
            out.push(message)
          } else if (item.role === 'assistant') {
            const knowledge = Array.isArray(item.knowledge)
              ? item.knowledge.filter(function (ref) {
                  return ref && typeof ref.title === 'string' && ref.title
                })
              : []
            const rawSources = item.web && Array.isArray(item.web.sources) ? item.web.sources : []
            const sources = normalizeWebSources(rawSources)
            const message = {
              id: nextId('assistant'),
              role: 'assistant',
              content: content,
              status: 'done',
              error: '',
              knowledge: knowledge,
            }
            if (sources.length > 0) message.web = { status: 'ok', sources: sources }
            out.push(message)
          }
        }
        return out
      }

      /**
       * 调用一个 Reader Host JSON 接口（/dsh-ai-reader/*）：JSON、超时中止、统一错误。
       * 失败抛 Error，并带 `readerStatus` / `readerCode` 供文案映射。
       * @param {string} path ORIGIN 相对路径（以 / 开头）。
       * @param {{ method?: string, body?: any, timeoutMs?: number }} [options] 选项。
       * @returns {Promise<any>}
       */
      async function readerFetchJson(path, options) {
        const settings = options || {}
        const controller = new AbortController()
        const timeoutMs =
          typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : LIBRARY_HTTP_TIMEOUT_MS
        const timer = setTimeout(function () {
          try {
            controller.abort()
          } catch (error) {
            // ignore
          }
        }, timeoutMs)
        const hasBody = settings.body !== undefined && settings.body !== null
        const headers = { accept: 'application/json' }
        if (hasBody) headers['content-type'] = 'application/json'
        try {
          const response = await fetch(ORIGIN + path, {
            method: settings.method || 'GET',
            headers: headers,
            body: hasBody ? JSON.stringify(settings.body) : undefined,
            cache: 'no-store',
            signal: controller.signal,
          })
          let data = null
          try {
            data = await response.json()
          } catch (error) {
            data = null
          }
          if (!response.ok || !data || data.ok !== true) {
            const failure = new Error(
              data && data.error && typeof data.error.message === 'string' && data.error.message
                ? data.error.message
                : 'HTTP ' + response.status,
            )
            failure.readerStatus = response.status
            failure.readerCode = data && data.error && typeof data.error.code === 'string' ? data.error.code : 'READER_FAILED'
            throw failure
          }
          return data
        } finally {
          clearTimeout(timer)
        }
      }

      /**
       * 保存失败 → 用户文案（按宿主错误码 / 网络错误映射，契约 §13.2）。
       * @param {any} error 捕获的异常。
       * @param {Function} t 翻译函数。
       * @param {number} maxSaveBytes 当前保存上限。
       * @returns {string}
       */
      function saveErrorMessage(error, t, maxSaveBytes) {
        const code = error && typeof error.readerCode === 'string' ? error.readerCode : ''
        const status = error && typeof error.readerStatus === 'number' ? error.readerStatus : 0
        if (status === 404 || code === 'SAVE_NOT_FOUND') return t('save.unavailable')
        if (code === 'TOO_LARGE') return t('save.tooLarge', { n: formatFileSize(maxSaveBytes, t) })
        if (code === 'BAD_REQUEST') return t('save.failed')
        if (code === 'SAVE_FAILED') {
          const message = error && typeof error.message === 'string' ? error.message : ''
          return message ? message : t('save.failed')
        }
        return t('save.failed')
      }

      // ======================================================================
      // 知识库联动（dsh-knowledge-base：同源 HTTP，失败一律静默降级）
      // 只通过 /dsh-kb/* 接口交互，不 import KB 代码、不读 KB 磁盘目录。
      // ======================================================================

      const KB_ORIGIN = '/dsh-kb'
      /** 联网参考最多展示/接受的来源数（与 Host §14 的默认上限一致；client 只做展示裁剪）。 */
      const WEB_MAX_REFS = 4
      /** 联网检索词字符上限（Host 契约 §14.2 同值；client 先截断避免 400）。 */
      const MAX_WEB_QUERY_CLIENT = 300
      /** 单条联网来源的展示名：标题优先，其次 hostname，最后原始 URL（契约 §14.4）。 */
      function webSourceLabel(source) {
        const title = source && typeof source.title === 'string' ? source.title.trim() : ''
        if (title) return title
        const url = source && typeof source.url === 'string' ? source.url : ''
        try {
          return new URL(url).hostname || url
        } catch (error) {
          return url
        }
      }
      /**
       * 清洗 Host SSE `web` 事件里的 sources（契约 §14.4）：只保留 http/https、去重、限 4 条。
       * @param {any} raw Host 发来的 sources 数组
       * @returns {Array<{title:string,url:string,publishedAt:string}>}
       */
      function normalizeWebSources(raw) {
        const list = Array.isArray(raw) ? raw : []
        const out = []
        const seen = {}
        for (let index = 0; index < list.length; index += 1) {
          const item = list[index]
          if (!item || typeof item !== 'object') continue
          const url = typeof item.url === 'string' ? item.url.trim() : ''
          if (!/^https?:\/\//i.test(url) || seen[url]) continue
          seen[url] = true
          out.push({
            title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
            url: url,
            publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 40) : '',
          })
          if (out.length >= WEB_MAX_REFS) break
        }
        return out
      }
      /** 知识库面板 id（稳定：'kb'），用于「打开知识库」。 */
      const KB_PANEL_ID = 'kb'
      const KB_QUERY_MAX = 120
      const KB_EXCERPT_MAX = 1500
      const KB_SEARCH_LIMIT = 3
      const KB_RELATED_LIMIT = 4
      const KB_RELATED_CANDIDATES = 32
      const KB_HTTP_TIMEOUT_MS = 3000
      const KB_PROBE_TIMEOUT_MS = 2000
      const KB_INGEST_TIMEOUT_MS = 15000
      const KB_JOB_POLL_MS = 900
      const KB_JOB_TIMEOUT_MS = 180000
      const KB_PASSAGE_MAX = 20000

      /**
       * 调用一个 KB JSON 接口：GET/POST、JSON 响应、超时中止、统一错误对象。
       * 任何网络 / 解析 / 业务失败都抛 Error，由调用方 try/catch 静默降级。
       * @param {string} path KB 相对路径（以 / 开头）。
       * @param {{ method?: string, body?: any, timeoutMs?: number, signal?: AbortSignal, cache?: string }} [options] 选项。
       * @returns {Promise<any>}
       */
      async function kbFetchJson(path, options) {
        const settings = options || {}
        const controller = new AbortController()
        const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : KB_HTTP_TIMEOUT_MS
        const timer = setTimeout(function () {
          try {
            controller.abort()
          } catch (error) {
            // ignore
          }
        }, timeoutMs)
        const external = settings.signal || null
        const forwardAbort = function () {
          try {
            controller.abort()
          } catch (error) {
            // ignore
          }
        }
        if (external) {
          if (external.aborted) forwardAbort()
          else if (typeof external.addEventListener === 'function') external.addEventListener('abort', forwardAbort)
        }
        const hasBody = settings.body !== undefined && settings.body !== null
        const headers = { accept: 'application/json' }
        if (hasBody) headers['content-type'] = 'application/json'
        try {
          const response = await fetch(KB_ORIGIN + path, {
            method: settings.method || 'GET',
            headers: headers,
            body: hasBody ? JSON.stringify(settings.body) : undefined,
            cache: settings.cache || 'no-store',
            signal: controller.signal,
          })
          let data = null
          try {
            data = await response.json()
          } catch (error) {
            data = null
          }
          if (!response.ok || !data || data.ok !== true) {
            const failure = new Error(
              data && data.error && typeof data.error.message === 'string' && data.error.message ? data.error.message : 'HTTP ' + response.status,
            )
            failure.kbStatus = response.status
            failure.kbCode = data && data.error && typeof data.error.code === 'string' ? data.error.code : 'KB_FAILED'
            throw failure
          }
          return data
        } finally {
          clearTimeout(timer)
          if (external && typeof external.removeEventListener === 'function') external.removeEventListener('abort', forwardAbort)
        }
      }

      function kbIngestJobId(data) {
        if (typeof data.jobId === 'string') return data.jobId
        return data.job && typeof data.job.id === 'string' ? data.job.id : ''
      }

      async function pollKbIngestJob(jobId, isCurrent, onStage, signal) {
        const startedAt = Date.now()
        while (isCurrent()) {
          if (Date.now() - startedAt > KB_JOB_TIMEOUT_MS) return { status: 'timeout' }
          await new Promise(function (resolve) { window.setTimeout(resolve, KB_JOB_POLL_MS) })
          if (!isCurrent()) return null
          const data = await kbFetchJson('/job?id=' + encodeURIComponent(jobId), { signal: signal })
          if (!isCurrent()) return null
          const job = data.job && typeof data.job === 'object' ? data.job : {}
          if (job.status === 'done' || job.status === 'failed') return job
          if (onStage) onStage(typeof job.stage === 'string' && job.stage ? job.stage : typeof job.message === 'string' ? job.message : '')
        }
        return null
      }

      /**
       * 去掉 Markdown 开头的 YAML frontmatter（KB 页面偶尔自带）。
       * @param {string} markdown 原始 Markdown。
       * @returns {string}
       */
      function stripFrontmatter(markdown) {
        return String(markdown == null ? '' : markdown).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      }

      /**
       * KB 页面正文摘录：去 frontmatter 后截断 1500 字符。
       * @param {string} markdown 页面 Markdown。
       * @returns {string}
       */
      function kbExcerpt(markdown) {
        const text = stripFrontmatter(markdown).trim()
        if (!text) return ''
        return text.length > KB_EXCERPT_MAX ? text.slice(0, KB_EXCERPT_MAX) : text
      }

      /**
       * 搜索知识库（limit 默认 3）。空 query 返回 []；接口失败抛错，由调用方降级。
       * @param {string} query 搜索词。
       * @param {number} [limit] 返回条数上限。
       * @param {AbortSignal} [signal] 外部取消信号（可选）。
       * @returns {Promise<Array<{ path: string, title: string, type: string, snippet: string }>>}
       */
      async function kbSearch(query, limit, signal) {
        const q = String(query == null ? '' : query).replace(/\s+/g, ' ').trim().slice(0, KB_QUERY_MAX)
        if (!q) return []
        const data = await kbFetchJson('/search', {
          method: 'POST',
          body: { q: q, limit: typeof limit === 'number' && limit > 0 ? limit : KB_SEARCH_LIMIT },
          signal: signal,
        })
        const results = Array.isArray(data.results) ? data.results : []
        const mapped = []
        const seenPaths = new Set()
        for (let index = 0; index < results.length; index += 1) {
          const item = results[index]
          if (!item || typeof item.path !== 'string' || !item.path) continue
          if (seenPaths.has(item.path)) continue
          seenPaths.add(item.path)
          mapped.push({
            path: item.path,
            title: typeof item.title === 'string' && item.title ? item.title : item.path,
            type: typeof item.type === 'string' ? item.type : '',
            snippet: typeof item.snippet === 'string' ? item.snippet : '',
            sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : '',
            article: item.article && typeof item.article === 'object' ? item.article : null,
          })
        }
        return mapped
      }

      /**
       * 读取单个 KB 页面并归一化（失败抛错）。
       * @param {string} path 页面路径 wiki/…md。
       * @param {AbortSignal} [signal] 外部取消信号（可选）。
       * @returns {Promise<{ path: string, title: string, type: string, confidence: string, updatedAt: string, tags: string[], markdown: string }>}
       */
      async function kbReadPage(path, signal) {
        const safePath = String(path == null ? '' : path).trim()
        if (!safePath) throw new Error('EMPTY_KB_PATH')
        const data = await kbFetchJson('/page?path=' + encodeURIComponent(safePath), { signal: signal })
        const page = data.page && typeof data.page === 'object' ? data.page : null
        if (!page) throw new Error('KB_PAGE_MISSING')
        return {
          path: typeof page.path === 'string' && page.path ? page.path : safePath,
          title: typeof page.title === 'string' && page.title ? page.title : safePath,
          type: typeof page.type === 'string' ? page.type : '',
          confidence: typeof page.confidence === 'string' ? page.confidence : '',
          updatedAt:
            typeof page.updatedAt === 'string' && page.updatedAt
              ? page.updatedAt
              : typeof page.createdAt === 'string'
                ? page.createdAt
                : '',
          tags: Array.isArray(page.tags) ? page.tags.filter(function (tag) { return typeof tag === 'string' }) : [],
          markdown: stripFrontmatter(typeof page.markdown === 'string' ? page.markdown : ''),
        }
      }

      /**
       * 为一次 AI 解读构建知识库参考：search top3 → 并发取页 → 截断摘录。
       * 任何失败都返回空数组（不阻塞回答）。
       * @param {string} query 检索词。
       * @param {AbortSignal} [signal] 外部取消信号（可选）。
       * @returns {Promise<Array<{ title: string, type: string, path: string, excerpt: string }>>}
       */
      async function kbFetchKnowledge(query, signal) {
        const results = await kbSearch(query, KB_SEARCH_LIMIT, signal)
        const top = results.slice(0, KB_SEARCH_LIMIT)
        if (top.length === 0) return []
        const pages = await Promise.all(
          top.map(async function (result) {
            try {
              const page = await kbReadPage(result.path, signal)
              const excerpt = kbExcerpt(page.markdown)
              const title = String(page.title || result.title || '').slice(0, 120)
              if (!title || !excerpt) return null
              return {
                title: title,
                type: String(page.type || result.type || '').slice(0, 20),
                path: String(page.path || result.path || '').slice(0, 300),
                excerpt: excerpt,
              }
            } catch (error) {
              return null
            }
          }),
        )
        return pages.filter(Boolean).slice(0, KB_SEARCH_LIMIT)
      }

      /** 探测知识库可用性及选段分析支持。 */
      async function kbProbe() {
        try {
          const data = await kbFetchJson('/meta', { timeoutMs: KB_PROBE_TIMEOUT_MS })
          return { ready: data.initialized !== false, passage: data.features && data.features.passageIngest === true }
        } catch (error) {
          return { ready: false, passage: false }
        }
      }

      /** KB 页面类型（用于本地化徽章文案）。 */
      const KB_PAGE_TYPES = ['entity', 'topic', 'source', 'synthesis', 'original', 'excerpt']

      /**
       * KB 页面类型的本地化文案；未知类型原样显示（数据值，不是 UI 文案）。
       * @param {string} type 页面类型。
       * @param {Function} t 翻译函数。
       * @returns {string}
       */
      function kbTypeLabel(type, t) {
        const value = String(type == null ? '' : type).toLowerCase()
        if (KB_PAGE_TYPES.indexOf(value) !== -1) return t('kb.type.' + value)
        return String(type == null ? '' : type)
      }

      /**
       * 当前文章的 KB 链接（链接型文章）；粘贴型返回空串。
       * @param {any} article 归一化后的文章。
       * @returns {string}
       */
      function kbArticleLink(article) {
        if (!article) return ''
        if (typeof article.url === 'string' && article.url) return article.url
        if (typeof article.sourceUrl === 'string' && article.sourceUrl) return article.sourceUrl
        return ''
      }

      /** 与知识库 normalizeSourceUrl 保持一致，保留识别正文所需的 query。 */
      function kbNormalizeLink(value) {
        const raw = String(value == null ? '' : value).trim()
        if (!raw) return ''
        try {
          const url = new URL(raw)
          url.hash = ''
          for (const key of Array.from(url.searchParams.keys())) {
            if (/^utm_/i.test(key)) url.searchParams.delete(key)
          }
          if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
          return url.href
        } catch (error) {
          return raw
        }
      }

      function kbArticleLinks(article) {
        if (!article) return []
        return [article.url, article.sourceUrl].filter(function (link) { return typeof link === 'string' && link.trim() }).map(kbNormalizeLink)
      }

      function kbTitleKey(value) {
        return String(value || '').normalize('NFKC').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, '').trim()
      }

      /** Recommend other knowledge, rather than four representations of the article already open.
       * Source records are grouped only for this shortlist; stored pages and AI evidence remain intact.
       * Known, different URLs take precedence over a shared title (e.g. two daily reports).
       */
      function kbRelatedItems(results, article) {
        const currentTitle = kbTitleKey(article && article.title)
        const currentLinks = kbArticleLinks(article)
        const groups = []
        const paths = new Set()
        const sourcePriority = { source: 3, original: 2, excerpt: 1 }
        for (const item of results) {
          if (!item || !item.path || paths.has(item.path)) continue
          paths.add(item.path)
          const isSource = Object.prototype.hasOwnProperty.call(sourcePriority, item.type)
          const title = kbTitleKey(item.article && item.article.title || item.title)
          const link = kbNormalizeLink(item.sourceUrl || item.article && item.article.url || '')
          if (isSource && (link && currentLinks.length
            ? currentLinks.indexOf(link) !== -1
            : currentTitle && title === currentTitle)) continue
          const existing = isSource && groups.find(function (group) {
            return group.isSource && (link && group.link ? link === group.link : title && title === group.title)
          })
          if (existing) {
            if (!existing.link && link) existing.link = link
            if (sourcePriority[item.type] > sourcePriority[existing.item.type]) existing.item = item
          } else {
            groups.push({ item: item, isSource: isSource, title: title, link: link })
          }
        }
        return groups.slice(0, KB_RELATED_LIMIT).map(function (group) { return group.item })
      }

      /** Strip retrieval-only Markdown markers from the short visible preview. */
      function kbRelatedSnippet(value) {
        return String(value || '').replace(/<!--[\s\S]*?-->/g, '')
          .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\s)#{1,6}\s+/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
          .replace(/\s+/g, ' ').trim().slice(0, 220)
      }

      /**
       * 把 ISO 时间格式化成本地日期 + 时间；无效输入原样返回。
       * @param {string} value ISO 时间字符串。
       * @returns {string}
       */
      function formatKbTime(value) {
        const raw = String(value == null ? '' : value)
        if (!raw) return ''
        try {
          const date = new Date(raw)
          if (isNaN(date.getTime())) return raw
          return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        } catch (error) {
          return raw
        }
      }

      // ======================================================================
      // 选中文字 → 浮动提问卡片定位（CONTRACT §3.3：选段后不直接解读，先让用户输入问题）
      // ======================================================================

      /** 提问卡片的估算尺寸（用于夹紧到视口/阅读区内，CSS 里会再兜一层）。 */
      const SELECTION_ASK_WIDTH = 400
      const SELECTION_ASK_HEIGHT = 120
      const SELECTION_HIGHLIGHT_NAME = 'dsh-ai-reader-selection'
      const SELECTION_FRAGMENT_LIMIT = 4000

      /** 按同一行统一行高，只在字形矩形上/下补背景，不盖住文字或改变正文布局。 */
      function selectionBandsFromFragments(fragments, origin) {
        if (!Array.isArray(fragments) || fragments.length > SELECTION_FRAGMENT_LIMIT) return []
        const sorted = fragments.filter(function (rect) {
          return rect && [rect.left, rect.top, rect.width, rect.height, rect.lineHeight].every(Number.isFinite) && rect.width > 0 && rect.height > 0
        }).sort(function (a, b) { return a.top - b.top || a.left - b.left })
        const lines = []
        for (const rect of sorted) {
          const bottom = rect.top + rect.height
          let line = lines.length ? lines[lines.length - 1] : null
          if (!line || rect.top >= line.bottom - 0.01 || bottom <= line.top + 0.01) {
            line = { top: rect.top, bottom: bottom, lineHeight: rect.lineHeight, fragments: [] }
            lines.push(line)
          }
          line.top = Math.min(line.top, rect.top)
          line.bottom = Math.max(line.bottom, bottom)
          line.lineHeight = Math.max(line.lineHeight, rect.lineHeight)
          line.fragments.push(rect)
        }
        const bands = []
        const offset = origin || { left: 0, top: 0 }
        for (const line of lines) {
          const extra = Math.max(0, line.lineHeight - (line.bottom - line.top)) / 2
          const top = line.top - extra
          const bottom = line.bottom + extra
          for (const rect of line.fragments) {
            let glyphTop = rect.top
            let glyphBottom = rect.top + rect.height
            // 不同字号或字体的字形框若横向重叠，补带也不能盖到邻片段文字。
            for (const other of line.fragments) {
              if (other.left < rect.left + rect.width - 0.01 && other.left + other.width > rect.left + 0.01) {
                glyphTop = Math.min(glyphTop, other.top)
                glyphBottom = Math.max(glyphBottom, other.top + other.height)
              }
            }
            if (glyphTop - top > 0.01) bands.push({ left: rect.left - offset.left, top: top - offset.top, width: rect.width, height: glyphTop - top })
            if (bottom - glyphBottom > 0.01) bands.push({ left: rect.left - offset.left, top: glyphBottom - offset.top, width: rect.width, height: bottom - glyphBottom })
          }
        }
        return bands
      }

      function collectSelectionBands(range, container) {
        if (!range || !container || typeof range.intersectsNode !== 'function') return []
        const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null)
        const view = doc && (doc.defaultView || (typeof window !== 'undefined' ? window : null))
        if (!doc || !view || typeof doc.createTreeWalker !== 'function' || typeof doc.createRange !== 'function' || typeof view.getComputedStyle !== 'function') return []
        try {
          const root = range.commonAncestorContainer
          if (!root || !container.contains(root)) return []
          const walker = doc.createTreeWalker(root, 4)
          const fragments = []
          let visits = 0
          let node = root.nodeType === 3 ? root : walker.nextNode()
          while (node) {
            if (++visits > 16000) return []
            if (range.intersectsNode(node)) {
              const part = doc.createRange()
              part.selectNodeContents(node)
              if (range.compareBoundaryPoints(0, part) > 0) part.setStart(range.startContainer, range.startOffset)
              if (range.compareBoundaryPoints(2, part) < 0) part.setEnd(range.endContainer, range.endOffset)
              if (!part.collapsed) {
                const parent = node.parentElement
                const block = parent && parent.closest('p,h1,h2,h3,h4,h5,h6,blockquote,.air-li-text,pre,td,th')
                const style = view.getComputedStyle(block || parent || container)
                const lineHeight = parseFloat(style.lineHeight)
                const rects = part.getClientRects()
                if (fragments.length + rects.length > SELECTION_FRAGMENT_LIMIT) return []
                for (const rect of rects) {
                  if (rect.width > 0 && rect.height > 0) fragments.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, lineHeight: Number.isFinite(lineHeight) ? lineHeight : rect.height })
                }
              }
            }
            node = walker.nextNode()
          }
          return selectionBandsFromFragments(fragments, container.getBoundingClientRect())
        } catch (error) {
          return []
        }
      }

      /**
       * 读取文章容器内当前的选区。
       * @param {HTMLElement | null} container 文章滚动容器。
       * @returns {{ text: string, range: Range, rect: { top: number, bottom: number, left: number, right: number, width: number } } | null}
       */
      function readSelection(container) {
        if (!container) return null
        if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return null
        try {
          const selection = window.getSelection()
          if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
          const range = selection.getRangeAt(0)
          if (!range) return null
          if (!container.contains(range.commonAncestorContainer)) return null
          const text = String(selection.toString() || '').trim()
          if (!text) return null
          const rect = range.getBoundingClientRect()
          if (!rect || (!rect.width && !rect.height)) return null
          return {
            text: text,
            range: range.cloneRange(),
            rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width },
          }
        } catch (error) {
          return null
        }
      }

      /**
       * 计算提问卡片的视口坐标：优先放在选区上方（下方是接下来要读的正文），放不下放到下方；
       * 水平居中并夹在阅读区/视口内。
       * @param {{ top: number, bottom: number, left: number, right: number, width: number }} rect 选区矩形。
       * @param {DOMRect|null} containerRect 阅读区矩形（可空）。
       * @param {number} cardWidth 卡片宽度。
       * @param {number} cardHeight 卡片高度。
       * @returns {{ top: number, left: number }}
       */
      function floatingPlacement(rect, containerRect, cardWidth, cardHeight) {
        const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024
        const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768
        const width = Math.min(cardWidth, viewportWidth - 24)
        const center = rect.left + (rect.right - rect.left) / 2
        const halfCard = width / 2
        let minLeft = halfCard + 8
        let maxLeft = Math.max(minLeft, viewportWidth - halfCard - 8)
        // 优先把卡片夹在阅读区内，避免压住右栏内容
        if (containerRect && containerRect.width > width + 24) {
          const containerMin = containerRect.left + halfCard + 8
          const containerMax = containerRect.right - halfCard - 8
          if (containerMax >= containerMin) {
            minLeft = Math.max(minLeft, containerMin)
            maxLeft = Math.min(maxLeft, containerMax)
          }
        }
        const left = Math.min(Math.max(center, minLeft), maxLeft)
        // 优先放在选区上方：下方是读者接下来要读的正文，卡片不遮挡
        let top = rect.top - cardHeight - 10
        if (top < 8) top = Math.min(rect.bottom + 10, viewportHeight - cardHeight - 8)
        return { top: Math.round(top), left: Math.round(left) }
      }

      // ======================================================================
      // 自写 Markdown 渲染器（返回 React 元素，绝不注入 HTML 字符串）
      // 支持：#/##/### 标题、段落、无序/有序列表、> 引用、``` 代码块、--- 分隔线、
      //       表格、**粗体**、*斜体*、`行内代码`、[文字](url)。其余按纯文本渲染。
      // ======================================================================

      const INLINE_PATTERN = /\\[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[([^\]\n]+)\]\((<[^<>\n]+>|(?:[^()\s<>]|\([^()\s]*\))+)\)/g
      const MARKDOWN_BLOCK_START = /^\s{0,3}(#{1,6}\s|>|```|~~~|[-*+]\s|\d{1,3}[.)]\s)/
      const MARKDOWN_TABLE_CELL_LIMIT = 8000

      function parseInlineMarkdown(source, allowHref) {
        const runs = []
        let lastIndex = 0
        for (const match of source.matchAll(INLINE_PATTERN)) {
          if (match.index > lastIndex) runs.push({ text: source.slice(lastIndex, match.index) })
          const token = match[0]
          if (token.charAt(0) === '\\') {
            runs.push({ text: token.slice(1) })
          } else if (token.startsWith('***')) {
            runs.push({ text: token.slice(3, -3), bold: true, italic: true })
          } else if (token.startsWith('**')) {
            runs.push({ text: token.slice(2, -2), bold: true })
          } else if (token.charAt(0) === '`') {
            runs.push({ text: token.slice(1, -1), code: true })
          } else if (match[1] !== undefined) {
            const href = allowHref(match[2].replace(/^<|>$/g, ''))
            runs.push(href ? { text: match[1], href: href } : { text: token })
          } else {
            runs.push({ text: token.slice(1, -1), italic: true })
          }
          lastIndex = match.index + token.length
        }
        if (lastIndex < source.length) runs.push({ text: source.slice(lastIndex) })
        return runs
      }

      function renderInline(text, keyPrefix) {
        return parseInlineMarkdown(String(text == null ? '' : text), safeHref).map(function (run, index) {
          const key = keyPrefix + '-inline-' + index
          let node = run.text
          if (run.code) node = h('code', { key: key, className: 'air-md-code' }, node)
          if (run.italic) node = h('em', { key: key }, node)
          if (run.bold) node = h('strong', { key: key }, node)
          if (run.href) node = h('a', { key: key, href: run.href, target: '_blank', rel: 'noreferrer' }, node)
          return node
        })
      }

      /**
       * 把若干行渲染成带 <br> 的段落子节点。
       * @param {string[]} lines 段落内的行。
       * @param {string} keyPrefix React key 前缀。
       * @returns {any[]} React 子节点数组。
       */
      function renderPlainLines(lines, keyPrefix) {
        const nodes = []
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) nodes.push(h('br', { key: keyPrefix + '-br-' + index }))
          const inlineNodes = renderInline(lines[index], keyPrefix + '-line-' + index)
          for (let inner = 0; inner < inlineNodes.length; inner += 1) nodes.push(inlineNodes[inner])
        }
        return nodes
      }

      /** 拆分未转义的竖线，允许省略行首或行尾的竖线。 */
      function splitMarkdownTableRow(line) {
        const text = line.trim()
        const cells = []
        let start = 0
        for (let index = 0; index < text.length; index += 1) {
          if (text[index] === '\\') {
            index += 1
            continue
          }
          if (text[index] !== '|') continue
          if (index > 0) cells.push(text.slice(start, index))
          start = index + 1
        }
        if (!start) return null
        if (start < text.length) cells.push(text.slice(start))
        return cells.map(cell => cell.trim().replace(/\\([|\\])/g, '$1'))
      }

      /** 只在表头和分隔行列数相符时识别表格，其他行仍由段落解析。 */
      function readMarkdownTableHeader(line, separator) {
        if (!separator || !/^[ \t|:-]+$/.test(separator)) return null
        const dividers = splitMarkdownTableRow(separator)
        if (!dividers?.length || dividers.length > MARKDOWN_TABLE_CELL_LIMIT) return null
        if (!dividers.every(cell => /^:?-+:?$/.test(cell))) return null
        const cells = splitMarkdownTableRow(line)
        return cells && cells.length === dividers.length ? { cells, dividers } : null
      }

      /**
       * 阅读器、知识库和对话共用的 Markdown 块解析。
       */
      function parseMarkdownBlocks(source, tableColumns = MARKDOWN_TABLE_CELL_LIMIT, tableRows = Infinity) {
        const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n')
        if (!text) return []
        const lines = text.split('\n')
        const blocks = []
        let cursor = 0
        while (cursor < lines.length) {
          const line = lines[cursor]
          if (!line.trim()) {
            cursor += 1
            continue
          }

          // 围栏代码块：``` 或 ~~~（流式未闭合时把剩余内容都当代码）
          const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*[^`]*$/.exec(line)
          if (fence) {
            const closer = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*$')
            const collected = []
            cursor += 1
            while (cursor < lines.length && !closer.test(lines[cursor])) {
              collected.push(lines[cursor])
              cursor += 1
            }
            if (cursor < lines.length) cursor += 1
            blocks.push({ kind: 'code', text: collected.join('\n') })
            continue
          }

          // 标题 # / ## / ###（更深的按三级处理）
          const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
          if (heading) {
            blocks.push({ kind: 'heading', level: Math.min(3, heading[1].length), text: heading[2] })
            cursor += 1
            continue
          }

          // 分隔线 --- / *** / ___
          if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            blocks.push({ kind: 'divider' })
            cursor += 1
            continue
          }

          // 引用块 >（递归解析内容，支持引用里再出列表 / 代码）
          if (/^\s{0,3}>/.test(line)) {
            const collected = []
            while (cursor < lines.length && /^\s{0,3}>/.test(lines[cursor])) {
              collected.push(lines[cursor].replace(/^\s{0,3}>\s?/, ''))
              cursor += 1
            }
            blocks.push({ kind: 'quote', text: collected.join('\n') })
            continue
          }

          // 列表（有序 / 无序，连续的同类项合成一个列表；缩进行并入上一项）
          const listItem = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line)
          if (listItem) {
            const ordered = /\d/.test(listItem[1])
            const items = []
            while (cursor < lines.length) {
              const current = lines[cursor]
              const itemMatch = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(current)
              if (!itemMatch) {
                if (items.length > 0 && /^\s{2,}\S/.test(current)) {
                  items[items.length - 1] += ' ' + current.trim()
                  cursor += 1
                  continue
                }
                break
              }
              if (/\d/.test(itemMatch[1]) !== ordered) break
              items.push(itemMatch[2])
              cursor += 1
            }
            blocks.push({ kind: 'list', ordered: ordered, items: items })
            continue
          }

          const table = readMarkdownTableHeader(line, lines[cursor + 1])
          if (table && table.cells.length <= tableColumns) {
            const rows = [table.cells]
            const rowLimit = Math.min(tableRows, Math.floor(MARKDOWN_TABLE_CELL_LIMIT / table.cells.length))
            cursor += 2
            while (cursor < lines.length && rows.length < rowLimit && !MARKDOWN_BLOCK_START.test(lines[cursor])) {
              const row = splitMarkdownTableRow(lines[cursor])
              // 超出列数的行留给后续段落，避免丢掉原始内容。
              if (!row || !row.length || row.length > table.cells.length) break
              rows.push(row)
              cursor += 1
            }
            const alignments = table.dividers.map(function (divider) {
              if (divider.endsWith(':')) return divider.startsWith(':') ? 'center' : 'right'
              return 'left'
            })
            blocks.push({ kind: 'table', rows: rows.map(row => table.cells.map((_, column) => row[column] || '')), alignments })
            continue
          }

          // 普通段落：连续非空、非块级标记行合并为一段
          const paragraphLines = []
          while (cursor < lines.length) {
            const current = lines[cursor]
            if (!current.trim()) break
            if (MARKDOWN_BLOCK_START.test(current)) break
            if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(current)) break
            const nextTable = readMarkdownTableHeader(current, lines[cursor + 1])
            if (nextTable && nextTable.cells.length <= tableColumns) break
            paragraphLines.push(current)
            cursor += 1
          }
          if (paragraphLines.length === 0) {
            // 未成对的标记仍作为正文保留。
            paragraphLines.push(lines[cursor])
            cursor += 1
          }
          blocks.push({ kind: 'paragraph', text: paragraphLines.join('\n') })
        }
        return blocks
      }

      function renderMarkdown(source, tableLabel, depth = 0) {
        return parseMarkdownBlocks(source).map(function (block, index) {
          const key = block.kind + '-' + index
          switch (block.kind) {
            case 'code': return h('pre', { key, className: 'air-md-pre' }, h('code', null, block.text))
            case 'heading': return h('h' + (block.level + 1), { key, className: 'air-md-h air-md-h' + block.level }, renderInline(block.text, key))
            case 'divider': return h('hr', { key, className: 'air-md-hr' })
            case 'quote': return h('blockquote', { key, className: 'air-md-quote' }, depth < 16 ? renderMarkdown(block.text, tableLabel, depth + 1) : block.text)
            case 'list': return h(block.ordered ? 'ol' : 'ul', { key, className: 'air-md-list' }, block.items.map(function (item, itemIndex) {
              const itemKey = key + '-' + itemIndex
              return h('li', { key: itemKey }, renderInline(item, itemKey))
            }))
            case 'table': {
              const rows = block.rows.map((row, r) => row.map((cell, c) => renderInline(cell, key + '-' + r + '-' + c)))
              return h(TableBlock, { key, rows, label: tableLabel, alignments: block.alignments })
            }
            default: return h('p', { key, className: 'air-md-p' }, renderPlainLines(block.text.split('\n'), key))
          }
        })
      }

      // The previous paste path saved raw Markdown as paragraph text. Keep its
      // fingerprint so re-pasting the same article updates the original record.
      function legacyPasteParagraphs(source) {
        return source.split(/\n{2,}/).map(part => part.trim().replace(/[ \t]+/g, ' ')).filter(Boolean).slice(0, 4000)
      }

      function pastedBlockText(value) {
        const source = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        return source.replace(/\r\n?/g, '\n').split('\n')
          .map(line => line.replace(/[^\S\n]+/g, ' ').trim()).filter(Boolean).join('\n')
      }

      function pastedInline(value) {
        const runs = parseInlineMarkdown(pastedBlockText(value), safeArticleHref)
        return { text: runs.map(run => run.text).join(''), runs }
      }

      function pastedMarkdownArticle(source, title, legacyParagraphs) {
        const blocks = []
        for (const block of parseMarkdownBlocks(source, 40, 200)) {
          if (block.kind === 'list') {
            for (const item of block.items) blocks.push({ kind: 'list-item', ordered: block.ordered, ...pastedInline(item) })
          } else if (block.kind === 'table') {
            const cells = block.rows.map(row => row.map(pastedInline))
            blocks.push({ kind: 'table', rows: cells.map(row => row.map(cell => cell.text)),
              cellRuns: cells.map(row => row.map(cell => cell.runs)), alignments: block.alignments })
          } else if (block.kind === 'code' || block.kind === 'divider') {
            blocks.push(block)
          } else {
            blocks.push({ ...block, ...pastedInline(block.text) })
          }
          if (blocks.length >= 4000) break
        }
        const first = blocks[0]
        const heading = first?.kind === 'heading' && first.level === 1 ? first.text : ''
        const legacyTitle = title || (legacyParagraphs[0] || '').slice(0, 60)
        if (blocks.length > 1 && heading && (!title || heading === title)) blocks.shift()
        return {
          title: title || heading || (first?.text || legacyTitle).slice(0, 60),
          blocks,
          pasteSourceRef: 'art-' + stableHash(legacyTitle + '|' + source + '|' + legacyParagraphs.length),
        }
      }

      function restorePastedMarkdown(raw) {
        if (raw.pasteSourceRef || raw.edited || raw.url || raw.sourceUrl || raw.file ||
          (raw.site !== '粘贴文本' && raw.site !== 'Pasted text') || typeof raw.text !== 'string' || !Array.isArray(raw.blocks)) return raw
        const paragraphs = legacyPasteParagraphs(raw.text)
        if (!paragraphs.length || raw.blocks.length !== paragraphs.length || !raw.blocks.every(function (block, index) {
          return block?.kind === 'paragraph' && !block.runs &&
            (block.text === paragraphs[index] || block.text === pastedBlockText(paragraphs[index]))
        })) return raw
        const inferred = paragraphs[0].slice(0, 60)
        const title = raw.title === inferred || raw.title === inferred.replace(/\s+/g, ' ').trim() ? '' : raw.title
        return { ...raw, ...pastedMarkdownArticle(raw.text, title, paragraphs) }
      }

      // 项目选择：三点仅改变透明度，不跳动；尺寸、节奏沿用阅读器的克制层级。
      function LoadingDots(props) {
        return h(
          'span',
          { className: 'air-loading-dots' + (props && props.small ? ' air-loading-dots-sm' : ''), 'aria-hidden': 'true' },
          h('span', { className: 'air-loading-dot' }),
          h('span', { className: 'air-loading-dot' }),
          h('span', { className: 'air-loading-dot' }),
        )
      }

      function LoadingStatus(props) {
        return h(
          'div',
          { className: 'air-loading' + (props.className ? ' ' + props.className : ''), role: 'status' },
          h('span', { className: 'air-loading-label' }, String(props.text || '').replace(/[.…]+$/, '')),
          h(LoadingDots),
        )
      }

      // ======================================================================
      // 图标（自绘 SVG，stroke/fill 用 currentColor，不依赖图标包）
      // ======================================================================

      /**
       * 生成一个统一规格的图标 svg 元素。
       * @param {number} size 边长（px）。
       * @param {any[]} children 子节点。
       * @param {Record<string, any>} [options] 额外属性。
       * @returns {any}
       */
      function iconSvg(size, children, options) {
        const side = typeof size === 'number' && size > 0 ? size : 16
        const props = {
          width: side,
          height: side,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        }
        if (options) Object.assign(props, options)
        return h.apply(null, ['svg', props].concat(children || []))
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function SparkIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', {
            key: 'spark',
            d: 'M11.2 2.8c.7 4.3 1.7 5.3 6 6-4.3.7-5.3 1.7-6 6-.7-4.3-1.7-5.3-6-6 4.3-.7 5.3-1.7 6-6Z',
            fill: 'currentColor',
            stroke: 'none',
          }),
          h('path', {
            key: 'spark-small',
            d: 'M18.4 14.2c.35 2.05.8 2.5 2.85 2.85-2.05.35-2.5.8-2.85 2.85-.35-2.05-.8-2.5-2.85-2.85 2.05-.35 2.5-.8 2.85-2.85Z',
            fill: 'currentColor',
            stroke: 'none',
          }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function TrashIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'lid', d: 'M4 7h16' }),
          h('path', { key: 'top', d: 'M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7' }),
          h('path', { key: 'body', d: 'M6.6 7l.8 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.4 7' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function KbIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'layer-1', d: 'M12 3.2 20 7l-8 3.8L4 7l8-3.8Z' }),
          h('path', { key: 'layer-2', d: 'M4 11.6 12 15.4l8-3.8' }),
          h('path', { key: 'layer-3', d: 'M4 16.2 12 20l8-3.8' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function RefreshIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'arc', d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
          h('path', { key: 'head', d: 'M20 4.2v4.6h-4.6' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function BackIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'chevron', d: 'M14.5 5.5 8 12l6.5 6.5' }),
          h('path', { key: 'line', d: 'M8 12h12' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function XIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'a', d: 'M6.5 6.5 17.5 17.5' }),
          h('path', { key: 'b', d: 'M17.5 6.5 6.5 17.5' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function CheckIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [h('path', { key: 'check', d: 'M5 12.5 9.5 17 19 7.5' })])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function FileIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'tray', d: 'M12 15.5V4M7.5 8 12 3.5 16.5 8' }),
          h('path', { key: 'base', d: 'M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function DownloadIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'shaft', d: 'M12 3.5v11.5' }),
          h('path', { key: 'head', d: 'M7.5 10.5 12 15 16.5 10.5' }),
          h('path', { key: 'base', d: 'M5 16.5v2A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-2' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function GlobeIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('circle', { key: 'globe', cx: 12, cy: 12, r: 8.5 }),
          h('path', { key: 'meridian', d: 'M3.5 12h17' }),
          h('path', { key: 'parallel', d: 'M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function HouseIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'roof', d: 'M4 10.5 12 4l8 6.5' }),
          h('path', { key: 'body', d: 'M6 9.5V19h12V9.5' }),
          h('path', { key: 'door', d: 'M10 19v-4.5h4V19' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function FolderIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'body', d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z' }),
          h('path', { key: 'tab', d: 'M3.5 9.5h17' }),
        ])
      }

      /**
       * 侧边栏入口图标：打开的书 + 星光；strokeWidth 随选中态略变粗。
       * @param {{ size?: number, active?: boolean }} [props] 侧边栏传入的尺寸与选中态。
       * @returns {any}
       */
      function ReaderIcon(props) {
        const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
        const active = !!(props && props.active)
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 2 : 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block' },
          },
          h('path', {
            key: 'book',
            d: 'M12 6.1C10.7 5 9 4.5 7 4.5H5.4A1.4 1.4 0 0 0 4 5.9v10.5a1.4 1.4 0 0 0 1.4 1.4H7c2 0 3.7.5 5 1.6 1.3-1.1 3-1.6 5-1.6h1.6a1.4 1.4 0 0 0 1.4-1.4V5.9a1.4 1.4 0 0 0-1.4-1.4H17c-2 0-3.7.5-5 1.6Z',
          }),
          h('path', { key: 'spine', d: 'M12 6.1v13.3' }),
          h('path', { key: 'lines', d: 'M7.2 9.2h1.7M7.2 12h1.7M15.1 9.2h1.7M15.1 12h1.7' }),
        )
      }

      /** 顶栏品牌图形：书 + 星。 @param {{ size?: number }} [props] 尺寸。 @returns {any} */
      function ReaderGlyph(props) {
        const size = props && props.size ? props.size : 18
        return iconSvg(
          size,
          [
            h('path', {
              key: 'book',
              d: 'M11 6.2C9.9 5.4 8.5 5 6.9 5H5.6A1.6 1.6 0 0 0 4 6.6v9.2A1.6 1.6 0 0 0 5.6 17.4h1.3c1.6 0 3 .4 4.1 1.2 1.1-.8 2.5-1.2 4.1-1.2h1.3a1.6 1.6 0 0 0 1.6-1.6V6.6A1.6 1.6 0 0 0 16.4 5h-1.3c-1.6 0-3 .4-4.1 1.2Z',
            }),
            h('path', { key: 'spine', d: 'M11 6.2v12.4' }),
            h('path', {
              key: 'spark',
              d: 'M18.2 2.2c.32 1.85.72 2.25 2.58 2.58-1.86.32-2.26.72-2.58 2.58-.32-1.86-.72-2.26-2.58-2.58 1.86-.33 2.26-.73 2.58-2.58Z',
              fill: 'currentColor',
              stroke: 'none',
            }),
          ],
          { strokeWidth: 1.7 },
        )
      }

      // ======================================================================
      // 左栏：文章正文渲染
      // ======================================================================

      /**
       * 图片块：通过 Host 图片代理加载（防盗链 / CSP），加载失败直接隐藏。
       * 图片本身用 <a target="_blank"> 包裹，点击可在新标签页查看原图。
       * @param {{ src: string, alt: string, articleUrl: string, viewImageLabel: string }} props 图片信息。
       * @returns {any}
       */
      function ArticleImage(props) {
        const [hidden, setHidden] = useState(false)
        useEffect(function () { setHidden(false) }, [props.src])
        const captions = Array.isArray(props.captions) ? props.captions : []
        const caption = captions.length > 0
          ? h('figcaption', { className: 'air-img-cap' }, captions.map(function (block, index) {
            // 图注统一为辅助文字，去掉源站的底色、染色与斜体装饰；原始 runs 仍保留供编辑和保存。
            const runs = Array.isArray(block.runs) ? block.runs.map(function (run) {
              return { text: run.text, bold: run.bold, underline: run.underline, strike: run.strike, code: run.code }
            }) : undefined
            return h('p', { key: 'caption-' + index, className: 'air-img-cap-line' + (isImageCredit(block.text) ? ' air-img-credit' : '') }, renderArticleText({ text: block.text, runs: runs }, 'caption-' + index))
          }))
          : props.alt ? h('figcaption', { className: 'air-img-cap' }, props.alt) : null
        if (props.editing && (hidden || !props.src)) {
          return h('figure', { className: 'air-img-wrap air-edit-image-unavailable' },
            h('span', null, props.unavailableLabel), props.alt ? h('figcaption', null, props.alt) : null)
        }
        // 图注仍是原文内容；图片加载失败时也保留，不让来源说明跟着消失。
        if (hidden || !props.src) return captions.length > 0 ? h('figure', { className: 'air-img-wrap' }, caption) : null
        const proxyUrl = ORIGIN + '/image?u=' + encodeURIComponent(props.src) + (props.articleUrl ? '&ref=' + encodeURIComponent(props.articleUrl) : '')
        return h(
          'figure',
          { className: 'air-img-wrap' },
          h(
            'a',
            {
              className: 'air-img-link',
              href: proxyUrl,
              target: '_blank',
              rel: 'noreferrer',
              title: props.viewImageLabel || '',
            },
            h('img', {
              className: 'air-img',
              src: proxyUrl,
              alt: props.alt || '',
              loading: 'lazy',
              decoding: 'async',
              referrerPolicy: 'no-referrer',
              onError: function () {
                setHidden(true)
              },
            }),
          ),
          caption,
        )
      }

      function isImageCredit(text) {
        return /^(?:图源|图片来源|图表来源|图片出处|图片版权|摄影|拍摄|(?:image|photo|picture|chart)\s+(?:credit|source)s?)\s*[:：]/i.test(String(text || '').trim())
      }

      /** 只收拢紧随图片、以明确图源结尾的短段落；没有图源证据时保留原块类型。 */
      function imageCaptionBlocks(blocks, imageIndex) {
        const captions = []
        let length = 0
        for (let index = imageIndex + 1; index < blocks.length && captions.length < 4; index += 1) {
          const block = blocks[index]
          if (!block || typeof block.text !== 'string') break
          const credit = isImageCredit(block.text)
          if (block.kind !== 'quote' && block.kind !== 'paragraph') break
          const text = block.text.trim()
          length += text.length
          if (!text || text.length > 240 || length > 600 || text.split('\n').length > 4) break
          captions.push(block)
          if (credit || isImageCredit(text.split('\n').pop())) return captions
        }
        return []
      }

      /**
       * 段落内换行：把文本里的 \n 变成 <br>（Host 对 <br> 的表示）。
       * @param {string} text 段落文本。
       * @param {string} keyPrefix React key 前缀。
       * @returns {any[]} React 子节点数组。
       */
      function textWithBreaks(text, keyPrefix) {
        const lines = String(text == null ? '' : text).split(/\r?\n/)
        const nodes = []
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) nodes.push(h('br', { key: keyPrefix + '-br-' + index }))
          nodes.push(lines[index])
        }
        return nodes
      }

      function articleColorLuminance(color) {
        const channels = [1, 3, 5].map(function (offset) {
          const value = parseInt(color.slice(offset, offset + 2), 16) / 255
          return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }

      function articleColorContrast(first, second) {
        const a = articleColorLuminance(first)
        const b = articleColorLuminance(second)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }

      /** 原背景色保留并校验前景对比；无背景的彩色文字按项目选择与主题正文色混合。 */
      function articleRunStyle(run) {
        if (run.backgroundColor) {
          let foreground = run.color
          if (!foreground || articleColorContrast(foreground, run.backgroundColor) < 4.5) {
            foreground = articleColorContrast('#000000', run.backgroundColor) >= articleColorContrast('#ffffff', run.backgroundColor) ? '#000000' : '#ffffff'
          }
          return { backgroundColor: run.backgroundColor, color: foreground }
        }
        if (!run.color) return null
        const channels = [1, 3, 5].map(function (offset) { return parseInt(run.color.slice(offset, offset + 2), 16) })
        if (Math.max.apply(null, channels) - Math.min.apply(null, channels) <= 12) return null
        return { color: 'color-mix(in srgb,' + run.color + ' 35%,var(--dsw-alias-label-primary) 65%)' }
      }

      /** 显式安全格式只生成 React 语义节点，不解释正文里的 Markdown 或 HTML。 */
      function renderArticleText(block, keyPrefix) {
        const text = typeof block.text === 'string' ? block.text : ''
        const runs = normalizeArticleRuns(block.runs, text)
        if (!runs) return textWithBreaks(text, keyPrefix)
        const nodes = []
        for (let index = 0; index < runs.length; index += 1) {
          const run = runs[index]
          const key = keyPrefix + '-run-' + index
          const style = articleRunStyle(run)
          let node = textWithBreaks(run.text, key)
          let wrapped = false
          if (run.code) { node = h('code', { key: key, className: 'air-md-code', style: run.backgroundColor ? style : undefined }, node); wrapped = true }
          if (run.strike) { node = h('s', { key: key, style: { textDecoration: 'line-through' } }, node); wrapped = true }
          if (run.underline) { node = h('u', { key: key, style: { textDecoration: 'underline' } }, node); wrapped = true }
          if (run.italic) { node = h('em', { key: key, style: { fontStyle: 'italic' } }, node); wrapped = true }
          if (run.bold) { node = h('strong', { key: key, style: { fontWeight: 700 } }, node); wrapped = true }
          if (style) { node = h('span', { key: key, style: style }, node); wrapped = true }
          if (run.href) {
            node = h('a', { key: key, className: 'air-article-link', href: run.href, target: '_blank', rel: 'noreferrer' }, node)
            wrapped = true
          }
          if (wrapped) nodes.push(node)
          else for (const child of node) nodes.push(child)
        }
        return nodes
      }

      /**
       * 表格块：横向滚动容器 + 0.5px 发丝线外框（Apple 内容优先风格）。
       * @param {{ rows: any[][], header?: boolean, label?: string, alignments?: string[] }} props 表格内容、列对齐与可访问名称。
       * @returns {any}
       */
      function TableBlock(props) {
        const rows = Array.isArray(props.rows) ? props.rows : []
        if (rows.length === 0) return null
        const header = props.header !== false
        const headRow = header ? rows[0] : null
        const bodyRows = header ? rows.slice(1) : rows
        const cellStyles = props.alignments?.map(textAlign => ({ textAlign }))
        const headCells = []
        if (headRow) {
          for (let cellIndex = 0; cellIndex < headRow.length; cellIndex += 1) {
            headCells.push(h('th', { key: 'th-' + cellIndex, scope: 'col', style: cellStyles?.[cellIndex] }, headRow[cellIndex]))
          }
        }
        const body = []
        for (let rowIndex = 0; rowIndex < bodyRows.length; rowIndex += 1) {
          const row = bodyRows[rowIndex]
          const cells = []
          for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
            cells.push(h('td', { key: 'td-' + rowIndex + '-' + cellIndex, style: cellStyles?.[cellIndex] }, row[cellIndex]))
          }
          body.push(h('tr', { key: 'row-' + rowIndex }, cells))
        }
        return h(
          'div',
          { className: 'air-table-wrap', tabIndex: 0, role: 'region', 'aria-label': props.label || '' },
          h(
            'table',
            { className: props.alignments ? 'air-table air-table-wrap-cells' : 'air-table' },
            headRow ? h('thead', null, h('tr', null, headCells)) : null,
            h('tbody', null, body),
          ),
        )
      }

      /**
       * 把 Host 的内容块数组渲染成 React 元素数组。
       * 连续的有序列表项由这里自行计数（Host 只给 ordered 标记）。
       * @param {any[]} blocks 归一化后的内容块。
       * @param {string} articleUrl 文章最终 URL（图片代理的 Referer 来源）。
       * @param {string} viewImageLabel 图片「查看大图」提示文案（随语言变化）。
       * @returns {any[]} React 元素数组。
       */
      function buildArticleNodes(blocks, articleUrl, viewImageLabel, tableLabel) {
        const nodes = []
        const list = Array.isArray(blocks) ? blocks : []
        let orderedCursor = 0
        let previousWasOrdered = false
        /** 重置列表计数（遇到非列表块时调用）。 @returns {void} */
        const resetList = function () {
          orderedCursor = 0
          previousWasOrdered = false
        }
        for (let index = 0; index < list.length; index += 1) {
          const block = list[index]
          if (!block) continue
          const key = 'block-' + index
          switch (block.kind) {
            case 'heading': {
              resetList()
              // 正文内三级标题：level 1/2/3 分别对应 .air-h1/.air-h2/.air-h3
              const level = block.level === 1 ? 1 : block.level === 2 ? 2 : 3
              const tag = level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4'
              nodes.push(h(tag, { key: key, className: 'air-h air-h' + level }, renderArticleText(block, key)))
              break
            }
            case 'paragraph': {
              resetList()
              nodes.push(h('p', { key: key, className: 'air-p' }, renderArticleText(block, key)))
              break
            }
            case 'list-item': {
              const ordered = block.ordered === true
              let marker
              if (ordered) {
                orderedCursor = previousWasOrdered ? orderedCursor + 1 : 1
                previousWasOrdered = true
                marker = orderedCursor + '.'
              } else {
                orderedCursor = 0
                previousWasOrdered = false
                marker = '•'
              }
              nodes.push(
                h(
                  'div',
                  { key: key, className: 'air-li' },
                  h('span', { className: 'air-li-marker', 'aria-hidden': 'true' }, marker),
                  h('span', { className: 'air-li-text' }, renderArticleText(block, key)),
                ),
              )
              break
            }
            case 'quote': {
              resetList()
              nodes.push(h('blockquote', { key: key, className: 'air-quote' }, renderArticleText(block, key)))
              break
            }
            case 'code': {
              resetList()
              nodes.push(h('pre', { key: key, className: 'air-pre' }, h('code', null, block.text || '')))
              break
            }
            case 'table': {
              resetList()
              const rows = block.cellRuns ? block.rows.map((row, r) => row.map(function (cell, c) {
                const runs = block.cellRuns[r]?.[c]
                return runs ? renderArticleText({ text: cell, runs }, key + '-' + r + '-' + c) : cell
              })) : block.rows
              nodes.push(h(TableBlock, { key: key, rows, header: block.header, label: tableLabel, alignments: block.alignments }))
              break
            }
            case 'image': {
              resetList()
              const captions = imageCaptionBlocks(list, index)
              nodes.push(h(ArticleImage, { key: key, src: block.src, alt: block.alt, captions: captions, articleUrl: articleUrl, viewImageLabel: viewImageLabel }))
              index += captions.length
              break
            }
            case 'divider': {
              resetList()
              nodes.push(h('hr', { key: key, className: 'air-hr' }))
              break
            }
            default:
              break
          }
        }
        return nodes
      }

      // ======================================================================
      // 右栏：消息渲染
      // ======================================================================

      /**
       * 渲染 user 消息：普通文本 + `> ` 引用段（引用段用左侧竖线突出）。
       * @param {{ content: string }} message 用户消息。
       * @returns {any[]} React 子节点数组。
       */
      function renderUserSegments(message) {
        // 快捷问题的 content 是发给模型的固定提示词；气泡显示按钮名（display），避免长 prompt 刷屏（CONTRACT §19.1）
        const source = String(
          message && (typeof message.display === 'string' && message.display ? message.display : message.content) != null
            ? (typeof message.display === 'string' && message.display ? message.display : message.content)
            : '',
        )
        const segments = source.split(/\n{2,}/)
        const nodes = []
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index].trim()
          if (!segment) continue
          const lines = segment.split(/\r?\n/)
          let isQuote = lines.length > 0
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            if (!/^\s*>/.test(lines[lineIndex])) {
              isQuote = false
              break
            }
          }
          if (isQuote) {
            const quoteText = []
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
              quoteText.push(lines[lineIndex].replace(/^\s*>\s?/, ''))
            }
            nodes.push(h('blockquote', { key: 'quote-' + index, className: 'air-user-quote' }, quoteText.join('\n')))
          } else {
            nodes.push(h('div', { key: 'text-' + index, className: 'air-user-text' }, segment))
          }
        }
        return nodes
      }

      /**
       * 渲染一条 assistant 消息：Markdown 正文 + 流式光标 / 思考中 / 已停止 / 错误重试。
       * @param {{ message: any, t: Function, onRetry: (id: string) => void, busy: boolean }} props 消息与回调。
       * @returns {any}
       */
      function AssistantMessage(props) {
        const message = props.message
        const t = props.t
        const content = typeof message.content === 'string' ? message.content : ''
        const streaming = message.status === 'streaming'
        const thinking = streaming && !content.trim()
        const references = Array.isArray(message.knowledge)
          ? message.knowledge.filter(function (item) {
              return item && typeof item.path === 'string' && item.path && typeof item.title === 'string' && item.title
            })
          : []
        // 联网检索结果（CONTRACT §14.4）：done/stopped 后展示可点击来源；miss/失败给一行说明
        const webInfo = message.web && typeof message.web === 'object' ? message.web : null
        const webSources =
          webInfo && webInfo.status === 'ok' && Array.isArray(webInfo.sources)
            ? webInfo.sources.filter(function (source) {
                return source && typeof source.url === 'string' && /^https?:\/\//i.test(source.url)
              })
            : []
        let webNote = ''
        if ((message.status === 'done' || message.status === 'stopped') && webInfo) {
          if (webInfo.status === 'error') webNote = t('web.failed')
          else if (webInfo.status === 'miss') webNote = t('web.noResult')
        }
        return h(
          'div',
          { className: 'air-msg air-msg-assistant' },
          h(
            'div',
            { className: 'air-assistant-head' },
            h('span', { className: 'air-avatar' }, h(SparkIcon, { size: 12 })),
            h('span', { className: 'air-assistant-label' }, t('right.title')),
          ),
          content
            ? h('div', { className: 'air-md' }, renderMarkdown(content, t('reader.table')), streaming ? h('span', { key: 'cursor', className: 'air-cursor' }) : null)
            : null,
          thinking
            ? h(
                'div',
                { className: 'air-msg-status' },
                h(LoadingDots, { small: true }),
                props.kbSearching
                  ? t('kb.searching')
                  : props.webSearching
                    ? t('web.searching')
                    : props.kbMiss
                      ? t('kb.searchMiss')
                      : props.webError
                        ? t('web.searchFailed')
                        : props.webMiss
                          ? t('web.missSearching')
                          : t('thread.thinking'),
              )
            : null,
          message.status === 'stopped' ? h('div', { className: 'air-msg-status' }, t('thread.stopped')) : null,
          message.status === 'error'
            ? h(
                'div',
                { className: 'air-msg-error' },
                h('p', { className: 'air-msg-error-text' }, message.error || t('error.requestFailed')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'air-linkbtn',
                    disabled: props.busy,
                    onClick: function () {
                      props.onRetry(message.id)
                    },
                  },
                  t('thread.retry'),
                ),
              )
            : null,
          webSources.length > 0 && (message.status === 'done' || message.status === 'stopped')
            ? h(
                'div',
                { className: 'air-web-refs' },
                h('span', { className: 'air-web-refs-label' }, t('web.refs.label')),
                webSources.slice(0, WEB_MAX_REFS).map(function (source) {
                  return h(
                    'a',
                    {
                      key: 'web-' + source.url,
                      className: 'air-chip air-web-ref',
                      href: source.url,
                      target: '_blank',
                      rel: 'noreferrer',
                      title: source.title || source.url,
                    },
                    h(GlobeIcon, { size: 11 }),
                    webSourceLabel(source),
                  )
                }),
              )
            : null,
          webNote ? h('div', { className: 'air-web-note' }, webNote) : null,
          references.length > 0 && (message.status === 'done' || message.status === 'stopped')
            ? h(
                'div',
                { className: 'air-kb-refs' },
                h('span', { className: 'air-kb-refs-label' }, t('kb.refs.label')),
                references.slice(0, 3).map(function (reference) {
                  return h(
                    'button',
                    {
                      key: 'ref-' + reference.path,
                      type: 'button',
                      className: 'air-chip air-ref-chip',
                      title: reference.title,
                      onClick: function () {
                        if (typeof props.onOpenKbPage === 'function') props.onOpenKbPage(reference.path)
                      },
                    },
                    reference.title,
                  )
                }),
              )
            : null,
        )
      }

      /** Compact, keyboard-accessible disclosure for related knowledge. */
      function KbRelated(props) {
        const t = props.t
        const [expanded, setExpanded] = useState(false)
        const items = props.items
        return h('div', { className: 'air-kb-related' },
          h('div', { className: 'air-kb-related-head' },
            h('button', {
              type: 'button', className: 'air-kb-related-toggle',
              'aria-expanded': expanded,
              title: t(expanded ? 'kb.related.collapse' : 'kb.related.expand'),
              onClick: function () { setExpanded(!expanded) },
            },
            h(KbIcon, { size: 14 }),
            h('span', { className: 'air-kb-related-title' }, t('kb.related.title', { n: String(items.length) })),
            iconSvg(12, [h('path', { key: 'chevron', d: expanded ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6' })])),
            h('button', {
              type: 'button', className: 'air-iconbtn', title: t('kb.related.refresh'),
              'aria-label': t('kb.related.refresh'), disabled: props.loading, onClick: props.onRefresh,
            }, h(RefreshIcon, { size: 13 })),
            h('button', {
              type: 'button', className: 'air-linkbtn air-kb-open', onClick: props.onOpenPanel,
            }, t('kb.openPanel')),
          ),
          expanded ? h('ul', { className: 'air-kb-related-list', 'aria-label': t('kb.related.title', { n: String(items.length) }) },
            items.map(function (item) {
              const snippet = kbRelatedSnippet(item.snippet)
              const type = kbTypeLabel(item.type, t)
              return h('li', { key: item.path },
                h('button', {
                  type: 'button', className: 'air-kb-related-item', title: item.title,
                  onClick: function () { props.onOpenPage(item.path) },
                },
                h('span', { className: 'air-kb-related-item-head' },
                  type ? h('span', { className: 'air-kb-related-type' }, type) : null,
                  h('span', { className: 'air-kb-related-name' }, item.title)),
                snippet ? h('span', { className: 'air-kb-related-snippet' }, snippet) : null,
                ),
              )
            }),
          ) : null,
        )
      }

      /** 右栏空状态：提示如何发起第一次解读。 */
      function ThreadEmpty(props) {
        const t = props.t
        return h(
          'div',
          { className: 'air-thread-empty' },
          h('span', { className: 'air-empty-icon' }, h(SparkIcon, { size: 26 })),
          h('p', { className: 'air-empty-title' }, t('thread.empty.title')),
          h('p', { className: 'air-empty-hint' }, t('thread.empty.hint')),
          h('p', { className: 'air-empty-shortcut' }, t('shortcut.hint')),
        )
      }

      // ======================================================================
      // 面板渲染异常兜底（组件抛错时不让整个 slot entry 变白）
      // ======================================================================
      class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        componentDidCatch(error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-ai-reader] 面板渲染异常：' + errorMessage(error, 'unknown'))
          }
        }

        render() {
          if (!this.state.failed) return this.props.children
          return h(
            'div',
            { className: 'air-root' },
            h('style', { key: 'air-style-crash' }, AIR_CSS),
            h(
              'div',
              { className: 'air-empty' },
              h('p', { className: 'air-empty-title' }, this.props.title),
              h('p', { className: 'air-empty-hint' }, this.props.hint),
            ),
          )
        }
      }

      // ======================================================================
      // 主面板
      // ======================================================================

      /**
       * 主面板入口（main key='ai-reader'）。
       * 只做翻译函数解析与错误边界包装；真正的界面/状态在 ReaderPanelBody。
       * @param {any} props slot 注入的 props（含 locale 服务绑定的 t、openKbPanel）。
       * @returns {any}
       */
      function ReaderPanel(props) {
        const t = resolveT(props)
        return h(
          PanelBoundary,
          { title: t('crash.title'), hint: t('crash.hint') },
          h(ReaderPanelBody, {
            t: t,
            openKbPanel: props && typeof props.openKbPanel === 'function' ? props.openKbPanel : null,
          }),
        )
      }

      /**
       * 双栏阅读面板主体。
       * 左栏：URL / 粘贴正文 → 阅读排版；右栏：AI 解读线程（SSE 流式）。
       * 所有 hooks 均在函数顶部无条件调用。
       * @param {{ t: Function }} props 翻译函数。
       * @returns {any}
       */
      function ReaderPanelBody(props) {
        const t = props.t
        // 「打开知识库」由 apply 注入（ctx.layout.selectPanel('kb')，try/catch 静默失败）
        const openKbPanel = typeof props.openKbPanel === 'function' ? props.openKbPanel : null

        // ---- 状态（初始值从模块级 cache 恢复，实现面板切换后现场还原） --------
        const [article, setArticle] = useState(function () {
          return normalizeArticle(cache.article)
        })
        const [thread, setThread] = useState(function () {
          const saved = Array.isArray(cache.thread) ? cache.thread : []
          const restored = []
          for (let index = 0; index < saved.length; index += 1) {
            const message = saved[index]
            if (!message || typeof message !== 'object') continue
            const next = Object.assign({}, message)
            // 上一个实例卸载时若正在流式，恢复后标记为已停止（不会再有增量了）
            if (next.status === 'streaming') next.status = 'stopped'
            restored.push(next)
          }
          return restored
        })
        const [split, setSplit] = useState(function () {
          return typeof cache.split === 'number' && cache.split >= 32 && cache.split <= 68 ? cache.split : DEFAULT_SPLIT
        })
        const [dragging, setDragging] = useState(false)
        const [compactPane, setCompactPane] = useState('article')
        const [mode, setMode] = useState('url')
        const [urlInput, setUrlInput] = useState('')
        const [pasteTitle, setPasteTitle] = useState('')
        const [pasteText, setPasteText] = useState('')
        const [leftError, setLeftError] = useState('')
        const [loadingArticle, setLoadingArticle] = useState(false)
        const [busy, setBusy] = useState(false)
        const [composer, setComposer] = useState('')
        const [metaState, setMetaState] = useState('loading')
        const [modelLabel, setModelLabel] = useState('')
        const [limits, setLimits] = useState(null)
        const [selection, setSelection] = useState(null)
        /** 选中内容后的提问输入（CONTRACT §3.3：选段后先提问，不直接解读）。 */
        const [selectionQuestion, setSelectionQuestion] = useState('')
        // 阅读排版偏好（模块级 cache 提供初值；localStorage 在模块装载时已读入 cache）
        const [fontLevel, setFontLevel] = useState(function () {
          return sanitizePrefs(cache.prefs).fontSize
        })
        const [widthLevel, setWidthLevel] = useState(function () {
          return sanitizePrefs(cache.prefs).width
        })
        // ---- 知识库联动状态（KB 不可用时全部静默降级） ----
        /** 是否在 AI 解读时参考知识库（持久化在阅读偏好里）。 */
        const [kbEnabled, setKbEnabled] = useState(function () {
          return sanitizePrefs(cache.prefs).kbEnabled
        })
        /** KB 可用性：unknown（探测中）| ready | unavailable。 */
        const [kbStatus, setKbStatus] = useState('unknown')
        const [kbPassageSupported, setKbPassageSupported] = useState(false)
        /** 自动关联结果：null = 整条隐藏；数组 = 相关页面。 */
        const [kbRelated, setKbRelated] = useState(null)
        const [kbRelatedLoading, setKbRelatedLoading] = useState(false)
        /** 存入知识库状态机：idle | checking | running | done | exists | failed | timeout。 */
        const [kbIngest, setKbIngest] = useState({ status: 'idle', stage: '', pages: 0, error: '' })
        const [passageIngest, setPassageIngest] = useState(null)
        /** 左栏 KB 页面预览：null = 文章视图；否则 { path, loading, error, page }。 */
        const [kbPreview, setKbPreview] = useState(null)
        /** 分析前知识库检索阶段：'' | 'searching'（只影响「思考中…」文案）。 */
        const [kbPhase, setKbPhase] = useState('')
        // ---- 联网检索状态（CONTRACT §14） ----
        /** 联网检索开关（持久化在阅读偏好里；默认开）。 */
        const [webEnabled, setWebEnabled] = useState(function () {
          return sanitizePrefs(cache.prefs).webEnabled
        })
        /** 联网服务是否可用（/meta.web.available；未知时按可用处理，检索失败会优雅降级）。 */
        const [webAvailable, setWebAvailable] = useState(true)
        /** 联网检索阶段：'' | 'searching' | 'miss' | 'error'（只影响「思考中…」文案）。 */
        const [webPhase, setWebPhase] = useState('')
        // ---- 本地文件拖拽/上传状态（CONTRACT §12.5） ----
        /** 解析中的文件：null | { name }（显示遮罩 + 「正在解析…」）。 */
        const [fileBusy, setFileBusy] = useState(null)
        /** 拖拽遮罩是否显示（dragenter/leave 计数器控制，避免子元素抖动）。 */
        const [dragActive, setDragActive] = useState(false)
        /** 上传限制（来自 /meta；缺失用内置兜底）。 */
        const [fileLimits, setFileLimits] = useState(function () {
          return { maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES, extensions: normalizeExtensions(null) }
        })
        /** 轻提示（例如多文件时只取第一个）。 */
        const [fileNotice, setFileNotice] = useState('')
        /** 清空线程后的撤销快照：null = 无；数组 = 可恢复的旧线程。 */
        const [undoThread, setUndoThread] = useState(null)

        // ---- 保存到本地 / 本地文稿状态（CONTRACT §13.3） --------------------
        /** 自动保存开关（持久化在阅读偏好里；默认关）。 */
        const [autoSave, setAutoSave] = useState(function () {
          return sanitizePrefs(cache.prefs).autoSave
        })
        /**
         * 保存状态机：idle | saving | done | failed。
         * key = 文章身份键：切到别的文章后「已保存」不会错误残留；
         * auto = 本次是否由自动保存触发（按钮文案区分「已保存 / 已自动保存」）。
         */
        const [saveStatus, setSaveStatus] = useState({ status: 'idle', key: '', id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: false })
        /** 保存结果条：null = 不显示；否则 { kind: 'done'|'error', dirLabel, id, message, unchanged }。 */
        const [saveNotice, setSaveNotice] = useState(null)
        // ---- 左侧文章翻译（CONTRACT §19.1） ---------------------------------
        /** 整篇翻译状态机：idle | loading | streaming | done | error（key = 文章身份键，切文章自动失效）。 */
        const [translation, setTranslation] = useState(function () {
          const cached = cache.translation
          if (cached && typeof cached === 'object' && typeof cached.key === 'string' && typeof cached.content === 'string') {
            if (cached.status === 'loading' || cached.status === 'streaming') {
              return Object.assign({}, cached, { status: 'error', error: t('translate.cancelled') })
            }
            return cached
          }
          return { status: 'idle', key: '', content: '', error: '' }
        })
        /** 左栏当前是否显示译文（false = 显示原文）。 */
        const [showTranslation, setShowTranslation] = useState(function () {
          return Boolean(cache.translation && cache.translation.show)
        })
        /** 本地文稿视图：null = 文章视图；对象 = 列表视图（items / dir / dirLabel / loading / error / confirmId / deletingId）。 */
        const [savedView, setSavedView] = useState(null)
        /** 本地文稿数量（工具条图标角标；列表/保存/删除后刷新）。 */
        const [savedCount, setSavedCount] = useState(0)

        // ---- refs ------------------------------------------------------------
        const readerRef = useRef(null)
        const threadRef = useRef(null)
        const bodyRef = useRef(null)
        const selectionButtonRef = useRef(null)
        /** 选区提问输入框（出现时自动聚焦，选中后可直接打字）。 */
        const selectionInputRef = useRef(null)
        const abortRef = useRef(null)
        const requestSeqRef = useRef(0)
        const mountedRef = useRef(true)
        /** 最新一版 openArticle：外部握手（AI 浏览器）调用时避免闭包读到旧 state。 */
        const openArticleRef = useRef(null)
        const articleFetchSeqRef = useRef(0)
        const articleFetchAbortRef = useRef(null)
        const providedContentRef = useRef(null)
        /** 已渲染的 user 消息数：用于「只在用户发新问题时滚到底部」，流式输出不跟随（CONTRACT §18）。 */
        const userCountRef = useRef(0)
        const selectionRef = useRef(null)
        const selectionTimerRef = useRef(0)
        const dragCleanupRef = useRef(null)
        // 知识库联动相关 refs
        const relatedSeqRef = useRef(0)
        const previewSeqRef = useRef(0)
        const ingestSeqRef = useRef(0)
        const ingestTimerRef = useRef(0)
        const ingestRequestRef = useRef(0)
        const ingestSourceRef = useRef('')
        const passageIngestRef = useRef(null)
        /** KB 预览返回时恢复焦点的触发元素。 */
        const kbTriggerRef = useRef(null)
        const kbReturnPaneRef = useRef('article')
        /** KB 预览返回按钮（打开后移入焦点）。 */
        const kbBackRef = useRef(null)
        /** 当前 KB 预览状态镜像（供 document 键盘事件读取）。 */
        const kbPreviewRef = useRef(null)
        const articleScrollRef = useRef(0)
        const pendingArticleScrollRef = useRef(null)
        // 本地文件上传相关 refs
        const dragDepthRef = useRef(0)
        const fileInputRef = useRef(null)
        const fileNoticeTimerRef = useRef(0)
        const uploadSeqRef = useRef(0)
        /** 翻译请求的 AbortController 与序号（切文章/卸载时取消）。 */
        const translationAbortRef = useRef(null)
        const translationSeqRef = useRef(0)
        /** 清空线程撤销条自动消失的定时器。 */
        const undoTimerRef = useRef(0)
        // 保存到本地 / 本地文稿相关 refs
        /** 保存请求序号：切换文章 / 连续点击时让旧请求失效。 */
        const saveSeqRef = useRef(0)
        /** 保存结果条自动消失定时器。 */
        const saveNoticeTimerRef = useRef(0)
        /** 本地文稿列表请求序号。 */
        const librarySeqRef = useRef(0)
        /** 本地文稿「确认删除」倒计时定时器。 */
        const libraryConfirmTimerRef = useRef(0)
        /** 当前保存状态镜像（供异步闭包读取最新值）。 */
        const saveStatusRef = useRef(saveStatus)
        /** 本地文稿工具条按钮（退出视图时把焦点还给它）与返回按钮（进入视图时聚焦）。 */
        const libraryTriggerRef = useRef(null)
        const libraryBackRef = useRef(null)
        /** 关闭本地文稿视图后是否要把焦点还给工具条按钮（只有「返回按钮」路径需要）。 */
        const libraryRestoreFocusRef = useRef(false)

        // 摘抄独立于文章存档与 AI 对话；新增 hooks 放在既有状态/ref 之后。
        const [excerptDraft, setExcerptDraft] = useState({ open: false, tags: [], newTag: '', status: 'idle', error: '', requestId: '' })
        const [excerptOptions, setExcerptOptions] = useState({ loading: false, tags: [], error: '' })
        const [excerptsView, setExcerptsView] = useState(null)
        const excerptDraftSeqRef = useRef(0)
        const excerptSaveRef = useRef(null)
        const excerptViewSeqRef = useRef(0)
        const excerptsViewRef = useRef(null)
        const excerptTagInputRef = useRef(null)
        const excerptNoteTriggerRef = useRef(null)
        const excerptNoteBackRef = useRef(null)
        excerptsViewRef.current = excerptsView
        const [selectionBands, setSelectionBands] = useState([])
        const readerInnerRef = useRef(null)
        const excerptDeleteRef = useRef(null)
        const excerptDeleteTriggerRef = useRef(null)

        const [articleEditor, setArticleEditor] = useState(function () {
          const draft = cache.articleEditor
          if (!draft || !article || draft.key !== articleIdentityKey(article)) return null
          return Object.assign({}, draft, { status: 'editing',
            error: draft.status === 'saving' ? t('edit.interrupted') : draft.error || '' })
        })
        const articleEditorRef = useRef(articleEditor)
        const articleEditorGroupRef = useRef(0)
        const articleEditTriggerRef = useRef(null)
        const articleEditFocusRef = useRef(false)
        const articleEditRestoreFocusRef = useRef(false)
        articleEditorRef.current = articleEditor
        useEffect(function () { cache.articleEditor = articleEditor }, [articleEditor])
        useEffect(function () {
          if (!articleEditor || !readerRef.current || !readerRef.current.querySelectorAll) return
          const inputs = readerRef.current.querySelectorAll('.air-edit-input')
          for (let index = 0; index < inputs.length; index += 1) resizeArticleEditorInput(inputs[index])
          if (articleEditFocusRef.current && inputs[0] && inputs[0].focus) {
            articleEditFocusRef.current = false
            inputs[0].focus({ preventScroll: true })
          }
        }, [articleEditor ? articleEditor.history.length : -1, fontLevel, widthLevel])
        useEffect(function () {
          if (articleEditor || !articleEditRestoreFocusRef.current) return
          articleEditRestoreFocusRef.current = false
          if (articleEditTriggerRef.current && articleEditTriggerRef.current.focus) articleEditTriggerRef.current.focus({ preventScroll: true })
        }, [Boolean(articleEditor)])

        // ---- 派生数据 --------------------------------------------------------
        const fontPref = FONT_PREFS[fontLevel - 1] || FONT_PREFS[1]
        const widthPref = WIDTH_PREFS[widthLevel - 1] || WIDTH_PREFS[1]
        // 图片「查看大图」提示随语言变化：作为 memo 依赖，切换语言后文章节点会重建
        const viewImageLabel = t('reader.viewImage')
        const tableLabel = t('reader.table')
        const articleNodes = useMemo(function () {
          return article ? buildArticleNodes(article.blocks, article.url, viewImageLabel, tableLabel) : []
        }, [article, viewImageLabel, tableLabel])
        const charCount = useMemo(function () {
          return article ? articleCharCount(article) : 0
        }, [article])
        const readingMinutes = useMemo(function () {
          return article ? readingMinutesFor(articlePlainText(article)) : 0
        }, [article])
        const canSend = !!article && !busy && !articleEditor && composer.trim().length > 0
        const maxUploadLabel = formatFileSize(fileLimits.maxUploadBytes, t)
        // 保存上限（/meta.limits.maxSaveBytes，缺失时用内置 40MB 兜底）
        const maxSaveBytes =
          limits && typeof limits.maxSaveBytes === 'number' && limits.maxSaveBytes > 0 ? limits.maxSaveBytes : DEFAULT_MAX_SAVE_BYTES
        const localFile = article && article.file && typeof article.file.name === 'string' && article.file.name ? article.file : null
        // 文章身份 key：用于「相关知识」「已在知识库」等 KB 副作用随文章切换刷新
        const articleKey = article ? articleIdentityKey(article) : ''
        const kbReady = kbStatus === 'ready'
        const badgeText = metaState === 'ready' ? modelLabel || t('header.modelUnknown') : metaState === 'error' ? t('header.modelUnavailable') : t('header.modelLoading')
        const badgeTitle =
          limits && typeof limits.maxPromptChars === 'number' && limits.maxPromptChars > 0
            ? t('header.modelTip', { n: String(limits.maxPromptChars) })
            : badgeText
        // 保存状态镜像：异步回调（保存/删除）读取最新值，避免闭包拿到旧 state。
        saveStatusRef.current = saveStatus
        // 外部打开握手：把本轮渲染的最新 openArticle 暴露给订阅者（AI 浏览器 → AI 阅读助手）
        openArticleRef.current = function (request) {
          return request.content ? openProvidedContent(request) : openArticle(request.url, { external: true })
        }

        // ---- 副作用 ----------------------------------------------------------

        // 切换文章时关闭「清空」的撤销窗口：旧线程属于旧文章，不应被恢复。
        // 同时清理上一篇文章的保存状态/结果条（打开本地文稿时 handler 会先把新状态写好，
        // 这里按 key 判断，key 一致就保留，避免「已保存」被误清）。
        useEffect(
          function () {
            if (undoTimerRef.current) {
              window.clearTimeout(undoTimerRef.current)
              undoTimerRef.current = 0
            }
            setUndoThread(null)
            if (saveNoticeTimerRef.current) {
              window.clearTimeout(saveNoticeTimerRef.current)
              saveNoticeTimerRef.current = 0
            }
            setSaveNotice(null)
            setSaveStatus(function (previous) {
              if (previous && previous.key === articleKey) return previous
              return { status: 'idle', key: articleKey, id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: false }
            })
          },
          [articleKey],
        )

        // 外部打开请求（window 事件 'dsh-ai-reader:open'）：面板已挂载时直接打开文章；
        // 首次进入时事件发生在挂载前，subscribeExternalOpen 会先消费挂起的请求。
        useEffect(function () {
          return subscribeExternalOpen(function (request) {
            const opener = openArticleRef.current
            if (typeof opener === 'function') void opener(request)
          })
        }, [])

        // 挂载时读取本地文稿数量（工具条角标）；失败静默忽略（不阻塞阅读）。
        useEffect(function () {
          let cancelled = false
          void (async function () {
            try {
              const data = await readerFetchJson('/saved', { timeoutMs: LIBRARY_HTTP_TIMEOUT_MS })
              if (cancelled || !mountedRef.current) return
              const items = data && Array.isArray(data.items) ? data.items : []
              setSavedCount(items.length)
            } catch (error) {
              // 保存功能不可用时不打扰用户：角标保持 0
            }
          })()
          return function () {
            cancelled = true
          }
        }, [])

        // 挂载时读取 Host 模型信息；失败只影响徽标，不阻塞 UI。
        useEffect(function () {
          let cancelled = false
          async function loadMeta() {
            try {
              const response = await fetch(ORIGIN + '/meta', { cache: 'no-store', headers: { accept: 'application/json' } })
              let data = null
              try {
                data = await response.json()
              } catch (error) {
                data = null
              }
              if (cancelled) return
              if (response.ok && data && data.ok) {
                const model = data.model && typeof data.model === 'object' ? data.model : {}
                const label = typeof model.label === 'string' && model.label ? model.label : [model.provider, model.model].filter(Boolean).join(' / ')
                setModelLabel(label || '')
                const nextLimits = data.limits && typeof data.limits === 'object' ? data.limits : null
                setLimits(nextLimits)
                // 本地文件：上传上限 + 支持扩展名（缺失时用内置 111 项兜底，保证拖拽/选择文件始终可用）
                const uploadLimit =
                  nextLimits && typeof nextLimits.maxUploadBytes === 'number' && nextLimits.maxUploadBytes > 0
                    ? nextLimits.maxUploadBytes
                    : DEFAULT_MAX_UPLOAD_BYTES
                const supported =
                  data.fileFormats && Array.isArray(data.fileFormats.supportedExtensions) ? data.fileFormats.supportedExtensions : null
                setFileLimits({ maxUploadBytes: uploadLimit, extensions: normalizeExtensions(supported) })
                // 联网检索（CONTRACT §14.4）：服务缺失时「联网」开关置灰
                if (data.web && typeof data.web.available === 'boolean') setWebAvailable(data.web.available)
                setMetaState('ready')
              } else {
                setModelLabel('')
                setMetaState('error')
              }
            } catch (error) {
              if (!cancelled) {
                setModelLabel('')
                setMetaState('error')
              }
            }
          }
          void loadMeta()
          return function () {
            cancelled = true
          }
        }, [])

        // 模块级 cache 同步（面板切走再切回时恢复现场）。
        useEffect(
          function () {
            cache.article = article
            cache.thread = thread
            cache.split = split
            cache.translation = {
              key: translation.key,
              content: translation.content,
              status: translation.status,
              error: translation.error,
              show: showTranslation,
            }
          },
          [article, thread, split, translation, showTranslation],
        )

        // 文章切换 / 回到首页：取消并清空上一篇文章的翻译（CONTRACT §19.1）。
        useEffect(
          function () {
            if (!articleKey) {
              translationSeqRef.current += 1
              if (translationAbortRef.current) {
                try {
                  translationAbortRef.current.abort()
                } catch (error) {
                  // ignore
                }
                translationAbortRef.current = null
              }
              setTranslation(function (previous) {
                return previous.status === 'idle' && !previous.content ? previous : { status: 'idle', key: '', content: '', error: '' }
              })
              setShowTranslation(function (previous) {
                return previous ? false : previous
              })
              return
            }
            if (!translation.key || translation.key === articleKey) return
            translationSeqRef.current += 1
            if (translationAbortRef.current) {
              try {
                translationAbortRef.current.abort()
              } catch (error) {
                // ignore
              }
              translationAbortRef.current = null
            }
            setTranslation({ status: 'idle', key: '', content: '', error: '' })
            setShowTranslation(false)
          },
          [articleKey],
        )

        // 卸载清理：abort 进行中的请求、清定时器、移除拖拽监听。
        useEffect(function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
            invalidateArticleFetch()
            requestSeqRef.current += 1
            if (abortRef.current) {
              try {
                abortRef.current.abort()
              } catch (error) {
                // ignore
              }
              abortRef.current = null
            }
            if (selectionTimerRef.current) window.clearTimeout(selectionTimerRef.current)
            excerptDraftSeqRef.current += 1
            excerptViewSeqRef.current += 1
            if (dragCleanupRef.current) dragCleanupRef.current()
            relatedSeqRef.current += 1
            previewSeqRef.current += 1
            ingestSeqRef.current += 1
            if (ingestTimerRef.current) window.clearTimeout(ingestTimerRef.current)
            if (passageIngestRef.current) passageIngestRef.current.abort()
            passageIngestRef.current = null
            uploadSeqRef.current += 1
            dragDepthRef.current = 0
            if (fileNoticeTimerRef.current) window.clearTimeout(fileNoticeTimerRef.current)
            if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current)
            saveSeqRef.current += 1
            librarySeqRef.current += 1
            if (saveNoticeTimerRef.current) window.clearTimeout(saveNoticeTimerRef.current)
            translationSeqRef.current += 1
            if (translationAbortRef.current) {
              try {
                translationAbortRef.current.abort()
              } catch (error) {
                // ignore
              }
              translationAbortRef.current = null
            }
            if (libraryConfirmTimerRef.current) window.clearTimeout(libraryConfirmTimerRef.current)
          }
        }, [])

        // 全局监听：点其它区域 / 窗口 resize / Esc 时隐藏浮动按钮。
        useEffect(function () {
          function handleDocumentMouseDown(event) {
            const target = event.target
            if (!target || typeof target.closest !== 'function') return
            if (selectionButtonRef.current && selectionButtonRef.current.contains(target)) return
            if (readerRef.current && readerRef.current.contains(target)) return
            setSelection(null)
          }
          function handleDocumentKeyDown(event) {
            if (event.key !== 'Escape') return
            if (excerptsViewRef.current) {
              closeExcerptsView()
              return
            }
            if (kbPreviewRef.current) {
              closeKbPreview()
              return
            }
            if (selectionRef.current) {
              closeSelectionBar()
              return
            }
            setSelection(null)
          }
          function handleWindowResize() {
            setSelection(null)
          }
          document.addEventListener('mousedown', handleDocumentMouseDown, true)
          document.addEventListener('keydown', handleDocumentKeyDown)
          window.addEventListener('resize', handleWindowResize)
          return function () {
            document.removeEventListener('mousedown', handleDocumentMouseDown, true)
            document.removeEventListener('keydown', handleDocumentKeyDown)
            window.removeEventListener('resize', handleWindowResize)
          }
        }, [])

        // 选区状态镜像（供 Cmd/Ctrl+J 等事件回调读取最新值）。
        useEffect(
          function () {
            selectionRef.current = selection
          },
          [selection],
        )

        // 原文/译文、知识库预览和文章切换后，旧 Range 不再代表当前可见正文。
        useEffect(function () {
          setSelection(null)
        }, [articleKey, showTranslation, kbPreview ? kbPreview.path : '', Boolean(savedView), Boolean(excerptsView)])

        // 新选区/关闭后重置摘抄草稿。旧请求完成时不能覆盖后来选中的内容。
        useEffect(function () {
          excerptDraftSeqRef.current += 1
          excerptSaveRef.current = null
          setExcerptDraft({ open: false, tags: [], newTag: '', status: 'idle', error: '', requestId: '' })
        }, [selection])

        // 独立笔记视图保留当前文章、阅读位置与对话；换文章后退出笔记视图。
        useEffect(function () {
          excerptViewSeqRef.current += 1
          setExcerptsView(null)
        }, [article])

        useEffect(function () {
          if (excerptsView && excerptNoteBackRef.current) excerptNoteBackRef.current.focus()
        }, [Boolean(excerptsView)])

        // 展开标签编辑器后按真实高度重定位，直接更新样式以免重设选区或抢输入焦点。
        useEffect(function () {
          const card = selectionButtonRef.current
          if (!selection || !card) return
          const reposition = function () {
            try {
              const rect = selection.range.getBoundingClientRect()
              const size = card.getBoundingClientRect()
              const placement = floatingPlacement(rect, readerRef.current ? readerRef.current.getBoundingClientRect() : null, size.width || SELECTION_ASK_WIDTH, size.height || SELECTION_ASK_HEIGHT)
              card.style.top = Math.max(8, placement.top) + 'px'
              card.style.left = placement.left + 'px'
            } catch (error) { /* A detached range is cleared by the view lifecycle. */ }
          }
          reposition()
          if (typeof window.ResizeObserver !== 'function') return
          const observer = new window.ResizeObserver(reposition)
          observer.observe(card)
          return function () { observer.disconnect() }
        }, [selection, excerptDraft.open, excerptDraft.status, excerptDraft.tags, excerptOptions.loading, excerptOptions.tags, excerptDraft.error, passageIngest])

        // 输入框获得焦点后浏览器会收起原生选区；独立绘制原文高亮，不改动正文 DOM。
        // 此 effect 必须在自动聚焦前执行；关闭、重选和卸载均只清理本插件的高亮。
        useLayoutEffect(function () {
          if (!selection || !selection.range || typeof window === 'undefined') return
          const registry = window.CSS && window.CSS.highlights
          if (!registry || typeof window.Highlight !== 'function') return
          const highlight = new window.Highlight(selection.range)
          registry.set(SELECTION_HIGHLIGHT_NAME, highlight)
          return function () {
            if (registry.get(SELECTION_HIGHLIGHT_NAME) === highlight) registry.delete(SELECTION_HIGHLIGHT_NAME)
          }
        }, [selection])

        useLayoutEffect(function () {
          const inner = readerInnerRef.current
          const customHighlightAvailable = typeof window !== 'undefined' && window.CSS && window.CSS.highlights && typeof window.Highlight === 'function'
          if (!selection || !inner || !customHighlightAvailable) { setSelectionBands(function (previous) { return previous.length ? [] : previous }); return }
          let active = true
          const update = function () {
            if (!active) return
            const next = collectSelectionBands(selection.range, inner)
            setSelectionBands(function (previous) {
              return previous.length === next.length && previous.every(function (band, index) {
                const other = next[index]
                return band.left === other.left && band.top === other.top && band.width === other.width && band.height === other.height
              }) ? previous : next
            })
          }
          update()
          if (typeof window.ResizeObserver !== 'function') return function () { active = false }
          const observer = new window.ResizeObserver(update)
          observer.observe(inner)
          return function () { active = false; observer.disconnect() }
        }, [selection])

        // 选区提问框：出现时聚焦输入框（选中即可直接打字），关闭时清空输入（CONTRACT §3.3）。
        useEffect(
          function () {
            if (selection) {
              const input = excerptDraft.open ? excerptTagInputRef.current : selectionInputRef.current
              if (input && typeof input.focus === 'function') input.focus()
              return
            }
            setSelectionQuestion('')
          },
          [selection, excerptDraft.open],
        )

        // 线程滚动策略（CONTRACT §18）：只在「用户发出新问题」时滚到最新（让新问题与回答开头进入视野），
        // AI 流式输出过程中不再跟随滚动，避免用户阅读时右侧页面一直跳；完成回答、追加参考也不滚动。
        useEffect(
          function () {
            const userCount = thread.reduce(function (total, message) {
              return total + (message && message.role === 'user' ? 1 : 0)
            }, 0)
            const previous = userCountRef.current
            userCountRef.current = userCount
            const scroller = threadRef.current
            if (!scroller) return
            if (userCount > previous) scroller.scrollTop = scroller.scrollHeight
          },
          [thread],
        )

        useEffect(function () { setCompactPane('article') }, [articleKey])

        // 挂载时探测知识库可用性（/dsh-kb/meta）；失败静默标记不可用，不阻塞 UI。
        useEffect(function () {
          let cancelled = false
          void (async function () {
            const result = await kbProbe()
            if (cancelled || !mountedRef.current) return
            setKbStatus(result.ready ? 'ready' : 'unavailable')
            setKbPassageSupported(result.passage === true)
          })()
          return function () {
            cancelled = true
          }
        }, [])

        // 文章切换 / KB 就绪 / 开关变化时自动关联相关知识；无结果或不可用则整条隐藏。
        useEffect(function () {
          relatedSeqRef.current += 1
          setKbRelated(null)
          if (!article || kbStatus !== 'ready' || !kbEnabled) {
            setKbRelated(null)
            setKbRelatedLoading(false)
            return
          }
          void fetchKbRelated(article)
          return function () {
            relatedSeqRef.current += 1
          }
        }, [articleKey, kbStatus, kbEnabled])

        // 本地编辑稿也沿用原文身份；检查完成前不开放重复存入入口。
        useEffect(function () {
          const seq = ingestSeqRef.current + 1
          ingestSeqRef.current = seq
          ingestRequestRef.current = 0
          if (ingestTimerRef.current) {
            window.clearTimeout(ingestTimerRef.current)
            ingestTimerRef.current = 0
          }
          setKbIngest({ status: 'idle', stage: '', pages: 0, error: '' })
          if (!article || kbStatus !== 'ready') return
          setKbIngest({ status: 'checking', stage: '', pages: 0, error: '' })
          let cancelled = false
          void (async function () {
            let source = null
            try { source = await findArticleKbSource(article) } catch (error) { /* Backend still enforces deduplication if lookup fails. */ }
            if (cancelled || !mountedRef.current || ingestSeqRef.current !== seq) return
            if (source) rememberArticleKbSource(article, source.id)
            setKbIngest({ status: source ? 'exists' : 'idle', stage: '', pages: 0, error: '' })
          })()
          return function () { cancelled = true }
        }, [article, kbStatus])

        // 面板切走再切回时恢复同一篇文章的阅读位置（模块级 cache）。
        useEffect(
          function () {
            if (kbPreview || savedView || excerptsView) return
            const scroller = readerRef.current
            if (!scroller) return
            const saved = cache.readerScroll
            if (!saved || !articleKey || saved.key !== articleKey) return
            if (pendingArticleScrollRef.current !== null) return
            scroller.scrollTop = saved.top
          },
          [articleKey, kbPreview, mode, savedView, excerptsView],
        )

        // KB 预览打开时把焦点移入返回按钮，关闭时还给触发元素（读屏/键盘路径）。
        useEffect(function () {
          if (kbPreview) {
            const back = kbBackRef.current
            if (back && typeof back.focus === 'function') back.focus()
            return
          }
          const trigger = kbTriggerRef.current
          kbTriggerRef.current = null
          if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus()
        }, [kbPreview])

        // kbPreview 镜像（document 级 Esc 监听读取）
        useEffect(
          function () {
            kbPreviewRef.current = kbPreview
          },
          [kbPreview],
        )

        // 从 KB 预览 / 本地文稿视图返回文章、或打开新文章时，应用待恢复的阅读滚动位置（CONTRACT §13.3.3/§13.3.4）。
        useEffect(function () {
          if (kbPreview || savedView || excerptsView) return
          const pending = pendingArticleScrollRef.current
          if (pending === null) return
          const scroller = readerRef.current
          if (!scroller || !scroller.clientHeight) return
          pendingArticleScrollRef.current = null
          scroller.scrollTop = pending
        }, [articleKey, kbPreview, savedView, excerptsView, compactPane])

        // 本地文稿视图焦点管理：进入时聚焦返回按钮，从返回按钮退出时把焦点还给工具条按钮（P2-13）。
        useEffect(
          function () {
            if (savedView) {
              const back = libraryBackRef.current
              if (back && typeof back.focus === 'function') back.focus()
              return
            }
            if (!libraryRestoreFocusRef.current) return
            libraryRestoreFocusRef.current = false
            const trigger = libraryTriggerRef.current
            if (trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus()
          },
          [savedView],
        )

        // ---- 事件处理：左栏 --------------------------------------------------

        /**
         * URL 模式 / 粘贴模式的切换。
         * @returns {void}
         */
        function toggleMode() {
          if (editorBlocksNavigation()) return
          setLeftError('')
          setSelection(null)
          if (excerptsView) closeExcerptsView()
          // 本地文稿视图打开时切到粘贴/URL 模式：先回到文章视图，否则表单被列表挡在后面
          if (savedView) closeSavedView()
          setMode(function (previous) {
            return previous === 'url' ? 'paste' : 'url'
          })
        }

        /**
         * 应用阅读偏好：更新字号 / 版心档位，并写入模块级 cache 与 localStorage。
         * @param {{ fontSize: number, width: number }} next 新偏好（1/2/3 档）。
         * @returns {void}
         */
        function applyReadingPrefs(next) {
          // 合并已有偏好再写回：只改字号/版心时不能把 autoSave / kbEnabled 重置为默认值（CONTRACT §13.3.5）
          const safe = saveStoredPrefs(Object.assign({}, cache.prefs, next))
          setFontLevel(safe.fontSize)
          setWidthLevel(safe.width)
        }

        /**
         * 「Aa」按钮：正文字号在 小 → 标准 → 大 三档间循环。
         * @returns {void}
         */
        function cycleFontLevel() {
          applyReadingPrefs({ fontSize: fontLevel >= 3 ? 1 : fontLevel + 1, width: widthLevel })
        }

        /**
         * 「版心」按钮：版心宽度在 窄 → 标准 → 宽 三档间循环。
         * @returns {void}
         */
        function cycleWidthLevel() {
          applyReadingPrefs({ fontSize: fontLevel, width: widthLevel >= 3 ? 1 : widthLevel + 1 })
        }

        // ---- 事件处理：知识库联动 --------------------------------------------

        /**
         * 文章切换时重置所有 KB 文章级状态（相关 chips / 存入状态 / 预览 / 检索阶段），
         * 并让仍在轮询的 ingest job 与相关检索失效。
         * @returns {void}
         */
        function resetKbArticleState() {
          ingestRequestRef.current = 0
          ingestSourceRef.current = ''
          if (passageIngestRef.current) passageIngestRef.current.abort()
          passageIngestRef.current = null
          setPassageIngest(null)
          relatedSeqRef.current += 1
          ingestSeqRef.current += 1
          if (ingestTimerRef.current) {
            window.clearTimeout(ingestTimerRef.current)
            ingestTimerRef.current = 0
          }
          setKbRelated(null)
          setKbRelatedLoading(false)
          setKbIngest({ status: 'idle', stage: '', pages: 0, error: '' })
          setKbPreview(null)
          setKbPhase('')
        }

        /**
         * 切换「解读时参考知识库」开关并持久化；KB 不可用时忽略。
         * @returns {void}
         */
        function toggleKbEnabled() {
          if (kbStatus === 'unavailable') return
          const saved = saveStoredPrefs(Object.assign({}, cache.prefs, { kbEnabled: !kbEnabled }))
          setKbEnabled(saved.kbEnabled)
        }

        /**
         * 切换「联网检索」开关并持久化；联网服务不可用时忽略。
         * @returns {void}
         */
        function toggleWebEnabled() {
          if (!webAvailable) return
          const saved = saveStoredPrefs(Object.assign({}, cache.prefs, { webEnabled: !webEnabled }))
          setWebEnabled(saved.webEnabled)
        }

        /**
         * 自动关联：用文章标题搜索 KB，结果写入 kbRelated（失败 / 无结果 → 空数组）。
         * @param {any} targetArticle 目标文章。
         * @returns {Promise<void>}
         */
        async function fetchKbRelated(targetArticle) {
          const title = targetArticle && typeof targetArticle.title === 'string' ? targetArticle.title.trim().slice(0, KB_QUERY_MAX) : ''
          if (!title || kbStatus !== 'ready' || !kbEnabled) {
            if (mountedRef.current) setKbRelated([])
            return
          }
          const seq = relatedSeqRef.current + 1
          relatedSeqRef.current = seq
          setKbRelatedLoading(true)
          try {
            let results = await kbSearch(title, KB_RELATED_CANDIDATES)
            let related = kbRelatedItems(results, targetArticle)
            if (!mountedRef.current || relatedSeqRef.current !== seq) return
            // A notebook may have many excerpts of this article ahead of other useful results.
            if (related.length < KB_RELATED_LIMIT && results.length >= KB_RELATED_CANDIDATES) {
              try {
                results = await kbSearch(title, 100)
                related = kbRelatedItems(results, targetArticle)
              } catch (error) { /* Keep the useful first batch when the expanded search fails. */ }
            }
            if (!mountedRef.current || relatedSeqRef.current !== seq) return
            setKbRelated(related)
          } catch (error) {
            if (!mountedRef.current || relatedSeqRef.current !== seq) return
            // 刷新失败时保留上一次的相关结果，避免信息突然消失
          } finally {
            if (mountedRef.current && relatedSeqRef.current === seq) setKbRelatedLoading(false)
          }
        }

        /**
         * 左栏打开一个 KB 页面预览（保存当前阅读滚动位置，返回时恢复）。
         * @param {string} path KB 页面路径。
         * @returns {void}
         */
        function openKbPage(path) {
          if (editorBlocksNavigation()) return
          const safePath = String(path == null ? '' : path).trim()
          if (!safePath) return
          const inSavedView = !!savedView
          if (!kbPreview) kbReturnPaneRef.current = compactPane
          // 只有「文章视图直接打开 KB 预览」时才记录文章滚动位置；从本地文稿视图进入时保留原值（P2-10）
          if (!kbPreview && !inSavedView && !excerptsView) {
            const scroller = readerRef.current
            const saved = cache.readerScroll
            if (scroller && scroller.clientHeight) articleScrollRef.current = scroller.scrollTop
            else articleScrollRef.current = saved && saved.key === articleKey ? saved.top : 0
            const active = typeof document !== 'undefined' ? document.activeElement : null
            kbTriggerRef.current = active && typeof active.focus === 'function' ? active : null
          }
          if (inSavedView) closeSavedView()
          if (excerptsView) closeExcerptsView()
          const seq = previewSeqRef.current + 1
          previewSeqRef.current = seq
          setCompactPane('article')
          setKbPreview({ path: safePath, loading: true, error: '', page: null })
          void (async function () {
            try {
              const page = await kbReadPage(safePath)
              if (!mountedRef.current || previewSeqRef.current !== seq) return
              setKbPreview({ path: safePath, loading: false, error: '', page: page })
            } catch (error) {
              if (!mountedRef.current || previewSeqRef.current !== seq) return
              setKbPreview({ path: safePath, loading: false, error: errorMessage(error, t('kb.preview.failed')), page: null })
            }
          })()
        }

        /**
         * 重试加载当前 KB 预览页。
         * @returns {void}
         */
        function retryKbPreview() {
          if (kbPreview && kbPreview.path) openKbPage(kbPreview.path)
        }

        /**
         * 关闭 KB 预览，返回此前的工作区。
         * @returns {void}
         */
        function closeKbPreview() {
          pendingArticleScrollRef.current = articleScrollRef.current
          setCompactPane(kbReturnPaneRef.current)
          setKbPreview(null)
        }

        function kbArticleCacheKeys(target) {
          const key = articleIdentityKey(target)
          const keys = [key]
          const saved = saveStatusRef.current
          if (saved && saved.key === key && saved.sourceRef) keys.push('saved:' + saved.sourceRef)
          return keys
        }

        function rememberArticleKbSource(target, sourceId) {
          if (!sourceId) return
          kbArticleCacheKeys(target).forEach(function (key) { cache.kbIngested[key] = sourceId })
        }

        async function findArticleKbSource(target) {
          const data = await kbFetchJson('/tree', {})
          const sources = (Array.isArray(data.sources) ? data.sources : []).filter(function (source) { return source && !source.passage && source.status !== 'failed' })
          const links = kbArticleLinks(target)
          const keys = kbArticleCacheKeys(target)
          const ids = keys.map(function (key) { return cache.kbIngested[key] }).filter(Boolean)
          const linked = sources.find(function (source) {
            return (source.url && links.indexOf(kbNormalizeLink(source.url)) !== -1) || ids.indexOf(source.id) !== -1
          })
          if (linked) return linked
          const text = articlePlainText(target).slice(0, 200000).replace(/\r\n?/g, '\n').trim()
          if (!text) return null
          if (window.crypto && window.crypto.subtle && sources.some(function (source) { return source.textHash })) {
            try {
              const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
              const hash = Array.from(new Uint8Array(digest)).map(function (value) { return value.toString(16).padStart(2, '0') }).join('')
              const sameText = sources.find(function (source) { return source.textHash === hash })
              if (sameText) return sameText
            } catch (error) { /* Older clients can still match sources by their URL or exact text. */ }
          }
          // Compatibility with older KB /tree summaries: read only a bounded set of
          // linkless records with the same character count, then compare full text.
          const candidates = sources.filter(function (source) {
            return source.id && !source.url && !source.textHash && source.chars === text.length
          }).slice(0, 8)
          const matches = await Promise.all(candidates.map(async function (source) {
            try {
              const detail = await kbFetchJson('/source?id=' + encodeURIComponent(source.id), {})
              return typeof detail.text === 'string' && detail.text.replace(/\r\n?/g, '\n').trim() === text ? source : null
            } catch (error) { return null }
          }))
          return matches.find(Boolean) || null
        }

        /**
         * 存入完成后 3s 恢复按钮状态（链接型文章现在在知识库里 → 显示「已在知识库」）。
         * @param {number} seq 本次 ingest 序号。
         * @returns {void}
         */
        function scheduleIngestRestore(seq) {
          if (ingestTimerRef.current) window.clearTimeout(ingestTimerRef.current)
          ingestTimerRef.current = window.setTimeout(function () {
            ingestTimerRef.current = 0
            if (!mountedRef.current || ingestSeqRef.current !== seq) return
            setKbIngest({ status: 'exists', stage: '', pages: 0, error: '' })
          }, 3000)
        }

        /**
         * 900ms 间隔轮询 KB job，直到 done / failed / 180s 超时。
         * @param {string} jobId KB 任务 id。
         * @param {number} seq 本次 ingest 序号（文章切换 / 卸载后自动失效）。
         * @returns {Promise<void>}
         */
        async function pollIngestJob(jobId, seq) {
          const job = await pollKbIngestJob(jobId, function () { return mountedRef.current && ingestSeqRef.current === seq }, function (stage) {
            setKbIngest({ status: 'running', stage: stage, pages: 0, error: '' })
          })
          if (!job || !mountedRef.current || ingestSeqRef.current !== seq) return
          if (job.status === 'timeout') {
            setKbIngest({ status: 'timeout', stage: '', pages: 0, error: t('kb.ingest.timeout') })
          } else if (job.status === 'failed') {
            const message = typeof job.error === 'string' && job.error || typeof job.message === 'string' && job.message || t('kb.ingest.failed')
            setKbIngest({ status: 'failed', stage: '', pages: 0, error: message })
          } else {
            const pages = job.result && Array.isArray(job.result.pages) ? job.result.pages.length : 0
            rememberArticleKbSource(article, ingestSourceRef.current)
            setKbIngest({ status: 'done', stage: '', pages: pages, error: '' })
            if (kbEnabled) void fetchKbRelated(article)
            scheduleIngestRestore(seq)
          }
        }

        /**
         * 「存入知识库」：链接型走 ingest-url、粘贴型走 ingest-text，拿 jobId 后开始轮询。
         * @returns {Promise<void>}
         */
        async function startIngest() {
          if (editorBlocksNavigation()) return
          if (!article || kbStatus !== 'ready') return
          const current = kbIngest.status
          if (ingestRequestRef.current || current === 'checking' || current === 'running' || current === 'exists' || current === 'done') return
          const seq = ingestSeqRef.current + 1
          ingestSeqRef.current = seq
          ingestRequestRef.current = seq
          if (ingestTimerRef.current) {
            window.clearTimeout(ingestTimerRef.current)
            ingestTimerRef.current = 0
          }
          setKbIngest({ status: 'running', stage: t('kb.ingest.starting'), pages: 0, error: '' })
          try {
            let existing = null
            try { existing = await findArticleKbSource(article) } catch (error) { /* Fall back to the idempotent ingest endpoint. */ }
            if (!mountedRef.current || ingestSeqRef.current !== seq) return
            if (existing) {
              rememberArticleKbSource(article, existing.id)
              setKbIngest({ status: 'exists', stage: '', pages: 0, error: '' })
              return
            }
            const link = kbArticleLink(article)
            let data = null
            if (link && article.edited !== true && !['rss', 'publisher'].includes(article.contentSource)) {
              data = await kbFetchJson('/ingest-url', {
                method: 'POST',
                body: { url: link, title: article.title || '' },
                timeoutMs: KB_INGEST_TIMEOUT_MS,
              })
            } else {
              const text = articlePlainText(article).slice(0, 200000)
              if (!text) {
                if (mountedRef.current && ingestSeqRef.current === seq) {
                  setKbIngest({ status: 'failed', stage: '', pages: 0, error: t('kb.ingest.empty') })
                }
                return
              }
              data = await kbFetchJson('/ingest-text', {
                method: 'POST',
                body: { title: article.title || '', text: text, url: link },
                timeoutMs: KB_INGEST_TIMEOUT_MS,
              })
            }
            if (!mountedRef.current || ingestSeqRef.current !== seq) return
            ingestSourceRef.current = data && data.source && data.source.id || ''
            const jobId = kbIngestJobId(data)
            if (!jobId) {
              // 后端命中已收录素材时不重新编译；直接保持已收录状态。
              rememberArticleKbSource(article, ingestSourceRef.current)
              setKbIngest({ status: data && data.existed ? 'exists' : 'done', stage: '', pages: 0, error: '' })
              if (kbEnabled) void fetchKbRelated(article)
              scheduleIngestRestore(seq)
              return
            }
            await pollIngestJob(jobId, seq)
          } catch (error) {
            if (!mountedRef.current || ingestSeqRef.current !== seq) return
            setKbIngest({ status: 'failed', stage: '', pages: 0, error: errorMessage(error, t('kb.ingest.failed')) })
          } finally {
            if (ingestRequestRef.current === seq) ingestRequestRef.current = 0
          }
        }

        async function startPassageIngest() {
          if (!selection || !article || !kbPassageSupported || passageIngestRef.current) return
          if (passageIngestMatchesSelection() && (passageIngest.status === 'done' || passageIngest.status === 'exists')) return
          const text = selection.text
          const target = { text: text, translated: showTranslation }
          if (text.length > KB_PASSAGE_MAX) {
            setPassageIngest(Object.assign({}, target, { status: 'failed', message: t('kb.passage.tooLong') }))
            return
          }
          const operation = new AbortController()
          passageIngestRef.current = operation
          const isCurrent = function () { return mountedRef.current && passageIngestRef.current === operation }
          const setResult = function (status, message, path) {
            setPassageIngest(Object.assign({}, target, { status: status, message: message, path: path || '' }))
          }
          setResult('running', t('kb.passage.running'))
          try {
            const data = await kbFetchJson('/ingest-passage', {
              method: 'POST',
              body: Object.assign({}, target, { title: article.title || '', url: kbArticleLink(article) }),
              timeoutMs: KB_INGEST_TIMEOUT_MS,
              signal: operation.signal,
            })
            if (!isCurrent()) return
            if (!kbReady) setKbStatus('ready')
            const jobId = kbIngestJobId(data)
            if (!jobId) {
              if (!data.existed || !data.source || data.source.status !== 'ready') throw new Error(t('kb.passage.failed'))
              const path = typeof data.source.pagePath === 'string' ? data.source.pagePath : ''
              setResult('exists', t('kb.passage.exists'), path)
              return
            }
            const job = await pollKbIngestJob(jobId, isCurrent, null, operation.signal)
            if (!job || !isCurrent()) return
            if (job.status === 'timeout') {
              setResult('failed', t('kb.passage.timeout'))
            } else if (job.status === 'failed') {
              setResult('failed', typeof job.error === 'string' && job.error || t('kb.passage.failed'))
            } else {
              const pages = job.result && Array.isArray(job.result.pages) ? job.result.pages : []
              const analysis = pages.find(function (page) { return page && page.type === 'source' && typeof page.path === 'string' })
              setResult('done', t('kb.passage.done'), analysis && analysis.path)
            }
          } catch (error) {
            if (isCurrent()) setResult('failed', errorMessage(error, t('kb.passage.failed')))
          } finally {
            if (passageIngestRef.current === operation) passageIngestRef.current = null
          }
        }

        /**
         * 打开文章：POST /article，成功后渲染 blocks；失败保留输入并在左栏顶部显示错误条。
         * @returns {Promise<void>}
         */
        function invalidateArticleFetch() {
          articleFetchSeqRef.current += 1
          if (articleFetchAbortRef.current) {
            try { articleFetchAbortRef.current.abort() } catch (error) { /* ignore */ }
            articleFetchAbortRef.current = null
          }
        }

        async function openProvidedContent(request) {
          if (editorBlocksNavigation()) return
          const content = normalizeProvidedContent(request && request.content, request && request.url)
          if (!content) return
          const previous = providedContentRef.current
          if (article && article.contentSource === content.kind && previous && previous.url === request.url
            && previous.kind === content.kind && previous.contentUrl === content.contentUrl
            && previous.html === content.html && previous.feedUrl === content.feedUrl && previous.publishedAt === content.publishedAt) {
            invalidateArticleFetch()
            setLoadingArticle(false)
            return
          }
          return fetchArticle(request.url, {
            url: request.url, title: typeof request.title === 'string' ? request.title.slice(0, 500) : '',
            html: content.html, publishedAt: content.publishedAt, feedUrl: content.feedUrl,
            accountName: content.accountName, contentSource: content.kind,
            ...(content.kind === 'publisher' ? { contentUrl: content.contentUrl } : {}),
          }, content)
        }

        async function openArticle(rawOverride, options) {
          const external = Boolean(options && options.external)
          if (!external && editorBlocksNavigation()) return
          const raw = typeof rawOverride === 'string' && rawOverride.trim() ? rawOverride.trim() : urlInput.trim()
          if (!raw) {
            setLeftError(t('url.empty'))
            return
          }
          let target = raw
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) target = 'https://' + raw
          if (external && article) {
            // A handoff of the article already being read reveals its current
            // state; it must not refetch over local edits, dialogue or translation.
            const urlKey = function (value) {
              try {
                const url = new URL(value)
                if (!/^https?:$/.test(url.protocol)) return ''
                url.hash = ''
                return url.href
              } catch (error) { return '' }
            }
            const key = urlKey(target)
            if (key && (key === urlKey(article.url) || key === urlKey(article.sourceUrl))) {
              invalidateArticleFetch()
              setLoadingArticle(false)
              if (savedView) closeSavedView()
              if (kbPreview) {
                previewSeqRef.current += 1
                closeKbPreview()
              }
              if (excerptsView) closeExcerptsView()
              setMode('url')
              setUrlInput(article.url || article.sourceUrl || target)
              setLeftError('')
              return
            }
          }
          if (external && editorBlocksNavigation()) return
          // A newer external target supersedes the pending fetch; manual clicks
          // retain the existing loading guard. fetchArticle owns abort/sequence.
          if (loadingArticle && !external) return
          return fetchArticle(target)
        }

        async function fetchArticle(target, provided, content) {
          invalidateArticleFetch()
          const seq = articleFetchSeqRef.current
          const controller = new AbortController()
          articleFetchAbortRef.current = controller
          // A newer article request also invalidates a local-file response.
          uploadSeqRef.current += 1
          librarySeqRef.current += 1
          setFileBusy(null)
          setLoadingArticle(true)
          setLeftError('')
          try {
            const response = await fetch(ORIGIN + (provided ? '/article-content' : '/article'), {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(provided || { url: target }),
              signal: controller.signal,
            })
            let data = null
            try {
              data = await response.json()
            } catch (error) {
              data = null
            }
            if (!mountedRef.current || articleFetchSeqRef.current !== seq) return
            if (!response.ok || !data || data.ok !== true) {
              const detail = data && data.error && typeof data.error.message === 'string' && data.error.message ? data.error.message : t('error.openFailed') + ' · HTTP ' + response.status
              throw new Error(detail)
            }
            const nextArticle = normalizeArticle(data.article)
            if (!nextArticle || nextArticle.blocks.length === 0) throw new Error(t('error.openFailed'))
            uploadSeqRef.current += 1
            setFileBusy(null)
            cancelActiveRequest()
            resetKbArticleState()
            setThread([])
            if (savedView) {
              librarySeqRef.current += 1
              setSavedView(null)
            }
            pendingArticleScrollRef.current = 0
            setArticle(nextArticle)
            providedContentRef.current = content ? Object.assign({ url: target }, content) : null
            setUrlInput(nextArticle.url || nextArticle.sourceUrl || target)
            setMode('url')
            setSelection(null)
            // 自动保存（CONTRACT §13.3.5）：开启后新打开的文章自动落盘，失败只提示不阻塞阅读
            void maybeAutoSave(nextArticle)
          } catch (error) {
            if (!mountedRef.current || articleFetchSeqRef.current !== seq) return
            setLeftError(errorMessage(error, t('error.openFailed')))
          } finally {
            if (mountedRef.current && articleFetchSeqRef.current === seq) {
              articleFetchAbortRef.current = null
              setLoadingArticle(false)
            }
          }
        }

        /**
         * 粘贴正文模式：解析 Markdown，构造本地 article（不走 Host）。
         * @returns {void}
         */
        function loadPastedText() {
          if (editorBlocksNavigation()) return
          const raw = pasteText.trim()
          if (!raw) {
            setLeftError(t('paste.empty'))
            return
          }
          const parsed = pastedMarkdownArticle(raw, pasteTitle.trim(), legacyPasteParagraphs(raw))
          if (parsed.blocks.length === 0) {
            setLeftError(t('paste.empty'))
            return
          }
          const localArticle = normalizeArticle({
            ...parsed,
            title: parsed.title || t('paste.untitled'),
            site: t('paste.site'),
            url: '',
            text: raw,
          })
          invalidateArticleFetch()
          setLoadingArticle(false)
          providedContentRef.current = null
          uploadSeqRef.current += 1
          setFileBusy(null)
          cancelActiveRequest()
          resetKbArticleState()
          setThread([])
          if (savedView) {
            librarySeqRef.current += 1
            setSavedView(null)
          }
          pendingArticleScrollRef.current = 0
          setArticle(localArticle)
          setMode('url')
          setLeftError('')
          setSelection(null)
          void maybeAutoSave(localArticle)
        }

        // ---- 事件处理：保存到本地 / 本地文稿（CONTRACT §13.3） ------------------

        /**
         * 显示保存结果条（成功 8s 自动消失；失败保留到重试 / 切换文章）。
         * @param {{ kind: 'done'|'error', dirLabel?: string, id?: string, message?: string, changed?: boolean, images?: number } | null} notice 结果条。
         * @returns {void}
         */
        function showSaveNotice(notice) {
          if (saveNoticeTimerRef.current) {
            window.clearTimeout(saveNoticeTimerRef.current)
            saveNoticeTimerRef.current = 0
          }
          setSaveNotice(notice)
          if (notice && notice.kind === 'done') {
            saveNoticeTimerRef.current = window.setTimeout(function () {
              saveNoticeTimerRef.current = 0
              if (mountedRef.current) setSaveNotice(null)
            }, SAVE_NOTICE_MS)
          }
        }

        /**
         * 把 Host /save 的返回规整成保存状态字段。
         * @param {any} saved 响应里的 saved 对象。
         * @returns {{ id: string, dir: string, dirLabel: string, bytes: number, images: number }}
         */
        function readSavedInfo(saved) {
          const source = saved && typeof saved === 'object' ? saved : {}
          const images = source.images && typeof source.images === 'object' ? Number(source.images.inlined) : 0
          return {
            id: typeof source.id === 'string' ? source.id : '',
            dir: typeof source.dir === 'string' ? source.dir : '',
            dirLabel: typeof source.dirLabel === 'string' ? source.dirLabel : '',
            bytes: Number.isFinite(Number(source.bytes)) ? Math.max(0, Number(source.bytes)) : 0,
            images: Number.isFinite(images) ? Math.max(0, images) : 0,
          }
        }

        /**
         * 刷新工具条「本地文稿」角标数量；失败静默（保存功能不可用时不打扰阅读）。
         * @returns {Promise<void>}
         */
        async function refreshSavedCount() {
          try {
            const data = await readerFetchJson('/saved', { timeoutMs: LIBRARY_HTTP_TIMEOUT_MS })
            if (!mountedRef.current) return
            const items = data && Array.isArray(data.items) ? data.items : []
            setSavedCount(items.length)
          } catch (error) {
            // 忽略：角标不是关键路径
          }
        }

        /**
         * 保存当前文章到本地（POST /save）。手动保存与自动保存共用；
         * 切换文章 / 重复点击时旧请求结果自动失效（saveSeqRef）。
         * @param {any} [target] 要保存的文章（缺省用当前 article；自动保存需显式传入，避免 setState 尚未生效）。
         * @param {{ auto?: boolean }} [options] 选项。
         * @returns {Promise<void>}
         */
        async function saveArticle(target, options) {
          const source = target && typeof target === 'object' ? target : article
          if (!source) return
          const auto = !!(options && options.auto)
          const blocks = Array.isArray(source.blocks) ? source.blocks : []
          if (blocks.length === 0) {
            if (!auto) {
              const message = t('save.empty')
              const key = articleIdentityKey(source)
              setSaveStatus({ status: 'failed', key: key, id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: false, error: message })
              showSaveNotice({ kind: 'error', message: message, id: '' })
            }
            return
          }
          const key = articleIdentityKey(source)
          const previous = options && options.previous || saveStatusRef.current
          const reusePrevious = previous && (previous.key === key || options && options.editSourceKey === previous.key)
          if (auto && previous && previous.status === 'done' && previous.key === key) return
          const seq = saveSeqRef.current + 1
          saveSeqRef.current = seq
          setSaveStatus({ status: 'saving', key: key, id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: auto, sourceRef: '' })
          // 手动保存/更新会把当前 AI 对话一起写成 note.md；自动保存（打开文章时）不发送 conversation，
          // 避免把已有笔记清空（Host：undefined = 不动已有对话，[] = 显式清空，契约 §16.2）。
          // 只有线程里确实有对话时才发送 conversation：线程为空（例如重新打开同一篇文章后还没对话）
          // 不发送 []，Host 会保留已有笔记，避免「普通保存」静默清空上次保存的 AI 对话（P1）。
          const conversation = auto ? null : buildConversationSnapshot(thread)
          const previousRef = options && typeof options.sourceRef === 'string' ? options.sourceRef : reusePrevious && typeof previous.sourceRef === 'string' ? previous.sourceRef : ''
          const saveBody = { article: source, sourceRef: previousRef || articleSourceRef(source) }
          if (reusePrevious && previous.id) saveBody.id = previous.id
          if (conversation && conversation.length > 0) saveBody.conversation = conversation
          try {
            const data = await readerFetchJson('/save', {
              method: 'POST',
              body: saveBody,
              timeoutMs: SAVE_HTTP_TIMEOUT_MS,
            })
            if (!mountedRef.current || saveSeqRef.current !== seq) return
            const saved = data && data.saved && typeof data.saved === 'object' ? data.saved : {}
            const info = readSavedInfo(saved)
            const nextStatus = {
              status: 'done',
              key: key,
              id: info.id,
              dir: info.dir,
              dirLabel: info.dirLabel,
              bytes: info.bytes,
              images: info.images,
              auto: auto,
              sourceRef: typeof saved.sourceRef === 'string' ? saved.sourceRef : '',
            }
            saveStatusRef.current = nextStatus
            setSaveStatus(nextStatus)
            const changed = saved.unchanged !== true
            showSaveNotice({
              kind: 'done',
              changed: changed,
              dirLabel: info.dirLabel,
              id: info.id,
              images: info.images,
              notes: Number(saved.conversationTurns) || 0,
            })
            void refreshSavedCount()
            if (savedView) void loadSavedList()
            return { status: nextStatus }
          } catch (error) {
            if (!mountedRef.current || saveSeqRef.current !== seq) return
            const message = saveErrorMessage(error, t, maxSaveBytes)
            // 失败重试仍复用已记录的 sourceRef，避免「重开+归一化标题+失败后重试」时新建目录（P2-11）
            const failedStatus = { status: 'failed', key: key, id: reusePrevious && previous.id || '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: auto, error: message, sourceRef: previousRef }
            saveStatusRef.current = failedStatus
            setSaveStatus(failedStatus)
            showSaveNotice({ kind: 'error', message: message, id: '' })
          }
        }

        /**
         * 文章打开成功后的自动保存入口（URL / 粘贴 / 本地文件三条路径共用）。
         * @param {any} nextArticle 刚打开的文章。
         * @returns {void}
         */
        function maybeAutoSave(nextArticle) {
          if (!autoSave || !nextArticle) return
          void saveArticle(nextArticle, { auto: true })
        }

        /**
         * 切换「自动保存」偏好并持久化；开启时若有文章且尚未保存，立即保存一次。
         * @returns {void}
         */
        function toggleAutoSave() {
          const saved = saveStoredPrefs(Object.assign({}, cache.prefs, { autoSave: !autoSave }))
          setAutoSave(saved.autoSave)
          if (saved.autoSave) {
            const current = saveStatusRef.current
            const alreadyDone = current && current.status === 'done' && current.key === articleKey
            const inFlight = current && current.status === 'saving'
            if (article && !alreadyDone && !inFlight) {
              void saveArticle(article, { auto: true })
            }
          } else if (saveNotice && saveNotice.kind === 'error') {
            showSaveNotice(null)
          }
        }

        /**
         * 拉取本地文稿列表（GET /saved），结果写入 savedView。
         * @returns {Promise<void>}
         */
        async function loadSavedList() {
          const seq = librarySeqRef.current + 1
          librarySeqRef.current = seq
          setSavedView(function (previous) {
            const base = previous && typeof previous === 'object' ? previous : { items: [], dir: '', dirLabel: '', confirmId: '', deletingId: '' }
            return Object.assign({}, base, { loading: true, error: '' })
          })
          try {
            const data = await readerFetchJson('/saved', { timeoutMs: LIBRARY_HTTP_TIMEOUT_MS })
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            const items = data && Array.isArray(data.items) ? data.items : []
            setSavedView({
              items: items,
              dir: data && typeof data.dir === 'string' ? data.dir : '',
              dirLabel: data && typeof data.dirLabel === 'string' ? data.dirLabel : '',
              loading: false,
              error: '',
              confirmId: '',
              deletingId: '',
            })
            setSavedCount(items.length)
          } catch (error) {
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            setSavedView(function (previous) {
              const base = previous && typeof previous === 'object' ? previous : { items: [], dir: '', dirLabel: '', confirmId: '', deletingId: '' }
              return Object.assign({}, base, { loading: false, error: errorMessage(error, t('library.error')) })
            })
          }
        }

        /**
         * 打开 / 关闭本地文稿视图（工具条按钮 toggle）。
         * @returns {void}
         */
        function openSavedView() {
          if (editorBlocksNavigation()) return
          if (savedView) {
            closeSavedView()
            return
          }
          setLeftError('')
          setSelection(null)
          if (excerptsView) closeExcerptsView()
          // 记住当前文章阅读位置：关闭本地文稿视图 / 打开文稿失败时恢复（CONTRACT §13.3.3）。
          // KB 预览打开时 readerRef 指向的是预览滚动容器，不能拿来当文章位置（P2-10）。
          if (!kbPreview && !excerptsView) articleScrollRef.current = readerRef.current ? readerRef.current.scrollTop : 0
          setSavedView({ items: [], dir: '', dirLabel: '', loading: true, error: '', confirmId: '', deletingId: '' })
          void loadSavedList()
        }

        /**
         * 关闭本地文稿视图，回到文章视图。
         * @returns {void}
         */
        function closeSavedView() {
          librarySeqRef.current += 1
          if (libraryConfirmTimerRef.current) {
            window.clearTimeout(libraryConfirmTimerRef.current)
            libraryConfirmTimerRef.current = 0
          }
          if (article) pendingArticleScrollRef.current = articleScrollRef.current
          libraryRestoreFocusRef.current = true
          setSavedView(null)
        }

        /**
         * 返回首页（CONTRACT §17）：清空当前文章 / 对话 / 本地文稿视图 / KB 预览，
         * 回到可拖入文件、打开新链接或粘贴正文的空状态。进行中的分析会中止；
         * 已保存到本地的文稿不受影响（可再用「本地文稿」打开）。
         * @returns {void}
         */
        function goHome() {
          if (editorBlocksNavigation()) return
          invalidateArticleFetch()
          providedContentRef.current = null
          excerptViewSeqRef.current += 1
          setExcerptsView(null)
          cancelActiveRequest()
          resetKbArticleState()
          uploadSeqRef.current += 1
          if (librarySeqRef.current) librarySeqRef.current += 1
          setFileBusy(null)
          setLoadingArticle(false)
          setSavedView(null)
          setThread([])
          setUndoThread(null)
          setArticle(null)
          setMode('url')
          setUrlInput('')
          setPasteTitle('')
          setPasteText('')
          setSelection(null)
          setSelectionQuestion('')
          setLeftError('')
          setFileNotice('')
          setComposer('')
          setSaveStatus({ status: 'idle', key: '', id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: false, sourceRef: '' })
          setSaveNotice(null)
          // 清掉「面板切走再切回」的模块级现场，确保回到真正的首页
          // 左侧译文也一并清空（CONTRACT §19.1）
          translationSeqRef.current += 1
          if (translationAbortRef.current) {
            try {
              translationAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
            translationAbortRef.current = null
          }
          setTranslation({ status: 'idle', key: '', content: '', error: '' })
          setShowTranslation(false)
          cache.translation = null
          cache.article = null
          cache.thread = []
          cache.readerScroll = null
          articleScrollRef.current = 0
          pendingArticleScrollRef.current = 0
        }

        /**
         * 打开一篇本地文稿：GET /saved?id= → 走既有「打开新文章」路径。
         * @param {any} item 列表项。
         * @returns {Promise<void>}
         */
        async function openSavedItem(item) {
          if (editorBlocksNavigation()) return
          if (!item || typeof item.id !== 'string' || !item.id) return
          invalidateArticleFetch()
          setLoadingArticle(false)
          providedContentRef.current = null
          const seq = librarySeqRef.current + 1
          librarySeqRef.current = seq
          try {
            const data = await readerFetchJson('/saved?id=' + encodeURIComponent(item.id), { timeoutMs: LIBRARY_HTTP_TIMEOUT_MS })
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            const nextArticle = normalizeArticle(data && data.article)
            if (!nextArticle || nextArticle.blocks.length === 0) throw new Error(t('library.openFailed'))
            uploadSeqRef.current += 1
            setFileBusy(null)
            cancelActiveRequest()
            resetKbArticleState()
            // 恢复保存时一并写入的 AI 对话（CONTRACT §16.3）；旧文稿没有对话 → 空线程
            setThread(restoreConversationMessages(data && data.conversation))
            setArticle(nextArticle)
            setUrlInput(nextArticle.url || nextArticle.sourceUrl || '')
            setMode('url')
            setSelection(null)
            setSavedView(null)
            const savedItem = data && data.item && typeof data.item === 'object' ? data.item : item
            const info = readSavedInfo({ id: savedItem.id, dirLabel: savedItem.dirLabel, bytes: savedItem.bytes, images: savedItem.images })
            setSaveStatus({
              status: 'done',
              key: articleIdentityKey(nextArticle),
              id: info.id || item.id,
              dir: '',
              dirLabel: info.dirLabel,
              bytes: info.bytes,
              images: info.images,
              auto: false,
              sourceRef: typeof savedItem.sourceRef === 'string' ? savedItem.sourceRef : '',
            })
            setLeftError('')
            pendingArticleScrollRef.current = 0
          } catch (error) {
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            setSavedView(function (previous) {
              const base = previous && typeof previous === 'object' ? previous : { items: [], dir: '', dirLabel: '', confirmId: '', deletingId: '' }
              return Object.assign({}, base, { error: errorMessage(error, t('library.openFailed')) })
            })
          }
        }

        /**
         * 删除二次确认第一步：标记 confirmId，4s 内未再点自动复原。
         * @param {any} item 列表项。
         * @returns {void}
         */
        function requestDeleteSaved(item) {
          if (!item || typeof item.id !== 'string' || !item.id) return
          if (libraryConfirmTimerRef.current) {
            window.clearTimeout(libraryConfirmTimerRef.current)
            libraryConfirmTimerRef.current = 0
          }
          setSavedView(function (previous) {
            return previous && typeof previous === 'object' ? Object.assign({}, previous, { confirmId: item.id }) : previous
          })
          libraryConfirmTimerRef.current = window.setTimeout(function () {
            libraryConfirmTimerRef.current = 0
            if (!mountedRef.current) return
            setSavedView(function (previous) {
              return previous && typeof previous === 'object' ? Object.assign({}, previous, { confirmId: '' }) : previous
            })
          }, LIBRARY_CONFIRM_MS)
        }

        /**
         * 删除一篇本地文稿（DELETE /saved?id=），成功后从列表移除并同步数量/保存状态。
         * @param {any} item 列表项。
         * @returns {Promise<void>}
         */
        async function deleteSavedItem(item) {
          if (!item || typeof item.id !== 'string' || !item.id) return
          if (libraryConfirmTimerRef.current) {
            window.clearTimeout(libraryConfirmTimerRef.current)
            libraryConfirmTimerRef.current = 0
          }
          const seq = librarySeqRef.current + 1
          librarySeqRef.current = seq
          setSavedView(function (previous) {
            return previous && typeof previous === 'object' ? Object.assign({}, previous, { confirmId: '', deletingId: item.id, error: '' }) : previous
          })
          try {
            await readerFetchJson('/saved?id=' + encodeURIComponent(item.id), {
              method: 'DELETE',
              timeoutMs: LIBRARY_HTTP_TIMEOUT_MS,
            })
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            setSavedView(function (previous) {
              if (!previous || typeof previous !== 'object') return previous
              return Object.assign({}, previous, {
                items: (Array.isArray(previous.items) ? previous.items : []).filter(function (entry) {
                  return entry && entry.id !== item.id
                }),
                deletingId: '',
              })
            })
            setSavedCount(function (previous) {
              return Math.max(0, Number(previous) - 1)
            })
            showFileNotice(t('library.deleted'))
            const current = saveStatusRef.current
            if (current && current.id === item.id) {
              setSaveStatus({ status: 'idle', key: articleKey, id: '', dir: '', dirLabel: '', bytes: 0, images: 0, auto: false })
              showSaveNotice(null)
            }
          } catch (error) {
            if (!mountedRef.current || librarySeqRef.current !== seq) return
            setSavedView(function (previous) {
              return previous && typeof previous === 'object'
                ? Object.assign({}, previous, { deletingId: '', error: errorMessage(error, t('library.deleteFailed')) })
                : previous
            })
          }
        }

        /**
         * 在系统文件管理器中打开保存目录（POST /reveal）；失败显示在左栏错误条。
         * @param {string} [id] 文稿 id（缺省 = 保存根目录）。
         * @returns {Promise<void>}
         */
        async function revealSavedDir(id) {
          try {
            await readerFetchJson('/reveal', {
              method: 'POST',
              body: id ? { id: id } : {},
              timeoutMs: LIBRARY_HTTP_TIMEOUT_MS,
            })
          } catch (error) {
            setLeftError(errorMessage(error, t('save.revealFailed')))
          }
        }

        // ---- 事件处理：本地文件拖拽 / 选择上传 --------------------------------

        /**
         * 显示一条 3s 后自动消失的轻提示（例如多文件只取第一个）。
         * @param {string} message 提示文案。
         * @returns {void}
         */
        function showFileNotice(message) {
          if (!message) return
          setFileNotice(message)
          if (fileNoticeTimerRef.current) window.clearTimeout(fileNoticeTimerRef.current)
          fileNoticeTimerRef.current = window.setTimeout(function () {
            fileNoticeTimerRef.current = 0
            if (mountedRef.current) setFileNotice('')
          }, 3000)
        }

        /**
         * 判断一次 drag 事件是否携带文件（dataTransfer.types 含 'Files'）。
         * @param {any} event React drag 事件。
         * @returns {boolean}
         */
        function hasFileDrag(event) {
          try {
            const dataTransfer = event && event.dataTransfer
            if (!dataTransfer || !dataTransfer.types) return false
            const types = dataTransfer.types
            for (let index = 0; index < types.length; index += 1) {
              if (types[index] === 'Files') return true
            }
            return false
          } catch (error) {
            return false
          }
        }

        /**
         * 拖入：显示遮罩（计数器避免子元素 dragleave 抖动）。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleRootDragEnter(event) {
          if (!hasFileDrag(event)) return
          event.preventDefault()
          dragDepthRef.current += 1
          if (!fileBusy && mountedRef.current) setDragActive(true)
        }

        /**
         * 拖过：持续 preventDefault 并设置 copy 光标（否则浏览器会打开文件）。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleRootDragOver(event) {
          if (!hasFileDrag(event)) return
          event.preventDefault()
          try {
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
          } catch (error) {
            // ignore
          }
          if (!fileBusy && mountedRef.current) setDragActive(true)
        }

        /**
         * 拖离：计数归零时关闭遮罩。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleRootDragLeave(event) {
          if (!hasFileDrag(event)) return
          event.preventDefault()
          const panel = event.currentTarget
          const related = event.relatedTarget
          // 指针仍在面板内部（进入子元素）：只递减计数器，不关闭遮罩
          if (panel && related && typeof panel.contains === 'function' && panel.contains(related)) {
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            return
          }
          // 真正离开面板：强制归零关闭，避免计数器在复杂子元素间漂移导致遮罩残留
          dragDepthRef.current = 0
          if (mountedRef.current) setDragActive(false)
        }

        /**
         * 放下：关闭遮罩，多文件只取第一个并提示。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleRootDrop(event) {
          event.preventDefault()
          dragDepthRef.current = 0
          setDragActive(false)
          let files = null
          try {
            files = event && event.dataTransfer ? event.dataTransfer.files : null
          } catch (error) {
            files = null
          }
          if (!files || files.length === 0) return
          if (files.length > 1) showFileNotice(t('file.multiple'))
          void uploadLocalFile(files[0])
        }

        /**
         * 「打开文件」按钮：触发隐藏的 file input。
         * @returns {void}
         */
        function openFilePicker() {
          if (editorBlocksNavigation()) return
          const input = fileInputRef.current
          if (!input || typeof input.click !== 'function') return
          try {
            input.click()
          } catch (error) {
            // ignore
          }
        }

        /**
         * file input change：与拖拽走同一条上传路径。
         * @param {any} event React change 事件。
         * @returns {void}
         */
        function handleFileInputChange(event) {
          const target = event && event.target ? event.target : null
          const files = target && target.files ? target.files : null
          if (files && files.length > 0) {
            if (files.length > 1) showFileNotice(t('file.multiple'))
            void uploadLocalFile(files[0])
          }
          try {
            if (target) target.value = ''
          } catch (error) {
            // ignore
          }
        }

        /**
         * 上传并解析一个本地文件：大小预检 → arrayBuffer→base64 → POST /file →
         * 成功后用返回 article 走与「打开 URL」一致的替换路径（中止流式、清线程、清选区、刷新 KB）。
         * @param {any} file 浏览器 File 对象（或兼容的 {name,type,size,arrayBuffer}）。
         * @returns {Promise<void>}
         */
        async function uploadLocalFile(file) {
          if (editorBlocksNavigation()) return
          if (!file || fileBusy) return
          const limitsNow =
            fileLimits && typeof fileLimits.maxUploadBytes === 'number' && fileLimits.maxUploadBytes > 0
              ? fileLimits
              : { maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES, extensions: FALLBACK_FILE_EXTENSIONS }
          const name = typeof file.name === 'string' ? file.name : ''
          if (!name) {
            setLeftError(t('file.invalid'))
            return
          }
          const size = typeof file.size === 'number' && file.size >= 0 ? file.size : 0
          if (size > limitsNow.maxUploadBytes) {
            setDragActive(false)
            setLeftError(t('file.tooLarge', { n: formatFileSize(limitsNow.maxUploadBytes, t) }))
            return
          }
          const seq = uploadSeqRef.current + 1
          invalidateArticleFetch()
          setLoadingArticle(false)
          providedContentRef.current = null
          uploadSeqRef.current = seq
          setDragActive(false)
          setLeftError('')
          setFileBusy({ name: name })
          try {
            const dataBase64 = await readFileAsBase64(file)
            if (!mountedRef.current || uploadSeqRef.current !== seq) return
            const response = await fetch(ORIGIN + '/file', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ name: name, mime: typeof file.type === 'string' ? file.type : '', dataBase64: dataBase64 }),
            })
            let data = null
            try {
              data = await response.json()
            } catch (error) {
              data = null
            }
            if (!mountedRef.current || uploadSeqRef.current !== seq) return
            if (!response.ok || !data || data.ok !== true) {
              const failure = new Error(
                data && data.error && typeof data.error.message === 'string' && data.error.message ? data.error.message : 'HTTP ' + response.status,
              )
              failure.fileCode = data && data.error && typeof data.error.code === 'string' ? data.error.code : ''
              failure.httpStatus = response.status
              throw failure
            }
            const nextArticle = normalizeArticle(data.article)
            if (!nextArticle || nextArticle.blocks.length === 0) {
              const failure = new Error('EMPTY_FILE')
              failure.fileCode = 'EXTRACT_FAILED'
              throw failure
            }
            // 与「打开 URL」一致：中止流式请求、重置 KB 文章态、清空线程 / 选区，替换文章
            cancelActiveRequest()
            resetKbArticleState()
            setThread([])
            if (savedView) {
              librarySeqRef.current += 1
              setSavedView(null)
            }
            pendingArticleScrollRef.current = 0
            setArticle(nextArticle)
            setUrlInput('')
            setMode('url')
            setSelection(null)
            setLeftError('')
            void maybeAutoSave(nextArticle)
          } catch (error) {
            if (!mountedRef.current || uploadSeqRef.current !== seq) return
            setLeftError(fileErrorMessage(error, t, limitsNow.maxUploadBytes))
          } finally {
            if (mountedRef.current && uploadSeqRef.current === seq) setFileBusy(null)
          }
        }

        // ---- 事件处理：选区 / 说明 -------------------------------------------

        function excerptNoteData(raw) {
          const note = raw && typeof raw === 'object' ? raw : {}
          return {
            fileName: typeof note.fileName === 'string' ? note.fileName : '摘抄笔记.md',
            path: typeof note.path === 'string' ? note.path : '',
            text: typeof note.text === 'string' ? note.text : '',
            tags: Array.isArray(note.tags) ? note.tags.filter(function (tag) { return typeof tag === 'string' && tag.trim() }) : [],
            count: typeof note.count === 'number' ? note.count : 0,
            entries: Array.isArray(note.entries) ? note.entries.filter(function (entry) { return entry && typeof entry.text === 'string' }).map(function (entry) {
              const source = entry.article && typeof entry.article === 'object' ? entry.article : {}
              return { id: typeof entry.id === 'string' ? entry.id : '', text: entry.text,
                tags: Array.isArray(entry.tags) ? entry.tags.filter(function (tag) { return typeof tag === 'string' }) : [],
                createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
                article: { title: typeof source.title === 'string' ? source.title : '', url: typeof source.url === 'string' ? source.url : '', site: typeof source.site === 'string' ? source.site : '' } }
            }) : [],
          }
        }

        async function loadExcerptOptions() {
          setExcerptOptions(function (previous) { return Object.assign({}, previous, { loading: true, error: '' }) })
          try {
            const data = await readerFetchJson('/excerpts')
            if (!mountedRef.current) return
            const note = excerptNoteData(data.note)
            setExcerptOptions({ loading: false, tags: note.tags, error: '' })
          } catch (error) {
            if (mountedRef.current) setExcerptOptions(function (previous) { return Object.assign({}, previous, { loading: false, error: errorMessage(error, t('excerpt.loadFailed')) }) })
          }
        }

        function openExcerptEditor() {
          if (!selection) return
          setExcerptDraft(function (previous) { return Object.assign({}, previous, { open: true }) })
          void loadExcerptOptions()
        }

        function changeExcerptTags(tags) {
          if (excerptSaveRef.current && excerptSaveRef.current.busy) return
          setExcerptDraft(function (previous) { return Object.assign({}, previous, { tags: tags, status: 'idle', error: '', requestId: '' }) })
        }

        function toggleExcerptTag(tag) {
          if (excerptDraft.status === 'done') return
          if (excerptDraft.tags.includes(tag)) changeExcerptTags(excerptDraft.tags.filter(function (value) { return value !== tag }))
          else if (excerptDraft.tags.length < 8) changeExcerptTags(excerptDraft.tags.concat(tag))
        }

        function addExcerptTag() {
          if (excerptSaveRef.current && excerptSaveRef.current.busy) return
          const tag = excerptDraft.newTag.trim().replace(/^#+/, '').trim()
          if (!tag) return
          if (tag.length > 32 || /[\r\n\t]/.test(tag)) {
            setExcerptDraft(function (previous) { return Object.assign({}, previous, { error: t('excerpt.tagInvalid') }) })
            return
          }
          if (!excerptDraft.tags.includes(tag) && excerptDraft.tags.length >= 8) return
          setExcerptDraft(function (previous) {
            return Object.assign({}, previous, { tags: previous.tags.includes(tag) ? previous.tags : previous.tags.concat(tag), newTag: '', status: 'idle', error: '', requestId: '' })
          })
        }

        async function saveExcerpt() {
          if (!selection || !article || excerptDraft.status === 'done' || (excerptSaveRef.current && excerptSaveRef.current.busy)) return
          if (!excerptDraft.tags.length || excerptDraft.newTag.trim()) {
            setExcerptDraft(function (previous) { return Object.assign({}, previous, { error: t('excerpt.chooseTags') }) })
            return
          }
          if (selection.text.length > 20000) {
            setExcerptDraft(function (previous) { return Object.assign({}, previous, { error: t('excerpt.tooLong') }) })
            return
          }
          const requestId = excerptDraft.requestId || (window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : 'excerpt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2))
          const previous = excerptSaveRef.current
          const payload = previous && previous.requestId === requestId ? previous.payload : {
            text: selection.text, tags: excerptDraft.tags.slice(), requestId: requestId,
            article: { title: article.title || '', url: article.sourceUrl || article.url || '', site: article.site || '' },
          }
          const seq = excerptDraftSeqRef.current
          const operation = { requestId: requestId, payload: payload, busy: true, seq: seq }
          excerptSaveRef.current = operation
          setExcerptDraft(function (current) { return Object.assign({}, current, { status: 'saving', error: '', requestId: requestId }) })
          try {
            const data = await readerFetchJson('/excerpts', { method: 'POST', body: payload })
            if (!mountedRef.current || excerptDraftSeqRef.current !== seq || excerptSaveRef.current !== operation) return
            const note = excerptNoteData(data.note)
            operation.busy = false
            setExcerptOptions({ loading: false, tags: note.tags, error: '' })
            setExcerptDraft(function (current) { return Object.assign({}, current, { status: 'done', error: '', fileName: note.fileName, path: note.path }) })
          } catch (error) {
            if (!mountedRef.current || excerptDraftSeqRef.current !== seq || excerptSaveRef.current !== operation) return
            operation.busy = false
            setExcerptDraft(function (current) { return Object.assign({}, current, { status: 'error', error: errorMessage(error, t('excerpt.saveFailed')) }) })
          }
        }

        async function loadExcerptsView() {
          const seq = ++excerptViewSeqRef.current
          setExcerptsView(function (previous) { return Object.assign({}, previous || { note: null, tag: '' }, { loading: true, error: '', confirmId: '', notice: '' }) })
          try {
            const data = await readerFetchJson('/excerpts')
            if (!mountedRef.current || excerptViewSeqRef.current !== seq) return
            const note = excerptNoteData(data.note)
            setExcerptOptions({ loading: false, tags: note.tags, error: '' })
            setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, {
              loading: false, error: '', deletingId: '', note: note, tag: note.tags.includes(previous.tag) ? previous.tag : '',
            }) : null })
          } catch (error) {
            if (!mountedRef.current || excerptViewSeqRef.current !== seq) return
            setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, { loading: false, error: errorMessage(error, t('excerpt.loadFailed')) }) : null })
          }
        }

        async function deleteExcerpt(entry) {
          if (!entry.id || excerptDeleteRef.current || !excerptsViewRef.current || excerptsViewRef.current.loading) return
          const operation = { id: entry.id }
          excerptDeleteRef.current = operation
          const seq = ++excerptViewSeqRef.current
          setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, {
            deletingId: entry.id, confirmId: '', error: '', notice: '',
          }) : null })
          try {
            const data = await readerFetchJson('/excerpts', { method: 'DELETE', body: { id: entry.id } })
            if (!mountedRef.current || excerptViewSeqRef.current !== seq) return
            const note = excerptNoteData(data.note)
            setExcerptOptions({ loading: false, tags: note.tags, error: '' })
            setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, {
              deletingId: '', error: '', note: note, notice: t('excerpt.deleted'),
              tag: note.tags.includes(previous.tag) ? previous.tag : '',
            }) : null })
            if (excerptNoteBackRef.current) excerptNoteBackRef.current.focus({ preventScroll: true })
          } catch (error) {
            if (!mountedRef.current || excerptViewSeqRef.current !== seq) return
            setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, {
              deletingId: '', confirmId: entry.id, error: errorMessage(error, t('excerpt.deleteFailed')),
            }) : null })
          } finally {
            if (excerptDeleteRef.current === operation) excerptDeleteRef.current = null
          }
        }

        function openExcerptsView() {
          if (editorBlocksNavigation()) return
          if (excerptsView) { closeExcerptsView(); return }
          if (!savedView && !kbPreview) articleScrollRef.current = readerRef.current ? readerRef.current.scrollTop : 0
          setSelection(null)
          setSavedView(null)
          setKbPreview(null)
          setMode('url')
          setExcerptsView({ note: null, tag: '', loading: true, error: '' })
          void loadExcerptsView()
        }

        function closeExcerptsView() {
          excerptViewSeqRef.current += 1
          pendingArticleScrollRef.current = articleScrollRef.current
          setExcerptsView(null)
          const trigger = excerptNoteTriggerRef.current
          if (trigger && typeof trigger.focus === 'function') trigger.focus()
        }

        /**
         * 重新计算文章容器内的选区与浮动按钮位置。
         * @returns {void}
         */
        function updateSelection() {
          if (articleEditorRef.current) { setSelection(null); return }
          // 正在提问框里打字：root keyup 会触发本函数，此时 DOM 选区已折叠，不能把提问框关掉
          const bar = selectionButtonRef.current
          const active = typeof document !== 'undefined' ? document.activeElement : null
          if (bar && active && bar.contains(active)) return
          const found = readSelection(readerRef.current)
          if (!found) {
            setSelection(null)
            return
          }
          const placement = floatingPlacement(
            found.rect,
            readerRef.current ? readerRef.current.getBoundingClientRect() : null,
            SELECTION_ASK_WIDTH,
            SELECTION_ASK_HEIGHT,
          )
          setSelection({ text: found.text, range: found.range, top: placement.top, left: placement.left })
        }

        /**
         * 关闭选区提问框：隐藏卡片、清空输入并折叠 DOM 选区。
         * @returns {void}
         */
        function closeSelectionBar() {
          setSelection(null)
          setSelectionQuestion('')
          try {
            const current = window.getSelection()
            if (current) current.removeAllRanges()
          } catch (error) {
            // ignore
          }
        }

        /**
         * 鼠标抬起后延迟一帧再取选区（双击选词、拖拽结束都能拿到最终结果）。
         * @returns {void}
         */
        function scheduleSelectionUpdate() {
          if (selectionTimerRef.current) window.clearTimeout(selectionTimerRef.current)
          selectionTimerRef.current = window.setTimeout(function () {
            selectionTimerRef.current = 0
            updateSelection()
          }, 0)
        }

        /**
         * 提交选区提问：构造「引用 + 用户问题」的 user 消息并立即发起分析；
         * 问题为空时退回原来的「解读这段」固定提示（CONTRACT §3.3）。
         * @param {string} selectedText 选中的原文。
         * @param {string} [question] 用户输入的问题（可空）。
         * @returns {void}
         */
        function explainSelection(selectedText, question) {
          if (!selectedText || !article || busy) return
          const asked = typeof question === 'string' ? question.trim() : ''
          setSelection(null)
          setSelectionQuestion('')
          try {
            const current = window.getSelection()
            if (current) current.removeAllRanges()
          } catch (error) {
            // ignore
          }
          // 选段过长时截断，避免单条消息超过 Host 的 20000 字符上限
          let passage = String(selectedText)
          if (passage.length > 4000) passage = passage.slice(0, 4000) + '\n…'
          const quote = quoteLines(passage)
          const content = asked
            ? t('prompt.selectionPrefix') + '\n\n' + quote + '\n\n' + t('prompt.selectionQuestion') + asked
            : t('prompt.selectionPrefix') + '\n\n' + quote + '\n\n' + t('prompt.selectionRequirements')
          // 有选区时用选区文字作为知识库检索词（CONTRACT §11.3）
          // 联网检索词：用户问题 + 选段前段（空问题直接用选段，CONTRACT §14.3）
          const webQuery = String((asked ? asked + ' ' : '') + passage).trim().slice(0, MAX_WEB_QUERY_CLIENT)
          // 笔记元数据（CONTRACT §16.2）：note.md 里用「选段 + 问题」排版，而不是整段 prompt
          sendUserMessage(content, String(selectedText).slice(0, KB_QUERY_MAX), webQuery, {
            kind: 'selection',
            quote: String(selectedText).slice(0, 4000),
            question: asked.slice(0, 2000),
          })
        }

        /**
         * 一键翻译选中的内容（CONTRACT §19）：构造「翻译指令 + 选段引用」的 user 消息并立即发起分析；
         * 笔记元数据与选区提问一致（quote + question），保存时 note.md 里显示为「问：翻译」。
         * @param {string} selectedText 选中的原文。
         * @returns {void}
         */
        function translateSelection(selectedText) {
          if (!selectedText || !article || busy) return
          setSelection(null)
          setSelectionQuestion('')
          try {
            const current = window.getSelection()
            if (current) current.removeAllRanges()
          } catch (error) {
            // ignore
          }
          let passage = String(selectedText)
          if (passage.length > 4000) passage = passage.slice(0, 4000) + '\n…'
          const content = t('prompt.translatePrefix') + '\n\n' + quoteLines(passage) + '\n\n' + t('prompt.translateRequirements')
          // 翻译不需要联网；知识库检索也跳过（避免无关参考干扰译文）
          sendUserMessage(content, '', '', {
            kind: 'selection',
            quote: String(selectedText).slice(0, 4000),
            question: t('selection.translate'),
          })
        }

        /**
         * 根节点键盘事件：Cmd/Ctrl+J 等价点击「解读这段」。
         * @param {any} event React 键盘事件。
         * @returns {void}
         */
        function handleRootKeyDown(event) {
          const key = String(event.key || '').toLowerCase()
          if (key === 'j' && (event.metaKey || event.ctrlKey) && !event.altKey) {
            event.preventDefault()
            // 没有已注册的选区时先刷新一次（例如键盘/拖拽刚结束），随后由 effect 聚焦输入框
            if (!selectionRef.current) updateSelection()
            const focusInput = function () {
              const input = selectionInputRef.current
              if (input && typeof input.focus === 'function') input.focus()
            }
            focusInput()
            window.setTimeout(focusInput, 0)
          }
        }

        /**
         * 根节点 keyup：键盘选区变化后刷新浮动按钮。
         * @returns {void}
         */
        function handleRootKeyUp() {
          scheduleSelectionUpdate()
        }

        // ---- 事件处理：右栏 / 流式 -------------------------------------------

        /**
         * 中止当前进行中的请求，并使旧的流式回调失效。
         * @returns {void}
         */
        function cancelActiveRequest() {
          requestSeqRef.current += 1
          if (abortRef.current) {
            try {
              abortRef.current.abort()
            } catch (error) {
              // ignore
            }
            abortRef.current = null
          }
          setBusy(false)
        }

        /**
         * 把一条 user 消息追加到线程并立即开始流式分析。
         * @param {string} content user 消息文本。
         * @param {string} [knowledgeQuery] 本次解读的知识库检索词（默认文章标题）。
         * @returns {void}
         */
        function sendUserMessage(content, knowledgeQuery, webQuery, meta) {
          if (editorBlocksNavigation()) return
          let text = String(content == null ? '' : content).trim()
          if (!text || !article || busy) return
          // 新消息出现后，「清空」的撤销窗口关闭（不再允许把旧线程恢复回来）
          if (undoTimerRef.current) {
            window.clearTimeout(undoTimerRef.current)
            undoTimerRef.current = 0
          }
          setUndoThread(null)
          // 契约 2.4：单条消息 content 上限 20000 字符（正常输入远小于此值）
          if (text.length > 20000) text = text.slice(0, 20000)
          // 联网检索词随消息保存：retry 时复用同一次提问的检索意图（CONTRACT §14.3）
          const webText =
            typeof webQuery === 'string' ? webQuery.trim().slice(0, MAX_WEB_QUERY_CLIENT) : ''
          const message = { id: nextId('user'), role: 'user', content: text, webQuery: webText }
          if (meta && typeof meta === 'object') {
            // 笔记元数据（CONTRACT §16.2）：kind/quote/question 只用于本地 note.md 的排版
            if (typeof meta.kind === 'string' && meta.kind) message.kind = meta.kind
            if (typeof meta.quote === 'string' && meta.quote) message.quote = meta.quote
            if (typeof meta.question === 'string' && meta.question) message.question = meta.question
            // 显示层短文案（CONTRACT §19.1）：快捷问题把长提示词发给模型，但气泡里显示按钮名
            if (typeof meta.display === 'string' && meta.display) message.display = meta.display.slice(0, 200)
          }
          startAnalysis(thread.concat([message]), { knowledgeQuery: knowledgeQuery, webQuery: webText })
        }

        /**
         * 共享收尾：按 seq 校验后更新 assistant 消息终态（避免旧请求覆盖新请求）。
         * @param {{ seq: number, assistantId: string }} request 请求上下文。
         * @param {'done'|'stopped'|'error'} status 终态。
         * @param {string} error 错误文案（仅 error 态）。
         * @returns {void}
         */
        function finishAssistant(request, status, error) {
          if (!mountedRef.current || requestSeqRef.current !== request.seq) return
          const assistantId = request.assistantId
          setThread(function (previous) {
            return previous.map(function (item) {
              if (!item || item.id !== assistantId) return item
              return Object.assign({}, item, { status: status, error: error || '' })
            })
          })
        }

        /**
         * 发起一次分析：写入 assistant 占位消息 →（可选）检索知识库 → POST /analyze 解析 SSE。
         * @param {any[]} baseMessages 不含占位 assistant 的完整对话历史（最后一条必须是 user）。
         * @param {{ knowledgeQuery?: string }} [options] 选项（知识库检索词）。
         * @returns {void}
         */
        function startAnalysis(baseMessages, options) {
          if (!article) return
          setCompactPane('answer')
          const analyzeArticle = toAnalyzeArticle(article)
          if (!analyzeArticle) {
            setThread(
              baseMessages.concat([
                { id: nextId('assistant'), role: 'assistant', content: '', status: 'error', error: t('error.emptyArticle'), knowledge: [] },
              ]),
            )
            return
          }
          // 一次只允许一个进行中的请求：中止旧的
          if (abortRef.current) {
            try {
              abortRef.current.abort()
            } catch (error) {
              // ignore
            }
            abortRef.current = null
          }
          requestSeqRef.current += 1
          const seq = requestSeqRef.current
          const controller = new AbortController()
          abortRef.current = controller
          const assistantId = nextId('assistant')
          const assistant = { id: assistantId, role: 'assistant', content: '', status: 'streaming', error: '', knowledge: [] }
          setThread(baseMessages.concat([assistant]))
          setBusy(true)
          setKbPhase('')
          const messages = []
          for (let index = 0; index < baseMessages.length; index += 1) {
            const item = baseMessages[index]
            if (!item || !item.role) continue
            // 契约 3.4：失败 / 占位消息不进入请求
            if (item.status === 'error' || item.status === 'streaming') continue
            const text = String(item.content == null ? '' : item.content)
            if (!text) continue
            // 契约 2.4：单条 content 上限 20000 字符
            messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: text.length > 20000 ? text.slice(0, 20000) : text })
          }
          // 契约 2.4：messages 最多 40 条（保留最近的轮次）
          while (messages.length > 40) messages.shift()
          const requestedQuery = options && typeof options.knowledgeQuery === 'string' ? options.knowledgeQuery : ''
          const knowledgeQuery = requestedQuery.trim().slice(0, KB_QUERY_MAX)
          const useKnowledge = !!(knowledgeQuery && kbEnabled && kbStatus === 'ready')
          // 联网检索（CONTRACT §14）：只有用户真的提问/选中内容时才检索；快捷问题不触发
          const requestedWeb = options && typeof options.webQuery === 'string' ? options.webQuery : ''
          const webQuery = requestedWeb.trim().slice(0, MAX_WEB_QUERY_CLIENT)
          const useWeb = !!(webQuery && webEnabled && webAvailable)
          setWebPhase('')
          void runKnowledgeThenAnalysis({
            seq: seq,
            controller: controller,
            assistantId: assistantId,
            article: analyzeArticle,
            messages: messages,
            knowledgeQuery: useKnowledge ? knowledgeQuery : '',
            webQuery: useWeb ? webQuery : '',
          })
        }

        /**
         * 分析前置步骤：kbEnabled 时 search → page 取参考知识库（失败静默空数组），
         * 然后进入 SSE 流式请求；检索期间右栏显示「检索知识库…」。
         * @param {{ seq: number, controller: AbortController, assistantId: string, article: any, messages: any[], knowledgeQuery: string, webQuery: string }} request 请求上下文。
         * @returns {Promise<void>}
         */
        async function runKnowledgeThenAnalysis(request) {
          let knowledge = []
          if (request.knowledgeQuery) {
            if (mountedRef.current && requestSeqRef.current === request.seq) setKbPhase('searching')
            let guardTimer = 0
            // 单次知识库检索总时长上限：即使 search/page 多点挂起，也不阻塞回答
            const guard = new Promise(function (resolve) {
              guardTimer = setTimeout(function () {
                resolve([])
              }, KB_HTTP_TIMEOUT_MS + 500)
            })
            try {
              knowledge = await Promise.race([kbFetchKnowledge(request.knowledgeQuery, request.controller.signal), guard])
            } catch (error) {
              knowledge = []
            } finally {
              clearTimeout(guardTimer)
            }
            if (mountedRef.current) setKbPhase(knowledge.length > 0 ? '' : 'miss')
            if (!mountedRef.current || requestSeqRef.current !== request.seq) return
            if (request.controller.signal.aborted) {
              finishAssistant(request, 'stopped', '')
              if (abortRef.current === request.controller) abortRef.current = null
              if (mountedRef.current) setBusy(false)
              return
            }
            if (knowledge.length > 0) {
              setThread(function (previous) {
                return previous.map(function (item) {
                  if (!item || item.id !== request.assistantId) return item
                  return Object.assign({}, item, { knowledge: knowledge })
                })
              })
            }
          }
          await runAnalysis(Object.assign({}, request, { knowledge: knowledge }))
        }

        /**
         * 执行 /analyze 流式请求并增量更新 assistant 消息。
         * 状态写入统一用 seq 校验，避免旧请求覆盖新请求或卸载后仍 setState。
         * @param {{ seq: number, controller: AbortController, assistantId: string, article: any, messages: any[], knowledge?: any[] }} request 请求上下文。
         * @returns {Promise<void>}
         */
        async function runAnalysis(request) {
          const controller = request.controller
          const assistantId = request.assistantId
          // 联网检索阶段文案：Host 会在 SSE 里先发 web(searching)，这里先本地占位避免空白等待
          if (request.webQuery && mountedRef.current) setWebPhase('searching')
          /** @returns {boolean} 本次请求是否仍是最新且组件仍挂载。 */
          const alive = function () {
            return mountedRef.current && requestSeqRef.current === request.seq
          }
          /**
           * 收尾：更新 assistant 消息的终态。
           * @param {'done'|'stopped'|'error'} status 终态。
           * @param {string} error 错误文案（仅 error 态）。
           * @returns {void}
           */
          const finish = function (status, error) {
            finishAssistant(request, status, error)
          }
          try {
            const knowledge = Array.isArray(request.knowledge) && request.knowledge.length > 0 ? request.knowledge : undefined
            const response = await fetch(ORIGIN + '/analyze', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify({
                article: request.article,
                messages: request.messages,
                knowledge: knowledge,
                // 联网检索（CONTRACT §14.2）：只有本轮确实要检索时才带 web 字段
                web: request.webQuery ? { query: request.webQuery } : undefined,
              }),
              signal: controller.signal,
            })
            if (!response.ok) {
              const detail = await readErrorText(response, t('error.analyzeFailed') + ' · HTTP ' + response.status)
              throw new Error(detail)
            }

            let content = ''
            let sawDone = false
            let streamError = ''
            /**
             * 处理单条 SSE 负载：meta / delta / done / error（thinking 忽略）。
             * @param {any} event Host 发来的事件对象。
             * @returns {void}
             */
            const onEvent = function (event) {
              const type = event.type
              if (type === 'meta') {
                const label = typeof event.label === 'string' && event.label ? event.label : [event.provider, event.model].filter(Boolean).join(' / ')
                if (label && alive()) {
                  setModelLabel(label)
                  setMetaState('ready')
                }
                return
              }
              if (type === 'web') {
                if (!alive()) return
                const status = typeof event.status === 'string' ? event.status : ''
                if (status === 'searching') {
                  setWebPhase('searching')
                  return
                }
                if (status === 'ok') {
                  setWebPhase('')
                  const sources = normalizeWebSources(event.sources)
                  setThread(function (previous) {
                    return previous.map(function (item) {
                      if (!item || item.id !== assistantId) return item
                      return Object.assign({}, item, { web: { status: 'ok', sources: sources } })
                    })
                  })
                  return
                }
                if (status === 'miss' || status === 'error') {
                  setWebPhase(status === 'error' ? 'error' : 'miss')
                  const detail = typeof event.message === 'string' ? event.message : ''
                  const code = typeof event.code === 'string' ? event.code : ''
                  setThread(function (previous) {
                    return previous.map(function (item) {
                      if (!item || item.id !== assistantId) return item
                      return Object.assign({}, item, { web: { status: status, sources: [], error: detail, code: code } })
                    })
                  })
                  return
                }
                return
              }
              if (type === 'delta') {
                if (typeof event.text !== 'string' || !event.text) return
                setWebPhase('')
                content += event.text
                if (!alive()) return
                setThread(function (previous) {
                  return previous.map(function (item) {
                    if (!item || item.id !== assistantId) return item
                    return Object.assign({}, item, { content: content })
                  })
                })
                return
              }
              if (type === 'done') {
                sawDone = true
                return
              }
              if (type === 'error') {
                streamError = typeof event.message === 'string' && event.message ? event.message : t('error.llm')
              }
            }

            const parser = createSseParser(onEvent)
            if (response.body && typeof response.body.getReader === 'function') {
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                if (chunk.value) parser.push(decoder.decode(chunk.value, { stream: true }))
              }
              const tail = decoder.decode()
              if (tail) parser.push(tail)
            } else {
              // 极少数环境没有流式 body：退化为整段解析
              parser.push(await response.text())
            }
            parser.flush()

            if (controller.signal.aborted) {
              finish('stopped', '')
              return
            }
            if (streamError) {
              finish('error', streamError)
              return
            }
            if (!sawDone) {
              finish('error', t('error.streamInterrupted'))
              return
            }
            if (!content.trim()) {
              finish('error', t('error.emptyAnswer'))
              return
            }
            finish('done', '')
          } catch (error) {
            if (controller.signal.aborted) {
              finish('stopped', '')
              return
            }
            finish('error', errorMessage(error, t('error.requestFailed')))
          } finally {
            if (abortRef.current === controller) abortRef.current = null
            if (alive()) {
              setBusy(false)
              setWebPhase('')
            }
          }
        }

        /**
         * 停止按钮：abort 当前请求；已生成内容保留，消息会标记为已停止。
         * @returns {void}
         */
        function stopAnalysis() {
          if (!abortRef.current) return
          try {
            abortRef.current.abort()
          } catch (error) {
            // ignore
          }
        }

        // ---- 左侧文章翻译（CONTRACT §19.1）：/translate SSE → 左栏译文视图 ----------

        /**
         * 取消进行中的整篇翻译（保留已生成的部分并停留在译文视图）。
         * @returns {void}
         */
        function cancelTranslation() {
          if (!translationAbortRef.current) return
          try {
            translationAbortRef.current.abort()
          } catch (error) {
            // ignore
          }
        }

        /**
         * 开始（或重新开始）整篇文章翻译：调用 Host 的 POST /translate SSE，把译文累加到左栏翻译状态。
         * 译文左侧阅读区展示，原文可通过「查看原文」切回；已有译文时由按钮切换视图，不重复请求。
         * @returns {Promise<void>}
         */
        async function startTranslate() {
          if (editorBlocksNavigation()) return
          if (!article || typeof article.text !== 'string' || !article.text.trim()) return
          const key = articleKey || articleIdentityKey(article)
          const seq = translationSeqRef.current + 1
          translationSeqRef.current = seq
          if (translationAbortRef.current) {
            try {
              translationAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = new AbortController()
          translationAbortRef.current = controller
          setShowTranslation(true)
          setTranslation({ status: 'loading', key: key, content: '', error: '' })
          const alive = function () {
            return mountedRef.current && translationSeqRef.current === seq
          }
          try {
            const response = await fetch(ORIGIN + '/translate', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify({
                article: { title: article.title || '', site: article.site || '', url: article.sourceUrl || article.url || '', text: article.text },
                target: 'zh',
              }),
              signal: controller.signal,
            })
            if (!response.ok) {
              const detail = await readErrorText(response, t('translate.failed') + ' · HTTP ' + response.status)
              throw new Error(detail)
            }
            if (!alive()) return
            setTranslation(function (previous) {
              return previous.key === key ? Object.assign({}, previous, { status: 'streaming' }) : previous
            })
            let content = ''
            let sawDone = false
            let streamError = ''
            const onEvent = function (event) {
              if (!alive()) return
              const type = event && typeof event.type === 'string' ? event.type : ''
              if (type === 'progress') {
                setTranslation(function (previous) {
                  return previous.key === key
                    ? Object.assign({}, previous, { part: event.part, totalParts: event.totalParts })
                    : previous
                })
                return
              }
              if (type === 'delta') {
                if (typeof event.text !== 'string' || !event.text) return
                content += event.text
                setTranslation(function (previous) {
                  return previous.key === key
                    ? Object.assign({}, previous, { content: content, status: 'streaming', error: '' })
                    : previous
                })
                return
              }
              if (type === 'done') {
                sawDone = true
                return
              }
              if (type === 'error') {
                streamError = typeof event.message === 'string' && event.message ? event.message : t('translate.failed')
              }
            }
            const parser = createSseParser(onEvent)
            if (response.body && typeof response.body.getReader === 'function') {
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                if (chunk.value) parser.push(decoder.decode(chunk.value, { stream: true }))
              }
              const tail = decoder.decode()
              if (tail) parser.push(tail)
            } else {
              parser.push(await response.text())
            }
            parser.flush()
            if (!alive()) return
            if (controller.signal.aborted) {
              // 用户取消：保留已生成的部分，按钮可继续切换/重试
              setTranslation(function (previous) {
                return previous.key === key ? Object.assign({}, previous, { status: 'error', error: t('translate.cancelled') }) : previous
              })
              return
            }
            if (streamError) throw new Error(streamError)
            if (!sawDone) throw new Error(t('error.streamInterrupted'))
            if (!content.trim()) throw new Error(t('translate.empty'))
            setTranslation({ status: 'done', key: key, content: content, error: '' })
          } catch (error) {
            if (!alive()) return
            if (controller.signal.aborted) {
              setTranslation(function (previous) {
                return previous.key === key ? Object.assign({}, previous, { status: 'error', error: t('translate.cancelled') }) : previous
              })
              return
            }
            setTranslation(function (previous) {
              return previous.key === key ? Object.assign({}, previous, { status: 'error', error: errorMessage(error, t('translate.failed')) }) : previous
            })
          } finally {
            if (translationAbortRef.current === controller) translationAbortRef.current = null
          }
        }

        /**
         * 文章头「译成中文 / 查看原文」按钮：首次点击开始翻译；已有译文时在原文/译文之间切换。
         * @returns {void}
         */
        function toggleTranslationView() {
          if (!article) return
          const current = translation.key === articleKey ? translation.status : 'idle'
          if (current === 'loading' || current === 'streaming') {
            cancelTranslation()
            return
          }
          if (current === 'done') {
            setShowTranslation(function (previous) {
              return !previous
            })
            return
          }
          void startTranslate()
        }

        /**
         * 重试一条失败的 assistant 消息：用它之前的对话历史重发。
         * @param {string} messageId 失败消息 id。
         * @returns {void}
         */
        function retryMessage(messageId) {
          if (busy) return
          const index = thread.findIndex(function (item) {
            return item && item.id === messageId
          })
          if (index < 0) return
          const base = thread.slice(0, index)
          while (base.length > 0 && base[base.length - 1].role !== 'user') base.pop()
          if (base.length === 0) return
          const lastUser = base[base.length - 1]
          const retryWebQuery = lastUser && typeof lastUser.webQuery === 'string' ? lastUser.webQuery : ''
          startAnalysis(base, { knowledgeQuery: article ? article.title || '' : '', webQuery: retryWebQuery })
        }

        /**
         * 清空线程并中止进行中的请求：保留一份快照，6 秒内可撤销。
         * @returns {void}
         */
        function clearThread() {
          if (busy || thread.length > 0) cancelActiveRequest()
          if (thread.length > 0) {
            setUndoThread(
              thread.map(function (item) {
                return item && item.status === 'streaming' ? Object.assign({}, item, { status: 'stopped' }) : item
              }),
            )
            if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current)
            undoTimerRef.current = window.setTimeout(function () {
              undoTimerRef.current = 0
              if (mountedRef.current) setUndoThread(null)
            }, 6000)
          }
          setThread([])
          setSelection(null)
        }

        /**
         * 撤销上一次清空：仅当清空后没有新消息时恢复旧线程。
         * @returns {void}
         */
        function undoClear() {
          if (undoTimerRef.current) {
            window.clearTimeout(undoTimerRef.current)
            undoTimerRef.current = 0
          }
          const snapshot = undoThread
          setUndoThread(null)
          if (!Array.isArray(snapshot) || snapshot.length === 0) return
          setThread(function (previous) {
            return previous && previous.length > 0 ? previous : snapshot
          })
        }

        /**
         * 快捷按钮：用固定问法发起一轮分析。
         * @param {{ id: string, labelKey: string, promptKey: string }} action 快捷动作定义。
         * @returns {void}
         */
        function runQuickAction(action) {
          if (!article || busy) return
          // 翻译全文：不检索知识库、不联网（译文只需要原文）；其它快捷问题沿用文章标题做 KB 检索
          const knowledgeQuery = action.id === 'translate' ? '' : article.title || ''
          sendUserMessage(t(action.promptKey), knowledgeQuery, '', {
            kind: 'quick',
            question: t(action.labelKey),
            display: t(action.labelKey),
          })
        }

        /**
         * composer 发送当前内容。
         * @returns {void}
         */
        function sendComposer() {
          if (!canSend) return
          const text = composer.trim()
          setComposer('')
          sendUserMessage(text, article.title || '', text, { kind: 'chat', question: text })
        }

        /**
         * composer 键盘：Enter 发送（Shift+Enter 换行；输入法组词时忽略）。
         * @param {any} event React 键盘事件。
         * @returns {void}
         */
        function handleComposerKeyDown(event) {
          if (event.key !== 'Enter' || event.shiftKey) return
          if (event.isComposing || event.keyCode === 229 || (event.nativeEvent && event.nativeEvent.isComposing)) return
          // 生成中发送按钮已变为「停止」：此时 Enter 保留换行，不吞键
          if (busy) return
          event.preventDefault()
          sendComposer()
        }

        // ---- 事件处理：分隔条拖拽 --------------------------------------------

        /**
         * 分隔条拖拽开始：记录起点，window 级 pointermove 调整 split（32%–68%）。
         * @param {any} event React pointer 事件。
         * @returns {void}
         */
        function handleSplitterPointerDown(event) {
          if (typeof event.button === 'number' && event.button !== 0) return
          event.preventDefault()
          const body = bodyRef.current
          if (!body) return
          const rect = body.getBoundingClientRect()
          const width = rect.width || 1
          const startX = event.clientX
          const startSplit = split
          setDragging(true)
          /** @param {any} moveEvent pointermove 事件。 @returns {void} */
          const handleMove = function (moveEvent) {
            const delta = ((moveEvent.clientX - startX) / width) * 100
            const next = Math.min(68, Math.max(32, startSplit + delta))
            setSplit(Math.round(next * 10) / 10)
          }
          /** @returns {void} */
          const handleUp = function () {
            setDragging(false)
            window.removeEventListener('pointermove', handleMove)
            window.removeEventListener('pointerup', handleUp)
            window.removeEventListener('pointercancel', handleUp)
            if (dragCleanupRef.current === handleUp) dragCleanupRef.current = null
          }
          if (dragCleanupRef.current) dragCleanupRef.current()
          dragCleanupRef.current = handleUp
          window.addEventListener('pointermove', handleMove)
          window.addEventListener('pointerup', handleUp)
          window.addEventListener('pointercancel', handleUp)
        }

        /**
         * 分隔条双击：恢复参考图默认分栏比例（68%）。
         * @returns {void}
         */
        function resetSplit() {
          setSplit(DEFAULT_SPLIT)
        }

        /**
         * 分隔条键盘微调（左右方向键 ±2%）。
         * @param {any} event React 键盘事件。
         * @returns {void}
         */
        function handleSplitterKeyDown(event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const delta = event.key === 'ArrowLeft' ? -2 : 2
          setSplit(function (previous) {
            return Math.min(68, Math.max(32, previous + delta))
          })
        }

        // ---- 渲染辅助 --------------------------------------------------------

        /**
         * 左栏工具栏：URL 模式（输入 + 打开 + 粘贴正文）或粘贴模式（标题 + 载入 + 返回）。
         * @returns {any}
         */
        /** 阅读显示采用原生 disclosure，保留字号/版心入口并把空间留给链接输入。 */
        function renderAppearanceOptions() {
          return h(
            'details',
            {
              className: 'air-appearance',
              onKeyDown: function (event) {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.open = false
                const summary = event.currentTarget.querySelector('summary')
                if (summary) summary.focus()
              },
              onBlur: function (event) {
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
              },
            },
            h('summary', { className: 'air-btn air-btn-ghost air-appearance-trigger', title: t('reader.appearance'), 'aria-label': t('reader.appearance') }, t('reader.fontSize')),
            h('div', { className: 'air-appearance-panel' },
              h('span', { className: 'air-appearance-title' }, t('reader.appearance')),
            h(
              'div',
              { className: 'air-seg', role: 'group', 'aria-label': t('reader.fontSize') + ' / ' + t('reader.width') },
              h(
                'button',
                {
                  type: 'button',
                  className: 'air-seg-item air-seg-font',
                  title: t('reader.fontSize.title', { label: t(fontPref.labelKey) }),
                  'aria-label': t('reader.fontSize.title', { label: t(fontPref.labelKey) }),
                  'data-level': String(fontLevel),
                  onClick: cycleFontLevel,
                },
                h('span', { className: 'air-seg-glyph' }, t('reader.fontSize')),
                h('span', { className: 'air-seg-value' }, t(fontPref.labelKey)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'air-seg-item air-seg-width',
                  title: t('reader.width.title', { label: t(widthPref.labelKey) }),
                  'aria-label': t('reader.width.title', { label: t(widthPref.labelKey) }),
                  'data-level': String(widthLevel),
                  onClick: cycleWidthLevel,
                },
                h('span', { className: 'air-seg-glyph' }, t('reader.width')),
                h('span', { className: 'air-seg-value' }, t(widthPref.labelKey)),
              ),
            ),
            ),
          )
        }

        function renderToolbar() {
          // 「返回首页」（CONTRACT §17）：有文章/文稿列表/KB 预览/粘贴草稿时可回到空状态
          const canGoHome = !!(article || savedView || kbPreview || excerptsView || mode === 'paste')
          const homeButton = canGoHome
            ? h(
                'button',
                {
                  key: 'home',
                  type: 'button',
                  className: 'air-btn air-btn-sm air-btn-ghost air-home-btn',
                  title: t('reader.homeHint'),
                  'aria-label': t('reader.home'),
                  onClick: goHome,
                },
                h(HouseIcon, { size: 14 }),
                h('span', { className: 'air-home-label' }, t('reader.home')),
              )
            : null
          if (mode === 'paste') {
            return h(
              'div',
              { className: 'air-urlbar' },
              homeButton,
              h('input', {
                className: 'air-field',
                type: 'text',
                value: pasteTitle,
                placeholder: t('paste.titlePlaceholder'),
                'aria-label': t('paste.titlePlaceholder'),
                spellCheck: false,
                onChange: function (event) {
                  setPasteTitle(event.target.value)
                },
              }),
              h(
                'button',
                { type: 'button', className: 'air-btn air-btn-primary', onClick: loadPastedText },
                t('paste.load'),
              ),
              h(
                'button',
                { type: 'button', className: 'air-btn air-btn-ghost', onClick: toggleMode, title: t('mode.url') },
                t('mode.url'),
              ),
              h('button', { type: 'button', className: 'air-btn air-btn-ghost air-excerpts-open', ref: excerptNoteTriggerRef,
                'aria-label': t('excerpt.note'), 'aria-expanded': Boolean(excerptsView), onClick: openExcerptsView }, t('excerpt.note')),
            )
          }
          return h(
            'div',
            { className: 'air-urlbar' },
            h('div', { className: 'air-open-controls' },
            homeButton,
            h('input', {
              className: 'air-field',
              type: 'url',
              value: urlInput,
              placeholder: t('url.placeholder'),
              'aria-label': t('url.placeholder'),
              spellCheck: false,
              autoComplete: 'off',
              disabled: loadingArticle,
              onChange: function (event) {
                setUrlInput(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void openArticle()
                }
              },
            }),
            h(
              'button',
              { type: 'button', className: 'air-btn air-btn-primary', disabled: loadingArticle, onClick: function () { void openArticle() } },
              loadingArticle ? h(LoadingDots, { small: true }) : null,
              loadingArticle ? t('url.opening') : t('url.open'),
            ),
            ),
            h('div', { className: 'air-toolbar-actions' },
            // 本地文档：30px 圆形图标按钮 + 隐藏 file input（accept 来自 /meta.fileFormats）
            h(
              'button',
              {
                type: 'button',
                className: 'air-btn air-btn-ghost air-iconbtn air-file-btn',
                title: t('file.open'),
                'aria-label': t('file.open'),
                disabled: !!fileBusy || loadingArticle,
                onClick: openFilePicker,
              },
              h(FileIcon, { size: 15 }),
            ),
            h('input', {
              ref: fileInputRef,
              type: 'file',
              className: 'air-file-input',
              multiple: true,
              accept: fileLimits.extensions.join(','),
              tabIndex: -1,
              'aria-hidden': 'true',
              onChange: handleFileInputChange,
            }),
            // 本地文稿入口：30px 图标按钮 + 数量角标（CONTRACT §13.3.3）
            h(
              'button',
              {
                type: 'button',
                ref: libraryTriggerRef,
                className: 'air-btn air-btn-ghost air-iconbtn air-library-btn',
                title: savedView ? t('library.back') : t('library.openHint', { n: String(savedCount) }),
                'aria-label': savedView ? t('library.back') : t('library.openHint', { n: String(savedCount) }),
                'aria-expanded': savedView ? 'true' : 'false',
                onClick: openSavedView,
              },
              h(FolderIcon, { size: 15 }),
              savedCount > 0
                ? h('span', { className: 'air-lib-badge', 'aria-hidden': 'true' }, savedCount > 99 ? '99+' : String(savedCount))
                : null,
            ),
            renderAppearanceOptions(),
            h('button', { type: 'button', className: 'air-btn air-btn-ghost air-excerpts-open', ref: excerptNoteTriggerRef,
              'aria-label': t('excerpt.note'), 'aria-expanded': Boolean(excerptsView), onClick: openExcerptsView }, t('excerpt.note')),
            h(
              'button',
              { type: 'button', className: 'air-btn air-btn-ghost', disabled: loadingArticle, onClick: toggleMode, title: t('mode.paste') },
              t('mode.paste'),
            ),
            ),
          )
        }

        // ---- 渲染辅助：知识库联动 --------------------------------------------

        /**
         * 右栏「联网」开关 chip：联网服务不可用时置灰，title 说明当前状态（CONTRACT §14.4）。
         * @returns {any}
         */
        function renderWebChip() {
          const available = webAvailable
          const on = available && webEnabled
          const title = available ? (webEnabled ? t('web.chip.on') : t('web.chip.off')) : t('web.unavailable')
          return h(
            'button',
            {
              type: 'button',
              className: 'air-chip air-web-chip',
              'data-on': on ? 'true' : 'false',
              'aria-pressed': on ? 'true' : 'false',
              disabled: !available,
              title: title,
              'aria-label': title,
              onClick: toggleWebEnabled,
            },
            h('span', { className: 'air-web-chip-dot', 'aria-hidden': 'true' }),
            h(GlobeIcon, { size: 12 }),
            t('web.chip.label'),
          )
        }

        /**
         * 右栏「知识库」开关 chip：KB 不可用时置灰，title 说明当前状态。
         * @returns {any}
         */
        function renderKbChip() {
          const available = kbStatus === 'ready'
          const on = available && kbEnabled
          const title = available ? (kbEnabled ? t('kb.chip.on') : t('kb.chip.off')) : t('kb.unavailable')
          return h(
            'button',
            {
              type: 'button',
              className: 'air-chip air-kb-chip' + (on ? ' air-kb-chip-on' : ''),
              'data-on': on ? 'true' : 'false',
              'aria-pressed': on ? 'true' : 'false',
              disabled: !available,
              title: title,
              'aria-label': title,
              onClick: toggleKbEnabled,
            },
            h('span', { className: 'air-kb-chip-dot', 'aria-hidden': 'true' }),
            h(KbIcon, { size: 12 }),
            t('kb.chip.label'),
          )
        }

        /**
         * 文章关联知识默认收起；展开显示有类型及摘要的列表，无结果时隐藏。
         * @returns {any}
         */
        function renderKbRelatedBar() {
          if (!kbEnabled || kbStatus !== 'ready' || !article) return null
          const items = Array.isArray(kbRelated) ? kbRelated : []
          if (items.length === 0) return null
          return h(KbRelated, {
            key: articleKey, t: t, items: items, loading: kbRelatedLoading,
            onRefresh: function () { void fetchKbRelated(article) },
            onOpenPanel: function () { if (openKbPanel) openKbPanel() },
            onOpenPage: openKbPage,
          })
        }

        /**
         * 文章头「存入知识库」按钮（含 running / done / exists / failed 文案状态）。
         * 只返回按钮本身；与自动保存/保存按钮一起由 renderArticleActions 包进 actions 行。
         * @returns {any}
         */
        function renderKbIngestAction() {
          if (!article) return null
          const available = kbStatus === 'ready'
          const status = kbIngest.status
          let label = t('kb.ingest.action')
          let disabled = !available
          let modifier = ''
          const title = available ? t('kb.ingest.hint') : t('kb.unavailable')
          if (status === 'checking') {
            label = t('kb.ingest.checking')
            disabled = true
            modifier = ' air-kb-ingest-busy'
          } else if (status === 'running') {
            label = kbIngest.stage
              ? t('kb.ingest.running', { stage: String(kbIngest.stage).slice(0, 24) })
              : t('kb.ingest.runningShort')
            disabled = true
            modifier = ' air-kb-ingest-busy'
          } else if (status === 'exists') {
            label = t('kb.ingest.exists')
            disabled = true
            modifier = ' air-kb-ingest-exists'
          } else if (status === 'done') {
            label = t('kb.ingest.done', { n: String(kbIngest.pages || 0) })
            disabled = true
            modifier = ' air-kb-ingest-done'
          } else if (status === 'failed' || status === 'timeout') {
            label = t('kb.ingest.retry')
          }
          return h(
            'button',
            {
              type: 'button',
              className: 'air-btn air-btn-sm air-btn-ghost air-kb-ingest' + modifier,
              disabled: disabled,
              title: title,
              'aria-label': label,
              onClick: function () {
                void startIngest()
              },
            },
            status === 'running'
              ? h(LoadingDots, { small: true })
              : status === 'done'
                ? h(CheckIcon, { size: 13 })
                : h(KbIcon, { size: 13 }),
            label,
          )
        }

        /**
         * 存入失败 / 超时的红条（可重试）。
         * @returns {any}
         */
        function renderKbIngestError() {
          const status = kbIngest.status
          if (status !== 'failed' && status !== 'timeout') return null
          return h(
            'div',
            { className: 'air-kb-error', role: 'alert' },
            h('span', { className: 'air-kb-error-text' }, kbIngest.error || t('kb.ingest.failed')),
            h(
              'button',
              {
                type: 'button',
                className: 'air-linkbtn',
                onClick: function () {
                  void startIngest()
                },
              },
              t('kb.ingest.retry'),
            ),
          )
        }

        function passageIngestMatchesSelection() {
          return !!(passageIngest && selection && selection.text === passageIngest.text && showTranslation === passageIngest.translated)
        }

        function renderPassageIngestStatus(inline) {
          if (!passageIngest) return null
          const inCard = passageIngestMatchesSelection() && !busy && !excerptDraft.open
          if (inline !== inCard) return null
          const failed = passageIngest.status === 'failed'
          const running = passageIngest.status === 'running'
          const path = passageIngest.path
          return h('div', {
            className: inline ? 'air-sel-kb-status' + (failed ? ' air-sel-kb-error' : '') : failed ? 'air-errorbar' : 'air-notice',
            role: failed ? 'alert' : 'status',
            'aria-live': failed ? 'assertive' : 'polite',
            'data-passage-status': passageIngest.status,
          },
          running ? h(LoadingDots, { small: true }) : null,
          h('span', { className: 'air-errorbar-text' }, passageIngest.message),
          path ? h('button', { type: 'button', className: 'air-linkbtn', onClick: function () { openKbPage(path) } }, t('kb.passage.view')) : null,
          !inline && !running ? h('button', {
            type: 'button', className: 'air-iconbtn air-errorbar-close', title: t('error.dismiss'), 'aria-label': t('error.dismiss'),
            onClick: function () { setPassageIngest(null) },
          }, h(XIcon, { size: 13 })) : null)
        }

        function renderPassageIngestAction() {
          const status = passageIngest && passageIngest.status
          const failed = status === 'failed' && passageIngestMatchesSelection()
          const complete = (status === 'done' || status === 'exists') && passageIngestMatchesSelection()
          const title = t(kbPassageSupported ? 'kb.passage.hint' : kbReady ? 'kb.passage.unsupported' : 'kb.unavailable')
          return h('button', {
            type: 'button', className: 'air-btn air-btn-sm air-btn-ghost air-sel-ask-kb',
            title: title,
            disabled: !kbPassageSupported,
            onClick: function () { void startPassageIngest() },
            'aria-disabled': status === 'running' || complete ? 'true' : undefined,
          }, failed ? t('kb.ingest.retry') : t('kb.passage.action'))
        }

        /**
         * 文章头「自动保存」开关 chip（偏好持久化；开启后新打开的文章自动保存到本地）。
         * @returns {any}
         */
        function renderAutoSaveChip() {
          const title = autoSave ? t('save.autoOn') : t('save.autoOff')
          return h(
            'button',
            {
              type: 'button',
              className: 'air-chip air-save-toggle',
              'data-on': autoSave ? 'true' : 'false',
              'aria-pressed': autoSave ? 'true' : 'false',
              title: title,
              'aria-label': title,
              onClick: toggleAutoSave,
            },
            h('span', { className: 'air-save-toggle-dot', 'aria-hidden': 'true' }),
            t('save.autoSave'),
          )
        }

        /**
         * 文章头「保存到本地」按钮：idle / saving / done / failed 四态（CONTRACT §13.3.1）。
         * @returns {any}
         */
        function renderSaveAction() {
          if (!article) return null
          const status = saveStatus && typeof saveStatus.status === 'string' ? saveStatus.status : 'idle'
          let label = t('save.action')
          let disabled = false
          let modifier = ''
          let title = t('save.hint')
          if (status === 'saving') {
            label = t('save.saving')
            disabled = true
            modifier = ' air-save-busy'
          } else if (status === 'done') {
            // 已保存后仍可点击：文章/对话有更新时把改动写回同一份本地文稿与 note.md（契约 §16.3）
            label = t('save.update')
            modifier = ' air-save-done'
            title = saveStatus.dirLabel ? `${t('save.updateHint')} · ${saveStatus.dirLabel}` : t('save.updateHint')
          } else if (status === 'failed') {
            label = t('save.retry')
            modifier = ' air-save-failed'
            title = saveStatus.error || t('save.failed')
          }
          return h(
            'button',
            {
              type: 'button',
              className: 'air-btn air-btn-sm air-btn-ghost air-save-btn' + modifier,
              disabled: disabled,
              title: title,
              'aria-label': label,
              onClick: function () {
                void saveArticle(article, {})
              },
            },
            status === 'saving'
              ? h(LoadingDots, { small: true })
              : status === 'done'
                ? h(CheckIcon, { size: 13 })
                : h(DownloadIcon, { size: 13 }),
            label,
          )
        }

        /**
         * 文章头 actions 行：自动保存开关 + 保存到本地 + 存入知识库（顺序固定，允许换行）。
         * @returns {any}
         */
        /**
         * 文章头「译成中文 / 查看原文」按钮（CONTRACT §19.1）：译文显示在左栏阅读区。
         * @returns {any}
         */
        function renderTranslateAction() {
          if (!article) return null
          const status = translation.key === articleKey ? translation.status : 'idle'
          let label = t('translate.action')
          let modifier = ''
          let title = t('translate.hint')
          let icon = h(GlobeIcon, { size: 13 })
          if (status === 'loading' || status === 'streaming') {
            label = t('translate.loading')
            modifier = ' air-translate-busy'
            title = t('translate.cancel')
            icon = h(LoadingDots, { small: true })
          } else if (status === 'done') {
            label = showTranslation ? t('translate.viewOriginal') : t('translate.viewTranslation')
            modifier = ' air-translate-done'
            title = showTranslation ? t('translate.title') : t('translate.viewTranslation')
          } else if (status === 'error') {
            label = t('translate.retry')
            modifier = ' air-translate-failed'
            title = translation.error || t('translate.failed')
          }
          return h(
            'button',
            {
              type: 'button',
              className: 'air-btn air-btn-sm air-btn-ghost air-translate-btn' + modifier,
              title: title,
              'aria-label': label,
              'aria-pressed': status === 'done' ? (showTranslation ? 'true' : 'false') : undefined,
              onClick: toggleTranslationView,
            },
            icon,
            label,
          )
        }

        function editorBlocksNavigation() {
          if (!articleEditorRef.current) return false
          setArticleEditor(function (draft) { return draft ? Object.assign({}, draft, { error: t('edit.finishFirst') }) : draft })
          return true
        }

        function beginArticleEdit() {
          if (!article || busy || loadingArticle || fileBusy || saveStatus.status === 'saving' || kbIngest.status === 'running' || translation.status === 'loading' || translation.status === 'streaming') return
          closeSelectionBar()
          setShowTranslation(false)
          articleEditFocusRef.current = true
          setArticleEditor(createArticleEditor(article, saveStatusRef.current))
          showSaveNotice(null)
        }

        function cancelArticleEdit() {
          const draft = articleEditorRef.current
          if (!draft || draft.status === 'saving') return
          saveStatusRef.current = draft.savedState
          setSaveStatus(draft.savedState)
          showSaveNotice(null)
          articleEditRestoreFocusRef.current = true
          setArticleEditor(null)
          cache.articleEditor = null
          if (articleEditTriggerRef.current && articleEditTriggerRef.current.focus) articleEditTriggerRef.current.focus()
        }

        function updateEditorText(index, value, row, column) {
          const group = 'text:' + index + ':' + (row == null ? '' : row + ':' + column) + ':' + articleEditorGroupRef.current
          setArticleEditor(function (draft) {
            if (!draft || !draft.blocks[index] || draft.status === 'saving') return draft
            const block = draft.blocks[index]
            const next = Object.assign({}, block)
            if (row != null) {
              next.rows = block.rows.map(function (cells, r) { return r === row ? cells.map(function (cell, c) { return c === column ? value : cell }) : cells })
            } else {
              if (block.text === value) return draft
              next.text = value
              delete next.runs
              const original = draft.original.blocks[index]
              if (original.text === value) return changeArticleEditor(draft, index, original, group)
            }
            return changeArticleEditor(draft, index, next, group)
          })
        }

        function toggleEditorBlock(index) {
          articleEditorGroupRef.current += 1
          setArticleEditor(function (draft) {
            if (!draft) return draft
            const next = draft.blocks[index] ? null : draft.removedBlocks[index] || draft.original.blocks[index]
            return changeArticleEditor(draft, index, next, '')
          })
        }

        function undoArticleEdit() {
          articleEditorGroupRef.current += 1
          setArticleEditor(undoArticleEditor)
        }

        async function saveArticleEdits() {
          const draft = articleEditorRef.current
          if (!draft || draft.status === 'saving' || !articleEditorChangeCount(draft)) return
          const next = buildEditedArticle(draft)
          if (!next.blocks.length) {
            setArticleEditor(Object.assign({}, draft, { error: t('edit.empty') }))
            return
          }
          setArticleEditor(Object.assign({}, draft, { status: 'saving', error: '' }))
          const result = await saveArticle(next, { editSourceKey: draft.key, previous: draft.savedState, sourceRef: draft.sourceRef })
          if (!mountedRef.current || !articleEditorRef.current || articleEditorRef.current.key !== draft.key) return
          if (!result) {
            const detail = saveStatusRef.current && saveStatusRef.current.error || ''
            setArticleEditor(function (current) { return current ? Object.assign({}, current, { status: 'editing', error: t('edit.failed') + (detail ? ' ' + detail : '') }) : current })
            return
          }
          saveStatusRef.current = result.status
          setArticle(next)
          cache.article = next
          articleEditRestoreFocusRef.current = true
          setArticleEditor(null)
          cache.articleEditor = null
          setSelection(null)
          setFileNotice(t('edit.saved'))
          setShowTranslation(false)
          setTranslation({ status: 'idle', key: '', content: '', error: '' })
          cache.translation = null
          resetKbArticleState()
          if (cache.readerScroll) cache.readerScroll = Object.assign({}, cache.readerScroll, { key: articleIdentityKey(next) })
        }

        function renderArticleEditor() {
          const draft = articleEditor
          const disabled = draft.status === 'saving'
          let imageNumber = 0
          return h('div', { className: 'air-article-editor', 'aria-label': t('edit.title') },
            draft.blocks.map(function (block, index) {
              const original = draft.original.blocks[index]
              if (original.kind === 'image') imageNumber += 1
              const image = original.kind === 'image'
              const n = String(image ? imageNumber : index + 1)
              const deleteLabel = image ? t('edit.deleteImage', { n: n }) : t('edit.deleteBlock', { n: n })
              const restoreLabel = image ? t('edit.restoreImage', { n: n }) : t('edit.restoreBlock', { n: n })
              let body = null
              if (!block) body = h('p', { className: 'air-edit-placeholder' }, t('edit.removed'))
              else if (block.kind === 'image') body = h(ArticleImage, { key: 'edit-image-' + index, src: block.src, alt: block.alt, articleUrl: article.url, viewImageLabel: viewImageLabel, editing: true, unavailableLabel: t('edit.imageUnavailable') })
              else if (typeof block.text === 'string') body = h('textarea', {
                className: 'air-edit-input', value: block.text, rows: 1, disabled: disabled, spellCheck: false,
                'aria-label': t('edit.textLabel', { n: String(index + 1) }),
                onChange: function (event) { updateEditorText(index, event.target.value); resizeArticleEditorInput(event.currentTarget || event.target) },
                onBlur: function () { articleEditorGroupRef.current += 1 },
                onKeyDown: function (event) { event.stopPropagation() },
              })
              else if (block.kind === 'table') body = h('div', { className: 'air-edit-table' },
                block.rows.map(function (row, r) { return h('div', { key: r, className: 'air-edit-table-row' }, row.map(function (cell, c) { return h('textarea', {
                  key: c, className: 'air-edit-input', value: cell, rows: 1, disabled: disabled,
                  'aria-label': t('edit.cellLabel', { n: String(index + 1), row: String(r + 1), col: String(c + 1) }),
                  onChange: function (event) { updateEditorText(index, event.target.value, r, c); resizeArticleEditorInput(event.currentTarget || event.target) },
                  onBlur: function () { articleEditorGroupRef.current += 1 }, onKeyDown: function (event) { event.stopPropagation() },
                }) })) }))
              else body = h('hr', { className: 'air-hr' })
              return h('div', { key: 'edit-block-' + index, className: 'air-edit-block' + (!block ? ' air-edit-removed' : ''), 'data-kind': original.kind },
                h('button', { type: 'button', className: 'air-edit-remove', disabled: disabled,
                  'aria-label': block ? deleteLabel : restoreLabel, title: block ? deleteLabel : restoreLabel,
                  onClick: function () { toggleEditorBlock(index) } }, block ? h(TrashIcon, { size: 13 }) : h(BackIcon, { size: 13 }), block ? t('edit.delete') : t('edit.restore')),
                body)
            }))
        }

        function renderArticleEditToolbar() {
          const saving = articleEditor.status === 'saving'
          const changes = articleEditorChangeCount(articleEditor)
          return h('div', { className: 'air-edit-toolbar' },
            h('div', { className: 'air-edit-intro' }, h('strong', null, t('edit.title')), h('span', null, t('edit.help'))),
            h('div', { className: 'air-edit-controls' },
              h('span', { className: 'air-edit-count', role: 'status' }, changes ? t('edit.changes', { n: String(changes) }) : t('edit.noChanges')),
              h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', disabled: saving || !articleEditor.history.length, onClick: undoArticleEdit }, t('edit.undo')),
              h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', disabled: saving, onClick: cancelArticleEdit }, t('edit.cancel')),
              h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-primary', disabled: saving || !changes, onClick: function () { void saveArticleEdits() } }, saving ? t('edit.saving') : t('edit.save'))),
            articleEditor.error ? h('p', { className: 'air-edit-error', role: 'alert' }, articleEditor.error) : null)
        }

        function renderArticleActions() {
          if (!article) return null
          if (articleEditor) return null
          return h(
            'div',
            { className: 'air-article-actions' },
            h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost air-edit-action', ref: articleEditTriggerRef,
              disabled: busy || loadingArticle || !!fileBusy || saveStatus.status === 'saving' || kbIngest.status === 'running' || translation.status === 'loading' || translation.status === 'streaming',
              'aria-label': t('edit.action'), title: t('edit.hint'), onClick: beginArticleEdit }, h(FileIcon, { size: 13 }), t('edit.action')),
            renderTranslateAction(),
            renderAutoSaveChip(),
            renderSaveAction(),
            renderKbIngestAction(),
          )
        }

        /**
         * 保存结果条：成功 = 路径 + 打开文件夹 / 查看本地文稿；失败 = 红条 + 重试。
         * @returns {any}
         */
        function renderSaveNotice() {
          if (!saveNotice) return null
          const closeButton = h(
            'button',
            {
              type: 'button',
              className: 'air-iconbtn air-save-notice-close',
              title: t('save.dismiss'),
              'aria-label': t('save.dismiss'),
              onClick: function () {
                showSaveNotice(null)
              },
            },
            h(XIcon, { size: 12 }),
          )
          if (saveNotice.kind === 'error') {
            return h(
              'div',
              { className: 'air-save-notice air-save-notice-error', role: 'alert' },
              h('span', { className: 'air-save-notice-text' }, saveNotice.message || t('save.failed')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'air-linkbtn',
                  onClick: function () {
                    void saveArticle(article, {})
                  },
                },
                t('save.retry'),
              ),
              closeButton,
            )
          }
          const parts = []
          if (saveNotice.changed === false) {
            parts.push(t('save.notice.unchanged'))
          } else {
            parts.push(t('save.notice.done', { dir: saveNotice.dirLabel || '' }))
            if (Number(saveNotice.images) > 0) parts.push(t('save.notice.images', { n: String(saveNotice.images) }))
            if (Number(saveNotice.notes) > 0) parts.push(t('save.notice.note', { n: String(saveNotice.notes) }))
          }
          return h(
            'div',
            { className: 'air-save-notice', role: 'status' },
            h(CheckIcon, { size: 13 }),
            h('span', { className: 'air-save-notice-text' }, parts.join(' ')),
            h(
              'button',
              {
                type: 'button',
                className: 'air-linkbtn',
                onClick: function () {
                  void revealSavedDir(saveNotice.id)
                },
              },
              t('save.openFolder'),
            ),
            h('button', { type: 'button', className: 'air-linkbtn', onClick: openSavedView }, t('save.openLibrary')),
            closeButton,
          )
        }

        /**
         * 左栏「本地文稿」视图：头部（返回/标题/数量/刷新/打开文件夹）+ 列表 / 空态 / 错误。
         * @returns {any}
         */
        function renderLibraryView() {
          const view = savedView && typeof savedView === 'object' ? savedView : { items: [], loading: true, error: '', dirLabel: '', confirmId: '', deletingId: '' }
          const items = Array.isArray(view.items) ? view.items : []
          const header = h(
            'div',
            { className: 'air-lib-head' },
            article
              ? h(
                  'button',
                  {
                    ref: libraryBackRef,
                    type: 'button',
                    className: 'air-iconbtn air-lib-back',
                    title: t('library.back'),
                    'aria-label': t('library.back'),
                    onClick: closeSavedView,
                  },
                  h(BackIcon, { size: 14 }),
                )
              : null,
            h('span', { className: 'air-lib-title' }, h(FolderIcon, { size: 15 }), t('library.title')),
            h('span', { className: 'air-lib-count' }, view.loading ? '' : t('library.count', { n: String(items.length) })),
            h('span', { className: 'air-lib-spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'air-iconbtn',
                title: t('library.refresh'),
                'aria-label': t('library.refresh'),
                disabled: !!view.loading,
                onClick: function () {
                  void loadSavedList()
                },
              },
              h(RefreshIcon, { size: 13 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'air-linkbtn',
                onClick: function () {
                  void revealSavedDir('')
                },
              },
              t('library.openFolder'),
            ),
          )
          let body = null
          if (view.loading && items.length === 0) {
            body = h(LoadingStatus, { text: t('library.loading') })
          } else if (items.length === 0) {
            body = h(
              'div',
              { className: 'air-empty air-lib-empty' },
              h('span', { className: 'air-empty-icon' }, h(FolderIcon, { size: 26 })),
              h('p', { className: 'air-empty-title' }, t('library.emptyTitle')),
              h('p', { className: 'air-empty-hint' }, t('library.emptyHint')),
            )
          } else {
            const rows = []
            for (let index = 0; index < items.length; index += 1) {
              const item = items[index]
              if (!item || typeof item.id !== 'string') continue
              const metaParts = []
              if (item.site) metaParts.push(String(item.site))
              if (item.savedAt) metaParts.push(t('library.saveTime', { time: formatKbTime(item.savedAt) }))
              if (Number(item.chars) > 0) metaParts.push(t('library.chars', { n: String(item.chars) }))
              if (Number(item.blocks) > 0) metaParts.push(t('library.blocks', { n: String(item.blocks) }))
              if (Number(item.images) > 0) metaParts.push(t('library.images', { n: String(item.images) }))
              if (Number(item.turns) > 0) metaParts.push(t('library.messages', { n: String(item.turns) }))
              const sizeLabel = formatFileSize(item.bytes, t)
              if (sizeLabel) metaParts.push(sizeLabel)
              const confirming = view.confirmId === item.id
              const deleting = view.deletingId === item.id
              rows.push(
                h(
                  'div',
                  {
                    key: 'lib-' + item.id,
                    className: 'air-lib-item',
                    role: 'listitem',
                    // 整行可点：卡片 padding 区域也能打开（P2-7）；删除按钮单独处理并阻止冒泡
                    onClick: function (event) {
                      const target = event && event.target
                      if (target && typeof target.closest === 'function' && target.closest('.air-lib-delete')) return
                      if (deleting) return
                      void openSavedItem(item)
                    },
                  },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'air-lib-open',
                      title: t('library.itemHint'),
                      onClick: function (event) {
                        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                        if (deleting) return
                        void openSavedItem(item)
                      },
                    },
                    h('span', { className: 'air-lib-item-title' }, item.title || t('paste.untitled')),
                    h('span', { className: 'air-lib-item-meta' }, metaParts.join(' · ')),
                  ),
                  h(
                    'div',
                    {
                      className: 'air-lib-actions',
                      role: 'group',
                      'aria-label': t('library.itemActions'),
                      'aria-live': 'polite',
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'air-lib-delete' + (confirming ? ' air-lib-delete-confirm' : ''),
                        disabled: deleting,
                        title: confirming ? t('library.deleteConfirm') : t('library.delete'),
                        'aria-label': confirming ? t('library.deleteConfirm') : t('library.delete'),
                        onClick: function (event) {
                          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                          if (confirming) void deleteSavedItem(item)
                          else requestDeleteSaved(item)
                        },
                      },
                      deleting ? t('library.deleting') : confirming ? t('library.deleteConfirm') : t('library.delete'),
                    ),
                  ),
                ),
              )
            }
            body = h('div', { className: 'air-lib-list', role: 'list' }, rows)
          }
          const errorBar = view.error
            ? h(
                'div',
                { className: 'air-kb-error', role: 'alert' },
                h('span', { className: 'air-kb-error-text' }, view.error),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'air-linkbtn',
                    onClick: function () {
                      void loadSavedList()
                    },
                  },
                  t('library.retry'),
                ),
              )
            : null
          return h(
            'div',
            { className: 'air-library' },
            header,
            errorBar,
            h('div', { className: 'air-lib-scroll' }, body),
          )
        }

        /**
         * 左栏 KB 页面预览：返回按钮 + 标题 + type/confidence/更新时间徽章 + Markdown 正文。
         * @returns {any}
         */
        function renderKbPreview() {
          const preview = kbPreview
          const page = preview && preview.page ? preview.page : null
          let body = null
          if (!preview || preview.loading) {
            body = h(LoadingStatus, { text: t('kb.preview.loading') })
          } else if (preview.error) {
            body = h(
              'div',
              { className: 'air-kb-error' },
              h('span', { className: 'air-kb-error-text' }, preview.error),
              h(
                'button',
                { type: 'button', className: 'air-linkbtn', onClick: retryKbPreview },
                t('kb.preview.retry'),
              ),
            )
          } else if (page) {
            const badges = []
            if (page.type) badges.push(h('span', { key: 'type', className: 'air-tag air-kb-type' }, kbTypeLabel(page.type, t)))
            if (page.confidence) {
              badges.push(h('span', { key: 'confidence', className: 'air-tag' }, t('kb.preview.confidence', { value: page.confidence })))
            }
            if (page.updatedAt) {
              badges.push(h('span', { key: 'updated', className: 'air-kb-updated' }, t('kb.preview.updated', { time: formatKbTime(page.updatedAt) })))
            }
            body = h(
              'div',
              { className: 'air-kb-page-body' },
              h('h1', { className: 'air-kb-page-title' }, page.title),
              badges.length > 0 ? h('div', { className: 'air-kb-badges' }, badges) : null,
              h('hr', { className: 'air-hr' }),
              h('div', { className: 'air-kb-prose' }, renderMarkdown(page.markdown, tableLabel)),
            )
          }
          return h(
            'div',
            { className: 'air-reader air-kb-page', ref: readerRef, tabIndex: 0, role: 'region', 'aria-label': t('reader.region') },
            h(
              'div',
              { className: 'air-reader-inner air-kb-page-inner' },
              h(
                'button',
                {
                  type: 'button',
                  ref: kbBackRef,
                  className: 'air-iconbtn air-kb-back',
                  title: t('kb.preview.back'),
                  'aria-label': t('kb.preview.back'),
                  onClick: closeKbPreview,
                },
                h(BackIcon, { size: 15 }),
              ),
              body,
            ),
          )
        }

        /**
         * 左栏主区域：加载中 / 阅读排版 / 空状态 / 粘贴模式编辑器。
         * @returns {any}
         */
        function renderExcerptEditor() {
          const saving = excerptDraft.status === 'saving'
          const done = excerptDraft.status === 'done'
          const tags = Array.from(new Set(excerptOptions.tags.concat(['AI', '技术', '产品', '商业', '写作', '灵感'], excerptDraft.tags)))
          return h('div', { className: 'air-excerpt-editor' },
            h('button', { type: 'button', className: 'air-linkbtn air-excerpt-back', disabled: saving,
              onClick: function () { setExcerptDraft(function (previous) { return Object.assign({}, previous, { open: false }) }) } }, t('excerpt.backToQuestion')),
            h('blockquote', { className: 'air-excerpt-preview', 'aria-label': t('excerpt.preview') }, selection.text),
            done
              ? h('div', { className: 'air-excerpt-success', role: 'status' },
                  h('p', null, t('excerpt.saved', { file: excerptDraft.fileName || '摘抄笔记.md' })),
                  h('button', { type: 'button', className: 'air-btn air-btn-primary', onClick: openExcerptsView }, t('excerpt.viewNote')))
              : h('div', { className: 'air-excerpt-fields' },
                  h('span', { className: 'air-excerpt-label' }, t('excerpt.tags')),
                  excerptOptions.loading ? h('span', { className: 'air-excerpt-hint', role: 'status' }, t('excerpt.tagsLoading')) : null,
                  excerptOptions.error ? h('div', { className: 'air-excerpt-error', role: 'alert' }, excerptOptions.error,
                    h('button', { type: 'button', className: 'air-linkbtn', onClick: function () { void loadExcerptOptions() } }, t('excerpt.retry'))) : null,
                  h('div', { className: 'air-excerpt-tags', role: 'group', 'aria-label': t('excerpt.tags') }, tags.map(function (tag) {
                    const chosen = excerptDraft.tags.includes(tag)
                    return h('button', { key: tag, type: 'button', className: 'air-excerpt-tag', 'aria-pressed': chosen,
                      disabled: saving || (!chosen && excerptDraft.tags.length >= 8), onClick: function () { toggleExcerptTag(tag) } }, tag)
                  })),
                  h('div', { className: 'air-excerpt-newtag' },
                    h('input', { ref: excerptTagInputRef, type: 'text', className: 'air-sel-ask-input', value: excerptDraft.newTag,
                      disabled: saving, placeholder: t('excerpt.newTag'), 'aria-label': t('excerpt.newTag'), autoComplete: 'off',
                      onChange: function (event) { const value = event.target.value; setExcerptDraft(function (previous) { return Object.assign({}, previous, { newTag: value, error: '' }) }) },
                      onKeyDown: function (event) {
                        if (event.key !== 'Enter' || event.isComposing || (event.nativeEvent && event.nativeEvent.isComposing)) return
                        event.preventDefault()
                        event.stopPropagation()
                        addExcerptTag()
                      } }),
                    h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', disabled: saving || !excerptDraft.newTag.trim(), onClick: addExcerptTag }, t('excerpt.addTag'))),
                  excerptDraft.tags.length >= 8 ? h('span', { className: 'air-excerpt-hint' }, t('excerpt.tagLimit')) : null,
                  selection.text.length > 20000 ? h('p', { className: 'air-excerpt-error', role: 'alert' }, t('excerpt.tooLong')) : null,
                  excerptDraft.error ? h('p', { className: 'air-excerpt-error', role: 'alert' }, excerptDraft.error) : null,
                  h('div', { className: 'air-excerpt-footer' },
                    h('button', { type: 'button', className: 'air-btn air-btn-primary',
                      disabled: saving || excerptDraft.tags.length === 0 || Boolean(excerptDraft.newTag.trim()) || selection.text.length > 20000,
                      onClick: function () { void saveExcerpt() } }, saving ? t('excerpt.saving') : t('excerpt.save')))))
        }

        function renderExcerptsView() {
          const view = excerptsView
          const note = view && view.note
          const entries = note ? note.entries.filter(function (entry) { return !view.tag || entry.tags.includes(view.tag) }) : []
          return h('div', { className: 'air-excerpts-view', role: 'region', 'aria-label': t('excerpt.note') },
            h('div', { className: 'air-excerpts-head' },
              h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', ref: excerptNoteBackRef,
                'aria-label': t('excerpt.back'), onClick: closeExcerptsView }, h(BackIcon, { size: 14 }), t('excerpt.back')),
              h('h2', null, t('excerpt.note')),
              h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', disabled: view.loading || Boolean(view.deletingId),
                'aria-label': t('excerpt.refresh'), onClick: function () { void loadExcerptsView() } }, t('excerpt.refresh'))),
            note ? h('div', { className: 'air-excerpts-info' },
              h('strong', null, note.fileName),
              h('span', { className: 'air-excerpt-hint' }, t('excerpt.count', { n: String(note.count) })),
              h('div', { className: 'air-excerpts-path' }, note.path),
              h('div', { className: 'air-excerpt-tags', role: 'group', 'aria-label': t('excerpt.allTags') }, [''].concat(note.tags).map(function (tag) {
                return h('button', { key: tag || 'all', type: 'button', className: 'air-excerpt-tag', 'aria-pressed': view.tag === tag,
                  onClick: function () { setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, { tag: tag, confirmId: '' }) : null }) } }, tag || t('excerpt.allTags'))
              }))) : null,
            view.error ? h('div', { className: 'air-excerpt-error air-excerpts-notice', role: 'alert' }, view.error,
              h('button', { type: 'button', className: 'air-linkbtn', disabled: Boolean(view.deletingId), onClick: function () { void loadExcerptsView() } }, t('excerpt.retry'))) : null,
            h('div', { className: 'air-excerpts-notice air-excerpts-status', role: 'status' }, view.notice || ''),
            h('div', { className: 'air-excerpts-scroll' },
              view.loading ? h(LoadingStatus, { text: t('excerpt.loading') })
                : note && entries.length ? entries.map(function (entry, index) {
                    const href = safeHref(entry.article.url)
                    const confirming = view.confirmId === entry.id
                    const deleting = view.deletingId === entry.id
                    return h('article', { key: entry.id || String(index), className: 'air-excerpt-entry' },
                      h('div', { className: 'air-excerpt-entry-meta' },
                        entry.createdAt ? h('time', { dateTime: entry.createdAt }, formatKbTime(entry.createdAt)) : null,
                        entry.tags.map(function (tag) { return h('span', { key: tag, className: 'air-tag' }, tag) }),
                        entry.id ? h('div', { className: 'air-excerpt-actions' },
                          h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost air-excerpt-delete',
                            disabled: Boolean(view.deletingId),
                            'aria-label': t(confirming ? 'excerpt.deleteConfirmLabel' : 'excerpt.deleteLabel', { title: entry.article.title || entry.text.slice(0, 40) }),
                            onClick: function (event) {
                              if (confirming) { void deleteExcerpt(entry); return }
                              excerptDeleteTriggerRef.current = event.currentTarget
                              setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, { confirmId: entry.id, error: '', notice: '' }) : null })
                            } }, deleting ? t('excerpt.deleting') : confirming ? t('excerpt.deleteConfirm') : t('excerpt.delete')),
                          confirming ? h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost',
                            onClick: function () {
                              setExcerptsView(function (previous) { return previous ? Object.assign({}, previous, { confirmId: '' }) : null })
                              if (excerptDeleteTriggerRef.current) excerptDeleteTriggerRef.current.focus()
                            } }, t('excerpt.deleteCancel')) : null) : null),
                      confirming ? h('p', { className: 'air-excerpt-delete-hint' }, t('excerpt.deleteHint')) : null,
                      h('blockquote', { className: 'air-excerpt-entry-text' }, entry.text),
                      href ? h('a', { href: href, target: '_blank', rel: 'noopener noreferrer', className: 'air-excerpt-source' }, entry.article.title || entry.article.site || href)
                        : entry.article.title ? h('span', { className: 'air-excerpt-source' }, entry.article.title) : null)
                  })
                  : note && !view.error ? h('div', { className: 'air-empty' },
                      h('p', { className: 'air-empty-title' }, view.tag ? t('excerpt.noMatch') : t('excerpt.empty')),
                      !view.tag ? h('p', { className: 'air-empty-hint' }, t('excerpt.emptyHint')) : null) : null))
        }

        function renderLeftMain() {
          if (excerptsView) return renderExcerptsView()
          // 本地文稿视图优先（工具条「本地文稿」进入；打开一篇文稿后自动回到文章视图）
          if (savedView) return renderLibraryView()
          // KB 页面预览优先（点击参考/相关 chips 进入，返回后恢复文章与滚动位置）
          if (kbPreview) return renderKbPreview()
          if (mode === 'paste') {
            return h(
              'div',
              { className: 'air-paste' },
              h('textarea', {
                className: 'air-paste-body',
                value: pasteText,
                placeholder: t('paste.placeholder'),
                'aria-label': t('paste.placeholder'),
                spellCheck: false,
                onChange: function (event) {
                  setPasteText(event.target.value)
                },
              }),
              h('div', { className: 'air-paste-hint' }, t('paste.hint')),
            )
          }
          if (loadingArticle) {
            return h(
              'div',
              { className: 'air-reader air-reader-empty', ref: readerRef },
              h(LoadingStatus, { text: t('reader.loading') }),
            )
          }
          if (!article) {
            return h(
              'div',
              { className: 'air-reader air-reader-empty', ref: readerRef },
              h(
                'div',
                { className: 'air-empty' },
                h('span', { className: 'air-empty-icon' }, h(ReaderGlyph, { size: 26 })),
                h('p', { className: 'air-empty-title' }, t('reader.empty.title')),
                h('p', { className: 'air-empty-hint' }, t('reader.empty.hint')),
                h(
                  'div',
                  { className: 'air-empty-actions' },
                  h(
                    'button',
                    { type: 'button', className: 'air-btn air-btn-primary', onClick: openFilePicker },
                    h(FileIcon, { size: 14 }),
                    t('file.open'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'air-btn air-btn-secondary', onClick: toggleMode },
                    t('mode.paste'),
                  ),
                ),
                h('p', { className: 'air-empty-shortcut' }, t('shortcut.hint')),
              ),
            )
          }
          // 文章头：标题 + 元信息
          //   本地文件：文件名 · 格式徽章 · 大小 · 约 N 分钟 · N 字（不显示原文链接）
          //   网页文章：站点 · 作者（若有） · 原文链接 · 约 N 分钟 · N 字
          const metaNodes = []
          if (localFile) {
            metaNodes.push(h('span', { key: 'file-name', className: 'air-file-name', title: localFile.name }, localFile.name))
            if (localFile.format) {
              metaNodes.push(h('span', { key: 'file-format', className: 'air-tag air-tag-file' }, fileFormatLabel(localFile.format, t)))
            }
            if (localFile.bytes > 0) metaNodes.push(h('span', { key: 'file-size' }, formatFileSize(localFile.bytes, t)))
          } else {
            if (article.site) metaNodes.push(h('span', { key: 'site' }, article.site))
            if (article.byline) metaNodes.push(h('span', { key: 'byline' }, t('reader.byline', { name: article.byline })))
            const sourceUrl = article.sourceUrl || article.url
            if (sourceUrl) {
              metaNodes.push(
                h('a', { key: 'source', href: sourceUrl, target: '_blank', rel: 'noreferrer' }, t('reader.source')),
              )
            }
          }
          if (readingMinutes > 0) metaNodes.push(h('span', { key: 'minutes' }, t('reader.readingTime', { n: String(readingMinutes) })))
          if (charCount > 0) metaNodes.push(h('span', { key: 'chars' }, t('reader.chars', { n: String(charCount) })))
          const metaWithDots = []
          for (let index = 0; index < metaNodes.length; index += 1) {
            if (index > 0) metaWithDots.push(h('span', { key: 'dot-' + index, className: 'air-meta-dot', 'aria-hidden': 'true' }))
            metaWithDots.push(metaNodes[index])
          }
          if (article.contentSource === 'rss' || article.contentSource === 'publisher') {
            const publisher = article.contentSource === 'publisher'
            metaWithDots.push(h(publisher ? 'a' : 'span', {
              key: article.contentSource, className: 'air-tag',
              title: article.sourceLabel + ' · ' + (article.contentUrl || article.feedUrl || ''),
              ...(publisher ? { href: article.contentUrl, target: '_blank', rel: 'noreferrer' } : {}),
            }, t(publisher ? 'reader.publisherContent' : 'reader.rssContent')))
            if (article.publishedAt) metaWithDots.push(h('time', { key: 'published', dateTime: article.publishedAt, title: article.publishedAt }, new Date(article.publishedAt).toLocaleDateString()))
          }
          if (article.edited === true) metaWithDots.push(h('span', { key: 'edited', className: 'air-tag' }, t('edit.local')))
          if (article.truncated) metaWithDots.push(h('span', { key: 'truncated', className: 'air-tag air-tag-warn' }, t('reader.truncated')))
          else if (charCount > 0 && charCount < 400) metaWithDots.push(h('span', { key: 'short', className: 'air-tag air-tag-warn' }, t('reader.shortArticle')))
          return h(
            'div',
            {
              className: 'air-reader',
              ref: readerRef,
              tabIndex: 0,
              role: 'region',
              'aria-label': t('reader.region'),
              // 版心宽度通过 CSS 变量下发；字号 / 行高作用在 .air-prose 上（正文内标题为固定档）
              style: { '--air-measure': widthPref.width + 'px', '--air-gutter': widthPref.gutter },
              onMouseUp: scheduleSelectionUpdate,
              onScroll: function (event) {
                if (selection) setSelection(null)
                // 面板切走/卸载后回到同一篇文章时恢复阅读位置
                const scroller = event.currentTarget
                cache.readerScroll = { key: articleKey, top: scroller.scrollTop }
              },
            },
            // 2px 阅读进度条：CSS scroll-driven animation（scroll(nearest)），无 JS 滚动监听；
            // 不支持 animation-timeline 的浏览器由 @supports 外的默认 scaleX(0) 保持不可见。
            h('div', { className: 'air-progress', 'aria-hidden': 'true' }, h('span', { className: 'air-progress-bar' })),
            h(
              'div',
              { className: 'air-reader-inner', ref: readerInnerRef },
              selection && selectionBands.length ? h('div', { className: 'air-selection-bands', 'aria-hidden': 'true' },
                selectionBands.map(function (band, index) { return h('span', { key: 'selection-band-' + index, style: band }) })) : null,
              h(
                'div',
                { className: 'air-article-head' },
                h('h1', { className: 'air-article-title' }, article.title || t('paste.untitled')),
                h(
                  'div',
                  { className: 'air-article-headrow' },
                  metaWithDots.length > 0 ? h('div', { className: 'air-article-meta' }, metaWithDots) : h('span', { className: 'air-article-meta' }),
                  renderArticleActions(),
                ),
              ),
              articleEditor ? renderArticleEditToolbar() : renderSaveNotice(),
              renderKbIngestError(),
              // 左栏正文：默认原文；点了「译成中文」后在同一阅读区显示译文，可切回（CONTRACT §19.1）
              h(
                'div',
                { className: 'air-prose air-translation-prose', style: { fontSize: fontPref.size + 'px', lineHeight: String(fontPref.lineHeight) } },
                articleEditor ? renderArticleEditor() : showTranslation && translation.key === articleKey && translation.status !== 'idle'
                  ? [
                      h(
                        'div',
                        { key: 'translation-bar', className: 'air-translation-bar' },
                        h('span', { className: 'air-translation-title' }, h(GlobeIcon, { size: 13 }), t('translate.title')),
                        h('span', { className: 'air-translation-badge' }, t('translate.badge')),
                        translation.status === 'loading' || translation.status === 'streaming'
                          ? h(
                              'span',
                              { className: 'air-translation-status', role: 'status', 'aria-live': 'polite' },
                              h(LoadingDots, { small: true }),
                              translation.totalParts > 1 ? t('translate.progress', { part: translation.part, total: translation.totalParts }) : t('translate.loading'),
                            )
                          : null,
                      ),
                      translation.status === 'error'
                        ? h(
                            'div',
                            { key: 'translation-error', className: 'air-translation-error', role: 'alert' },
                            h('p', { className: 'air-translation-error-text' }, translation.error || t('translate.failed')),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'air-btn air-btn-sm air-btn-secondary air-translation-retry',
                                onClick: function () {
                                  void startTranslate()
                                },
                              },
                              t('translate.retry'),
                            ),
                            h(
                              'button',
                              { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost', onClick: function () { setShowTranslation(false) } },
                              t('translate.viewOriginal'),
                            ),
                          )
                        : null,
                      translation.content.trim()
                          ? h(
                              'div',
                              { key: 'translation-body', className: 'air-translation-body' },
                              renderMarkdown(translation.content, tableLabel),
                              translation.status === 'streaming' ? h('span', { key: 'translation-cursor', className: 'air-cursor' }) : null,
                            )
                          : translation.status === 'error' ? null : h(
                              LoadingStatus,
                              { key: 'translation-loading', className: 'air-translation-loading', text: t('translate.loading') },
                            ),
                    ]
                  : articleNodes,
              ),
            ),
          )
        }

        /**
         * 右栏头部：标题 + 知识库开关 + 快捷按钮组 + 清空。
         * @returns {any}
         */
        function renderRightHead() {
          const chips = []
          for (let index = 0; index < QUICK_ACTIONS.length; index += 1) {
            const action = QUICK_ACTIONS[index]
            chips.push(
              h(
                'button',
                {
                  key: action.id,
                  type: 'button',
                  className: 'air-chip',
                  disabled: !article || busy,
                  onClick: function () {
                    runQuickAction(action)
                  },
                },
                t(action.labelKey),
              ),
            )
          }
          return h(
            'div',
            { className: 'air-righttop' },
            h(
              'div',
              { className: 'air-righthead' },
              h(
                'span',
                { className: 'air-right-title' },
                h('span', { className: 'air-right-title-icon' }, h(SparkIcon, { size: 14 })),
                t('right.title'),
              ),
              h('span', { className: 'air-right-spacer' }),
              renderWebChip(),
              renderKbChip(),
              h(
                'button',
                {
                  type: 'button',
                  className: 'air-btn air-btn-ghost air-btn-sm air-clear',
                  title: t('right.clear'),
                  disabled: thread.length === 0 && !busy,
                  onClick: clearThread,
                },
                h(TrashIcon, { size: 13 }),
                t('right.clear'),
              ),
            ),
            h('div', { className: 'air-quickrow' }, h('div', { className: 'air-quickbar' }, chips)),
          )
        }

        /**
         * 渲染一条线程消息（user / assistant 两种）。
         * @param {any} message 线程消息。
         * @returns {any}
         */
        function renderMessage(message) {
          if (!message || typeof message !== 'object') return null
          if (message.role === 'user') {
            return h(
              'div',
              { key: message.id, className: 'air-msg air-msg-user' },
              h('div', { className: 'air-msg-bubble' }, renderUserSegments(message)),
            )
          }
          return h(AssistantMessage, {
            key: message.id,
            message: message,
            t: t,
            onRetry: retryMessage,
            busy: busy,
            kbSearching: kbPhase === 'searching',
            kbMiss: kbPhase === 'miss',
            webSearching: webPhase === 'searching',
            webMiss: webPhase === 'miss',
            webError: webPhase === 'error',
            onOpenKbPage: openKbPage,
          })
        }

        // ---- 渲染 ------------------------------------------------------------
        return h(
          'div',
          {
            className: 'air-root',
            'data-dragging': dragging ? 'true' : 'false',
            'data-pane': compactPane,
            onKeyDown: handleRootKeyDown,
            onKeyUp: handleRootKeyUp,
            onDragEnter: handleRootDragEnter,
            onDragOver: handleRootDragOver,
            onDragLeave: handleRootDragLeave,
            onDrop: handleRootDrop,
          },
          h('style', { key: 'air-style' }, AIR_CSS),
          h(
            'header',
            { className: 'air-header' },
            h('span', { className: 'air-logo', 'aria-hidden': 'true' }, h(ReaderGlyph, { size: 16 })),
            h('span', { className: 'air-title' }, t('panel.label')),
            h('span', { className: 'air-header-subtitle' }, t('header.tagline')),
            h('span', { className: 'air-header-spacer' }),
            h(
              'span',
              { className: 'air-model', 'data-state': metaState, title: badgeTitle },
              h('span', { className: 'air-model-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'air-model-text' }, badgeText),
            ),
          ),
          h('nav', { className: 'air-pane-switch', 'aria-label': t('panel.views') },
            h('div', { className: 'air-pane-segment' },
              h('button', { type: 'button', 'aria-pressed': compactPane === 'article', onClick: function () { setCompactPane('article') } }, t('panel.article')),
              h('button', { type: 'button', 'aria-pressed': compactPane === 'answer', onClick: function () { setCompactPane('answer') } }, t('right.title')),
            ),
          ),
          h(
            'div',
            { className: 'air-body', ref: bodyRef, style: { '--air-split': split + '%' } },
            h(
              'section',
              { className: 'air-left', 'aria-label': t('panel.article') },
              renderToolbar(),
              renderPassageIngestStatus(false),
              fileNotice
                ? h(
                    'div',
                    { className: 'air-notice', role: 'status' },
                    h('span', { className: 'air-notice-text' }, fileNotice),
                  )
                : null,
              leftError
                ? h(
                    'div',
                    { className: 'air-errorbar', role: 'alert' },
                    h('span', { className: 'air-errorbar-text' }, leftError),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'air-iconbtn air-errorbar-close',
                        title: t('error.dismiss'),
                        'aria-label': t('error.dismiss'),
                        onClick: function () {
                          setLeftError('')
                        },
                      },
                      h(XIcon, { size: 13 }),
                    ),
                  )
                : null,
              renderLeftMain(),
            ),
            h('div', {
              key: 'splitter',
              className: 'air-splitter',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': t('splitter.label'),
              'aria-valuenow': Math.round(split),
              'aria-valuemin': 32,
              'aria-valuemax': 68,
              'aria-valuetext': Math.round(split) + '%',
              title: t('splitter.hint'),
              tabIndex: 0,
              'data-dragging': dragging ? 'true' : 'false',
              onPointerDown: handleSplitterPointerDown,
              onKeyDown: handleSplitterKeyDown,
              onDoubleClick: resetSplit,
            }),
            h(
              'section',
              { className: 'air-right', 'aria-label': t('right.title') },
              renderRightHead(),
              undoThread
                ? h(
                    'div',
                    { className: 'air-undo', role: 'status' },
                    h('span', { className: 'air-undo-text' }, t('right.cleared')),
                    h(
                      'button',
                      { type: 'button', className: 'air-linkbtn', onClick: undoClear },
                      t('right.undo'),
                    ),
                  )
                : null,
              renderKbRelatedBar(),
              h(
                'div',
                {
                  className: 'air-thread',
                  ref: threadRef,
                  role: 'log',
                  tabIndex: 0,
                  'aria-label': t('right.title'),
                  'aria-busy': busy ? 'true' : 'false',
                },
                thread.length === 0 ? h(ThreadEmpty, { t: t }) : thread.map(renderMessage),
              ),
              h(
                'div',
                { className: 'air-composer' },
                h(
                  'form',
                  { className: 'air-composer-box', onSubmit: function (event) { event.preventDefault(); sendComposer() } },
                  h('textarea', {
                    className: 'air-composer-input',
                    rows: 1,
                    value: composer,
                    disabled: !article,
                    placeholder: article ? t('composer.placeholder') : t('composer.placeholderNoArticle'),
                    'aria-label': t('composer.label'),
                    'aria-describedby': article && !busy ? 'air-composer-keys' : undefined,
                    onChange: function (event) {
                      setComposer(event.target.value)
                    },
                    onKeyDown: handleComposerKeyDown,
                  }),
                  h('div', { className: 'air-composer-actions' },
                    article && !busy ? h('span', { id: 'air-composer-keys', className: 'air-composer-keys' }, t('composer.keys')) : null,
                    busy
                      ? h('button', { type: 'button', className: 'air-send air-send-stop', onClick: stopAnalysis }, t('composer.stop'))
                      : h('button', { type: 'submit', className: 'air-send', disabled: !canSend, title: t('composer.keys') }, t('composer.send')),
                  ),
                ),
              ),
            ),
          ),
          dragActive || fileBusy
            ? h(
                'div',
                {
                  className: 'air-drop-overlay',
                  role: fileBusy ? 'status' : undefined,
                  'aria-hidden': fileBusy ? 'false' : 'true',
                },
                h('div', { className: 'air-drop-frame', 'aria-hidden': 'true' }),
                h(
                  'div',
                  { className: 'air-drop-card' },
                  h('span', { className: 'air-drop-icon' }, h(FileIcon, { size: 44 })),
                  h(
                    'p',
                    { className: 'air-drop-title' },
                    fileBusy ? t('file.parsing', { name: fileBusy.name }) : t('file.dropTitle'),
                  ),
                  fileBusy ? h(LoadingDots) : null,
                  !fileBusy && maxUploadLabel
                    ? h('p', { className: 'air-drop-hint' }, t('file.dropHint', { n: maxUploadLabel }))
                    : null,
                ),
              )
            : null,
          selection && article && !busy
            ? h(
                'div',
                {
                  ref: selectionButtonRef,
                  key: 'selection-ask',
                  className: 'air-sel-ask',
                  role: 'group',
                  'aria-label': t('selection.askLabel'),
                  style: { top: selection.top + 'px', left: selection.left + 'px' },
                },
                h(
                  'div',
                  { className: 'air-sel-ask-head' },
                  h(SparkIcon, { size: 12 }),
                  h(
                    'span',
                    { className: 'air-sel-ask-count', title: String(selection.text).slice(0, 200) },
                    t('selection.selectedChars', { n: String(Array.from(String(selection.text)).length) }),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'air-iconbtn air-sel-ask-close',
                      title: t('selection.close'),
                      'aria-label': t('selection.close'),
                      onClick: closeSelectionBar,
                    },
                    h(XIcon, { size: 12 }),
                  ),
                ),
                excerptDraft.open ? renderExcerptEditor() : h(
                  'div',
                  { className: 'air-sel-ask-row' },
                  h('input', {
                    ref: selectionInputRef,
                    type: 'text',
                    className: 'air-sel-ask-input',
                    value: selectionQuestion,
                    placeholder: t('selection.questionPlaceholder'),
                    'aria-label': t('selection.questionPlaceholder'),
                    'aria-keyshortcuts': 'Meta+J Control+J',
                    spellCheck: false,
                    autoComplete: 'off',
                    onChange: function (event) {
                      setSelectionQuestion(event.target.value)
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !(event.nativeEvent && event.nativeEvent.isComposing)) {
                        event.preventDefault()
                        explainSelection(selection.text, selectionQuestion)
                        return
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        closeSelectionBar()
                      }
                    },
                  }),
                  h('div', { className: 'air-sel-ask-actions' },
                    h('button', { type: 'button', className: 'air-btn air-btn-sm air-btn-ghost air-sel-ask-excerpt',
                      'aria-label': t('excerpt.action'), onClick: openExcerptEditor }, t('excerpt.action')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'air-btn air-btn-sm air-btn-ghost air-sel-ask-translate',
                        title: t('selection.translateHint'),
                        'aria-label': t('selection.translate'),
                        onClick: function () { translateSelection(selection.text) },
                      },
                      t('selection.translate'),
                    ),
                    renderPassageIngestAction(),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'air-btn air-btn-sm air-btn-primary air-sel-ask-send',
                        title: t('selection.sendHint'),
                        'aria-label': t('selection.send'),
                        onClick: function () { explainSelection(selection.text, selectionQuestion) },
                      },
                      t('selection.send'),
                    ),
                  ),
                ),
                renderPassageIngestStatus(true),
              )
            : null,
        )
      }

      // ======================================================================
      // 样式：全部写进组件内渲染的 <style>，颜色只用主题变量（浅/深色自动适配）
      // ======================================================================
      const AIR_CSS = [
        /* ---- Apple 设计语言：系统字体 / 单一强调色 / 发丝线 / 材质 / 克制动效 ----
           ！！颜色只允许 --dsw-* / --dsh-* 主题变量 + color-mix，禁止 hex/rgb/hsl 写死颜色。
           表面层级用 host 语义表面 token（浅色主题里 bg-layer-1/2/3 全解析为白色，无法表达层级）：
             --air-panel-bg  面板/右栏底（host sidebar-fill：浅色浅灰 / 深色略亮于底色）
             --air-card-bg   浮在面板上的卡片/输入（host input-major：浅色白 / 深色提亮）
             --air-muted-bg  基础底上的控件/选中块/代码（host module-platform）
             --air-line      控件与结构发丝线（host border-l2）
             --air-line-strong 需要更明确边界的控件描边（host border-l3） */
        '.air-root{container:air-panel / inline-size;--air-font-ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;--air-font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--air-ease:cubic-bezier(.32,.72,0,1);--air-dur:180ms;--air-dur-fast:120ms;--air-dur-slow:220ms;--air-panel-bg:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base));--air-card-bg:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));--air-muted-bg:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-3));--air-line:var(--dsw-alias-border-l2);--air-line-strong:var(--dsw-alias-border-l3);--air-error-text:color-mix(in srgb,var(--dsw-alias-state-error-primary) 78%,var(--dsw-alias-label-primary));--air-business-text:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,var(--dsw-alias-label-primary));--air-shadow-overlay:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--air-font-ui);font-size:13px;line-height:20px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
        'html[data-platform=\'darwin\'] .air-root{padding-top:var(--dsh-frame-top-clearance,48px)}',
        '.air-root *,.air-root *::before,.air-root *::after{box-sizing:border-box}',
        '.air-root button,.air-root input,.air-root textarea{font-family:inherit}',
        '.air-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
        // 项目选择：文字输入使用系统强调色；单层焦点环不沿用黑色主操作的品牌色。
        '.air-root{--air-field-focus:var(--dsw-alias-state-business-primary);--air-field-ring:0 0 0 3px color-mix(in srgb,var(--air-field-focus) 20%,transparent)}',
        '@supports (color:AccentColor){.air-root{--air-field-focus:AccentColor}}',
        // 系统选中文本语义色（项目选择），随系统外观变化；保留清晰的焦点和原文上下文。
        '.air-root ::highlight(dsh-ai-reader-selection){background-color:Highlight;color:HighlightText}',
        '.air-reader ::selection{background-color:Highlight;color:HighlightText}',
        '.air-selection-bands{position:absolute;inset:0;pointer-events:none;user-select:none;z-index:1;overflow:hidden}',
        '.air-selection-bands>span{position:absolute;display:block;background-color:Highlight;pointer-events:none}',
        /* ---- 面板顶栏：56px 半透明材质 + 发丝线 ---- */
        '.air-header{position:relative;z-index:2;flex:0 0 auto;display:flex;align-items:center;gap:10px;min-height:52px;height:auto;padding:10px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:.5px solid var(--air-line)}',
        '.air-logo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
        '.air-title{font-size:15px;font-weight:600;line-height:20px;letter-spacing:-.01em;white-space:nowrap}',
        '.air-header-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.air-header-spacer{flex:1 1 auto;min-width:8px}',
        '.air-model{flex:0 1 auto;display:inline-flex;align-items:center;gap:6px;max-width:46%;min-width:0;height:24px;padding:0 10px;border:0;border-radius:999px;background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:400;line-height:16px;white-space:nowrap}',
        '.air-model-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.air-model-text{min-width:0;overflow:hidden;text-overflow:ellipsis}',
        '.air-model[data-state=\'ready\'] .air-model-dot{background:var(--dsw-alias-state-success-primary)}',
        '.air-model[data-state=\'error\']{color:var(--air-error-text);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
        '.air-model[data-state=\'error\'] .air-model-dot{background:var(--dsw-alias-state-error-primary)}',
        /* ---- 双栏骨架：右栏一层 panel 底 + 0.5px 分隔 + 可见拖拽条 ---- */
        '.air-body{flex:1 1 auto;display:flex;min-width:0;min-height:0}',
        '.air-pane-switch{display:none}',
        '.air-left{container:air-reader-column / inline-size;flex:0 0 var(--air-split,68%);display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}',
        '.air-right{container:air-answer/inline-size;flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--air-panel-bg)}',
        '.air-splitter{position:relative;flex:0 0 8px;min-width:8px;cursor:col-resize;background:transparent;touch-action:none;border-radius:999px}',
        '.air-splitter::before{content:\'\';position:absolute;top:16px;bottom:16px;left:50%;width:1px;transform:translateX(-50%);border-radius:999px;background:var(--air-line-strong);transition:background-color var(--air-dur) var(--air-ease)}',
        '.air-splitter:hover::before,.air-splitter[data-dragging=\'true\']::before,.air-splitter:focus-visible::before{width:2px;background:var(--dsw-alias-brand-primary)}',
        '.air-splitter:focus-visible{outline:none;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}',
        '.air-root[data-dragging=\'true\']{cursor:col-resize}',
        '.air-root[data-dragging=\'true\'] .air-reader,.air-root[data-dragging=\'true\'] .air-thread{user-select:none}',
        /* ---- 左工具条：52px（与右栏 header 对齐）+ 材质 + 发丝线 ---- */
        '.air-urlbar{position:relative;z-index:5;flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;align-content:center;gap:8px;min-height:58px;padding:12px 16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:.5px solid var(--air-line)}',
        '.air-home-btn{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
        '.air-translate-btn{flex:none}',
        '.air-translate-btn.air-translate-done{color:var(--air-business-text)}',
        '.air-translation-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:9px 12px;border:.5px solid var(--air-line);border-radius:10px;background:var(--air-muted-bg);font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.air-translation-title{display:inline-flex;align-items:center;gap:5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.air-translation-title>svg{color:var(--dsw-alias-brand-primary)}',
        '.air-translation-badge{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
        '.air-translation-status{display:inline-flex;align-items:center;gap:6px;margin-left:auto;color:var(--dsw-alias-label-secondary)}',
        '.air-translation-body{display:block}',
        '.air-translation-error{margin:0 0 16px;padding:12px 14px;border-radius:10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
        '.air-translation-error-text{margin:0 0 10px;color:var(--air-error-text);font-size:13px;line-height:20px}',
        '.air-translation-loading{margin:32px auto}',
        '.air-translation-prose{position:relative}',
        '.air-home-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
        '.air-home-label{white-space:nowrap}',
        '.air-field{flex:1 1 200px;min-width:0;height:36px;padding:0 12px;border:.5px solid var(--air-line);border-radius:10px;background:var(--air-card-bg);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color var(--air-dur) var(--air-ease),box-shadow var(--air-dur) var(--air-ease),background-color var(--air-dur) var(--air-ease)}',
        '.air-field::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
        '.air-field:hover{border-color:var(--air-line-strong)}',
        '.air-root :is(.air-field,.air-paste-body,.air-sel-ask-input):is(:focus,:focus-visible){border-color:var(--air-field-focus);box-shadow:var(--air-field-ring);outline:none;outline-offset:0}',
        '.air-field:disabled{opacity:.5}',
        /* ---- 按钮：胶囊 / 圆角 10，仅过渡 transform/背景/边框/颜色 ---- */
        '.air-btn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;height:auto;padding:7px 12px;border:.5px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),border-color var(--air-dur) var(--air-ease),color var(--air-dur) var(--air-ease),transform var(--air-dur-fast) var(--air-ease)}',
        '.air-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.air-btn:active:not(:disabled){transform:scale(.98)}',
        '.air-btn:disabled{opacity:.45;cursor:default}',
        '.air-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
        '.air-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.05)}',
        '.air-btn-primary::after{content:\'\';position:absolute;left:0;right:0;top:50%;height:44px;transform:translateY(-50%)}',
        '.air-btn-ghost{height:30px;padding:0 12px;border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
        '.air-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-btn-secondary{height:32px;padding:0 14px;border-color:var(--air-line);background:var(--air-card-bg);color:var(--dsw-alias-label-primary)}',
        '.air-btn-secondary:hover:not(:disabled){background:var(--air-muted-bg);border-color:var(--air-line-strong)}',
        '.air-btn-sm{min-height:32px;padding:6px 10px;font-size:12px}',
        '.air-file-btn{width:30px;height:30px;padding:0;border-radius:50%;color:var(--dsw-alias-label-secondary)}',
        '.air-file-btn::after{content:\'\';position:absolute;inset:-5px;border-radius:50%}',
        '.air-file-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-file-input{display:none}',
        '.air-linkbtn{position:relative;padding:1px 2px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12.5px;font-weight:500;line-height:18px;cursor:pointer;transition:opacity var(--air-dur) var(--air-ease)}',
        '.air-linkbtn::after{content:\'\';position:absolute;inset:-6px;border-radius:6px}',
        '.air-linkbtn:hover:not(:disabled){opacity:.7}',
        '.air-linkbtn:disabled{opacity:.4;cursor:default}',
        /* ---- 阅读显示分段控件（Aa / 版心）：一个容器两段，段间发丝线 ---- */
        '.air-seg{display:inline-flex;align-items:center;flex:none;height:32px;padding:2px;border:.5px solid var(--air-line);border-radius:999px;background:var(--air-muted-bg)}',
        '.air-seg-item{position:relative;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),color var(--air-dur) var(--air-ease),transform var(--air-dur-fast) var(--air-ease)}',
        '.air-seg-item+.air-seg-item::before{content:\'\';position:absolute;left:-1px;top:7px;bottom:7px;width:.5px;background:var(--air-line)}',
        '.air-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-seg-item:active{transform:scale(.98)}',
        '.air-seg-glyph{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:0}',
        '.air-seg-value{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:400}',
        '.air-seg-font .air-seg-glyph{letter-spacing:.01em}',
        '.air-seg-width .air-seg-glyph{font-weight:500}',
        /* ---- 错误条 / 状态 ---- */
        '.air-errorbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent);color:var(--air-error-text);font-size:12px;line-height:18px}',
        '.air-errorbar-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
        '.air-errorbar .air-linkbtn{color:var(--air-error-text)}',
        '.air-errorbar-close{flex:none;color:var(--air-error-text)}',
        '.air-notice{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:.5px solid var(--air-line);background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-notice-text{min-width:0;overflow-wrap:anywhere}',
        '.air-drop-overlay{position:absolute;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:16px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);pointer-events:none}',
        '.air-drop-frame{position:absolute;inset:8px;border:2px dashed var(--dsw-alias-brand-primary);border-radius:16px;opacity:.8}',
        '.air-drop-card{--dsw-elevation-stroke-color:var(--air-line);position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:440px;padding:24px 28px;border:.5px solid var(--air-line);border-radius:16px;background:var(--air-card-bg);box-shadow:var(--dsw-elevation-prominent);text-align:center}',
        '.air-drop-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
        '.air-drop-title{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
        '.air-drop-hint{margin:0;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.air-loading{display:flex;align-items:center;justify-content:center;gap:8px;max-width:100%;box-sizing:border-box;padding:64px 24px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:20px}',
        '.air-loading-label{min-width:0;overflow-wrap:anywhere}',
        '.air-loading-dots{display:inline-flex;flex:none;align-items:center;justify-content:center;gap:3px;width:18px;height:16px;color:inherit}',
        '.air-loading-dot{display:block;flex:none;width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.28;animation:air-dot-pulse 1.4s ease-in-out infinite}',
        '.air-loading-dot:nth-child(2){animation-delay:.16s}.air-loading-dot:nth-child(3){animation-delay:.32s}',
        '.air-loading-dots-sm{gap:2.5px;width:14px;height:12px}.air-loading-dots-sm .air-loading-dot{width:3px;height:3px}',
        '@keyframes air-dot-pulse{0%,60%,100%{opacity:.28}30%{opacity:.88}}',
        /* ---- 左栏阅读区 ---- */
        '.air-reader{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 var(--air-gutter,clamp(20px,4vw,40px)) 72px;user-select:text;scrollbar-width:thin;scrollbar-color:var(--air-line) transparent}',
        '.air-reader:focus{outline:none}',
        '.air-reader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
        '.air-reader-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding-top:16px;padding-bottom:48px}',
        '.air-reader-inner{position:relative;max-width:var(--air-measure,700px);margin:0 auto;padding:28px 0 0}',
        '.air-progress{position:sticky;top:0;left:0;z-index:3;width:100%;height:2px;margin:0;background:transparent;pointer-events:none}',
        '.air-progress-bar{display:block;width:100%;height:2px;background:var(--dsw-alias-brand-primary);transform:scaleX(0);transform-origin:0 50%;will-change:transform}',
        '@supports (animation-timeline: scroll()){.air-progress-bar{animation:air-progress-grow linear both;animation-timeline:scroll(nearest)}}',
        '@keyframes air-progress-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
        '.air-reader::-webkit-scrollbar,.air-thread::-webkit-scrollbar,.air-paste-body::-webkit-scrollbar{width:10px;height:10px}',
        '.air-reader::-webkit-scrollbar-thumb,.air-thread::-webkit-scrollbar-thumb,.air-paste-body::-webkit-scrollbar-thumb{background:var(--air-line);background-clip:content-box;border:3px solid transparent;border-radius:999px}',
        '.air-reader::-webkit-scrollbar-thumb:hover,.air-thread::-webkit-scrollbar-thumb:hover,.air-paste-body::-webkit-scrollbar-thumb:hover{background:var(--air-line-strong);background-clip:content-box}',
        /* ---- 空状态（内容优先，居中对齐两栏）---- */
        '.air-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}',
        '.air-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:8px;border:.5px solid var(--air-line);border-radius:12px;background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary)}',
        '.air-empty-title{margin:0;font-size:15px;font-weight:600;line-height:22px;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}',
        '.air-empty-hint{max-width:380px;margin:0;font-size:13px;line-height:1.8;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.air-empty-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;margin-top:10px}',
        '.air-empty-shortcut{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        /* ---- 文章头 ---- */
        '.air-edit-toolbar{position:sticky;top:8px;z-index:6;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px;margin:0 0 20px;border:1px solid var(--air-line-strong);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
        '.air-edit-intro{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.air-edit-intro strong{font-size:14px;color:var(--dsw-alias-label-primary)}',
        '.air-edit-controls{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;flex:1 1 auto}',
        '.air-edit-count{font-size:12px;color:var(--dsw-alias-label-secondary);margin-right:auto}',
        '.air-edit-error{flex-basis:100%;margin:0;color:var(--air-error-text);font-size:13px;line-height:1.5}',
        '.air-edit-block{position:relative;margin:16px 0;padding:32px 8px 8px;border:1px dashed var(--air-line-strong);border-radius:8px;min-width:0}',
        '.air-edit-block:focus-within{border-style:solid;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary)}',
        '.air-edit-remove{position:absolute;right:6px;top:3px;display:flex;align-items:center;gap:4px;min-height:28px;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}',
        '.air-edit-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-edit-remove:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
        '.air-edit-input{display:block;box-sizing:border-box;width:100%;min-height:36px;padding:4px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;line-height:inherit;resize:vertical;overflow:hidden;outline:none}',
        '.air-root .air-edit-input:focus-visible{outline:none;box-shadow:none}',
        '.air-edit-block[data-kind=heading] .air-edit-input{font-size:1.2em;font-weight:600}',
        '.air-edit-block[data-kind=code] .air-edit-input{font-family:ui-monospace,monospace;font-size:.85em}',
        '.air-edit-block .air-img-wrap{margin:0}',
        '.air-edit-placeholder{margin:4px 0!important;color:var(--dsw-alias-label-secondary);font-size:13px}',
        '.air-edit-block.air-edit-removed{border-style:solid;opacity:.85}',
        '.air-edit-image-unavailable{min-height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}',
        '.air-edit-table{max-width:100%;overflow:auto}',
        '.air-edit-table-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(120px,1fr);min-width:100%;width:max-content;border-bottom:1px solid var(--air-line)}',
        '.air-edit-table .air-edit-input{border-right:1px solid var(--air-line);font-size:.9em}',
        '@media(pointer:coarse){.air-edit-remove{min-height:40px}.air-edit-block{padding-top:44px}}',
        '.air-article-head{margin:0 0 24px;padding-bottom:20px;border-bottom:.5px solid var(--air-line)}',
        '.air-article-title{margin:0 0 12px;font-size:24px;font-weight:600;line-height:1.3;letter-spacing:-.02em;color:var(--dsw-alias-label-primary)}',
        '.air-article-link{color:var(--air-business-text);text-decoration:underline;text-underline-offset:.15em;overflow-wrap:anywhere}',
        '.air-article-headrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
        '.air-article-headrow .air-article-meta{flex:1 1 auto;min-width:0}',
        '.air-article-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-article-meta a{color:var(--dsw-alias-label-secondary);text-decoration:none;border-bottom:.5px solid var(--air-line-strong);transition:color var(--air-dur) var(--air-ease),border-color var(--air-dur) var(--air-ease)}',
        '.air-article-meta a:hover{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-tertiary)}',
        '.air-meta-dot{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.air-tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap}',
        '.air-tag-warn{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary)}',
        '.air-file-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-weight:500}',
        '.air-tag-file{background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary)}',
        '.air-article-actions{display:inline-flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;flex:none;max-width:100%;min-width:0;margin-left:auto}',
        /* ---- 正文：17px/1.8/-0.01em，段距 1em，标题负字距 ---- */
        '.air-prose{font-family:var(--air-font-ui);font-size:15px;line-height:1.8;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);text-align:left;font-kerning:normal}',
        '.air-prose>:first-child{margin-top:0}',
        '.air-p{margin:0 0 1em}',
        '.air-h{font-weight:600;line-height:1.3;letter-spacing:-.015em;color:var(--dsw-alias-label-primary);margin:0}',
        '.air-h1{font-size:22px;line-height:1.3;margin:2em 0 .5em}',
        '.air-h2{font-size:18px;line-height:1.35;margin:2em 0 .5em}',
        '.air-h3{font-size:16px;line-height:1.4;margin:2em 0 .5em;letter-spacing:-.01em}',
        '.air-li{display:flex;align-items:baseline;gap:.5em;margin:0 0 8px;padding-left:.1em}',
        '.air-li-marker{flex:0 0 1.5em;width:1.5em;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;line-height:inherit}',
        '.air-li-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
        '.air-quote{margin:1.2em 0;padding:.15em 0 .15em .9em;border-left:2px solid var(--air-line-strong);border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:1em;line-height:1.75;overflow-wrap:anywhere}',
        '.air-pre{margin:20px 0;padding:16px;overflow-x:auto;border:.5px solid var(--air-line);border-radius:12px;background:var(--air-muted-bg);color:var(--dsw-alias-label-primary);font-family:var(--air-font-mono);font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.air-img-wrap{display:flex;flex-direction:column;align-items:center;gap:.6em;margin:1.6em 0}',
        '.air-img-link{display:block;max-width:100%;text-decoration:none;border-radius:14px;overflow:hidden}',
        '.air-img{display:block;max-width:100%;max-height:78vh;height:auto;object-fit:contain;border-radius:14px;background:var(--air-muted-bg);transition:transform var(--air-dur-slow) var(--air-ease)}',
        '.air-img-link:hover .air-img{transform:scale(1.005)}',
        '.air-img-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
        /* 图注用继承字号适配阅读档位；这些比例与间距是本项目的排版选择。 */
        '.air-img-cap{align-self:stretch;min-width:0;color:var(--dsw-alias-label-secondary);font-size:.86em;line-height:1.55;letter-spacing:0;text-align:left;overflow-wrap:anywhere}',
        '.air-img-cap-line{margin:0}',
        '.air-img-cap-line+.air-img-cap-line{margin-top:.16em}',
        '.air-img-cap-line+.air-img-credit{margin-top:.4em}',
        '@media (prefers-contrast:more){.air-quote{border-left-color:var(--dsw-alias-label-secondary)}}',
        '@media (forced-colors:active){.air-quote{border-left-color:CanvasText}}',
        '.air-hr{height:0;margin:36px 0;border:0;border-top:.5px solid var(--air-line)}',
        '.air-table-wrap{margin:22px 0;overflow-x:auto;border:.5px solid var(--air-line);border-radius:12px;background:var(--dsw-alias-bg-base);-webkit-overflow-scrolling:touch}',
        '.air-table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
        '.air-table th,.air-table td{padding:8px 12px;text-align:left;vertical-align:top;border-bottom:.5px solid var(--air-line);white-space:nowrap}',
        '.air-table thead th{background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500}',
        '.air-table tbody tr:last-child td{border-bottom:0}',
        '.air-table-wrap-cells :is(th,td){min-width:7em;white-space:normal;overflow-wrap:anywhere}',
        ':where(.air-md,.air-kb-prose,.air-translation-body) .air-table-wrap{max-width:100%;margin:16px 0;scrollbar-width:thin;scrollbar-color:var(--air-line-strong) transparent}',
        ':where(.air-md,.air-kb-prose,.air-translation-body) .air-table{font-size:.875em}',
        ':where(.air-md,.air-kb-prose,.air-translation-body) .air-table :is(th,td){min-width:7em;white-space:normal;overflow-wrap:anywhere;text-wrap:wrap}',
        ':where(.air-md,.air-kb-prose,.air-translation-body) .air-table thead th{font-size:inherit;font-weight:600}',
        /* ---- 粘贴正文模式 ---- */
        '.air-paste{flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-height:0;padding:16px}',
        '.air-paste-body{flex:1 1 auto;width:100%;min-height:120px;padding:14px 16px;resize:none;border:.5px solid var(--air-line);border-radius:14px;background:var(--air-card-bg);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;line-height:1.8;outline:none;transition:border-color var(--air-dur) var(--air-ease),box-shadow var(--air-dur) var(--air-ease)}',
        '.air-paste-body:hover{border-color:var(--air-line-strong)}',
        '.air-paste-body:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}',
        '.air-paste-body::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
        '.air-paste-hint{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        /* ---- 右栏顶部：52px 标题行 + 独立换行 chips 行（不再裁切）---- */
        '.air-righttop{flex:0 0 auto;display:flex;flex-direction:column;padding:0 0 12px;border-bottom:.5px solid var(--air-line);background:var(--air-panel-bg)}',
        '.air-righthead{display:flex;align-items:center;gap:8px;height:52px;padding:0 16px;overflow:visible}',
        '.air-right-spacer{flex:1 1 auto;min-width:8px}',
        '.air-right-title{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;white-space:nowrap}',
        '.air-right-title-icon{display:inline-flex;color:var(--dsw-alias-brand-primary)}',
        '.air-quickrow{display:flex;align-items:center;padding:0 16px}',
        '.air-quickbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1 1 auto;min-width:0}',
        '.air-chip{flex:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border:.5px solid var(--air-line);border-radius:999px;background:var(--air-card-bg);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),border-color var(--air-dur) var(--air-ease),color var(--air-dur) var(--air-ease),opacity var(--air-dur) var(--air-ease)}',
        '.air-chip:hover:not(:disabled){background:var(--air-muted-bg);border-color:var(--air-line-strong);color:var(--dsw-alias-label-primary)}',
        '.air-chip:disabled{opacity:.45;cursor:default}',
        // Quick actions share one quiet surface; stateful source toggles retain their own appearance.
        '.air-quickbar .air-chip{height:30px;padding:0 10px;border-color:transparent;border-radius:8px;background:var(--air-muted-bg);font-size:12px}',
        '.air-quickbar .air-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--air-line);color:var(--dsw-alias-label-primary)}',
        '.air-clear{flex:none;margin-left:0;color:var(--dsw-alias-label-secondary)}',
        /* ---- 知识库开关 chip：胶囊 + 状态点 ---- */
        '.air-kb-chip{height:28px;border-color:var(--air-line);background:var(--air-card-bg);color:var(--dsw-alias-label-secondary)}',
        '.air-kb-chip[data-on=\'true\']{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--air-card-bg));color:var(--dsw-alias-label-primary)}',
        '.air-kb-chip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.air-kb-chip[data-on=\'true\'] .air-kb-chip-dot{background:var(--dsw-alias-brand-primary)}',
        '.air-kb-chip:disabled{opacity:.4}',
        /* ---- 联网开关 chip：业务色区分于知识库（CONTRACT §14.4） ---- */
        '.air-web-chip{height:28px;border-color:var(--air-line);background:var(--air-card-bg);color:var(--dsw-alias-label-secondary)}',
        '.air-web-chip[data-on=\'true\']{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--air-card-bg));color:var(--dsw-alias-label-primary)}',
        '.air-web-chip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.air-web-chip[data-on=\'true\'] .air-web-chip-dot{background:var(--dsw-alias-state-business-primary)}',
        '.air-web-chip:disabled{opacity:.4}',
        /* ---- 联网参考：消息下方的可点击来源 chips ---- */
        '.air-web-refs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-web-refs-label{flex:none;color:var(--dsw-alias-label-secondary)}',
        '.air-web-ref{height:24px;padding:0 9px;font-size:11.5px;line-height:16px;max-width:230px;overflow:hidden;text-overflow:ellipsis;text-decoration:none;color:var(--dsw-alias-label-secondary)}',
        '.air-web-ref:hover{border-color:var(--air-line-strong);background:var(--air-muted-bg);color:var(--dsw-alias-label-primary);text-decoration:none}',
        '.air-web-note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        /* ---- 相关知识：默认收起，单列阅读。以下 CSS 尺寸是项目选择。 ---- */
        '.air-kb-related{flex:none;display:flex;flex-direction:column;min-width:0;margin:12px 16px 0;padding:6px 10px;border:.5px solid var(--air-line);border-radius:12px;background:var(--air-card-bg)}',
        '.air-kb-related-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}',
        '.air-kb-related-toggle{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;min-height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;text-align:left;cursor:pointer}',
        '.air-kb-related-toggle:hover{color:var(--dsw-alias-label-primary)}',
        '.air-kb-related-title{min-width:0;line-height:1.5;overflow-wrap:anywhere}',
        '.air-kb-related-list{display:flex;flex-direction:column;gap:2px;min-width:0;max-height:min(32vh,280px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;margin:6px 0 0;padding:2px;list-style:none;border-top:.5px solid var(--air-line)}',
        '.air-kb-related-list>li{min-width:0}',
        '.air-kb-related-item{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;min-height:44px;padding:8px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
        '.air-kb-related-item:hover{background:var(--air-muted-bg)}',
        '.air-kb-related-item-head{display:flex;align-items:baseline;gap:8px;min-width:0;width:100%}',
        '.air-kb-related-type{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}',
        '.air-kb-related-name{min-width:0;font-size:12px;font-weight:500;line-height:1.5;white-space:normal;overflow-wrap:anywhere}',
        '.air-kb-related-snippet{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.air-kb-open{flex:none;min-height:32px;font-size:12px}',
        '@media (pointer:coarse){.air-kb-related-toggle,.air-kb-open{min-height:44px}}',
        '.air-iconbtn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),color var(--air-dur) var(--air-ease)}',
        '.air-iconbtn::after{content:\'\';position:absolute;inset:-4px;border-radius:50%}',
        '.air-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-iconbtn:disabled{opacity:.4;cursor:default}',
        /* ---- 清空撤销条 ---- */
        '.air-undo{flex:none;display:flex;align-items:center;gap:8px;margin:10px 16px 0;padding:8px 12px;border:.5px solid var(--air-line);border-radius:10px;background:var(--air-card-bg);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-undo-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
        /* ---- 消息：iMessage 风格 user 气泡 + 无气泡 assistant ---- */
        '.air-thread{flex:1 1 auto;display:flex;flex-direction:column;gap:28px;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 20px 12px;scrollbar-width:thin;scrollbar-color:var(--air-line) transparent}',
        '.air-thread:focus-visible,.air-table-wrap:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
        '.air-thread-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;margin:auto;padding:40px 24px;text-align:center;color:var(--dsw-alias-label-secondary)}',
        '.air-msg{display:flex;flex-direction:column;min-width:0}',
        '.air-msg-user{align-self:flex-end;max-width:88%}',
        '.air-msg-bubble{padding:10px 14px;border:0;border-radius:18px;border-bottom-right-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:14.5px;line-height:1.65;overflow-wrap:anywhere}',
        '.air-user-text{white-space:pre-wrap}',
        '.air-user-quote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
        '.air-user-text+.air-user-quote,.air-user-quote+.air-user-text{margin-top:8px}',
        '.air-msg-assistant{align-self:stretch;max-width:100%}',
        '.air-assistant-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:16px}',
        '.air-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}',
        '.air-assistant-label{letter-spacing:-.005em}',
        '.air-md{font-family:var(--air-font-ui);font-size:15px;line-height:1.8;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;user-select:text}',
        '.air-md>:first-child{margin-top:0}',
        '.air-md-p{margin:0 0 10px}',
        '.air-md-h{margin:18px 0 8px;font-weight:600;line-height:1.35;letter-spacing:-.01em}',
        '.air-md-h1{font-size:17px}',
        '.air-md-h2{font-size:16px}',
        '.air-md-h3{font-size:15px}',
        '.air-md-list{margin:0 0 10px;padding-left:22px}',
        '.air-md-list li{margin:4px 0}',
        '.air-md-quote{margin:0 0 10px;padding:8px 12px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);border-radius:8px;background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary)}',
        '.air-md-pre{margin:0 0 10px;padding:12px 14px;overflow-x:auto;border:.5px solid var(--air-line);border-radius:10px;background:var(--air-muted-bg);font-family:var(--air-font-mono)}',
        '.air-md-pre code{padding:0;border:0;background:none;font-size:12px;line-height:1.7}',
        '.air-md-code{padding:1.5px 5px;border-radius:6px;background:var(--air-muted-bg);font-family:var(--air-font-mono);font-size:12.5px}',
        '.air-md a{color:var(--dsw-alias-brand-primary);text-decoration:none;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);transition:color var(--air-dur) var(--air-ease)}',
        '.air-md a:hover{color:var(--dsw-alias-label-secondary)}',
        '.air-md-hr{height:0;margin:16px 0;border:0;border-top:.5px solid var(--air-line)}',
        '.air-md strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
        // AI answer typography: project choices for this web panel, not native Apple point sizes.
        // Scope to assistant messages so source articles, translations and knowledge pages keep their formatting.
        '.air-msg-assistant .air-md{max-width:68ch;font-size:16px;line-height:1.75;letter-spacing:normal;font-kerning:normal;text-wrap:pretty}',
        '.air-msg-assistant .air-md-p{margin:0 0 14px}',
        '.air-msg-assistant .air-md-h{margin:26px 0 10px;line-height:1.4;letter-spacing:normal;text-wrap:pretty}',
        '.air-msg-assistant .air-md-h1{font-size:20px}',
        '.air-msg-assistant .air-md-h2{font-size:18px}',
        '.air-msg-assistant .air-md-h3{font-size:16px}',
        '.air-msg-assistant .air-md-list{margin:0 0 14px;padding-inline-start:1.5em}',
        '.air-msg-assistant .air-md-list li{margin:6px 0;padding-inline-start:2px}',
        '.air-msg-assistant .air-md-list li::marker{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.air-msg-assistant .air-md-quote{margin:14px 0;padding:2px 0 2px 14px;border-left:2px solid var(--air-line-strong);border-radius:0;background:transparent;color:var(--dsw-alias-label-primary)}',
        '.air-msg-assistant .air-md-quote>:first-child{margin-top:0}',
        '.air-msg-assistant .air-md-quote>:last-child{margin-bottom:0}',
        '.air-msg-assistant .air-md-quote .air-md-quote{margin:10px 0;padding-inline-start:12px}',
        '.air-msg-assistant .air-md-pre{max-width:100%;margin:16px 0;padding:12px 14px;border:1px solid var(--air-line);border-radius:10px;font-size:.8125em;line-height:1.65;letter-spacing:normal;text-wrap:nowrap}',
        '.air-msg-assistant .air-md-pre code{font:inherit;color:inherit}',
        '.air-msg-assistant .air-md-code{padding:2px 5px;border-radius:4px;font-size:.875em;letter-spacing:normal}',
        '.air-msg-assistant .air-md a{border-bottom:0;color:var(--air-business-text);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--air-business-text) 40%,transparent);text-decoration-thickness:1px;text-underline-offset:3px}',
        '.air-msg-assistant .air-md a:hover{text-decoration-color:currentColor}',
        '.air-msg-assistant .air-md-hr{margin:24px 0}',
        '.air-msg-assistant .air-md>:first-child{margin-top:0}',
        '.air-msg-assistant .air-md>:last-child{margin-bottom:0}',
        '@container air-answer (max-width:380px){.air-righthead{height:auto;min-height:52px;flex-wrap:wrap;padding:12px 16px;row-gap:10px}.air-right-title{flex-basis:100%}.air-right-spacer{display:none}.air-thread{padding:18px 16px 12px}}',
        '@media (prefers-contrast:more){.air-msg-assistant .air-md-quote{border-left-color:var(--dsw-alias-label-secondary)}.air-msg-assistant .air-md a{text-decoration-color:currentColor}}',
        '@media (forced-colors:active){.air-msg-assistant .air-md-quote{border-left-color:CanvasText}.air-msg-assistant .air-md a{color:LinkText;text-decoration-color:LinkText}}',
        '.air-cursor{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:text-bottom;background:var(--dsw-alias-brand-primary);animation:air-blink 1.2s steps(1,end) infinite}',
        '@keyframes air-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}',
        '@keyframes air-save-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
        '.air-msg-status{display:flex;align-items:center;gap:8px;margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-msg-error{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:10px;padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}',
        '.air-msg-error-text{margin:0;color:var(--air-error-text);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}',
        /* ---- 参考 chips ---- */
        '.air-kb-refs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;padding-top:8px;border-top:.5px dashed var(--air-line)}',
        '.air-kb-refs-label{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
        '.air-ref-chip{height:26px;padding:0 10px;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
        /* ---- Composer：输入区占满宽度，操作放在单独一行 ---- */
        '.air-composer{flex:0 0 auto;padding:10px 16px 14px;background:transparent}',
        '.air-composer-box{display:grid;gap:6px;min-width:0;margin:0;padding:8px 10px 10px;border:1px solid var(--air-line);border-radius:12px;background:var(--air-card-bg);transition:border-color var(--air-dur) var(--air-ease),box-shadow var(--air-dur) var(--air-ease)}',
        '.air-root .air-composer-box:focus-within{border-color:var(--air-field-focus);box-shadow:var(--air-field-ring)}',
        '.air-composer-input{display:block;width:100%;min-width:0;min-height:2.4em;max-height:clamp(3em,21dvh,8em);padding:6px 4px;border:0;outline:none;resize:none;field-sizing:content;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--air-line-strong) transparent;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:.875rem;line-height:1.55}',
        '.air-root .air-composer-input:is(:focus,:focus-visible){border:0;outline:none;outline-offset:0;box-shadow:none}',
        '.air-composer-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
        '.air-composer-actions{display:flex;align-items:center;flex-wrap:wrap;gap:5px 10px;padding-inline:4px 0}',
        '.air-composer-keys{min-width:0;color:var(--dsw-alias-label-secondary);font-size:.6875rem;line-height:1.45}',
        '.air-send{flex:none;min-height:32px;min-width:60px;margin-left:auto;padding:5px 12px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:.8125rem;font-weight:550;line-height:1.35;cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),transform var(--air-dur-fast) var(--air-ease)}',
        '.air-send:hover:not(:disabled){filter:brightness(1.05)}',
        '.air-send:active:not(:disabled){transform:scale(.98)}',
        '.air-send:disabled{background:var(--air-muted-bg);color:var(--dsw-alias-label-secondary);cursor:default}',
        '.air-send-stop{border:.5px solid var(--air-line-strong);background:transparent;color:var(--dsw-alias-label-secondary)}',
        '.air-send-stop:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '@container air-answer (max-width:320px){.air-composer-keys{display:none}}',
        /* ---- 选中文字浮动按钮（唯一使用浮层阴影的元素）---- */
        // 摘抄卡片沿用现有浮层与语义色；高度上限是网页项目选择，保证窄窗可滚动。
        '.air-sel-ask{max-height:calc(100dvh - 16px);overflow-y:auto;overscroll-behavior:contain}',
        '.air-sel-ask-excerpt{flex:none;height:30px;padding:0 8px;font-size:12.5px}',
        '.air-excerpt-editor,.air-excerpt-fields{display:flex;flex-direction:column;gap:10px;min-width:0}',
        '.air-excerpt-back{align-self:flex-start;font-size:12px}',
        '.air-excerpt-preview{max-height:112px;overflow:auto;margin:0;padding:8px 10px;border-left:3px solid var(--air-line-strong);background:var(--air-muted-bg);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.65}',
        '.air-excerpt-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.air-excerpt-tags{display:flex;flex-wrap:wrap;gap:6px}',
        '.air-excerpt-tag{max-width:100%;padding:4px 10px;border:.5px solid var(--air-line);border-radius:999px;background:var(--air-card-bg);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;overflow-wrap:anywhere;cursor:pointer}',
        '.air-excerpt-tag[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--air-muted-bg);color:var(--dsw-alias-label-primary);font-weight:600}',
        '.air-excerpt-tag:disabled{opacity:.5;cursor:default}',
        '.air-excerpt-newtag{display:flex;align-items:center;gap:6px;min-width:0}',
        '.air-excerpt-newtag>input{width:0}',
        '.air-excerpt-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.air-excerpt-error{margin:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;line-height:18px;color:var(--air-error-text);overflow-wrap:anywhere}',
        '.air-excerpt-success{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:8px 0;font-size:13px}',
        '.air-excerpt-success>p{margin:0}',
        '.air-excerpt-footer{display:flex;justify-content:flex-end}',
        '.air-excerpts-view{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;min-width:0}',
        '.air-excerpts-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:.5px solid var(--air-line)}',
        '.air-excerpts-head>h2{flex:1 1 auto;margin:0;font-size:15px;line-height:22px;font-weight:600}',
        '.air-excerpts-info{display:flex;flex:none;flex-wrap:wrap;align-items:baseline;gap:8px;max-height:35vh;overflow-y:auto;padding:14px 20px;border-bottom:.5px solid var(--air-line)}',
        '.air-excerpts-info>.air-excerpt-tags,.air-excerpts-path{flex-basis:100%}',
        '.air-excerpts-path{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;user-select:text}',
        '.air-excerpts-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 20px 32px;user-select:text}',
        '.air-excerpts-notice{padding:12px 20px}',
        '.air-excerpts-status:empty{display:none}',
        '.air-excerpts-status{color:var(--dsw-alias-label-secondary);font-size:13px}',
        '.air-excerpt-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-inline-start:auto}',
        '.air-excerpt-delete{color:var(--air-error-text)}',
        '.air-excerpt-delete-hint{margin:8px 0 0;font-size:12px;line-height:1.6;color:var(--air-error-text)}',
        '.air-excerpt-entry{padding:20px 0;border-bottom:.5px solid var(--air-line)}',
        '.air-excerpt-entry-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.air-excerpt-entry-text{margin:10px 0;font-size:15px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
        '.air-excerpt-source{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.air-sel-ask{position:fixed;z-index:900;display:flex;flex-direction:column;gap:6px;width:400px;max-width:calc(100vw - 24px);padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);border-radius:14px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,transparent);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);color:var(--dsw-alias-label-primary);font:inherit;box-shadow:var(--air-shadow-overlay);transform:translateX(-50%);animation:air-sel-in var(--air-dur-fast) var(--air-ease) both}',
        '.air-sel-ask-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}',
        '.air-sel-ask-head>svg{flex:none;color:var(--dsw-alias-brand-primary)}',
        '.air-sel-ask-count{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.air-sel-ask-close{width:20px;height:20px;color:var(--dsw-alias-label-secondary)}',
        '.air-sel-ask-close::after{inset:-6px}',
        '.air-sel-ask-row{display:grid;min-width:0;gap:8px}',
        '.air-sel-ask-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}',
        '.air-sel-ask-translate{flex:none;height:30px;padding:0 10px;border-radius:999px;font-size:12.5px}',
        '.air-sel-ask-kb[aria-disabled=true]{opacity:.55;cursor:default}',
        '.air-sel-kb-status{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
        '.air-sel-kb-error{color:var(--air-error-text)}',
        '.air-sel-ask-input{min-width:0;width:100%;min-height:34px;padding:7px 10px;border:.5px solid var(--air-line);border-radius:8px;background:var(--air-card-bg);color:var(--dsw-alias-label-primary);font:inherit;font-size:.8125rem;line-height:1.5;outline:none;transition:border-color var(--air-dur) var(--air-ease),box-shadow var(--air-dur) var(--air-ease),background-color var(--air-dur) var(--air-ease)}',
        '.air-sel-ask-input:hover{border-color:var(--air-line-strong)}',
        '.air-sel-ask-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
        '@keyframes air-sel-in{from{opacity:0;transform:translate(-50%,0) scale(.96)}to{opacity:1;transform:translate(-50%,0) scale(1)}}',
        /* ---- 存入知识库 ---- */
        '.air-kb-ingest{height:30px;padding:0 12px;border:.5px solid var(--air-line);background:var(--air-card-bg);color:var(--dsw-alias-label-secondary);font-size:12px;border-radius:999px}',
        '.air-kb-ingest::after{content:\'\';position:absolute;inset:-7px;border-radius:999px}',
        '.air-kb-ingest:hover:not(:disabled){background:var(--air-muted-bg);color:var(--dsw-alias-label-primary)}',
        '.air-kb-ingest-busy,.air-kb-ingest-busy:disabled{opacity:1;color:var(--dsw-alias-label-secondary)}',
        '.air-kb-ingest-done,.air-kb-ingest-done:disabled{opacity:1;color:var(--dsw-alias-label-primary)}',
        '.air-kb-ingest-done svg{color:var(--dsw-alias-state-success-primary)}',
        '.air-kb-ingest-exists,.air-kb-ingest-exists:disabled{color:var(--dsw-alias-label-secondary)}',
        '.air-kb-error{display:flex;align-items:flex-start;gap:8px;margin:0 0 18px;padding:10px 12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent);color:var(--air-error-text);font-size:12px;line-height:18px}',
        '.air-kb-error-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}',
        /* ---- KB 页面预览：与文章视图一致的阅读排版 ---- */
        '.air-kb-page{min-height:100%}',
        '.air-kb-page-inner{display:flex;flex-direction:column;gap:16px}',
        '.air-kb-page-body{display:flex;flex-direction:column;gap:12px}',
        '.air-kb-back{color:var(--dsw-alias-label-secondary)}',
        '.air-kb-page-title{margin:0;font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-.02em;color:var(--dsw-alias-label-primary)}',
        '.air-kb-badges{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
        '.air-kb-type{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--air-business-text)}',
        '.air-kb-updated{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.air-kb-prose{font-family:var(--air-font-ui);font-size:15px;line-height:1.8;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);user-select:text}',
        '.air-kb-prose .air-md-p{margin:0 0 14px}',
        '.air-kb-prose .air-md-h1{font-size:20px}',
        '.air-kb-prose .air-md-h2{font-size:18px}',
        '.air-kb-prose .air-md-h3{font-size:16px}',
        /* ---- 保存到本地 / 本地文稿（CONTRACT §13.3） ---- */
        '.air-save-toggle{height:28px}',
        '.air-save-toggle[data-on=\'true\']{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--air-card-bg));color:var(--dsw-alias-label-primary)}',
        '.air-save-toggle-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.air-save-toggle[data-on=\'true\'] .air-save-toggle-dot{background:var(--dsw-alias-brand-primary)}',
        '.air-save-btn{color:var(--dsw-alias-label-secondary)}',
        '.air-save-busy,.air-save-busy:disabled{opacity:1;color:var(--dsw-alias-label-secondary)}',
        '.air-save-done,.air-save-done:disabled{opacity:1;color:var(--dsw-alias-label-secondary)}',
        '.air-save-done svg{color:var(--dsw-alias-state-success-primary)}',
        '.air-save-failed{color:var(--air-error-text)}',
        '.air-save-notice{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:10px 12px;border:.5px solid var(--air-line);border-radius:10px;background:var(--air-card-bg);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px;animation:air-save-in var(--air-dur) var(--air-ease)}',
        '.air-save-notice>svg{flex:none;color:var(--dsw-alias-state-success-primary)}',
        '.air-save-notice-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
        '.air-save-notice-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent);color:var(--air-error-text);margin-top:0}',
        '.air-save-notice-error>svg{display:none}',
        '.air-save-notice-close{width:24px;height:24px;color:inherit}',
        '.air-save-notice-close::after{inset:-6px}',
        /* 本地文稿视图 */
        '.air-library{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}',
        '.air-lib-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:.5px solid var(--air-line)}',
        '.air-lib-back{color:var(--dsw-alias-label-secondary)}',
        '.air-lib-title{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;white-space:nowrap}',
        '.air-lib-title svg{color:var(--dsw-alias-label-secondary)}',
        '.air-lib-count{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.air-lib-spacer{flex:1 1 auto;min-width:8px}',
        '.air-lib-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:14px 16px 48px;scrollbar-width:thin;scrollbar-color:var(--air-line) transparent}',
        '.air-lib-list{display:flex;flex-direction:column;gap:8px}',
        '.air-lib-item{display:flex;align-items:center;gap:16px;min-height:76px;padding:14px 16px;border:.5px solid var(--air-line);border-radius:12px;background:var(--air-card-bg);transition:border-color var(--air-dur) var(--air-ease),box-shadow var(--air-dur) var(--air-ease)}',
        '.air-lib-item:hover{border-color:var(--air-line-strong);box-shadow:0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
        '.air-lib-open{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;padding:0;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.air-lib-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
        '.air-lib-item-title{font-size:15px;font-weight:600;line-height:1.35;letter-spacing:-.01em;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.air-lib-item-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.air-lib-actions{flex:none;display:flex;align-items:center;gap:6px}',
        '.air-lib-delete{position:relative;padding:4px 8px;border:.5px solid transparent;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background-color var(--air-dur) var(--air-ease),border-color var(--air-dur) var(--air-ease),color var(--air-dur) var(--air-ease)}',
        '.air-lib-delete::after{content:\'\';position:absolute;inset:-6px;border-radius:10px}',
        '.air-lib-delete:hover:not(:disabled){color:var(--air-error-text);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
        '.air-lib-delete:disabled{opacity:.6;cursor:default}',
        '.air-lib-delete-confirm,.air-lib-delete-confirm:hover:not(:disabled){color:var(--air-error-text);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}',
        '.air-library-btn{position:relative;flex:none;width:30px;height:30px;padding:0;border-radius:50%;color:var(--dsw-alias-label-secondary)}',
        '.air-library-btn::after{content:\'\';position:absolute;inset:-5px;border-radius:50%}',
        '.air-library-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.air-library-btn[aria-expanded=\'true\']{color:var(--dsw-alias-brand-primary)}',
        '.air-lib-badge{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:9.5px;font-weight:600;line-height:14px;text-align:center;font-variant-numeric:tabular-nums}',
        '.air-lib-empty{min-height:100%;justify-content:center}',
        '.air-lib-empty .air-empty-hint{max-width:420px}',
        /* ---- 窄窗口与阅读栏 ---- */
        '@container air-reader-column (max-width:600px){.air-open-controls{flex-basis:100%}.air-toolbar-actions{justify-content:flex-end;width:100%}.air-home-label{display:none}.air-article-actions{gap:6px}}',
        '@media (max-width:640px){.air-article-title{font-size:24px}.air-right-title{font-size:13px}.air-righthead{gap:6px}.air-sel-ask{width:calc(100vw - 20px);max-width:calc(100vw - 20px)}}',
        // 沿用项目的 900 CSS px 容器断点，短窗内一次只呈现一个工作区。
        '@container air-panel (max-width:900px){',
        '.air-pane-switch{display:flex;flex:none;padding:7px 12px;border-bottom:1px solid var(--air-line);background:var(--dsw-alias-bg-base)}',
        '.air-pane-segment{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:min(280px,100%);gap:3px;padding:3px;border-radius:10px;background:var(--air-muted-bg)}',
        '.air-pane-segment button{min-width:0;min-height:32px;padding:5px 10px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-weight:500;overflow-wrap:anywhere;cursor:pointer}',
        '.air-pane-segment button[aria-pressed=true]{border-color:var(--air-line);background:var(--air-card-bg);color:var(--dsw-alias-label-primary);font-weight:600}',
        '.air-left,.air-right{flex:1 1 0}',
        '.air-root[data-pane="article"] .air-right,.air-root[data-pane="answer"] .air-left,.air-root[data-pane="answer"] .air-sel-ask,.air-splitter{display:none}',
        '.air-reader{padding:0 12px 40px}.air-reader-inner{padding-top:20px}',
        '.air-urlbar{padding:8px 12px}.air-header,.air-righthead,.air-quickrow{padding-inline:12px}',
        '.air-righttop{padding-bottom:8px}.air-kb-related{margin:8px 12px 0;padding:6px 8px}',
        '.air-thread{padding:14px 12px 8px}.air-thread-empty{padding:16px 12px;gap:4px}',
        '.air-thread-empty .air-empty-icon,.air-header-subtitle{display:none}',
        '.air-thread-empty .air-empty-hint{font-size:12px;line-height:1.6}',
        '.air-drop-card{padding:20px}.air-drop-frame{inset:6px}',
        '.air-composer{padding:8px 12px 12px}.air-undo{margin:8px 12px 0}',
        '}',
        // 项目选择：次要显示设置收进 disclosure；所有表面继续继承宿主语义色。
        '.air-open-controls{display:flex;align-items:center;gap:8px;flex:1 1 240px;min-width:0}',
        '.air-toolbar-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-width:0}',
        '.air-toolbar-actions .air-iconbtn{width:34px;height:34px;min-height:34px;border-radius:10px}',
        '.air-appearance{position:relative;flex:none}',
        '.air-appearance-trigger{list-style:none;min-width:34px;min-height:34px;padding:7px 9px;font-size:14px;font-weight:600}',
        '.air-appearance-trigger::-webkit-details-marker{display:none}',
        '.air-appearance[open] .air-appearance-trigger{background:var(--air-muted-bg)}',
        '.air-appearance-panel{position:absolute;z-index:80;right:0;top:calc(100% + 8px);display:flex;flex-direction:column;gap:12px;width:244px;max-width:calc(100vw - 32px);padding:16px;border:.5px solid var(--air-line);border-radius:12px;background:var(--air-card-bg);box-shadow:var(--air-shadow-overlay)}',
        '.air-appearance-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
        '.air-appearance-panel .air-seg{display:flex;align-items:stretch;flex-direction:column;height:auto;width:100%;padding:3px;gap:3px;border-radius:10px}',
        '.air-appearance-panel .air-seg-item{justify-content:space-between;width:100%;min-height:34px;height:auto;padding:8px 10px;border-radius:8px}',
        '.air-appearance-panel .air-seg-value{display:inline;color:var(--dsw-alias-label-primary)}',
        '@container air-reader-column (max-width:600px){.air-appearance{position:static}.air-appearance-panel{right:12px;max-width:calc(100% - 24px)}}',
        '.air-lib-open{min-height:44px}.air-lib-item-title{overflow-wrap:anywhere}.air-lib-item-meta{line-height:1.6}',
        '@media (forced-colors:active){.air-root :is(.air-field,.air-paste-body,.air-sel-ask-input):is(:focus,:focus-visible),.air-root .air-composer-box:focus-within{outline:2px solid Highlight;outline-offset:2px;box-shadow:none}}',
        '@container air-panel (max-width:640px){.air-header-subtitle{display:none}.air-model{max-width:42%}.air-article-title{font-size:22px}.air-reader{padding-bottom:24px}.air-righthead{flex-wrap:wrap;height:auto;min-height:48px;padding-top:8px;padding-bottom:8px}.air-lib-item{gap:8px;padding:12px}.air-appearance-panel{width:228px}}',
        '@media (pointer:coarse){.air-btn,.air-iconbtn,.air-seg-item,.air-send,.air-pane-segment button,.air-sel-ask-input{min-height:44px}.air-iconbtn{min-width:44px}.air-appearance-trigger{min-width:44px}}',
        '@media (prefers-reduced-transparency:reduce){.air-header,.air-urlbar{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none}}',
        /* ---- 尊重系统减少动态效果 ---- */
        '@media (prefers-reduced-motion:reduce){.air-root *,.air-root *::before,.air-root *::after{transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}.air-loading-dot{animation:none!important;opacity:.6}.air-cursor{animation:none;opacity:.7}.air-sel-ask{animation:none}}',
      ].join('')

      // ======================================================================
      // 插件装配：locale 字典 + main 面板 + 侧边栏入口
      // ======================================================================

      /**
       * Cordis 客户端插件入口。
       * @param {any} ctx 客户端 cordis 上下文（slots / locale 服务由 inject 保证就绪）。
       * @returns {void}
       */
      function apply(ctx) {
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'ai-reader: dictionaries')
        const t = ctx.locale.bind(NS)
        // 外部打开握手：AI 浏览器等插件通过 window 事件把当前页面递进来
        // （事件名 / detail 形状见 AI浏览器/CONTRACT.md §4.4；失败静默，不影响阅读器）
        ctx.effect(function () {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
            return function () {}
          }
          const onExternalOpen = function (event) {
            try {
              dispatchExternalOpen(event && event.detail)
            } catch (error) {
              // 外部握手异常不影响阅读器
            }
          }
          window.addEventListener('dsh-ai-reader:open', onExternalOpen)
          return function () {
            window.removeEventListener('dsh-ai-reader:open', onExternalOpen)
          }
        }, 'ai-reader: external open')
        /**
         * 打开知识库面板（KB 面板 id 稳定为 'kb'）。
         * KB 未安装 / 没有 layout 服务 / 面板不存在时静默失败，绝不影响阅读面板。
         * @returns {void}
         */
        function openKbPanel() {
          try {
            if (ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel(KB_PANEL_ID)
              return
            }
          } catch (error) {
            // KB 面板不存在时静默失败
          }
          try {
            if (ctx && typeof ctx.get === 'function') {
              const layout = ctx.get('layout')
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(KB_PANEL_ID)
            }
          } catch (error) {
            // KB 面板不存在时静默失败
          }
        }
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: function () { return { t: t, openKbPanel: openKbPanel } } },
            ReaderPanel,
          )
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: function () { return t('panel.label') } },
            ReaderIcon,
          )
        })
      }

      return { name: PANEL_ID, inject: ['slots', 'locale'], apply: apply }
    },
  })
} else {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[dsh-ai-reader] __ModuleLoader__ 不可用，client.js 未加载')
  }
}
