/**
 * dsh-knowledge-base — 浏览器半侧（client.js）
 * ============================================================================
 * 职责
 *   DSH Web GUI 内的「知识库」主面板（main key = kb）与左侧栏入口
 *   （sidebar.panellist id = kb，order = 21）。面板分五个 tab：
 *     知识库：概览（研究方向 / 统计 / 最近更新 / 图谱预览）与页面阅读（自写
 *             Markdown 渲染、[[双向链接]]、反向链接、来源素材）。
 *     素材：  素材库独立页（全宽列表 / 状态筛选 / 批量管理 / 添加素材 /
 *             重新编译）；左侧栏素材列表只做导航，管理动作统一进这一页。
 *     图谱：  交互式知识图谱（力导向布局 + 拖拽平移/滚轮缩放 + 类型/关系筛选 +
 *             标题搜索 + 选中详情与邻居聚焦；v0.6.0 重做）。
 *     问答：  POST /dsh-kb/ask（SSE 流式）+ 引用页面 chips。
 *     健康：  GET /dsh-kb/health-check，按类型分组的链接/页面问题。
 *   左栏承载素材入口与页面导航：上传文件（拖拽 + 多选）、消化链接、粘贴文本、
 *   任务进度轮询、搜索框、素材列表（仅导航，管理在「素材」tab）、实体/主题分组列表。
 *
 * 注册方式（普通副作用脚本，不能有顶层 import/export）
 *   window.__ModuleLoader__.load({ id:'dsh-knowledge-base', factory(require) {...} })
 *   factory 内只 require('react')，不依赖任何 Harness 客户端包；返回
 *   { name:'kb', inject:['slots','locale'], apply }。
 *
 * 健壮性约定
 *   - 所有网络请求统一走 api()，内部 try/catch，错误统一 { ok:false, error } 解析。
 *   - 主面板整体包 ErrorBoundary；任何组件异常都不会炸掉 slot。
 *   - 卸载 / 切换时 abort 进行中的请求与定时器；空闲时不轮询。
 *   - 不使用浏览器持久化存储；tab / 当前页面 / 列表数据放模块级 cache，切换后恢复。
 *   - 不注入 HTML 字符串：Markdown 渲染器返回 React 元素。
 *   - 样式只使用 --dsw-alias-* / --dsh-* 主题变量（图谱节点使用主题变量色板）。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-knowledge-base',

    /**
     * DSH 客户端插件 factory：注入 react 平台种子模块，组装组件，返回插件三件套。
     * @param {(id: string) => any} require 平台种子模块加载器（此处只用 'react'）。
     * @returns {{ name: string, inject: string[], apply: (ctx: any) => void }}
     */
    factory(require) {
      // ---- 平台种子模块（只允许 react） --------------------------------------
      const React = require('react')
      const { useState, useEffect, useRef, useCallback, useMemo, useContext } = React
      const h = React.createElement

      // ---- 恒定标识（与 CONTRACT.md 第 1 节一致） ---------------------------
      const NS = 'kb'
      const PANEL_ID = 'kb'
      const ORIGIN = '/dsh-kb'
      const DEFAULT_ROOT_LABEL = '~/Documents/DSH工具数据/知识库'
      const DEFAULT_MAX_FILE_BYTES = 30 * 1024 * 1024
      const MAX_GRAPH_NODES = 300
      const MAX_PURPOSE_CHARS = 4000
      const JOB_POLL_MS = 900
      const SEARCH_DEBOUNCE_MS = 250
      const TAB_IDS = ['library', 'books', 'sources', 'conversations', 'graph', 'ask', 'health']

      // ---- 上传可接受扩展名（仅用于 input accept 与提示；真正解析由 Host 决定） --
      const ACCEPT_EXTENSIONS = [
        '.pdf', '.docx', '.pptx', '.xlsx', '.epub', '.odt', '.ods', '.odp',
        '.rtf', '.html', '.htm', '.md', '.markdown', '.txt', '.csv', '.tsv',
        '.json', '.yaml', '.yml', '.xml', '.log', '.js', '.ts', '.py', '.java',
        '.go', '.rs', '.c', '.h', '.cpp', '.css', '.sql', '.sh',
      ].join(',')

      // ---- 页面类型 / 素材类型 / 图谱色板（端色只用主题变量） ------------------
      const PAGE_TYPE_KEYS = {
        source: 'page.type.source',
        sources: 'page.type.source',
        entity: 'page.type.entity',
        entities: 'page.type.entity',
        topic: 'page.type.topic',
        topics: 'page.type.topic',
        synthesis: 'page.type.synthesis',
        syntheses: 'page.type.synthesis',
        excerpt: 'page.type.excerpt',
        original: 'page.type.original',
        chapter: 'page.type.chapter',
        evidence: 'page.type.evidence',
      }
      const CONFIDENCE_KEYS = {
        EXTRACTED: 'page.confidence.EXTRACTED',
        INFERRED: 'page.confidence.INFERRED',
        AMBIGUOUS: 'page.confidence.AMBIGUOUS',
        UNVERIFIED: 'page.confidence.UNVERIFIED',
      }
      const KIND_KEYS = {
        file: 'sources.kind.file',
        url: 'sources.kind.url',
        article: 'sources.kind.article',
        text: 'sources.kind.text',
        note: 'sources.kind.note',
        conversation: 'sources.kind.conversation',
        path: 'sources.kind.path',
      }
      const SOURCE_STATUS_KEYS = {
        queued: 'sources.status.queued',
        parsing: 'sources.status.parsing',
        compiling: 'sources.status.compiling',
        ready: 'sources.status.ready',
        failed: 'sources.status.failed',
      }
      /** @type {Record<string, string>} 图谱节点端色（主题变量，随浅/深色适配）。 */
      const NODE_COLORS = {
        source: 'var(--dsw-alias-state-business-primary)',
        entity: 'var(--dsw-alias-brand-primary)',
        topic: 'var(--dsw-alias-state-success-primary)',
        synthesis: 'var(--dsw-alias-state-warn-tertiary)',
      }
      const NODE_COLOR_FALLBACK = 'var(--dsw-alias-label-tertiary)'
      const GRAPH_LEGEND = [
        { type: 'entity', key: 'graph.legend.entity' },
        { type: 'topic', key: 'graph.legend.topic' },
        { type: 'source', key: 'graph.legend.source' },
        { type: 'synthesis', key: 'graph.legend.synthesis' },
      ]
      /** 图谱边关系类型。 */
      const GRAPH_RELATIONS = [
        { relation: 'link', key: 'graph.relation.link' },
        { relation: 'derived', key: 'graph.relation.derived' },
        { relation: 'topic', key: 'taxonomy.relation' },
        { relation: 'CEO', key: 'graph.relation.ceo' },
      ]
      /** 图谱节点类型 → locale key（筛选 chips / 详情徽章复用）。 */
      const GRAPH_TYPE_LABEL_KEYS = {
        source: 'graph.legend.source',
        entity: 'graph.legend.entity',
        topic: 'graph.legend.topic',
        synthesis: 'graph.legend.synthesis',
      }
      /** job 终态（Host 契约未写死枚举，按常见值容错）。 */
      const TERMINAL_JOB_STATUS = ['done', 'failed', 'error', 'cancelled', 'canceled', 'complete', 'completed', 'success']
      const FAILED_JOB_STATUS = ['failed', 'error', 'cancelled', 'canceled']

      // ---- 模块级缓存：面板切走再切回时恢复现场（不使用持久化存储） -----------
      const IDLE_PAGE = { status: 'idle', path: '', data: null, error: '' }
      const cache = {
        tab: 'library',
        page: IDLE_PAGE,
        pageOrigin: '',
        overview: null,
        tree: null,
        searchQuery: '',
        askMessages: [],
        graphData: null,
        graphExplore: { selectedKey: '', searchQuery: '', mode: 'topics', view: 'map', scope: 'overview', groupKey: '' },
        healthData: null,
      }

      // ======================================================================
      // 本地化字典（key 集合 zh / en 完全一致；所有可见文案都从这里取）
      // ======================================================================
      /** @type {Record<string, string>} 简体中文字典。 */
      const zh = {
        'panel.label': '知识库',
        'header.title': '知识库',
        'header.rootTip': '知识库目录：{path}（点击复制）',
        'header.copied': '已复制目录路径',
        'header.copyFailed': '复制失败，请手动复制：{path}',
        'header.refresh': '刷新',
        'header.refreshing': '刷新中…',
        'header.modelFallback': '未知模型',
        'header.modelTip': '当前用于编译与问答的模型',
        'header.notInitialized': '未初始化',
        'tab.library': '知识库',
        'tab.sources': '素材',
        'tab.conversations': 'AI 对话',
        'sources.kind.conversation': 'AI 对话',
        'conversation.mine': '我的发言',
        'conversation.reply': 'AI 回答',
        'conversation.me': '我：',
        'conversation.provider': '提供方：{name}',
        'conversation.unknownModel': '模型未记录',
        'conversation.modelChange': '模型：{name}',
        'conversation.actions': '对话操作',
        'conversation.copied': '已复制完整对话',
        'conversation.copy': '复制对话',
        'conversation.collection': '对话收藏',
        'conversation.prompts': '{n} 次提问',
        'conversation.messages': '{n} 条消息',
        'conversation.savedAt': '收藏于 {date}',
        'conversation.models': '使用模型',
        'conversation.partialModels': '部分发言未记录模型',
        'conversation.details': '对话详情',
        'conversation.source': '来源',
        'conversation.dshSource': 'DSH 对话',
        'conversation.scope': '保存范围',
        'conversation.session': '会话编号',
        'conversation.modelRecord': '模型记录',
        'conversation.modelWithProvider': '{model}（提供方：{provider}）',
        'conversation.noModelRecord': '原始记录未提供模型标识',
        'conversation.recordNote': '保留用户与 AI 的原始发言。模型标识来自每条回答的原始记录。AI 回答未经独立事实核实；附件仅保留名称。',
        'conversation.original': '对话原文',
        'conversation.full': '完整对话',
        'conversation.selected': '所选 {n} 条消息',
        'conversation.description': '值得留下的问答，随时回来翻阅。',
        'conversation.save': '收藏对话',
        'conversation.count': '共 {n} 段对话',
        'conversation.search': '搜索对话',
        'conversation.searchPlaceholder': '搜索对话…',
        'conversation.delete': '删除对话',
        'conversation.empty': '还没有收藏的对话',
        'conversation.emptyHint': '打开任意 DSH 对话，点击顶部的「保存到知识库」，选择整段或几条消息。',
        'conversation.deleteTitle': '删除对话「{title}」？',
        'conversation.deleteSelected': '删除 {n} 个对话？',
        'conversation.deleteNote': '这会永久移除知识库中的收藏副本。',
        'dshUi.region': '对话中的表格和提示',
        'dshUi.table': '表格 {n}',
        'dshUi.info': '说明',
        'dshUi.success': '提示',
        'dshUi.warning': '提醒',
        'dshUi.error': '注意',
        'upload.readerUnavailable': '当前环境不支持文件读取',
        'upload.readFailed': '无法读取文件内容',
        'tab.graph': '图谱',
        'tab.ask': '问答',
        'tab.health': '健康',
        'common.loading': '加载中…',
        'common.retry': '重试',
        'common.cancel': '取消',
        'common.close': '关闭',
        'common.delete': '删除',
        'common.refresh': '刷新',
        'common.dismiss': '关闭提示',
        'common.empty': '暂无数据',
        'common.unknown': '未知',
        'common.updated': '更新于 {time}',
        'common.chars': '{n} 字',
        'common.pages': '{n} 页',
        'common.items': '{n} 项',
        'common.open': '打开',
        'common.viewAll': '查看全部',
        'common.separator': ' · ',
        'common.failureSeparator': '  ·  ',
        'crash.title': '知识库面板暂时无法显示',
        'crash.hint': '请切换面板后重试；如果问题持续，请查看控制台日志。',
        'error.loadFailed': '加载失败',
        'error.loadFailedWith': '加载失败：{message}',
        'error.requestFailed': '请求失败，请稍后重试',
        'error.network': '网络请求失败，请检查 Host 是否在线',
        'error.badResponse': '服务返回了无法解析的数据',
        'upload.section': '添加素材',
        'upload.dropTitle': '上传文档',
        'upload.dropHint': '点击选择文件，或把文件拖到这里',
        'upload.acceptHint': '支持 PDF / Office / EPUB / HTML / Markdown / 文本等，单文件上限 {size}',
        'upload.choose': '选择文件',
        'upload.reading': '正在读取 {name}…',
        'upload.uploading': '正在上传 {name}（{size}）…',
        'upload.processing': '正在处理 {index}/{total}：{name}',
        'upload.tooLarge': '文件过大：{name}（{size}，上限 {limit}）',
        'upload.empty': '没有选择文件',
        'upload.done': '已上传 {n} 个文件，正在编译…',
        'upload.failed': '「{name}」上传失败：{message}',
        'upload.dragActive': '松开以上传',
        'upload.busy': '正在处理文件…',
        'upload.retry': '重新选择',
        'url.section': '消化链接',
        'url.placeholder': '粘贴网页 / 文章链接…',
        'url.action': '消化',
        'url.busy': '抓取中…',
        'url.submitted': '已提交链接，正在编译…',
        'url.invalid': '请输入 http(s):// 开头的有效链接',
        'url.failed': '链接消化失败',
        'dup.existed': '已在知识库，未重复入库：{title}',
        'dup.changed': '已在知识库：{title}（原文有更新，本次未覆盖）',
        'dup.skippedMany': '已跳过 {n} 个知识库已存在的素材',
        'paste.toggle': '粘贴文本',
        'paste.titlePlaceholder': '标题（可选）',
        'paste.placeholder': '把要消化的正文粘贴到这里，空行分段…',
        'paste.action': '消化',
        'paste.busy': '提交中…',
        'paste.empty': '请先粘贴正文',
        'paste.tooLong': '正文最多 {n} 字',
        'paste.cancel': '收起',
        'paste.failed': '文本消化失败',
        'job.queued': '排队中',
        'job.running': '正在编译…',
        'job.progress': '{n}%',
        'job.done': '已完成',
        'job.failed': '处理失败',
        'job.retry': '重试',
        'job.dismiss': '关闭',
        'job.pages': '生成 {n} 个页面',
        'job.source': '素材：{title}',
        'job.pollFailed': '无法获取任务进度：{message}',
        'job.retrying': '正在重新编译…',
        'search.section': '搜索',
        'search.placeholder': '搜索标题、标签与正文…',
        'search.busy': '搜索中…',
        'search.results': '搜索「{q}」：{n} 条结果',
        'search.clear': '清除搜索',
        'search.empty': '没有找到与「{q}」相关的内容',
        'search.failed': '搜索失败',
        'search.shown': '已显示 {shown}／{total} 条',
        'search.more': '加载更多',
        'search.match': '查看匹配段落',
        'search.sourceMatch': '匹配到 {type}',
        'search.sourceMatches': '匹配 {n} 项内容',
        'search.hint': '输入关键词自动搜索，回车立即搜索',
        'sources.title': '素材',
        'sources.empty': '还没有素材，先上传或消化一篇内容',
        'sources.status.queued': '排队中',
        'sources.status.parsing': '解析中',
        'sources.status.compiling': '编译中',
        'sources.status.ready': '就绪',
        'sources.status.failed': '失败',
        'sources.openPage': '打开摘要页',
        'sources.failedTip': '处理失败：{message}',
        'sources.retry': '重新编译',
        'sources.retryFailed': '重新编译失败：{message}',
        'sources.retrying': '正在重新编译…',
        'sources.delete': '删除素材',
        'sources.deleteConfirm': '删除「{title}」及其摘要页？',
        'sources.deleteConfirmHint': '实体 / 主题页会移除该来源引用。',
        'sources.deleteAction': '确认删除',
        'sources.deleting': '正在删除…',
        'sources.deleted': '已删除素材「{title}」',
        'sources.deleteFailed': '删除失败：{message}',
        'sources.noPage': '该素材还没有生成摘要页',
        'sources.kind.file': '文件',
        'sources.kind.url': '链接',
        'sources.kind.article': '网页',
        'sources.kind.text': '粘贴',
        'sources.kind.note': '笔记',
        'sources.kind.path': '本地文件',
        'sources.pageCount': '{n} 页',
        'sources.pageDesc': '上传的文件、链接与笔记都在这里；可查看编译状态、重新编译或删除。',
        'sources.createdAt': '创建于 {time}',
        'sources.add': '添加素材',
        'sources.addDesc': '上传文档、消化链接或粘贴文本；编译完成后会出现在素材列表里。',
        'sources.filterLabel': '按状态筛选素材',
        'sources.filter.all': '全部',
        'sources.filter.ready': '就绪',
        'sources.filter.failed': '失败',
        'sources.filter.busy': '进行中',
        'sources.filterPlaceholder': '搜索素材标题…',
        'sources.filterEmpty': '没有符合筛选的素材',
        'sources.filterEmptyHint': '换个关键词或状态再试试。',
        'sources.filterClear': '清除筛选',
        'sources.emptyHint': '上传文档、消化链接或粘贴文本；编译完成后素材会出现在这里。',
        'sources.selectAll': '全选',
        'sources.deselectAll': '取消全选',
        'sources.openMaterial': '打开素材',
        'sources.openConversation': '打开对话',
        'sources.relatedCount': '关联 {n} 个知识页',
        'sources.manageTip': '在素材页集中管理',
        'groups.title': '页面',
        'groups.empty': '还没有生成任何页面',
        'groups.type.source': '素材摘要',
        'groups.type.entity': '实体',
        'groups.type.topic': '主题',
        'groups.type.synthesis': '综合',
        'groups.type.other': '其他',
        'init.title': '初始化知识库',
        'init.desc': '在本地创建 Markdown Wiki：素材原文、摘要页、实体页、主题页、索引与图谱。素材只编译一次，之后持续维护。',
        'init.button': '初始化知识库',
        'init.busy': '正在初始化…',
        'init.failed': '初始化失败：{message}',
        'init.done': '知识库已就绪',
        'init.rootTip': '将创建于 {path}',
        'init.emptyAside': '知识库尚未初始化',
        'overview.title': '概览',
        'overview.purpose': '研究方向',
        'overview.purposeHint': '说明你的研究目标或关注点，编译时会参考它组织页面。',
        'overview.purposeEmpty': '还没有填写研究方向，可以在这里补充。',
        'overview.purposeSave': '保存',
        'overview.purposeSaving': '保存中…',
        'overview.purposeSaved': '已保存研究方向',
        'overview.purposeFailed': '保存失败：{message}',
        'overview.purposeTooLong': '研究方向最多 {n} 字',
        'overview.purposeCounter': '{n}/{max}',
        'overview.stats.sources': '素材',
        'overview.stats.entities': '实体',
        'overview.stats.topics': '主题',
        'overview.stats.pages': '页面',
        'overview.recentPages': '最近更新',
        'overview.recentSources': '最近素材',
        'overview.noRecentPages': '还没有页面',
        'overview.noRecentSources': '还没有素材',
        'overview.graphPreview': '图谱预览',
        'overview.openGraph': '打开图谱',
        'overview.model': '编译模型',
        'overview.modelLabel': '编译模型：{model}',
        'overview.rootDir': '根目录',
        'overview.loading': '正在加载概览…',
        'overview.failed': '概览加载失败：{message}',
        'overview.empty.title': '知识库还是空的',
        'overview.empty.hint': '在左侧上传文档、消化链接或粘贴文本，编译后这里会显示研究方向、统计与最近更新。',
        'overview.charTotal': '累计 {n} 字',
        'page.reading': '正在读取页面…',
        'page.failed': '页面加载失败：{message}',
        'page.back': '返回概览',
        'page.backConversations': '返回 AI 对话',
        'page.notFound': '页面不存在或已被删除',
        'page.type.source': '素材摘要',
        'page.type.entity': '实体',
        'page.type.topic': '主题',
        'page.type.synthesis': '综合',
        'page.type.excerpt': '摘抄',
        'page.type.original': '原文',
        'page.type.chapter': '章节原文',
        'page.type.evidence': '引用段落',
        'page.fullText': '查看全文',
        'page.evidenceLines': '原文第 {start}—{end} 行',
        'page.excerptOrigin': '来自 AI 阅读助手，可在「摘抄笔记」中管理。',
        'page.excerptSource': '来源：',
        'page.confidence.EXTRACTED': '原文',
        'page.confidence.INFERRED': '推断',
        'page.confidence.AMBIGUOUS': '存疑',
        'page.confidence.UNVERIFIED': '未验证',
        'page.aliases': '别名',
        'page.aliasesLabel': '别名：',
        'page.aliasesSeparator': '、',
        'page.backlinks': '反向链接',
        'page.backlinksEmpty': '还没有其他页面链接到这里',
        'page.sources': '来源素材',
        'page.sourcesEmpty': '没有关联来源',
        'page.openSource': '打开素材页',
        'page.openOriginal': '打开原文',
        'page.openOriginalUrl': '打开原网页',
        'source.original.title': '原文',
        'source.detail.title': '素材详情',
        'source.detail.sections': '素材内容',
        'source.detail.summary': '摘要',
        'source.detail.aiSummary': 'AI 整理的摘要',
        'source.detail.openSummary': '打开摘要页',
        'source.detail.excerpts': '摘抄 {n}',
        'source.detail.excerptUnavailable': '暂时无法读取阅读助手的摘抄。',
        'source.detail.related': '关联知识 {n}',
        'source.detail.documentNote': '同文档笔记',
        'source.detail.versions': '同文版本 {n}',
        'source.detail.currentVersion': '当前版本',
        'source.original.open': '查看原文',
        'source.original.short': '原文',
        'source.original.loading': '正在读取本地原文…',
        'source.original.failed': '读取原文失败：{message}',
        'source.original.empty': '没有可显示的原文文本（原件可能已删除，或该素材只有二进制原件）。',
        'source.original.copy': '复制原文',
        'source.original.copied': '原文已复制',
        'source.original.openFile': '打开原件',
        'source.original.openUrl': '打开原网页',
        'source.original.binaryHint': '弹层显示的是从原件中抽取出的正文；「打开原件」可下载或预览原始文件。',
        'page.sourceStatus': '状态：{status}',
        'page.wikiMissing': '尚未创建',
        'page.wikiTip': '打开「{title}」',
        'page.wikiMissingTip': '「{title}」尚未创建',
        'page.pathTip': '页面路径：{path}',
        'page.copyPath': '复制页面路径',
        'page.pathCopied': '已复制页面路径',
        'page.charCount': '{n} 字',
        'graph.explore': "关联阅读",
        'graph.map': "主题地图",
        "graph.hiddenLabels": "{n} 个标题暂时收起，移到节点上或放大可查看。",
        "graph.moreMatches": "另有 {n} 个结果，可继续输入或按 Enter 逐个查看。",
        "graph.matchPages": "匹配的知识页",
        "graph.mapLimit": "已达单图显示上限，可从关联列表继续浏览。",
        "graph.allHint": "全库总览仅显示部分标题。搜索或点节点可进入局部探索。",
        "graph.groupHint": "当前只展开这个主题的页面。点击节点查看直接关联。",
        "graph.localHint": "只显示当前页的直接关联。点另一个节点，继续探索它的关联。",
        "graph.expandMore": "再展开 {n} 页",
        "graph.shown": "显示 {shown} / {total} 页",
        "graph.back": "返回上一步",
        "graph.localMap": "直接关联",
        "graph.allMap": "全库关系",
        "graph.ungroupedHint": "这些页面还没有连到现有主题，可以从这里继续探索。",
        "graph.ungrouped": "尚未关联主题",
        "graph.groupShared": "一个页面可出现在多个主题中；分组表示浏览入口。",
        "graph.groupCounts": "{topics} 个主题 · {pages} 个关联页面",
        "graph.overviewHint": "按现有主题目录和页面链接分组。点进主题，再沿着关联逐页探索。",
        "graph.overviewTitle": "从一个主题开始",
        "graph.overview": "主题总览",
        'graph.purpose': "选一个主题，找到相关页面、引用原句和来源素材。",
        'graph.catalog': "选择阅读起点",
        'graph.browseCatalog': '浏览目录',
        'common.moreActions': '更多操作',
        'common.more': '更多',
        'graph.mode.topics': "主题目录",
        'graph.mode.bridges': "跨素材线索",
        'graph.mode.isolated': "待连接页面",
        'graph.mode.all': "全部页面",
        'graph.mode.topics.hint': "从大主题逐层展开子主题，也可以新建主题或调整上级。",
        'graph.mode.bridges.hint': "这些页面由多份素材共同整理。共同提及不代表观点一致。",
        'graph.mode.isolated.hint': "这些页面还没有显式引用或素材派生关系，可以先读原文，再决定是否补充链接。",
        'graph.mode.all.hint': "浏览全部页面；搜索也会匹配别名和标签。",
        'graph.catalogEmpty': "当前分类没有匹配页面，试试全部页面或清除搜索。",
        'graph.sourcesCount': "{n} 份来源素材",
        'graph.more': "再显示 {n} 项",
        'graph.welcome.title': "从一页读到一组资料",
        'graph.welcome.desc': "左侧按主题找入口。选中页面后，可以先看摘要，再顺着引用关系阅读，或回到来源核对。",
        'graph.welcome.bridges': "值得交叉阅读",
        'graph.welcome.topics': "从这些主题开始",
        'graph.preview': "内容预览",
        'graph.previewLoading': "正在读取页面…",
        'graph.previewEmpty': "正文暂无可预览段落，可以打开页面查看。",
        'graph.provenance': "来源素材",
        'graph.noSources': "页面未记录可追溯的来源素材。",
        'graph.references': "接下来读什么",
        'graph.linkOut': "本页引用",
        'graph.linkIn': "引用本页",
        'graph.linkBoth': "互相引用",
        'graph.derivedIn': "整理自这份素材",
        'graph.derivedOut': "由本素材整理",
        'graph.evidence': "查看引用原句",
        'graph.evidenceHide': "收起引用原句",
        'graph.evidenceMissing': "未找到可展示的引用段落，请打开引用页核对正文。",
        'graph.evidenceFrom': "引用来自：{title}",
        'graph.evidenceCaveat': "正文引用表示页面之间有链接；素材派生表示整理来源。连线本身不代表支持、反对或因果关系。",
        'graph.return': "返回关联阅读",
        "taxonomy.entityCategory": "实体分类",
        "taxonomy.category.all": "全部分类",
        "taxonomy.category.company": "公司",
        "taxonomy.category.technology": "技术",
        "taxonomy.category.task": "任务",
        "taxonomy.category.product": "产品",
        "taxonomy.category.person": "人物",
        "taxonomy.category.organization": "机构",
        "taxonomy.category.concept": "概念",
        "taxonomy.category.metric": "指标",
        "taxonomy.category.document": "文档与规则",
        "taxonomy.category.other": "其他",
        "taxonomy.category.unassigned": "待分类",
        "taxonomy.categoryEmpty": "这个分类还没有匹配的实体，可以切换分类或清除搜索。",
        "taxonomy.chooseCategory": "选择实体分类",
        "taxonomy.parent": "上级主题",
        "taxonomy.root": "无上级，作为大主题",
        "taxonomy.parentHint": "可以继续分多层；移动一个主题时，其子主题会一起保留。",
        "taxonomy.organize": "调整归属",
        "taxonomy.createTopic": "新建主题",
        "taxonomy.addChild": "添加子主题",
        "taxonomy.topicTitle": "主题名称",
        "taxonomy.expand": "展开 {title}",
        "taxonomy.collapse": "收起 {title}",
        "taxonomy.children": "子主题（{n}）",
        "taxonomy.breadcrumb": "主题路径",
        "taxonomy.relation": "主题层级",
        "taxonomy.parentRelation": "属于上级主题",
        "taxonomy.childRelation": "包含子主题",
        "graph.mode.entities": "实体分类",
        "graph.mode.entities.hint": "按公司、技术、任务、产品等分类浏览，归属可以随时调整。",
        'tab.books': "书库",
        'books.title': "书库",
        'books.subtitle': "每本书，一个独立的知识库。",
        'books.import': "导入书籍",
        'books.importing': "正在导入…",
        'books.importHint': "支持 EPUB、可复制文字的 PDF、TXT、Markdown、DOCX，单本最多 {size}。单本上传后使用当前模型自动精读；批量导入可逐本启动。",
        'books.mode.analysis': '单书精读',
        'reading.title': '读懂这本书',
        'reading.promise': '把问题、论证、案例和适用条件一起讲清楚。',
        'reading.start': '开始精读',
        'reading.resume': '继续精读',
        'reading.pause': '暂停精读',
        'reading.scope': '已识别 {n} 个章节 · {chars} 字',
        'reading.partialSource': '原件有部分图片或内容未被识别，本次仅分析已识别文字，不能视为整本书完整覆盖。',
        'reading.textScope': '基于已识别文字生成。原件中的图片和图表未单独核读。',
        'reading.selected': '本次分析 {n} 个正文章节或部分。',
        'reading.excluded.sections': '已略过 {n} 个非正文部分',
        'reading.excluded.passages': '已略过 {n} 段推广信息',
        'reading.excluded.original': '这些内容不参与精讲、卡片和图解，原书与章节原文保留。',
        'reading.reason.preface': '前言／序言',
        'reading.reason.title-page': '书名／署名页',
        'reading.reason.copyright': '版权／出版信息',
        'reading.reason.contents': '目录',
        'reading.reason.dedication': '献词',
        'reading.reason.acknowledgements': '致谢',
        'reading.reason.publisher-note': '出版后记',
        'reading.reason.promotion': '推广／下载广告',
        'reading.reason.divider': '纯标题页',
        'reading.reason.author-info': '作者简介',
        'reading.parseNotes': '解析说明',
        'reading.progress': '已保存 {n}/{total} 个阅读片段',
        'reading.progressLabel': '逐章精读与全书综合进度',
        'reading.stats': '精讲约 {minutes} 分钟 · {cards} 张知识卡片 · {diagrams} 张图解（按每分钟 300 字估算）',
        'reading.intro': '阅读筛选后的正文，用第一人称直接讲清知识、例子和适用条件。科技书讲机制，商业书讲决策条件，社科书讲观点与论据。',
        'reading.view.read': '速读精讲',
        'reading.view.cards': '知识卡片',
        'reading.view.diagrams': '图解与地图',
        'reading.preview.read': '压缩篇幅，讲清概念、推理和具体例子；可以展开逐章细读。',
        'reading.preview.cards': '每个知识点都有解释、书中例子、适用边界和原文出处。',
        'reading.preview.diagrams': '用知识地图呈现关系；书中有方法步骤时，再生成流程图。',
        'reading.resumeHint': '使用 DSH 当前模型。长书需要多次调用，完成一段就保存一段，可随时暂停并继续。',
        'reading.views': '精读视图',
        'reading.synthesisPending': '已完成的章节可以先读。全部片段处理完后，会生成全书精讲和图解。',
        'reading.chapterReading': '展开逐章细读',
        'reading.source': '原文',
        'reading.sources': '查看本节出处（{n}）',
        'reading.inference': '编者归纳',
        'reading.searchCards': '查找知识卡片',
        'reading.searchPlaceholder': '概念、方法或章节',
        'reading.allCards': '显示全部 {n} 张卡片',
        'reading.noCards': '没有匹配的知识卡片。',
        'reading.expandCard': '展开卡片',
        'reading.openCard': '展开卡片：{title}',
        'reading.collapseCard': '收起卡片',
        'reading.example': '书中例子',
        'reading.boundary': '适用边界',
        'reading.diagrams': '选择图解',
        'reading.noDiagrams': '当前内容没有足够依据生成图解，可在精讲和卡片中阅读。',
        'reading.diagramHint': '选择知识点查看讲解与案例；蓝线突出当前关系，虚线表示编者归纳。',
        'reading.nodes': '知识节点',
        "reading.author": "书中观点",
        "reading.mapScope": "关系显示范围",
        "reading.wholeMap": "全图",
        "reading.localMap": "只看当前关系",
        "reading.expandMap": "放大查看",
        "reading.collapseMap": "收起图解",
        "reading.nodeNumber": "知识点 {n}",
        "reading.nodeSections": "{n} 节出处",
        "reading.connected": "相邻关系 · {n}",
        "reading.noConnections": "此知识点暂未标注与其他节点的关系。",
        "reading.followNode": "继续看：{title}",
        "reading.mapStats": "{nodes} 个知识点 · {edges} 条关系",
        "reading.kind.map": "知识地图",
        "reading.kind.flow": "方法流程",
        "reading.kind.causal": "因果关系",
        "reading.sameSectionCards": "同节知识卡片 · {n}",
        "reading.sameSectionHint": "来自这个知识点所引用的章节，展开查看解释、例子与适用边界。",
        "reading.deepReading": "展开章节精讲 · {n}",
        "reading.studyUnavailable": "本书的章节精讲暂不可用，可以先查看节点解释与出处。",
        'reading.relations': '展开关系说明',
        'reading.state.empty': '尚未生成精读',
        'reading.state.running': '正在精读',
        'reading.state.ready': '精读已生成',
        'reading.state.paused': '精读已暂停',
        'reading.state.failed': '精读待重试',
        'reading.state.stale': '精读待更新',
        'books.importProgress': "正在保存并识别《{name}》…",
        'books.emptyTitle': "把一本书，整理成自己的知识库",
        'books.emptyHint': "原书、章节、提炼的知识和问答分别保存在本书范围内，不会自动合并到主库或其他书。",
        'books.loading': "正在读取书库…",
        'books.open': "打开本书知识库",
        'books.back': "返回书库",
        'books.delete': "删除本书",
        'books.deleteTitle': "删除《{title}》？",
        'books.deleteHint': "本书的原件、章节和已抽取的知识页都会永久删除。其他书和主库不受影响。",
        'books.tooLarge': "《{name}》超过单本 {size} 的限制。",
        'books.unsupported': "请选择 EPUB、PDF、TXT、Markdown 或 DOCX 文件。",
        'books.status.imported': "待抽取",
        'books.status.running': "抽取中",
        'books.status.paused': "已暂停",
        'books.status.partial': "部分完成",
        'books.status.ready': "已完成",
        'books.status.failed': "处理失败",
        'books.progress': "已完成 {done}/{total} 节 · {pages} 个知识页",
        'books.incomplete': "部分原文未被识别，本次仅处理已识别的文字。请查看识别提示并核对原书。",
        'books.coverageUnknown': "原文识别是否完整尚待核对；章节完成进度不代表整本书已完整识别。",
        'books.coveragePartialShort': "部分原文未识别",
        'books.coverageUnknownShort': "原文覆盖待核对",
        'books.isolatedScope': "本书独立整理、检索和问答，不自动写入主库。",
        'books.originalFile': "打开原书",
        'books.extract': "开始抽取知识",
        'books.resume': "继续抽取未完成部分",
        'books.pause': "暂停抽取",
        'books.actionWorking': "正在处理…",
        'books.extractionDetails': "识别与抽取",
        'books.extractionHint': "已识别 {chars} 字符。抽取使用当前模型，可暂停后继续。",
        'books.warnings': "查看 {n} 条处理提示",
        'books.notFound': "这本书不存在，或已被删除。",
        'books.contentLabel': "本书内容",
        'books.mode.knowledge': "知识页",
        'books.mode.ask': "问这本书",
        'books.chapterCount': "已识别 {n} 个章节或分段",
        'books.originalChapter': "原文",
        'books.knowledgePage': "本书知识页",
        'books.citation': "出处",
        'books.openCitation': "查看引用 {n}：{title}",
        'books.knowledgeEvidenceLines': "知识页第 {start}—{end} 行",
        'books.chapterSources': "回到原文章节",
        'books.chooseKnowledge': "选择一个知识页",
        'books.knowledgeHint': "知识页会保留来源章节，便于回到原文核对。",
        'books.noKnowledge': "尚未抽取知识。可用上方搜索框查找章节原文，也可开始抽取知识。",
        'books.searchLabel': "搜索本书原文与知识",
        'books.searchPlaceholder': "搜索概念、主题或正文…",
        'books.pageType': "知识页类型",
        'books.allPages': "全部知识页",
        'books.noMatches': "本书内没有匹配的知识页。",
        'books.reading': "正在读取本书内容…",
        'books.askScope': "回答依据本书原文与知识页。点引用编号可查看对应段落。",
        'books.askEmpty': "从一个问题开始",
        'books.askHint': "可以问本书的核心论点、概念之间的关系，或某个观点的出处。",
        'books.askNeedsExtraction': "导入书籍后即可依据已识别的章节原文提问。",
        'books.askLabel': "向本书提问",
        'books.askPlaceholder': "例如，作者的核心论点是什么？",
        'books.askKeys': "回车发送 · Shift + 回车换行",
        'books.stopAnswer': "停止回答",
        'books.askStopped': "回答已停止，已生成的内容保留。",
        'books.askInterrupted': "回答中断，可以重新提问。",
        'books.searchLimited': '找到 {total} 条，当前显示前 {shown} 条；可缩小关键词继续检索。',
        'books.currentChapter': '正在整理：{title}',
        'graph.title': '图谱',
        'graph.loading': '正在加载图谱…',
        'graph.failed': '图谱加载失败：{message}',
        'graph.empty.title': '图谱还是空的',
        'graph.empty.hint': '上传并编译素材后，实体、主题与素材之间的链接会显示在这里。',
        'graph.reload': '重新布局',
        'graph.refresh': '刷新数据',
        'graph.truncated': '节点过多，仅显示关联度最高的 {shown}/{total} 个',
        'graph.nodes': '{n} 节点',
        'graph.edges': '{n} 连接',
        'graph.legend.source': '素材',
        'graph.legend.entity': '实体',
        'graph.legend.topic': '主题',
        'graph.legend.synthesis': '综合',
        'graph.hint': '点击节点打开页面，悬停查看标题',
        'graph.searchPlaceholder': '搜索标题、别名、标签…',
        'graph.searchClear': '清除搜索',
        'graph.searchMatches': '{n} 个匹配',
        'graph.searchEmpty': '没有匹配的节点',
        'graph.filterTypes': '按类型与关系筛选',
        'graph.filterShowAll': '显示全部',
        'graph.relation.link': '正文链接',
        'graph.relation.derived': '素材派生',
        'graph.relation.ceo': 'CEO',
        'graph.ceoDirection': '{person} 担任 {company} 的 CEO',
        'graph.ceoSource': '查看 CEO 关系的选段出处',
        'graph.ceoSourceNamed': '查看 CEO 关系的出处《{title}》',
        'graph.zoomIn': '放大',
        'graph.zoomOut': '缩小',
        'graph.fit': '适应画布',
        'graph.panHint': '拖拽平移 · 滚轮缩放 · 点击节点展开关联 · 在详情中阅读全文',
        'graph.stats': '{nodes} 节点 · {edges} 连接',
        'graph.isolated': '{n} 个孤立页面',
        'graph.detail': '节点详情',
        'graph.detail.close': '关闭详情',
        'graph.detail.degree': '{n} 条连接',
        'graph.detail.open': '阅读全文',
        'graph.detail.neighbors': '邻居（{n}）',
        'graph.detail.noNeighbors': '孤立页面：还没有任何链接',
        'graph.detail.focus': '只看邻居',
        'graph.detail.unfocus': '显示全部',
        'graph.filterEmpty': '当前筛选下没有可见节点',
        'graph.filteredStats': '显示 {nodes}/{totalNodes} 节点 · {edges}/{totalEdges} 连接',
        'ask.title': '知识库问答',
        'ask.subtitle': '检索原文与知识页，查找证据并给出段落引用。',
        'ask.placeholder': '向知识库提问…',
        'ask.keys': 'Enter 发送 · Shift+Enter 换行',
        'ask.send': '发送',
        'ask.stop': '停止',
        'ask.thinking': '思考中…',
        'ask.stopped': '已停止',
        'ask.retry': '重试',
        'ask.retrying': '正在重试…',
        'ask.empty.title': '向知识库提问',
        'ask.empty.hint': '例如：「这个知识库主要讲了什么？」「把关于 XX 的页面串起来总结一下。」',
        'ask.noSources': '未命中页面，回答可能基于模型常识',
        'ask.sources': '参考段落',
        'ask.failed': '问答失败：{message}',
        'ask.streamInterrupted': '回答流中断，请重试',
        'ask.emptyAnswer': '模型没有返回内容，请重试',
        'ask.clear': '清空对话',
        'ask.you': '你',
        'ask.ai': '知识库',
        'ask.errNoModel': '尚未配置模型 provider/model，请先在 Harness 里选择默认模型。',
        'ask.errNoKb': '知识库还没有内容，先添加素材再来提问。',
        'ask.historyHint': '对话会携带最近几轮上下文',
        'ask.openSource': '打开引用页面',
        'health.title': '健康检查',
        'health.desc': '检查孤立页面、失效链接、缺失来源、空页面与重复标题。',
        'health.run': '运行检查',
        'health.running': '检查中…',
        'health.failed': '健康检查失败：{message}',
        'health.good': '知识库状态良好',
        'health.goodHint': '未发现孤立页面、失效链接或缺失来源。',
        'health.summary': '页面 {pages} · 链接 {links} · 问题 {issues}',
        'health.issueCount': '共 {n} 个问题',
        'health.empty.title': '尚未运行检查',
        'health.empty.hint': '点击上方按钮检查知识库链接与页面完整性。',
        'health.type.orphan-page': '孤立页面',
        'health.type.broken-link': '失效链接',
        'health.type.missing-source': '缺失来源',
        'health.type.empty-page': '空页面',
        'health.type.duplicate-title': '重复标题',
        'health.type.unknown': '其他问题',
        'health.severity.error': '错误',
        'health.severity.warn': '警告',
        'health.severity.warning': '警告',
        'health.severity.info': '提示',
        'health.pageTarget': '页面：{page}',
        'health.openPage': '打开页面',
        'health.noPage': '无关联页面',
        'health.errors': '{n} 错误',
        'health.warnings': '{n} 警告',
        'health.checkedAt': '检查时间：{time}',
        /* ---- 附录 A：内容管理（编辑 / 删除 / 批量 / 回收站） ---- */
        'dialog.close': '关闭',
        'dialog.cancel': '取消',
        'dialog.working': '处理中…',
        'confirm.irreversible': '此操作将永久删除数据，不可恢复。',
        'edit.title': '编辑页面',
        'edit.subtitle': '手动修改会标记为已编辑；重新编译素材可能覆盖素材摘要页正文。',
        'edit.field.title': '标题',
        'edit.field.aliases': '别名',
        'edit.field.tags': '标签',
        'edit.field.confidence': '置信度',
        'edit.field.markdown': '正文（Markdown）',
        'edit.aliasesHint': '用逗号分隔，可留空',
        'edit.tagsHint': '用逗号分隔，可留空',
        'edit.titleRequired': '标题不能为空',
        'edit.titleTooLong': '标题最多 {n} 字',
        'edit.markdownTooShort': '正文至少 {n} 字',
        'edit.markdownTooLong': '正文最多 {n} 字',
        'edit.tooManyAliases': '别名最多 {n} 项',
        'edit.tooManyTags': '标签最多 {n} 项',
        'edit.itemTooLong': '每项最多 {n} 字',
        'edit.save': '保存',
        'edit.saving': '保存中…',
        'edit.saved': '页面已保存',
        'edit.savedTitle': '已保存',
        'edit.failed': '保存失败：{message}',
        'edit.rewrittenLinks': '已改写 {n} 处引用',
        'edit.warnings': '警告（{n}）',
        'edit.discardTitle': '放弃未保存的修改？',
        'edit.discardDesc': '关闭后本次编辑不会保存。',
        'edit.discardAction': '放弃修改',
        'edit.keepEditing': '继续编辑',
        'edit.userEditedTip': '此页有手动编辑记录（{time}），重新编译素材可能覆盖正文。',
        'edit.sourceTip': '这是素材摘要页：重新编译该素材会覆盖你手动编辑的正文。',
        'page.edit': '编辑',
        'page.delete': '删除',
        'page.deleteTitle': '删除页面',
        'page.deleteDesc': '「{title}」将移入回收站，可在「健康 → 回收站」恢复。指向它的链接会被降级为纯文本。',
        'page.deleteAction': '删除页面',
        'page.deleting': '正在删除…',
        'page.deleted': '已移入回收站，可在「健康 → 回收站」恢复',
        'page.deleteFailed': '删除页面失败：{message}',
        'page.userEdited': '手动编辑于 {time}',
        'manage.enter': '管理',
        'manage.exit': '完成',
        'manage.selected': '已选 {n} 项',
        'manage.cancel': '取消',
        'manage.delete': '删除所选',
        'manage.deleteSourcesTitle': '永久删除 {n} 个素材？',
        'manage.deleteSourcesDesc': '素材原件、摘要页以及仅由它们引用的实体/主题页会被永久删除，无法恢复。',
        'manage.deletePagesTitle': '删除 {n} 个页面？',
        'manage.deletePagesDesc': '所选页面将移入回收站，可从「健康 → 回收站」恢复；相关链接会被降级为纯文本。',
        'manage.deleteSourcesAction': '永久删除',
        'manage.deletePagesAction': '移入回收站',
        'manage.deleting': '正在删除…',
        'manage.deletedSources': '已删除 {n} 个素材',
        'manage.deletedPages': '已删除 {n} 个页面',
        'manage.skipped': '跳过 {n} 项',
        'manage.failed': '操作失败：{message}',
        'manage.sourceNotSelectable': '素材摘要页请在素材列表管理',
        'manage.emptySources': '没有可删除的素材',
        'manage.emptyPages': '没有可删除的页面',
        'manage.moreItems': '…等 {n} 项',
        'trash.title': '回收站（{n}）',
        'trash.loading': '正在加载回收站…',
        'trash.failed': '回收站加载失败：{message}',
        'trash.empty': '回收站是空的',
        'trash.deletedAt': '删除于 {time}',
        'trash.restore': '恢复',
        'trash.restoring': '恢复中…',
        'trash.restored': '已恢复「{title}」',
        'trash.restoredWithTarget': '已恢复「{title}」→ {path}',
        'trash.restoreFailed': '恢复失败：{message}',
        'trash.purge': '彻底删除',
        'trash.purgeTitle': '彻底删除页面',
        'trash.purgeDesc': '「{title}」将被永久删除，无法恢复。',
        'trash.purgeAction': '彻底删除',
        'trash.purgeFailed': '彻底删除失败：{message}',
        'trash.purged': '已彻底删除',
        'trash.clear': '清空回收站',
        'trash.clearTitle': '清空回收站？',
        'trash.clearDesc': '回收站中的 {n} 个页面将被永久删除，无法恢复。',
        'trash.clearAction': '清空回收站',
        'trash.cleared': '回收站已清空',
        'trash.clearFailed': '清空回收站失败：{message}',
        'trash.note': '恢复的页面不会自动还原已被降级的反向链接，可重新编辑或重新编译素材。',
        'trash.reload': '刷新回收站',
        'trash.sourceCount': '关联 {n} 个素材',
        'sources.recompileTitle': '重新编译素材',
        'sources.recompileDesc': '「{title}」的素材摘要页有手动编辑，重新编译会覆盖正文。是否继续？',
        'sources.recompileAction': '继续编译',
        /* ---- Apple 视觉规范（DESIGN.md）---- */
        'tablist.label': '面板切换',
        'job.progressAria': '编译进度',
        'graph.toolsLabel': '图谱工具',
        'graph.legendLabel': '图例',
        'notices.label': '通知',
        'header.copyPath': '复制知识库路径',
        'header.navigation': '浏览资料',
        'reader.actionsLabel': '页面操作',
      }

      /** @type {Record<string, string>} English dictionary (same key set as zh). */
      const en = {
        'panel.label': 'Knowledge Base',
        'header.title': 'Knowledge Base',
        'header.rootTip': 'Knowledge base folder: {path} (click to copy)',
        'header.copied': 'Folder path copied',
        'header.copyFailed': 'Copy failed. Copy manually: {path}',
        'header.refresh': 'Refresh',
        'header.refreshing': 'Refreshing…',
        'header.modelFallback': 'Unknown model',
        'header.modelTip': 'Model currently used for compiling and Q&A',
        'header.notInitialized': 'Not initialized',
        'tab.library': 'Library',
        'tab.sources': 'Materials',
        'tab.conversations': 'AI Conversations',
        'sources.kind.conversation': 'AI Conversation',
        'conversation.mine': 'My message',
        'conversation.reply': 'AI response',
        'conversation.me': 'Me:',
        'conversation.provider': 'Provider: {name}',
        'conversation.unknownModel': 'Model not recorded',
        'conversation.modelChange': 'Model: {name}',
        'conversation.actions': 'Conversation actions',
        'conversation.copied': 'Conversation copied',
        'conversation.copy': 'Copy conversation',
        'conversation.collection': 'Saved conversations',
        'conversation.prompts': 'Prompts: {n}',
        'conversation.messages': 'Messages: {n}',
        'conversation.savedAt': 'Saved {date}',
        'conversation.models': 'Models used',
        'conversation.partialModels': 'Some messages lack model records',
        'conversation.details': 'Conversation details',
        'conversation.source': 'Source',
        'conversation.dshSource': 'DSH conversation',
        'conversation.scope': 'Saved scope',
        'conversation.session': 'Session ID',
        'conversation.modelRecord': 'Model records',
        'conversation.modelWithProvider': '{model} ({provider})',
        'conversation.noModelRecord': 'The original record contains no model IDs',
        'conversation.recordNote': 'User and AI messages are preserved. Model IDs come from the original response records. AI responses were not independently verified. Attachments are represented by name.',
        'conversation.original': 'Original conversation',
        'conversation.full': 'Full conversation',
        'conversation.selected': 'Selected messages: {n}',
        'conversation.description': 'Save conversations you want to revisit.',
        'conversation.save': 'Save a conversation',
        'conversation.count': 'Saved conversations: {n}',
        'conversation.search': 'Search conversations',
        'conversation.searchPlaceholder': 'Search conversations…',
        'conversation.delete': 'Delete conversation',
        'conversation.empty': 'No saved conversations',
        'conversation.emptyHint': 'Open a DSH conversation, choose Save to Knowledge Base, and select the full conversation or individual messages.',
        'conversation.deleteTitle': 'Delete “{title}”?',
        'conversation.deleteSelected': 'Delete selected conversations ({n})?',
        'conversation.deleteNote': 'This permanently removes the saved copies in the knowledge base.',
        'dshUi.region': 'Tables and callouts',
        'dshUi.table': 'Table {n}',
        'dshUi.info': 'Information',
        'dshUi.success': 'Success',
        'dshUi.warning': 'Reminder',
        'dshUi.error': 'Attention',
        'upload.readerUnavailable': 'File reading is unavailable in this environment',
        'upload.readFailed': 'Could not read the file contents',
        'tab.graph': 'Graph',
        'tab.ask': 'Ask',
        'tab.health': 'Health',
        'common.loading': 'Loading…',
        'common.retry': 'Retry',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'common.delete': 'Delete',
        'common.refresh': 'Refresh',
        'common.dismiss': 'Dismiss',
        'common.empty': 'No data yet',
        'common.unknown': 'Unknown',
        'common.updated': 'Updated {time}',
        'common.chars': '{n} chars',
        'common.pages': '{n} pages',
        'common.items': '{n} items',
        'common.open': 'Open',
        'common.viewAll': 'View all',
        'common.separator': ' · ',
        'common.failureSeparator': '  ·  ',
        'crash.title': 'The Knowledge Base panel cannot be displayed right now',
        'crash.hint': 'Switch panels and try again; if the problem persists, check the console log.',
        'error.loadFailed': 'Failed to load',
        'error.loadFailedWith': 'Failed to load: {message}',
        'error.requestFailed': 'Request failed. Please try again.',
        'error.network': 'Network request failed. Check that the Host is running.',
        'error.badResponse': 'The service returned unreadable data',
        'upload.section': 'Add material',
        'upload.dropTitle': 'Upload documents',
        'upload.dropHint': 'Click to choose files, or drop files here',
        'upload.acceptHint': 'PDF / Office / EPUB / HTML / Markdown / text, up to {size} per file',
        'upload.choose': 'Choose files',
        'upload.reading': 'Reading {name}…',
        'upload.uploading': 'Uploading {name} ({size})…',
        'upload.processing': 'Processing {index}/{total}: {name}',
        'upload.tooLarge': 'File too large: {name} ({size}, limit {limit})',
        'upload.empty': 'No files selected',
        'upload.done': 'Uploaded {n} file(s), compiling…',
        'upload.failed': 'Could not upload “{name}”: {message}',
        'upload.dragActive': 'Release to upload',
        'upload.busy': 'Processing files…',
        'upload.retry': 'Choose again',
        'url.section': 'Ingest a link',
        'url.placeholder': 'Paste a web page or article URL…',
        'url.action': 'Ingest',
        'url.busy': 'Fetching…',
        'url.submitted': 'Link submitted — compiling…',
        'url.invalid': 'Enter a valid http(s):// URL',
        'url.failed': 'Could not ingest the link',
        'dup.existed': 'Already in the knowledge base — skipped: {title}',
        'dup.changed': 'Already in the knowledge base: {title} (source changed; existing copy kept)',
        'dup.skippedMany': 'Skipped {n} materials already in the knowledge base',
        'paste.toggle': 'Paste text',
        'paste.titlePlaceholder': 'Title (optional)',
        'paste.placeholder': 'Paste the text to ingest here; separate paragraphs with blank lines…',
        'paste.action': 'Ingest',
        'paste.busy': 'Submitting…',
        'paste.empty': 'Paste some text first',
        'paste.tooLong': 'The text is limited to {n} chars',
        'paste.cancel': 'Collapse',
        'paste.failed': 'Could not ingest the text',
        'job.queued': 'Queued',
        'job.running': 'Compiling…',
        'job.progress': '{n}%',
        'job.done': 'Done',
        'job.failed': 'Failed',
        'job.retry': 'Retry',
        'job.dismiss': 'Dismiss',
        'job.pages': '{n} page(s) created',
        'job.source': 'Material: {title}',
        'job.pollFailed': 'Could not get job progress: {message}',
        'job.retrying': 'Recompiling…',
        'search.section': 'Search',
        'search.placeholder': 'Search titles, tags and content…',
        'search.busy': 'Searching…',
        'search.results': '“{q}”: {n} result(s)',
        'search.clear': 'Clear search',
        'search.empty': 'Nothing found for “{q}”',
        'search.failed': 'Search failed',
        'search.shown': 'Showing {shown} of {total}',
        'search.more': 'Load more',
        'search.match': 'View matching passage',
        'search.sourceMatch': 'Matched in {type}',
        'search.sourceMatches': '{n} matches in this material',
        'search.hint': 'Search as you type, or press Enter to search now',
        'sources.title': 'Materials',
        'sources.empty': 'No materials yet. Upload a file or ingest a link first.',
        'sources.status.queued': 'Queued',
        'sources.status.parsing': 'Parsing',
        'sources.status.compiling': 'Compiling',
        'sources.status.ready': 'Ready',
        'sources.status.failed': 'Failed',
        'sources.openPage': 'Open summary page',
        'sources.failedTip': 'Failed: {message}',
        'sources.retry': 'Recompile',
        'sources.retryFailed': 'Recompile failed: {message}',
        'sources.retrying': 'Recompiling…',
        'sources.delete': 'Delete material',
        'sources.deleteConfirm': 'Delete “{title}” and its summary page?',
        'sources.deleteConfirmHint': 'Entity and topic pages will drop references to this source.',
        'sources.deleteAction': 'Delete',
        'sources.deleting': 'Deleting…',
        'sources.deleted': 'Deleted material “{title}”',
        'sources.deleteFailed': 'Delete failed: {message}',
        'sources.noPage': 'This material has no summary page yet',
        'sources.kind.file': 'File',
        'sources.kind.url': 'Link',
        'sources.kind.article': 'Article',
        'sources.kind.text': 'Pasted',
        'sources.kind.note': 'Note',
        'sources.kind.path': 'Local file',
        'sources.pageCount': '{n} page(s)',
        'sources.pageDesc': 'All uploaded files, links and notes live here — check compilation status, recompile or delete.',
        'sources.createdAt': 'Created {time}',
        'sources.add': 'Add material',
        'sources.addDesc': 'Upload a document, ingest a link, or paste text; materials appear here once compiled.',
        'sources.filterLabel': 'Filter materials by status',
        'sources.filter.all': 'All',
        'sources.filter.ready': 'Ready',
        'sources.filter.failed': 'Failed',
        'sources.filter.busy': 'Working',
        'sources.filterPlaceholder': 'Search materials…',
        'sources.filterEmpty': 'No materials match the filter',
        'sources.filterEmptyHint': 'Try another keyword or status.',
        'sources.filterClear': 'Clear filter',
        'sources.emptyHint': 'Upload a document, ingest a link or paste text; materials show up here after compiling.',
        'sources.selectAll': 'Select all',
        'sources.deselectAll': 'Deselect all',
        'sources.openMaterial': 'Open material',
        'sources.openConversation': 'Open conversation',
        'sources.relatedCount': '{n} related knowledge pages',
        'sources.manageTip': 'Manage on the Materials tab',
        'groups.title': 'Pages',
        'groups.empty': 'No pages generated yet',
        'groups.type.source': 'Summaries',
        'groups.type.entity': 'Entities',
        'groups.type.topic': 'Topics',
        'groups.type.synthesis': 'Synthesis',
        'groups.type.other': 'Other',
        'init.title': 'Initialize the knowledge base',
        'init.desc': 'Create a local Markdown Wiki: raw materials, summary pages, entity pages, topic pages, index and graph. Materials are compiled once, then maintained over time.',
        'init.button': 'Initialize',
        'init.busy': 'Initializing…',
        'init.failed': 'Initialization failed: {message}',
        'init.done': 'Knowledge base is ready',
        'init.rootTip': 'Will be created at {path}',
        'init.emptyAside': 'Knowledge base is not initialized',
        'overview.title': 'Overview',
        'overview.purpose': 'Research direction',
        'overview.purposeHint': 'Describe your research goal or focus; compiling uses it to organize pages.',
        'overview.purposeEmpty': 'No research direction yet — you can add it here.',
        'overview.purposeSave': 'Save',
        'overview.purposeSaving': 'Saving…',
        'overview.purposeSaved': 'Research direction saved',
        'overview.purposeFailed': 'Save failed: {message}',
        'overview.purposeTooLong': 'Research direction is limited to {n} chars',
        'overview.purposeCounter': '{n}/{max}',
        'overview.stats.sources': 'Materials',
        'overview.stats.entities': 'Entities',
        'overview.stats.topics': 'Topics',
        'overview.stats.pages': 'Pages',
        'overview.recentPages': 'Recently updated',
        'overview.recentSources': 'Recent materials',
        'overview.noRecentPages': 'No pages yet',
        'overview.noRecentSources': 'No materials yet',
        'overview.graphPreview': 'Graph preview',
        'overview.openGraph': 'Open graph',
        'overview.model': 'Compile model',
        'overview.modelLabel': 'Compile model: {model}',
        'overview.rootDir': 'Root folder',
        'overview.loading': 'Loading overview…',
        'overview.failed': 'Could not load overview: {message}',
        'overview.empty.title': 'The knowledge base is empty',
        'overview.empty.hint': 'Upload a document, ingest a link or paste text on the left. After compiling, the research direction, stats and recent updates appear here.',
        'overview.charTotal': '{n} chars total',
        'page.reading': 'Reading page…',
        'page.failed': 'Could not load page: {message}',
        'page.back': 'Back to overview',
        'page.backConversations': 'Back to AI Conversations',
        'page.notFound': 'The page does not exist or was deleted',
        'page.type.source': 'Summary',
        'page.type.entity': 'Entity',
        'page.type.topic': 'Topic',
        'page.type.synthesis': 'Synthesis',
        'page.type.excerpt': 'Excerpt',
        'page.type.original': 'Original',
        'page.type.chapter': 'Chapter',
        'page.type.evidence': 'Evidence',
        'page.fullText': 'Read full text',
        'page.evidenceLines': 'Source lines {start}–{end}',
        'page.excerptOrigin': 'From AI Reader. Manage this passage in Excerpt notes.',
        'page.excerptSource': 'Source: ',
        'page.confidence.EXTRACTED': 'Extracted',
        'page.confidence.INFERRED': 'Inferred',
        'page.confidence.AMBIGUOUS': 'Ambiguous',
        'page.confidence.UNVERIFIED': 'Unverified',
        'page.aliases': 'Aliases',
        'page.aliasesLabel': 'Aliases: ',
        'page.aliasesSeparator': ', ',
        'page.backlinks': 'Backlinks',
        'page.backlinksEmpty': 'No other page links here yet',
        'page.sources': 'Source materials',
        'page.sourcesEmpty': 'No linked sources',
        'page.openSource': 'Open summary page',
        'page.openOriginal': 'Open original',
        'page.openOriginalUrl': 'Open original page',
        'source.original.title': 'Original',
        'source.detail.title': 'Material details',
        'source.detail.sections': 'Material contents',
        'source.detail.summary': 'Summary',
        'source.detail.aiSummary': 'AI-generated summary',
        'source.detail.openSummary': 'Open summary page',
        'source.detail.excerpts': 'Excerpts {n}',
        'source.detail.excerptUnavailable': 'Reading assistant excerpts are temporarily unavailable.',
        'source.detail.related': 'Related knowledge {n}',
        'source.detail.documentNote': 'Notes on this document',
        'source.detail.versions': 'Text editions {n}',
        'source.detail.currentVersion': 'Current edition',
        'source.original.open': 'View original',
        'source.original.short': 'Original',
        'source.original.loading': 'Reading local original…',
        'source.original.failed': 'Could not read the original: {message}',
        'source.original.empty': 'No readable original text (the file may be missing, or only a binary original exists).',
        'source.original.copy': 'Copy text',
        'source.original.copied': 'Original copied',
        'source.original.openFile': 'Open original file',
        'source.original.openUrl': 'Open original page',
        'source.original.binaryHint': 'This shows the text extracted from the original file; use “Open original file” to download or preview it.',
        'page.sourceStatus': 'Status: {status}',
        'page.wikiMissing': 'Not created yet',
        'page.wikiTip': 'Open “{title}”',
        'page.wikiMissingTip': '“{title}” has not been created yet',
        'page.pathTip': 'Page path: {path}',
        'page.copyPath': 'Copy page path',
        'page.pathCopied': 'Page path copied',
        'page.charCount': '{n} chars',
        'graph.explore': "Related reading",
        'graph.map': "Topic map",
        "graph.hiddenLabels": "{n} labels are hidden. Hover over a node or zoom in to reveal them.",
        "graph.moreMatches": "{n} more results. Refine your search or press Enter to browse them.",
        "graph.matchPages": "Matching pages",
        "graph.mapLimit": "Map limit reached. Continue using the connection list.",
        "graph.allHint": "Only some labels appear in the full map. Search or select a node to explore locally.",
        "graph.groupHint": "Showing pages in this topic. Select a node to see its direct connections.",
        "graph.localHint": "Only direct connections are shown. Select another node to explore its connections.",
        "graph.expandMore": "Show {n} more pages",
        "graph.shown": "Showing {shown} of {total} pages",
        "graph.back": "Go back",
        "graph.localMap": "Direct connections",
        "graph.allMap": "All relationships",
        "graph.ungroupedHint": "These pages have no link to an existing topic. Explore them here.",
        "graph.ungrouped": "Without a topic link",
        "graph.groupShared": "A page may appear in several topics; groups are browsing entry points.",
        "graph.groupCounts": "{topics} topics \u00b7 {pages} linked pages",
        "graph.overviewHint": "Grouped by the topic outline and existing page links. Open a topic, then follow its connections.",
        "graph.overviewTitle": "Start with a topic",
        "graph.overview": "Topic overview",
        'graph.purpose': "Choose a topic to find related pages, quoted context, and original sources.",
        'graph.catalog': "Choose a starting point",
        'graph.browseCatalog': 'Browse outline',
        'common.moreActions': 'More actions',
        'common.more': 'More',
        'graph.mode.topics': "Topic outline",
        'graph.mode.bridges': "Across sources",
        'graph.mode.isolated': "Unlinked pages",
        'graph.mode.all': "All pages",
        'graph.mode.topics.hint': "Expand topics into subtopics, create a topic, or change its parent.",
        'graph.mode.bridges.hint': "These pages draw on multiple sources. Shared coverage does not imply agreement.",
        'graph.mode.isolated.hint': "These pages have no explicit references or source links. Read them before deciding whether to connect them.",
        'graph.mode.all.hint': "Browse every page; search also matches aliases and tags.",
        'graph.catalogEmpty': "No matches in this category. Try all pages or clear the search.",
        'graph.sourcesCount': "{n} source materials",
        'graph.more': "Show {n} more",
        'graph.welcome.title': "Turn one page into a reading trail",
        'graph.welcome.desc': "Choose a topic on the left. Preview the page, follow its references, or check the source material.",
        'graph.welcome.bridges': "Read across sources",
        'graph.welcome.topics': "Start with these topics",
        'graph.preview': "Page preview",
        'graph.previewLoading': "Loading page\u2026",
        'graph.previewEmpty': "No preview paragraph. Open the page to read it.",
        'graph.provenance': "Source materials",
        'graph.noSources': "No traceable source material is recorded for this page.",
        'graph.references': "What to read next",
        'graph.linkOut': "Referenced by this page",
        'graph.linkIn': "References this page",
        'graph.linkBoth': "Mutual references",
        'graph.derivedIn': "Compiled from this source",
        'graph.derivedOut': "Compiled from this material",
        'graph.evidence': "Show reference context",
        'graph.evidenceHide': "Hide reference context",
        'graph.evidenceMissing': "No context paragraph was found. Open the referencing page to check.",
        'graph.evidenceFrom': "Reference from: {title}",
        'graph.evidenceCaveat': "References show explicit page links; source links show where a page was compiled from. Links alone do not establish agreement, disagreement, or causation.",
        'graph.return': "Back to related reading",
        "taxonomy.entityCategory": "Entity category",
        "taxonomy.category.all": "All categories",
        "taxonomy.category.company": "Companies",
        "taxonomy.category.technology": "Technologies",
        "taxonomy.category.task": "Tasks",
        "taxonomy.category.product": "Products",
        "taxonomy.category.person": "People",
        "taxonomy.category.organization": "Organizations",
        "taxonomy.category.concept": "Concepts",
        "taxonomy.category.metric": "Metrics",
        "taxonomy.category.document": "Documents & rules",
        "taxonomy.category.other": "Other",
        "taxonomy.category.unassigned": "Unclassified",
        "taxonomy.categoryEmpty": "No entities match this category. Choose another category or clear search.",
        "taxonomy.chooseCategory": "Choose a category",
        "taxonomy.parent": "Parent topic",
        "taxonomy.root": "No parent (top-level topic)",
        "taxonomy.parentHint": "Topics can have multiple levels. Moving a topic keeps its children attached.",
        "taxonomy.organize": "Change organization",
        "taxonomy.createTopic": "Create topic",
        "taxonomy.addChild": "Add subtopic",
        "taxonomy.topicTitle": "Topic name",
        "taxonomy.expand": "Expand {title}",
        "taxonomy.collapse": "Collapse {title}",
        "taxonomy.children": "Subtopics ({n})",
        "taxonomy.breadcrumb": "Topic path",
        "taxonomy.relation": "Topic hierarchy",
        "taxonomy.parentRelation": "Part of parent topic",
        "taxonomy.childRelation": "Contains subtopic",
        "graph.mode.entities": "Entity categories",
        "graph.mode.entities.hint": "Browse companies, technologies, tasks, products, and more. Categories can be changed.",
        'tab.books': "Books",
        'books.title': "Books",
        'books.subtitle': "A separate knowledge base for each book.",
        'books.import': "Import books",
        'books.importing': "Importing\u2026",
        'books.importHint': "EPUB, text-based PDF, TXT, Markdown, and DOCX; up to {size} per book. A single upload starts a reading with your current model. Batch imports can be started individually.",
        'books.mode.analysis': 'Deep reading',
        'reading.title': 'Understand this book',
        'reading.promise': 'Follow the questions, arguments, examples, and conditions.',
        'reading.start': 'Start reading',
        'reading.resume': 'Continue reading',
        'reading.pause': 'Pause reading',
        'reading.scope': '{n} recognized sections · {chars} characters',
        'reading.partialSource': 'Some images or content could not be extracted. This reading covers recognized text only, not the complete original.',
        'reading.textScope': 'Based on recognized text. Images and charts in the original have not been reviewed separately.',
        'reading.selected': 'Reading {n} substantive sections.',
        'reading.excluded.sections': 'Skipped {n} non-content sections',
        'reading.excluded.passages': 'Skipped {n} promotional passages',
        'reading.excluded.original': 'Excluded from explanations, cards, and diagrams. The original file and chapter text are retained.',
        'reading.reason.preface': 'Preface / foreword',
        'reading.reason.title-page': 'Title / credits page',
        'reading.reason.copyright': 'Copyright / publication details',
        'reading.reason.contents': 'Table of contents',
        'reading.reason.dedication': 'Dedication',
        'reading.reason.acknowledgements': 'Acknowledgements',
        'reading.reason.publisher-note': 'Publisher note',
        'reading.reason.promotion': 'Promotion / download advert',
        'reading.reason.divider': 'Section title only',
        'reading.reason.author-info': 'Author biography',
        'reading.parseNotes': 'Source parsing notes',
        'reading.progress': '{n}/{total} reading parts saved',
        'reading.progressLabel': 'Chapter reading and synthesis progress',
        'reading.stats': 'About {minutes} minutes · {cards} cards · {diagrams} diagrams (estimated at 300 characters per minute)',
        'reading.intro': 'Read the selected content and explain its ideas directly in a first-person teaching voice, retaining mechanisms, examples, and limits.',
        'reading.view.read': 'Quick deep read',
        'reading.view.cards': 'Knowledge cards',
        'reading.view.diagrams': 'Diagrams & maps',
        'reading.preview.read': 'A condensed explanation with reasoning and examples. Expand chapters for more detail.',
        'reading.preview.cards': 'Concepts with explanations, examples, boundaries, and source locations.',
        'reading.preview.diagrams': 'A map of ideas, plus workflows where the book provides actual steps.',
        'reading.resumeHint': 'Uses your current DSH model. Long books require multiple calls. Progress is saved after each part and can be resumed.',
        'reading.views': 'Reading views',
        'reading.synthesisPending': 'Completed sections are available now. The whole-book reading and diagrams follow when every part is complete.',
        'reading.chapterReading': 'Explore individual sections',
        'reading.source': 'Source',
        'reading.sources': 'View sources ({n})',
        'reading.inference': 'Editorial synthesis',
        'reading.searchCards': 'Find knowledge cards',
        'reading.searchPlaceholder': 'Concept, method, or chapter',
        'reading.allCards': 'Show all {n} cards',
        'reading.noCards': 'No matching knowledge cards.',
        'reading.expandCard': 'Expand card',
        'reading.openCard': 'Expand card: {title}',
        'reading.collapseCard': 'Collapse card',
        'reading.example': 'Example in the book',
        'reading.boundary': 'Conditions and limits',
        'reading.diagrams': 'Choose a diagram',
        'reading.noDiagrams': 'There is not enough source material for a diagram. See the reading and cards.',
        'reading.diagramHint': 'Select a concept for explanations and examples. Blue links highlight its connections; dashed links indicate editorial synthesis.',
        'reading.nodes': 'Knowledge nodes',
        "reading.author": "Book claim",
        "reading.mapScope": "Relationship scope",
        "reading.wholeMap": "Whole map",
        "reading.localMap": "Current connections",
        "reading.expandMap": "Expand diagram",
        "reading.collapseMap": "Close diagram",
        "reading.nodeNumber": "Concept {n}",
        "reading.nodeSections": "{n} source sections",
        "reading.connected": "Connections · {n}",
        "reading.noConnections": "No connections have been recorded for this concept.",
        "reading.followNode": "Explore: {title}",
        "reading.mapStats": "{nodes} concepts · {edges} relationships",
        "reading.kind.map": "Knowledge map",
        "reading.kind.flow": "Workflow",
        "reading.kind.causal": "Causal map",
        "reading.sameSectionCards": "Cards from these sections · {n}",
        "reading.sameSectionHint": "These cards come from the sections cited by this concept. Expand for explanations, examples, and limits.",
        "reading.deepReading": "Chapter explanations · {n}",
        "reading.studyUnavailable": "Chapter explanations are unavailable. Read the concept and its sources above.",
        'reading.relations': 'Explore relationships',
        'reading.state.empty': 'No reading generated yet',
        'reading.state.running': 'Reading in progress',
        'reading.state.ready': 'Reading available',
        'reading.state.paused': 'Reading paused',
        'reading.state.failed': 'Reading needs retry',
        'reading.state.stale': 'Reading needs updating',
        'books.importProgress': "Saving and identifying sections in {name}\u2026",
        'books.emptyTitle': "Turn a book into a knowledge base",
        'books.emptyHint': "The original, sections, extracted knowledge, and answers stay within this book. They are not automatically merged into your main library or other books.",
        'books.loading': "Loading books\u2026",
        'books.open': "Open book knowledge base",
        'books.back': "Back to books",
        'books.delete': "Delete book",
        'books.deleteTitle': "Delete {title}?",
        'books.deleteHint': "This permanently deletes the original, sections, and knowledge pages for this book. Other books and the main library are unaffected.",
        'books.tooLarge': "{name} exceeds the {size} limit per book.",
        'books.unsupported': "Choose an EPUB, PDF, TXT, Markdown, or DOCX file.",
        'books.status.imported': "Not extracted",
        'books.status.running': "Extracting",
        'books.status.paused': "Paused",
        'books.status.partial': "Partially complete",
        'books.status.ready': "Complete",
        'books.status.failed': "Failed",
        'books.progress': "{done}/{total} sections completed \u00b7 {pages} knowledge pages",
        'books.incomplete': "Some original text was not identified. Only identified text is processed; check the warnings and original.",
        'books.coverageUnknown': "Text recognition completeness needs checking. Section progress does not establish complete coverage of the original book.",
        'books.coveragePartialShort': "Partial text coverage",
        'books.coverageUnknownShort': "Text coverage unverified",
        'books.isolatedScope': "Knowledge, search, and answers are scoped to this book; they are not automatically written to the main library.",
        'books.originalFile': "Open original",
        'books.extract': "Extract knowledge",
        'books.resume': "Continue unfinished sections",
        'books.pause': "Pause extraction",
        'books.actionWorking': "Working\u2026",
        'books.extractionDetails': "Text and extraction",
        'books.extractionHint': "{chars} characters identified. Extraction uses the current model and can be paused and resumed.",
        'books.warnings': "View {n} processing notes",
        'books.notFound': "This book is unavailable or has been deleted.",
        'books.contentLabel': "Book content",
        'books.mode.knowledge': "Knowledge pages",
        'books.mode.ask': "Ask this book",
        'books.chapterCount': "{n} chapters or sections identified",
        'books.originalChapter': "Original text",
        'books.knowledgePage': "Book knowledge page",
        'books.citation': "Source",
        'books.openCitation': "Open citation {n}: {title}",
        'books.knowledgeEvidenceLines': "Knowledge page lines {start}–{end}",
        'books.chapterSources': "Read the original section",
        'books.chooseKnowledge': "Choose a knowledge page",
        'books.knowledgeHint': "Knowledge pages retain their source sections so you can check the original.",
        'books.noKnowledge': "No knowledge has been extracted yet. Start extraction above to create pages here.",
        'books.searchLabel': "Search this book",
        'books.searchPlaceholder': "Search concepts, topics, or text\u2026",
        'books.pageType': "Knowledge page type",
        'books.allPages': "All knowledge pages",
        'books.noMatches': "No matching knowledge pages in this book.",
        'books.reading': "Loading book content\u2026",
        'books.askScope': "Answers draw from this book's text and knowledge pages. Open a citation to check the source.",
        'books.askEmpty': "Start with a question",
        'books.askHint': "Ask about the central argument, connections between concepts, or the source of a claim.",
        'books.askNeedsExtraction': "Import a book to ask questions about its recognized chapters.",
        'books.askLabel': "Ask this book",
        'books.askPlaceholder': "What is the author's central argument?",
        'books.askKeys': "Return to send · Shift + Return for a new line",
        'books.stopAnswer': "Stop answer",
        'books.askStopped': "Answer stopped; generated text is retained.",
        'books.askInterrupted': "Answer interrupted. You can ask again.",
        'books.searchLimited': 'Found {total} results; showing the first {shown}. Narrow your search to find more.',
        'books.currentChapter': 'Processing: {title}',
        'graph.title': 'Knowledge graph',
        'graph.loading': 'Loading graph…',
        'graph.failed': 'Could not load graph: {message}',
        'graph.empty.title': 'The graph is empty',
        'graph.empty.hint': 'After materials are compiled, links between entities, topics and sources appear here.',
        'graph.reload': 'Re-layout',
        'graph.refresh': 'Refresh data',
        'graph.truncated': 'Too many nodes — showing the top {shown}/{total} by degree',
        'graph.nodes': '{n} nodes',
        'graph.edges': '{n} links',
        'graph.legend.source': 'Material',
        'graph.legend.entity': 'Entity',
        'graph.legend.topic': 'Topic',
        'graph.legend.synthesis': 'Synthesis',
        'graph.hint': 'Click a node to open its page; hover to see the title',
        'graph.searchPlaceholder': 'Search titles, aliases, tags…',
        'graph.searchClear': 'Clear search',
        'graph.searchMatches': '{n} match(es)',
        'graph.searchEmpty': 'No matching nodes',
        'graph.filterTypes': 'Filter by type and relation',
        'graph.filterShowAll': 'Show all',
        'graph.relation.link': 'Body link',
        'graph.relation.derived': 'Source-derived',
        'graph.relation.ceo': 'CEO',
        'graph.ceoDirection': '{person} serves as CEO of {company}',
        'graph.ceoSource': 'View the passage supporting this CEO relationship',
        'graph.ceoSourceNamed': 'View the CEO relationship evidence in {title}',
        'graph.zoomIn': 'Zoom in',
        'graph.zoomOut': 'Zoom out',
        'graph.fit': 'Fit to view',
        'graph.panHint': 'Drag to pan · scroll to zoom · select a node to explore · read the full page in details',
        'graph.stats': '{nodes} nodes · {edges} links',
        'graph.isolated': '{n} isolated page(s)',
        'graph.detail': 'Node details',
        'graph.detail.close': 'Close details',
        'graph.detail.degree': '{n} connection(s)',
        'graph.detail.open': 'Read page',
        'graph.detail.neighbors': 'Neighbors ({n})',
        'graph.detail.noNeighbors': 'Isolated page: no links yet',
        'graph.detail.focus': 'Focus neighbors',
        'graph.detail.unfocus': 'Show all',
        'graph.filterEmpty': 'No visible nodes with the current filters',
        'graph.filteredStats': 'Showing {nodes}/{totalNodes} nodes · {edges}/{totalEdges} links',
        'ask.title': 'Ask the knowledge base',
        'ask.subtitle': 'Answers are based only on the knowledge base, with cited pages.',
        'ask.placeholder': 'Ask about the knowledge base…',
        'ask.keys': 'Enter to send · Shift+Enter for a new line',
        'ask.send': 'Send',
        'ask.stop': 'Stop',
        'ask.thinking': 'Thinking…',
        'ask.stopped': 'Stopped',
        'ask.retry': 'Retry',
        'ask.retrying': 'Retrying…',
        'ask.empty.title': 'Ask the knowledge base',
        'ask.empty.hint': 'For example: “What is this knowledge base about?” or “Summarize everything about X.”',
        'ask.noSources': 'No pages matched — the answer may rely on general knowledge',
        'ask.sources': 'Source passages',
        'ask.failed': 'Q&A failed: {message}',
        'ask.streamInterrupted': 'The answer stream was interrupted. Please retry.',
        'ask.emptyAnswer': 'The model returned no content. Please retry.',
        'ask.clear': 'Clear conversation',
        'ask.you': 'You',
        'ask.ai': 'Knowledge Base',
        'ask.errNoModel': 'No model provider/model is configured. Choose a default model in Harness first.',
        'ask.errNoKb': 'The knowledge base is still empty. Add materials before asking.',
        'ask.historyHint': 'Recent turns are included as context',
        'ask.openSource': 'Open cited page',
        'health.title': 'Health check',
        'health.desc': 'Checks orphan pages, broken links, missing sources, empty pages and duplicate titles.',
        'health.run': 'Run check',
        'health.running': 'Checking…',
        'health.failed': 'Health check failed: {message}',
        'health.good': 'The knowledge base is healthy',
        'health.goodHint': 'No orphan pages, broken links or missing sources found.',
        'health.summary': 'Pages {pages} · Links {links} · Issues {issues}',
        'health.issueCount': '{n} issue(s)',
        'health.empty.title': 'No check run yet',
        'health.empty.hint': 'Use the button above to verify knowledge base links and pages.',
        'health.type.orphan-page': 'Orphan page',
        'health.type.broken-link': 'Broken link',
        'health.type.missing-source': 'Missing source',
        'health.type.empty-page': 'Empty page',
        'health.type.duplicate-title': 'Duplicate title',
        'health.type.unknown': 'Other issue',
        'health.severity.error': 'Error',
        'health.severity.warn': 'Warning',
        'health.severity.warning': 'Warning',
        'health.severity.info': 'Info',
        'health.pageTarget': 'Page: {page}',
        'health.openPage': 'Open page',
        'health.noPage': 'No related page',
        'health.errors': '{n} error(s)',
        'health.warnings': '{n} warning(s)',
        'health.checkedAt': 'Checked at {time}',
        /* ---- Appendix A: content management (edit / delete / batch / trash) ---- */
        'dialog.close': 'Close',
        'dialog.cancel': 'Cancel',
        'dialog.working': 'Working…',
        'confirm.irreversible': 'This action permanently deletes data and cannot be undone.',
        'edit.title': 'Edit page',
        'edit.subtitle': 'Manual edits are marked as user-edited; recompiling the source may overwrite the summary page body.',
        'edit.field.title': 'Title',
        'edit.field.aliases': 'Aliases',
        'edit.field.tags': 'Tags',
        'edit.field.confidence': 'Confidence',
        'edit.field.markdown': 'Body (Markdown)',
        'edit.aliasesHint': 'Comma-separated; may be empty',
        'edit.tagsHint': 'Comma-separated; may be empty',
        'edit.titleRequired': 'Title is required',
        'edit.titleTooLong': 'Title is limited to {n} characters',
        'edit.markdownTooShort': 'Body must be at least {n} characters',
        'edit.markdownTooLong': 'Body is limited to {n} characters',
        'edit.tooManyAliases': 'At most {n} aliases',
        'edit.tooManyTags': 'At most {n} tags',
        'edit.itemTooLong': 'Each item is limited to {n} characters',
        'edit.save': 'Save',
        'edit.saving': 'Saving…',
        'edit.saved': 'Page saved',
        'edit.savedTitle': 'Saved',
        'edit.failed': 'Save failed: {message}',
        'edit.rewrittenLinks': '{n} reference(s) rewritten',
        'edit.warnings': 'Warnings ({n})',
        'edit.discardTitle': 'Discard unsaved changes?',
        'edit.discardDesc': 'Your edits will be lost if you close now.',
        'edit.discardAction': 'Discard',
        'edit.keepEditing': 'Keep editing',
        'edit.userEditedTip': 'This page was edited manually ({time}); recompiling the source may overwrite the body.',
        'edit.sourceTip': 'This is a summary page: recompiling the source will overwrite your manual edits.',
        'page.edit': 'Edit',
        'page.delete': 'Delete',
        'page.deleteTitle': 'Delete page',
        'page.deleteDesc': '“{title}” will be moved to Trash and can be restored from Health → Trash. Links pointing to it will be downgraded to plain text.',
        'page.deleteAction': 'Delete page',
        'page.deleting': 'Deleting…',
        'page.deleted': 'Moved to Trash — restore it from Health → Trash',
        'page.deleteFailed': 'Could not delete page: {message}',
        'page.userEdited': 'Manually edited {time}',
        'manage.enter': 'Manage',
        'manage.exit': 'Done',
        'manage.selected': '{n} selected',
        'manage.cancel': 'Cancel',
        'manage.delete': 'Delete selected',
        'manage.deleteSourcesTitle': 'Permanently delete {n} source(s)?',
        'manage.deleteSourcesDesc': 'Source files, summary pages and entity/topic pages referenced only by them will be permanently deleted. This cannot be undone.',
        'manage.deletePagesTitle': 'Delete {n} page(s)?',
        'manage.deletePagesDesc': 'Selected pages move to Trash and can be restored from Health → Trash; affected links are downgraded to plain text.',
        'manage.deleteSourcesAction': 'Delete permanently',
        'manage.deletePagesAction': 'Move to Trash',
        'manage.deleting': 'Deleting…',
        'manage.deletedSources': 'Deleted {n} source(s)',
        'manage.deletedPages': 'Deleted {n} page(s)',
        'manage.skipped': 'Skipped {n} item(s)',
        'manage.failed': 'Operation failed: {message}',
        'manage.sourceNotSelectable': 'Manage summary pages from the materials list',
        'manage.emptySources': 'No sources to delete',
        'manage.emptyPages': 'No pages to delete',
        'manage.moreItems': '…and {n} more',
        'trash.title': 'Trash ({n})',
        'trash.loading': 'Loading trash…',
        'trash.failed': 'Could not load trash: {message}',
        'trash.empty': 'Trash is empty',
        'trash.deletedAt': 'Deleted {time}',
        'trash.restore': 'Restore',
        'trash.restoring': 'Restoring…',
        'trash.restored': 'Restored “{title}”',
        'trash.restoredWithTarget': 'Restored “{title}” → {path}',
        'trash.restoreFailed': 'Restore failed: {message}',
        'trash.purge': 'Delete permanently',
        'trash.purgeTitle': 'Delete page permanently',
        'trash.purgeDesc': '“{title}” will be permanently deleted and cannot be restored.',
        'trash.purgeAction': 'Delete permanently',
        'trash.purgeFailed': 'Permanent delete failed: {message}',
        'trash.purged': 'Permanently deleted',
        'trash.clear': 'Empty trash',
        'trash.clearTitle': 'Empty trash?',
        'trash.clearDesc': 'The {n} page(s) in Trash will be permanently deleted and cannot be restored.',
        'trash.clearAction': 'Empty trash',
        'trash.cleared': 'Trash emptied',
        'trash.clearFailed': 'Could not empty trash: {message}',
        'trash.note': 'Restoring a page does not restore backlinks that were downgraded; edit the page or recompile the source.',
        'trash.reload': 'Refresh trash',
        'trash.sourceCount': '{n} source(s)',
        'sources.recompileTitle': 'Recompile source',
        'sources.recompileDesc': 'The summary page for “{title}” was edited manually; recompiling will overwrite the body. Continue?',
        'sources.recompileAction': 'Recompile',
        /* ---- Apple visual system (DESIGN.md) ---- */
        'tablist.label': 'Panel sections',
        'job.progressAria': 'Compile progress',
        'graph.toolsLabel': 'Graph tools',
        'graph.legendLabel': 'Legend',
        'notices.label': 'Notifications',
        'header.copyPath': 'Copy knowledge base path',
        'header.navigation': 'Browse library',
        'reader.actionsLabel': 'Page actions',
      }

      // ======================================================================
      // 通用工具（字符串 / 时间 / 字节 / 复制）
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
        return fallback || ''
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

      /**
       * 格式化字节数为可读文案（1.2 MB / 340 KB）。
       * @param {number} bytes 字节数。
       * @returns {string}
       */
      function formatBytes(bytes) {
        const value = Number(bytes)
        if (!isFinite(value) || value <= 0) return '0 B'
        if (value < 1024) return Math.round(value) + ' B'
        if (value < 1024 * 1024) return (value / 1024).toFixed(1).replace(/\.0$/, '') + ' KB'
        if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB'
        return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB'
      }

      /**
       * 把 ISO 时间格式化为 MM-DD HH:mm（无效值返回空串）。
       * @param {string} iso ISO 时间串。
       * @returns {string}
       */
      function formatTime(iso) {
        const text = String(iso == null ? '' : iso)
        if (!text) return ''
        const date = new Date(text)
        if (isNaN(date.getTime())) return ''
        const pad = function (value) {
          return value < 10 ? '0' + value : String(value)
        }
        return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      }

      /**
       * 把 ISO 时间格式化为 YYYY-MM-DD HH:mm。
       * @param {string} iso ISO 时间串。
       * @returns {string}
       */
      function formatDateTime(iso) {
        const text = String(iso == null ? '' : iso)
        if (!text) return ''
        const date = new Date(text)
        if (isNaN(date.getTime())) return ''
        const pad = function (value) {
          return value < 10 ? '0' + value : String(value)
        }
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      }

      /**
       * 数值夹紧。
       * @param {number} value 输入值。
       * @param {number} min 下界。
       * @param {number} max 上界。
       * @returns {number}
       */
      function clampNumber(value, min, max) {
        const number = Number(value)
        if (!isFinite(number)) return min
        return Math.min(Math.max(number, min), max)
      }

      /**
       * 取字符串值；非字符串返回空串。
       * @param {any} value 任意值。
       * @returns {string}
       */
      function asString(value) {
        return typeof value === 'string' ? value : ''
      }

      /**
       * 判断是否是 http(s) 绝对链接。
       * @param {string} value 输入。
       * @returns {boolean}
       */
      function isHttpUrl(value) {
        return /^https?:\/\/[^\s]+$/i.test(String(value == null ? '' : value).trim())
      }

      /**
       * 去掉 Markdown 正文里的 HTML 注释（编译落盘的 `<!-- kb-source:… -->`
       * 标记等）。围栏代码块内的内容保持原样，避免破坏示例代码。
       * @param {string} text Markdown 源文本。
       * @returns {string} 清理后的文本。
       */
      function stripHtmlComments(text) {
        const source = String(text == null ? '' : text)
        if (source.indexOf('<!--') < 0) return source
        const lines = source.split('\n')
        const out = []
        let inFence = false
        let inComment = false
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]
          if (!inComment && /^\s*(```|~~~)/.test(line)) {
            inFence = !inFence
            out.push(line)
            continue
          }
          if (inFence) {
            out.push(line)
            continue
          }
          let current = line
          let guard = 0
          while (current.length > 0 && guard < 20) {
            guard += 1
            if (inComment) {
              const commentEnd = current.indexOf('-->')
              if (commentEnd < 0) {
                current = ''
                break
              }
              inComment = false
              current = current.slice(commentEnd + 3)
              continue
            }
            const start = current.indexOf('<!--')
            if (start < 0) break
            const end = current.indexOf('-->', start + 4)
            if (end < 0) {
              inComment = true
              current = current.slice(0, start)
              break
            }
            current = current.slice(0, start) + current.slice(end + 3)
          }
          out.push(current)
        }
        return out.join('\n')
      }

      /**
       * 把 Markdown 摘要净化成可扫读的纯文本（搜索结果的 snippet）。
       * @param {string} text 原始摘要。
       * @returns {string} 纯文本摘要（过长时截断）。
       */
      function cleanSearchSnippet(text, maxLength) {
        let value = String(text == null ? '' : text)
        if (!value) return ''
        value = stripHtmlComments(value)
        value = value
          .replace(/\r\n?/g, '\n')
          .replace(/^\s{0,3}#{1,6}\s+/gm, '')
          .replace(/\[\[([^[\]]+)\]\]/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/[*_~`>]+/g, '')
          .replace(/^\s{0,3}(?:[-+*]|\d+\.)\s+/gm, '')
          .replace(/\s+/g, ' ')
          .replace(/\s#{1,6}\s+/g, ' ')
          .replace(/\s[-+*]\s+/g, ' ')
          .trim()
        const limit = typeof maxLength === 'number' ? maxLength : 150
        if (value.length > limit) value = value.slice(0, limit) + '…'
        return value
      }

      /** A short opening paragraph keeps the exploration pane readable; the full page stays one action away. */
      function graphPageSummary(markdown) {
        const lines = stripHtmlComments(asString(markdown)).split('\n')
        const paragraph = []
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index].trim()
          if (!line || /^#/.test(line)) { if (paragraph.length) break; continue }
          if (/^\|/.test(line)) continue
          paragraph.push(line)
        }
        return cleanSearchSnippet(paragraph.join(' '), 260)
      }

      /**
       * 复制文本到剪贴板（优先 Clipboard API）。
       * @param {string} text 待复制文本。
       * @returns {Promise<boolean>} 是否成功。
       */
      async function copyText(text) {
        const value = String(text == null ? '' : text)
        if (!value) return false
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value)
            return true
          }
        } catch (error) {
          // 退化为失败，由调用方展示提示
        }
        return false
      }

      /**
       * 用 FileReader 把浏览器 File 读成 base64（去掉 data URL 前缀）。
       * @param {File} file 浏览器文件对象。
       * @returns {Promise<string>}
       */
      function readFileAsBase64(file, t) {
        return new Promise(function (resolve, reject) {
          if (typeof FileReader !== 'function') {
            reject(new Error(t('upload.readerUnavailable')))
            return
          }
          const reader = new FileReader()
          reader.onload = function () {
            const result = typeof reader.result === 'string' ? reader.result : ''
            const commaIndex = result.indexOf(',')
            if (commaIndex < 0) {
              reject(new Error(t('upload.readFailed')))
              return
            }
            resolve(result.slice(commaIndex + 1))
          }
          reader.onerror = function () {
            reject(reader.error || new Error(t('upload.readFailed')))
          }
          try {
            reader.readAsDataURL(file)
          } catch (error) {
            reject(error)
          }
        })
      }

      // ======================================================================
      // Host HTTP API 封装（统一 { ok, error:{code,message} } 解析 + abort 支持）
      // ======================================================================

      /** Host 返回的错误（带 code / status，便于分支处理）。 */
      class ApiError extends Error {
        /**
         * @param {string} message 用户可读错误文案。
         * @param {string} code 错误码。
         * @param {number} status HTTP 状态码（0 表示网络层失败）。
         */
        constructor(message, code, status) {
          super(message)
          this.name = 'ApiError'
          this.code = code || 'INTERNAL'
          this.status = typeof status === 'number' ? status : 0
        }
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
       * 调用 Host JSON 接口。GET 自动带 no-store，写请求自动 JSON 序列化。
       * @param {string} path 以 / 开头的路由（如 '/overview'）。
       * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] 请求选项。
       * @returns {Promise<any>} 解析后的 JSON（{ ok:true, ... }）。
       */
      async function api(path, options) {
        const opts = options || {}
        const method = opts.method || 'GET'
        const init = { method: method, signal: opts.signal }
        if (opts.body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(opts.body)
        }
        let response
        try {
          response = await fetch(ORIGIN + path, init)
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          throw new ApiError(fallbackT('error.network'), 'NETWORK', 0)
        }
        let data = null
        try {
          data = await response.json()
        } catch (error) {
          if (error && error.name === 'AbortError') throw error
          data = null
        }
        if (!response.ok) {
          const detail = data && data.error ? data.error : null
          throw new ApiError(
            detail && typeof detail.message === 'string' && detail.message ? detail.message : 'HTTP ' + response.status,
            detail && typeof detail.code === 'string' ? detail.code : 'HTTP_' + response.status,
            response.status,
          )
        }
        if (data && data.ok === false) {
          const detail = data.error || {}
          throw new ApiError(
            typeof detail.message === 'string' && detail.message ? detail.message : fallbackT('error.requestFailed'),
            typeof detail.code === 'string' ? detail.code : 'INTERNAL',
            response.status,
          )
        }
        if (!data || typeof data !== 'object') {
          throw new ApiError(fallbackT('error.badResponse'), 'BAD_RESPONSE', response.status)
        }
        return data
      }

      // ======================================================================
      // SSE 解析（/ask 流式回答）
      // ======================================================================

      /**
       * 解析一个 SSE 事件块（以空行分隔），把 `data:` 负载交给回调。
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
            console.warn('[dsh-kb] SSE 事件处理异常：' + errorMessage(error, 'unknown'))
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
      // 自写 Markdown 渲染器（返回 React 元素，绝不注入 HTML 字符串）
      // 支持：#/##/### 标题、段落、无序/有序列表、> 引用、``` 代码块、--- 分隔线、
      //       表格、**粗体**、*斜体*、`行内代码`、[文字](url)、[[Wiki 链接]]。
      // Wiki 链接按 page.links（title → path）解析，path 为 null 时渲染为不可点。
      // ======================================================================

      /** @type {RegExp} 行内语法（顺序：粗体 → 斜体 → 行内代码 → Wiki 链接 → 普通链接）。 */
      const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)\s]+\)|\[\d{1,3}\])/g

      /** @type {RegExp} Markdown 表格行（| a | b |）。 */
      const TABLE_ROW_PATTERN = /^\s{0,3}\|.*\|\s*$/
      /** @type {RegExp} Markdown 表格分隔行（| --- | --- |）。 */
      const TABLE_SEP_PATTERN = /^\s{0,3}\|[\s:|-]+\|\s*$/

      /**
       * 在 wikiMap 中解析 [[title]]（先精确匹配，再忽略大小写）。
       * @param {string} title 链接标题。
       * @param {any} options 渲染选项（含 wikiMap）。
       * @returns {{ title: string, path: string | null } | null}
       */
      function resolveWikiLink(title, options) {
        const map = options && options.wikiMap
        if (!map || typeof map.get !== 'function') return null
        const key = String(title == null ? '' : title).trim()
        const entry = map.get(key) || map.get(key.toLowerCase())
        if (!entry || typeof entry !== 'object') return null
        return { title: asString(entry.title) || key, path: typeof entry.path === 'string' && entry.path ? entry.path : null }
      }

      /**
       * 渲染一行 Markdown 行内语法。
       * @param {string} text 原始行内文本。
       * @param {string} keyPrefix React key 前缀。
       * @param {any} [options] 渲染选项（wikiMap / onOpenPath / t）。
       * @returns {any[]} React 子节点数组。
       */
      function renderInline(text, keyPrefix, options) {
        const source = String(text == null ? '' : text)
        if (!source) return []
        const opts = options || {}
        const t = typeof opts.t === 'function' ? opts.t : null
        const nodes = []
        let lastIndex = 0
        let match
        let tokenIndex = 0
        INLINE_PATTERN.lastIndex = 0
        while ((match = INLINE_PATTERN.exec(source)) !== null) {
          if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index))
          const token = match[0]
          const key = keyPrefix + '-inline-' + tokenIndex
          tokenIndex += 1
          if (token.slice(0, 2) === '**') {
            nodes.push(h('strong', { key: key }, token.slice(2, -2)))
          } else if (token.charAt(0) === '`') {
            nodes.push(h('code', { key: key, className: 'kb-md-code' }, token.slice(1, -1)))
          } else if (token.slice(0, 2) === '[[' && token.slice(-2) === ']]') {
            const title = token.slice(2, -2).trim()
            const wiki = resolveWikiLink(title, opts)
            if (wiki && wiki.path) {
              nodes.push(
                h(
                  'button',
                  {
                    key: key,
                    type: 'button',
                    className: 'kb-wikilink',
                    title: t ? t('page.wikiTip', { title: title }) : title,
                    onClick: function () {
                      if (typeof opts.onOpenPath === 'function') opts.onOpenPath(wiki.path)
                    },
                  },
                  title,
                ),
              )
            } else {
              nodes.push(
                h(
                  'span',
                  {
                    key: key,
                    className: 'kb-wikilink kb-wikilink-missing',
                    'data-missing': 'true',
                    title: t ? t('page.wikiMissingTip', { title: title }) : title,
                  },
                  title,
                ),
              )
            }
          } else if (token.charAt(0) === '[') {
            const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
            const label = link ? link[1] : token.slice(1, -1)
            const citation = opts.citations && opts.citations.find(function (entry) {
              return String(entry.citation) === label && entry.path
            })
            const rawTarget = link ? link[2] : ''
            if (citation && typeof opts.onOpenPath === 'function') {
              nodes.push(h('button', {
                key: key, type: 'button', className: 'kb-book-citation',
                title: citation.title,
                'aria-label': t ? t('books.openCitation', { n: label, title: citation.title }) : citation.title,
                onClick: function () { opts.onOpenPath(citation.path) },
              }, '[' + label + ']'))
            } else if (link && /^wiki\//.test(rawTarget)) {
              const path = rawTarget.replace(/^\/+/, '')
              nodes.push(
                h(
                  'button',
                  {
                    key: key,
                    type: 'button',
                    className: 'kb-wikilink',
                    title: t ? t('page.wikiTip', { title: link[1] }) : link[1],
                    onClick: function () {
                      if (typeof opts.onOpenPath === 'function') opts.onOpenPath(path)
                    },
                  },
                  link[1],
                ),
              )
            } else {
              const href = link ? safeHref(rawTarget) : null
              if (link && href) nodes.push(h('a', { key: key, href: href, target: '_blank', rel: 'noreferrer' }, link[1]))
              else nodes.push(token)
            }
          } else {
            nodes.push(h('em', { key: key }, token.slice(1, -1)))
          }
          lastIndex = match.index + token.length
        }
        if (lastIndex < source.length) nodes.push(source.slice(lastIndex))
        return nodes
      }

      /**
       * 把若干行渲染成带 <br> 的段落子节点。
       * @param {string[]} lines 段落内的行。
       * @param {string} keyPrefix React key 前缀。
       * @param {any} [options] 渲染选项。
       * @returns {any[]} React 子节点数组。
       */
      function renderPlainLines(lines, keyPrefix, options) {
        const nodes = []
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) nodes.push(h('br', { key: keyPrefix + '-br-' + index }))
          const inlineNodes = renderInline(lines[index], keyPrefix + '-line-' + index, options)
          for (let inner = 0; inner < inlineNodes.length; inner += 1) nodes.push(inlineNodes[inner])
        }
        return nodes
      }

      /**
       * 把表格行拆成单元格文本。
       * @param {string} line 表格行。
       * @returns {string[]}
       */
      function splitTableRow(line) {
        let text = String(line == null ? '' : line).trim()
        if (text.charAt(0) === '|') text = text.slice(1)
        if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1)
        return text.split('|').map(function (cell) {
          return cell.trim()
        })
      }

      /** Read-only rendering of archived GenUI tables/callouts. Never execute model-authored UI actions. */
      function renderDshUi(raw, key, options) {
        if (raw.length > 500000) return null
        let spec
        try { spec = JSON.parse(raw) } catch { return null }
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
        const items = Array.isArray(spec.items) ? spec.items : spec.type ? [spec] : null
        if (!items || !items.length || items.length > 100) return null
        if (spec.title !== undefined && typeof spec.title !== 'string') return null
        const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
        let cells = 0
        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return null
          if (item.title !== undefined && typeof item.title !== 'string') return null
          if (item.type === 'table') {
            if (!Array.isArray(item.columns) || !item.columns.length || item.columns.length > 24 || !item.columns.every(value => typeof value === 'string')) return null
            if (!Array.isArray(item.rows) || item.rows.length > 1000 || !item.rows.every(row => Array.isArray(row) && row.length <= item.columns.length && row.every(scalar))) return null
            // Interactive/computed tables keep their source rather than silently dropping behavior or data.
            if (item.details || item.total || item.filter || item.sortField || item.types) return null
            cells += item.rows.length * item.columns.length
            if (cells > 10000) return null
          } else if (item.type === 'callout') {
            if (typeof item.content !== 'string' || (item.tone !== undefined && !['info', 'success', 'warning', 'error'].includes(item.tone))) return null
          } else return null
        }
        const title = typeof spec.title === 'string' ? spec.title : ''
        const gap = typeof spec.gap === 'number' && Number.isFinite(spec.gap) ? Math.max(8, Math.min(24, spec.gap)) : 14
        const renderText = (value, prefix) => renderPlainLines(String(value == null ? '' : value).split('\n'), prefix, options)
        const t = resolveT(options)
        return h('section', { key, className: 'kb-dshui', 'aria-label': title || t('dshUi.region'), style: { gap: gap + 'px' } },
          title ? h('h3', { className: 'kb-dshui-title' }, title) : null,
          items.map((item, index) => {
            const itemKey = key + '-item-' + index
            if (item.type === 'callout') {
              const tone = item.tone || 'info'
              const label = t('dshUi.' + tone)
              return h('aside', { key: itemKey, className: 'kb-dshui-callout', 'data-tone': tone },
                h('div', { className: 'kb-dshui-callout-label' }, item.title || label),
                h('div', { className: 'kb-dshui-callout-content' }, renderText(item.content, itemKey)))
            }
            const label = item.title || (title ? title + ' · ' : '') + t('dshUi.table', { n: items.slice(0, index + 1).filter(entry => entry.type === 'table').length })
            return h('div', { key: itemKey, className: 'kb-dshui-table-wrap', role: 'region', tabIndex: 0, 'aria-label': label },
              h('table', { className: 'kb-dshui-table', 'aria-label': label, style: { minWidth: Math.min(720, item.columns.length * 160) + 'px' } },
                h('thead', null, h('tr', null, item.columns.map((column, col) => h('th', { key: col, scope: 'col' }, renderText(column, itemKey + '-head-' + col))))),
                h('tbody', null, item.rows.map((row, rowIndex) => h('tr', { key: rowIndex }, item.columns.map((_, col) => h('td', { key: col }, renderText(row[col], itemKey + '-cell-' + rowIndex + '-' + col))))))))
          }))
      }

      /**
       * 渲染整段 Markdown 文本（流式过程中允许未闭合标记，按纯文本降级）。
       * @param {string} source Markdown 源文本。
       * @param {any} [options] 渲染选项（wikiMap / onOpenPath / t）。
       * @returns {any[]} React 元素数组（每个都有 key）。
       */
      function renderMarkdown(source, options) {
        const text = stripHtmlComments(String(source == null ? '' : source)).replace(/\r\n?/g, '\n')
        if (!text) return []
        const opts = options || {}
        const lines = text.split('\n')
        const nodes = []
        const listItemPattern = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/
        let cursor = 0
        let keyCounter = 0
        /** @returns {string} */
        const nextKey = function (prefix) {
          keyCounter += 1
          return prefix + '-' + keyCounter
        }
        while (cursor < lines.length) {
          const line = lines[cursor]
          if (!line.trim()) {
            cursor += 1
            continue
          }

          // 围栏代码块：``` 或 ~~~（流式未闭合时把剩余内容都当代码）
          const fence = /^\s{0,3}(`{3,}|~{3,})[\t ]*([\w+#.-]*)[\t ]*$/.exec(line)
          if (fence) {
            const collected = []
            const closer = new RegExp('^\\s{0,3}' + fence[1][0] + '{' + fence[1].length + ',}[\\t ]*$')
            cursor += 1
            while (cursor < lines.length && !closer.test(lines[cursor])) {
              collected.push(lines[cursor])
              cursor += 1
            }
            const complete = cursor < lines.length
            if (cursor < lines.length) cursor += 1
            const raw = collected.join('\n')
            const blockKey = nextKey('fence')
            const rendered = complete && fence[2].toLowerCase() === 'dsh-ui' ? renderDshUi(raw, blockKey, opts) : null
            nodes.push(rendered || h('pre', { key: blockKey, className: 'kb-md-pre' }, h('code', null, raw)))
            continue
          }

          // 标题 # / ## / ###（更深的按三级处理）；h1 由阅读器标题承担，
          // Markdown 标题从 h2 起，保留语义层级与原有 .kb-md-h 样式。
          const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
          if (heading) {
            const level = Math.min(3, heading[1].length)
            const headingTag = 'h' + (level + 1)
            nodes.push(h(headingTag, { key: nextKey('h'), className: 'kb-md-h kb-md-h' + level }, renderInline(heading[2], 'h-' + keyCounter, opts)))
            cursor += 1
            continue
          }

          // 分隔线 --- / *** / ___
          if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            nodes.push(h('hr', { key: nextKey('hr'), className: 'kb-md-hr' }))
            cursor += 1
            continue
          }

          // 表格：| a | b |  +  | --- | --- |
          if (TABLE_ROW_PATTERN.test(line) && cursor + 1 < lines.length && TABLE_SEP_PATTERN.test(lines[cursor + 1])) {
            const headerCells = splitTableRow(line)
            cursor += 2
            const bodyRows = []
            while (cursor < lines.length && TABLE_ROW_PATTERN.test(lines[cursor])) {
              bodyRows.push(splitTableRow(lines[cursor]))
              cursor += 1
            }
            const headCells = []
            for (let index = 0; index < headerCells.length; index += 1) {
              headCells.push(h('th', { key: 'th-' + keyCounter + '-' + index }, renderInline(headerCells[index], 'th-' + keyCounter + '-' + index, opts)))
            }
            const bodyNodes = []
            for (let rowIndex = 0; rowIndex < bodyRows.length; rowIndex += 1) {
              const cells = bodyRows[rowIndex]
              const cellNodes = []
              for (let index = 0; index < cells.length; index += 1) {
                cellNodes.push(h('td', { key: 'td-' + rowIndex + '-' + index }, renderInline(cells[index], 'td-' + rowIndex + '-' + index, opts)))
              }
              bodyNodes.push(h('tr', { key: 'tr-' + rowIndex }, cellNodes))
            }
            nodes.push(
              h(
                'div',
                { key: nextKey('table'), className: 'kb-md-table-wrap' },
                h('table', { className: 'kb-md-table' }, h('thead', null, h('tr', null, headCells)), h('tbody', null, bodyNodes)),
              ),
            )
            continue
          }

          // 引用块 >（递归解析内容，支持引用里再出列表 / 代码）
          if (/^\s{0,3}>/.test(line)) {
            const collected = []
            while (cursor < lines.length && /^\s{0,3}>/.test(lines[cursor])) {
              collected.push(lines[cursor].replace(/^\s{0,3}>\s?/, ''))
              cursor += 1
            }
            nodes.push(h('blockquote', { key: nextKey('quote'), className: 'kb-md-quote' }, renderMarkdown(collected.join('\n'), opts)))
            continue
          }

          // 有序条目之间可以留空行，交给同一个 ol 连续编号。
          const listItem = listItemPattern.exec(line)
          if (listItem) {
            const numbering = /^(\d+)([.)])$/.exec(listItem[1])
            const belongsToList = function (item) {
              if (!item) return false
              const isOrdered = /^\d/.test(item[1])
              return numbering ? isOrdered && item[1].endsWith(numbering[2]) : !isOrdered
            }
            const items = []
            let loose = false
            while (cursor < lines.length) {
              const current = lines[cursor]
              if (numbering && !current.trim()) {
                let next = cursor + 1
                while (next < lines.length && !lines[next].trim()) next += 1
                if (next >= lines.length || !belongsToList(listItemPattern.exec(lines[next]))) break
                loose = true
                cursor = next
                continue
              }
              const itemMatch = listItemPattern.exec(current)
              if (!itemMatch) {
                if (items.length > 0 && /^\s{2,}\S/.test(current)) {
                  items[items.length - 1] += ' ' + current.trim()
                  cursor += 1
                  continue
                }
                break
              }
              if (!belongsToList(itemMatch)) break
              items.push(itemMatch[2])
              cursor += 1
            }
            const itemNodes = []
            for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
              const key = 'li-' + keyCounter + '-' + itemIndex
              const content = renderInline(items[itemIndex], key, opts)
              itemNodes.push(h('li', { key }, loose ? h('p', { className: 'kb-md-p' }, content) : content))
            }
            const listProps = { key: nextKey('list'), className: 'kb-md-list' }
            if (numbering) listProps.start = Number(numbering[1])
            nodes.push(h(numbering ? 'ol' : 'ul', listProps, itemNodes))
            continue
          }

          // 普通段落：连续非空、非块级标记行合并为一段
          const paragraphLines = []
          while (cursor < lines.length) {
            const current = lines[cursor]
            if (!current.trim()) break
            if (/^\s{0,3}(#{1,6}\s|>|```|~~~|[-*+]\s|\d{1,3}[.)]\s)/.test(current)) break
            if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(current)) break
            if (TABLE_ROW_PATTERN.test(current)) break
            paragraphLines.push(current)
            cursor += 1
          }
          if (paragraphLines.length === 0) {
            // 防御：任何未命中的行都消费掉，避免死循环
            cursor += 1
            continue
          }
          nodes.push(h('p', { key: nextKey('p'), className: 'kb-md-p' }, renderPlainLines(paragraphLines, 'p-' + keyCounter, opts)))
        }
        return nodes
      }

      /**
       * Markdown 渲染组件：把 source 渲染成 .kb-md 容器。
       * @param {{ source: string, wikiMap?: any, onOpenPath?: Function, t?: Function, className?: string }} props 属性。
       * @returns {any}
       */
      function MarkdownBlock(props) {
        const options = useMemo(function () {
          return { wikiMap: props.wikiMap || null, onOpenPath: props.onOpenPath || null, citations: props.citations || null, t: props.t }
        }, [props.wikiMap, props.onOpenPath, props.citations, props.t])
        const nodes = useMemo(function () {
          return renderMarkdown(props.source, options)
        }, [props.source, options])
        const className = props.className ? 'kb-md ' + props.className : 'kb-md'
        return h('div', { className: className }, nodes)
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

      /**
       * 侧边栏入口图标：书本 + 知识节点；strokeWidth 随选中态略变粗。
       * @param {{ size?: number, active?: boolean }} [props] 尺寸与选中态。
       * @returns {any}
       */
      function KbIcon(props) {
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
          h('path', { key: 'book', d: 'M11.6 6.3C10.5 5.4 9.1 5 7.5 5H6.2A1.5 1.5 0 0 0 4.7 6.5v9.1a1.5 1.5 0 0 0 1.5 1.5h1.3c1.6 0 3 .4 4.1 1.2 1.1-.8 2.5-1.2 4.1-1.2h1.3a1.5 1.5 0 0 0 1.5-1.5V6.5A1.5 1.5 0 0 0 17 5h-1.3c-1.6 0-3 .4-4.1 1.3Z' }),
          h('path', { key: 'spine', d: 'M11.6 6.3v12' }),
          h('circle', { key: 'n1', cx: 15.8, cy: 9.4, r: 1.3, fill: 'currentColor', stroke: 'none' }),
          h('path', { key: 'e1', d: 'M14.8 10.5 13.4 12' }),
          h('circle', { key: 'n2', cx: 18.3, cy: 12.6, r: 1.1, fill: 'currentColor', stroke: 'none' }),
          h('path', { key: 'e2', d: 'M15.9 10.4 17.3 11.7' }),
        )
      }

      /** 顶栏品牌图形：书本 + 星。 @param {{ size?: number }} [props] 尺寸。 @returns {any} */
      function BrandGlyph(props) {
        const size = props && props.size ? props.size : 18
        return iconSvg(
          size,
          [
            h('path', { key: 'book', d: 'M11 6.2C9.9 5.4 8.5 5 6.9 5H5.6A1.6 1.6 0 0 0 4 6.6v9.2A1.6 1.6 0 0 0 5.6 17.4h1.3c1.6 0 3 .4 4.1 1.2 1.1-.8 2.5-1.2 4.1-1.2h1.3a1.6 1.6 0 0 0 1.6-1.6V6.6A1.6 1.6 0 0 0 16.4 5h-1.3c-1.6 0-3 .4-4.1 1.2Z' }),
            h('path', { key: 'spine', d: 'M11 6.2v12.4' }),
            h('path', { key: 'spark', d: 'M18.2 2.2c.32 1.85.72 2.25 2.58 2.58-1.86.32-2.26.72-2.58 2.58-.32-1.86-.72-2.26-2.58-2.58 1.86-.33 2.26-.73 2.58-2.58Z', fill: 'currentColor', stroke: 'none' }),
          ],
          { strokeWidth: 1.7 },
        )
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function RefreshIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'arc', d: 'M20 12a8 8 0 1 1-2.4-5.7' }),
          h('path', { key: 'head', d: 'M20 4.5V10h-5.5' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function UploadIcon(props) {
        const size = props && props.size ? props.size : 18
        return iconSvg(size, [
          h('path', { key: 'tray', d: 'M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-3' }),
          h('path', { key: 'up', d: 'M12 16V4.5' }),
          h('path', { key: 'head', d: 'M6.8 9.7 12 4.5l5.2 5.2' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function LinkIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'a', d: 'M10 13.9a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4' }),
          h('path', { key: 'b', d: 'M14 10.1a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function PasteIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('rect', { key: 'board', x: 5, y: 4.5, width: 14, height: 16, rx: 2 }),
          h('path', { key: 'clip', d: 'M9 4.5V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2v1.3' }),
          h('path', { key: 'lines', d: 'M8.5 10h7M8.5 13.5h7M8.5 17h4' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function SearchIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('circle', { key: 'c', cx: 10.5, cy: 10.5, r: 6.2 }),
          h('path', { key: 'h', d: 'm15.2 15.2 4.3 4.3' }),
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
      function GraphIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'e1', d: 'M6.8 7.4 16 11.4M7.4 16.2l7.4-3.7' }),
          h('circle', { key: 'n1', cx: 5.5, cy: 6.5, r: 2.1 }),
          h('circle', { key: 'n2', cx: 18.5, cy: 10, r: 2.1 }),
          h('circle', { key: 'n3', cx: 6.5, cy: 17.5, r: 2.1 }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function AskIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'bubble', d: 'M20 12.2c0 3.6-3.6 6.5-8 6.5-.9 0-1.8-.1-2.6-.4L5 20l1-3.3c-1.2-1.2-2-2.7-2-4.5 0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5Z' }),
          h('path', { key: 'dots', d: 'M8.7 12.2h.01M12 12.2h.01M15.3 12.2h.01', strokeWidth: 2.4 }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function HealthIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'pulse', d: 'M3 12h4l2.2-5.4 3.6 10.8L15 12h6' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function ZoomInIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('circle', { key: 'c', cx: 11, cy: 11, r: 6.5 }),
          h('path', { key: 'h', d: 'M11 8v6M8 11h6' }),
          h('path', { key: 'l', d: 'm16 16 4.5 4.5' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function ZoomOutIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('circle', { key: 'c', cx: 11, cy: 11, r: 6.5 }),
          h('path', { key: 'h', d: 'M8 11h6' }),
          h('path', { key: 'l', d: 'm16 16 4.5 4.5' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function FitIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [
          h('path', { key: 'tl', d: 'M9 4H5.5A1.5 1.5 0 0 0 4 5.5V9' }),
          h('path', { key: 'tr', d: 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9' }),
          h('path', { key: 'br', d: 'M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15' }),
          h('path', { key: 'bl', d: 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20H9' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function CloseIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [h('path', { key: 'x', d: 'm6 6 12 12M18 6 6 18' })])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function CheckIcon(props) {
        const size = props && props.size ? props.size : 15
        return iconSvg(size, [h('path', { key: 'tick', d: 'm4.5 12.5 5 5 10-11' })])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function ChevronIcon(props) {
        const size = props && props.size ? props.size : 12
        const expanded = !!(props && props.expanded)
        return iconSvg(size, [h('path', { key: 'c', d: expanded ? 'm6 9.5 6 6 6-6' : 'm9.5 6 6 6-6 6' })])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function ArrowLeftIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [h('path', { key: 'l', d: 'M19 12H5.5' }), h('path', { key: 'h', d: 'M11 5.5 4.5 12l6.5 6.5' })])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function SparkIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 's', d: 'M11.2 2.8c.7 4.3 1.7 5.3 6 6-4.3.7-5.3 1.7-6 6-.7-4.3-1.7-5.3-6-6 4.3-.7 5.3-1.7 6-6Z', fill: 'currentColor', stroke: 'none' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function WarningIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'tri', d: 'M12 3.5 21 19.5H3L12 3.5Z' }),
          h('path', { key: 'bar', d: 'M12 9.5v4.5' }),
          h('path', { key: 'dot', d: 'M12 16.8h.01', strokeWidth: 2.4 }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function FileIcon(props) {
        const size = props && props.size ? props.size : 14
        return iconSvg(size, [
          h('path', { key: 'doc', d: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z' }),
          h('path', { key: 'fold', d: 'M13.5 3.5v5h5' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function EditIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'pencil', d: 'M4 20h4.2L19 9.2a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L4 15.8V20Z' }),
          h('path', { key: 'tip', d: 'm13.8 6.2 4 4' }),
        ])
      }

      /** @param {{ size?: number }} [props] 图标尺寸。 @returns {any} */
      function UndoIcon(props) {
        const size = props && props.size ? props.size : 13
        return iconSvg(size, [
          h('path', { key: 'arrow', d: 'M9 14 4.5 9.5 9 5' }),
          h('path', { key: 'arc', d: 'M4.5 9.5H14a5.5 5.5 0 0 1 0 11H8.5' }),
        ])
      }

      /**
       * 通用小图标按钮（用于列表行的删除 / 重试等）。
       * @param {{ label: string, onClick?: Function, disabled?: boolean, className?: string, children: any, title?: string }} props 属性。
       * @returns {any}
       */
      function FolderIcon(props) {
        return iconSvg(props && props.size || 16, [h('path', { key: 'folder', d: 'M3.5 7V5.5A1.5 1.5 0 0 1 5 4h5l2 2h7A1.5 1.5 0 0 1 20.5 7.5v11A1.5 1.5 0 0 1 19 20H5A1.5 1.5 0 0 1 3.5 18.5V7Z' })])
      }

      /** A labelled disclosure keeps secondary actions accessible without menu keyboard conventions. */
      function ActionDisclosure(props) {
        const [open, setOpen] = useState(false)
        const rootRef = useRef(null)
        const triggerRef = useRef(null)
        useEffect(function () {
          if (!open) return undefined
          const root = rootRef.current
          const first = root && root.querySelector('.kb-action-popover button')
          if (first) first.focus()
          function outside(event) { if (root && !root.contains(event.target)) setOpen(false) }
          function escape(event) {
            if (event.key !== 'Escape') return
            event.preventDefault(); event.stopPropagation(); setOpen(false)
            if (triggerRef.current) triggerRef.current.focus()
          }
          document.addEventListener('pointerdown', outside)
          if (root) root.addEventListener('keydown', escape)
          return function () { document.removeEventListener('pointerdown', outside); if (root) root.removeEventListener('keydown', escape) }
        }, [open])
        return h('div', { className: 'kb-action-disclosure', ref: rootRef, onBlur: function (event) { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) } },
          h('button', { type: 'button', ref: triggerRef, className: 'kb-btn kb-btn-sm kb-btn-ghost', 'aria-label': props.t('common.moreActions'), 'aria-expanded': open, onClick: function () { setOpen(!open) } },
            iconSvg(16, [h('circle', { key: 'a', cx: 5, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' }), h('circle', { key: 'b', cx: 12, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' }), h('circle', { key: 'c', cx: 19, cy: 12, r: 1, fill: 'currentColor', stroke: 'none' })]), props.t('common.more')),
          open ? h('div', { className: 'kb-action-popover', role: 'group', 'aria-label': props.t('common.moreActions') }, props.actions.map(function (action) {
            return h('button', { key: action.label, type: 'button', className: 'kb-action-option', 'aria-pressed': action.pressed, onClick: function () { setOpen(false); if (triggerRef.current) triggerRef.current.focus(); action.onClick() } }, action.label)
          })) : null,
        )
      }

      function IconButton(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'kb-iconbtn' + (props.className ? ' ' + props.className : ''),
            onClick: props.onClick,
            disabled: !!props.disabled,
            title: props.title || props.label,
            'aria-label': props.label,
          },
          props.children,
        )
      }

      // ======================================================================
      // 插件级共享上下文（避免多层 props 透传）
      // ======================================================================

      /** @type {any} 面板共享状态（PanelBody 提供）。 */
      const KbContext = React.createContext(null)

      /** @returns {any} 面板共享上下文。 */
      function useKb() {
        return useContext(KbContext)
      }

      // ======================================================================
      // 面板渲染异常兜底（组件抛错时不让整个 slot entry 变白）
      // ======================================================================
      class KbErrorBoundary extends React.Component {
        /**
         * @param {any} props 属性（含 title / hint / children）。
         */
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        /** @returns {any} 派生状态。 */
        static getDerivedStateFromError() {
          return { failed: true }
        }

        /**
         * 渲染异常日志。
         * @param {any} error 异常。
         * @returns {void}
         */
        componentDidCatch(error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-kb] 面板渲染异常：' + errorMessage(error, 'unknown'))
          }
        }

        /** @returns {any} 界面。 */
        render() {
          if (!this.state.failed) return this.props.children
          return h(
            'div',
            { className: 'kb-root' },
            h('style', { key: 'kb-style-crash' }, KB_CSS),
            h(
              'div',
              { className: 'kb-empty' },
              h('span', { className: 'kb-empty-icon' }, h(BrandGlyph, { size: 26 })),
              h('p', { className: 'kb-empty-title' }, this.props.title),
              h('p', { className: 'kb-empty-hint' }, this.props.hint),
            ),
          )
        }
      }

      // ======================================================================
      // 共享展示原子组件
      // ======================================================================

      /**
       * 类型徽章（页面 / 素材）。
       * @param {{ t: Function, type: string }} props 属性。
       * @returns {any}
       */
      function TypeBadge(props) {
        const t = props.t
        const key = PAGE_TYPE_KEYS[props.type]
        const label = key ? t(key) : asString(props.type) || t('common.unknown')
        return h('span', { className: 'kb-badge kb-badge-type', 'data-type': asString(props.type) || 'unknown' }, label)
      }

      /**
       * 置信度徽章。
       * @param {{ t: Function, confidence: string }} props 属性。
       * @returns {any}
       */
      function ConfidenceBadge(props) {
        const t = props.t
        const confidence = asString(props.confidence).toUpperCase()
        if (!confidence) return null
        const key = CONFIDENCE_KEYS[confidence]
        return h('span', { className: 'kb-badge kb-badge-confidence', 'data-level': confidence.toLowerCase() }, key ? t(key) : confidence)
      }

      /**
       * 素材类型徽章文案。
       * @param {Function} t 翻译函数。
       * @param {string} kind 素材类型。
       * @returns {string}
       */
      function kindLabel(t, kind) {
        const key = KIND_KEYS[asString(kind)]
        return key ? t(key) : asString(kind) || t('common.unknown')
      }

      /**
       * 素材状态文案。
       * @param {Function} t 翻译函数。
       * @param {string} status 状态。
       * @returns {string}
       */
      function sourceStatusLabel(t, status) {
        const key = SOURCE_STATUS_KEYS[asString(status)]
        return key ? t(key) : asString(status) || t('common.unknown')
      }

      /**
       * 页面类型文案（groups.type.* 或 page.type.*）。
       * @param {Function} t 翻译函数。
       * @param {string} type 页面类型。
       * @returns {string}
       */
      function pageTypeLabel(t, type) {
        const key = PAGE_TYPE_KEYS[asString(type)]
        return key ? t(key) : asString(type) || t('common.unknown')
      }

      /**
       * 加载状态块。
       * @param {{ t: Function, text?: string }} props 属性。
       * @returns {any}
       */
      function LoadingBlock(props) {
        return h(
          'div',
          { className: 'kb-loading' },
          h('span', { className: 'kb-spinner' }),
          h('span', null, props.text || props.t('common.loading')),
        )
      }

      /**
       * 错误状态块（带重试）。
       * @param {{ t: Function, text: string, onRetry?: Function }} props 属性。
       * @returns {any}
       */
      function ErrorBlock(props) {
        return h(
          'div',
          { className: 'kb-loading' },
          h('span', { className: 'kb-error-dot' }),
          h('span', { className: 'kb-error-inline-text' }, props.text),
          props.onRetry ? h('button', { type: 'button', className: 'kb-linkbtn', onClick: props.onRetry }, props.t('common.retry')) : null,
        )
      }

      /**
       * 空状态块。
       * @param {{ t: Function, title: string, hint?: string, icon?: any, action?: any }} props 属性。
       * @returns {any}
       */
      function EmptyBlock(props) {
        return h(
          'div',
          { className: 'kb-empty' },
          h('span', { className: 'kb-empty-icon' }, props.icon || h(BrandGlyph, { size: 26 })),
          h('p', { className: 'kb-empty-title' }, props.title),
          props.hint ? h('p', { className: 'kb-empty-hint' }, props.hint) : null,
          props.action ? h('div', { className: 'kb-empty-action' }, props.action) : null,
        )
      }

      /**
       * 无样式图标按钮的加载指示。
       * @param {{ size?: string }} [props] 尺寸（sm / md）。
       * @returns {any}
       */
      function Spinner(props) {
        return h('span', { className: 'kb-spinner' + (props && props.size === 'sm' ? ' kb-spinner-sm' : '') })
      }

      // ======================================================================
      // 通用模态框（Esc / 遮罩关闭，role=dialog aria-modal，主题变量）
      // ======================================================================

      /** @type {any[]} 当前打开的模态框栈：Esc 只交给最上层，避免嵌套弹层同时关闭。 */
      const modalStack = []
      /** 模态框自增 id。 */
      let modalSequence = 0

      /**
       * 通用模态框外壳。
       * @param {{ t: Function, title: string, description?: string, children?: any, footer?: any, danger?: boolean, wide?: boolean, busy?: boolean, closeOnBackdrop?: boolean, onClose?: Function }} props 属性。
       * @returns {any}
       */
      function KbModal(props) {
        const t = props.t
        const busy = !!props.busy
        const modalRef = useRef(null)
        const panelRef = useRef(null)
        const restoreFocusRef = useRef(null)
        if (modalRef.current === null) {
          modalSequence += 1
          modalRef.current = { id: 'kb-modal-' + modalSequence }
        }
        const entry = modalRef.current
        entry.onEscape = function () {
          if (!busy && typeof props.onClose === 'function') props.onClose()
        }
        // 焦点管理：进入时聚焦首个可聚焦元素，关闭后归还焦点
        useEffect(function () {
          restoreFocusRef.current = typeof document !== 'undefined' ? document.activeElement : null
          const panel = panelRef.current
          if (panel) {
            const target = panel.querySelector('[data-kb-autofocus]') || panel
            if (target && typeof target.focus === 'function') {
              try {
                target.focus({ preventScroll: true })
              } catch (error) {
                // ignore
              }
            }
          }
          return function () {
            const previous = restoreFocusRef.current
            if (previous && typeof previous.focus === 'function') {
              try {
                previous.focus({ preventScroll: true })
              } catch (error) {
                // ignore
              }
            }
          }
        }, [])

        useEffect(function () {
          modalStack.push(entry)
          /**
           * 只处理最上层弹层的 Esc。
           * @param {any} event 键盘事件。
           * @returns {void}
           */
          function handleKey(event) {
            if (!event || event.key !== 'Escape') return
            if (modalStack[modalStack.length - 1] !== entry) return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            // v0.5.0 修复 OBS-1：吞掉这次 Esc，避免同一按键继续冒泡触发 PanelBody 的
            // 「Esc 关闭阅读页」handler（弹层刚关闭时 modalStack 可能已清空 → 阅读页被连带关闭）。
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof entry.onEscape === 'function') entry.onEscape()
          }
          document.addEventListener('keydown', handleKey, true)
          return function () {
            const index = modalStack.indexOf(entry)
            if (index >= 0) modalStack.splice(index, 1)
            document.removeEventListener('keydown', handleKey, true)
          }
        }, [])

        /**
         * 点击遮罩关闭（点击面板内部不触发）。
         * @param {any} event React mouse 事件。
         * @returns {void}
         */
        function handleOverlay(event) {
          if (busy || props.closeOnBackdrop === false) return
          if (event && event.target === event.currentTarget && typeof props.onClose === 'function') {
            // Keep the backdrop's default mousedown focus from overriding the restored trigger.
            if (typeof event.preventDefault === 'function') event.preventDefault()
            props.onClose()
          }
        }

        /**
         * 阻止面板内部点击冒泡到遮罩。
         * @param {any} event React mouse 事件。
         * @returns {void}
         */
        function stopBubble(event) {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        }

        /**
         * 收集面板内可聚焦元素（过滤 disabled / hidden / aria-hidden）。
         * @returns {HTMLElement[]}
         */
        function focusableElements() {
          const panel = panelRef.current
          if (!panel || typeof panel.querySelectorAll !== 'function') return []
          const selector = 'button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])'
          return Array.prototype.slice.call(panel.querySelectorAll(selector)).filter(function (node) {
            if (!node || node.disabled) return false
            if (node.hidden) return false
            if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false
            if (typeof node.closest === 'function' && node.closest('[hidden]')) return false
            return true
          })
        }

        /**
         * Tab 焦点陷阱：最后一个 → 第一个，Shift+Tab 第一个 → 最后一个。
         * Esc 仍由全局栈处理（此处不拦截）。
         * @param {any} event React 键盘事件。
         * @returns {void}
         */
        function handlePanelKeyDown(event) {
          if (!event || event.key !== 'Tab') return
          const panel = panelRef.current
          const list = focusableElements()
          if (list.length === 0) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (panel && typeof panel.focus === 'function') panel.focus()
            return
          }
          const first = list[0]
          const last = list[list.length - 1]
          // 用事件目标定位当前焦点元素（对 shadow DOM 也比 document.activeElement 可靠）。
          const active = event.target
          const index = list.indexOf(active)
          if (event.shiftKey) {
            if (index <= 0) {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              last.focus()
            }
          } else if (index === list.length - 1 || index < 0) {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            first.focus()
          }
        }

        return h(
          'div',
          { className: 'kb-modal-overlay', role: 'presentation', onMouseDown: handleOverlay },
          h(
            'div',
            {
              ref: panelRef,
              tabIndex: -1,
              className: 'kb-sheet kb-modal' + (props.danger ? ' kb-modal-danger' : '') + (props.wide ? ' kb-modal-wide' : ''),
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': props.title,
              onMouseDown: stopBubble,
              onKeyDown: handlePanelKeyDown,
            },
            h(
              'div',
              { className: 'kb-modal-head' },
              h(
                'div',
                { className: 'kb-modal-title-wrap' },
                props.danger ? h('span', { className: 'kb-modal-danger-dot', 'aria-hidden': 'true' }) : null,
                h('h2', { className: 'kb-modal-title' }, props.title),
              ),
              h(IconButton, { label: t('dialog.close'), onClick: props.onClose, disabled: busy }, h(CloseIcon, { size: 13 })),
            ),
            props.description ? h('p', { className: 'kb-modal-desc' }, props.description) : null,
            h('div', { className: 'kb-modal-body' }, props.children),
            props.footer ? h('div', { className: 'kb-modal-foot' }, props.footer) : null,
          ),
        )
      }

      /**
       * 通用确认框：危险按钮红色，支持 Esc/遮罩取消、自定义内容与 busy 态。
       * irreversible=true 时确认按钮用填充红（永久删除），并自动附「不可恢复」提示。
       * @param {{ t: Function, title: string, description?: string, children?: any, confirmLabel?: string, cancelLabel?: string, danger?: boolean, irreversible?: boolean, busy?: boolean, busyLabel?: string, error?: string, onCancel?: Function, onConfirm?: Function }} props 属性。
       * @returns {any}
       */
      function ConfirmDialog(props) {
        const t = props.t
        const busy = !!props.busy
        const confirmClass = props.irreversible
          ? 'kb-btn kb-btn-danger-fill kb-btn-sm'
          : props.danger === false ? 'kb-btn kb-btn-primary kb-btn-sm' : 'kb-btn kb-btn-danger kb-btn-sm'
        const footer = [
          h(
            'button',
            { key: 'cancel', type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: props.onCancel, disabled: busy },
            props.cancelLabel || t('dialog.cancel'),
          ),
          h(
            'button',
            {
              key: 'confirm',
              type: 'button',
              className: confirmClass,
              onClick: function () {
                if (!busy && typeof props.onConfirm === 'function') props.onConfirm()
              },
              disabled: busy,
            },
            busy ? (props.busyLabel || t('dialog.working')) : (props.confirmLabel || t('common.delete')),
          ),
        ]
        const body = []
        if (props.error) body.push(h('div', { key: 'error', className: 'kb-inline-error' }, props.error))
        if (props.irreversible) body.push(h('div', { key: 'irreversible', className: 'kb-confirm-hint' }, t('confirm.irreversible')))
        if (props.children) body.push(h('div', { key: 'extra' }, props.children))
        return h(KbModal, {
          t: t,
          title: props.title,
          description: props.description,
          danger: props.danger !== false,
          busy: busy,
          onClose: function () {
            if (typeof props.onCancel === 'function') props.onCancel()
          },
          footer: footer,
          children: body,
        })
      }

      /**
       * 把逗号分隔的输入拆成去重列表。
       * @param {string} text 输入文本。
       * @returns {string[]}
       */
      function splitCommaList(text) {
        const parts = String(text == null ? '' : text).split(/[,，]/)
        const result = []
        for (let index = 0; index < parts.length; index += 1) {
          const value = parts[index].trim()
          if (value && result.indexOf(value) < 0) result.push(value)
        }
        return result
      }

      /** @type {string[]} 编辑弹层里的置信度选项。 */
      const EDIT_CONFIDENCE_OPTIONS = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'UNVERIFIED']
      /** 编辑弹层错误块 id（拆分字面量避免被 CSS 类一致性扫描误判为类名）。 */
      const EDIT_ERROR_ID = 'kb-edit-' + 'error'

      /**
       * 编辑页面弹层：标题 / 别名 / 标签 / 置信度 / 正文；保存走 PUT /page，展示 saving / 错误 / warnings。
       * 未保存时关闭需二次确认；有 warnings 时先展示保存结果，再点「完成」关闭。
       * @param {{ t: Function, page: any, onClose: Function, onSave: Function, onSaved: Function }} props 属性。
       * @returns {any}
       */
      function EditPageDialog(props) {
        const t = props.t
        const page = props.page && typeof props.page === 'object' ? props.page : {}
        const path = asString(page.path)
        const initialTitle = asString(page.title)
        const initialAliases = (Array.isArray(page.aliases) ? page.aliases : []).map(function (item) { return asString(item) }).filter(Boolean).join(', ')
        const initialTags = (Array.isArray(page.tags) ? page.tags : []).map(function (item) { return asString(item) }).filter(Boolean).join(', ')
        const initialConfidence = CONFIDENCE_KEYS[asString(page.confidence).toUpperCase()] ? asString(page.confidence).toUpperCase() : 'EXTRACTED'
        const initialMarkdown = asString(page.markdown)

        const [title, setTitle] = useState(initialTitle)
        const [aliasesText, setAliasesText] = useState(initialAliases)
        const [tagsText, setTagsText] = useState(initialTags)
        const [confidence, setConfidence] = useState(initialConfidence)
        const [markdown, setMarkdown] = useState(initialMarkdown)
        const [saving, setSaving] = useState(false)
        const [error, setError] = useState('')
        const [savedInfo, setSavedInfo] = useState(null)
        const [discardOpen, setDiscardOpen] = useState(false)
        const mountedRef = useRef(true)

        useEffect(function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
          }
        }, [])

        const dirty =
          title !== initialTitle ||
          aliasesText !== initialAliases ||
          tagsText !== initialTags ||
          confidence !== initialConfidence ||
          markdown !== initialMarkdown

        /**
         * 校验表单，返回错误文案（空串表示通过）。
         * @returns {string}
         */
        function validate() {
          const trimmedTitle = title.trim()
          if (!trimmedTitle) return t('edit.titleRequired')
          if (trimmedTitle.length > 200) return t('edit.titleTooLong', { n: 200 })
          const aliases = splitCommaList(aliasesText)
          const tags = splitCommaList(tagsText)
          if (aliases.length > 30) return t('edit.tooManyAliases', { n: 30 })
          if (tags.length > 30) return t('edit.tooManyTags', { n: 30 })
          const allItems = aliases.concat(tags)
          for (let index = 0; index < allItems.length; index += 1) {
            if (allItems[index].length > 100) return t('edit.itemTooLong', { n: 100 })
          }
          const bodyLength = markdown.trim().length
          if (bodyLength < 20) return t('edit.markdownTooShort', { n: 20 })
          if (markdown.length > 200000) return t('edit.markdownTooLong', { n: 200000 })
          return ''
        }

        /**
         * 保存：PUT /page，由父级 api 封装；成功后处理 warnings / rewrittenLinks。
         * @returns {Promise<void>}
         */
        async function save() {
          if (saving) return
          const validationError = validate()
          if (validationError) {
            setError(validationError)
            return
          }
          setError('')
          setSaving(true)
          let result = null
          try {
            result = await props.onSave({
              path: path,
              title: title.trim(),
              aliases: splitCommaList(aliasesText),
              tags: splitCommaList(tagsText),
              confidence: confidence,
              markdown: markdown,
            })
          } catch (saveError) {
            result = { ok: false, message: errorMessage(saveError, t('error.requestFailed')) }
          }
          if (!mountedRef.current) return
          setSaving(false)
          if (!result || !result.ok) {
            setError(result && result.message ? result.message : t('edit.failed', { message: t('error.requestFailed') }))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          const warnings = Array.isArray(data.warnings) ? data.warnings.filter(function (item) { return typeof item === 'string' && item }) : []
          const rewrittenLinks = typeof data.rewrittenLinks === 'number' && isFinite(data.rewrittenLinks) ? data.rewrittenLinks : 0
          const info = { warnings: warnings, rewrittenLinks: rewrittenLinks }
          setSavedInfo(info)
          if (warnings.length === 0 && rewrittenLinks === 0) props.onSaved(info)
        }

        /** @returns {void} 请求关闭（脏数据二次确认）。 */
        function requestClose() {
          if (saving) return
          if (savedInfo) {
            props.onSaved(savedInfo)
            return
          }
          if (dirty) {
            setDiscardOpen(true)
            return
          }
          props.onClose()
        }

        // 保存成功且无 warning / 改写时通常已由父级关闭；这里保留「完成」态
        if (savedInfo) {
          const warningNodes = savedInfo.warnings.map(function (warning, index) {
            return h('div', { key: 'warning-' + index, className: 'kb-modal-warning-item' }, warning)
          })
          return h(KbModal, {
            t: t,
            title: t('edit.savedTitle'),
            onClose: function () {
              props.onSaved(savedInfo)
            },
            footer: [
              h(
                'button',
                { key: 'done', type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: function () { props.onSaved(savedInfo) } },
                t('manage.exit'),
              ),
            ],
            children: [
              h(
                'div',
                { key: 'saved', className: 'kb-edit-saved' },
                h('div', { className: 'kb-edit-success-head' }, h(CheckIcon, { size: 16 }), h('span', null, t('edit.saved'))),
                savedInfo.rewrittenLinks > 0 ? h('div', { className: 'kb-form-hint' }, t('edit.rewrittenLinks', { n: savedInfo.rewrittenLinks })) : null,
                savedInfo.warnings.length > 0
                  ? h('div', { className: 'kb-modal-warnings' }, h('div', { className: 'kb-form-label' }, t('edit.warnings', { n: savedInfo.warnings.length })), warningNodes)
                  : null,
              ),
            ],
          })
        }

        const confidenceOptions = EDIT_CONFIDENCE_OPTIONS.map(function (option) {
          const key = 'page.confidence.' + option
          return h('option', { key: option, value: option }, t(key))
        })

        const body = [
          h(
            'div',
            { key: 'title', className: 'kb-form-field' },
            h('label', { className: 'kb-form-label', htmlFor: 'kb-edit-title' }, t('edit.field.title')),
            h('input', {
              id: 'kb-edit-title',
              className: 'kb-input',
              type: 'text',
              value: title,
              maxLength: 200,
              autoFocus: true,
              'data-kb-autofocus': 'true',
              disabled: saving,
              'aria-invalid': error ? 'true' : undefined,
              'aria-describedby': error ? EDIT_ERROR_ID : undefined,
              onChange: function (event) {
                setTitle(event.target.value)
                if (error) setError('')
              },
            }),
          ),
          h(
            'div',
            { key: 'aliases-tags', className: 'kb-edit-grid' },
            h(
              'div',
              { className: 'kb-form-field' },
              h('label', { className: 'kb-form-label', htmlFor: 'kb-edit-aliases' }, t('edit.field.aliases')),
              h('input', {
                id: 'kb-edit-aliases',
                className: 'kb-input',
                type: 'text',
                value: aliasesText,
                disabled: saving,
                'aria-invalid': error ? 'true' : undefined,
                'aria-describedby': error ? EDIT_ERROR_ID : undefined,
                onChange: function (event) {
                  setAliasesText(event.target.value)
                },
              }),
              h('div', { className: 'kb-form-hint' }, t('edit.aliasesHint')),
            ),
            h(
              'div',
              { className: 'kb-form-field' },
              h('label', { className: 'kb-form-label', htmlFor: 'kb-edit-tags' }, t('edit.field.tags')),
              h('input', {
                id: 'kb-edit-tags',
                className: 'kb-input',
                type: 'text',
                value: tagsText,
                disabled: saving,
                'aria-invalid': error ? 'true' : undefined,
                'aria-describedby': error ? EDIT_ERROR_ID : undefined,
                onChange: function (event) {
                  setTagsText(event.target.value)
                },
              }),
              h('div', { className: 'kb-form-hint' }, t('edit.tagsHint')),
            ),
          ),
          h(
            'div',
            { key: 'confidence', className: 'kb-form-field kb-form-field-narrow' },
            h('label', { className: 'kb-form-label', htmlFor: 'kb-edit-confidence' }, t('edit.field.confidence')),
            h(
              'select',
              {
                id: 'kb-edit-confidence',
                className: 'kb-select',
                value: confidence,
                disabled: saving,
                onChange: function (event) {
                  setConfidence(event.target.value)
                },
              },
              confidenceOptions,
            ),
          ),
          page.userEditedAt
            ? h('div', { key: 'user-edited', className: 'kb-form-hint' }, t('edit.userEditedTip', { time: formatDateTime(page.userEditedAt) }))
            : null,
          asString(page.type) === 'source' || page.type === 'source' ? h('div', { key: 'source-tip', className: 'kb-form-hint kb-form-hint-warn' }, t('edit.sourceTip')) : null,
          h(
            'div',
            { key: 'markdown', className: 'kb-form-field' },
            h('div', { className: 'kb-form-label-row' }, h('label', { className: 'kb-form-label', htmlFor: 'kb-edit-markdown' }, t('edit.field.markdown')), h('span', { className: 'kb-counter' }, t('common.chars', { n: markdown.length }))),
            h('textarea', {
              id: 'kb-edit-markdown',
              className: 'kb-textarea kb-edit-markdown',
              value: markdown,
              rows: 14,
              maxLength: 200000,
              spellCheck: false,
              disabled: saving,
              'aria-invalid': error ? 'true' : undefined,
              'aria-describedby': error ? EDIT_ERROR_ID : undefined,
              onChange: function (event) {
                setMarkdown(event.target.value)
                if (error) setError('')
              },
            }),
          ),
          error ? h('div', { key: 'error', id: EDIT_ERROR_ID, className: 'kb-inline-error' }, error) : null,
        ]

        const dialog = h(KbModal, {
          t: t,
          title: t('edit.title'),
          description: t('edit.subtitle'),
          busy: saving,
          wide: true,
          onClose: requestClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: requestClose, disabled: saving }, t('dialog.cancel')),
            h(
              'button',
              { key: 'save', type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: save, disabled: saving },
              saving ? t('edit.saving') : t('edit.save'),
            ),
          ],
          children: body,
        })
        if (!discardOpen) return dialog
        return h(
          React.Fragment,
          null,
          dialog,
          h(ConfirmDialog, {
            t: t,
            title: t('edit.discardTitle'),
            description: t('edit.discardDesc'),
            confirmLabel: t('edit.discardAction'),
            cancelLabel: t('edit.keepEditing'),
            onCancel: function () {
              setDiscardOpen(false)
            },
            onConfirm: function () {
              setDiscardOpen(false)
              props.onClose()
            },
          }),
        )
      }

      /**
       * 生成批量操作确认框里的标题预览列表。
       * @param {Function} t 翻译函数。
       * @param {any[]} items 条目（title / name / id / path）。
       * @param {number} [limit] 最多显示条数（默认 5）。
       * @returns {any}
       */
      function confirmPreviewList(t, items, limit) {
        const list = Array.isArray(items) ? items : []
        const max = typeof limit === 'number' && limit > 0 ? limit : 5
        const shown = list.slice(0, max)
        const nodes = shown.map(function (item, index) {
          const source = item && typeof item === 'object' ? item : {}
          const title = asString(source.title) || asString(source.name) || asString(source.id) || asString(source.path) || t('common.unknown')
          return h('div', { key: title + '-' + index, className: 'kb-confirm-item' }, title)
        })
        const extra = list.length - shown.length
        if (extra > 0) nodes.push(h('div', { key: 'more', className: 'kb-confirm-more' }, t('manage.moreItems', { n: extra })))
        return h('div', { className: 'kb-confirm-list' }, nodes)
      }

      /** One reading surface for a material and the pages linked to it. */
      function SourceOriginalDialog() {
        const ctx = useKb()
        const t = ctx.t
        const state = ctx.sourceOriginal
        if (!state) return null
        const data = state.data && typeof state.data === 'object' ? state.data : null
        const source = data && data.source && typeof data.source === 'object' ? data.source : {}
        const text = data && typeof data.text === 'string' ? data.text : ''
        const raw = data && data.raw && typeof data.raw === 'object' ? data.raw : {}
        const title = asString(source.title) || state.title || t('source.detail.title')
        const detail = data && data.detail ? data.detail : {}
        const section = state.section || 'original'
        const summary = detail.summary
        const excerpts = Array.isArray(detail.excerpts) ? detail.excerpts : []
        const related = Array.isArray(detail.related) ? detail.related : []
        const versions = Array.isArray(detail.versions) ? detail.versions : []
        const waiting = state.status === 'loading'
        const failed = state.status === 'error'
        const metaNodes = []
        if (source.kind) metaNodes.push(h('span', { className: 'kb-badge kb-badge-kind' }, kindLabel(t, source.kind)))
        if (typeof source.chars === 'number' && source.chars > 0) metaNodes.push(h('span', null, t('common.chars', { n: source.chars })))
        if (source.status) metaNodes.push(h('span', null, t('page.sourceStatus', { status: sourceStatusLabel(t, source.status) })))
        if (raw.exists && typeof raw.size === 'number' && raw.size > 0) metaNodes.push(h('span', null, formatBytes(raw.size)))

        let body = null
        if (waiting) {
          body = h('div', { className: 'kb-loading' }, h(Spinner, { size: 'sm' }), h('span', null, t('source.original.loading')))
        } else if (failed) {
          body = h('div', { className: 'kb-inline-error' }, t('source.original.failed', { message: state.error || t('error.requestFailed') }),
            h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.openSourceOriginal(state) } }, t('common.retry')))
        } else {
          const rawPath = asString(raw.path)
          const isTextOriginal = !rawPath || /\.(md|markdown|txt|json|csv|tsv|yaml|yml|html?|log|xml)$/i.test(rawPath)
          const sections = [['original', t('source.original.title')]]
          if (summary) sections.push(['summary', t('source.detail.summary')])
          if (excerpts.length) sections.push(['excerpts', t('source.detail.excerpts', { n: excerpts.length })])
          if (related.length) sections.push(['related', t('source.detail.related', { n: related.length })])
          const openPage = function (path) { ctx.closeSourceOriginal(); ctx.openPage(path) }
          let reading = null
          if (section === 'summary' && summary) {
            const wikiMap = new Map()
            for (const link of Array.isArray(summary.links) ? summary.links : []) {
              wikiMap.set(link.title, link)
              wikiMap.set(asString(link.title).toLowerCase(), link)
            }
            reading = h('div', { className: 'kb-material-pane', tabIndex: 0, 'aria-label': t('source.detail.summary') },
              h('div', { className: 'kb-material-pane-heading' },
                h('span', { className: 'kb-original-hint' }, t('source.detail.aiSummary')),
                h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { openPage(summary.path) } }, t('source.detail.openSummary')),
              ),
              h(MarkdownBlock, { source: asString(summary.markdown), wikiMap: wikiMap, onOpenPath: openPage, t: t }),
            )
          } else if (section === 'excerpts' && excerpts.length) {
            reading = h('ul', { className: 'kb-material-pane kb-material-list', tabIndex: 0, 'aria-label': t('source.detail.excerpts', { n: excerpts.length }) },
              excerpts.map(function (excerpt) {
                return h('li', { key: excerpt.path },
                  h('blockquote', { className: 'kb-material-quote' }, asString(excerpt.text)),
                  Array.isArray(excerpt.tags) && excerpt.tags.length ? h('span', { className: 'kb-original-hint' }, excerpt.tags.join(' · ')) : null,
                )
              }),
            )
          } else if (section === 'related' && related.length) {
            reading = h('ul', { className: 'kb-material-pane kb-material-list', tabIndex: 0, 'aria-label': t('source.detail.related', { n: related.length }) },
              related.map(function (item) {
                return h('li', { key: item.path }, h('button', { type: 'button', className: 'kb-material-link', onClick: function () { openPage(item.path) } },
                  h('span', null, item.title), h('span', { className: 'kb-original-hint' }, item.materialDocument ? t('source.detail.documentNote') : pageTypeLabel(t, item.type)),
                ))
              }),
            )
          } else {
            reading = text
              ? h('pre', { className: 'kb-original-pre', tabIndex: 0, 'aria-label': t('source.original.title') }, text)
              : h('div', { className: 'kb-nav-empty' }, t('source.original.empty'))
          }
          body = h(
            'div',
            { className: 'kb-original-body' },
            metaNodes.length > 0 ? h('div', { className: 'kb-original-meta' }, metaNodes) : null,
            versions.length > 1 ? h('details', { className: 'kb-material-versions' },
              h('summary', null, t('source.detail.versions', { n: versions.length })),
              h('ul', { className: 'kb-material-list' }, versions.map(function (version) {
                const current = version.id === state.id
                return h('li', { key: version.id }, h('button', {
                  type: 'button', className: 'kb-material-link', disabled: current,
                  onClick: function () { ctx.openSourceOriginal(version) },
                }, h('span', null, version.title), current ? h('span', { className: 'kb-original-hint' }, t('source.detail.currentVersion')) : null))
              })),
            ) : null,
            sections.length > 1 ? h('div', { className: 'kb-material-sections', role: 'group', 'aria-label': t('source.detail.sections') },
              sections.map(function ([id, label]) {
                return h('button', { key: id, type: 'button', className: 'kb-graph-chip', 'data-active': section === id,
                  'aria-pressed': section === id, onClick: function () { ctx.setSourceSection(id) },
                }, label)
              }),
            ) : null,
            h('div', { key: section, className: 'kb-material-reading' }, reading),
            detail.excerptWarning ? h('div', { className: 'kb-original-hint', role: 'status' }, t('source.detail.excerptUnavailable')) : null,
            section === 'original' && source.kind === 'file' && raw.exists && !isTextOriginal
              ? h('div', { className: 'kb-original-hint' }, t('source.original.binaryHint'))
              : null,
          )
        }

        const footer = []
        if (text && section === 'original') {
          footer.push(
            h(
              'button',
              {
                key: 'copy',
                type: 'button',
                className: 'kb-btn kb-btn-ghost kb-btn-sm',
                onClick: function () {
                  ctx.copyText(text)
                  ctx.showNotice('info', t('source.original.copied'))
                },
              },
              t('source.original.copy'),
            ),
          )
        }
        if (raw.exists && asString(raw.path)) {
          footer.push(
            h(
              'a',
              {
                key: 'raw',
                className: 'kb-btn kb-btn-sm',
                href: ORIGIN + '/raw?path=' + encodeURIComponent(asString(raw.path)),
                target: '_blank',
                rel: 'noreferrer',
              },
              t('source.original.openFile'),
            ),
          )
        }
        const originalUrl = safeHref(asString(source.url))
        if (originalUrl) {
          footer.push(
            h(
              'a',
              { key: 'url', className: 'kb-btn kb-btn-sm', href: originalUrl, target: '_blank', rel: 'noreferrer' },
              t('source.original.openUrl'),
            ),
          )
        }
        footer.push(
          h('button', { key: 'close', type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: ctx.closeSourceOriginal }, t('common.close')),
        )

        return h(
          KbModal,
          {
            t: t,
            title: title,
            description: title === t('source.detail.title') ? '' : t('source.detail.title'),
            wide: true,
            onClose: ctx.closeSourceOriginal,
            footer: footer,
          },
          body,
        )
      }

      /**
       * 判断 /tree 数据里是否仍存在某个页面路径。
       * @param {any} treeData /tree 响应。
       * @param {string} path 页面路径。
       * @returns {boolean}
       */
      function treeHasPath(treeData, path) {
        const target = asString(path)
        if (!target || !treeData || typeof treeData !== 'object') return false
        const groups = Array.isArray(treeData.groups) ? treeData.groups : []
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          const group = groups[groupIndex]
          const items = group && Array.isArray(group.items) ? group.items : []
          for (let index = 0; index < items.length; index += 1) {
            if (asString(items[index] && items[index].path) === target) return true
          }
        }
        return false
      }

      // ======================================================================
      // 顶栏 / tab 导航 / 通知条
      // ======================================================================

      /**
       * 顶栏（56px 玻璃控制层）：左侧品牌 + 路径胶囊，中间分段控件，右侧模型徽标 + 刷新。
       * @returns {any}
       */
      function KbHeader() {
        const ctx = useKb()
        const t = ctx.t
        const rootPath = ctx.rootDir || DEFAULT_ROOT_LABEL
        const modelFull = ctx.modelLabel || ''
        const modelShort = ctx.modelShort || modelFull
        return h(
          'header',
          { className: 'kb-header' },
          h(
            'div',
            { className: 'kb-header-left' },
            ctx.tab === 'books' || ctx.tab === 'sources' || ctx.tab === 'conversations' || ctx.tab === 'graph' ? null : h(
              'button',
              {
                type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm kb-navigation-toggle',
                'aria-label': t('header.navigation'), 'aria-controls': 'kb-navigation',
                'aria-expanded': ctx.navigationOpen ? 'true' : 'false',
                onClick: function () { ctx.setNavigationOpen(!ctx.navigationOpen) },
              },
              h(BrandGlyph, { size: 14 }), t('header.navigation'),
            ),
            h('span', { className: 'kb-logo' }, h(BrandGlyph, { size: 18 })),
            h('span', { className: 'kb-title' }, t('header.title')),
            h(
              'button',
              {
                type: 'button',
                className: 'kb-path',
                title: t('header.rootTip', { path: rootPath }),
                'aria-label': t('header.copyPath'),
                onClick: function () {
                  ctx.copyRootDir()
                },
              },
              h(FolderIcon, { size: 15 }),
            ),
            ctx.initialized ? null : h('span', { className: 'kb-badge kb-badge-warn' }, t('header.notInitialized')),
          ),
          h('div', { className: 'kb-header-center' }, h(KbTabs)),
          h(
            'div',
            { className: 'kb-header-right' },
            ctx.tab === 'conversations' ? null : h(
              'span',
              { className: 'kb-model', title: modelFull || t('header.modelTip'), 'data-state': ctx.modelLabel ? 'ready' : 'idle' },
              h('span', { className: 'kb-model-dot' }),
              h('span', { className: 'kb-model-text' }, modelShort || t('header.modelFallback')),
            ),
            h(
              IconButton,
              {
                label: t('header.refresh'),
                title: ctx.refreshing ? t('header.refreshing') : t('header.refresh'),
                disabled: ctx.refreshing,
                className: 'kb-iconbtn-refresh',
                onClick: ctx.refreshAll,
              },
              ctx.refreshing ? h(Spinner, { size: 'sm' }) : h(RefreshIcon, { size: 14 }),
            ),
          ),
        )
      }

      /**
       * 六个 tab 的分段控件（segmented pill，支持 ←/→/Home/End 键盘切换）。
       * @returns {any}
       */
      function KbTabs() {
        const ctx = useKb()
        const t = ctx.t
        const tabs = [
          { id: 'library', label: t('tab.library'), icon: BrandGlyph },
          { id: 'books', label: t('tab.books'), icon: FileIcon },
          { id: 'sources', label: t('tab.sources'), icon: FileIcon },
          { id: 'conversations', label: t('tab.conversations'), icon: AskIcon },
          { id: 'graph', label: t('tab.graph'), icon: GraphIcon },
          { id: 'ask', label: t('tab.ask'), icon: AskIcon },
          { id: 'health', label: t('tab.health'), icon: HealthIcon },
        ]
        const tabRefs = useRef({})
        const stats = ctx.overview && ctx.overview.data && ctx.overview.data.stats ? ctx.overview.data.stats : null
        const graphNodes = ctx.graphData && Array.isArray(ctx.graphData.nodes) ? ctx.graphData.nodes.length : 0
        const healthIssues = ctx.healthData && Array.isArray(ctx.healthData.issues) ? ctx.healthData.issues.length : 0
        const badges = {
          library: stats && typeof stats.pages === 'number' && stats.pages > 0 ? String(stats.pages) : '',
          sources: stats && typeof stats.sources === 'number' && stats.sources > 0 ? String(stats.sources) : '',
          graph: graphNodes > 0 ? String(graphNodes) : '',
          ask: '',
          health: healthIssues > 0 ? String(healthIssues) : '',
        }

        /**
         * 分段控件键盘导航：←/→ 循环、Home/End 跳首尾，并移动焦点。
         * @param {any} event React 键盘事件。
         * @returns {void}
         */
        function handleKeyDown(event) {
          if (!event || !event.key) return
          const currentIndex = tabs.findIndex(function (tab) {
            return tab.id === ctx.tab
          })
          let nextIndex = -1
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
          else if (event.key === 'Home') nextIndex = 0
          else if (event.key === 'End') nextIndex = tabs.length - 1
          if (nextIndex < 0) return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          const nextTab = tabs[nextIndex]
          ctx.setTab(nextTab.id)
          const node = tabRefs.current && tabRefs.current[nextTab.id]
          if (node && typeof node.focus === 'function') node.focus()
        }

        return h(
          'nav',
          { className: 'kb-tabs kb-segmented', role: 'tablist', 'aria-label': t('tablist.label'), onKeyDown: handleKeyDown },
          tabs.map(function (tab) {
            const active = ctx.tab === tab.id
            return h(
              'button',
              {
                key: tab.id,
                ref: function (node) {
                  if (!tabRefs.current) tabRefs.current = {}
                  tabRefs.current[tab.id] = node
                },
                id: 'kb-tab-' + tab.id,
                type: 'button',
                role: 'tab',
                className: 'kb-tab',
                'aria-label': tab.label,
                'data-active': active ? 'true' : 'false',
                'aria-selected': active ? 'true' : 'false',
                'aria-controls': 'kb-main',
                tabIndex: active ? 0 : -1,
                onClick: function () {
                  ctx.setTab(tab.id)
                },
              },
              h('span', { className: 'kb-tab-icon' }, h(tab.icon, { size: 15 })),
              h('span', { className: 'kb-tab-label' }, tab.label),
              badges[tab.id] ? h('span', { className: 'kb-tab-badge' }, badges[tab.id]) : null,
            )
          }),
        )
      }

      /**
       * 通知条：info（自动消失）+ error（手动关闭）。
       * @returns {any}
       */
      function KbNotices() {
        const ctx = useKb()
        const t = ctx.t
        const rows = []
        if (ctx.errorBar) {
          rows.push(
            h(
              'div',
              { key: 'error', className: 'kb-notice kb-notice-error', role: 'alert' },
              h('span', { className: 'kb-notice-icon' }, h(WarningIcon, { size: 13 })),
              h('span', { className: 'kb-notice-text' }, ctx.errorBar),
              h(IconButton, { label: t('common.dismiss'), onClick: ctx.dismissError }, h(CloseIcon, { size: 12 })),
            ),
          )
        }
        if (ctx.notice && ctx.notice.text) {
          rows.push(
            h(
              'div',
              { key: 'info', className: 'kb-notice kb-notice-info', role: 'status', 'data-kind': ctx.notice.kind === 'warn' ? 'warn' : 'info' },
              h('span', { className: 'kb-notice-icon' }, ctx.notice.kind === 'warn' ? h(WarningIcon, { size: 13 }) : h(CheckIcon, { size: 13 })),
              h('span', { className: 'kb-notice-text' }, ctx.notice.text),
              h(IconButton, { label: t('common.dismiss'), onClick: ctx.dismissNotice }, h(CloseIcon, { size: 12 })),
            ),
          )
        }
        if (rows.length === 0) return null
        return h('div', { className: 'kb-notices', role: 'region', 'aria-label': t('notices.label') }, rows)
      }

      // ======================================================================
      // 左栏：上传 / 链接 / 粘贴 卡片
      // ======================================================================

      /**
       * 素材录入卡片：拖拽上传（多选）、链接消化、粘贴文本。
       * fileInputRef / pasteOpen / pickFiles 由 PanelBody 提升持有（空态 CTA 也会调用）。
       * @param {{ fileInputRef?: any, pasteOpen?: boolean, setPasteOpen?: Function, pickFiles?: Function }} props 属性。
       * @returns {any}
       */
      function UploadCard(props) {
        const ctx = useKb()
        const t = ctx.t
        const [dragActive, setDragActive] = useState(false)
        const [urlInput, setUrlInput] = useState('')
        const [urlError, setUrlError] = useState('')
        const [urlBusy, setUrlBusy] = useState(false)
        const [pasteTitle, setPasteTitle] = useState('')
        const [pasteText, setPasteText] = useState('')
        const [pasteError, setPasteError] = useState('')
        const [pasteBusy, setPasteBusy] = useState(false)
        const fileInputRef = props.fileInputRef || null
        const pasteOpen = !!props.pasteOpen
        const setPasteOpen = typeof props.setPasteOpen === 'function' ? props.setPasteOpen : function () {}
        const pickFiles = typeof props.pickFiles === 'function'
          ? props.pickFiles
          : function () {
              if (fileInputRef && typeof fileInputRef.current.click === 'function') fileInputRef.current.click()
            }
        const uploadState = ctx.uploadState || { busy: false }
        const busy = !!uploadState.busy
        const limits = ctx.meta && ctx.meta.data && ctx.meta.data.limits ? ctx.meta.data.limits : null
        const maxBytes = limits && typeof limits.maxFileBytes === 'number' && limits.maxFileBytes > 0 ? limits.maxFileBytes : DEFAULT_MAX_FILE_BYTES
        const initialized = !!ctx.initialized

        /**
         * file input 选择完成。
         * @param {any} event React change 事件。
         * @returns {void}
         */
        function handleInputChange(event) {
          const list = event && event.target && event.target.files ? event.target.files : null
          const files = list ? Array.prototype.slice.call(list) : []
          if (event && event.target) event.target.value = ''
          if (files.length === 0) return
          ctx.uploadFiles(files)
        }

        /**
         * 拖拽悬停。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleDragOver(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (busy) return
          setDragActive(true)
        }

        /**
         * 拖拽离开。
         * @param {any} event React drag 事件。
         * @returns {void}
         */
        function handleDragLeave(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          setDragActive(false)
        }

        /**
         * 拖拽释放：取出文件交给 PanelBody 串行上传。
         * @param {any} event React drop 事件。
         * @returns {void}
         */
        function handleDrop(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          setDragActive(false)
          if (busy) return
          const transfer = event && event.dataTransfer ? event.dataTransfer : null
          const list = transfer && transfer.files ? transfer.files : null
          const files = list ? Array.prototype.slice.call(list) : []
          if (files.length === 0) return
          ctx.uploadFiles(files)
        }

        /**
         * 提交链接消化。
         * @param {any} [event] React submit 事件。
         * @returns {Promise<void>}
         */
        async function submitUrl(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (urlBusy) return
          const value = urlInput.trim()
          if (!isHttpUrl(value)) {
            setUrlError(t('url.invalid'))
            return
          }
          setUrlError('')
          setUrlBusy(true)
          try {
            const result = await ctx.ingestUrl(value)
            if (result && result.ok) {
              setUrlInput('')
            } else {
              setUrlError(result && result.message ? result.message : t('url.failed'))
            }
          } finally {
            setUrlBusy(false)
          }
        }

        /**
         * 提交粘贴文本消化。
         * @param {any} [event] React submit 事件。
         * @returns {Promise<void>}
         */
        async function submitPaste(event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (pasteBusy) return
          const text = pasteText.trim()
          if (!text) {
            setPasteError(t('paste.empty'))
            return
          }
          if (text.length > 2000000) {
            setPasteError(t('paste.tooLong', { n: 2000000 }))
            return
          }
          setPasteError('')
          setPasteBusy(true)
          try {
            const result = await ctx.ingestText(text, pasteTitle.trim())
            if (result && result.ok) {
              setPasteText('')
              setPasteTitle('')
              setPasteOpen(false)
            } else {
              setPasteError(result && result.message ? result.message : t('paste.failed'))
            }
          } finally {
            setPasteBusy(false)
          }
        }

        const busyText = uploadState.busy
          ? uploadState.total > 1
            ? t('upload.processing', { index: uploadState.index, total: uploadState.total, name: uploadState.name })
            : uploadState.phase === 'reading'
              ? t('upload.reading', { name: uploadState.name })
              : t('upload.uploading', { name: uploadState.name, size: formatBytes(uploadState.size) })
          : ''

        return h(
          'section',
          { className: 'kb-nav-section kb-upload' },
          h(
            'div',
            { className: 'kb-nav-head' },
            h('span', { className: 'kb-nav-title' }, t('upload.section')),
            initialized ? null : h('span', { className: 'kb-nav-tip' }, t('init.emptyAside')),
          ),
          h(
            'div',
            {
              className: 'kb-drop',
              'data-drag': dragActive ? 'true' : 'false',
              role: 'button',
              tabIndex: 0,
              'aria-label': t('upload.dropTitle'),
              onClick: pickFiles,
              onKeyDown: function (event) {
                if (event && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  pickFiles()
                }
              },
              onDragOver: handleDragOver,
              onDragEnter: handleDragOver,
              onDragLeave: handleDragLeave,
              onDrop: handleDrop,
            },
            h('span', { className: 'kb-drop-icon' }, busy ? h(Spinner) : h(UploadIcon, { size: 20 })),
            h('span', { className: 'kb-drop-title' }, dragActive ? t('upload.dragActive') : busy ? t('upload.busy') : t('upload.dropTitle')),
            h('span', { className: 'kb-drop-hint' }, busyText || t('upload.acceptHint', { size: formatBytes(maxBytes) })),
          ),
          h(
            'button',
            { type: 'button', className: 'kb-btn kb-btn-sm', onClick: pickFiles, disabled: busy },
            h(UploadIcon, { size: 12 }),
            h('span', null, t('upload.choose')),
          ),
          h('input', {
            ref: fileInputRef,
            className: 'kb-file-input',
            type: 'file',
            multiple: true,
            accept: ACCEPT_EXTENSIONS,
            onChange: handleInputChange,
            tabIndex: -1,
            'aria-hidden': 'true',
          }),
          h(
            'form',
            { className: 'kb-urlbar', onSubmit: submitUrl },
            h(
              'div',
              { className: 'kb-input-row' },
              h('span', { className: 'kb-input-icon' }, h(LinkIcon, { size: 14 })),
              h('input', {
                className: 'kb-input kb-url-input',
                type: 'text',
                value: urlInput,
                placeholder: t('url.placeholder'),
                'aria-label': t('url.section'),
                onChange: function (event) {
                  setUrlInput(event.target.value)
                  if (urlError) setUrlError('')
                },
                disabled: urlBusy,
                spellCheck: false,
                autoComplete: 'off',
              }),
              h(
                'button',
                { type: 'submit', className: 'kb-btn kb-btn-primary kb-btn-sm', disabled: urlBusy || !urlInput.trim() },
                urlBusy ? t('url.busy') : t('url.action'),
              ),
            ),
            urlError ? h('div', { className: 'kb-inline-error' }, urlError) : null,
          ),
          h(
            'div',
            { className: 'kb-paste' },
            h(
              'button',
              {
                type: 'button',
                className: 'kb-collapse',
                onClick: function () {
                  setPasteOpen(!pasteOpen)
                  setPasteError('')
                },
                'aria-expanded': pasteOpen ? 'true' : 'false',
              },
              h('span', { className: 'kb-collapse-icon' }, h(ChevronIcon, { size: 11, expanded: pasteOpen })),
              h(PasteIcon, { size: 14 }),
              h('span', null, t('paste.toggle')),
            ),
            pasteOpen
              ? h(
                  'form',
                  { className: 'kb-paste-form', onSubmit: submitPaste },
                  h('input', {
                    className: 'kb-input',
                    type: 'text',
                    value: pasteTitle,
                    placeholder: t('paste.titlePlaceholder'),
                    'aria-label': t('paste.titlePlaceholder'),
                    onChange: function (event) {
                      setPasteTitle(event.target.value)
                    },
                    disabled: pasteBusy,
                  }),
                  h('textarea', {
                    className: 'kb-textarea',
                    value: pasteText,
                    placeholder: t('paste.placeholder'),
                    'aria-label': t('paste.placeholder'),
                    rows: 5,
                    onChange: function (event) {
                      setPasteText(event.target.value)
                      if (pasteError) setPasteError('')
                    },
                    disabled: pasteBusy,
                  }),
                  pasteError ? h('div', { className: 'kb-inline-error' }, pasteError) : null,
                  h(
                    'div',
                    { className: 'kb-form-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: function () { setPasteOpen(false) }, disabled: pasteBusy },
                      t('paste.cancel'),
                    ),
                    h('button', { type: 'submit', className: 'kb-btn kb-btn-primary kb-btn-sm', disabled: pasteBusy || !pasteText.trim() }, pasteBusy ? t('paste.busy') : t('paste.action')),
                  ),
                )
              : null,
          ),
        )
      }

      // ======================================================================
      // 左栏：任务进度条（900ms 轮询由 PanelBody 负责）
      // ======================================================================

      /**
       * 当前编译任务进度卡片；失败时可重试，完成后可关闭。
       * @returns {any}
       */
      function JobStrip() {
        const ctx = useKb()
        const t = ctx.t
        const job = ctx.activeJob
        const [retrying, setRetrying] = useState(false)
        if (!job) return null
        const status = asString(job.status)
        const isFailed = FAILED_JOB_STATUS.indexOf(status) >= 0
        const isDone = status === 'done' || status === 'complete' || status === 'completed' || status === 'success'
        const isQueued = status === 'queued'
        const running = !isFailed && !isDone
        const percentValue = typeof job.progress === 'number' && isFinite(job.progress) ? job.progress * 100 : null
        // 排队中没有有意义进度：显示不确定动画
        const percent = isQueued || percentValue === null ? null : Math.round(clampNumber(percentValue, 0, 100))
        const pages = job.resultPages && job.resultPages.length ? job.resultPages.length : 0
        const headText = job.sourceTitle ? t('job.source', { title: job.sourceTitle }) : t('job.running')
        const stageText = isFailed
          ? job.error || t('job.failed')
          : isDone
            ? t('job.pages', { n: pages })
            : job.stage || job.message || (isQueued ? t('job.queued') : t('job.running'))

        /**
         * 失败任务重试：POST /compile { sourceId }。
         * @returns {Promise<void>}
         */
        async function retry() {
          if (retrying || !job.sourceId) return
          setRetrying(true)
          try {
            await ctx.retryJob(job)
          } finally {
            setRetrying(false)
          }
        }

        return h(
          'div',
          { className: 'kb-job', 'data-state': isFailed ? 'failed' : isDone ? 'done' : 'running' },
          h(
            'div',
            { className: 'kb-job-head' },
            h('span', { className: 'kb-job-title', title: headText }, headText),
            h('span', { className: 'kb-job-status' }, statusTextSpan(t, status, isFailed, isDone, isQueued, retrying)),
          ),
          running
            ? h(
                'div',
                {
                  className: 'kb-progress',
                  'data-indeterminate': percent === null ? 'true' : 'false',
                  role: 'progressbar',
                  'aria-label': t('job.progressAria'),
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': percent === null ? undefined : percent,
                  'aria-valuetext': stageText,
                },
                h('div', { className: 'kb-progress-bar', style: percent === null ? undefined : { width: percent + '%' } }),
              )
            : null,
          h(
            'div',
            { className: 'kb-job-msg' },
            stageText,
            running && percent !== null ? h('span', { className: 'kb-job-percent' }, t('job.progress', { n: percent })) : null,
          ),
          isFailed && job.sourceId
            ? h(
                'div',
                { className: 'kb-form-actions' },
                h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: retry, disabled: retrying }, retrying ? t('job.retrying') : t('job.retry')),
                h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.clearJob, disabled: retrying }, t('job.dismiss')),
              )
            : isDone
              ? h(
                  'div',
                  { className: 'kb-form-actions' },
                  h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.clearJob }, t('job.dismiss')),
                )
              : null,
        )
      }

      /**
       * 任务状态文案（含重试中的小提示）。
       * @param {Function} t 翻译函数。
       * @param {string} status 状态。
       * @param {boolean} isFailed 是否失败。
       * @param {boolean} isDone 是否完成。
       * @param {boolean} isQueued 是否排队。
       * @param {boolean} retrying 是否正在重试。
       * @returns {any}
       */
      function statusTextSpan(t, status, isFailed, isDone, isQueued, retrying) {
        if (retrying) return h(Spinner, { size: 'sm' })
        const text = isFailed ? t('job.failed') : isDone ? t('job.done') : isQueued ? t('job.queued') : t('job.running')
        return h('span', null, text)
      }

      // ======================================================================
      // 左栏：搜索框
      // ======================================================================

      /**
       * 搜索输入框（250ms 防抖由 PanelBody 负责，回车立即搜索）。
       * @returns {any}
       */
      function SearchBox() {
        const ctx = useKb()
        const t = ctx.t
        const loading = ctx.searchStatus === 'loading'
        return h(
          'div',
          { className: 'kb-search' },
          h('span', { className: 'kb-search-icon' }, h(SearchIcon, { size: 14 })),
          h('input', {
            className: 'kb-search-input',
            type: 'text',
            value: ctx.searchQuery,
            placeholder: t('search.placeholder'),
            onChange: function (event) {
              ctx.setSearchQuery(event.target.value)
            },
            onKeyDown: function (event) {
              if (event && event.key === 'Enter') {
                event.preventDefault()
                ctx.runSearchNow()
              }
            },
            spellCheck: false,
            autoComplete: 'off',
            'aria-label': t('search.placeholder'),
          }),
          loading ? h(Spinner, { size: 'sm' }) : null,
          ctx.searchQuery
            ? h(IconButton, { label: t('search.clear'), onClick: ctx.clearSearch }, h(CloseIcon, { size: 12 }))
            : null,
        )
      }

      // ======================================================================
      // 左栏：素材列表（状态点 / 页数 / 删除二次确认 / 失败重试）
      // ======================================================================

      /**
       * 左栏小节标题（可选计数）。
       * @param {{ title: string, count?: string }} props 属性。
       * @returns {any}
       */
      function NavSectionHead(props) {
        return h(
          'div',
          { className: 'kb-nav-head' },
          h('span', { className: 'kb-nav-title' }, props.title),
          props.count ? h('span', { className: 'kb-nav-count' }, props.count) : null,
          props.action ? h('span', { className: 'kb-header-spacer' }) : null,
          props.action || null,
        )
      }

      /**
       * 左栏素材列表（仅导航）：状态点 + 标题 + 元信息，点击打开摘要页。
       * 添加 / 重新编译 / 删除 / 批量管理统一放在「素材」tab，这里只留一个入口。
       * @returns {any}
       */
      function SourceList() {
        const ctx = useKb()
        const t = ctx.t
        const treeState = ctx.tree || {}
        const sources = treeState.data && Array.isArray(treeState.data.sources) ? treeState.data.sources : []
        const loading = treeState.status === 'loading' && sources.length === 0
        const failed = treeState.status === 'error'

        const manageLink = sources.length > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'kb-nav-action',
                onClick: function () {
                  ctx.setTab('sources')
                },
                title: t('sources.manageTip'),
                'aria-label': t('sources.manageTip'),
              },
              h(EditIcon, { size: 11 }),
              h('span', null, t('manage.enter')),
            )
          : null
        const head = h(NavSectionHead, {
          title: t('sources.title'),
          count: sources.length > 0 ? t('common.items', { n: sources.length }) : '',
          action: manageLink,
        })

        if (loading) {
          return h('section', { className: 'kb-nav-section' }, head, h('div', { className: 'kb-nav-loading' }, h(Spinner, { size: 'sm' }), h('span', null, t('common.loading'))))
        }
        if (failed) {
          return h(
            'section',
            { className: 'kb-nav-section' },
            head,
            h('div', { className: 'kb-nav-error' }, t('error.loadFailed')),
            h('button', { type: 'button', className: 'kb-linkbtn', onClick: ctx.loadTree }, t('common.retry')),
          )
        }
        if (sources.length === 0) {
          return h('section', { className: 'kb-nav-section' }, head, h('div', { className: 'kb-nav-empty' }, t('sources.empty')))
        }

        return h(
          'section',
          { className: 'kb-nav-section' },
          head,
          h(
            'div',
            { className: 'kb-source-list kb-inset' },
            sources.map(function (source, index) {
              if (!source || typeof source !== 'object') return null
              const id = asString(source.id) || 'source-' + index
              const status = asString(source.status) || 'queued'
              const pages = Array.isArray(source.pages) ? source.pages : []
              const title = asString(source.title) || asString(source.name) || id
              const relatedCount = pages.filter(function (path) { return path !== source.pagePath }).length
              const relatedLabel = t('sources.relatedCount', { n: relatedCount })
              const metaTitle = [kindLabel(t, source.kind), relatedLabel, sourceStatusLabel(t, status)].join(t('common.separator'))
              return h(
                'div',
                { key: id, className: 'kb-source', 'data-status': status },
                h(
                  'div',
                  { className: 'kb-source-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'kb-source-main',
                      onClick: function () {
                        ctx.openSourceOriginal(source)
                      },
                      title: status === 'failed' && source.error ? t('sources.failedTip', { message: asString(source.error) }) : title,
                    },
                    h('span', { className: 'kb-status-dot', 'data-status': status }),
                    h(
                      'span',
                      { className: 'kb-source-body' },
                      h('span', { className: 'kb-source-title' }, title),
                      h(
                        'span',
                        { className: 'kb-source-meta', title: metaTitle },
                        h('span', null, kindLabel(t, source.kind)),
                        h('span', { className: 'kb-meta-dot' }),
                        h('span', null, relatedLabel),
                        h('span', { className: 'kb-meta-dot' }),
                        h('span', null, sourceStatusLabel(t, status)),
                      ),
                    ),
                  ),
                ),
              )
            }),
          ),
        )
      }

      // ======================================================================
      // 左栏：实体 / 主题 / 素材摘要 分组页面列表
      // ======================================================================

      /**
       * 页面分组列表（可折叠，点击打开页面；支持批量管理，素材摘要页不可选）。
       * @returns {any}
       */
      function PageGroups() {
        const ctx = useKb()
        const t = ctx.t
        const [collapsed, setCollapsed] = useState({})
        const [managing, setManaging] = useState(false)
        const [selected, setSelected] = useState([])
        const [batchConfirm, setBatchConfirm] = useState(false)
        const [batchBusy, setBatchBusy] = useState(false)
        const [batchError, setBatchError] = useState('')
        const treeState = ctx.tree || {}
        const groups = treeState.data && Array.isArray(treeState.data.groups) ? treeState.data.groups : []
        const currentPath = ctx.page && ctx.page.path ? ctx.page.path : ''

        // 路径 → 条目（批量确认框预览与选中统计用）
        const itemIndex = useMemo(
          function () {
            const map = {}
            for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
              const group = groups[groupIndex]
              const type = asString(group && group.type) || 'other'
              const items = group && Array.isArray(group.items) ? group.items : []
              for (let index = 0; index < items.length; index += 1) {
                const item = items[index]
                if (!item || typeof item !== 'object') continue
                const path = asString(item.path)
                if (!path) continue
                const isSourceGroup = type === 'source' || type === 'sources'
                map[path] = { path: path, title: asString(item.title) || path, type: type, selectable: !isSourceGroup }
              }
            }
            return map
          },
          [groups],
        )
        const selectedItems = selected
          .map(function (path) {
            return itemIndex[path] || null
          })
          .filter(Boolean)
        const selectableCount = Object.keys(itemIndex).filter(function (path) { return itemIndex[path].selectable }).length

        /** @returns {void} 进入管理态。 */
        function enterManage() {
          setManaging(true)
          setSelected([])
          setBatchError('')
        }

        /** @returns {void} 退出管理态并清空选择。 */
        function exitManage() {
          setManaging(false)
          setSelected([])
          setBatchError('')
          setBatchConfirm(false)
        }

        /**
         * 切换某个页面的选中态（素材摘要页忽略）。
         * @param {string} path 页面路径。
         * @returns {void}
         */
        function toggleSelected(path) {
          const entry = itemIndex[path]
          if (!entry || !entry.selectable) return
          setSelected(function (previous) {
            return previous.indexOf(path) >= 0 ? previous.filter(function (item) { return item !== path }) : previous.concat([path])
          })
        }

        /** @returns {Promise<void>} 确认批量删除页面。 */
        async function confirmBatch() {
          if (batchBusy) return
          const paths = selected.slice()
          if (paths.length === 0) return
          setBatchBusy(true)
          setBatchError('')
          let result = null
          try {
            result = await ctx.deletePages(paths)
          } finally {
            setBatchBusy(false)
          }
          if (!result || !result.ok) {
            setBatchError(result && result.message ? result.message : t('manage.failed', { message: t('error.requestFailed') }))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          const deleted = Array.isArray(data.deleted) ? data.deleted.length : paths.length
          const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0
          ctx.showNotice('info', t('manage.deletedPages', { n: deleted }) + (skipped > 0 ? t('common.separator') + t('manage.skipped', { n: skipped }) : ''))
          exitManage()
        }

        const manageToggle = groups.length > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'kb-nav-action',
                onClick: managing ? exitManage : enterManage,
                title: managing ? t('manage.exit') : t('manage.enter'),
              },
              managing ? h(CheckIcon, { size: 11 }) : h(EditIcon, { size: 11 }),
              h('span', null, managing ? t('manage.exit') : t('manage.enter')),
            )
          : null
        const head = h(NavSectionHead, { title: t('groups.title'), count: '', action: manageToggle })

        if (!groups.length) {
          return h('section', { className: 'kb-nav-section' }, head, h('div', { className: 'kb-nav-empty' }, t('groups.empty')))
        }

        const manageBar = managing
          ? h(
              'div',
              { className: 'kb-manage-bar' },
              h('span', { className: 'kb-manage-text' }, t('manage.selected', { n: selected.length })),
              h('span', { className: 'kb-header-spacer' }),
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: exitManage, disabled: batchBusy }, t('manage.cancel')),
              h(
                'button',
                { type: 'button', className: 'kb-btn kb-btn-danger kb-btn-sm', onClick: function () { setBatchConfirm(true) }, disabled: batchBusy || selected.length === 0 },
                t('manage.delete'),
              ),
            )
          : null

        return h(
          'section',
          { className: 'kb-nav-section' },
          head,
          managing ? h('div', { className: 'kb-nav-tip' }, t('manage.sourceNotSelectable')) : null,
          manageBar,
          h(
            'div',
            { className: 'kb-groups kb-inset' },
            groups.map(function (group, groupIndex) {
              if (!group || typeof group !== 'object') return null
              const type = asString(group.type) || 'other'
              const items = Array.isArray(group.items) ? group.items : []
              if (type === 'source' || type === 'sources') return null
              const visibleItems = !managing && type === 'entity' ? items.filter(function (item) { return !item.materialDocument }) : items
              if (visibleItems.length === 0) return null
              const collapsedNow = !!collapsed[type]
              const label = pageTypeLabel(t, type)
              const isSourceGroup = type === 'source' || type === 'sources'
              return h(
                'div',
                { key: type + '-' + groupIndex, className: 'kb-group' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'kb-group-head',
                    onClick: function () {
                      setCollapsed(Object.assign({}, collapsed, { [type]: !collapsedNow }))
                    },
                    'aria-expanded': collapsedNow ? 'false' : 'true',
                  },
                  h('span', { className: 'kb-group-caret' }, h(ChevronIcon, { size: 11, expanded: !collapsedNow })),
                  h('span', { className: 'kb-group-label' }, label),
                  h('span', { className: 'kb-group-count' }, t('common.items', { n: visibleItems.length })),
                ),
                collapsedNow
                  ? null
                  : !managing && type === 'topic' ? h(TopicOutline, { t: t, nodes: items.map(function (item) { return Object.assign({ type: type }, item) }), selectedKey: currentPath, onSelect: ctx.openPage })
                  : !managing && type === 'entity' ? h(EntityCatalogue, { t: t, nodes: visibleItems.map(function (item) { return Object.assign({ type: type }, item) }), selectedKey: currentPath, onSelect: ctx.openPage, compact: true })
                  : h(
                      'div',
                      { className: 'kb-group-items' },
                      items.map(function (item, itemIndexValue) {
                        if (!item || typeof item !== 'object') return null
                        const path = asString(item.path)
                        const title = asString(item.title) || path || t('common.unknown')
                        const active = currentPath && path && currentPath === path
                        const isSelected = path && selected.indexOf(path) >= 0
                        if (managing) {
                          const selectable = !isSourceGroup
                          return h(
                            'label',
                            {
                              key: path || 'manage-' + itemIndexValue,
                              className: 'kb-page-manage-item',
                              'data-selected': isSelected ? 'true' : 'false',
                              'data-disabled': selectable ? 'false' : 'true',
                              title: selectable ? title : t('manage.sourceNotSelectable'),
                            },
                            h('input', {
                              className: 'kb-checkbox',
                              type: 'checkbox',
                              checked: !!isSelected,
                              disabled: !selectable || batchBusy,
                              onChange: function () {
                                if (path) toggleSelected(path)
                              },
                              'aria-label': title,
                              'aria-checked': isSelected ? 'true' : 'false',
                            }),
                            h('span', { className: 'kb-page-manage-title' }, title),
                          )
                        }
                        return h(
                          'button',
                          {
                            key: path || 'item-' + itemIndexValue,
                            type: 'button',
                            className: 'kb-page-item',
                            'data-active': active ? 'true' : 'false',
                            'aria-current': active ? 'page' : undefined,
                            onClick: function () {
                              if (path) ctx.openPage(path)
                            },
                            title: title,
                          },
                          h('span', { className: 'kb-page-item-title' }, title),
                        )
                      }),
                    ),
              )
            }),
          ),
          managing && selectableCount === 0 ? h('div', { className: 'kb-nav-tip' }, t('manage.emptyPages')) : null,
          batchConfirm
            ? h(ConfirmDialog, {
                t: t,
                title: t('manage.deletePagesTitle', { n: selected.length }),
                description: t('manage.deletePagesDesc'),
                confirmLabel: t('manage.deletePagesAction'),
                busyLabel: t('manage.deleting'),
                busy: batchBusy,
                error: batchError,
                onCancel: function () {
                  if (!batchBusy) setBatchConfirm(false)
                },
                onConfirm: confirmBatch,
                children: confirmPreviewList(t, selectedItems),
              })
            : null,
        )
      }

      // ======================================================================
      // 左栏整体
      // ======================================================================

      /**
       * 左栏容器：上传卡片、任务进度、搜索、素材、页面分组。
       * @returns {any}
       */
      function KbAside() {
        const ctx = useKb()
        const t = ctx.t
        const treeLoading = ctx.tree && ctx.tree.status === 'loading'
        return h(
          'aside',
          {
            className: 'kb-nav', id: 'kb-navigation', 'aria-label': t('header.navigation'),
            onKeyDown: function (event) {
              if (event.key !== 'Escape' || !ctx.navigationOpen) return
              event.preventDefault()
              event.stopPropagation()
              ctx.setNavigationOpen(false)
              const root = event.currentTarget.closest('.kb-root')
              const toggle = root && root.querySelector('.kb-navigation-toggle')
              if (toggle) toggle.focus()
            },
          },
          h(UploadCard, { fileInputRef: ctx.fileInputRef, pasteOpen: ctx.pasteOpen, setPasteOpen: ctx.setPasteOpen, pickFiles: ctx.pickFiles }),
          h(JobStrip),
          h('section', { className: 'kb-nav-section kb-search-section' }, h(SearchBox), h('div', { className: 'kb-nav-tip kb-search-hint' }, t('search.hint'))),
          h(SourceList),
          h(PageGroups),
          treeLoading ? h('div', { className: 'kb-nav-loading' }, h(Spinner, { size: 'sm' }), h('span', null, t('common.loading'))) : null,
        )
      }

      // ======================================================================
      // 总览：研究方向 / 统计 / 最近更新 / 最近素材 / 图谱预览
      // ======================================================================

      /**
       * 研究方向编辑卡片（保存走 POST /purpose）。
       * @returns {any}
       */
      function PurposeCard() {
        const ctx = useKb()
        const t = ctx.t
        const [editing, setEditing] = useState(false)
        const expanded = editing || ctx.purposeDirty || Boolean(ctx.purposeError)
        const editRef = useRef(null)
        const previousExpanded = useRef(expanded)
        useEffect(function () {
          if (previousExpanded.current && !expanded && editRef.current) editRef.current.focus()
          previousExpanded.current = expanded
        }, [expanded])
        const length = ctx.purposeDraft.length
        return h('section', { className: 'kb-purpose', 'data-editing': expanded },
          h('div', { className: 'kb-section-head' },
            h('h3', { className: 'kb-section-title' }, t('overview.purpose')),
            h('span', { className: 'kb-header-spacer' }),
            !expanded ? h('button', { type: 'button', className: 'kb-linkbtn', ref: editRef, 'aria-expanded': false, onClick: function () { setEditing(true) } }, h(EditIcon, { size: 12 }), ' ', t('page.edit')) : null,
          ),
          expanded ? h('div', { className: 'kb-purpose-editor' },
            h('p', { className: 'kb-section-sub' }, t('overview.purposeHint')),
            h('textarea', { className: 'kb-textarea kb-purpose-textarea', value: ctx.purposeDraft, placeholder: t('overview.purposeEmpty'), 'aria-label': t('overview.purpose'), maxLength: MAX_PURPOSE_CHARS, rows: 3, autoFocus: true, disabled: ctx.purposeSaving, onChange: function (event) { ctx.setPurposeDraft(event.target.value) } }),
            ctx.purposeError ? h('div', { className: 'kb-inline-error' }, ctx.purposeError) : null,
            h('div', { className: 'kb-purpose-foot' },
              h('span', { className: 'kb-counter' }, t('overview.purposeCounter', { n: length, max: MAX_PURPOSE_CHARS })),
              h('span', { className: 'kb-header-spacer' }),
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', disabled: ctx.purposeDirty || ctx.purposeSaving, onClick: function () { setEditing(false) } }, t('dialog.close')),
              h('button', { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', disabled: !ctx.purposeDirty || ctx.purposeSaving, onClick: async function () { await ctx.savePurpose(); setEditing(false) } }, ctx.purposeSaving ? t('overview.purposeSaving') : t('overview.purposeSave')),
            ),
          ) : h('p', { className: 'kb-purpose-summary' }, ctx.purposeDraft || t('overview.purposeEmpty')),
        )
      }

      /**
       * 统计卡片。
       * @param {{ t: Function, stats: any, overview: any }} props 属性。
       * @returns {any}
       */
      function StatsGrid(props) {
        const t = props.t
        const stats = props.stats || {}
        const cards = [
          { key: 'sources', value: stats.sources, label: t('overview.stats.sources') },
          { key: 'entities', value: stats.entities, label: t('overview.stats.entities') },
          { key: 'topics', value: stats.topics, label: t('overview.stats.topics') },
          { key: 'pages', value: stats.pages, label: t('overview.stats.pages') },
        ]
        return h(
          'div',
          { className: 'kb-stats' },
          cards.map(function (card) {
            const value = typeof card.value === 'number' && isFinite(card.value) ? card.value : 0
            return h(
              'div',
              { key: card.key, className: 'kb-stat' },
              h('span', { className: 'kb-stat-value' }, String(value)),
              h('span', { className: 'kb-stat-label' }, card.label),
            )
          }),
        )
      }

      /**
       * 总览面板。
       * @returns {any}
       */
      function Overview() {
        const ctx = useKb()
        const t = ctx.t
        const state = ctx.overview || {}
        const data = state.data && typeof state.data === 'object' ? state.data : null
        if (!data) {
          if (state.status === 'error') {
            return h(
              'div',
              { className: 'kb-overview' },
              h(ErrorBlock, { t: t, text: t('overview.failed', { message: asString(state.error) || t('error.requestFailed') }), onRetry: ctx.loadOverview }),
            )
          }
          return h('div', { className: 'kb-overview' }, h(LoadingBlock, { t: t, text: t('overview.loading') }))
        }

        const stats = data.stats && typeof data.stats === 'object' ? data.stats : {}
        const recentPages = Array.isArray(data.recentPages) ? data.recentPages : []
        const recentSources = Array.isArray(data.recentSources) ? data.recentSources : []
        // Host 的 /overview.graph 是计数（{nodes:number,edges:number}）；/graph 才是节点数组
        const graphInfo = data.graph && typeof data.graph === 'object' ? data.graph : null
        const cachedGraph = ctx.graphData && Array.isArray(ctx.graphData.nodes) ? ctx.graphData : null
        const graphPreview = cachedGraph && cachedGraph.nodes.length > 0 ? cachedGraph : null
        const graphNodeCount = graphPreview ? graphPreview.nodes.length : graphInfo && typeof graphInfo.nodes === 'number' ? graphInfo.nodes : 0
        const graphEdgeCount = graphPreview ? graphPreview.edges.length : graphInfo && typeof graphInfo.edges === 'number' ? graphInfo.edges : 0
        const isEmpty = (typeof stats.pages === 'number' ? stats.pages : 0) === 0 && (typeof stats.sources === 'number' ? stats.sources : 0) === 0
        const modelInfo = data.model && typeof data.model === 'object' ? data.model : ctx.meta && ctx.meta.data ? ctx.meta.data.model : null
        const modelText = modelInfo ? asString(modelInfo.label) || [asString(modelInfo.provider), asString(modelInfo.model)].filter(Boolean).join(' / ') : ''

        return h(
          'div',
          { className: 'kb-overview' },
          h(
            'div',
            { className: 'kb-overview-head' },
            h('h2', { className: 'kb-overview-title' }, t('overview.title')),
            h(
              'span',
              { className: 'kb-overview-sub' },
              t('overview.charTotal', { n: typeof stats.chars === 'number' && isFinite(stats.chars) ? stats.chars : 0 }),
              modelText ? h('span', { className: 'kb-meta-dot' }) : null,
              modelText ? t('overview.modelLabel', { model: modelText }) : null,
            ),
          ),
          h(PurposeCard),
          h(StatsGrid, { t: t, stats: stats }),
          isEmpty
            ? h(EmptyBlock, {
                t: t,
                title: t('overview.empty.title'),
                hint: t('overview.empty.hint'),
                icon: h(BrandGlyph, { size: 26 }),
                action: h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    { key: 'upload', type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: ctx.pickFiles },
                    h(UploadIcon, { size: 13 }),
                    h('span', null, t('upload.dropTitle')),
                  ),
                  h(
                    'button',
                    { key: 'paste', type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.openPaste },
                    h(PasteIcon, { size: 13 }),
                    h('span', null, t('paste.toggle')),
                  ),
                ),
              })
            : h(
                'div',
                { className: 'kb-cols' },
                h(
                  'section',
                  { className: 'kb-panel' },
                  h(
                    'div',
                    { className: 'kb-section-head' },
                    h('h3', { className: 'kb-section-title' }, t('overview.recentPages')),
                  ),
                  recentPages.length === 0
                    ? h('div', { className: 'kb-nav-empty' }, t('overview.noRecentPages'))
                    : h(
                        'div',
                        { className: 'kb-list kb-inset' },
                        recentPages.map(function (page, index) {
                          if (!page || typeof page !== 'object') return null
                          const path = asString(page.path)
                          const title = asString(page.title) || path || t('common.unknown')
                          return h(
                            'button',
                            {
                              key: path || 'recent-page-' + index,
                              type: 'button',
                              className: 'kb-list-item',
                              onClick: function () {
                                if (path) ctx.openPage(path)
                              },
                            },
                            h(
                              'span',
                              { className: 'kb-list-main' },
                              h('span', { className: 'kb-list-title' }, title),
                              h('span', { className: 'kb-list-meta' }, h(TypeBadge, { t: t, type: asString(page.type) })),
                            ),
                            page.updatedAt ? h('span', { className: 'kb-list-time' }, formatTime(page.updatedAt)) : null,
                          )
                        }),
                      ),
                ),
                h(
                  'section',
                  { className: 'kb-panel' },
                  h('div', { className: 'kb-section-head' }, h('h3', { className: 'kb-section-title' }, t('overview.recentSources'))),
                  recentSources.length === 0
                    ? h('div', { className: 'kb-nav-empty' }, t('overview.noRecentSources'))
                    : h(
                        'div',
                        { className: 'kb-list kb-inset' },
                        recentSources.map(function (source, index) {
                          if (!source || typeof source !== 'object') return null
                          const title = asString(source.title) || asString(source.id) || t('common.unknown')
                          return h(
                            'button',
                            {
                              key: asString(source.id) || 'recent-source-' + index,
                              type: 'button',
                              className: 'kb-list-item',
                              onClick: function () {
                                ctx.openSourceOriginal(source)
                              },
                            },
                            h(
                              'span',
                              { className: 'kb-list-main' },
                              h('span', { className: 'kb-list-title' }, title),
                              h(
                                'span',
                                { className: 'kb-list-meta' },
                                h('span', null, kindLabel(t, source.kind)),
                                h('span', { className: 'kb-meta-dot' }),
                                h('span', null, sourceStatusLabel(t, source.status)),
                              ),
                            ),
                            source.createdAt ? h('span', { className: 'kb-list-time' }, formatTime(source.createdAt)) : null,
                          )
                        }),
                      ),
                ),
              ),
          graphNodeCount > 0
            ? h(
                'section',
                { className: 'kb-panel kb-graph-preview' },
                h(
                  'div',
                  { className: 'kb-section-head' },
                  h('h3', { className: 'kb-section-title' }, t('overview.graphPreview')),
                  h('span', { className: 'kb-section-sub' }, t('graph.nodes', { n: graphNodeCount }), t('common.separator'), t('graph.edges', { n: graphEdgeCount })),
                  h('span', { className: 'kb-header-spacer' }),
                  h(
                    'button',
                    { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.setTab('graph') } },
                    t('overview.openGraph'),
                  ),
                ),
                graphPreview
                  ? h(MiniGraph, { graph: graphPreview, t: t, onOpenPath: ctx.openPage })
                  : h('div', { className: 'kb-nav-empty' }, t('graph.empty.hint')),
              )
            : null,
        )
      }

      /**
       * 总览里的小图谱预览（只读、无布局按钮，节点最多 40 个）。
       * @param {{ graph: any, t: Function, onOpenPath: Function }} props 属性。
       * @returns {any}
       */
      function MiniGraph(props) {
        const t = props.t
        const graph = props.graph && typeof props.graph === 'object' ? props.graph : { nodes: [], edges: [] }
        const width = 640
        const height = 200
        const layout = useMemo(
          function () {
            const allNodes = Array.isArray(graph.nodes) ? graph.nodes : []
            const allEdges = Array.isArray(graph.edges) ? graph.edges : []
            const sorted = allNodes
              .slice()
              .sort(function (a, b) {
                return (typeof b.degree === 'number' ? b.degree : 0) - (typeof a.degree === 'number' ? a.degree : 0)
              })
              .slice(0, 40)
            const ids = {}
            for (let index = 0; index < sorted.length; index += 1) ids[asString(sorted[index].id) || asString(sorted[index].path)] = true
            const edges = allEdges.filter(function (edge) {
              return edge && ids[asString(edge.source)] && ids[asString(edge.target)]
            })
            const positions = computeGraphLayout(sorted, edges, width, height, 2, 60)
            return { nodes: sorted, edges: edges, positions: positions }
          },
          [graph],
        )
        if (!layout.nodes.length) return h('div', { className: 'kb-nav-empty' }, t('graph.empty.hint'))
        const positionMap = layout.positions
        return h(
          'div',
          { className: 'kb-mini-graph' },
          h(
            'svg',
            { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': t('overview.graphPreview') },
            layout.edges.map(function (edge, index) {
              const source = positionMap[asString(edge.source)]
              const target = positionMap[asString(edge.target)]
              if (!source || !target) return null
              return h('line', {
                key: 'me-' + index,
                x1: source.x,
                y1: source.y,
                x2: target.x,
                y2: target.y,
                className: 'kb-graph-edge',
              })
            }),
            layout.nodes.map(function (node, index) {
              const key = asString(node.id) || asString(node.path)
              const position = positionMap[key]
              if (!position) return null
              const type = asString(node.type) || 'source'
              const color = NODE_COLORS[type] || NODE_COLOR_FALLBACK
              return h(
                'g',
                { key: key || 'mn-' + index, className: 'kb-graph-node' },
                h('circle', { cx: position.x, cy: position.y, r: position.r || 4, style: { fill: color } }),
                h('title', null, asString(node.title) || key),
                node.path
                  ? h('circle', {
                      cx: position.x,
                      cy: position.y,
                      r: (position.r || 4) + 2,
                      className: 'kb-graph-hit',
                      onClick: function () {
                        props.onOpenPath(asString(node.path))
                      },
                    })
                  : null,
              )
            }),
          ),
        )
      }

      // ======================================================================
      // 页面阅读（frontmatter 徽章 / Markdown / [[链接]] / 反向链接 / 来源素材）
      // ======================================================================

      /**
       * 把来源引用补齐成可点击目标（pagePath 优先，兼容仅有 pages 的旧形状）。
       * @param {any} ctx 面板上下文。
       * @param {any} ref 来源引用（sourceRefs / recentSources / tree.sources 项）。
       * @returns {{ pagePath: string, url: string }}
       */
      function resolveSourceTarget(ctx, ref) {
        const result = {
          pagePath: asString(ref && ref.pagePath),
          url: asString(ref && ref.url),
        }
        if (result.pagePath && result.url) return result
        const sources = ctx && ctx.tree && ctx.tree.data && Array.isArray(ctx.tree.data.sources) ? ctx.tree.data.sources : []
        const id = asString(ref && ref.id)
        if (!id) return result
        for (let index = 0; index < sources.length; index += 1) {
          const item = sources[index]
          if (!item || asString(item.id) !== id) continue
          if (!result.pagePath) {
            result.pagePath = asString(item.pagePath)
            if (!result.pagePath && Array.isArray(item.pages) && item.pages.length > 0) result.pagePath = asString(item.pages[0])
          }
          if (!result.url) result.url = asString(item.url)
          break
        }
        return result
      }

      /**
       * 页面阅读视图。
       * @returns {any}
       */
      function conversationScope(t, scope) {
        if (scope === zh['conversation.full']) return t('conversation.full')
        const selection = /^所选 (\d+) 条消息$/.exec(scope || '')
        return selection ? t('conversation.selected', { n: selection[1] }) : scope
      }

      function ConversationReader({ page, wikiMap, onOpenPath, onEdit, editDialog }) {
        const ctx = useKb()
        const t = ctx.t
        const unknownModel = t('conversation.unknownModel')
        const data = page.conversation
        const messages = data.messages
        const models = Array.isArray(data.models) ? data.models : []
        const missingModel = messages.some(m => m.role === 'assistant' && !m.model?.model)
        const promptCount = messages.filter(m => m.role === 'user').length
        const groups = []
        for (const message of messages) {
          const previous = groups[groups.length - 1]
          if (previous?.role === message.role) previous.messages.push(message)
          else groups.push({ role: message.role, messages: [message] })
        }
        const timeline = groups.map(group => {
          const human = group.role === 'user'
          const first = group.messages[0]
          const groupModels = [...new Map(group.messages.map(m => [m.model?.provider + '/' + m.model?.model, m.model])).values()]
          return h('section', { key: first.id, className: 'kb-conversation-message', 'data-role': group.role, 'aria-label': t(human ? 'conversation.mine' : 'conversation.reply') },
            h('div', { className: 'kb-conversation-byline' },
              h('strong', null, human ? t('conversation.me') : 'AI'),
              !human ? groupModels.map((model, i) => h('span', { key: i, className: 'kb-conversation-model', title: model?.provider ? t('conversation.provider', { name: model.provider }) : undefined }, model?.model || unknownModel)) : null),
            h('div', { className: 'kb-conversation-text' }, group.messages.map((message, index) => {
              const previous = group.messages[index - 1]
              const changed = previous && (previous.model?.model !== message.model?.model || previous.model?.provider !== message.model?.provider)
              return h('div', { key: message.id, className: 'kb-conversation-fragment', 'data-message-id': message.id },
                changed ? h('span', { className: 'kb-conversation-model-change' }, t('conversation.modelChange', { name: message.model?.model || unknownModel })) : null,
                human ? h('div', { className: 'kb-conversation-prompt' }, message.text) : h(MarkdownBlock, { source: message.text, wikiMap, onOpenPath, t }))
            })),
            first.time ? h('time', { className: 'kb-conversation-time', dateTime: first.time, title: formatDateTime(first.time) }, formatDateTime(first.time)) : null)
        })
        const text = '# ' + page.title + '\n\n' + groups.map(group => '## ' + (group.role === 'user' ? t('conversation.me') : 'AI · ' + [...new Set(group.messages.map(m => m.model?.model || unknownModel))].join(' / ')) + '\n\n' + group.messages.map(m => m.text).join('\n\n')).join('\n\n')
        return h('article', { className: 'kb-reader kb-conversation-reader' },
          h('div', { className: 'kb-reader-inner' },
            h('nav', { className: 'kb-conversation-toolbar', 'aria-label': t('conversation.actions') },
              h('button', { className: 'kb-btn kb-btn-ghost', type: 'button', onClick: ctx.returnFromPage }, h(ArrowLeftIcon, { size: 14 }), t('tab.conversations')),
              h('span', { className: 'kb-header-spacer' }),
              h('button', { className: 'kb-btn kb-btn-ghost', type: 'button', onClick: () => ctx.openSourceOriginal(page.sourceRefs[0]) }, t('source.original.short')),
              h('button', { className: 'kb-btn', type: 'button', onClick: () => ctx.copyText(text, t('conversation.copied')) }, t('conversation.copy'))),
            h('header', { className: 'kb-conversation-heading' },
              h('p', { className: 'kb-conversation-eyebrow' }, t('conversation.collection')),
              h('h1', null, page.title),
              h('p', { className: 'kb-conversation-subtitle' }, t('conversation.prompts', { n: promptCount }), h('span', { 'aria-hidden': true }, ' · '), t('conversation.messages', { n: messages.length }), h('span', { 'aria-hidden': true }, ' · '), t('conversation.savedAt', { date: formatDateTime(data.savedAt || page.createdAt) })),
              h('div', { className: 'kb-conversation-models' }, h('span', null, t('conversation.models')),
                models.map((model, index) => h('span', { key: index, className: 'kb-conversation-model', title: model.provider ? t('conversation.provider', { name: model.provider }) : undefined }, model.model)),
                missingModel || !models.length ? h('span', { className: 'kb-conversation-model kb-conversation-unknown' }, models.length ? t('conversation.partialModels') : unknownModel) : null)),
            h('div', { className: 'kb-conversation-timeline' }, timeline),
            h('details', { className: 'kb-conversation-details' },
              h('summary', null, t('conversation.details')),
              h('dl', null,
                h('dt', null, t('conversation.source')), h('dd', null, t('conversation.dshSource')),
                h('dt', null, t('conversation.scope')), h('dd', null, conversationScope(t, data.scope)),
                h('dt', null, t('conversation.session')), h('dd', null, data.sessionId),
                h('dt', null, t('conversation.modelRecord')), h('dd', null, models.length ? models.map(m => m.provider ? t('conversation.modelWithProvider', { model: m.model, provider: m.provider }) : m.model).join(' · ') : t('conversation.noModelRecord'))),
              h('p', null, t('conversation.recordNote')),
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: onEdit }, t('page.edit'))),
            editDialog))
      }

      function PageReader() {
        const ctx = useKb()
        const t = ctx.t
        const pageState = ctx.page || {}
        const page = pageState.data && typeof pageState.data === 'object' ? pageState.data : null
        const links = page && Array.isArray(page.links) ? page.links : []
        const sourceRefs = page && Array.isArray(page.sourceRefs) ? page.sourceRefs : []

        // hooks 必须在任何 return 之前无条件调用
        const wikiMap = useMemo(
          function () {
            const map = new Map()
            for (let index = 0; index < links.length; index += 1) {
              const link = links[index]
              if (!link || typeof link !== 'object') continue
              const linkTitle = asString(link.title)
              if (!linkTitle) continue
              const entry = { title: linkTitle, path: typeof link.path === 'string' && link.path ? link.path : null }
              map.set(linkTitle, entry)
              map.set(linkTitle.toLowerCase(), entry)
            }
            return map
          },
          [links],
        )

        const sourceTargets = useMemo(
          function () {
            return sourceRefs.map(function (ref) {
              return { ref: ref, target: resolveSourceTarget(ctx, ref) }
            })
          },
          [sourceRefs, ctx.tree],
        )

        // 稳定回调：避免每次父级渲染都让 Markdown 重新解析
        const stableOpenPath = useMemo(function () {
          return function (path) {
            ctx.openPage(path)
          }
        }, [])

        const [editOpen, setEditOpen] = useState(false)
        const [organizeOpen, setOrganizeOpen] = useState(false)
        const [deleteOpen, setDeleteOpen] = useState(false)
        const [deleteBusy, setDeleteBusy] = useState(false)
        const [deleteError, setDeleteError] = useState('')

        /**
         * 保存编辑（PUT /page），由 PanelBody.updatePage 统一封装。
         * @param {any} body 表单字段。
         * @returns {Promise<any>}
         */
        async function savePageEdit(body) {
          return ctx.updatePage(body)
        }

        /**
         * 编辑保存成功：关闭弹层、notice、刷新页面与列表。
         * @returns {Promise<void>}
         */
        async function handleEditSaved() {
          setEditOpen(false)
          ctx.showNotice('info', t('edit.saved'))
          await ctx.refreshContent()
        }

        /**
         * 确认删除当前页面（进回收站）。
         * @returns {Promise<void>}
         */
        async function confirmDelete() {
          if (deleteBusy) return
          setDeleteBusy(true)
          setDeleteError('')
          let result = null
          try {
            result = await ctx.deletePageFile(path)
          } finally {
            setDeleteBusy(false)
          }
          if (!result || !result.ok) {
            setDeleteError(result && result.message ? result.message : t('page.deleteFailed', { message: t('error.requestFailed') }))
            return
          }
          setDeleteOpen(false)
          ctx.showNotice('info', t('page.deleted'))
        }

        if (!page) return null
        const path = asString(page.path) || asString(pageState.path)
        const title = asString(page.title) || path || t('common.unknown')
        const markdown = asString(page.markdown)
        const tags = Array.isArray(page.tags) ? page.tags : []
        const aliases = Array.isArray(page.aliases) ? page.aliases : []
        const backlinks = Array.isArray(page.backlinks) ? page.backlinks : []
        const readOnly = page.readOnly === true
        const excerptArticle = page.article && typeof page.article === 'object' ? page.article : {}
        const excerptHref = safeHref(excerptArticle.url)

        if (page.conversation?.messages && !page.userEditedAt) return h(ConversationReader, {
          page, wikiMap, onOpenPath: stableOpenPath,
          onEdit: () => setEditOpen(true),
          editDialog: editOpen ? h(EditPageDialog, { t, page, onClose: () => setEditOpen(false), onSave: savePageEdit, onSaved: handleEditSaved }) : null,
        })

        return h(
          'article',
          { className: 'kb-reader' },
          h(
            'div',
            { className: 'kb-reader-inner' },
            h(
              'div',
              { className: 'kb-reader-top' },
              h(
                'button',
                { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.returnFromPage },
                h(ArrowLeftIcon, { size: 13 }),
                h('span', null, ctx.pageBackLabel),
              ),
              h('span', { className: 'kb-header-spacer' }),
              h(
                'span',
                { className: 'kb-reader-actions', role: 'group', 'aria-label': t('reader.actionsLabel') },
                path
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'kb-iconbtn',
                        'aria-label': t('page.copyPath'),
                        title: t('page.pathTip', { path: path }),
                        onClick: function () {
                          ctx.copyText(path, t('page.pathCopied'))
                        },
                      },
                      h(FolderIcon, { size: 15 }),
                    )
                  : null,
                asString(page.type) === 'source' && sourceRefs.length > 0
                  ? h(
                      'button',
                      { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { ctx.openSourceOriginal(sourceRefs[0]) }, title: t('source.original.open'), 'aria-label': t('source.original.open') },
                      h(FileIcon, { size: 12 }),
                      h('span', null, t('source.original.open')),
                    )
                  : null,
                !readOnly ? h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setEditOpen(true); setDeleteError('') }, title: t('page.edit'), 'aria-label': t('page.edit') },
                  h(EditIcon, { size: 12 }),
                  h('span', null, t('page.edit')),
                ) : null,
                !readOnly && asString(page.type) !== 'source' ? h(ActionDisclosure, { t: t, actions: [
                  asString(page.type) === 'topic' || asString(page.type) === 'entity' ? { label: t('taxonomy.organize'), onClick: function () { setOrganizeOpen(true) } } : null,
                  { label: t('page.delete'), onClick: function () { setDeleteOpen(true); setDeleteError('') } },
                ].filter(Boolean) }) : null,
              ),
            ),
            h('h1', { className: 'kb-page-title' }, title),
            h(
              'div',
              { className: 'kb-page-meta' },
              sourceRefs.some(source => source.kind === 'conversation') ? h('span', { className: 'kb-chip kb-chip-sm' }, t('conversation.original')) : h(TypeBadge, { t: t, type: asString(page.type) }),
              h(ConfidenceBadge, { t: t, confidence: asString(page.confidence) }),
              page.updatedAt ? h('span', { className: 'kb-page-time' }, t('common.updated', { time: formatDateTime(page.updatedAt) })) : null,
              tags.map(function (tag, index) {
                return h('span', { key: 'tag-' + index, className: 'kb-chip kb-chip-sm' }, asString(tag))
              }),
            ),
            aliases.length > 0
              ? h(
                  'div',
                  { className: 'kb-page-aliases' },
                  h('span', { className: 'kb-page-aliases-label' }, t('page.aliasesLabel')),
                  h('span', null, aliases.map(function (alias) { return asString(alias) }).filter(Boolean).join(t('page.aliasesSeparator'))),
                )
              : null,
            page.userEditedAt
              ? h(
                  'div',
                  { className: 'kb-page-edited' },
                  h(EditIcon, { size: 11 }),
                  h('span', null, t('page.userEdited', { time: formatDateTime(page.userEditedAt) })),
                )
              : null,
            page.parentPath ? h('div', { className: 'kb-page-edited' },
              h('span', null, t('page.evidenceLines', { start: page.startLine, end: page.endLine })),
              h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.openPage(page.parentPath) } }, t('page.fullText'))) : null,
            page.sourceUrl && safeHref(page.sourceUrl) ? h('p', { className: 'kb-page-edited' }, h('a', { href: safeHref(page.sourceUrl), target: '_blank', rel: 'noopener noreferrer' }, t('source.original.openUrl'))) : null,
            readOnly && asString(page.type) === 'excerpt' ? h('p', { className: 'kb-page-edited' }, t('page.excerptOrigin')) : null,
            h('div', { className: 'kb-page-body' }, typeof page.originalText === 'string'
              ? h('pre', { className: 'kb-book-original', tabIndex: 0 }, page.originalText)
              : asString(page.type) === 'excerpt' && typeof page.excerptText === 'string'
              ? h('div', { className: 'kb-md' },
                  h('blockquote', { className: 'kb-md-quote', style: { whiteSpace: 'pre-wrap' } }, page.excerptText),
                  h('p', { className: 'kb-md-p' }, t('page.excerptSource'),
                    excerptHref ? h('a', { href: excerptHref, target: '_blank', rel: 'noopener noreferrer' }, asString(excerptArticle.title) || excerptHref)
                      : asString(excerptArticle.title) || title,
                    excerptArticle.site ? ' · ' + asString(excerptArticle.site) : null))
              : h(MarkdownBlock, { source: markdown, wikiMap: wikiMap, onOpenPath: stableOpenPath, t: t })),
            !readOnly ? h(
              'section',
              { className: 'kb-panel kb-reader-foot' },
              h('div', { className: 'kb-section-head' }, h('h3', { className: 'kb-section-title' }, t('page.backlinks'))),
              backlinks.length === 0
                ? h('div', { className: 'kb-nav-empty' }, t('page.backlinksEmpty'))
                : h(
                    'div',
                    { className: 'kb-linklist kb-inset' },
                    backlinks.map(function (link, index) {
                      if (!link || typeof link !== 'object') return null
                      const linkPath = asString(link.path)
                      return h(
                        'button',
                        {
                          key: linkPath || 'backlink-' + index,
                          type: 'button',
                          className: 'kb-linkitem',
                          onClick: function () {
                            if (linkPath) ctx.openPage(linkPath)
                          },
                        },
                        h('span', { className: 'kb-linkitem-title' }, asString(link.title) || linkPath),
                      )
                    }),
                  ),
            ) : null,
            !readOnly ? h(
              'section',
              { className: 'kb-panel' },
              h('div', { className: 'kb-section-head' }, h('h3', { className: 'kb-section-title' }, t('page.sources'))),
              sourceRefs.length === 0
                ? h('div', { className: 'kb-nav-empty' }, t('page.sourcesEmpty'))
                : h(
                    'div',
                    { className: 'kb-linklist kb-inset' },
                    sourceTargets.map(function (item, index) {
                      const ref = item.ref || {}
                      const target = item.target || {}
                      const refTitle = asString(ref.title) || asString(ref.name) || asString(ref.id) || t('common.unknown')
                      const href = safeHref(target.url)
                      return h(
                        'div',
                        { key: asString(ref.id) || 'source-ref-' + index, className: 'kb-sourceref' },
                        h(
                          'span',
                          { className: 'kb-sourceref-main' },
                          h('span', { className: 'kb-badge kb-badge-kind' }, kindLabel(t, ref.kind)),
                          h('span', { className: 'kb-sourceref-title' }, refTitle),
                          h('span', { className: 'kb-meta-dot' }),
                          h('span', { className: 'kb-sourceref-status' }, t('page.sourceStatus', { status: sourceStatusLabel(t, ref.status) })),
                        ),
                        h(
                          'span',
                          { className: 'kb-sourceref-actions' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'kb-linkbtn',
                              onClick: function () {
                                ctx.openSourceOriginal({ id: asString(ref.id) })
                              },
                            },
                            t('source.original.open'),
                          ),
                          target.pagePath
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'kb-linkbtn',
                                  onClick: function () {
                                    ctx.openPage(target.pagePath)
                                  },
                                },
                                t('page.openSource'),
                              )
                            : null,
                          href
                            ? h('a', { className: 'kb-linkbtn', href: href, target: '_blank', rel: 'noreferrer' }, t('page.openOriginalUrl'))
                            : null,
                        ),
                      )
                    }),
                  ),
            ) : null,
            organizeOpen ? h(TaxonomyDialog, { page: page, nodes: ctx.tree && ctx.tree.data && Array.isArray(ctx.tree.data.groups) ? ctx.tree.data.groups.reduce(function (all, group) { return all.concat((group.items || []).map(function (item) { return Object.assign({ type: group.type }, item) })) }, []) : [], onClose: function () { setOrganizeOpen(false) }, onSaved: function () { setOrganizeOpen(false); ctx.openPage(path) } }) : null,
            editOpen
              ? h(EditPageDialog, {
                  t: t,
                  page: page,
                  onClose: function () {
                    setEditOpen(false)
                  },
                  onSave: savePageEdit,
                  onSaved: handleEditSaved,
                })
              : null,
            deleteOpen
              ? h(ConfirmDialog, {
                  t: t,
                  title: t('page.deleteTitle'),
                  description: t('page.deleteDesc', { title: title }),
                  confirmLabel: t('page.deleteAction'),
                  busyLabel: t('page.deleting'),
                  busy: deleteBusy,
                  error: deleteError,
                  onCancel: function () {
                    if (!deleteBusy) setDeleteOpen(false)
                  },
                  onConfirm: confirmDelete,
                })
              : null,
          ),
        )
      }

      // ======================================================================
      // 搜索结果显示（main 区顶部，不新开 tab）
      // ======================================================================

      /**
       * 搜索结果面板。
       * @returns {any}
       */
      function SearchResults() {
        const ctx = useKb()
        const t = ctx.t
        const results = Array.isArray(ctx.searchResults) ? ctx.searchResults : []
        const total = typeof ctx.searchTotal === 'number' ? ctx.searchTotal : results.length
        const q = ctx.searchQuery.trim()
        const loading = ctx.searchStatus === 'loading'
        return h(
          'section',
          { className: 'kb-search-results' },
          h(
            'div',
            { className: 'kb-section-head' },
            h('h3', { className: 'kb-section-title' }, loading && results.length === 0 ? t('search.busy') : t('search.results', { q: q, n: total })),
            h('span', { className: 'kb-header-spacer' }),
            loading ? h(Spinner, { size: 'sm' }) : null,
            h(IconButton, { label: t('search.clear'), onClick: ctx.clearSearch }, h(CloseIcon, { size: 12 })),
          ),
          ctx.searchStatus === 'error' ? h('div', { className: 'kb-inline-error' }, t('search.failed')) : null,
          Array.isArray(ctx.searchWarnings) ? ctx.searchWarnings.map(function (warning, index) {
            return h('p', { key: index, className: 'kb-list-meta', role: 'status' }, warning)
          }) : null,
          !loading && results.length === 0 ? h('div', { className: 'kb-nav-empty' }, t('search.empty', { q: q })) : null,
          h(
            'div',
            { className: 'kb-list kb-inset' },
            results.map(function (result, index) {
              if (!result || typeof result !== 'object') return null
              const path = asString(result.evidencePath) || asString(result.path)
              const material = asString(result.sourceId)
              const key = asString(result.key) || path || 'search-' + index
              const row = h(
                'button',
                {
                  key: key,
                  type: 'button',
                  className: 'kb-list-item kb-search-result',
                  onClick: function () {
                    if (material) ctx.openSourceOriginal({ id: material, title: result.title })
                    else if (path) ctx.openPage(path)
                  },
                },
                h(
                  'span',
                  { className: 'kb-list-main' },
                  h(
                    'span',
                    { className: 'kb-list-title' },
                    asString(result.title) || path || t('common.unknown'),
                    material ? h('span', { className: 'kb-badge kb-badge-kind' }, t('sources.title')) : h(TypeBadge, { t: t, type: asString(result.type) }),
                  ),
                  asString(result.snippet) ? h('span', { className: 'kb-search-snippet' }, cleanSearchSnippet(asString(result.snippet))) : null,
                  material ? h('span', { className: 'kb-list-meta' }, [
                    result.matchType ? t('search.sourceMatch', { type: pageTypeLabel(t, result.matchType) }) : '',
                    result.matchCount > 1 ? t('search.sourceMatches', { n: result.matchCount }) : '',
                    result.versionCount > 1 ? t('source.detail.versions', { n: result.versionCount }) : '',
                  ].filter(Boolean).join(t('common.separator'))) : null,
                  !material && asString(result.type) === 'excerpt' && Array.isArray(result.tags) && result.tags.length
                    ? h('span', { className: 'kb-list-meta' }, result.tags.map(asString).filter(Boolean).join(' · ')) : null,
                ),
              )
              if (!material) return row
              return h('div', { className: 'kb-search-material', key: key }, row,
                path ? h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.openPage(path) } }, t('search.match')) : null,
              )
            }),
          ),
          total > 0 && (total > results.length || ctx.searchNextOffset != null) ? h('div', { className: 'kb-search-tail' },
            h('span', { className: 'kb-list-meta', role: 'status' }, t('search.shown', { shown: results.length, total: total })),
            ctx.searchNextOffset != null ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', disabled: loading, onClick: ctx.loadMoreSearch }, t('search.more')) : null,
          ) : null,
        )
      }

      // ======================================================================
      // 未初始化引导
      // ======================================================================

      /**
       * 未初始化时的引导卡片（POST /init）。
       * @returns {any}
       */
      function InitGuide() {
        const ctx = useKb()
        const t = ctx.t
        return h(
          'div',
          { className: 'kb-init' },
          h(
            'div',
            { className: 'kb-init-card' },
            h('span', { className: 'kb-init-icon' }, h(BrandGlyph, { size: 30 })),
            h('h2', { className: 'kb-init-title' }, t('init.title')),
            h('p', { className: 'kb-init-desc' }, t('init.desc')),
            h('p', { className: 'kb-init-path' }, t('init.rootTip', { path: ctx.rootDir || DEFAULT_ROOT_LABEL })),
            ctx.initError ? h('div', { className: 'kb-inline-error' }, t('init.failed', { message: asString(ctx.initError) })) : null,
            h(
              'button',
              { type: 'button', className: 'kb-btn kb-btn-primary', onClick: ctx.initialize, disabled: ctx.initBusy },
              ctx.initBusy ? h(Spinner, { size: 'sm' }) : h(SparkIcon, { size: 14 }),
              h('span', null, ctx.initBusy ? t('init.busy') : t('init.button')),
            ),
          ),
        )
      }

      // ======================================================================
      // tab = 知识库（搜索 / 页面 / 总览）
      // ======================================================================

      /** 「知识库」和「AI 对话」共用的阅读状态。 */
      function PageView() {
        const ctx = useKb()
        const t = ctx.t
        const pageState = ctx.page
        if (pageState.status === 'loading') {
          return h(LoadingBlock, { t: t, text: t('page.reading') })
        }
        if (pageState.status === 'error') {
          return h(
            'div',
            { className: 'kb-loading kb-loading-col' },
            h('span', { className: 'kb-error-dot' }),
            h('span', { className: 'kb-error-inline-text' }, t('page.failed', { message: asString(pageState.error) || t('error.requestFailed') })),
            h(
              'span',
              { className: 'kb-form-actions' },
              h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { ctx.openPage(pageState.path) } }, t('common.retry')),
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.returnFromPage }, ctx.pageBackLabel),
            ),
          )
        }
        return pageState.data ? h(PageReader) : null
      }

      /** 「知识库」tab 主区：初始化引导、搜索、页面阅读与总览。 */
      function LibraryTab() {
        const ctx = useKb()
        const t = ctx.t
        const metaState = ctx.meta || {}
        if (metaState.status === 'error') {
          return h('div', { className: 'kb-library' }, h(ErrorBlock, { t: t, text: t('error.loadFailedWith', { message: asString(metaState.error) || t('error.requestFailed') }), onRetry: ctx.loadMeta }))
        }
        if (metaState.status === 'loading') {
          return h('div', { className: 'kb-library' }, h(LoadingBlock, { t: t }))
        }
        if (ctx.searchResults !== null) return h('div', { className: 'kb-library' }, h(SearchResults))
        if (!ctx.initialized) return h('div', { className: 'kb-library' }, h(InitGuide))
        return h('div', { className: 'kb-library' }, ctx.page.status === 'idle' ? h(Overview) : h(PageView))
      }

      // ======================================================================
      // 自写力导向布局（确定性种子随机 + 斥力 / 边弹簧 / 向心引力，迭代后静止）
      // ======================================================================

      /**
       * 计算图谱节点位置（纯函数，无副作用；相同入参得到相同布局）。
       * @param {any[]} nodes 节点数组（含 degree / type）。
       * @param {any[]} edges 边数组（source / target 为节点 id）。
       * @param {number} width 画布宽。
       * @param {number} height 画布高。
       * @param {number} seedOffset 种子偏移（「重新布局」时改变）。
       * @param {number} iterations 迭代次数。
       * @returns {Record<string, { x: number, y: number, r: number }>}
       */
      function computeGraphLayout(nodes, edges, width, height, seedOffset, iterations) {
        const list = Array.isArray(nodes) ? nodes : []
        const count = list.length
        const result = {}
        if (count === 0) return result
        const safeWidth = Math.max(240, Number(width) || 640)
        const safeHeight = Math.max(180, Number(height) || 400)
        const pad = 30
        const centerX = safeWidth / 2
        const centerY = safeHeight / 2
        const rounds = Math.max(20, Math.min(200, typeof iterations === 'number' ? iterations : 120))

        // ---- 确定性伪随机（LCG），同一数据每次布局稳定 ----
        let seed = 0x9e3779b9 + (typeof seedOffset === 'number' ? seedOffset : 0) * 2654435761
        seed = seed >>> 0
        function random() {
          seed = (seed * 1664525 + 1013904223) >>> 0
          return seed / 4294967296
        }

        const positions = new Array(count)
        const velocities = new Array(count)
        const degrees = new Array(count)
        const keys = new Array(count)
        const indexById = {}
        for (let index = 0; index < count; index += 1) {
          const node = list[index] || {}
          const key = asString(node.id) || asString(node.path) || 'node-' + index
          keys[index] = key
          indexById[key] = index
          degrees[index] = typeof node.degree === 'number' && node.degree > 0 ? node.degree : 0
          const radius = 4 + Math.min(8, Math.sqrt(degrees[index]) * 1.9)
          result[key] = { x: 0, y: 0, r: radius }
          positions[index] = {
            x: pad + random() * (safeWidth - pad * 2),
            y: pad + random() * (safeHeight - pad * 2),
          }
          velocities[index] = { x: 0, y: 0 }
        }

        const pairs = []
        const edgeList = Array.isArray(edges) ? edges : []
        for (let index = 0; index < edgeList.length; index += 1) {
          const edge = edgeList[index]
          if (!edge || typeof edge !== 'object') continue
          const sourceIndex = indexById[asString(edge.source)]
          const targetIndex = indexById[asString(edge.target)]
          if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) continue
          pairs.push({ a: sourceIndex, b: targetIndex })
          degrees[sourceIndex] += 1
          degrees[targetIndex] += 1
        }
        for (let index = 0; index < count; index += 1) {
          result[keys[index]].r = 4 + Math.min(8, Math.sqrt(degrees[index]) * 1.9)
        }

        const area = (safeWidth - pad * 2) * (safeHeight - pad * 2)
        const idealDistance = clampNumber(Math.sqrt(area / Math.max(count, 1)) * 0.95, 26, 220)
        const repulsionStrength = idealDistance * idealDistance

        for (let round = 0; round < rounds; round += 1) {
          const cooling = 1 - round / rounds
          const maxStep = 2 + 38 * cooling * cooling

          for (let index = 0; index < count; index += 1) {
            velocities[index].x = 0
            velocities[index].y = 0
          }

          // 节点间斥力
          for (let a = 0; a < count; a += 1) {
            const positionA = positions[a]
            for (let b = a + 1; b < count; b += 1) {
              const positionB = positions[b]
              let dx = positionA.x - positionB.x
              let dy = positionA.y - positionB.y
              let distance = Math.sqrt(dx * dx + dy * dy)
              if (distance < 0.6) {
                dx = 0.6 + random() * 0.8
                dy = 0.6 + random() * 0.8
                distance = Math.sqrt(dx * dx + dy * dy)
              }
              const force = repulsionStrength / (distance * distance)
              const fx = (dx / distance) * force
              const fy = (dy / distance) * force
              velocities[a].x += fx
              velocities[a].y += fy
              velocities[b].x -= fx
              velocities[b].y -= fy
            }
          }

          // 边弹簧
          for (let index = 0; index < pairs.length; index += 1) {
            const pair = pairs[index]
            const positionA = positions[pair.a]
            const positionB = positions[pair.b]
            const dx = positionB.x - positionA.x
            const dy = positionB.y - positionA.y
            const distance = Math.sqrt(dx * dx + dy * dy) || 0.001
            const desired = idealDistance * 0.92
            const force = (distance - desired) * 0.045
            const fx = (dx / distance) * force
            const fy = (dy / distance) * force
            velocities[pair.a].x += fx
            velocities[pair.a].y += fy
            velocities[pair.b].x -= fx
            velocities[pair.b].y -= fy
          }

          // 向心引力 + 位置更新（单步位移上限，随迭代衰减）
          for (let index = 0; index < count; index += 1) {
            const position = positions[index]
            velocities[index].x += (centerX - position.x) * 0.012
            velocities[index].y += (centerY - position.y) * 0.012
            velocities[index].x *= 0.82
            velocities[index].y *= 0.82
            let stepX = velocities[index].x
            let stepY = velocities[index].y
            const stepLength = Math.sqrt(stepX * stepX + stepY * stepY)
            if (stepLength > maxStep) {
              stepX = (stepX / stepLength) * maxStep
              stepY = (stepY / stepLength) * maxStep
            }
            position.x = clampNumber(position.x + stepX, pad, safeWidth - pad)
            position.y = clampNumber(position.y + stepY, pad, safeHeight - pad)
          }
        }

        for (let index = 0; index < count; index += 1) {
          const key = keys[index]
          result[key] = { x: positions[index].x, y: positions[index].y, r: result[key] ? result[key].r : 4 }
        }
        return result
      }

      // ======================================================================
      // tab = 图谱（v0.6.0：可缩放 / 可平移 / 可筛选 / 可聚焦的交互式知识图谱）
      // ======================================================================

      /** Separate node + two-line title envelopes before screen-space label placement. */
      function relaxGraphLayout(positions, nodes) {
        const entries = nodes.map(function (node) {
          const key = asString(node.key) || asString(node.id) || asString(node.path)
          const point = positions[key]
          if (!point) return null
          const textWidth = Array.from(asString(node.title)).reduce(function (width, char) { return width + (char.charCodeAt(0) < 128 ? 7 : 12) }, 0)
          return { key: key, point: point, width: clampNumber(textWidth / 2 + 20, 74, 150), height: 70 }
        }).filter(Boolean)
        for (let round = 0; round < 48; round += 1) {
          for (let a = 0; a < entries.length; a += 1) {
            for (let b = a + 1; b < entries.length; b += 1) {
              const first = entries[a], second = entries[b]
              const dx = second.point.x - first.point.x, dy = second.point.y - first.point.y
              const overlapX = (first.width + second.width) / 2 + 10 - Math.abs(dx)
              const overlapY = (first.height + second.height) / 2 + 8 - Math.abs(dy)
              if (overlapX <= 0 || overlapY <= 0) continue
              if (overlapX < overlapY) {
                const push = (overlapX + 0.5) / 2 * (dx < 0 ? -1 : 1)
                first.point.x -= push; second.point.x += push
              } else {
                const push = (overlapY + 0.5) / 2 * (dy < 0 ? -1 : 1)
                first.point.y -= push; second.point.y += push
              }
            }
          }
        }
        return positions
      }

      /**
       * 计算「适应画布」的平移缩放：让所有节点落入视口（带内边距）。
       * @param {any} positions 布局表 {key:{x,y,r}}。
       * @param {number} width 视口宽。
       * @param {number} height 视口高。
       * @param {number} [padding] 内边距。
       * @returns {{k:number, tx:number, ty:number}}
       */
      function fitGraphTransform(positions, width, height, padding) {
        const keys = positions && typeof positions === 'object' ? Object.keys(positions) : []
        if (keys.length === 0) return { k: 1, tx: 0, ty: 0 }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let index = 0; index < keys.length; index += 1) {
          const position = positions[keys[index]]
          if (!position) continue
          const radius = typeof position.r === 'number' ? position.r : 4
          minX = Math.min(minX, position.x - radius)
          maxX = Math.max(maxX, position.x + radius)
          minY = Math.min(minY, position.y - radius)
          maxY = Math.max(maxY, position.y + radius)
        }
        if (!isFinite(minX) || !isFinite(minY)) return { k: 1, tx: 0, ty: 0 }
        const pad = typeof padding === 'number' && padding > 0 ? padding : 64
        const boxW = Math.max(120, maxX - minX)
        const boxH = Math.max(120, maxY - minY)
        const k = clampNumber(Math.min((width - pad * 2) / boxW, (height - pad * 2) / boxH), 0.35, 1.6)
        const centerX = (minX + maxX) / 2
        const centerY = (minY + maxY) / 2
        return { k: k, tx: width / 2 - centerX * k, ty: height / 2 - centerY * k }
      }

      /** 图谱节点标题截断（按字符，不破坏中文）。 */
      function truncateGraphTitle(title, maxLength) {
        const text = asString(title)
        const limit = typeof maxLength === 'number' && maxLength > 4 ? maxLength : 14
        const chars = Array.from(text)
        return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
      }

      /**
       * 知识图谱视图：力导向布局 + 平移/缩放 + 类型/关系筛选 + 搜索 + 选中详情与邻居聚焦。
       * 支持键盘：+ / - 缩放、0 适应画布、Esc 清除选择；节点可 Tab 聚焦、Enter 打开页面。
       * @returns {any}
       */
      const ENTITY_CATEGORIES = ['company', 'technology', 'task', 'product', 'person', 'organization', 'concept', 'metric', 'document', 'other']

      // Build a stable, cycle-safe outline from explicit topic parents, never title similarity.
      function buildTopicHierarchy(nodes) {
        const byId = Object.create(null)
        const parentById = Object.create(null)
        const children = Object.create(null)
        nodes.filter(function (node) { return node.type === 'topic' }).forEach(function (node) {
          const key = asString(node.key) || asString(node.path) || asString(node.id)
          if (key) byId[key] = Object.assign({}, node, { key: key })
        })
        Object.keys(byId).forEach(function (key) {
          const parent = asString(byId[key].topicParent)
          parentById[key] = parent && byId[parent] && parent !== key ? parent : ''
        })
        Object.keys(byId).forEach(function (key) {
          const seen = new Set([key])
          let ancestor = parentById[key]
          while (ancestor) {
            if (seen.has(ancestor)) { parentById[key] = ''; break }
            seen.add(ancestor)
            ancestor = parentById[ancestor]
          }
        })
        Object.keys(byId).forEach(function (key) {
          const parent = parentById[key] || ''
          if (!children[parent]) children[parent] = []
          children[parent].push(byId[key])
        })
        Object.keys(children).forEach(function (key) {
          children[key].sort(function (a, b) { return a.title.localeCompare(b.title) })
        })
        function ancestors(key) {
          const result = []
          const seen = new Set([key])
          let parent = parentById[key]
          while (parent && !seen.has(parent)) {
            seen.add(parent)
            result.unshift(byId[parent])
            parent = parentById[parent]
          }
          return result
        }
        function descendants(key) {
          const result = []
          const pending = (children[key] || []).slice()
          const seen = new Set()
          while (pending.length) {
            const node = pending.shift()
            if (seen.has(node.key)) continue
            seen.add(node.key)
            result.push(node)
            pending.push.apply(pending, children[node.key] || [])
          }
          return result
        }
        return { byId: byId, parentById: parentById, children: children, roots: children[''] || [], ancestors: ancestors, descendants: descendants }
      }

      function TopicOutline(props) {
        const t = props.t
        const outlineRef = useRef(null)
        const forest = useMemo(function () { return buildTopicHierarchy(props.nodes || []) }, [props.nodes])
        const [collapsed, setCollapsed] = useState(cache.topicCollapsed || {})
        const [limit, setLimit] = useState(120)
        const query = asString(props.query).trim().toLowerCase()
        const matched = new Set()
        Object.keys(forest.byId).forEach(function (key) {
          const node = forest.byId[key]
          if (!query || [node.title].concat(node.aliases || [], node.tags || []).join(' ').toLowerCase().indexOf(query) >= 0) {
            matched.add(key)
            forest.ancestors(key).forEach(function (parent) { matched.add(parent.key) })
          }
        })
        useEffect(function () {
          const ancestors = forest.ancestors(props.selectedKey)
          if (!ancestors.length) return
          setCollapsed(function (previous) {
            const next = Object.assign({}, previous)
            ancestors.forEach(function (node) { next[node.key] = false })
            cache.topicCollapsed = next
            return next
          })
        }, [props.selectedKey, forest])
        useEffect(function () { setLimit(120) }, [query])
        useEffect(function () {
          const element = outlineRef.current
          const selected = element && element.querySelector('.kb-topic-select[aria-current="page"]')
          if (selected && typeof selected.scrollIntoView === 'function') selected.scrollIntoView({ block: 'nearest' })
        }, [props.selectedKey, query, collapsed])
        let rendered = 0
        function branch(node) {
          if (!matched.has(node.key) || rendered >= limit) return null
          rendered += 1
          const kids = forest.children[node.key] || []
          const expanded = kids.length > 0 && (query || collapsed[node.key] === false || (collapsed[node.key] !== true && !forest.parentById[node.key]))
          return h('li', { key: node.key, className: 'kb-topic-item' },
            h('div', { className: 'kb-topic-row', 'data-selected': props.selectedKey === node.key },
              kids.length ? h('button', {
                type: 'button', className: 'kb-topic-disclosure', 'aria-expanded': Boolean(expanded), disabled: Boolean(query),
                'aria-label': t(expanded ? 'taxonomy.collapse' : 'taxonomy.expand', { title: node.title }),
                onClick: function () {
                  const next = Object.assign({}, collapsed, { [node.key]: expanded })
                  cache.topicCollapsed = next
                  setCollapsed(next)
                },
              }, h(ChevronIcon, { size: 12, expanded: expanded })) : h('span', { className: 'kb-topic-spacer', 'aria-hidden': 'true' }),
              h('button', { type: 'button', className: 'kb-topic-select', 'aria-current': props.selectedKey === node.key ? 'page' : undefined, onClick: function () { props.onSelect(node.key) } },
                h('span', null, node.title), kids.length ? h('span', { className: 'kb-topic-count' }, String(kids.length)) : null,
              ),
            ),
            expanded ? h('ul', { className: 'kb-topic-children' }, kids.map(branch)) : null,
          )
        }
        return h('div', { className: 'kb-topic-outline', ref: outlineRef },
          h('ul', { className: 'kb-topic-roots' }, forest.roots.map(branch)),
          matched.size === 0 ? h('p', { className: 'kb-graph-copy' }, t('graph.catalogEmpty')) : null,
          rendered >= limit && matched.size > rendered ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setLimit(limit + 120) } }, t('graph.more', { n: Math.min(120, matched.size - rendered) })) : null,
        )
      }

      function EntityCatalogue(props) {
        const t = props.t
        const nodes = (props.nodes || []).filter(function (node) { return node.type === 'entity' && !node.materialDocument })
        const [category, setCategory] = useState(cache.entityCategoryFilter || 'all')
        const [limit, setLimit] = useState(60)
        const query = asString(props.query).toLowerCase().trim()
        useEffect(function () { setLimit(60) }, [category, query])
        const filtered = nodes.filter(function (node) {
          const assigned = node.entityCategoryAssigned !== false && ENTITY_CATEGORIES.indexOf(node.entityCategory) >= 0
          return (category === 'all' || (category === 'unassigned' ? !assigned : assigned && node.entityCategory === category))
            && (!query || [node.title].concat(node.aliases || [], node.tags || []).join(' ').toLowerCase().indexOf(query) >= 0)
        }).sort(function (a, b) { return a.title.localeCompare(b.title) })
        const categories = ['all'].concat(ENTITY_CATEGORIES, ['unassigned'])
        return h('div', { className: 'kb-entity-catalog' },
          props.compact ? h('select', { className: 'kb-select kb-entity-select', value: category, 'aria-label': t('taxonomy.entityCategory'), onChange: function (event) { cache.entityCategoryFilter = event.target.value; setCategory(event.target.value) } }, categories.map(function (id) { return h('option', { key: id, value: id }, t('taxonomy.category.' + id)) })) : h('div', { className: 'kb-entity-categories', role: 'group', 'aria-label': t('taxonomy.entityCategory') }, categories.map(function (id) {
            const count = nodes.filter(function (node) {
              const assigned = node.entityCategoryAssigned !== false && ENTITY_CATEGORIES.indexOf(node.entityCategory) >= 0
              return id === 'all' || (id === 'unassigned' ? !assigned : assigned && node.entityCategory === id)
            }).length
            return h('button', { key: id, type: 'button', className: 'kb-graph-chip', 'data-active': category === id, 'aria-pressed': category === id,
              onClick: function () { cache.entityCategoryFilter = id; setCategory(id) },
            }, t('taxonomy.category.' + id), ' ', count)
          })),
          filtered.slice(0, limit).map(function (node) { return h('button', {
            key: node.key || node.path, type: 'button', className: 'kb-graph-catalog-row', 'aria-pressed': props.selectedKey === (node.key || node.path), onClick: function () { props.onSelect(node.key || node.path) },
          }, h('span', { className: 'kb-graph-catalog-title' }, node.title), h('span', { className: 'kb-graph-catalog-meta' }, t('taxonomy.category.' + (node.entityCategoryAssigned === false || !node.entityCategory ? 'unassigned' : node.entityCategory)))) }),
          filtered.length === 0 ? h('p', { className: 'kb-graph-copy' }, t('taxonomy.categoryEmpty')) : null,
          filtered.length > limit ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setLimit(limit + 60) } }, t('graph.more', { n: Math.min(60, filtered.length - limit) })) : null,
        )
      }

      // A small organization form avoids rewriting page bodies just to change their place.
      function TaxonomyDialog(props) {
        const ctx = useKb()
        const t = ctx.t
        const page = props.page || {}
        const creating = props.creating === true
        const topic = creating || page.type === 'topic'
        const forest = useMemo(function () { return buildTopicHierarchy(props.nodes || []) }, [props.nodes])
        const [title, setTitle] = useState('')
        const [parent, setParent] = useState(creating ? asString(props.parentPath) : asString(page.topicParent))
        const [category, setCategory] = useState(page.entityCategoryAssigned === false || !page.entityCategory ? '' : page.entityCategory)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [discard, setDiscard] = useState(false)
        const mounted = useRef(true)
        useEffect(function () { return function () { mounted.current = false } }, [])
        const excluded = new Set([page.key || page.path].concat(forest.descendants(page.key || page.path).map(function (node) { return node.key })))
        const initialCategory = page.entityCategoryAssigned === false || !page.entityCategory ? '' : page.entityCategory
        const dirty = creating ? Boolean(title.trim()) || parent !== asString(props.parentPath) : parent !== asString(page.topicParent) || category !== initialCategory
        function close() { if (busy) return; if (dirty) setDiscard(true); else props.onClose() }
        async function save(event) {
          if (event && event.preventDefault) event.preventDefault()
          if (busy) return
          if (creating && (!title.trim() || title.trim().length > 200)) { setError(t('edit.titleRequired')); return }
          if (!topic && ENTITY_CATEGORIES.indexOf(category) < 0) { setError(t('taxonomy.chooseCategory')); return }
          setBusy(true); setError('')
          try {
            const response = creating
              ? await api('/topics', { method: 'POST', body: { title: title.trim(), parentPath: parent } })
              : await api('/page', { method: 'PUT', body: Object.assign({ path: page.path || page.key }, topic ? { topicParent: parent } : { entityCategory: category }) })
            if (!mounted.current) return
            await ctx.refreshContent({ reopen: false })
            await ctx.loadGraph()
            if (!mounted.current) return
            props.onSaved(response.page || page)
          } catch (err) {
            if (mounted.current) { setBusy(false); setError(errorMessage(err, t('error.requestFailed'))) }
          }
        }
        const form = h('form', { id: 'kb-taxonomy-form', onSubmit: save, className: 'kb-taxonomy-form' },
          creating ? h('div', { className: 'kb-form-field' }, h('label', { className: 'kb-form-label', htmlFor: 'kb-topic-title' }, t('taxonomy.topicTitle')), h('input', { id: 'kb-topic-title', className: 'kb-input', value: title, maxLength: 200, autoFocus: true, disabled: busy, onChange: function (event) { setTitle(event.target.value) } })) : h('p', { className: 'kb-graph-copy' }, page.title),
          topic ? h('div', { className: 'kb-form-field' }, h('label', { className: 'kb-form-label', htmlFor: 'kb-topic-parent' }, t('taxonomy.parent')), h('select', { id: 'kb-topic-parent', className: 'kb-select', value: parent, disabled: busy, onChange: function (event) { setParent(event.target.value) } },
            h('option', { value: '' }, t('taxonomy.root')),
            Object.keys(forest.byId).map(function (key) { return forest.byId[key] }).filter(function (node) { return creating || !excluded.has(node.key) }).sort(function (a, b) { return a.title.localeCompare(b.title) }).map(function (node) {
              return h('option', { key: node.key, value: node.key }, forest.ancestors(node.key).concat([node]).map(function (entry) { return entry.title }).join(' / '))
            }),
          ), h('p', { className: 'kb-form-hint' }, t('taxonomy.parentHint'))) : h('div', { className: 'kb-form-field' }, h('label', { className: 'kb-form-label', htmlFor: 'kb-entity-category' }, t('taxonomy.entityCategory')), h('select', { id: 'kb-entity-category', className: 'kb-select', value: category, disabled: busy, onChange: function (event) { setCategory(event.target.value) } },
            h('option', { value: '', disabled: true }, t('taxonomy.chooseCategory')), ENTITY_CATEGORIES.map(function (id) { return h('option', { key: id, value: id }, t('taxonomy.category.' + id)) }),
          )),
          error ? h('p', { role: 'alert', className: 'kb-inline-error' }, error) : null,
        )
        if (discard) return h(ConfirmDialog, { t: t, title: t('edit.discardTitle'), description: t('edit.discardDesc'), confirmLabel: t('edit.discardAction'), onCancel: function () { setDiscard(false) }, onConfirm: props.onClose })
        return h(KbModal, { t: t, title: t(creating ? 'taxonomy.createTopic' : 'taxonomy.organize'), onClose: close, busy: busy, children: form, footer: [
          h('button', { key: 'cancel', type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', disabled: busy, onClick: close }, t('dialog.cancel')),
          h('button', { key: 'save', type: 'submit', form: 'kb-taxonomy-form', className: 'kb-btn kb-btn-primary kb-btn-sm', disabled: busy }, t(busy ? 'edit.saving' : 'edit.save')),
        ] })
      }

      // Groups are navigation sets, built only from explicit topic parents and existing links.
      // A linked page may belong to multiple groups; every page remains reachable.
      function buildGraphGroups(nodes, edges) {
        const forest = buildTopicHierarchy(nodes)
        const byId = Object.create(null)
        nodes.forEach(function (node) { byId[node.key] = node })
        const covered = new Set()
        const groups = forest.roots.map(function (root) {
          const topics = [root].concat(forest.descendants(root.key))
          const topicKeys = new Set(topics.map(function (node) { return node.key }))
          const keys = new Set(topicKeys)
          edges.forEach(function (edge) {
            if (topicKeys.has(edge.source) && byId[edge.target] && byId[edge.target].type !== 'topic') keys.add(edge.target)
            if (topicKeys.has(edge.target) && byId[edge.source] && byId[edge.source].type !== 'topic') keys.add(edge.source)
          })
          keys.forEach(function (key) { covered.add(key) })
          return { key: root.key, title: root.title, topics: topics, keys: keys,
            members: nodes.filter(function (node) { return keys.has(node.key) }),
            children: forest.children[root.key] || [] }
        })
        const remaining = nodes.filter(function (node) { return !covered.has(node.key) })
        if (remaining.length) groups.push({ key: '@ungrouped', title: '', topics: [], members: remaining,
          keys: new Set(remaining.map(function (node) { return node.key })), children: [] })
        return groups
      }

      // One visible stroke and one spring per pair, oriented by the explicit role when present.
      function mergeGraphEdges(edges) {
        const pairs = new Map()
        edges.forEach(function (edge) {
          const key = JSON.stringify([edge.source, edge.target].sort())
          const previous = pairs.get(key)
          if (previous) {
            if (previous.relations.indexOf(edge.relation) < 0) previous.relations.push(edge.relation)
            if (previous.relation === 'CEO') return
            if (edge.relation === 'CEO') {
              pairs.set(key, Object.assign({}, edge, { key: key, relations: previous.relations }))
            } else {
              previous.relation = previous.relations.length > 1 ? 'mixed' : previous.relations[0]
            }
          } else pairs.set(key, Object.assign({}, edge, { key: key, relations: [edge.relation] }))
        })
        return Array.from(pairs.values())
      }

      /**
       * Place graph labels in SCREEN coordinates, after applying the pan/zoom transform.
       * No DOM / font measurement / mutation. CSS must keep text at 12px and draw this
       * layer OUTSIDE the transformed node group so zoom never makes the labels tiny.
       *
       * Result[key]: { x, y, width, height, lines, textX, textY, fontSize, lineHeight,
       *               truncated, leader: null | { x1, y1, x2, y2 } }
       * x/y describe the top-left of a padded label box. Render lines with textX/textY
       * as the first baseline and lineHeight between baselines. Missing key = hidden.
       * All returned boxes fit the viewport and avoid every visible node + other box.
       * An impossible priority label is omitted, never forced over another label/node.
       */
      function placeGraphLabels(nodes, positions, transform, width, height, priorityKeys) {
        const result = Object.create(null)
        const safeWidth = Number(width) || 0
        const safeHeight = Number(height) || 0
        const fontSize = 12
        const lineHeight = 16
        const paddingX = 3
        const paddingY = 2
        const edgePadding = 8
        if (safeWidth < 64 || safeHeight < 40) return result
        const zoom = transform && Number.isFinite(transform.k) && transform.k > 0 ? transform.k : 1
        const tx = transform && Number.isFinite(transform.tx) ? transform.tx : 0
        const ty = transform && Number.isFinite(transform.ty) ? transform.ty : 0
        const priorities = Array.isArray(priorityKeys) ? priorityKeys : priorityKeys instanceof Set ? Array.from(priorityKeys) : Object.keys(priorityKeys || {}).filter(function (key) { return priorityKeys[key] })
        const priorityRank = Object.create(null)
        priorities.forEach(function (key, index) { if (priorityRank[key] === undefined) priorityRank[key] = index })

        // Conservative advances for the 12px system font; CJK, astral glyphs and broad
        // Latin letters receive extra room. A slight overestimate is intentional.
        function advance(char) {
          const code = char.codePointAt(0)
          if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0
          if (/\s/.test(char)) return 4.5
          if (/[ilI.,'`:;!|]/.test(char)) return 4.5
          if (/[MW@%&#]/.test(char)) return 11.5
          return code < 128 ? 8.5 : code > 0xffff ? 15 : 13
        }
        function lineWidth(value) {
          return Array.from(value).reduce(function (sum, char) { return sum + advance(char) }, 0)
        }
        const maxTextWidth = Math.min(144, safeWidth - edgePadding * 2 - paddingX * 2)
        function wrap(value) {
          const chars = Array.from(String(value || '').replace(/\s+/g, ' ').trim())
          const lines = []
          let cursor = 0
          while (cursor < chars.length && lines.length < 2) {
            let line = ''
            let used = 0
            while (cursor < chars.length) {
              const next = chars[cursor]
              const nextWidth = advance(next)
              if (line && used + nextWidth > maxTextWidth) break
              line += next
              used += nextWidth
              cursor += 1
            }
            lines.push(line.trim())
            while (cursor < chars.length && chars[cursor] === ' ') cursor += 1
          }
          if (!lines.length) lines.push('…')
          const truncated = cursor < chars.length
          if (truncated) {
            let last = Array.from(lines[lines.length - 1])
            while (last.length && lineWidth(last.join('') + '…') > maxTextWidth) last.pop()
            lines[lines.length - 1] = last.join('').trimEnd() + '…'
          }
          return { lines: lines, truncated: truncated, width: Math.ceil(Math.max.apply(null, lines.map(lineWidth))) + paddingX * 2, height: lines.length * lineHeight + paddingY * 2 }
        }

        const points = []
        const seen = new Set()
        ;(Array.isArray(nodes) ? nodes : []).forEach(function (node, index) {
          const key = String(node && (node.key || node.id || node.path) || 'node-' + index)
          const position = positions && positions[key]
          if (!position || seen.has(key) || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return
          seen.add(key)
          const point = { key: key, node: node, x: position.x * zoom + tx, y: position.y * zoom + ty, r: Math.max(3, (Number(position.r) || 4) * zoom), index: index }
          if (point.x + point.r < 0 || point.y + point.r < 0 || point.x - point.r > safeWidth || point.y - point.r > safeHeight) return
          points.push(point)
        })
        const ordered = points.slice().sort(function (a, b) {
          const aRank = priorityRank[a.key] === undefined ? Infinity : priorityRank[a.key]
          const bRank = priorityRank[b.key] === undefined ? Infinity : priorityRank[b.key]
          if (aRank !== bRank) return aRank - bRank
          const degree = (Number(b.node.degree) || 0) - (Number(a.node.degree) || 0)
          if (degree) return degree
          const topic = Number(b.node.type === 'topic') - Number(a.node.type === 'topic')
          return topic || a.index - b.index
        })
        const placed = []
        function isClear(box) {
          if (box.x < edgePadding || box.y < edgePadding || box.x + box.width > safeWidth - edgePadding || box.y + box.height > safeHeight - edgePadding) return false
          for (let index = 0; index < placed.length; index += 1) {
            const other = placed[index]
            if (box.x < other.x + other.width + 4 && box.x + box.width + 4 > other.x && box.y < other.y + other.height + 4 && box.y + box.height + 4 > other.y) return false
          }
          for (let index = 0; index < points.length; index += 1) {
            const point = points[index]
            const nearestX = Math.max(box.x, Math.min(point.x, box.x + box.width))
            const nearestY = Math.max(box.y, Math.min(point.y, box.y + box.height))
            const dx = nearestX - point.x
            const dy = nearestY - point.y
            if (dx * dx + dy * dy < (point.r + 4) * (point.r + 4)) return false
          }
          return true
        }
        ordered.forEach(function (point) {
          const text = wrap(point.node.title || point.key)
          const w = text.width
          const h = text.height
          const rings = priorityRank[point.key] === undefined ? [7, 20, 38] : [7, 20, 38, 64, 100, 144]
          let chosen = null
          for (let ring = 0; ring < rings.length && !chosen; ring += 1) {
            const gap = point.r + rings[ring]
            // Prefer below, then above, right and left; diagonal slots rescue labels
            // in dense local graphs without resorting to a whole-screen label cloud.
            const candidates = [
              [point.x - w / 2, point.y + gap],
              [point.x - w / 2, point.y - gap - h],
              [point.x + gap, point.y - h / 2],
              [point.x - gap - w, point.y - h / 2],
              [point.x + gap * 0.72, point.y + gap * 0.72],
              [point.x - gap * 0.72 - w, point.y + gap * 0.72],
              [point.x + gap * 0.72, point.y - gap * 0.72 - h],
              [point.x - gap * 0.72 - w, point.y - gap * 0.72 - h],
            ]
            for (let candidate = 0; candidate < candidates.length; candidate += 1) {
              const box = { x: Math.round(Math.max(edgePadding, Math.min(candidates[candidate][0], safeWidth - edgePadding - w))), y: Math.round(Math.max(edgePadding, Math.min(candidates[candidate][1], safeHeight - edgePadding - h))), width: w, height: h }
              if (isClear(box)) { chosen = box; break }
            }
          }
          if (!chosen) return
          const endX = Math.max(chosen.x, Math.min(point.x, chosen.x + w))
          const endY = Math.max(chosen.y, Math.min(point.y, chosen.y + h))
          const dx = endX - point.x
          const dy = endY - point.y
          const distance = Math.sqrt(dx * dx + dy * dy) || 1
          const leader = distance > point.r + 22 ? { x1: point.x + dx / distance * (point.r + 2), y1: point.y + dy / distance * (point.r + 2), x2: endX, y2: endY } : null
          const label = Object.assign(chosen, { lines: text.lines, textX: chosen.x + paddingX, textY: chosen.y + paddingY + fontSize, fontSize: fontSize, lineHeight: lineHeight, truncated: text.truncated, leader: leader })
          result[point.key] = label
          placed.push(chosen)
        })
        return result
      }

      function GraphView() {
        const ctx = useKb()
        const t = ctx.t
        const state = ctx.graph || {}
        const data = state.data && typeof state.data === 'object' ? state.data : null
        const stageRef = useRef(null)
        const wrapperRef = useRef(null)
        const [size, setSize] = useState({ width: 0, height: 0 })
        const [layoutNonce, setLayoutNonce] = useState(0)
        const [fitNonce, setFitNonce] = useState(0)
        const [transform, setTransform] = useState({ k: 1, tx: 0, ty: 0 })
        const [selectedKey, setSelectedKey] = useState(cache.graphExplore.selectedKey)
        const [hoverKey, setHoverKey] = useState('')
        const [hiddenTypes, setHiddenTypes] = useState({})
        const [hiddenRelations, setHiddenRelations] = useState({})
        const [searchQuery, setSearchQuery] = useState(cache.graphExplore.searchQuery)
        const [exploreMode, setExploreMode] = useState(cache.graphExplore.mode)
        const [viewMode, setViewMode] = useState(cache.graphExplore.view)
        const [mapScope, setMapScope] = useState(cache.graphExplore.scope || 'overview')
        const [groupKey, setGroupKey] = useState(cache.graphExplore.groupKey || '')
        const [mapLimit, setMapLimit] = useState(cache.graphExplore.mapLimit || 20)
        const [mapHistory, setMapHistory] = useState(cache.graphExplore.history || [])
        const [catalogLimit, setCatalogLimit] = useState(60)
        const [catalogOpen, setCatalogOpen] = useState(false)
        const catalogToggleRef = useRef(null)
        const [neighborLimit, setNeighborLimit] = useState(30)
        const [preview, setPreview] = useState({ key: '', status: 'idle', page: null, error: '' })
        const [previewNonce, setPreviewNonce] = useState(0)
        const [taxonomyDialog, setTaxonomyDialog] = useState(null)
        const [evidenceKey, setEvidenceKey] = useState('')
        const [evidence, setEvidence] = useState({ key: '', status: 'idle', page: null, error: '' })
        const [searchCursor, setSearchCursor] = useState(-1)
        const [focusNeighbors, setFocusNeighbors] = useState(false)
        const [dragging, setDragging] = useState(false)
        const dragRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false })
        const suppressClickRef = useRef(false)
        const transformRef = useRef(transform)

        useEffect(function () {
          cache.graphExplore = { selectedKey: selectedKey, searchQuery: searchQuery, mode: exploreMode, view: viewMode,
            scope: mapScope, groupKey: groupKey, mapLimit: mapLimit, history: mapHistory }
        }, [selectedKey, searchQuery, exploreMode, viewMode, mapScope, groupKey, mapLimit, mapHistory])

        // One page at a time; abort stale selection requests and preserve the browsing context.
        useEffect(function () {
          setEvidenceKey('')
          setNeighborLimit(30)
          if (!selectedKey) { setPreview({ key: '', status: 'idle', page: null, error: '' }); return undefined }
          const controller = new AbortController()
          setPreview({ key: selectedKey, status: 'loading', page: null, error: '' })
          api('/page?path=' + encodeURIComponent(selectedKey), { signal: controller.signal }).then(function (response) {
            if (!controller.signal.aborted) setPreview({ key: selectedKey, status: 'ready', page: response.page, error: '' })
          }).catch(function (error) {
            if (!controller.signal.aborted) setPreview({ key: selectedKey, status: 'error', page: null, error: errorMessage(error, t('error.requestFailed')) })
          })
          return function () { controller.abort() }
        }, [selectedKey, data, previewNonce])

        useEffect(function () {
          setCatalogLimit(60)
        }, [searchQuery, exploreMode])


        useEffect(function () {
          transformRef.current = transform
        }, [transform])

        // 容器尺寸测量（图谱画布区域）
        useEffect(function () {
          const element = stageRef.current
          if (!element) return undefined
          function measure() {
            if (!stageRef.current) return
            const width = stageRef.current.clientWidth || 0
            const height = stageRef.current.clientHeight || 0
            setSize(function (previous) {
              if (previous.width === width && previous.height === height) return previous
              return { width: width, height: height }
            })
          }
          measure()
          if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(measure)
            observer.observe(element)
            return function () {
              observer.disconnect()
            }
          }
          if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('resize', measure)
            return function () {
              window.removeEventListener('resize', measure)
            }
          }
          return undefined
        }, [data ? 'ready' : 'empty', viewMode, mapScope, Boolean(selectedKey)])

        // 数据预处理：节点/边/邻接/计数（一次 useMemo，筛选与交互都基于它）
        const prepared = useMemo(
          function () {
            const allNodes = data && Array.isArray(data.nodes) ? data.nodes : []
            const allEdges = data && Array.isArray(data.edges) ? data.edges : []
            const sorted = allNodes.slice().sort(function (first, second) {
              return (typeof second.degree === 'number' ? second.degree : 0) - (typeof first.degree === 'number' ? first.degree : 0)
            })
            const limited = sorted // Keep the entire catalogue searchable; only the SVG is capped.
            const byId = Object.create(null)
            const nodes = []
            for (let index = 0; index < limited.length; index += 1) {
              const node = limited[index] || {}
              const key = asString(node.id) || asString(node.path) || 'node-' + index
              if (!key || byId[key]) continue
              const entry = {
                key: key,
                id: asString(node.id) || key,
                path: asString(node.path),
                title: asString(node.title) || key,
                type: asString(node.type) || 'source',
                tags: Array.isArray(node.tags) ? node.tags.map(function (tag) { return asString(tag) }).filter(Boolean).slice(0, 8) : [],
                aliases: Array.isArray(node.aliases) ? node.aliases.filter(function (value) { return typeof value === 'string' }) : [],
                sources: Array.isArray(node.sources) ? Array.from(new Set(node.sources.filter(Boolean))) : [],
                sourceCount: Number.isFinite(node.sourceCount) && node.sourceCount >= 0 ? node.sourceCount : null,
                topicParent: asString(node.topicParent),
                entityCategory: asString(node.entityCategory),
                entityCategoryAssigned: typeof node.entityCategoryAssigned === 'boolean' ? node.entityCategoryAssigned : Boolean(node.entityCategory),
                materialDocument: node.materialDocument === true,
                updatedAt: asString(node.updatedAt),
                confidence: asString(node.confidence),
                degree: typeof node.degree === 'number' ? node.degree : 0,
              }
              byId[key] = entry
              nodes.push(entry)
            }
            const sourceIdentities = Object.create(null)
            allEdges.forEach(function (edge) { if (edge && edge.relation === 'derived' && edge.sourceId) sourceIdentities[edge.source] = edge.sourceId })
            const edges = []
            const adjacency = Object.create(null)
            /**
             * 记录邻居，保留同一对节点间各类关系的方向与证据。
             * @param {string} fromKey 起点。
             * @param {string} toKey 邻居。
             * @param {string} relation 关系。
             * @param {string} direction 方向。
             * @param {Array} ceoSources 职务关系的来源。
             * @returns {void}
             */
            function addNeighbor(fromKey, toKey, relation, direction, ceoSources) {
              if (!adjacency[fromKey]) adjacency[fromKey] = []
              const list = adjacency[fromKey]
              for (let index = 0; index < list.length; index += 1) {
                if (list[index].key !== toKey) continue
                if (list[index].relation !== relation) list[index].relation = 'both'
                list[index][relation + (direction === 'out' ? 'Out' : 'In')] = true
                if (relation === 'CEO') list[index].ceoSources = ceoSources
                return
              }
              const neighbor = { key: toKey, relation: relation, direction: direction }
              neighbor[relation + (direction === 'out' ? 'Out' : 'In')] = true
              if (relation === 'CEO') neighbor.ceoSources = ceoSources
              list.push(neighbor)
            }
            for (let index = 0; index < allEdges.length; index += 1) {
              const edge = allEdges[index] || {}
              const sourceKey = asString(edge.source)
              const targetKey = asString(edge.target)
              if (!byId[sourceKey] || !byId[targetKey] || sourceKey === targetKey) continue
              const relation = asString(edge.relation) || 'link'
              edges.push({ key: 'edge-' + index, source: sourceKey, target: targetKey, relation: relation })
              const ceoSources = relation === 'CEO' && Array.isArray(edge.sourceRefs)
                ? edge.sourceRefs.filter(function (ref) { return ref && asString(ref.id) && ref.status !== 'missing' })
                : []
              addNeighbor(sourceKey, targetKey, relation, 'out', ceoSources)
              addNeighbor(targetKey, sourceKey, relation, 'in', ceoSources)
              // Older hosts have no node.sources: recover provenance from explicit derived edges.
              if (relation === 'derived') {
                const sourceId = byId[sourceKey].sources[0] || asString(sourceIdentities[sourceKey]) || sourceKey
                if (byId[targetKey].sources.indexOf(sourceId) < 0) byId[targetKey].sources.push(sourceId)
              }
            }
            const typeCounts = { source: 0, entity: 0, topic: 0, synthesis: 0 }
            const isolated = []
            for (let index = 0; index < nodes.length; index += 1) {
              const node = nodes[index]
              if (node.sourceCount === null) node.sourceCount = node.sources.length
              typeCounts[node.type] = (typeCounts[node.type] || 0) + 1
              if (!adjacency[node.key] || adjacency[node.key].length === 0) isolated.push(node.key)
            }
            const relationCounts = { link: 0, derived: 0 }
            for (let index = 0; index < edges.length; index += 1) {
              relationCounts[edges[index].relation] = (relationCounts[edges[index].relation] || 0) + 1
            }
            return {
              nodes: nodes,
              edges: edges,
              byId: byId,
              adjacency: adjacency,
              typeCounts: typeCounts,
              relationCounts: relationCounts,
              isolated: isolated,
              totalNodes: allNodes.length,
              totalEdges: allEdges.length,
              truncated: allNodes.length > MAX_GRAPH_NODES,
            }
          },
          [data],
        )

        const topicForest = useMemo(function () { return buildTopicHierarchy(prepared.nodes) }, [prepared])

        const topicGroups = useMemo(function () { return buildGraphGroups(prepared.nodes, prepared.edges) }, [prepared])
        const activeGroup = topicGroups.find(function (group) { return group.key === groupKey })
        const mapCandidates = useMemo(function () {
          let candidates = []
          const childKeys = new Set(activeGroup ? activeGroup.children.map(function (node) { return node.key }) : [])
          const ceoNeighbors = new Set()
          if (mapScope === 'local' && prepared.byId[selectedKey]) {
            const related = new Set([selectedKey])
            prepared.edges.forEach(function (edge) {
              if (hiddenRelations[edge.relation]) return
              const neighbor = edge.source === selectedKey ? edge.target : edge.target === selectedKey ? edge.source : ''
              if (!neighbor) return
              related.add(neighbor)
              if (edge.relation === 'CEO') ceoNeighbors.add(neighbor)
            })
            candidates = prepared.nodes.filter(function (node) { return related.has(node.key) })
          } else if (mapScope === 'group') candidates = activeGroup ? activeGroup.members : []
          else if (mapScope === 'all') candidates = prepared.nodes.slice()
          return candidates.filter(function (node) { return node.key === selectedKey || !hiddenTypes[node.type] }).sort(function (a, b) {
            if (a.key === selectedKey) return -1
            if (b.key === selectedKey) return 1
            const byCeo = Number(ceoNeighbors.has(b.key)) - Number(ceoNeighbors.has(a.key))
            if (byCeo) return byCeo
            if (a.key === groupKey) return -1
            if (b.key === groupKey) return 1
            if (mapScope === 'group' && childKeys.has(a.key) !== childKeys.has(b.key)) return childKeys.has(a.key) ? -1 : 1
            return b.degree - a.degree || a.title.localeCompare(b.title)
          })
        }, [prepared, topicGroups, mapScope, groupKey, selectedKey, hiddenTypes, hiddenRelations])
        const mapNodes = useMemo(function () {
          return mapCandidates.slice(0, mapScope === 'all' ? MAX_GRAPH_NODES : Math.min(mapLimit, MAX_GRAPH_NODES))
        }, [mapCandidates, mapScope, mapLimit])
        const mapKeys = new Set(mapNodes.map(function (node) { return node.key }))
        const mapEdges = useMemo(function () {
          const keys = new Set(mapNodes.map(function (node) { return node.key }))
          return mergeGraphEdges(prepared.edges.filter(function (edge) {
            if (hiddenRelations[edge.relation] || !keys.has(edge.source) || !keys.has(edge.target)) return false
            return mapScope !== 'local' || edge.source === selectedKey || edge.target === selectedKey
          }))
        }, [prepared, mapNodes, mapScope, selectedKey, hiddenRelations])

        // Reflow the displayed subgraph, never a hidden full graph.
        const layout = useMemo(function () {
          if (viewMode !== 'map' || mapNodes.length === 0) return {}
          const positions = computeGraphLayout(mapNodes, mapEdges,
            Math.max(480, size.width || 900), Math.max(360, size.height || 560), layoutNonce + 7, 120)
          relaxGraphLayout(positions, mapNodes)
          return positions
        }, [mapNodes, mapEdges, viewMode, size.width, size.height, layoutNonce])

        // 首次 / 重新布局 / 画布尺寸变化后自动适应画布
        useEffect(
          function () {
            if (!size.width || !size.height) return
            if (Object.keys(layout).length === 0) return
            setTransform(fitGraphTransform(layout, size.width, size.height, 56))
          },
          [layout, size.width, size.height, fitNonce],
        )

        // 滚轮缩放（非 passive，阻止页面滚动）：以指针位置为缩放中心
        useEffect(function () {
          const element = wrapperRef.current
          if (!element || !element.addEventListener) return undefined
          function handleWheel(event) {
            if (!event) return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            const rect = element.getBoundingClientRect()
            const pointerX = event.clientX - rect.left
            const pointerY = event.clientY - rect.top
            const factor = Math.exp(-event.deltaY * 0.0015)
            setTransform(function (previous) {
              const nextK = clampNumber(previous.k * factor, 0.35, 3)
              const worldX = (pointerX - previous.tx) / previous.k
              const worldY = (pointerY - previous.ty) / previous.k
              return { k: nextK, tx: pointerX - worldX * nextK, ty: pointerY - worldY * nextK }
            })
          }
          element.addEventListener('wheel', handleWheel, { passive: false })
          return function () {
            element.removeEventListener('wheel', handleWheel)
          }
        }, [viewMode, Boolean(data), mapScope])

        // Search the full catalogue, including aliases and tags.
        const normalizedQuery = searchQuery.trim().toLowerCase()
        const matches = useMemo(
          function () {
            if (!normalizedQuery) return []
            const result = []
            for (let index = 0; index < prepared.nodes.length; index += 1) {
              const node = prepared.nodes[index]
              if ([node.title].concat(node.aliases, node.tags).join(' ').toLowerCase().indexOf(normalizedQuery) >= 0) result.push(node.key)
            }
            result.sort(function (first, second) {
              const degreeA = prepared.byId[first] ? prepared.byId[first].degree : 0
              const degreeB = prepared.byId[second] ? prepared.byId[second].degree : 0
              return degreeB - degreeA
            })
            return result
          },
          [prepared, normalizedQuery],
        )
        useEffect(
          function () {
            setSearchCursor(-1)
          },
          [normalizedQuery, matches.length],
        )

        // 选中 / 悬停态：焦点节点 + 邻居集合
        const focusKey = selectedKey || hoverKey
        const focusNode = focusKey ? prepared.byId[focusKey] || null : null
        let focusNeighborSet = null
        if (focusKey) {
          const links = prepared.adjacency[focusKey] || []
          focusNeighborSet = {}
          for (let index = 0; index < links.length; index += 1) focusNeighborSet[links[index].key] = true
        }
        const selectedNode = selectedKey ? prepared.byId[selectedKey] || null : null
        const selectedNeighbors = selectedKey
          ? (prepared.adjacency[selectedKey] || []).slice().sort(function (a, b) {
              return Number(Boolean(b.CEOIn || b.CEOOut)) - Number(Boolean(a.CEOIn || a.CEOOut))
            })
          : []
        const previewPage = preview.key === selectedKey && preview.status === 'ready' ? preview.page : null
        const sourceRefs = previewPage && Array.isArray(previewPage.sourceRefs) ? previewPage.sourceRefs.filter(function (ref) { return ref && ref.status !== 'missing' }) : []

        // Incoming reference context is fetched only when requested, never N+1 for the whole graph.
        const evidenceNeighbor = evidenceKey ? selectedNeighbors.find(function (neighbor) { return neighbor.key === evidenceKey }) : null
        const evidenceFromKey = evidenceNeighbor && evidenceNeighbor.linkIn && !evidenceNeighbor.linkOut ? evidenceKey : selectedKey
        useEffect(function () {
          if (!evidenceKey || evidenceFromKey === selectedKey) return undefined
          const controller = new AbortController()
          setEvidence({ key: evidenceFromKey, status: 'loading', page: null, error: '' })
          api('/page?path=' + encodeURIComponent(evidenceFromKey), { signal: controller.signal }).then(function (response) {
            if (!controller.signal.aborted) setEvidence({ key: evidenceFromKey, status: 'ready', page: response.page, error: '' })
          }).catch(function (error) {
            if (!controller.signal.aborted) setEvidence({ key: evidenceFromKey, status: 'error', page: null, error: errorMessage(error, t('error.requestFailed')) })
          })
          return function () { controller.abort() }
        }, [evidenceKey, evidenceFromKey, selectedKey, data])

        function referenceContext(page, targetKey) {
          if (!page || !Array.isArray(page.links)) return ''
          const titles = page.links.filter(function (link) { return link.path === targetKey }).map(function (link) { return link.title.toLowerCase() })
          const lines = stripHtmlComments(asString(page.markdown)).replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').split('\n')
          const line = lines.find(function (value) {
            const refs = value.match(/\[\[([^\]]+)\]\]/g) || []
            return refs.some(function (ref) { return titles.indexOf(ref.slice(2, -2).split('|')[0].trim().toLowerCase()) >= 0 })
          })
          if (!line) return ''
          const refs = Array.from(line.matchAll(/\[\[([^\]]+)\]\]/g))
          const matched = refs.find(function (ref) { return titles.indexOf(ref[1].split('|')[0].trim().toLowerCase()) >= 0 })
          const start = Math.max(0, (matched ? matched.index : 0) - 60)
          const end = Math.min(line.length, (matched ? matched.index + matched[0].length : 0) + 120)
          return (start > 0 ? '…' : '') + cleanSearchSnippet(line.slice(start, end), 320) + (end < line.length ? '…' : '')
        }

        function neighborLabel(neighbor) {
          const labels = []
          if (neighbor.CEOOut || neighbor.CEOIn) {
            const otherTitle = prepared.byId[neighbor.key].title
            labels.push(t('graph.ceoDirection', neighbor.CEOOut
              ? { person: selectedNode.title, company: otherTitle }
              : { person: otherTitle, company: selectedNode.title }))
          }
          if (neighbor.linkOut && neighbor.linkIn) labels.push(t('graph.linkBoth'))
          else if (neighbor.linkOut) labels.push(t('graph.linkOut'))
          else if (neighbor.linkIn) labels.push(t('graph.linkIn'))
          if (neighbor.derivedIn) labels.push(t('graph.derivedIn'))
          if (neighbor.derivedOut) labels.push(t('graph.derivedOut'))
          if (neighbor.topicIn) labels.push(t('taxonomy.parentRelation'))
          if (neighbor.topicOut) labels.push(t('taxonomy.childRelation'))
          return labels.join(t('common.separator'))
        }

        const visibleNodes = mapNodes
        const filtersActive = Object.keys(hiddenTypes).length > 0 || Object.keys(hiddenRelations).length > 0
        const visibleEdges = mapEdges

        const matchSet = {}
        for (let index = 0; index < matches.length; index += 1) matchSet[matches[index]] = true

        useEffect(
          function () {
            if (selectedKey && !prepared.byId[selectedKey]) {
              setSelectedKey('')
              setFocusNeighbors(false)
              setMapScope('overview')
            }
          },
          [prepared, selectedKey],
        )

        function clampZoom(nextK) {
          return clampNumber(nextK, 0.35, 3)
        }

        function zoomStep(factor) {
          const centerX = (size.width || 900) / 2
          const centerY = (size.height || 560) / 2
          // 以画布中心为锚点缩放
          setTransform(function (previous) {
            const k = clampZoom(previous.k * factor)
            const worldX = (centerX - previous.tx) / previous.k
            const worldY = (centerY - previous.ty) / previous.k
            return { k: k, tx: centerX - worldX * k, ty: centerY - worldY * k }
          })
        }

        function fitView() {
          setFitNonce(fitNonce + 1)
          if (Object.keys(layout).length > 0 && size.width && size.height) {
            setTransform(fitGraphTransform(layout, size.width, size.height, 56))
          }
        }

        function centerOnNode(key) {
          const position = layout[key]
          if (!position) return
          const width = size.width || 900
          const height = size.height || 560
          setTransform(function (previous) {
            const k = clampZoom(Math.max(previous.k, 1.05))
            return { k: k, tx: width / 2 - position.x * k, ty: height / 2 - position.y * k }
          })
        }

        function rememberMap() {
          setMapHistory(function (previous) { return previous.concat({ scope: mapScope, groupKey: groupKey,
            selectedKey: selectedKey, limit: mapLimit }).slice(-30) })
        }
        function mapOverview() {
          setMapScope('overview'); setSelectedKey(''); setGroupKey(''); setFocusNeighbors(false)
          setMapHistory([]); setHiddenTypes({}); setHiddenRelations({}); setHoverKey('')
        }
        function openGroup(key) {
          rememberMap(); setGroupKey(key); setMapScope('group'); setSelectedKey(''); setMapLimit(20)
          setFocusNeighbors(false); setHiddenTypes({}); setHiddenRelations({}); setHoverKey('')
        }
        function backInMap() {
          const previous = mapHistory[mapHistory.length - 1]
          if (!previous) { mapOverview(); return }
          setMapHistory(mapHistory.slice(0, -1)); setMapScope(previous.scope); setGroupKey(previous.groupKey)
          setSelectedKey(previous.selectedKey); setMapLimit(previous.limit); setFocusNeighbors(previous.scope === 'local')
          setHoverKey('')
        }
        function selectNode(key) {
          if (!key) return
          if (catalogOpen) {
            setCatalogOpen(false)
            const toggle = catalogToggleRef.current
            if (toggle && toggle.offsetParent) toggle.focus()
          }
          if (viewMode === 'map') {
            if (selectedKey !== key || mapScope !== 'local') rememberMap()
            setMapScope('local'); setMapLimit(20); setFocusNeighbors(true)
          }
          setSelectedKey(key)
          setHoverKey('')
          setHiddenTypes({})
        }

        function openNode(node) {
          if (node && node.path) ctx.openPage(node.path)
        }

        function handleNodeClick(key) {
          if (suppressClickRef.current) return
          selectNode(key)
        }

        function handleNodeDoubleClick(node) {
          openNode(node)
        }

        function handleStagePointerDown(event) {
          if (event && typeof event.button === 'number' && event.button !== 0) return
          // Capturing a node's pointerdown would retarget its click to the canvas.
          // Start panning on the background so node selection remains a normal click.
          const target = event && event.target
          if (target && typeof target.closest === 'function' && target.closest('.kb-graph-node')) return
          dragRef.current = {
            active: true,
            startX: event.clientX,
            startY: event.clientY,
            originX: transformRef.current.tx,
            originY: transformRef.current.ty,
            moved: false,
          }
          setDragging(true)
          if (wrapperRef.current && wrapperRef.current.setPointerCapture) {
            try {
              wrapperRef.current.setPointerCapture(event.pointerId)
            } catch (error) {
              /* ignore */
            }
          }
        }

        function handleStagePointerMove(event) {
          const drag = dragRef.current
          if (!drag.active) return
          const dx = event.clientX - drag.startX
          const dy = event.clientY - drag.startY
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
          drag.moved = true
          setTransform(function (previous) {
            return { k: previous.k, tx: drag.originX + dx, ty: drag.originY + dy }
          })
        }

        function handleStagePointerUp(event) {
          const drag = dragRef.current
          if (!drag.active) return
          drag.active = false
          setDragging(false)
          if (drag.moved) {
            suppressClickRef.current = true
            window.setTimeout(function () {
              suppressClickRef.current = false
            }, 0)
          }
          if (wrapperRef.current && wrapperRef.current.releasePointerCapture) {
            try {
              wrapperRef.current.releasePointerCapture(event.pointerId)
            } catch (error) {
              /* ignore */
            }
          }
        }

        function handleStageClick(event) {
          if (suppressClickRef.current) return
          const target = event && event.target
          const nodeElement = target && typeof target.closest === 'function' ? target.closest('.kb-graph-node') : null
          if (nodeElement) return
          if (searchQuery) setSearchQuery('')
        }

        function handleKeyDown(event) {
          if (!event || !event.key) return
          if (event.key === 'Escape') {
            if (searchQuery) {
              setSearchQuery('')
              return
            }
            if (selectedKey) {
              backInMap()
              return
            }
            if (mapScope !== 'overview') backInMap()
            return
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            zoomStep(1.25)
            return
          }
          if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            zoomStep(0.8)
            return
          }
          if (event.key === '0') {
            event.preventDefault()
            fitView()
          }
        }

        function jumpSearch(direction) {
          if (matches.length === 0) return
          const start = searchCursor < 0 ? (direction < 0 ? 0 : -1) : searchCursor
          const nextIndex = (start + direction + matches.length) % matches.length
          setSearchCursor(nextIndex)
          const key = matches[nextIndex]
          selectNode(key)
          centerOnNode(key)
        }

        const isolatedCount = prepared.isolated.length
        const subtitleParts = [
          t('graph.stats', { nodes: prepared.nodes.length, edges: prepared.edges.length }),
          viewMode === 'map' && prepared.truncated ? t('graph.truncated', { shown: mapNodes.length, total: prepared.totalNodes }) : '',
          isolatedCount > 0 ? t('graph.isolated', { n: isolatedCount }) : '',
          filtersActive
            ? t('graph.filteredStats', {
                nodes: visibleNodes.length,
                totalNodes: prepared.nodes.length,
                edges: visibleEdges.length,
                totalEdges: prepared.edges.length,
              })
            : '',
        ].filter(Boolean)

        const viewSwitch = h('div', { className: 'kb-graph-view-switch', role: 'group', 'aria-label': t('graph.title') }, ['read', 'map'].map(function (mode) {
          return h('button', { key: mode, type: 'button', className: 'kb-graph-chip', 'data-active': viewMode === mode, 'aria-pressed': viewMode === mode, onClick: function () { setViewMode(mode); if (mode === 'map' && selectedKey) { setMapScope('local'); setFocusNeighbors(true) } } }, t(mode === 'read' ? 'graph.explore' : 'graph.map'))
        }))

        const head = h(
          'div',
          { className: 'kb-graph-head' },
          h(
            'div',
            { className: 'kb-ask-titles' },
            h('h2', { className: 'kb-overview-title' }, t('graph.title')),
            h('span', { className: 'kb-ask-sub' }, subtitleParts.join(t('common.separator'))),
          ),
          h('span', { className: 'kb-header-spacer' }),
          data ? viewSwitch : null,
          data
            ? h(
                'div',
                { className: 'kb-search kb-graph-search' },
                h('span', { className: 'kb-search-icon' }, h(SearchIcon, { size: 13 })),
                h('input', {
                  className: 'kb-search-input',
                  type: 'text',
                  value: searchQuery,
                  placeholder: t('graph.searchPlaceholder'),
                  'aria-label': t('graph.searchPlaceholder'),
                  onChange: function (event) {
                    setSearchQuery(event.target.value)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter' && !event.isComposing && !(event.nativeEvent && event.nativeEvent.isComposing)) {
                      event.preventDefault()
                      if (event.shiftKey) jumpSearch(-1)
                      else jumpSearch(1)
                    }
                  },
                  spellCheck: false,
                  autoComplete: 'off',
                }),
                searchQuery
                  ? h(
                      IconButton,
                      { label: t('graph.searchClear'), onClick: function () { setSearchQuery('') } },
                      h(CloseIcon, { size: 12 }),
                    )
                  : null,
              )
            : null,
          data
            ? h(
                'div',
                { className: 'kb-graph-head-actions' },
                h(
                  'button',
                  { type: 'button', className: 'kb-iconbtn', 'aria-label': t('graph.refresh'), onClick: ctx.loadGraph, disabled: state.status === 'loading', title: t('graph.refresh') },
                  h(RefreshIcon, { size: 12 }),
                ),
                viewMode === 'map' && mapScope !== 'overview' ? h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setLayoutNonce(layoutNonce + 1) }, title: t('graph.reload') },
                  h(GraphIcon, { size: 12 }),
                  h('span', null, t('graph.reload')),
                ) : null,
              )
            : null,
        )

        if (state.status === 'loading' && !data) {
          return h('div', { className: 'kb-graph-page' }, head, h('div', { className: 'kb-graph-state' }, h(LoadingBlock, { t: t, text: t('graph.loading') })))
        }
        if (state.status === 'error' && !data) {
          return h(
            'div',
            { className: 'kb-graph-page' },
            head,
            h('div', { className: 'kb-graph-state' }, h(ErrorBlock, { t: t, text: t('graph.failed', { message: asString(state.error) || t('error.requestFailed') }), onRetry: ctx.loadGraph })),
          )
        }
        if (!data || prepared.nodes.length === 0) {
          return h(
            'div',
            { className: 'kb-graph-page' },
            head,
            h(
              'div',
              { className: 'kb-graph-state' },
              h(EmptyBlock, {
                t: t,
                title: t('graph.empty.title'),
                hint: t('graph.empty.hint'),
                icon: h(GraphIcon, { size: 28 }),
                action: h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: ctx.pickFiles },
                  h(UploadIcon, { size: 13 }),
                  h('span', null, t('upload.dropTitle')),
                ),
              }),
            ),
          )
        }

        const labelPlacements = placeGraphLabels(visibleNodes, layout, transform,
          size.width || 900, size.height || 560, [selectedKey, hoverKey].concat(matches))

        const nodeList = visibleNodes.map(function (node) {
          const position = layout[node.key]
          if (!position) return null
          const color = NODE_COLORS[node.type] || NODE_COLOR_FALLBACK
          const isSelected = node.key === selectedKey
          const isMatch = Boolean(matchSet[node.key])
          const isFocusNeighbor = Boolean(focusNeighborSet && focusNeighborSet[node.key])
          let dimmed = false
          if (focusKey && !isSelected && !isFocusNeighbor) dimmed = true
          if (!focusKey && matches.length > 0 && !isMatch) dimmed = true
          const nodeElement = h(
            'g',
            {
              key: node.key,
              className: 'kb-graph-node',
              'data-type': node.type,
              'data-selected': isSelected ? 'true' : 'false',
              'data-dim': dimmed ? 'true' : 'false',
              'data-match': isMatch ? 'true' : 'false',
              role: node.path ? 'button' : 'img',
              tabIndex: node.path ? 0 : -1,
              'aria-label': node.title,
              'data-key': node.key,
              'aria-pressed': isSelected,
              onClick: function () {
                handleNodeClick(node.key)
              },
              onDoubleClick: function () {
                handleNodeDoubleClick(node)
              },
              onMouseEnter: function () {
                setHoverKey(node.key)
              },
              onMouseLeave: function () {
                setHoverKey(function (previous) {
                  return previous === node.key ? '' : previous
                })
              },
              onFocus: function () {
                setHoverKey(node.key)
              },
              onBlur: function () {
                setHoverKey(function (previous) {
                  return previous === node.key ? '' : previous
                })
              },
              onKeyDown: function (event) {
                if (event && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  event.stopPropagation()
                  selectNode(node.key)
                }
              },
            },
            h('circle', { cx: position.x, cy: position.y, r: position.r + 7, className: 'kb-graph-halo', fill: 'none' }),
            h('circle', { cx: position.x, cy: position.y, r: position.r, className: 'kb-graph-circle', style: { fill: color } }),
            h('title', null, node.title + ' · ' + (GRAPH_TYPE_LABEL_KEYS[node.type] ? t(GRAPH_TYPE_LABEL_KEYS[node.type]) : node.type)),

          )
          return nodeElement
        })

        const ceoLabels = []
        const edgeList = visibleEdges.map(function (edge) {
          const sourcePosition = layout[edge.source]
          const targetPosition = layout[edge.target]
          if (!sourcePosition || !targetPosition) return null
          const dx = targetPosition.x - sourcePosition.x
          const dy = targetPosition.y - sourcePosition.y
          const distance = Math.sqrt(dx * dx + dy * dy) || 1
          const sourceRadius = sourcePosition.r + 2
          const targetRadius = targetPosition.r + 4
          const x1 = sourcePosition.x + (dx / distance) * sourceRadius
          const y1 = sourcePosition.y + (dy / distance) * sourceRadius
          const x2 = targetPosition.x - (dx / distance) * targetRadius
          const y2 = targetPosition.y - (dy / distance) * targetRadius
          let active = false
          let dimmed = false
          if (focusKey) {
            active = edge.source === focusKey || edge.target === focusKey
            dimmed = !active
          }
          if (matches.length > 0 && !focusKey) {
            const sourceMatch = Boolean(matchSet[edge.source])
            const targetMatch = Boolean(matchSet[edge.target])
            active = sourceMatch && targetMatch
            dimmed = !sourceMatch && !targetMatch
          }
          const line = {
            x1: x1,
            y1: y1,
            x2: x2,
            y2: y2,
            className: 'kb-graph-edge',
            'data-relation': edge.relation,
            'data-active': active ? 'true' : 'false',
            'data-dim': dimmed ? 'true' : 'false',
          }
          if (edge.relation !== 'CEO') return h('line', Object.assign({ key: edge.key }, line))
          const direction = t('graph.ceoDirection', {
            person: prepared.byId[edge.source].title,
            company: prepared.byId[edge.target].title,
          })
          const visibleLength = (distance - sourceRadius - targetRadius) * transform.k
          if (visibleLength >= 34 && !dimmed) {
            ceoLabels.push(h('text', {
              key: edge.key,
              className: 'kb-graph-ceo-label',
              x: (x1 + x2) / 2 * transform.k + transform.tx,
              y: (y1 + y2) / 2 * transform.k + transform.ty,
            }, t('graph.relation.ceo')))
          }
          const unitX = dx / distance
          const unitY = dy / distance
          const arrowLength = 8 / transform.k
          const arrowHalfWidth = 4 / transform.k
          const baseX = x2 - unitX * arrowLength
          const baseY = y2 - unitY * arrowLength
          return h('g', {
            key: edge.key,
            className: 'kb-graph-ceo-edge',
            role: 'img',
            'aria-label': direction,
            'data-dim': dimmed ? 'true' : 'false',
          },
            h('title', null, direction),
            h('line', line),
            visibleLength > 10 ? h('polygon', {
              className: 'kb-graph-ceo-arrow',
              points: [
                [x2, y2],
                [baseX - unitY * arrowHalfWidth, baseY + unitX * arrowHalfWidth],
                [baseX + unitY * arrowHalfWidth, baseY - unitX * arrowHalfWidth],
              ].map(function (point) { return point.join(',') }).join(' '),
            }) : null,
          )
        })

        const detail = selectedNode
          ? h(
              'aside',
              { className: 'kb-graph-detail', role: 'region', 'aria-label': t('graph.detail') },
              h(
                'div',
                { className: 'kb-graph-detail-head' },
                h(TypeBadge, { t: t, type: selectedNode.type }),
                h('span', { className: 'kb-graph-detail-close' }, h(IconButton, { label: t('graph.detail.close'), onClick: function () { if (viewMode === 'map') backInMap(); else { setSelectedKey(''); setFocusNeighbors(false) } } }, h(CloseIcon, { size: 12 }))),
              ),
              selectedNode.type === 'topic' ? h('nav', { className: 'kb-topic-breadcrumb', 'aria-label': t('taxonomy.breadcrumb') }, topicForest.ancestors(selectedKey).map(function (node) {
                return h('button', { key: node.key, type: 'button', className: 'kb-linkbtn', onClick: function () { selectNode(node.key) } }, node.title, h('span', { 'aria-hidden': 'true' }, ' ›'))
              })) : null,
              h('h3', { className: 'kb-graph-detail-title' }, selectedNode.title),
              selectedNode.type === 'entity' ? h('span', { className: 'kb-badge' }, t('taxonomy.category.' + (selectedNode.entityCategoryAssigned ? selectedNode.entityCategory : 'unassigned'))) : null,
              h(
                'div',
                { className: 'kb-graph-detail-meta' },
                typeof selectedNode.degree === 'number'
                  ? h('span', null, t('graph.detail.degree', { n: selectedNode.degree }))
                  : null,
                selectedNode.confidence
                  ? h(ConfidenceBadge, { t: t, confidence: selectedNode.confidence })
                  : null,
              ),
              selectedNode.tags.length > 0
                ? h('div', { className: 'kb-graph-tags' }, selectedNode.tags.map(function (tag, index) {
                    return h('span', { key: 'tag-' + index, className: 'kb-graph-tag' }, tag)
                  }))
                : null,
              h(
                'div',
                { className: 'kb-graph-detail-actions' },
                selectedNode.path
                  ? h('button', { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: function () { ctx.openPage(selectedNode.path) } }, h(FileIcon, { size: 12 }), h('span', null, t('graph.detail.open')))
                  : null,
                h(ActionDisclosure, { t: t, actions: [
                  { label: t('graph.localMap'), pressed: mapScope === 'local' && viewMode === 'map', onClick: function () { setViewMode('map'); setMapScope('local'); setMapLimit(20); setFocusNeighbors(true) } },
                  selectedNode.type === 'topic' || selectedNode.type === 'entity' ? { label: t('taxonomy.organize'), onClick: function () { setTaxonomyDialog({ page: selectedNode }) } } : null,
                  selectedNode.type === 'topic' ? { label: t('taxonomy.addChild'), onClick: function () { setTaxonomyDialog({ creating: true, parentPath: selectedKey }) } } : null,
                ].filter(Boolean) }),
              ),
              selectedNode.type === 'topic' && (topicForest.children[selectedKey] || []).length ? h('section', { className: 'kb-graph-section' },
                h('h4', null, t('taxonomy.children', { n: topicForest.children[selectedKey].length })),
                topicForest.children[selectedKey].map(function (node) { return h('button', { key: node.key, type: 'button', className: 'kb-topic-child-link', onClick: function () { selectNode(node.key) } }, node.title) }),
              ) : null,
              preview.status === 'loading'
                ? h('p', { className: 'kb-graph-copy', role: 'status' }, t('graph.previewLoading'))
                : preview.status === 'error'
                  ? h(ErrorBlock, { t: t, text: preview.error, onRetry: function () { setPreviewNonce(previewNonce + 1) } })
                  : previewPage ? h('section', { className: 'kb-graph-section' },
                      h('h4', null, t('graph.preview')),
                      h('p', { className: 'kb-graph-copy' }, graphPageSummary(previewPage.markdown) || t('graph.previewEmpty')),
                    ) : null,
              h('section', { className: 'kb-graph-section' },
                h('h4', null, t('graph.provenance')),
                sourceRefs.length ? sourceRefs.map(function (ref) {
                  return h('div', { key: ref.id, className: 'kb-graph-source-row' },
                    h('span', { className: 'kb-graph-source-title' }, h(FileIcon, { size: 16 }), h('span', null, ref.title || ref.name || ref.id)),
                    h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.openSourceOriginal(ref) } }, t('page.openOriginal')),
                  )
                }) : h('p', { className: 'kb-graph-copy' }, preview.status === 'loading' ? t('graph.previewLoading') : t('graph.noSources')),
              ),
              h(
                'div',
                { className: 'kb-graph-neighbors' },
                h('div', { className: 'kb-graph-nb-title' }, t('graph.references') + ' · ' + selectedNeighbors.length),
                selectedNeighbors.length === 0
                  ? h('div', { className: 'kb-graph-detail-empty' }, t('graph.detail.noNeighbors'))
                  : selectedNeighbors.slice(0, neighborLimit).map(function (neighbor, index) {
                      const neighborNode = prepared.byId[neighbor.key]
                      if (!neighborNode) return null
                      const neighborColor = NODE_COLORS[neighborNode.type] || NODE_COLOR_FALLBACK
                      const expanded = evidenceKey === neighbor.key
                      const contextPage = evidenceFromKey === selectedKey ? previewPage : evidence.key === evidenceFromKey && evidence.status === 'ready' ? evidence.page : null
                      const targetKey = evidenceFromKey === selectedKey ? neighbor.key : selectedKey
                      const excerpt = expanded ? referenceContext(contextPage, targetKey) : ''
                      return h('article', { key: 'nb-' + neighbor.key, className: 'kb-graph-relation-row' },
                        h('button', {
                          type: 'button', className: 'kb-graph-nb', title: neighborNode.title,
                          onClick: function () { selectNode(neighbor.key); centerOnNode(neighbor.key) },
                        },
                          h('span', { className: 'kb-graph-nb-dot', style: { background: neighborColor } }),
                          h('span', { className: 'kb-graph-nb-title-text' }, neighborNode.title),
                        ),
                        h('div', { className: 'kb-graph-relation-actions' },
                          h('span', { className: 'kb-graph-relation-label' }, neighborLabel(neighbor)),
                          neighbor.linkIn || neighbor.linkOut ? h('button', {
                            type: 'button', className: 'kb-linkbtn', 'aria-expanded': expanded,
                            onClick: function () { setEvidenceKey(expanded ? '' : neighbor.key) },
                          }, t(expanded ? 'graph.evidenceHide' : 'graph.evidence')) : null,
                        ),
                        neighbor.ceoSources && neighbor.ceoSources.length ? h('ul', { className: 'kb-graph-ceo-sources' },
                          neighbor.ceoSources.map(function (ref) {
                            const article = asString(ref.passage && ref.passage.title) || asString(ref.title)
                            return h('li', { key: ref.id }, h('button', {
                              type: 'button',
                              className: 'kb-linkbtn kb-graph-ceo-source',
                              'aria-label': article ? t('graph.ceoSourceNamed', { title: article }) : t('graph.ceoSource'),
                              onClick: function () { ctx.openSourceOriginal(ref) },
                            }, article || t('graph.ceoSource')))
                          }),
                        ) : null,
                        expanded ? h('div', { className: 'kb-graph-evidence', role: 'status' },
                          contextPage ? h(React.Fragment, null,
                            h('p', null, excerpt || t('graph.evidenceMissing')),
                            h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.openPage(evidenceFromKey) } }, t('graph.evidenceFrom', { title: contextPage.title })),
                          ) : h('p', null, evidence.status === 'error' && evidenceFromKey !== selectedKey ? evidence.error : preview.status === 'error' ? preview.error : t('graph.previewLoading')),
                        ) : null,
                      )
                    }),
                selectedNeighbors.length > neighborLimit ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setNeighborLimit(neighborLimit + 30) } }, t('graph.more', { n: Math.min(30, selectedNeighbors.length - neighborLimit) })) : null,
              ),
              h('p', { className: 'kb-graph-copy kb-graph-caveat' }, t('graph.evidenceCaveat')),
            )
          : null

        const typeChips = GRAPH_LEGEND.map(function (item) {
          const visible = !hiddenTypes[item.type]
          const count = prepared.typeCounts[item.type] || 0
          return h(
            'button',
            {
              key: 'type-' + item.type,
              type: 'button',
              className: 'kb-graph-chip',
              'data-active': visible ? 'true' : 'false',
              'aria-pressed': visible ? 'true' : 'false',
              title: t(item.key),
              onClick: function () {
                setHiddenTypes(function (previous) {
                  const next = Object.assign({}, previous)
                  if (next[item.type]) delete next[item.type]
                  else next[item.type] = true
                  return next
                })
              },
            },
            h('span', { className: 'kb-graph-chip-dot', style: { background: NODE_COLORS[item.type] || NODE_COLOR_FALLBACK } }),
            h('span', null, t(item.key)),
            h('span', { className: 'kb-graph-chip-count' }, String(count)),
          )
        })
        if (Object.keys(hiddenTypes).length > 0) {
          typeChips.push(
            h(
              'button',
              {
                key: 'type-all',
                type: 'button',
                className: 'kb-graph-chip',
                'data-active': 'true',
                onClick: function () {
                  setHiddenTypes({})
                },
              },
              h('span', null, t('graph.filterShowAll')),
            ),
          )
        }

        const relationChips = GRAPH_RELATIONS.map(function (item) {
          const visible = !hiddenRelations[item.relation]
          const count = prepared.relationCounts[item.relation] || 0
          if (item.relation === 'CEO' && !count) return null
          return h(
            'button',
            {
              key: 'rel-' + item.relation,
              type: 'button',
              className: 'kb-graph-chip',
              'data-active': visible ? 'true' : 'false',
              'aria-pressed': visible ? 'true' : 'false',
              title: t(item.key),
              onClick: function () {
                setHiddenRelations(function (previous) {
                  const next = Object.assign({}, previous)
                  if (next[item.relation]) delete next[item.relation]
                  else next[item.relation] = true
                  return next
                })
              },
            },
            h('span', { className: 'kb-graph-rel-line', 'data-relation': item.relation }),
            h('span', null, t(item.key)),
            h('span', { className: 'kb-graph-chip-count' }, String(count)),
          )
        })

        const filterEmpty = visibleNodes.length === 0
        const searchNote = matches.length > 0
          ? h('span', { className: 'kb-graph-chip kb-graph-chip-static' }, t('graph.searchMatches', { n: matches.length }))
          : normalizedQuery
            ? h('span', { className: 'kb-graph-chip kb-graph-chip-static' }, t('graph.searchEmpty'))
            : null

        const catalogModes = ['topics', 'entities', 'bridges', 'isolated', 'all']
        function inMode(node, mode) {
          if (mode === 'topics') return node.type === 'topic'
          if (mode === 'entities') return node.type === 'entity'
          if (mode === 'bridges') return node.type !== 'source' && node.sourceCount > 1
          if (mode === 'isolated') return !prepared.adjacency[node.key] || prepared.adjacency[node.key].length === 0
          return true
        }
        const catalogue = prepared.nodes.filter(function (node) {
          return inMode(node, exploreMode) && (!normalizedQuery || matchSet[node.key])
        }).sort(function (a, b) {
          if (exploreMode === 'bridges' && a.sourceCount !== b.sourceCount) return b.sourceCount - a.sourceCount
          if (exploreMode === 'topics' && a.type !== b.type) return (a.type === 'topic' ? -1 : 0) - (b.type === 'topic' ? -1 : 0)
          return b.degree - a.degree || a.title.localeCompare(b.title)
        })
        function catalogRow(node) {
          return h('button', {
            key: node.key, type: 'button', className: 'kb-graph-catalog-row', 'aria-pressed': selectedKey === node.key,
            onClick: function () { selectNode(node.key) },
          },
            h('span', { className: 'kb-graph-catalog-title' }, node.title),
            h('span', { className: 'kb-graph-catalog-meta' }, pageTypeLabel(t, node.type), t('common.separator'), t('graph.sourcesCount', { n: node.sourceCount })),
          )
        }
        const cataloguePanel = h('nav', { className: 'kb-graph-catalog', 'data-open': catalogOpen, 'aria-label': t('graph.catalog') },
          h('button', { ref: catalogToggleRef, type: 'button', className: 'kb-graph-catalog-toggle', 'aria-expanded': catalogOpen, 'aria-controls': 'kb-graph-catalog-body', onClick: function () { setCatalogOpen(!catalogOpen) } }, h(FolderIcon, { size: 16 }), h('span', null, t('graph.browseCatalog')), h('span', { className: 'kb-graph-toggle-mode' }, t('graph.mode.' + exploreMode)), h(ChevronIcon, { size: 14, expanded: catalogOpen })),
          h('div', { className: 'kb-graph-catalog-body', id: 'kb-graph-catalog-body' },
          h('div', { className: 'kb-graph-catalog-modes', role: 'group', 'aria-label': t('graph.catalog') }, catalogModes.map(function (mode) {
            return h('button', {
              key: mode, type: 'button', className: 'kb-graph-chip', 'data-active': exploreMode === mode, 'aria-pressed': exploreMode === mode,
              onClick: function () { setExploreMode(mode) },
            }, h('span', { className: 'kb-graph-mode-icon', 'aria-hidden': 'true' }, h(mode === 'topics' ? FolderIcon : mode === 'bridges' ? LinkIcon : mode === 'isolated' ? WarningIcon : mode === 'entities' ? BrandGlyph : FileIcon, { size: 16 })), h('span', { className: 'kb-graph-mode-label' }, t('graph.mode.' + mode)), h('span', { className: 'kb-graph-mode-count' }, prepared.nodes.filter(function (node) { return inMode(node, mode) }).length))
          })),
          h('div', { className: 'kb-graph-catalog-section' },
            h('h3', { className: 'kb-graph-catalog-heading' }, t('graph.mode.' + exploreMode)),
            exploreMode === 'topics' ? h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { setTaxonomyDialog({ creating: true, parentPath: '' }) } }, '+ ', t('taxonomy.createTopic')) : null,
          ),
          h('p', { className: 'kb-graph-catalog-hint' }, t('graph.mode.' + exploreMode + '.hint')),
          h('div', { className: 'kb-graph-catalog-list' },
            exploreMode === 'topics' ? h(TopicOutline, { t: t, nodes: prepared.nodes, query: searchQuery, selectedKey: selectedKey, onSelect: selectNode }) : exploreMode === 'entities' ? h(EntityCatalogue, { compact: true, t: t, nodes: prepared.nodes, query: searchQuery, selectedKey: selectedKey, onSelect: selectNode }) : catalogue.length ? catalogue.slice(0, catalogLimit).map(catalogRow) : h('p', { className: 'kb-graph-copy', role: 'status' }, t('graph.catalogEmpty')),
            exploreMode !== 'topics' && exploreMode !== 'entities' && catalogue.length > catalogLimit ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setCatalogLimit(catalogLimit + 60) } }, t('graph.more', { n: Math.min(60, catalogue.length - catalogLimit) })) : null,
          ),
          ),
        )
        const welcome = h('div', { className: 'kb-graph-welcome' },
          h('h3', null, t('graph.welcome.title')),
          h('p', { className: 'kb-graph-copy' }, t('graph.welcome.desc')),
          ['bridges', 'topics'].map(function (mode) {
            const suggestions = prepared.nodes.filter(function (node) { return mode === 'topics' ? (node.type === 'topic' || node.type === 'synthesis') && node.sourceCount < 2 : inMode(node, mode) }).sort(function (a, b) { return mode === 'bridges' ? b.sourceCount - a.sourceCount || b.degree - a.degree : b.degree - a.degree }).slice(0, 3)
            return suggestions.length ? h('section', { key: mode, className: 'kb-graph-section' }, h('h4', null, t('graph.welcome.' + mode)), suggestions.map(catalogRow)) : null
          }),
          h('p', { className: 'kb-graph-copy kb-graph-caveat' }, t('graph.evidenceCaveat')),
        )


        const organizationDialog = taxonomyDialog ? h(TaxonomyDialog, Object.assign({}, taxonomyDialog, {
          nodes: prepared.nodes,
          onClose: function () { setTaxonomyDialog(null) },
          onSaved: function (page) { setTaxonomyDialog(null); if (page && page.path) selectNode(page.path) },
        })) : null

        if (viewMode === 'read') return h('div', { className: 'kb-graph-page' }, head,
          h('div', { className: 'kb-graph-reading' }, cataloguePanel, h('div', { className: 'kb-graph-reading-content' }, detail || welcome)), organizationDialog,
        )

        const groupTitle = activeGroup ? (activeGroup.title || t('graph.ungrouped')) : ''
        const mapNavigation = h('nav', { className: 'kb-graph-mapnav', 'aria-label': t('graph.overview') },
          mapScope !== 'overview' ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm kb-graph-back', onClick: backInMap }, '‹ ', t('graph.back')) : null,
          h('button', { type: 'button', className: 'kb-linkbtn', onClick: mapOverview, 'aria-current': mapScope === 'overview' ? 'page' : undefined }, t('graph.overview')),
          mapScope !== 'overview' ? h('span', { 'aria-hidden': 'true' }, ' / ') : null,
          groupKey && mapScope !== 'overview' ? h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { openGroup(groupKey) } }, groupTitle) : null,
          mapScope === 'local' ? h('span', { className: 'kb-graph-current' }, selectedNode ? selectedNode.title : t('graph.localMap')) : null,
          mapScope === 'all' ? h('span', null, t('graph.allMap')) : null,
          mapScope === 'overview' ? h('button', { type: 'button', className: 'kb-linkbtn kb-graph-all', onClick: function () { rememberMap(); setMapScope('all'); setSelectedKey(''); setFocusNeighbors(false) } }, t('graph.allMap')) : null,
        )

        if (mapScope === 'overview') return h('div', { className: 'kb-graph-page' }, head, organizationDialog,
          mapNavigation,
          h('section', { className: 'kb-graph-overview', 'aria-label': t('graph.overview') },
            h('div', { className: 'kb-graph-overview-intro' }, h('h3', null, t('graph.overviewTitle')), h('p', null, t('graph.overviewHint'))),
            normalizedQuery ? h('section', { className: 'kb-graph-search-results', 'aria-label': t('graph.matchPages') },
              h('h4', null, t('graph.matchPages') + ' · ' + matches.length),
              matches.length ? matches.slice(0, 20).map(function (key) { const node = prepared.byId[key]; return h('button', { key: key, type: 'button', className: 'kb-graph-result', onClick: function () { selectNode(key) } }, h(TypeBadge, { t: t, type: node.type }), h('span', null, node.title)) }) : h('p', { role: 'status' }, t('graph.searchEmpty')),
              matches.length > 20 ? h('p', null, t('graph.moreMatches', { n: matches.length - 20 })) : null,
            ) : null,
            h('div', { className: 'kb-graph-group-grid' }, topicGroups.filter(function (group) {
              return !normalizedQuery || group.members.some(function (node) { return matchSet[node.key] })
            }).map(function (group, index) {
              return h('button', { key: group.key, type: 'button', className: 'kb-graph-group-card', 'data-group': group.key, onClick: function () { openGroup(group.key) } },
                h('span', { className: 'kb-graph-group-top' }, h(FolderIcon, { size: 20 }), h('span', { className: 'kb-graph-group-index', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')), h('span', { className: 'kb-graph-group-arrow', 'aria-hidden': 'true' }, '↗')),
                h('span', { className: 'kb-graph-group-title' }, group.title || t('graph.ungrouped')),
                h('span', { className: 'kb-graph-group-meta' }, t('graph.groupCounts', { topics: group.topics.length, pages: group.members.length - group.topics.length })),
                h('span', { className: 'kb-graph-group-examples' }, group.key === '@ungrouped' ? t('graph.ungroupedHint') : (group.children.length ? group.children : group.members.filter(function (node) { return node.key !== group.key })).slice(0, 3).map(function (node) { return node.title }).join(' · ')),
              )
            })),
            h('p', { className: 'kb-graph-overview-footnote' }, t('graph.groupShared')),
          ),
        )

        const labelList = Object.keys(labelPlacements).map(function (key) {
          const label = labelPlacements[key]
          return h('g', { key: key, className: 'kb-graph-screen-label', 'data-key': key, 'data-selected': key === selectedKey, 'aria-hidden': 'true' },
            label.leader ? h('line', Object.assign({ className: 'kb-graph-label-leader' }, label.leader)) : null,
            h('text', { x: label.textX, y: label.textY, className: 'kb-graph-label' }, label.lines.map(function (line, index) {
              return h('tspan', { key: index, x: label.textX, dy: index ? label.lineHeight : 0 }, line)
            })),
          )
        })
        const hiddenLabelCount = visibleNodes.length - Object.keys(labelPlacements).length
        return h('div', { className: 'kb-graph-page' }, head, organizationDialog, mapNavigation,
          h('div', { className: 'kb-graph-map-status' },
            h('span', null, t(mapScope === 'local' ? 'graph.localHint' : mapScope === 'group' ? 'graph.groupHint' : 'graph.allHint')),
            h('span', { className: 'kb-graph-shown', role: 'status', 'aria-live': 'polite' }, t('graph.shown', { shown: mapNodes.length, total: mapCandidates.length })),
            mapScope !== 'all' && mapNodes.length < Math.min(mapCandidates.length, MAX_GRAPH_NODES) ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm kb-graph-expand', onClick: function () { setMapLimit(Math.min(mapLimit + 12, MAX_GRAPH_NODES)) } }, t('graph.expandMore', { n: Math.min(12, mapCandidates.length - mapNodes.length, MAX_GRAPH_NODES - mapNodes.length) })) : null,
            mapNodes.length >= MAX_GRAPH_NODES && mapCandidates.length > MAX_GRAPH_NODES ? h('span', null, t('graph.mapLimit')) : null,
          ),
          h('div', { className: 'kb-graph-filterbar', role: 'group', 'aria-label': t('graph.filterTypes') }, typeChips, h('span', { className: 'kb-graph-filter-sep' }), relationChips),
          h('div', { className: 'kb-graph-workspace', 'data-detail': Boolean(selectedNode) },
            h('div', { ref: stageRef, className: 'kb-graph-stage', 'data-dragging': dragging ? 'true' : 'false', 'data-scope': mapScope },
              h('div', { ref: wrapperRef, className: 'kb-graph-panlayer', tabIndex: 0, role: 'group', 'aria-label': t('graph.title'), onPointerDown: handleStagePointerDown, onPointerMove: handleStagePointerMove, onPointerUp: handleStagePointerUp, onPointerCancel: handleStagePointerUp, onClick: handleStageClick, onKeyDown: handleKeyDown, style: { touchAction: 'none' } },
                h('svg', { className: 'kb-graph-svg', viewBox: '0 0 ' + (size.width || 900) + ' ' + (size.height || 560), preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': t('graph.title') },
                  h('g', { transform: 'translate(' + transform.tx + ',' + transform.ty + ') scale(' + transform.k + ')' }, edgeList, nodeList),
                  h('g', { className: 'kb-graph-label-layer', 'aria-hidden': 'true' }, ceoLabels, labelList),
                ),
              ),
              h('div', { className: 'kb-graph-toolbar', role: 'toolbar', 'aria-label': t('graph.toolsLabel') },
                h('button', { type: 'button', className: 'kb-graph-iconbtn', onClick: function () { zoomStep(1.25) }, title: t('graph.zoomIn'), 'aria-label': t('graph.zoomIn') }, h(ZoomInIcon, { size: 15 })),
                h('button', { type: 'button', className: 'kb-graph-iconbtn', onClick: function () { zoomStep(0.8) }, title: t('graph.zoomOut'), 'aria-label': t('graph.zoomOut') }, h(ZoomOutIcon, { size: 15 })),
                h('button', { type: 'button', className: 'kb-graph-iconbtn', onClick: fitView, title: t('graph.fit'), 'aria-label': t('graph.fit') }, h(FitIcon, { size: 15 })),
                h('span', { className: 'kb-graph-zoom-label' }, Math.round(transform.k * 100) + '%'),
              ),
              h('div', { className: 'kb-graph-hintbar' }, hiddenLabelCount ? t('graph.hiddenLabels', { n: hiddenLabelCount }) : t('graph.panHint')),
              filterEmpty ? h('div', { className: 'kb-graph-empty-note' }, t('graph.filterEmpty'), h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setHiddenTypes({}); setHiddenRelations({}) } }, t('graph.filterShowAll'))) : null,
              searchNote ? h('div', { className: 'kb-graph-search-note' }, searchNote) : null,
            ), detail,
          ),
        )
      }

      // ======================================================================
      // tab = 问答（POST /ask SSE 流式 + 引用 chips）
      // ======================================================================

      /**
       * 问答视图：消息列表 + 输入框 + 流式回答。
       * @returns {any}
       */
      function bookRoute(bookId, suffix) {
        const id = asString(bookId)
        if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid book identifier')
        const path = asString(suffix)
        if (path && path.charAt(0) !== '/') throw new Error('Invalid book route')
        let pathname = path.split(/[?#]/)[0]
        for (let pass = 0; pass < 3; pass += 1) {
          if (pathname.indexOf('\\') >= 0 || pathname.split('/').some(function (part) { return part === '.' || part === '..' })) throw new Error('Invalid book route')
          try { const decoded = decodeURIComponent(pathname); if (decoded === pathname) break; pathname = decoded } catch (error) { throw new Error('Invalid book route') }
        }
        return '/books/' + encodeURIComponent(id) + path
      }

      function bookRequest(bookId, suffix, options) {
        try { return api(bookRoute(bookId, suffix), options) }
        catch (error) { return Promise.reject(error) }
      }

      function bookStatusLabel(t, status) {
        const known = ['imported', 'running', 'paused', 'partial', 'ready', 'failed']
        return t('books.status.' + (known.indexOf(status) >= 0 ? status : 'imported'))
      }

      function BookProgress(props) {
        const t = props.t
        const book = props.book || {}
        const coverage = book.coverage || {}
        const total = Number(coverage.totalChapters) || 0
        const completed = Number(coverage.completedChapters) || 0
        const pages = book.stats && Number(book.stats.pages) || 0
        const progressText = t('books.progress', { done: completed, total: total, pages: pages })
        const status = book.status === 'ready' && total > 0 ? null
          : h('span', { className: 'kb-badge', 'data-book-status': book.status }, bookStatusLabel(t, book.status))
        const warningKey = coverage.truncated ? 'books.incomplete' : coverage.coverageComplete === false ? 'books.coverageUnknown' : ''
        const warning = warningKey ? h('p', { className: 'kb-book-warning' }, t(warningKey)) : null
        return h('div', { className: 'kb-book-progress' },
          props.children ? h('details', { className: 'kb-book-diagnostics' },
            h('summary', { className: 'kb-book-progress-label' },
              h('span', { className: 'kb-book-diagnostics-title' }, t('books.extractionDetails')),
              status,
              total > 0 ? h('span', null, progressText) : null,
              warningKey ? h('span', { className: 'kb-book-coverage' }, t(coverage.truncated ? 'books.coveragePartialShort' : 'books.coverageUnknownShort')) : null,
            ),
            h('div', { className: 'kb-book-diagnostics-body', role: 'region', tabIndex: 0, 'aria-label': t('books.extractionDetails') }, warning, props.children),
          ) : h('div', { className: 'kb-book-progress-label' },
            status,
            total > 0 ? h('span', null, progressText) : null,
          ),
          book.status === 'running' ? h('progress', { max: total || undefined, value: total > 0 ? completed : undefined, 'aria-label': total > 0 ? progressText : bookStatusLabel(t, book.status) }) : null,
          props.children ? null : warning,
        )
      }

      function BooksTab() {
        const ctx = useKb()
        const t = ctx.t
        const [books, setBooks] = useState([])
        const [status, setStatus] = useState('loading')
        const [error, setError] = useState('')
        const [selectedId, setSelectedId] = useState(cache.bookSelectedId || '')
        const [importing, setImporting] = useState(false)
        const [importName, setImportName] = useState('')
        const [deleteBook, setDeleteBook] = useState(null)
        const [deleteBusy, setDeleteBusy] = useState(false)
        const [deleteError, setDeleteError] = useState('')
        const inputRef = useRef(null)
        const mounted = useRef(true)
        const loadAbort = useRef(null)
        const importAbort = useRef(null)
        const maxBytes = ctx.meta && ctx.meta.data && ctx.meta.data.limits ? ctx.meta.data.limits.maxFileBytes || DEFAULT_MAX_FILE_BYTES : DEFAULT_MAX_FILE_BYTES

        async function loadBooks() {
          if (loadAbort.current) loadAbort.current.abort()
          const controller = new AbortController()
          loadAbort.current = controller
          try {
            const result = await api('/books', { signal: controller.signal })
            if (controller.signal.aborted || !mounted.current) return
            setBooks(Array.isArray(result.books) ? result.books : [])
            setStatus('ready'); setError('')
          } catch (err) {
            if (controller.signal.aborted || !mounted.current) return
            setStatus('error'); setError(errorMessage(err, t('error.requestFailed')))
          }
        }
        useEffect(function () {
          mounted.current = true
          loadBooks()
          return function () { mounted.current = false; if (loadAbort.current) loadAbort.current.abort(); if (importAbort.current) importAbort.current.abort() }
        }, [])
        useEffect(function () { cache.bookSelectedId = selectedId }, [selectedId])
        const hasRunningBooks = books.some(function (book) { return book.status === 'running' || book.reading && book.reading.status === 'running' })
        useEffect(function () {
          if (!hasRunningBooks || selectedId) return undefined
          const timer = setInterval(loadBooks, 2200)
          return function () { clearInterval(timer) }
        }, [hasRunningBooks, selectedId])

        async function importFiles(event) {
          const files = Array.from(event.target.files || [])
          event.target.value = ''
          if (!files.length || importing) return
          setImporting(true); setError('')
          let importedId = ''
          const controller = new AbortController()
          importAbort.current = controller
          try {
            for (const file of files) {
              if (file.size > maxBytes) throw new Error(t('books.tooLarge', { name: file.name, size: formatBytes(maxBytes) }))
              if (!/\.(pdf|epub|txt|md|markdown|docx)$/i.test(file.name)) throw new Error(t('books.unsupported'))
              if (controller.signal.aborted || !mounted.current) return
              setImportName(file.name)
              const dataBase64 = await readFileAsBase64(file, t)
              if (controller.signal.aborted || !mounted.current) return
              const result = await api('/books', { method: 'POST', body: { name: file.name, mime: file.type || '', dataBase64: dataBase64 }, signal: controller.signal })
              if (controller.signal.aborted || !mounted.current) return
              if (result.book && result.book.id) {
                importedId = result.book.id
                if (files.length === 1) await bookRequest(importedId, '/analysis/start', { method: 'POST', signal: controller.signal })
              }
            }
            await loadBooks()
            if (mounted.current && files.length === 1 && importedId) setSelectedId(importedId)
          } catch (err) {
            if (!controller.signal.aborted && mounted.current) { await loadBooks(); if (mounted.current) setError(errorMessage(err, t('error.requestFailed'))) }
          } finally {
            if (mounted.current) { setImporting(false); setImportName('') }
          }
        }

        async function confirmDelete() {
          if (!deleteBook || deleteBusy) return
          setDeleteBusy(true); setDeleteError('')
          try {
            await bookRequest(deleteBook.id, '', { method: 'DELETE' })
            if (!mounted.current) return
            setDeleteBook(null)
            await loadBooks()
          } catch (err) {
            if (mounted.current) setDeleteError(errorMessage(err, t('error.requestFailed')))
          } finally { if (mounted.current) setDeleteBusy(false) }
        }

        if (selectedId) return h(BookDetail, { key: selectedId, bookId: selectedId, onBack: function () { setSelectedId(''); loadBooks() } })
        return h('div', { className: 'kb-books' },
          h('header', { className: 'kb-books-head' },
            h('div', null, h('h2', { className: 'kb-overview-title' }, t('books.title')), h('p', { className: 'kb-graph-copy' }, t('books.subtitle'))),
            h('div', { className: 'kb-books-actions' },
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: loadBooks, disabled: importing }, h(RefreshIcon, { size: 13 }), t('common.refresh')),
              h('button', { type: 'button', className: 'kb-btn kb-btn-primary', disabled: importing, onClick: function () { if (inputRef.current) inputRef.current.click() } }, h(UploadIcon, { size: 14 }), t(importing ? 'books.importing' : 'books.import')),
            ),
          ),
          h('input', { ref: inputRef, className: 'kb-books-file-input', type: 'file', multiple: true, accept: '.pdf,.epub,.txt,.md,.markdown,.docx', 'aria-label': t('books.import'), disabled: importing, onChange: importFiles }),
          h('div', { className: 'kb-books-scroll' },
            h('p', { className: 'kb-books-intro' }, t('books.importHint', { size: formatBytes(maxBytes) })),
            importing ? h('p', { className: 'kb-book-import-status', role: 'status' }, h(Spinner, { size: 'sm' }), t('books.importProgress', { name: importName })) : null,
            error ? h('p', { className: 'kb-inline-error', role: 'alert' }, error) : null,
            status === 'loading' ? h(LoadingBlock, { t: t, text: t('books.loading') }) : null,
            status === 'error' && !books.length ? h(ErrorBlock, { t: t, text: error, onRetry: loadBooks }) : null,
            status === 'ready' && !books.length ? h(EmptyBlock, { t: t, title: t('books.emptyTitle'), hint: t('books.emptyHint'), icon: h(FileIcon, { size: 32 }), action: h('button', { type: 'button', className: 'kb-btn kb-btn-primary', disabled: importing, onClick: function () { if (inputRef.current) inputRef.current.click() } }, t('books.import')) }) : null,
            books.length ? h('div', { className: 'kb-book-grid' }, books.map(function (book) { return h('article', { key: book.id, className: 'kb-book-card' },
              h('button', { type: 'button', className: 'kb-book-card-open', onClick: function () { setSelectedId(book.id) } },
                h('span', { className: 'kb-book-cover', 'aria-hidden': 'true' }, h(FileIcon, { size: 28 })),
                h('span', { className: 'kb-book-card-title' }, book.title || book.name),
                h('span', { className: 'kb-book-card-name' }, book.name),
              ),
              book.error ? h(BookProgress, { t: t, book: book }) : h('div', { className: 'kb-reading-shelf' },
                h('p', null, t('reading.state.' + (book.reading ? book.reading.status : 'empty'))),
                h('p', { className: 'kb-graph-copy' }, book.reading && book.reading.totalUnits ? t('reading.progress', { n: book.reading.completedUnits, total: book.reading.totalUnits }) : t('books.chapterCount', { n: book.coverage && book.coverage.totalChapters || 0 })),
              ),
              h('div', { className: 'kb-book-card-footer' },
                h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { setSelectedId(book.id) } }, t('books.open')),
                h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: function () { setDeleteBook(book); setDeleteError('') } }, t('books.delete')),
              ),
            ) })) : null,
          ),
          deleteBook ? h(ConfirmDialog, { t: t, title: t('books.deleteTitle', { title: deleteBook.title || deleteBook.name }), description: t('books.deleteHint'), confirmLabel: t('books.delete'), busy: deleteBusy, busyLabel: t('manage.deleting'), error: deleteError, onCancel: function () { if (!deleteBusy) setDeleteBook(null) }, onConfirm: confirmDelete }) : null,
        )
      }

      /** 主库和书库的问答输入区使用同一套布局和键盘行为。 */
      function renderQuestionComposer({
        t, inputId, inputRef, value, onChange, onSend, onStop, busy, disabled,
        placeholder, label, keys, stopLabel, className,
      }) {
        const showKeys = !busy && !disabled
        const keysId = inputId + '-keys'
        function submit(event) {
          if (event) event.preventDefault()
          if (!busy && !disabled && value.trim()) return onSend()
        }
        return h('form', { className: className, onSubmit: submit },
          h('div', { className: 'kb-composer-box' },
            h('textarea', {
              className: 'kb-composer-input', id: inputId, ref: inputRef,
              value: value, rows: 1, maxLength: 4000, disabled: disabled,
              placeholder: placeholder, 'aria-label': label,
              'aria-describedby': showKeys ? keysId : undefined,
              onChange: function (event) { onChange(event.target.value) },
              onKeyDown: function (event) {
                const composing = event.isComposing || event.keyCode === 229 || event.nativeEvent?.isComposing
                if (event.key === 'Enter' && !event.shiftKey && !composing && !busy) submit(event)
              },
            }),
            h('div', { className: 'kb-composer-actions' },
              showKeys ? h('span', { id: keysId, className: 'kb-composer-keys' }, keys) : null,
              busy
                ? h('button', { type: 'button', className: 'kb-btn kb-send', onClick: onStop }, stopLabel)
                : h('button', { type: 'submit', className: 'kb-btn kb-btn-primary kb-send', disabled: disabled || !value.trim(), title: keys }, t('ask.send')),
            ),
          ),
        )
      }

      function BookAsk(props) {
        const t = props.t
        const [messages, setMessages] = useState([])
        const [input, setInput] = useState('')
        const [busy, setBusy] = useState(false)
        const mounted = useRef(true)
        const controllerRef = useRef(null)
        const serial = useRef(0)
        const scrollRef = useRef(null)
        const inputRef = useRef(null)
        const nearBottom = useRef(true)
        useEffect(function () {
          mounted.current = true
          setMessages([]); setInput(''); setBusy(false)
          return function () { mounted.current = false; serial.current += 1; if (controllerRef.current) controllerRef.current.abort() }
        }, [props.bookId])
        function stop() {
          serial.current += 1
          if (controllerRef.current) controllerRef.current.abort()
          setBusy(false)
          setMessages(function (items) { return items.map(function (item) { return item.status === 'streaming' ? Object.assign({}, item, { status: 'stopped' }) : item }) })
        }
        useEffect(function () { if (!props.active && controllerRef.current) stop() }, [props.active])
        useEffect(function () { if (scrollRef.current && nearBottom.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight }, [messages])
        async function send(event) {
          if (event && event.preventDefault) event.preventDefault()
          const question = input.trim()
          if (!question || busy || !props.enabled || question.length > 4000) return
          const requestId = ++serial.current
          const controller = new AbortController()
          controllerRef.current = controller
          const history = messages.filter(function (item) { return item.role === 'user' || item.status === 'done' }).slice(-12).map(function (item) { return { role: item.role, content: item.content.slice(0, 4000) } })
          const answerId = 'book-answer-' + requestId
          setInput(''); setBusy(true); nearBottom.current = true
          if (inputRef.current) inputRef.current.focus({ preventScroll: true })
          setMessages(function (items) { return items.concat([{ id: 'book-question-' + requestId, role: 'user', content: question }, { id: answerId, role: 'assistant', content: '', sources: [], status: 'streaming' }]) })
          function update(patch) {
            if (!mounted.current || controller.signal.aborted || requestId !== serial.current) return
            setMessages(function (items) { return items.map(function (item) { if (item.id !== answerId) return item; return Object.assign({}, item, typeof patch === 'function' ? patch(item) : patch) }) })
          }
          let done = false
          try {
            const response = await fetch(ORIGIN + bookRoute(props.bookId, '/kb/ask'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: question, history: history }), signal: controller.signal })
            if (!response.ok) { const data = await response.json().catch(function () { return null }); throw new Error(data && data.error && data.error.message || t('error.requestFailed')) }
            if (!response.body) throw new Error(t('error.requestFailed'))
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            const parser = createSseParser(function (payload) {
              if (payload.type === 'delta') update(function (item) { return { content: item.content + asString(payload.text) } })
              else if (payload.type === 'progress') update({ progress: asString(payload.message) })
              else if (payload.type === 'meta') update({ sources: Array.isArray(payload.sources) ? payload.sources : [], retrieval: payload.retrieval })
              else if (payload.type === 'done') { done = true; update({ status: 'done' }) }
              else if (payload.type === 'error') { done = true; update({ status: 'error', error: asString(payload.message) || t('error.requestFailed') }) }
            })
            while (!controller.signal.aborted) { const chunk = await reader.read(); if (chunk.done) break; parser.push(decoder.decode(chunk.value, { stream: true })) }
            parser.push(decoder.decode()); parser.flush()
            if (!done && !controller.signal.aborted) update({ status: 'error', error: t('books.askInterrupted') })
          } catch (err) {
            if (!controller.signal.aborted) update({ status: 'error', error: errorMessage(err, t('error.requestFailed')) })
          } finally { if (mounted.current && requestId === serial.current) { setBusy(false); controllerRef.current = null } }
        }
        return h('div', { className: 'kb-book-ask-inner' },
          messages.length ? h('div', { className: 'kb-book-ask-head' },
            h('p', { className: 'kb-graph-copy' }, t('books.askScope')),
            h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', disabled: busy, onClick: function () {
              setMessages([])
              if (inputRef.current) inputRef.current.focus({ preventScroll: true })
            } }, t('ask.clear')),
          ) : null,
          h('div', { ref: scrollRef, className: 'kb-book-messages', onScroll: function () { const el = scrollRef.current; if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 } },
            !messages.length ? h(EmptyBlock, { t: t, title: t('books.askEmpty'), hint: t(props.enabled ? 'books.askHint' : 'books.askNeedsExtraction'), icon: h(AskIcon, { size: 19 }) }) : messages.map(function (message) { return h('article', { key: message.id, className: 'kb-msg' + (message.role === 'user' ? ' kb-msg-user' : '') },
              message.role === 'user' ? h('div', { className: 'kb-msg-user-bubble' }, message.content) : h('div', { className: 'kb-msg-body' }, message.content ? h(MarkdownBlock, { source: message.content, t: t, citations: message.sources, onOpenPath: props.onOpenPage }) : message.status === 'streaming' ? h('p', { role: 'status' }, message.progress || t('ask.thinking')) : null,
                message.retrieval && Array.isArray(message.retrieval.warnings) ? message.retrieval.warnings.map(function (warning, i) { return h('p', { key: 'warning-' + i, className: 'kb-graph-copy', role: 'status' }, warning) }) : null,
                message.status === 'error' ? h('p', { className: 'kb-inline-error', role: 'alert' }, message.error) : null,
                message.status === 'stopped' ? h('p', { className: 'kb-graph-copy' }, t('books.askStopped')) : null,
                (message.sources || []).length ? h('div', { className: 'kb-refs' }, message.sources.map(function (source) { return h('button', { key: source.path, type: 'button', className: 'kb-ref-chip', onClick: function () { props.onOpenPage(source.path) } }, (source.citation ? '[' + source.citation + '] ' : '') + source.title) })) : null,
              ),
            ) }),
          ),
          renderQuestionComposer({
            t, inputRef, inputId: 'kb-book-question', className: 'kb-book-question',
            value: input, onChange: setInput, onSend: send, busy, disabled: !props.enabled,
            label: t('books.askLabel'), placeholder: t('books.askPlaceholder'), keys: t('books.askKeys'), stopLabel: t('books.stopAnswer'),
            onStop: function () {
              stop()
              if (inputRef.current) inputRef.current.focus({ preventScroll: true })
            },
          }),
        )
      }

      function readingCitationPath(citation) {
        return 'book-chapters/' + citation.chapterId + '.md#evidence=' + citation.startChar + '-' + citation.endChar + '-' + citation.sourceHash
      }

      function ReadingDiagram(props) {
        const t = props.t
        const diagram = props.diagram
        const nodes = diagram.nodes || []
        const [focusOnly, setFocusOnly] = useState(false)
        const [expanded, setExpanded] = useState(false)
        const detailHeading = useRef(null), expandedHeading = useRef(null), pendingFocus = useRef(false)
        const selected = nodes.find(function (node) { return node.id === props.selectedId }) || nodes[0]
        useEffect(function () {
          if (!pendingFocus.current) return
          pendingFocus.current = false
          const target = expanded ? expandedHeading.current : detailHeading.current
          if (target) target.focus({ preventScroll: true })
        }, [selected && selected.id, expanded])
        if (!nodes.length) return h('p', { className: 'kb-graph-copy' }, t('reading.noDiagrams'))
        const edges = (diagram.edges || []).filter(function (edge) { return nodes.some(function (node) { return node.id === edge.from }) && nodes.some(function (node) { return node.id === edge.to }) })
        const related = selected ? edges.filter(function (edge) { return edge.from === selected.id || edge.to === selected.id }) : []
        const connectedIds = new Set(selected ? [selected.id] : [])
        related.forEach(function (edge) { connectedIds.add(edge.from); connectedIds.add(edge.to) })
        const visibleNodes = focusOnly ? nodes.filter(function (node) { return connectedIds.has(node.id) }) : nodes
        const visibleEdges = focusOnly ? related : edges
        const positions = {}
        let height = 650
        if (focusOnly && selected) {
          const incoming = visibleNodes.filter(function (node) { return node.id !== selected.id && related.some(function (edge) { return edge.from === node.id && edge.to === selected.id }) })
          const outgoing = visibleNodes.filter(function (node) { return node.id !== selected.id && !incoming.includes(node) })
          height = Math.max(260, Math.max(incoming.length, outgoing.length) * 128 + 70)
          positions[selected.id] = { x: 450, y: height / 2 }
          ;[incoming, outgoing].forEach(function (group, side) { group.forEach(function (node, index) { positions[node.id] = { x: side ? 775 : 125, y: height * (index + 1) / (group.length + 1) } }) })
        } else if (diagram.kind === 'flow' || diagram.kind === 'causal') {
          const ranks = {}; nodes.forEach(function (node) { ranks[node.id] = 0 })
          let changed = false
          for (let pass = 0; pass < nodes.length; pass++) {
            changed = false
            edges.forEach(function (edge) { if (ranks[edge.to] <= ranks[edge.from]) { ranks[edge.to] = ranks[edge.from] + 1; changed = true } })
            if (!changed) break
          }
          if (changed) nodes.forEach(function (node, index) { ranks[node.id] = index })
          const levels = Array.from(new Set(nodes.map(function (node) { return ranks[node.id] }))).sort(function (a, b) { return a - b })
          const horizontal = levels.length <= 3
          height = horizontal ? Math.max(340, Math.max.apply(null, levels.map(function (rank) { return nodes.filter(function (node) { return ranks[node.id] === rank }).length })) * 140 + 70) : Math.max(300, levels.length * 138 + 30)
          levels.forEach(function (rank, row) {
            const group = nodes.filter(function (node) { return ranks[node.id] === rank })
            group.forEach(function (node, column) { positions[node.id] = horizontal
              ? { x: 125 + row * 650 / Math.max(1, levels.length - 1), y: height * (column + 1) / (group.length + 1) }
              : { x: 900 * (column + 1) / (group.length + 1), y: 70 + row * 138 } })
          })
        } else {
          // A ring avoids inventing a hierarchy by placing the first concept at the center.
          height = nodes.length <= 3 ? 380 : 650
          nodes.forEach(function (node, index) {
            const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(1, nodes.length)
            positions[node.id] = nodes.length === 1 ? { x: 450, y: height / 2 } : nodes.length === 2
              ? { x: 230 + index * 440, y: height / 2 }
              : { x: 450 + 325 * Math.cos(angle), y: height / 2 + (height / 2 - 70) * Math.sin(angle) }
          })
        }
        function select(id, moveFocus) { pendingFocus.current = !!moveFocus; props.onSelect(id) }
        function legend() { return h('div', { className: 'kb-reading-map-legend' }, h('span', null, h('i', { 'aria-hidden': true }), t('reading.author')), h('span', null, h('i', { className: 'is-inference', 'aria-hidden': true }), t('reading.inference'))) }
        function canvas(large) {
          const markerId = 'kb-reading-arrow-' + diagram.id + (large ? '-large' : '-inline')
          return h('div', { className: 'kb-reading-diagram-scroll' + (large ? ' is-expanded' : ''), tabIndex: 0, role: 'region', 'aria-label': diagram.title },
            h('svg', { viewBox: '0 0 900 ' + height, role: 'group', 'aria-label': diagram.title + ' · ' + t('reading.diagramHint') },
              h('defs', null, h('marker', { id: markerId, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' }, h('path', { d: 'M0,0 L8,4 L0,8 Z', fill: 'context-stroke' }))),
              visibleEdges.map(function (edge, index) {
                const from = positions[edge.from], to = positions[edge.to]
                const dx = to.x - from.x, dy = to.y - from.y
                const distance = Math.max(1, Math.hypot(dx, dy))
                const crossesNode = visibleNodes.some(function (node) {
                  if (node.id === edge.from || node.id === edge.to) return false
                  const point = positions[node.id]
                  const along = ((point.x - from.x) * dx + (point.y - from.y) * dy) / (distance * distance)
                  return along > 0 && along < 1 && Math.abs(from.x + dx * along - point.x) < 115 && Math.abs(from.y + dy * along - point.y) < 58
                })
                let control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
                if (crossesNode) {
                  const offset = { x: -dy / distance * 260, y: dx / distance * 260 }
                  const forward = control.x + offset.x > 50 && control.x + offset.x < 850 && control.y + offset.y > 45 && control.y + offset.y < height - 45
                  control = { x: control.x + offset.x * (forward ? 1 : -1), y: control.y + offset.y * (forward ? 1 : -1) }
                }
                function clip(point, toward) {
                  const x = toward.x - point.x, y = toward.y - point.y
                  const ratio = Math.min(Math.abs(x) > 0 ? 101 / Math.abs(x) : Infinity, Math.abs(y) > 0 ? 47 / Math.abs(y) : Infinity, .8)
                  return { x: point.x + x * ratio, y: point.y + y * ratio }
                }
                const start = clip(from, control), end = clip(to, control)
                const labelX = (start.x + end.x) / 4 + control.x / 2
                const labelY = (start.y + end.y) / 4 + control.y / 2 - 8
                const labelChars = Array.from(edge.label), labelLines = []
                for (let i = 0; i < labelChars.length; i += 10) labelLines.push(labelChars.slice(i, i + 10).join(''))
                const active = selected && (edge.from === selected.id || edge.to === selected.id)
                return h('g', { key: 'edge-' + index, className: 'kb-reading-edge', 'data-active': !!active, 'aria-hidden': true },
                  h('path', { d: 'M' + start.x + ',' + start.y + ' Q' + control.x + ',' + control.y + ' ' + end.x + ',' + end.y, fill: 'none', stroke: active ? 'var(--kb-accent)' : 'var(--kb-ink-secondary)', strokeWidth: active ? 2 : 1.2, strokeDasharray: edge.perspective === 'inference' ? '5 4' : undefined, markerEnd: 'url(#' + markerId + ')' }),
                  h('text', { textAnchor: 'middle', className: 'kb-reading-edge-label' }, labelLines.map(function (line, lineIndex) { return h('tspan', { key: lineIndex, x: labelX, y: labelY + (lineIndex - (labelLines.length - 1) / 2) * 15 }, line) })),
                )
              }),
              visibleNodes.map(function (node) {
                const position = positions[node.id]
                const chars = Array.from(node.label)
                const lines = []; for (let i = 0; i < chars.length; i += 12) lines.push(chars.slice(i, i + 12).join(''))
                return h('g', { key: node.id, transform: 'translate(' + position.x + ',' + position.y + ')', className: 'kb-reading-node', role: 'button', tabindex: 0,
                  'aria-label': node.label, 'aria-pressed': selected && node.id === selected.id, onClick: function () { select(node.id) },
                  onKeyDown: function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.id) } } },
                  h('title', null, node.label + '\n' + node.detail),
                  h('rect', { x: -98, y: -44, width: 196, height: 88, rx: 12 }),
                  h('text', { textAnchor: 'middle' }, lines.slice(0, 3).map(function (line, i) { return h('tspan', { key: i, x: 0, y: -7 + (i - (Math.min(lines.length, 3) - 1) / 2) * 17 }, line) })),
                  h('text', { textAnchor: 'middle', className: 'kb-reading-node-caption', x: 0, y: 30 }, t('reading.nodeNumber', { n: nodes.indexOf(node) + 1 }) + ' · ' + t('reading.nodeSections', { n: (node.unitIds || []).length })),
                )
              }),
            ),
          )
        }
        function connections() {
          return h('section', { className: 'kb-reading-connections' }, h('h6', null, t('reading.connected', { n: related.length })),
            !related.length ? h('p', { className: 'kb-graph-copy' }, t('reading.noConnections')) : related.map(function (edge, index) {
              const from = nodes.find(function (node) { return node.id === edge.from }), to = nodes.find(function (node) { return node.id === edge.to })
              const neighbor = edge.from === selected.id ? to : from
              return h('button', { key: index, type: 'button', className: 'kb-reading-connection', onClick: function () { select(neighbor.id, true) }, 'aria-label': t('reading.followNode', { title: neighbor.label }) },
                h('span', { className: 'kb-reading-connection-path' }, from.label + ' → ' + edge.label + ' → ' + to.label),
                h('span', { className: 'kb-reading-connection-meta' }, t(edge.perspective === 'inference' ? 'reading.inference' : 'reading.author') + ' · ' + t('reading.followNode', { title: neighbor.label })),
              )
            }),
          )
        }
        return h('div', { className: 'kb-reading-diagram' },
          h('div', { className: 'kb-reading-map-toolbar' },
            h('div', { className: 'kb-reading-map-modes', role: 'group', 'aria-label': t('reading.mapScope') },
              h('button', { type: 'button', className: 'kb-btn kb-btn-sm', 'aria-pressed': !focusOnly, 'data-active': !focusOnly, onClick: function () { setFocusOnly(false) } }, t('reading.wholeMap')),
              h('button', { type: 'button', className: 'kb-btn kb-btn-sm', 'aria-pressed': focusOnly, 'data-active': focusOnly, onClick: function () { setFocusOnly(true) } }, t('reading.localMap'))),
            h('button', { type: 'button', className: 'kb-btn kb-btn-sm', 'aria-haspopup': 'dialog', onClick: function (event) { if (event && event.currentTarget) event.currentTarget.focus({ preventScroll: true }); setExpanded(true) } }, h(FitIcon, { size: 14 }), t('reading.expandMap')),
          ),
          legend(), canvas(false),
          h('p', { className: 'kb-reading-map-hint' }, t('reading.diagramHint')),
          h('div', { className: 'kb-reading-node-buttons', role: 'group', 'aria-label': t('reading.nodes') }, nodes.map(function (node, index) { return h('button', { key: node.id, type: 'button', className: 'kb-graph-chip', 'aria-pressed': selected && selected.id === node.id, 'data-active': selected && selected.id === node.id, onClick: function () { select(node.id) } }, h('span', { className: 'kb-reading-node-number', 'aria-hidden': true }, String(index + 1).padStart(2, '0')), node.label) })),
          selected ? h('section', { className: 'kb-reading-node-detail', key: selected.id },
            h('header', { 'aria-live': 'polite', 'aria-atomic': true }, h('p', { className: 'kb-reading-node-eyebrow' }, t('reading.nodeNumber', { n: nodes.indexOf(selected) + 1 }) + ' / ' + nodes.length), h('h5', { ref: detailHeading, tabIndex: -1 }, selected.label), h('p', { className: 'kb-reading-node-explanation' }, selected.detail)),
            connections(), props.renderStudy ? props.renderStudy(selected) : null,
            props.renderSources ? props.renderSources(selected.unitIds || []) : null,
          ) : null,
          h('details', { className: 'kb-reading-relations' }, h('summary', null, t('reading.relations')), h('ul', null, edges.map(function (edge, index) {
            const from = nodes.find(function (node) { return node.id === edge.from }), to = nodes.find(function (node) { return node.id === edge.to })
            return h('li', { key: index }, from.label + ' → ' + edge.label + ' → ' + to.label, ' · ' + t(edge.perspective === 'inference' ? 'reading.inference' : 'reading.author'))
          }))),
          expanded ? h('div', { className: 'kb-reading-map-modal' }, h(KbModal, { t: t, title: diagram.title, description: t('reading.diagramHint'), wide: true, onClose: function () { setExpanded(false) },
            footer: h('button', { type: 'button', className: 'kb-btn', onClick: function () { setExpanded(false) } }, t('reading.collapseMap')) },
            legend(), canvas(true), selected ? h('div', { className: 'kb-reading-expanded-note', 'aria-live': 'polite' }, h('h3', { ref: expandedHeading, tabIndex: -1 }, selected.label), h('p', null, selected.detail), connections()) : null,
          )) : null,
        )
      }
      function BookReading(props) {
        const t = props.t
        const [analysis, setAnalysis] = useState(null)
        const [error, setError] = useState('')
        const [busy, setBusy] = useState(false)
        const [view, setView] = useState('read')
        const [query, setQuery] = useState('')
        const [allCards, setAllCards] = useState(false)
        const [cardLimit, setCardLimit] = useState(48)
        const [expandedCardId, setExpandedCardId] = useState('')
        const [diagramId, setDiagramId] = useState('')
        const [nodeId, setNodeId] = useState('')
        const alive = useRef(true), loading = useRef(null), action = useRef(null)
        async function load() {
          if (loading.current) loading.current.abort()
          const controller = new AbortController(); loading.current = controller
          try {
            const result = await props.request('/analysis', { signal: controller.signal })
            if (alive.current && !controller.signal.aborted) { setAnalysis(function (previous) { return previous && previous.updatedAt > result.analysis.updatedAt ? previous : result.analysis }); setError('') }
          } catch (err) { if (alive.current && !controller.signal.aborted) setError(errorMessage(err, t('error.requestFailed'))) }
        }
        useEffect(function () { alive.current = true; return function () { alive.current = false; if (loading.current) loading.current.abort(); if (action.current) action.current.abort() } }, [])
        useEffect(function () { if (props.active) load() }, [props.active])
        useEffect(function () {
          if (!props.active || !analysis || analysis.status !== 'running') return undefined
          const timer = setInterval(load, 2000); return function () { clearInterval(timer) }
        }, [props.active, analysis && analysis.status])
        useEffect(function () { setCardLimit(48) }, [query, allCards])
        useEffect(function () { if (!props.active || view !== 'cards') setExpandedCardId('') }, [props.active, view])
        async function run(pause) {
          if (busy) return
          setBusy(true); setError('')
          if (loading.current) loading.current.abort()
          const controller = new AbortController(); action.current = controller
          try {
            const result = await props.request('/analysis/' + (pause ? 'pause' : 'start'), { method: 'POST', signal: controller.signal })
            if (alive.current && !controller.signal.aborted) setAnalysis(result.analysis)
          } catch (err) { if (alive.current && !controller.signal.aborted) setError(errorMessage(err, t('error.requestFailed'))) }
          finally { if (alive.current) setBusy(false) }
        }
        if (!analysis) return error ? h(ErrorBlock, { t: t, text: error, onRetry: load }) : h(LoadingBlock, { t: t, text: t('books.loading') })
        const units = analysis.units || []
        const synthesis = analysis.synthesis
        const running = analysis.status === 'running'
        const ready = analysis.status === 'ready'
        const sourceCoverage = analysis.coverage || props.book.coverage
        const excludedChapters = analysis.excludedChapters || []
        const excludedPassages = analysis.excludedPassages || []
        const cards = units.reduce(function (all, unit) { return all.concat(unit.cards || []) }, [])
        const selectedCards = synthesis && synthesis.coreCardIds && synthesis.coreCardIds.length ? cards.filter(function (card) { return synthesis.coreCardIds.indexOf(card.id) >= 0 }) : cards
        const term = query.trim().toLowerCase()
        const visibleCards = (allCards || term ? cards : selectedCards).filter(function (card) { return !term || (card.title + ' ' + card.explanation + ' ' + card.chapterTitle).toLowerCase().indexOf(term) >= 0 })
        const expandedCard = cards.find(function (card) { return card.id === expandedCardId })
        const diagrams = synthesis ? synthesis.diagrams || [] : []
        const diagram = diagrams.find(function (item) { return item.id === diagramId }) || diagrams.find(function (item) { return item.kind === 'map' }) || diagrams[0]
        function citations(items) {
          return h('div', { className: 'kb-reading-citations' }, items.map(function (citation, index) { return h('button', { key: citation.chapterId + '-' + citation.startChar + '-' + index, type: 'button', className: 'kb-linkbtn', title: citation.quote,
            onClick: function (event) { if (event && event.currentTarget) event.currentTarget.focus({ preventScroll: true }); props.onOpenSource(readingCitationPath(citation)) } }, citation.chapterTitle + ' · ' + t('reading.source') + ' ' + (index + 1)) }))
        }
        function cardSources(card) {
          const unit = units.find(function (item) { return item.id === card.unitId })
          return (unit ? unit.citations || [] : []).filter(function (citation) { return (card.citationIds || []).indexOf(citation.id) >= 0 })
        }
        function cardMeta(card) { return card.chapterTitle + (card.perspective === 'inference' ? ' · ' + t('reading.inference') : '') }
        function closeCard() { setExpandedCardId('') }
        function unitSources(ids) {
          const sources = units.filter(function (unit) { return ids.indexOf(unit.id) >= 0 }).reduce(function (all, unit) { return all.concat(unit.citations || []) }, [])
          return h('details', { className: 'kb-reading-sources' }, h('summary', null, t('reading.sources', { n: sources.length })), citations(sources))
        }
        function nodeStudy(node) {
          const ids = new Set(node.unitIds || [])
          const linked = units.filter(function (unit) { return ids.has(unit.id) })
          const seen = new Set()
          const linkedCards = linked.reduce(function (all, unit) { return all.concat(unit.cards || []) }, []).filter(function (card) { if (seen.has(card.id)) return false; seen.add(card.id); return true })
          if (!linked.length) return h('p', { className: 'kb-graph-copy' }, t('reading.studyUnavailable'))
          return h('div', { className: 'kb-reading-node-study' },
            linkedCards.length ? h('section', { className: 'kb-reading-study-cards' },
              h('h6', null, t('reading.sameSectionCards', { n: linkedCards.length })), h('p', { className: 'kb-reading-study-hint' }, t('reading.sameSectionHint')),
              linkedCards.map(function (card, index) { const sources = cardSources(card); return h('details', { key: card.id, className: 'kb-reading-study-card', open: index === 0 },
                h('summary', null, h('span', { className: 'kb-reading-study-card-title' }, card.title), h('span', { className: 'kb-reading-study-card-preview' }, cleanSearchSnippet(card.explanation, 100))),
                h('div', { className: 'kb-reading-study-card-body' }, h('p', { className: 'kb-reading-study-meta' }, cardMeta(card)), h(MarkdownBlock, { source: card.explanation, t: t }),
                  card.example ? h('section', null, h('h6', null, t('reading.example')), h('p', null, card.example)) : null,
                  card.boundary ? h('section', null, h('h6', null, t('reading.boundary')), h('p', null, card.boundary)) : null,
                  sources.length ? h('details', { className: 'kb-reading-sources' }, h('summary', null, t('reading.sources', { n: sources.length })), citations(sources)) : null),
              ) }),
            ) : null,
            h('section', { className: 'kb-reading-study-chapters' }, h('h6', null, t('reading.deepReading', { n: linked.length })), linked.map(function (unit) { return h('details', { key: unit.id, className: 'kb-reading-chapter' },
              h('summary', null, unit.title + (unit.part > 1 ? ' · ' + unit.part : '')), h('h5', null, unit.question), h('p', { className: 'kb-reading-chapter-thesis' }, unit.thesis), h(MarkdownBlock, { source: unit.narrative, t: t }), citations(unit.citations || []),
            ) })),
          )
        }
        return h('div', { className: 'kb-reading-inner' },
          h('div', { className: 'kb-reading-toolbar' },
            h('div', null, h('h3', null, t('reading.title')), h('p', { className: 'kb-graph-copy' }, synthesis ? t('reading.stats', { minutes: synthesis.readingMinutes, cards: cards.length, diagrams: diagrams.length }) : t('reading.promise'))),
            !ready ? h('button', { type: 'button', className: 'kb-btn kb-btn-primary', disabled: busy, onClick: function () { run(running) } }, t(busy ? 'books.actionWorking' : running ? 'reading.pause' : analysis.status === 'empty' || analysis.status === 'stale' ? 'reading.start' : 'reading.resume')) : null,
          ),
          h('div', { className: 'kb-reading-coverage' },
            h('p', null, t('reading.scope', { n: props.book.chapters.length, chars: Number(props.book.coverage.extractedChars || 0).toLocaleString() })),
            typeof analysis.totalChapters === 'number' ? h('p', null, t('reading.selected', { n: analysis.totalChapters })) : null,
            excludedChapters.length || excludedPassages.length ? h('details', { className: 'kb-reading-sources' },
              h('summary', null, [excludedChapters.length ? t('reading.excluded.sections', { n: excludedChapters.length }) : '', excludedPassages.length ? t('reading.excluded.passages', { n: excludedPassages.length }) : ''].filter(Boolean).join('；')),
              h('p', null, t('reading.excluded.original')),
              h('ul', null, excludedChapters.map(function (chapter) { return h('li', { key: chapter.id }, chapter.title + ' · ' + t('reading.reason.' + chapter.reason)) }),
                excludedPassages.map(function (passage, index) { return h('li', { key: passage.chapterId + '-' + index }, passage.title + ' · ' + t('reading.reason.' + passage.reason)) })),
            ) : null,
            sourceCoverage.coverageComplete !== true ? h('details', null, h('summary', null, t('reading.parseNotes')), h('p', { className: 'kb-reading-source-note' }, t('reading.partialSource'))) : h('p', { className: 'kb-graph-copy' }, t('reading.textScope')),
          ),
          analysis.status !== 'empty' ? h('div', { className: 'kb-reading-progress' },
            h('p', { role: 'status', 'aria-live': running ? 'off' : 'polite' }, analysis.stage || '', analysis.totalUnits ? ' · ' + t('reading.progress', { n: analysis.completedUnits, total: analysis.totalUnits }) : ''),
            running ? h('progress', { value: analysis.completedUnits, max: Math.max(1, analysis.totalUnits + 1), 'aria-label': t('reading.progressLabel') }) : null,
          ) : null,
          error || analysis.error ? h('p', { className: 'kb-inline-error', role: 'alert' }, error || analysis.error) : null,
          !units.length ? h('div', { className: 'kb-reading-welcome' },
            h('p', null, t('reading.intro')),
            h('div', { className: 'kb-reading-preview' }, ['read', 'cards', 'diagrams'].map(function (id) { return h('div', { key: id }, h('h4', null, t('reading.view.' + id)), h('p', null, t('reading.preview.' + id))) })),
            h('p', { className: 'kb-graph-copy' }, t('reading.resumeHint')),
          ) : h(React.Fragment, null,
            h('div', { className: 'kb-reading-views', role: 'group', 'aria-label': t('reading.views') }, ['read', 'cards', 'diagrams'].map(function (id) { return h('button', { key: id, type: 'button', className: 'kb-btn kb-btn-sm', 'aria-pressed': view === id, 'data-active': view === id, onClick: function () { setView(id) } }, t('reading.view.' + id)) })),
            view === 'read' ? h('div', { className: 'kb-reading-prose' },
              synthesis ? h(React.Fragment, null,
                h('section', { className: 'kb-reading-thesis' }, h('h4', null, synthesis.question), h('p', null, synthesis.thesis)),
                synthesis.sections.map(function (section, index) { return h('section', { key: index, className: 'kb-reading-section' }, h('h4', null, section.title), h(MarkdownBlock, { source: section.body, t: t }), unitSources(section.unitIds)) }),
              ) : h('p', { className: 'kb-graph-copy' }, t('reading.synthesisPending')),
              h('h4', { className: 'kb-reading-chapter-title' }, t('reading.chapterReading')),
              units.map(function (unit) { return h('details', { key: unit.id, className: 'kb-reading-chapter' }, h('summary', null, unit.title + (unit.part > 1 ? ' · ' + unit.part : '')), h('h5', null, unit.question), h('p', { className: 'kb-reading-chapter-thesis' }, unit.thesis), h(MarkdownBlock, { source: unit.narrative, t: t }), citations(unit.citations)) }),
            ) : null,
            view === 'cards' ? h('div', null,
              h('div', { className: 'kb-reading-card-controls' }, h('label', null, h('span', null, t('reading.searchCards')), h('input', { className: 'kb-input', type: 'search', value: query, maxLength: 200, placeholder: t('reading.searchPlaceholder'), onChange: function (event) { setQuery(event.target.value) } })),
                h('label', { className: 'kb-reading-checkbox' }, h('input', { type: 'checkbox', checked: allCards, onChange: function (event) { setAllCards(event.target.checked) } }), t('reading.allCards', { n: cards.length }))),
              !visibleCards.length ? h('p', { className: 'kb-graph-copy' }, t('reading.noCards')) : null,
              h('div', { className: 'kb-reading-cards' }, visibleCards.slice(0, cardLimit).map(function (card) {
                return h('button', { key: card.id, type: 'button', className: 'kb-reading-card', 'aria-haspopup': 'dialog', 'aria-label': t('reading.openCard', { title: card.title }), title: card.title,
                  onClick: function (event) {
                    // macOS pointer clicks do not always focus buttons; preserve the exact trigger for modal return.
                    if (event && event.currentTarget) event.currentTarget.focus({ preventScroll: true })
                    setExpandedCardId(card.id)
                  } },
                  h('span', { className: 'kb-reading-card-meta' }, cardMeta(card)),
                  h('span', { className: 'kb-reading-card-title' }, card.title),
                  h('span', { className: 'kb-reading-card-preview' }, cleanSearchSnippet(card.explanation, 160)),
                  h('span', { className: 'kb-reading-card-open' }, h(FitIcon, { size: 13 }), t('reading.expandCard')),
                )
              })),
              visibleCards.length > cardLimit ? h('button', { type: 'button', className: 'kb-btn', onClick: function () { setCardLimit(cardLimit + 48) } }, t('graph.more', { n: Math.min(48, visibleCards.length - cardLimit) })) : null,
              expandedCard ? h('div', { className: 'kb-reading-card-modal' }, h(KbModal, { t: t, title: expandedCard.title, description: cardMeta(expandedCard), wide: true, onClose: closeCard,
                footer: h('button', { type: 'button', className: 'kb-btn', onClick: closeCard }, t('reading.collapseCard')) },
                h('article', { className: 'kb-reading-card-full' },
                  h(MarkdownBlock, { source: expandedCard.explanation, t: t }),
                  expandedCard.example ? h('section', { className: 'kb-reading-card-detail' }, h('h3', null, t('reading.example')), h('p', null, expandedCard.example)) : null,
                  expandedCard.boundary ? h('section', { className: 'kb-reading-card-detail' }, h('h3', null, t('reading.boundary')), h('p', null, expandedCard.boundary)) : null,
                  citations(cardSources(expandedCard)),
                ),
              )) : null,
            ) : null,
            view === 'diagrams' ? h('div', { className: 'kb-reading-maps' },
              !diagram ? h('p', { className: 'kb-graph-copy' }, t(synthesis ? 'reading.noDiagrams' : 'reading.synthesisPending')) : h(React.Fragment, null,
                h('div', { className: 'kb-reading-map-tabs', role: 'group', 'aria-label': t('reading.diagrams') }, diagrams.map(function (item) { return h('button', { key: item.id, type: 'button', className: 'kb-graph-chip', 'aria-pressed': item.id === diagram.id, 'data-active': item.id === diagram.id, onClick: function () { setDiagramId(item.id); setNodeId('') } }, h('span', { className: 'kb-reading-map-kind' }, t('reading.kind.' + item.kind)), h('span', { className: 'kb-reading-map-title' }, item.title), h('span', { className: 'kb-reading-map-count' }, t('reading.mapStats', { nodes: item.nodes.length, edges: item.edges.length }))) })),
                h('h4', null, diagram.title), h('p', { className: 'kb-graph-copy' }, diagram.description),
                h(ReadingDiagram, { key: diagram.id, diagram: diagram, t: t, selectedId: nodeId, onSelect: setNodeId, renderSources: unitSources, renderStudy: nodeStudy }),
              ),
            ) : null,
          ),
        )
      }

      function useBookPage(request, t) {
        const [reader, setReader] = useState(null)
        const pending = useRef(null)
        function cancel() {
          if (pending.current) pending.current.abort()
          pending.current = null
        }
        useEffect(function () {
          setReader(null)
          return cancel
        }, [request])
        function close() {
          cancel()
          setReader(null)
        }
        async function open(path) {
          if (!path) return
          cancel()
          const controller = new AbortController()
          pending.current = controller
          setReader({ status: 'loading', path: path })
          try {
            const result = await request('/kb/page?path=' + encodeURIComponent(path), { signal: controller.signal })
            if (controller.signal.aborted) return
            if (!result.page) throw new Error(t('error.requestFailed'))
            setReader({ status: 'ready', path: path, data: result.page })
          } catch (error) {
            if (!controller.signal.aborted) setReader({ status: 'error', path: path, error: errorMessage(error, t('error.requestFailed')) })
          } finally {
            if (pending.current === controller) pending.current = null
          }
        }
        return { reader: reader, open: open, close: close }
      }

      function isBookOriginal(page) {
        const kind = page.sourceKind || page.type
        return kind === 'chapter' || kind === 'original'
      }

      function BookDetail(props) {
        const ctx = useKb()
        const t = ctx.t
        const [book, setBook] = useState(null)
        const [error, setError] = useState('')
        const [loading, setLoading] = useState(true)
        const [actionBusy, setActionBusy] = useState(false)
        const [mode, setMode] = useState('analysis')
        const [pages, setPages] = useState([])
        const [pagesError, setPagesError] = useState('')
        const [query, setQuery] = useState('')
        const [typeFilter, setTypeFilter] = useState('all')
        const [results, setResults] = useState(null)
        const [searchStatus, setSearchStatus] = useState('idle')
        const [searchError, setSearchError] = useState('')
        const [searchTotal, setSearchTotal] = useState(0)
        const [listLimit, setListLimit] = useState(80)
        const mounted = useRef(true)
        const sourcePaneRef = useRef(null)
        const manifestAbort = useRef(null)
        const pagesAbort = useRef(null)
        const actionAbort = useRef(null)
        const revisionRef = useRef(-1)
        const request = useCallback(function (path, options) { return bookRequest(props.bookId, path, options) }, [props.bookId])
        const knowledgeReader = useBookPage(request, t)
        const sourceReader = useBookPage(request, t)

        async function loadPages() {
          if (pagesAbort.current) pagesAbort.current.abort()
          const controller = new AbortController(); pagesAbort.current = controller
          try {
            const result = await request('/kb/tree', { signal: controller.signal })
            if (!mounted.current || controller.signal.aborted) return
            const all = []
            ;(Array.isArray(result.groups) ? result.groups : []).forEach(function (group) { (group.items || []).forEach(function (item) { all.push(Object.assign({ type: group.type }, item)) }) })
            setPages(all); setPagesError('')
          } catch (err) { if (mounted.current && !controller.signal.aborted) setPagesError(errorMessage(err, t('error.requestFailed'))) }
        }
        async function loadBook() {
          if (manifestAbort.current) manifestAbort.current.abort()
          const controller = new AbortController(); manifestAbort.current = controller
          try {
            const result = await request('', { signal: controller.signal })
            if (!mounted.current || controller.signal.aborted) return
            const next = result.book
            if (!next) throw new Error(t('books.notFound'))
            setBook(function (previous) { return previous && previous.id === next.id && previous.updatedAt > next.updatedAt ? previous : next })
            setError(''); setLoading(false)
            const revision = Number(next.coverage && next.coverage.completedChapters) || 0
            if (revision !== revisionRef.current) { revisionRef.current = revision; loadPages() }
          } catch (err) { if (mounted.current && !controller.signal.aborted) { setError(errorMessage(err, t('error.requestFailed'))); setLoading(false) } }
        }
        useEffect(function () {
          mounted.current = true
          revisionRef.current = -1
          setBook(null); setPages([]); setResults(null); setQuery(''); setTypeFilter('all'); setMode('analysis'); setSearchTotal(0)
          setError(''); setPagesError(''); setLoading(true); setActionBusy(false)
          loadBook()
          return function () {
            mounted.current = false
            ;[manifestAbort, pagesAbort, actionAbort].forEach(function (ref) { if (ref.current) ref.current.abort() })
          }
        }, [props.bookId])
        useEffect(function () {
          if (!book || book.status !== 'running') return undefined
          const timer = setInterval(loadBook, 1400)
          return function () { clearInterval(timer) }
        }, [book && book.status, props.bookId])
        useEffect(function () { setListLimit(80) }, [query, typeFilter, mode])
        useEffect(function () {
          const term = query.trim()
          if (!term) { setResults(null); setSearchTotal(0); setSearchStatus('idle'); setSearchError(''); return undefined }
          const controller = new AbortController()
          setSearchStatus('loading'); setSearchError('')
          const timer = setTimeout(function () {
            request('/kb/search', { method: 'POST', body: { q: term, limit: 100 }, signal: controller.signal }).then(function (result) {
              if (mounted.current && !controller.signal.aborted) { setResults(Array.isArray(result.results) ? result.results : []); setSearchTotal(typeof result.total === 'number' ? result.total : (result.results || []).length); setSearchStatus('ready') }
            }).catch(function (err) { if (mounted.current && !controller.signal.aborted) { setResults([]); setSearchError(errorMessage(err, t('error.requestFailed'))); setSearchStatus('error') } })
          }, 250)
          return function () { clearTimeout(timer); controller.abort() }
        }, [query, props.bookId])

        function openSource(path) {
          // When following a link inside the dialog, keep focus in the dialog while its content loads.
          if (sourcePaneRef.current) sourcePaneRef.current.focus({ preventScroll: true })
          sourceReader.open(path)
        }
        async function extractionAction(pause) {
          if (actionBusy) return
          setActionBusy(true); setError('')
          const controller = new AbortController(); actionAbort.current = controller
          try {
            const result = await request(pause ? '/pause' : '/extract', { method: 'POST', body: {}, signal: controller.signal })
            if (!mounted.current || controller.signal.aborted) return
            if (result.book) setBook(result.book)
            loadBook(); loadPages()
          } catch (err) { if (mounted.current && !controller.signal.aborted) setError(errorMessage(err, t('error.requestFailed'))) }
          finally { if (mounted.current && !controller.signal.aborted) setActionBusy(false) }
        }
        const coverage = book && book.coverage || {}
        const chapters = book && Array.isArray(book.chapters) ? book.chapters : []
        const browsePages = useMemo(function () {
          const chapterOrder = new Map()
          chapters.forEach(function (chapter, index) {
            if (chapter.sourceId) chapterOrder.set(chapter.sourceId, index)
          })
          // Each generated source summary points to its chapter through one source ID.
          function chapterPosition(page) {
            if (page.type !== 'source') return chapters.length
            return chapterOrder.get(page.sources?.[0]) ?? chapters.length
          }
          return pages.slice().sort(function (a, b) { return chapterPosition(a) - chapterPosition(b) })
        }, [chapters, pages])
        const availablePages = (results ?? browsePages).filter(function (page) { return typeFilter === 'all' || page.type === typeFilter })
        if (loading || (book && book.id !== props.bookId)) return h('div', { className: 'kb-books' }, h('button', { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: props.onBack }, t('books.back')), h(LoadingBlock, { t: t, text: t('books.loading') }))
        if (!book) return h('div', { className: 'kb-books' }, h('button', { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: props.onBack }, t('books.back')), h(ErrorBlock, { t: t, text: error || t('books.notFound'), onRetry: loadBook }))
        function changeMode(id) {
          sourceReader.close()
          setMode(id)
          if (id === 'knowledge') loadPages()
        }
        const running = book.status === 'running'
        const extractionLabel = running ? 'books.pause' : book.status === 'imported' ? 'books.extract' : 'books.resume'
        function renderBookPage(reader, openPage) {
          if (!reader) return h(EmptyBlock, { t: t, title: t('books.chooseKnowledge'), hint: t('books.knowledgeHint'), icon: h(FileIcon, { size: 26 }) })
          if (reader.status === 'loading') return h(LoadingBlock, { t: t, text: t('books.reading') })
          if (reader.status === 'error') return h(ErrorBlock, { t: t, text: reader.error, onRetry: function () { openPage(reader.path) } })
          const page = reader.data
          const original = isBookOriginal(page)
          const sources = original ? [] : (page.sourceRefs || []).map(function (ref) {
            return chapters.find(function (chapter) { return chapter.sourceId === ref.id })
          }).filter(Boolean)
          const wikiMap = new Map()
          for (const link of page.links || []) {
            wikiMap.set(link.title, link)
            wikiMap.set(asString(link.title).toLowerCase(), link)
          }
          return h('article', null,
            h('div', { className: 'kb-book-reader-meta' }, h('span', { className: 'kb-badge' }, t(original ? 'books.originalChapter' : 'books.knowledgePage')), original ? null : h(ConfidenceBadge, { t: t, confidence: page.confidence })),
            h('h3', { className: 'kb-page-title' }, page.title),
            page.parentPath ? h('div', { className: 'kb-page-edited' },
              h('span', null, t(original ? 'page.evidenceLines' : 'books.knowledgeEvidenceLines', { start: page.startLine, end: page.endLine })),
              h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { openPage(page.parentPath) } }, t('page.fullText')),
            ) : null,
            original ? h('pre', { className: 'kb-book-original', tabIndex: 0 }, page.originalText)
              : h(MarkdownBlock, { source: page.markdown || '', t: t, wikiMap: wikiMap, onOpenPath: openPage }),
            sources.length ? h('div', { className: 'kb-book-reading-sources' }, h('h4', null, t('books.chapterSources')),
              sources.map(function (chapter) {
                return h('button', { key: chapter.id, type: 'button', className: 'kb-linkbtn', onClick: function () { openSource('book-chapters/' + chapter.id + '.md') } }, chapter.title)
              }),
            ) : null,
          )
        }
        const source = sourceReader.reader
        return h('div', { className: 'kb-book-detail' },
          h('header', { className: 'kb-book-detail-head' },
            h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: props.onBack }, h(ArrowLeftIcon, { size: 13 }), t('books.back')),
            h('div', { className: 'kb-book-titles' }, h('h2', { className: 'kb-overview-title' }, book.title || book.name)),
            h('div', { className: 'kb-books-actions' },
              h('a', { className: 'kb-btn kb-btn-sm', href: ORIGIN + bookRoute(props.bookId, '/original'), target: '_blank', rel: 'noreferrer' }, t('books.originalFile')),
              mode !== 'analysis' && book.status !== 'ready' ? h('button', { type: 'button', className: 'kb-btn', disabled: actionBusy || chapters.length === 0, onClick: function () { extractionAction(running) } }, t(actionBusy ? 'books.actionWorking' : extractionLabel)) : null,
            ),
          ),
          h('div', { className: 'kb-book-summary', hidden: mode === 'analysis' },
            h(BookProgress, { t: t, book: book },
              h('p', { className: 'kb-graph-copy' }, t('books.extractionHint', { chars: Number(coverage.extractedChars || 0).toLocaleString() }), ' ', t('books.isolatedScope')),
              (book.warnings || []).length ? h('details', { className: 'kb-book-warnings' },
                h('summary', null, t('books.warnings', { n: book.warnings.length })),
                h('ul', null, book.warnings.map(function (warning, index) { return h('li', { key: index }, warning) })),
              ) : null,
            ),
            running ? h('p', { className: 'kb-graph-copy', role: 'status' }, t('books.currentChapter', { title: (chapters.find(function (chapter) { return chapter.id === book.currentChapterId }) || {}).title || book.stage }), book.stage ? ' · ' + book.stage : '') : null,
            error || book.error ? h('p', { className: 'kb-inline-error', role: 'alert' }, error || book.error) : null,
          ),
          h('div', { className: 'kb-book-modes', role: 'group', 'aria-label': t('books.contentLabel') }, ['analysis', 'knowledge', 'ask'].map(function (id) { return h('button', { key: id, type: 'button', className: 'kb-graph-chip', 'data-active': mode === id, 'aria-pressed': mode === id, onClick: function () { changeMode(id) } }, t('books.mode.' + id)) })),
          h('section', { className: 'kb-reading', hidden: mode !== 'analysis', 'aria-label': t('reading.title') }, h(BookReading, { key: props.bookId, book: book, t: t, request: request, active: mode === 'analysis', onOpenSource: openSource })),
          source ? h(KbModal, { t: t, title: t('books.citation'), wide: true, onClose: sourceReader.close },
            h('div', { ref: sourcePaneRef, className: 'kb-book-reader', tabIndex: -1 }, renderBookPage(source, openSource)),
          ) : null,
          h('div', { className: 'kb-book-workspace', hidden: mode !== 'knowledge' },
            h('nav', { className: 'kb-book-nav', 'aria-label': t('books.mode.knowledge') },
                h('label', { className: 'kb-form-label', htmlFor: 'kb-book-search' }, t('books.searchLabel')),
                h('input', { id: 'kb-book-search', className: 'kb-input', type: 'search', value: query, maxLength: 200, placeholder: t('books.searchPlaceholder'), onChange: function (event) { setQuery(event.target.value) } }),
                h('select', { className: 'kb-select', value: typeFilter, 'aria-label': t('books.pageType'), onChange: function (event) { setTypeFilter(event.target.value) } }, ['all', 'chapter', 'topic', 'entity', 'synthesis', 'source'].map(function (type) { return h('option', { key: type, value: type }, type === 'all' ? t('books.allPages') : pageTypeLabel(t, type)) })),
                searchStatus === 'loading' ? h('p', { role: 'status', className: 'kb-graph-copy' }, t('search.busy')) : null,
                results && searchTotal > results.length ? h('p', { className: 'kb-graph-copy', role: 'status' }, t('books.searchLimited', { total: searchTotal, shown: results.length })) : null,
                pagesError || searchError ? h('p', { role: 'alert', className: 'kb-inline-error' }, pagesError || searchError) : null,
                !availablePages.length && searchStatus !== 'loading' ? h('p', { className: 'kb-graph-copy' }, t(pages.length ? 'books.noMatches' : 'books.noKnowledge')) : null,
                availablePages.slice(0, listLimit).map(function (page) {
                  const path = page.evidencePath || page.path
                  const openPage = isBookOriginal(page) ? openSource : knowledgeReader.open
                  return h('button', { key: page.path, type: 'button', className: 'kb-book-nav-row', 'aria-current': knowledgeReader.reader?.path === path ? 'page' : undefined, onClick: function () { openPage(path) } },
                    h('span', { className: 'kb-book-nav-title' }, page.title),
                    h('span', { className: 'kb-book-nav-meta' }, pageTypeLabel(t, page.type)),
                    page.snippet ? h('span', { className: 'kb-book-nav-snippet' }, cleanSearchSnippet(page.snippet)) : null,
                  )
                }),
                availablePages.length > listLimit ? h('button', { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setListLimit(listLimit + 80) } }, t('graph.more', { n: Math.min(80, availablePages.length - listLimit) })) : null,
            ),
            h('div', { className: 'kb-book-reader' }, renderBookPage(knowledgeReader.reader, knowledgeReader.open)),
          ),
          h('section', { className: 'kb-book-ask', hidden: mode !== 'ask', 'aria-label': t('books.mode.ask') }, h(BookAsk, { key: props.bookId, bookId: props.bookId, t: t, active: mode === 'ask', enabled: chapters.length > 0, onOpenPage: openSource })),
        )
      }

      function AskView() {
        const ctx = useKb()
        const t = ctx.t
        const messages = Array.isArray(ctx.askMessages) ? ctx.askMessages : []
        const [input, setInput] = useState('')
        const scrollRef = useRef(null)
        const stickRef = useRef(true)
        const busy = !!ctx.askBusy

        // 稳定回调：流式增量时避免重新解析其他消息的 Markdown
        const stableOpenPath = useMemo(function () {
          return function (path) {
            ctx.openPage(path)
          }
        }, [])

        // 新内容到达时：若用户停在底部附近，则自动滚到底部
        useEffect(
          function () {
            const element = scrollRef.current
            if (!element || !stickRef.current) return
            element.scrollTop = element.scrollHeight
          },
          [messages],
        )

        /**
         * 记录用户是否停留在底部附近。
         * @returns {void}
         */
        function handleScroll() {
          const element = scrollRef.current
          if (!element) return
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
        }

        /**
         * 发送当前输入。
         * @returns {void}
         */
        function submit() {
          const question = input.trim()
          if (!question || busy) return
          setInput('')
          stickRef.current = true
          ctx.sendAsk(question)
        }

        return h(
          'div',
          { className: 'kb-ask' },
          h(
            'div',
            { className: 'kb-ask-head' },
            h('div', { className: 'kb-ask-titles' }, h('h2', { className: 'kb-overview-title' }, t('ask.title')), h('span', { className: 'kb-ask-sub' }, t('ask.subtitle'))),
            h('span', { className: 'kb-header-spacer' }),
            h(
              'button',
              { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.clearAsk, disabled: busy || messages.length === 0 },
              h(TrashIcon, { size: 12 }),
              h('span', null, t('ask.clear')),
            ),
          ),
          h(
            'div',
            { ref: scrollRef, className: 'kb-ask-scroll', onScroll: handleScroll },
            messages.length === 0
              ? h('p', { className: 'kb-ask-example' }, t('ask.empty.hint'))
              : messages.map(function (message) {
                  if (!message || typeof message !== 'object') return null
                  if (message.role === 'user') {
                    return h(
                      'div',
                      { key: message.id, className: 'kb-msg kb-msg-user' },
                      h('div', { className: 'kb-msg-role' }, h('span', null, t('ask.you'))),
                      h('div', { className: 'kb-msg-user-bubble' }, asString(message.content)),
                    )
                  }
                  const streaming = message.status === 'streaming'
                  const failed = message.status === 'error'
                  const stopped = message.status === 'stopped'
                  const sources = Array.isArray(message.sources) ? message.sources : []
                  return h(
                    'div',
                    { key: message.id, className: 'kb-msg kb-msg-assistant' },
                    h(
                      'div',
                      { className: 'kb-msg-role' },
                      h('span', { className: 'kb-avatar' }, h(BrandGlyph, { size: 12 })),
                      h('span', null, t('ask.ai')),
                    ),
                    h(
                      'div',
                      { className: 'kb-msg-body' },
                      asString(message.content)
                        ? h(MarkdownBlock, { source: message.content, t: t, onOpenPath: stableOpenPath })
                        : streaming
                          ? h('div', { className: 'kb-msg-thinking' }, h(Spinner, { size: 'sm' }), h('span', { role: 'status' }, message.progress || t('ask.thinking')))
                          : null,
                      streaming ? h('span', { className: 'kb-cursor' }) : null,
                    ),
                    message.retrieval && Array.isArray(message.retrieval.warnings) ? message.retrieval.warnings.map(function (warning, i) { return h('p', { key: 'warning-' + i, className: 'kb-graph-copy', role: 'status' }, warning) }) : null,
                    sources.length > 0
                      ? h(
                          'div',
                          { className: 'kb-refs' },
                          h('span', { className: 'kb-refs-label' }, t('ask.sources')),
                          sources.map(function (source, index) {
                            const sourceTitle = asString(source.title) || t('common.unknown')
                            const sourcePath = asString(source.path)
                            return h(
                              'button',
                              {
                                key: sourcePath || 'ref-' + index,
                                type: 'button',
                                className: 'kb-ref-chip',
                                title: sourcePath ? t('ask.openSource') : sourceTitle,
                                disabled: !sourcePath,
                                onClick: function () {
                                  if (sourcePath) ctx.openPage(sourcePath)
                                },
                              },
                              h(FileIcon, { size: 11 }),
                              h('span', null, (source.citation ? '[' + source.citation + '] ' : '') + sourceTitle),
                            )
                          }),
                        )
                      : message.status === 'done'
                        ? h('div', { className: 'kb-refs' }, h('span', { className: 'kb-refs-empty' }, t('ask.noSources')))
                        : null,
                    failed
                      ? h(
                          'div',
                          { className: 'kb-msg-error' },
                          h('span', { className: 'kb-msg-error-text' }, asString(message.error) || t('ask.failed', { message: t('error.requestFailed') })),
                          h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.retryAsk(message.id) } }, t('ask.retry')),
                        )
                      : stopped
                        ? h('div', { className: 'kb-msg-status' }, h('span', null, t('ask.stopped')), h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.retryAsk(message.id) } }, t('ask.retry')))
                        : null,
                  )
                }),
          ),
          h(
            'div',
            { className: 'kb-composer' },
            h('div', { className: 'kb-ask-hint' }, t('ask.historyHint')),
            renderQuestionComposer({
              t, inputId: 'dsh-kb-ask-question', value: input, onChange: setInput,
              onSend: submit, onStop: ctx.stopAsk, busy, disabled: busy,
              label: t('ask.empty.title'), placeholder: t('ask.placeholder'), keys: t('ask.keys'), stopLabel: t('ask.stop'),
            }),
          ),
        )
      }

      // ======================================================================
      // tab = 健康（GET /health-check，按 severity / type 分组）
      // ======================================================================

      /** 健康检查问题类型展示顺序。 */
      const HEALTH_TYPE_ORDER = ['broken-link', 'missing-source', 'orphan-page', 'empty-page', 'duplicate-title']

      /**
       * 问题严重度徽章。
       * @param {{ t: Function, severity: string }} props 属性。
       * @returns {any}
       */
      function SeverityBadge(props) {
        const t = props.t
        const severity = asString(props.severity).toLowerCase() || 'info'
        const key = 'health.severity.' + severity
        const label = t(key)
        return h('span', { className: 'kb-sev', 'data-severity': severity }, label === key ? severity : label)
      }

      /**
       * 回收站面板（健康 tab 顶部）：列表 / 恢复 / 彻底删除 / 清空。
       * @returns {any}
       */
      function TrashPanel() {
        const ctx = useKb()
        const t = ctx.t
        const state = ctx.trash || {}
        const data = state.data && typeof state.data === 'object' ? state.data : null
        const items = data && Array.isArray(data.items) ? data.items : []
        const total = data && typeof data.total === 'number' ? data.total : items.length
        const count = total || items.length || ctx.trashCount || 0
        const loading = state.status === 'loading'
        const [busyId, setBusyId] = useState('')
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [confirm, setConfirm] = useState(null)

        // 未加载过时进入健康 tab 自动拉取回收站
        useEffect(
          function () {
            if (state.status === 'idle') ctx.loadTrash()
          },
          [state.status],
        )

        /**
         * 恢复一条回收站页面。
         * @param {any} item 回收站条目。
         * @returns {Promise<void>}
         */
        async function restore(item) {
          if (busy || busyId) return
          setBusyId(asString(item.id))
          setError('')
          let result = null
          try {
            result = await ctx.restoreTrash(asString(item.id))
          } finally {
            setBusyId('')
          }
          if (!result || !result.ok) {
            setError(result && result.message ? result.message : t('trash.restoreFailed', { message: t('error.requestFailed') }))
            return
          }
          const resultData = result.data && typeof result.data === 'object' ? result.data : {}
          const target = asString(resultData.restoredTo) || asString(resultData.page && resultData.page.path)
          const itemTitle = asString(item.title) || t('common.unknown')
          ctx.showNotice('info', target
            ? t('trash.restoredWithTarget', { title: itemTitle, path: target })
            : t('trash.restored', { title: itemTitle }))
        }

        /**
         * 确认彻底删除单条 / 清空回收站。
         * @returns {Promise<void>}
         */
        async function confirmAction() {
          if (busy || !confirm) return
          setBusy(true)
          setError('')
          let result = null
          const isPurge = confirm.kind === 'purge'
          try {
            result = isPurge ? await ctx.purgeTrash(asString(confirm.item && confirm.item.id)) : await ctx.clearTrash()
          } finally {
            setBusy(false)
          }
          if (!result || !result.ok) {
            const message = result && result.message ? result.message : t('error.requestFailed')
            setError(isPurge ? t('trash.purgeFailed', { message: message }) : t('trash.clearFailed', { message: message }))
            return
          }
          setConfirm(null)
          ctx.showNotice('info', isPurge ? t('trash.purged') : t('trash.cleared'))
        }

        const head = h(
          'div',
          { className: 'kb-section-head' },
          h('h3', { className: 'kb-section-title' }, t('trash.title', { n: count })),
          h('span', { className: 'kb-header-spacer' }),
          h(
            IconButton,
            {
              label: t('trash.reload'),
              title: t('trash.reload'),
              disabled: loading,
              onClick: function () {
                ctx.loadTrash()
              },
            },
            loading ? h(Spinner, { size: 'sm' }) : h(RefreshIcon, { size: 12 }),
          ),
        )

        const listNodes = []
        if (loading && !data) {
          listNodes.push(h('div', { key: 'loading', className: 'kb-trash-empty' }, h(Spinner, { size: 'sm' }), ' ', t('trash.loading')))
        } else if (state.status === 'error' && !data) {
          listNodes.push(
            h(
              'div',
              { key: 'error', className: 'kb-trash-empty' },
              t('trash.failed', { message: asString(state.error) || t('error.requestFailed') }),
              ' ',
              h('button', { type: 'button', className: 'kb-linkbtn', onClick: function () { ctx.loadTrash() } }, t('common.retry')),
            ),
          )
        } else if (items.length === 0) {
          listNodes.push(h('div', { key: 'empty', className: 'kb-trash-empty' }, t('trash.empty')))
        } else {
          listNodes.push(
            h(
              'div',
              { key: 'list', className: 'kb-trash-list kb-inset' },
              items.map(function (item) {
                if (!item || typeof item !== 'object') return null
                const id = asString(item.id)
                const title = asString(item.title) || asString(item.path) || t('common.unknown')
                const sourceCount = typeof item.sourceCount === 'number' && item.sourceCount > 0 ? item.sourceCount : 0
                return h(
                  'div',
                  { key: id || title, className: 'kb-trash-item' },
                  h(
                    'span',
                    { className: 'kb-trash-main' },
                    h('span', { className: 'kb-trash-title' }, title),
                    h(
                      'span',
                      { className: 'kb-trash-meta' },
                      h(TypeBadge, { t: t, type: asString(item.type) }),
                      item.deletedAt ? h('span', null, t('trash.deletedAt', { time: formatDateTime(item.deletedAt) })) : null,
                      sourceCount > 0 ? h('span', null, t('trash.sourceCount', { n: sourceCount })) : null,
                    ),
                  ),
                  h(
                    'span',
                    { className: 'kb-trash-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { restore(item) }, disabled: busy || !!busyId },
                      busyId === id ? h(Spinner, { size: 'sm' }) : h(UndoIcon, { size: 12 }),
                      h('span', null, busyId === id ? t('trash.restoring') : t('trash.restore')),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'kb-btn kb-btn-danger kb-btn-sm',
                        disabled: busy || !!busyId,
                        onClick: function () {
                          setConfirm({ kind: 'purge', item: item })
                        },
                      },
                      h(TrashIcon, { size: 12 }),
                      h('span', null, t('trash.purge')),
                    ),
                  ),
                )
              }),
            ),
          )
        }

        return h(
          'section',
          { className: 'kb-trash' },
          head,
          error ? h('div', { className: 'kb-inline-error' }, error) : null,
          listNodes,
          items.length > 0
            ? h(
                'div',
                { className: 'kb-trash-foot' },
                h('span', { className: 'kb-trash-note' }, t('trash.note')),
                h('span', { className: 'kb-header-spacer' }),
                h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-danger kb-btn-sm', onClick: function () { setConfirm({ kind: 'clear' }) }, disabled: busy },
                  h(TrashIcon, { size: 12 }),
                  h('span', null, t('trash.clear')),
                ),
              )
            : null,
          confirm
            ? h(ConfirmDialog, {
                t: t,
                title: confirm.kind === 'purge' ? t('trash.purgeTitle') : t('trash.clearTitle'),
                description: confirm.kind === 'purge'
                  ? t('trash.purgeDesc', { title: asString(confirm.item && confirm.item.title) || t('common.unknown') })
                  : t('trash.clearDesc', { n: items.length }),
                confirmLabel: confirm.kind === 'purge' ? t('trash.purgeAction') : t('trash.clearAction'),
                irreversible: true,
                busy: busy,
                busyLabel: t('dialog.working'),
                onCancel: function () {
                  if (!busy) setConfirm(null)
                },
                onConfirm: confirmAction,
              })
            : null,
        )
      }

      /**
       * 健康检查视图。
       * @returns {any}
       */
      function HealthView() {
        const ctx = useKb()
        const t = ctx.t
        const state = ctx.health || {}
        const data = state.data && typeof state.data === 'object' ? state.data : null
        const running = state.status === 'loading'
        const issues = data && Array.isArray(data.issues) ? data.issues : []
        const summary = data && data.summary && typeof data.summary === 'object' ? data.summary : null
        const errorCount = issues.filter(function (issue) { return asString(issue.severity).toLowerCase() === 'error' }).length
        const warningCount = issues.filter(function (issue) { return asString(issue.severity).toLowerCase() === 'warning' }).length

        const grouped = []
        const known = {}
        for (let orderIndex = 0; orderIndex < HEALTH_TYPE_ORDER.length; orderIndex += 1) {
          const type = HEALTH_TYPE_ORDER[orderIndex]
          known[type] = []
        }
        const other = []
        for (let index = 0; index < issues.length; index += 1) {
          const issue = issues[index]
          if (!issue || typeof issue !== 'object') continue
          const type = asString(issue.type)
          if (known[type]) known[type].push(issue)
          else other.push(issue)
        }
        for (let orderIndex = 0; orderIndex < HEALTH_TYPE_ORDER.length; orderIndex += 1) {
          const type = HEALTH_TYPE_ORDER[orderIndex]
          if (known[type].length > 0) grouped.push({ type: type, issues: known[type] })
        }
        if (other.length > 0) grouped.push({ type: 'unknown', issues: other })
        const severityRank = { error: 0, warning: 1, warn: 1, info: 2 }
        for (let groupIndex = 0; groupIndex < grouped.length; groupIndex += 1) {
          grouped[groupIndex].issues.sort(function (left, right) {
            const leftRank = severityRank[asString(left.severity).toLowerCase()]
            const rightRank = severityRank[asString(right.severity).toLowerCase()]
            return (leftRank === undefined ? 3 : leftRank) - (rightRank === undefined ? 3 : rightRank)
          })
        }

        return h(
          'div',
          { className: 'kb-health' },
          h(
            'div',
            { className: 'kb-health-head' },
            h('div', { className: 'kb-ask-titles' }, h('h2', { className: 'kb-overview-title' }, t('health.title')), h('span', { className: 'kb-ask-sub' }, t('health.desc'))),
            h('span', { className: 'kb-header-spacer' }),
            h(
              'button',
              { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: ctx.runHealthCheck, disabled: running },
              running ? h(Spinner, { size: 'sm' }) : h(HealthIcon, { size: 13 }),
              h('span', null, running ? t('health.running') : t('health.run')),
            ),
          ),
          h(TrashPanel, { key: 'trash' }),
          state.status === 'error'
            ? h('div', { className: 'kb-inline-error' }, t('health.failed', { message: asString(state.error) || t('error.requestFailed') }))
            : null,
          !data
            ? h(EmptyBlock, {
                t: t,
                title: t('health.empty.title'),
                hint: t('health.empty.hint'),
                icon: h(HealthIcon, { size: 28 }),
                action: h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: ctx.runHealthCheck, disabled: running },
                  running ? h(Spinner, { size: 'sm' }) : h(HealthIcon, { size: 13 }),
                  h('span', null, running ? t('health.running') : t('health.run')),
                ),
              })
            : h(
                'div',
                { className: 'kb-health-body' },
                h(
                  'div',
                  { className: 'kb-health-summary' },
                  summary
                    ? h(
                        'span',
                        { className: 'kb-health-summary-text' },
                        t('health.summary', {
                          pages: typeof summary.pages === 'number' ? summary.pages : 0,
                          links: typeof summary.links === 'number' ? summary.links : 0,
                          issues: typeof summary.issues === 'number' ? summary.issues : issues.length,
                        }),
                      )
                    : h('span', { className: 'kb-health-summary-text' }, t('health.issueCount', { n: issues.length })),
                  errorCount > 0 ? h('span', { className: 'kb-sev', 'data-severity': 'error' }, t('health.errors', { n: errorCount })) : null,
                  warningCount > 0 ? h('span', { className: 'kb-sev', 'data-severity': 'warning' }, t('health.warnings', { n: warningCount })) : null,
                  state.checkedAt ? h('span', { className: 'kb-health-time' }, t('health.checkedAt', { time: formatDateTime(state.checkedAt) })) : null,
                ),
                issues.length === 0
                  ? h('div', { className: 'kb-health-good' }, h('span', { className: 'kb-health-good-icon' }, h(CheckIcon, { size: 18 })), h('div', null, h('div', { className: 'kb-health-good-title' }, t('health.good')), h('div', { className: 'kb-health-good-hint' }, t('health.goodHint'))))
                  : grouped.map(function (group) {
                      const type = group.type
                      const typeKey = 'health.type.' + type
                      const typeLabel = t(typeKey)
                      return h(
                        'section',
                        { key: type, className: 'kb-health-group' },
                        h(
                          'div',
                          { className: 'kb-health-group-head' },
                          h('h3', { className: 'kb-section-title' }, typeLabel === typeKey ? type : typeLabel),
                          h('span', { className: 'kb-group-count' }, t('common.items', { n: group.issues.length })),
                        ),
                        h(
                          'div',
                          { className: 'kb-health-issues kb-inset' },
                          group.issues.map(function (issue, index) {
                            const page = asString(issue.page)
                            const detail = asString(issue.detail)
                            return h(
                              'div',
                              { key: page ? page + '-' + index : type + '-' + index, className: 'kb-health-issue', 'data-severity': asString(issue.severity).toLowerCase() || 'info' },
                              h(SeverityBadge, { t: t, severity: issue.severity }),
                              h(
                                'div',
                                { className: 'kb-health-issue-main' },
                                h('div', { className: 'kb-health-detail' }, detail || t('health.type.unknown')),
                                page ? h('div', { className: 'kb-health-page' }, t('health.pageTarget', { page: page })) : h('div', { className: 'kb-health-page' }, t('health.noPage')),
                              ),
                              page
                                ? h(
                                    'button',
                                    {
                                      type: 'button',
                                      className: 'kb-linkbtn',
                                      onClick: function () {
                                        ctx.openPage(page)
                                      },
                                    },
                                    t('health.openPage'),
                                  )
                                : null,
                            )
                          }),
                        ),
                      )
                    }),
              ),
        )
      }

      // ======================================================================
      // 素材 tab：素材库独立页（v0.3.0：管理动作从左侧栏集中到这里）
      // ======================================================================

      /** 素材状态筛选项（全部 / 就绪 / 失败 / 进行中）。 */
      const SOURCE_FILTERS = ['all', 'ready', 'failed', 'busy']

      /**
       * 素材状态归组（ready / failed / busy），供筛选用。
       * @param {any} source 素材记录。
       * @returns {'ready'|'failed'|'busy'}
       */
      function sourceStatusGroup(source) {
        const status = asString(source && source.status)
        if (status === 'ready') return 'ready'
        if (status === 'failed') return 'failed'
        return 'busy'
      }

      /**
       * 素材库页：全宽列表 + 状态筛选 + 批量管理（删除）+ 添加 / 重新编译。
       * @returns {any}
       */
      function SourcesTab({ conversationsOnly = false } = {}) {
        const ctx = useKb()
        const t = ctx.t
        const treeState = ctx.tree || {}
        const sources = treeState.data && Array.isArray(treeState.data.sources) ? treeState.data.sources.filter(source => !conversationsOnly || source.kind === 'conversation') : []
        const loading = treeState.status === 'loading' && sources.length === 0
        const loadFailed = treeState.status === 'error' && sources.length === 0
        const [filter, setFilter] = useState('all')
        const [query, setQuery] = useState('')
        const [managing, setManaging] = useState(false)
        const [selected, setSelected] = useState([])
        const [addOpen, setAddOpen] = useState(false)
        const [deleteTarget, setDeleteTarget] = useState(null)
        const [deleteBusy, setDeleteBusy] = useState(false)
        const [deleteError, setDeleteError] = useState('')
        const [batchConfirm, setBatchConfirm] = useState(false)
        const [batchBusy, setBatchBusy] = useState(false)
        const [batchError, setBatchError] = useState('')
        const [retryingId, setRetryingId] = useState('')
        const [recompileTarget, setRecompileTarget] = useState(null)

        const counts = { all: sources.length, ready: 0, failed: 0, busy: 0 }
        for (let index = 0; index < sources.length; index += 1) {
          counts[sourceStatusGroup(sources[index])] += 1
        }
        const keyword = query.trim().toLowerCase()
        const visible = sources.filter(function (source) {
          if (!source || typeof source !== 'object') return false
          if (filter !== 'all' && sourceStatusGroup(source) !== filter) return false
          if (!keyword) return true
          const title = asString(source.title) || asString(source.name) || asString(source.id)
          return title.toLowerCase().indexOf(keyword) >= 0
        })
        const visibleIds = visible.map(function (source) {
          return asString(source.id)
        }).filter(Boolean)
        const selectedSources = sources.filter(function (source) {
          return source && selected.indexOf(asString(source.id)) >= 0
        })
        const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(function (id) {
          return selected.indexOf(id) >= 0
        })
        const hasFilter = filter !== 'all' || keyword.length > 0

        /** @returns {void} 进入管理态。 */
        function enterManage() {
          setManaging(true)
          setSelected([])
          setBatchError('')
          setDeleteTarget(null)
          setDeleteError('')
        }

        /** @returns {void} 退出管理态并清空选择。 */
        function exitManage() {
          setManaging(false)
          setSelected([])
          setBatchError('')
          setBatchConfirm(false)
        }

        /**
         * 切换单个素材选中态。
         * @param {string} id 素材 id。
         * @returns {void}
         */
        function toggleSelected(id) {
          setSelected(function (previous) {
            return previous.indexOf(id) >= 0 ? previous.filter(function (item) { return item !== id }) : previous.concat([id])
          })
        }

        /** @returns {void} 全选 / 取消全选当前筛选结果。 */
        function toggleAllVisible() {
          if (allVisibleSelected) {
            setSelected(function (previous) {
              return previous.filter(function (id) { return visibleIds.indexOf(id) < 0 })
            })
            return
          }
          setSelected(function (previous) {
            const next = previous.slice()
            for (let index = 0; index < visibleIds.length; index += 1) {
              if (next.indexOf(visibleIds[index]) < 0) next.push(visibleIds[index])
            }
            return next
          })
        }

        /**
         * 单条删除（二次确认后永久删除）。
         * @returns {Promise<void>}
         */
        async function confirmDelete() {
          const target = deleteTarget
          if (!target || deleteBusy) return
          setDeleteBusy(true)
          setDeleteError('')
          try {
            const result = await ctx.deleteSource(target)
            if (!result || !result.ok) {
              setDeleteError(result && result.message ? result.message : t('sources.deleteFailed', { message: t('error.requestFailed') }))
              return
            }
            setDeleteTarget(null)
          } finally {
            setDeleteBusy(false)
          }
        }

        /**
         * 重新编译前检查素材摘要页是否有手动编辑（有则二次确认）。
         * @param {any} source 素材。
         * @returns {Promise<void>}
         */
        async function requestRetry(source) {
          if (retryingId) return
          const id = asString(source && source.id)
          setRetryingId(id)
          try {
            const info = await ctx.inspectSourceRecompile(source)
            if (info && info.confirm) {
              setRecompileTarget({ source: source, title: info.title || asString(source.title) || id })
              return
            }
            await ctx.retrySource(source)
          } finally {
            setRetryingId('')
          }
        }

        /** @returns {Promise<void>} 确认覆盖手动编辑并重新编译。 */
        async function confirmCompile() {
          const pending = recompileTarget && recompileTarget.source ? recompileTarget.source : null
          setRecompileTarget(null)
          if (!pending) return
          setRetryingId(asString(pending.id))
          try {
            await ctx.retrySource(pending)
          } finally {
            setRetryingId('')
          }
        }

        /** @returns {Promise<void>} 确认批量删除素材。 */
        async function confirmBatch() {
          if (batchBusy) return
          const ids = selectedSources.map(function (source) { return asString(source.id) }).filter(Boolean)
          if (ids.length === 0) return
          setBatchBusy(true)
          setBatchError('')
          let result = null
          try {
            result = await ctx.deleteSources(ids)
          } finally {
            setBatchBusy(false)
          }
          if (!result || !result.ok) {
            setBatchError(result && result.message ? result.message : t('manage.failed', { message: t('error.requestFailed') }))
            return
          }
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          const deleted = Array.isArray(data.deleted) ? data.deleted.length : ids.length
          const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0
          ctx.showNotice('info', t('manage.deletedSources', { n: deleted }) + (skipped > 0 ? t('common.separator') + t('manage.skipped', { n: skipped }) : ''))
          exitManage()
        }

        // Esc 退出管理态（有弹层时交给弹层自己处理）
        useEffect(function () {
          if (!managing) return undefined
          /**
           * @param {any} event 键盘事件。
           * @returns {void}
           */
          function handleEscape(event) {
            if (!event || event.key !== 'Escape') return
            if (deleteTarget || batchConfirm || recompileTarget || addOpen) return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            exitManage()
          }
          document.addEventListener('keydown', handleEscape)
          return function () {
            document.removeEventListener('keydown', handleEscape)
          }
        }, [managing, deleteTarget, batchConfirm, recompileTarget, addOpen])

        /**
         * 素材行元信息片段（类型 / 页数 / 字数 / 状态 / 创建时间）。
         * @param {any} source 素材。
         * @returns {string[]}
         */
        function metaPartsOf(source) {
          if (conversationsOnly) return [
            (source.conversation?.models || []).map(m => m.model).join(' / ') || t('conversation.unknownModel'),
            t('conversation.messages', { n: source.conversation?.messageCount || 0 }),
            conversationScope(t, source.conversation?.scope) || '',
            source.createdAt ? formatDateTime(source.createdAt) : '',
          ].filter(Boolean)
          const parts = [kindLabel(t, source.kind)]
          if (source.kind === 'conversation' && source.conversation) {
            const scope = conversationScope(t, source.conversation.scope)
            parts.push(source.conversation.scope === zh['conversation.full'] ? scope + ' · ' + t('conversation.messages', { n: source.conversation.messageCount }) : scope)
          }
          const pages = Array.isArray(source.pages) ? source.pages : []
          const relatedCount = pages.filter(function (path) { return path !== source.pagePath }).length
          if (relatedCount) parts.push(t('sources.relatedCount', { n: relatedCount }))
          if (source.versionCount > 1) parts.push(t('source.detail.versions', { n: source.versionCount }))
          if (typeof source.chars === 'number' && source.chars > 0) parts.push(t('common.chars', { n: source.chars }))
          parts.push(sourceStatusLabel(t, asString(source.status) || 'queued'))
          if (source.createdAt) parts.push(t('sources.createdAt', { time: formatTime(source.createdAt) }))
          return parts
        }

        const filterLabels = {
          all: t('sources.filter.all'),
          ready: t('sources.filter.ready'),
          failed: t('sources.filter.failed'),
          busy: t('sources.filter.busy'),
        }

        const head = h(
          'div',
          { className: 'kb-sources-head' },
          h(
            'div',
            { className: 'kb-ask-titles' },
            h('h2', { className: 'kb-overview-title' }, t(conversationsOnly ? 'tab.conversations' : 'sources.title')),
            h('span', { className: 'kb-ask-sub' }, t(conversationsOnly ? 'conversation.description' : 'sources.pageDesc')),
          ),
          h('span', { className: 'kb-header-spacer' }),
          h(
            'button',
            { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: ctx.refreshAll, disabled: ctx.refreshing },
            ctx.refreshing ? h(Spinner, { size: 'sm' }) : h(RefreshIcon, { size: 13 }),
            h('span', null, t('common.refresh')),
          ),
          sources.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'kb-btn kb-btn-sm' + (managing ? ' kb-btn-primary' : ''),
                  onClick: managing ? exitManage : enterManage,
                  'aria-pressed': managing ? 'true' : 'false',
                },
                managing ? h(CheckIcon, { size: 13 }) : h(EditIcon, { size: 13 }),
                h('span', null, managing ? t('manage.exit') : t('manage.enter')),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: function () { if (conversationsOnly) window.dispatchEvent(new Event('dsh-conversations:open')); else setAddOpen(true) } },
            h(UploadIcon, { size: 13 }),
            h('span', null, t(conversationsOnly ? 'conversation.save' : 'sources.add')),
          ),
        )

        const toolbar = h(
          'div',
          { className: 'kb-sources-toolbar' },
          conversationsOnly
            ? sources.length > 0
              ? h('span', { key: 'conversation-count', className: 'kb-sources-count' }, t('conversation.count', { n: sources.length }))
              : null
            : h(
                'div',
                { className: 'kb-filter-chips', role: 'group', 'aria-label': t('sources.filterLabel') },
                SOURCE_FILTERS.map(function (id) {
                  return h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'kb-filter-chip',
                      'data-active': filter === id ? 'true' : 'false',
                      'aria-pressed': filter === id ? 'true' : 'false',
                      onClick: function () {
                        setFilter(id)
                        setSelected([])
                      },
                    },
                    h('span', null, filterLabels[id]),
                    h('span', { className: 'kb-filter-count' }, String(counts[id])),
                  )
                }),
              ),
          h('span', { className: 'kb-header-spacer' }),
          h(
            'div',
            { className: 'kb-search-field' },
            h('span', { className: 'kb-search-field-icon', 'aria-hidden': 'true' }, h(SearchIcon, { size: 13 })),
            h('input', {
              className: 'kb-input kb-filter-input',
              type: 'text',
              value: query,
              placeholder: t(conversationsOnly ? 'conversation.searchPlaceholder' : 'sources.filterPlaceholder'),
              'aria-label': t(conversationsOnly ? 'conversation.search' : 'sources.filterPlaceholder'),
              onChange: function (event) {
                setQuery(event.target.value)
                setSelected([])
              },
              spellCheck: false,
              autoComplete: 'off',
            }),
          ),
        )

        const manageBar = managing
          ? h(
              'div',
              { className: 'kb-manage-bar kb-manage-bar-page' },
              h(
                'label',
                { className: 'kb-manage-selectall' },
                h('input', {
                  className: 'kb-checkbox',
                  type: 'checkbox',
                  checked: allVisibleSelected,
                  onChange: toggleAllVisible,
                  'aria-label': allVisibleSelected ? t('sources.deselectAll') : t('sources.selectAll'),
                }),
                h('span', null, allVisibleSelected ? t('sources.deselectAll') : t('sources.selectAll')),
              ),
              h('span', { className: 'kb-manage-text' }, t('manage.selected', { n: selected.length })),
              h('span', { className: 'kb-header-spacer' }),
              h('button', { type: 'button', className: 'kb-btn kb-btn-ghost kb-btn-sm', onClick: exitManage, disabled: batchBusy }, t('manage.cancel')),
              h(
                'button',
                { type: 'button', className: 'kb-btn kb-btn-danger kb-btn-sm', onClick: function () { setBatchConfirm(true) }, disabled: batchBusy || selected.length === 0 },
                t('manage.delete'),
              ),
            )
          : null

        const rowNodes = visible.map(function (source, index) {
          const id = asString(source.id) || 'source-page-' + index
          const status = asString(source.status) || 'queued'
          const title = asString(source.title) || asString(source.name) || id
          const parts = metaPartsOf(source)
          const metaTitle = parts.join(t('common.separator'))
          const metaNodes = []
          for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            if (partIndex > 0) metaNodes.push(h('span', { key: 'dot-' + partIndex, className: 'kb-meta-dot' }))
            metaNodes.push(h('span', { key: 'part-' + partIndex }, parts[partIndex]))
          }
          const isSelected = selected.indexOf(id) >= 0
          if (managing) {
            return h(
              'label',
              { key: id, className: 'kb-source-item kb-source-item-manage' + (isSelected ? ' kb-source-selected' : ''), 'data-status': status },
              h('input', {
                className: 'kb-checkbox',
                type: 'checkbox',
                checked: isSelected,
                onChange: function () { toggleSelected(id) },
                'aria-label': title,
                'aria-checked': isSelected ? 'true' : 'false',
              }),
              h(
                'span',
                { className: 'kb-source-body' },
                h('span', { className: 'kb-source-title' }, title),
                h('span', { className: 'kb-source-meta', title: metaTitle }, metaNodes),
              ),
            )
          }
          const isFailed = status === 'failed'
          const retrying = retryingId === id
          return h(
            'div',
            { key: id, className: 'kb-source-item', 'data-status': status },
            h(
              'button',
              {
                type: 'button',
                className: 'kb-source-item-main',
                onClick: function () { if (conversationsOnly) ctx.openSourceRef(source); else ctx.openSourceOriginal(source) },
                title: isFailed && source.error ? t('sources.failedTip', { message: asString(source.error) }) : title,
                'aria-label': t(conversationsOnly ? 'sources.openConversation' : 'sources.openMaterial') + t('common.separator') + title,
              },
              h('span', { className: 'kb-status-dot', 'data-status': status }),
              h(
                'span',
                { className: 'kb-source-body' },
                h('span', { className: 'kb-source-title' }, title),
                h('span', { className: 'kb-source-meta', title: metaTitle }, metaNodes),
              ),
            ),
            h(
              'span',
              { className: 'kb-source-item-actions' },
              isFailed
                ? h(
                    'button',
                    { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { requestRetry(source) }, disabled: retrying || !!retryingId, title: t('sources.retry'), 'aria-label': t('sources.retry') },
                    retrying ? h(Spinner, { size: 'sm' }) : h(RefreshIcon, { size: 12 }),
                    h('span', null, t('sources.retry')),
                  )
                : null,
              conversationsOnly ? h(
                'button',
                { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { ctx.openSourceOriginal(source) }, title: t('source.original.open'), 'aria-label': t('source.original.open') },
                h(FileIcon, { size: 12 }),
                h('span', null, t('source.original.short')),
              ) : null,
              h(
                'button',
                { type: 'button', className: 'kb-btn kb-btn-danger kb-btn-sm', onClick: function () { setDeleteTarget(source); setDeleteError('') }, title: t(conversationsOnly ? 'conversation.delete' : 'sources.delete'), 'aria-label': t(conversationsOnly ? 'conversation.delete' : 'sources.delete') },
                h(TrashIcon, { size: 12 }),
                h('span', null, t(conversationsOnly ? 'conversation.delete' : 'sources.delete')),
              ),
            ),
          )
        })

        let body = null
        if (!ctx.initialized) {
          body = h(InitGuide, { key: 'init' })
        } else if (loading) {
          body = h(LoadingBlock, { key: 'loading', t: t })
        } else if (loadFailed) {
          body = h(ErrorBlock, { key: 'error', t: t, text: t('error.loadFailed'), onRetry: ctx.loadTree })
        } else if (sources.length === 0) {
          body = h(EmptyBlock, {
            key: 'empty',
            t: t,
            title: t(conversationsOnly ? 'conversation.empty' : 'sources.empty'),
            hint: t(conversationsOnly ? 'conversation.emptyHint' : 'sources.emptyHint'),
            icon: h(FileIcon, { size: 28 }),
            action: h(
              'button',
              { type: 'button', className: 'kb-btn kb-btn-primary kb-btn-sm', onClick: function () { if (conversationsOnly) window.dispatchEvent(new Event('dsh-conversations:open')); else setAddOpen(true) } },
              h(UploadIcon, { size: 13 }),
              h('span', null, t(conversationsOnly ? 'conversation.save' : 'sources.add')),
            ),
          })
        } else if (visible.length === 0) {
          body = h(EmptyBlock, {
            key: 'filter-empty',
            t: t,
            title: t('sources.filterEmpty'),
            hint: t('sources.filterEmptyHint'),
            icon: h(FileIcon, { size: 28 }),
            action: h(
              'button',
              { type: 'button', className: 'kb-btn kb-btn-sm', onClick: function () { setFilter('all'); setQuery(''); setSelected([]) }, disabled: !hasFilter },
              h('span', null, t('sources.filterClear')),
            ),
          })
        } else {
          body = h('div', { key: 'list', className: 'kb-sources-card' }, rowNodes)
        }

        return h(
          'div',
          { className: 'kb-sources' + (conversationsOnly ? ' kb-conversation-collection' : '') },
          head,
          ctx.activeJob ? h(JobStrip, { key: 'job' }) : null,
          sources.length > 0 ? toolbar : null,
          manageBar,
          body,
          deleteTarget
            ? h(ConfirmDialog, {
                key: 'delete',
                t: t,
                title: t(conversationsOnly ? 'conversation.deleteTitle' : 'sources.deleteConfirm', { title: asString(deleteTarget.title) || asString(deleteTarget.id) || t('common.unknown') }),
                description: t(conversationsOnly ? 'conversation.deleteNote' : 'sources.deleteConfirmHint'),
                confirmLabel: t(conversationsOnly ? 'conversation.delete' : 'sources.deleteAction'),
                busyLabel: t('sources.deleting'),
                busy: deleteBusy,
                error: deleteError,
                irreversible: true,
                onCancel: function () {
                  if (!deleteBusy) setDeleteTarget(null)
                },
                onConfirm: confirmDelete,
              })
            : null,
          batchConfirm
            ? h(ConfirmDialog, {
                key: 'batch',
                t: t,
                title: t(conversationsOnly ? 'conversation.deleteSelected' : 'manage.deleteSourcesTitle', { n: selected.length }),
                description: t(conversationsOnly ? 'conversation.deleteNote' : 'manage.deleteSourcesDesc'),
                confirmLabel: t(conversationsOnly ? 'conversation.delete' : 'manage.deleteSourcesAction'),
                busyLabel: t('manage.deleting'),
                busy: batchBusy,
                error: batchError,
                irreversible: true,
                onCancel: function () {
                  if (!batchBusy) setBatchConfirm(false)
                },
                onConfirm: confirmBatch,
                children: confirmPreviewList(t, selectedSources),
              })
            : null,
          recompileTarget
            ? h(ConfirmDialog, {
                key: 'recompile',
                t: t,
                title: t('sources.recompileTitle'),
                description: t('sources.recompileDesc', { title: asString(recompileTarget.title) || t('common.unknown') }),
                confirmLabel: t('sources.recompileAction'),
                busy: false,
                onCancel: function () {
                  setRecompileTarget(null)
                },
                onConfirm: confirmCompile,
              })
            : null,
          addOpen
            ? h(
                KbModal,
                { key: 'add', t: t, title: t(conversationsOnly ? 'conversation.save' : 'sources.add'), description: t('sources.addDesc'), onClose: function () { setAddOpen(false) } },
                h(UploadCard, { fileInputRef: ctx.fileInputRef, pasteOpen: ctx.pasteOpen, setPasteOpen: ctx.setPasteOpen, pickFiles: ctx.pickFiles }),
              )
            : null,
        )
      }

      // ======================================================================
      // 主面板数据整理 / 轮询辅助
      // ======================================================================

      /** 问答消息 id 自增序列（仅用于 React key 与定位，无业务含义）。 */
      let askIdSequence = 0

      /**
       * 生成问答消息 id。
       * @param {string} prefix 前缀（u / a）。
       * @returns {string}
       */
      function nextAskId(prefix) {
        askIdSequence += 1
        return prefix + '-' + askIdSequence.toString(36) + '-' + Date.now().toString(36)
      }

      /**
       * 归一化模块缓存里的问答消息（面板切换后恢复；进行中的流标记为已停止）。
       * @param {any} raw 缓存数组。
       * @returns {any[]}
       */
      function normalizeAskMessages(raw) {
        const list = Array.isArray(raw) ? raw : []
        const messages = []
        for (let index = 0; index < list.length; index += 1) {
          const message = list[index]
          if (!message || typeof message !== 'object') continue
          const role = message.role === 'user' ? 'user' : 'assistant'
          let status = asString(message.status) || 'done'
          if (status === 'streaming') status = 'stopped'
          messages.push({
            id: asString(message.id) || nextAskId(role === 'user' ? 'u' : 'a'),
            role: role,
            content: asString(message.content),
            status: status,
            error: asString(message.error),
            sources: Array.isArray(message.sources) ? message.sources.filter(function (item) { return item && typeof item === 'object' }) : [],
          })
        }
        return messages
      }

      /**
       * 归一化 Host 返回的 job 对象（字段缺失一律降级）。
       * @param {any} raw 原始 job。
       * @returns {any | null}
       */
      function normalizeJob(raw) {
        if (!raw || typeof raw !== 'object') return null
        const result = raw.result && typeof raw.result === 'object' ? raw.result : null
        const rawPages = result && Array.isArray(result.pages) ? result.pages : []
        const pages = []
        for (let index = 0; index < rawPages.length; index += 1) {
          const item = rawPages[index]
          if (!item || typeof item !== 'object') continue
          pages.push({ path: asString(item.path), title: asString(item.title), type: asString(item.type) })
        }
        let errorText = ''
        if (typeof raw.error === 'string') errorText = raw.error
        else if (raw.error && typeof raw.error === 'object' && typeof raw.error.message === 'string') errorText = raw.error.message
        return {
          id: asString(raw.id),
          kind: asString(raw.kind),
          sourceId: asString(raw.sourceId) || asString(result && result.sourceId),
          status: asString(raw.status) || 'queued',
          stage: asString(raw.stage),
          message: asString(raw.message),
          progress: typeof raw.progress === 'number' && isFinite(raw.progress) ? raw.progress : null,
          error: errorText,
          warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
          finishedAt: asString(raw.finishedAt),
          resultPages: pages,
          sourceTitle: asString(raw.sourceTitle) || asString(result && result.title) || '',
        }
      }

      /**
       * 合并轮询结果到当前 activeJob（保留初始 sourceTitle / sourceId）。
       * @param {any} previous 上一次 job。
       * @param {any} next 归一化后的 job。
       * @returns {any}
       */
      function mergeJob(previous, next) {
        const merged = Object.assign({}, previous, next)
        if (!next.sourceTitle) merged.sourceTitle = previous && previous.sourceTitle ? previous.sourceTitle : ''
        if (!next.sourceId) merged.sourceId = previous && previous.sourceId ? previous.sourceId : ''
        return merged
      }

      /**
       * 构造 /ask 的 history（最近 12 条、每条 ≤4000 字、按时间顺序）。
       * @param {any[]} messages 已有消息。
       * @returns {Array<{ role: string, content: string }>}
       */
      function buildAskHistory(messages) {
        const list = Array.isArray(messages) ? messages : []
        const history = []
        for (let index = 0; index < list.length; index += 1) {
          const message = list[index]
          if (!message || typeof message !== 'object') continue
          const role = message.role === 'user' ? 'user' : 'assistant'
          const content = asString(message.content).trim()
          if (!content) continue
          history.push({ role: role, content: content.length > MAX_PURPOSE_CHARS ? content.slice(0, MAX_PURPOSE_CHARS) : content })
        }
        return history.slice(-12)
      }

      // ======================================================================
      // 主面板入口（main key='kb'）：ErrorBoundary + 状态容器
      // ======================================================================

      /**
       * 主面板入口：只做翻译函数解析与错误边界包装。
       * @param {any} props slot 注入的 props（含 locale 服务绑定的 t）。
       * @returns {any}
       */
      function KbPanel(props) {
        const t = resolveT(props)
        return h(KbErrorBoundary, { title: t('crash.title'), hint: t('crash.hint') }, h(PanelBody, { t: t }))
      }

      /**
       * 面板主体：持有全部状态与数据加载逻辑，通过 KbContext 供子组件使用。
       * @param {{ t: Function }} props 翻译函数。
       * @returns {any}
       */
      function PanelBody(props) {
        const t = props.t

        // ---- 状态（初始值尽量从模块级 cache 恢复，切换面板保留现场） ----------
        const [tab, setTabState] = useState(function () {
          return TAB_IDS.indexOf(cache.tab) >= 0 ? cache.tab : 'library'
        })
        const [navigationOpen, setNavigationOpen] = useState(false)
        const [meta, setMeta] = useState({ status: 'loading', data: null, error: '' })
        const [overview, setOverview] = useState(function () {
          return cache.overview ? { status: 'ready', data: cache.overview, error: '' } : { status: 'idle', data: null, error: '' }
        })
        const [tree, setTree] = useState(function () {
          return cache.tree ? { status: 'ready', data: cache.tree, error: '' } : { status: 'idle', data: null, error: '' }
        })
        const [page, setPageState] = useState(() => cache.page)
        const [graph, setGraph] = useState(function () {
          return { status: cache.graphData ? 'ready' : 'idle', data: cache.graphData || null, error: '' }
        })
        // Keep cached graph visible while refreshing changes made by other plugins.
        const [graphStale, setGraphStale] = useState(true)
        const [health, setHealth] = useState(function () {
          return cache.healthData ? { status: 'ready', data: cache.healthData, error: '', checkedAt: '' } : { status: 'idle', data: null, error: '', checkedAt: '' }
        })
        const [trash, setTrash] = useState(function () {
          return cache.trashData ? { status: 'ready', data: cache.trashData, error: '' } : { status: 'idle', data: null, error: '' }
        })
        const [searchQuery, setSearchQueryState] = useState(function () {
          return typeof cache.searchQuery === 'string' ? cache.searchQuery : ''
        })
        const [searchResults, setSearchResults] = useState(null)
        const [searchTotal, setSearchTotal] = useState(0)
        const [searchNextOffset, setSearchNextOffset] = useState(null)
        const [searchStatus, setSearchStatus] = useState('idle')
        const [searchWarnings, setSearchWarnings] = useState([])
        const [activeJob, setActiveJob] = useState(null)
        const [uploadState, setUploadState] = useState({ busy: false, index: 0, total: 0, name: '', size: 0, phase: 'reading' })
        const [pasteOpen, setPasteOpen] = useState(false)
        const [sourceOriginal, setSourceOriginal] = useState(null)
        const [notice, setNotice] = useState(null)
        const [errorBar, setErrorBar] = useState('')
        const [refreshing, setRefreshing] = useState(false)
        const [initBusy, setInitBusy] = useState(false)
        const [initError, setInitError] = useState('')
        const [purposeDraft, setPurposeDraftState] = useState(function () {
          return cache.overview && typeof cache.overview.purpose === 'string' ? cache.overview.purpose : ''
        })
        const [purposeSaving, setPurposeSaving] = useState(false)
        const [purposeError, setPurposeError] = useState('')
        const [purposeDirty, setPurposeDirty] = useState(false)
        const [askMessages, setAskMessages] = useState(function () {
          return normalizeAskMessages(cache.askMessages)
        })
        const [askBusy, setAskBusy] = useState(false)

        // ---- refs（abort / 定时器 / mounted 守卫） -----------------------------
        const mountedRef = useRef(true)
        const controllersRef = useRef(null)
        if (!controllersRef.current) controllersRef.current = new Set()
        const pageAbortRef = useRef(null)
        const overviewAbortRef = useRef(null)
        const treeAbortRef = useRef(null)
        const graphAbortRef = useRef(null)
        const searchAbortRef = useRef(null)
        const searchSeqRef = useRef(0)
        const searchResultsQueryRef = useRef('')
        const sourceOriginalAbortRef = useRef(null)
        const askAbortRef = useRef(null)
        const trashAbortRef = useRef(null)
        const noticeTimerRef = useRef(0)
        const purposeDirtyRef = useRef(false)
        const activeJobRef = useRef(null)
        const fileInputRef = useRef(null)
        const mainRef = useRef(null)

        // ---- 派生数据 ---------------------------------------------------------
        const metaData = meta.data
        const initialized = !!(metaData && metaData.initialized === true)
        const pageBackTab = tab === 'conversations' ? tab : cache.pageOrigin
        const rootDir = asString(metaData && metaData.rootDir) || asString(overview.data && overview.data.rootDir) || ''
        const modelSource = metaData && metaData.model ? metaData.model : overview.data && overview.data.model ? overview.data.model : null
        const modelLabel = modelSource && typeof modelSource === 'object'
          ? asString(modelSource.label) || [asString(modelSource.provider), asString(modelSource.model)].filter(Boolean).join(' / ')
          : ''
        // 顶栏空间有限：只展示模型名末段（按「·」或「 / 」分隔），完整名放 title。
        const modelShort = (function () {
          if (!modelLabel) return ''
          const parts = modelLabel.split(/\s*·\s*|\s+\/\s+/).map(function (part) { return part.trim() }).filter(Boolean)
          return parts.length > 0 ? parts[parts.length - 1] : modelLabel
        })()
        const trashCount = trash && trash.data && typeof trash.data.total === 'number'
          ? trash.data.total
          : (overview.data && typeof overview.data.trashCount === 'number'
            ? overview.data.trashCount
            : metaData && typeof metaData.trashCount === 'number' ? metaData.trashCount : 0)

        // --------------------------------------------------------------------
        // 基础工具
        // --------------------------------------------------------------------

        /**
         * 注册进行中的 AbortController（卸载时统一 abort）。
         * @param {AbortController} controller 控制器。
         * @returns {AbortController}
         */
        function registerController(controller) {
          if (controllersRef.current) controllersRef.current.add(controller)
          return controller
        }

        /**
         * 请求结束后移除控制器。
         * @param {AbortController} controller 控制器。
         * @returns {void}
         */
        function releaseController(controller) {
          if (controllersRef.current) controllersRef.current.delete(controller)
        }

        /**
         * 判断异常是否是 abort。
         * @param {any} error 异常。
         * @returns {boolean}
         */
        function isAbort(error) {
          return !!(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
        }

        /**
         * 显示 info / warn 通知（3s 自动消失）。
         * @param {string} kind 'info' | 'warn'。
         * @param {string} text 文案。
         * @returns {void}
         */
        function showNotice(kind, text) {
          if (noticeTimerRef.current) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = 0
          }
          setNotice({ kind: kind || 'info', text: asString(text) })
          noticeTimerRef.current = setTimeout(function () {
            noticeTimerRef.current = 0
            if (mountedRef.current) setNotice(null)
          }, 3000)
        }

        /** @returns {void} 关闭 info 通知。 */
        function dismissNotice() {
          if (noticeTimerRef.current) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = 0
          }
          setNotice(null)
        }

        /**
         * 显示全局错误条（需手动关闭）。
         * @param {string} text 文案。
         * @returns {void}
         */
        function showError(text) {
          setErrorBar(asString(text) || t('error.requestFailed'))
        }

        /** @returns {void} 关闭错误条。 */
        function dismissError() {
          setErrorBar('')
        }

        // --------------------------------------------------------------------
        // 数据加载
        // --------------------------------------------------------------------

        /**
         * 加载 /overview。
         * @returns {Promise<void>}
         */
        async function loadOverview() {
          if (overviewAbortRef.current) {
            try {
              overviewAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          overviewAbortRef.current = controller
          setOverview(function (previous) {
            return { status: 'loading', data: previous ? previous.data : null, error: '' }
          })
          try {
            const data = await api('/overview', { signal: controller.signal })
            if (!mountedRef.current) return
            setOverview({ status: 'ready', data: data, error: '' })
            cache.overview = data
            if (!purposeDirtyRef.current) {
              setPurposeDraftState(typeof data.purpose === 'string' ? data.purpose : '')
            }
            return data
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setOverview(function (previous) {
              return { status: 'error', data: previous ? previous.data : null, error: errorMessage(error, t('error.requestFailed')) }
            })
          } finally {
            releaseController(controller)
            if (overviewAbortRef.current === controller) overviewAbortRef.current = null
          }
        }

        /**
         * 加载 /tree。
         * @returns {Promise<void>}
         */
        async function loadTree() {
          if (treeAbortRef.current) {
            try {
              treeAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          treeAbortRef.current = controller
          setTree(function (previous) {
            return { status: 'loading', data: previous ? previous.data : null, error: '' }
          })
          try {
            const data = await api('/tree?view=library', { signal: controller.signal })
            if (!mountedRef.current) return
            setTree({ status: 'ready', data: data, error: '' })
            cache.tree = data
            return data
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setTree(function (previous) {
              return { status: 'error', data: previous ? previous.data : null, error: errorMessage(error, t('error.requestFailed')) }
            })
          } finally {
            releaseController(controller)
            if (treeAbortRef.current === controller) treeAbortRef.current = null
          }
        }

        /**
         * 加载 /graph。
         * @returns {Promise<void>}
         */
        async function loadGraph() {
          if (graphAbortRef.current) {
            try {
              graphAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          graphAbortRef.current = controller
          setGraph(function (previous) {
            return { status: 'loading', data: previous ? previous.data : null, error: '' }
          })
          try {
            const data = await api('/graph', { signal: controller.signal })
            if (!mountedRef.current) return
            setGraph({ status: 'ready', data: data, error: '' })
            cache.graphData = data
            setGraphStale(false)
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setGraph(function (previous) {
              return { status: 'error', data: previous ? previous.data : null, error: errorMessage(error, t('error.requestFailed')) }
            })
          } finally {
            releaseController(controller)
            if (graphAbortRef.current === controller) graphAbortRef.current = null
          }
        }

        /**
         * 加载 /meta；已初始化时顺带加载 overview / tree 并恢复上次页面。
         * @returns {Promise<void>}
         */
        async function loadMeta() {
          const controller = registerController(new AbortController())
          setMeta(function (previous) {
            return Object.assign({}, previous, { status: 'loading', error: '' })
          })
          try {
            const data = await api('/meta', { signal: controller.signal })
            if (!mountedRef.current) return
            setMeta({ status: 'ready', data: data, error: '' })
            if (data && data.initialized === true) {
              await Promise.all([loadOverview(), loadTree(), loadGraph()])
            } else {
              setOverview({ status: 'ready', data: null, error: '' })
              setTree({ status: 'ready', data: { initialized: false, groups: [], sources: [] }, error: '' })
            }
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setMeta({ status: 'error', data: null, error: errorMessage(error, t('error.requestFailed')) })
          } finally {
            releaseController(controller)
          }
        }

        /**
         * 手动刷新：meta + 列表 + 当前页 + 图谱。
         * @returns {Promise<void>}
         */
        async function refreshAll() {
          if (refreshing) return
          const currentPage = cache.page
          setRefreshing(true)
          try {
            await loadMeta()
            if (!mountedRef.current) return
            if (currentPage.path && cache.page === currentPage && !pageAbortRef.current) await openPage(currentPage.path)
            if (!mountedRef.current) return
            if (tab === 'graph') await loadGraph()
          } finally {
            if (mountedRef.current) setRefreshing(false)
          }
        }

        /**
         * 初始化知识库（POST /init）。
         * @returns {Promise<void>}
         */
        async function initialize() {
          if (initBusy) return
          setInitBusy(true)
          setInitError('')
          try {
            await api('/init', { method: 'POST', body: {} })
            if (!mountedRef.current) return
            showNotice('info', t('init.done'))
            await loadMeta()
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setInitError(errorMessage(error, t('error.requestFailed')))
          } finally {
            if (mountedRef.current) setInitBusy(false)
          }
        }

        // --------------------------------------------------------------------
        // 导航 / 页面 / 搜索
        // --------------------------------------------------------------------

        useEffect(function () {
          const open = () => {
            setTab('conversations')
            loadMeta()
          }
          window.addEventListener('dsh-kb:conversations', open)
          return () => window.removeEventListener('dsh-kb:conversations', open)
        }, [])

        function activateTab(nextTab) {
          cache.tab = nextTab
          setTabState(nextTab)
        }

        /** 顶部标签打开对应概览或列表。 */
        function setTab(nextTab) {
          if (TAB_IDS.indexOf(nextTab) < 0) return
          closePage()
          if (nextTab === 'library') clearSearch()
          activateTab(nextTab)
          if (nextTab === 'graph' && initialized && graph.status !== 'loading') loadGraph()
        }

        function setPage(nextPage) {
          cache.page = nextPage
          setPageState(nextPage)
        }

        /**
         * 打开页面（GET /page?path=），按页面类型选择阅读所属标签。
         * @param {string} path 页面相对路径（wiki/...）。
         * @param {'conversations'|'library'} [initialTab] 加载时的标签。
         * @returns {Promise<void>}
         */
        async function openPage(path, initialTab) {
          const target = asString(path)
          if (!target) return
          const currentTab = cache.tab
          if (currentTab !== 'library') {
            cache.pageOrigin = currentTab === 'conversations' || currentTab === 'graph' ? currentTab : ''
          }
          if (cache.searchQuery || searchResults !== null) clearSearch()
          pageAbortRef.current?.abort()
          const controller = registerController(new AbortController())
          pageAbortRef.current = controller
          activateTab(initialTab || (currentTab === 'conversations' ? currentTab : 'library'))
          setPage({ status: 'loading', path: target, data: null, error: '' })
          try {
            const data = await api('/page?path=' + encodeURIComponent(target), { signal: controller.signal })
            if (!mountedRef.current || pageAbortRef.current !== controller || controller.signal.aborted) return
            const pageData = data.page && typeof data.page === 'object' ? data.page : null
            if (!pageData) {
              throw new ApiError(t('page.notFound'), 'NOT_FOUND', 200)
            }
            const resolvedPath = asString(pageData.path) || target
            const isConversation = pageData.conversation || (pageData.type === 'source' && Array.isArray(pageData.sourceRefs) && pageData.sourceRefs.some(ref => ref?.kind === 'conversation'))
            activateTab(isConversation ? 'conversations' : 'library')
            setPage({ status: 'ready', path: resolvedPath, data: pageData, error: '' })
          } catch (error) {
            if (!mountedRef.current || pageAbortRef.current !== controller || controller.signal.aborted || isAbort(error)) return
            setPage({ status: 'error', path: target, data: null, error: errorMessage(error, t('error.requestFailed')) })
          } finally {
            releaseController(controller)
            if (pageAbortRef.current === controller) pageAbortRef.current = null
          }
        }

        /** 关闭当前阅读页及其请求。 */
        function closePage() {
          pageAbortRef.current?.abort()
          pageAbortRef.current = null
          cache.pageOrigin = ''
          setPage(IDLE_PAGE)
          if (mainRef.current) mainRef.current.scrollTop = 0
        }

        function returnFromPage() {
          if (pageBackTab) setTab(pageBackTab)
          else closePage()
        }

        /**
         * 更新搜索框（250ms 防抖由 effect 负责）。
         * @param {string} value 输入值。
         * @returns {void}
         */
        function setSearchQuery(value) {
          const text = asString(value)
          cache.searchQuery = text
          setSearchQueryState(text)
        }

        /**
         * 执行搜索（带序号防乱序）。
         * @param {string} queryText 关键词。
         * @returns {Promise<void>}
         */
        async function runSearch(queryText, offset = 0) {
          const keyword = asString(queryText).trim()
          if (!keyword) {
            clearSearch()
            return
          }
          searchSeqRef.current += 1
          const seq = searchSeqRef.current
          if (searchAbortRef.current) {
            try {
              searchAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          searchAbortRef.current = controller
          if (!offset) {
            searchResultsQueryRef.current = keyword
            setSearchResults([])
            setSearchTotal(0)
            setSearchNextOffset(null)
            setSearchWarnings([])
          }
          setSearchStatus('loading')
          try {
            const data = await api('/search', { method: 'POST', body: { q: keyword, limit: 30, offset: offset, view: 'library' }, signal: controller.signal })
            if (!mountedRef.current || searchSeqRef.current !== seq) return
            const results = Array.isArray(data.results) ? data.results : []
            setSearchResults(function (previous) {
              if (!offset || !Array.isArray(previous)) return results
              const seen = new Set(previous.map(function (item) { return item.key || item.path }))
              return previous.concat(results.filter(function (item) { return !seen.has(item.key || item.path) }))
            })
            setSearchTotal(typeof data.total === 'number' ? data.total : results.length)
            setSearchNextOffset(Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null)
            setSearchWarnings(Array.isArray(data.warnings) ? data.warnings.filter(function (warning) { return typeof warning === 'string' }) : [])
            setSearchStatus('ready')
          } catch (error) {
            if (!mountedRef.current || searchSeqRef.current !== seq || isAbort(error)) return
            if (!offset) setSearchResults([])
            setSearchStatus('error')
          } finally {
            releaseController(controller)
            if (searchAbortRef.current === controller) searchAbortRef.current = null
          }
        }

        /** @returns {void} 回车立即搜索。 */
        function runSearchNow() {
          runSearch(searchQuery)
        }

        function loadMoreSearch() {
          const keyword = searchQuery.trim()
          if (searchNextOffset !== null && !searchAbortRef.current && searchResultsQueryRef.current === keyword) {
            void runSearch(keyword, searchNextOffset)
          }
        }

        /** @returns {void} 清空搜索状态。 */
        function clearSearch() {
          searchSeqRef.current += 1
          if (searchAbortRef.current) {
            try {
              searchAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          cache.searchQuery = ''
          searchResultsQueryRef.current = ''
          setSearchQueryState('')
          setSearchResults(null)
          setSearchTotal(0)
          setSearchNextOffset(null)
          setSearchWarnings([])
          setSearchStatus('idle')
        }

        // --------------------------------------------------------------------
        // 素材：打开 / 删除 / 重编译
        // --------------------------------------------------------------------

        /**
         * 打开来源引用：优先素材摘要页，其次原始链接。
         * @param {any} ref 来源引用（sourceRefs / tree.sources / recentSources）。
         * @returns {void}
         */
        function openSourceRef(ref) {
          const target = resolveSourceTarget({ tree: tree }, ref)
          if (target.pagePath) {
            openPage(target.pagePath, ref?.kind === 'conversation' ? 'conversations' : undefined)
            return
          }
          if (target.url && typeof window !== 'undefined' && typeof window.open === 'function') {
            try {
              window.open(target.url, '_blank', 'noopener')
              return
            } catch (error) {
              // 落到 noPage 提示
            }
          }
          showNotice('warn', t('sources.noPage'))
        }

        /**
         * 打开「查看原文」弹层：GET /source?id= 读取素材记录与本地保存的正文。
         * @param {any} ref 素材引用（{ id }）。
         * @returns {Promise<void>}
         */
        async function openSourceOriginal(ref) {
          const id = asString(ref && ref.id)
          if (!id) return
          sourceOriginalAbortRef.current?.abort()
          const controller = registerController(new AbortController())
          sourceOriginalAbortRef.current = controller
          const title = asString(ref && ref.title)
          setSourceOriginal({ status: 'loading', id: id, title: title, section: 'original' })
          try {
            const data = await api('/source?id=' + encodeURIComponent(id) + '&view=detail', { signal: controller.signal })
            if (!mountedRef.current || sourceOriginalAbortRef.current !== controller) return
            setSourceOriginal({ status: 'ready', id: id, title: title, section: 'original', data: data })
          } catch (error) {
            if (!mountedRef.current || sourceOriginalAbortRef.current !== controller || isAbort(error)) return
            setSourceOriginal({ status: 'error', id: id, title: title, error: errorMessage(error, t('error.requestFailed')) })
          } finally {
            releaseController(controller)
            if (sourceOriginalAbortRef.current === controller) sourceOriginalAbortRef.current = null
          }
        }

        function setSourceSection(section) {
          setSourceOriginal(function (current) {
            return current && current.status === 'ready' ? Object.assign({}, current, { section: section }) : current
          })
        }

        /** @returns {void} 关闭「查看原文」弹层。 */
        function closeSourceOriginal() {
          sourceOriginalAbortRef.current?.abort()
          sourceOriginalAbortRef.current = null
          setSourceOriginal(null)
        }

        /**
         * 删除素材（DELETE /source?id=），成功后刷新列表。
         * @param {any} source 素材。
         * @returns {Promise<{ ok: boolean, message?: string }>}
         */
        async function deleteSource(source) {
          const id = asString(source && source.id)
          if (!id) return { ok: false }
          try {
            await api('/source?id=' + encodeURIComponent(id), { method: 'DELETE' })
            if (!mountedRef.current) return { ok: true }
            const removedPaths = []
            if (Array.isArray(source.pages)) {
              for (let index = 0; index < source.pages.length; index += 1) removedPaths.push(asString(source.pages[index]))
            }
            if (source.pagePath) removedPaths.push(asString(source.pagePath))
            if (page.path && removedPaths.indexOf(page.path) >= 0) closePage()
            showNotice('info', t('sources.deleted', { title: asString(source.title) || id }))
            await refreshContent()
            invalidateTrash()
            return { ok: true }
          } catch (error) {
            if (isAbort(error)) return { ok: false }
            const message = errorMessage(error, t('error.requestFailed'))
            showError(t('sources.deleteFailed', { message: message }))
            return { ok: false, message: message }
          }
        }

        /**
         * 重新编译指定素材（POST /compile）。
         * @param {any} source 素材。
         * @returns {Promise<boolean>}
         */
        async function retrySource(source) {
          const id = asString(source && source.id)
          if (!id) return false
          try {
            const data = await api('/compile', { method: 'POST', body: { sourceId: id } })
            if (!mountedRef.current) return false
            startJob(asString(data.jobId), asString(source.title), id)
            return true
          } catch (error) {
            if (isAbort(error)) return false
            showError(t('sources.retryFailed', { message: errorMessage(error, t('error.requestFailed')) }))
            return false
          }
        }

        // --------------------------------------------------------------------
        // 任务：启动 / 轮询完成 / 重试
        // --------------------------------------------------------------------

        /**
         * 记录一个正在进行的 job，随后由 900ms 轮询接管。
         * @param {string} jobId job id。
         * @param {string} sourceTitle 素材标题（展示用）。
         * @param {string} [sourceId] 素材 id（失败重试用）。
         * @returns {void}
         */
        function startJob(jobId, sourceTitle, sourceId) {
          const id = asString(jobId)
          if (!id) return
          setActiveJob({
            id: id,
            kind: '',
            status: 'queued',
            stage: '',
            message: '',
            progress: null,
            error: '',
            warnings: [],
            finishedAt: '',
            resultPages: [],
            sourceTitle: asString(sourceTitle),
            sourceId: asString(sourceId),
          })
        }

        /** @returns {void} 关闭任务卡片。 */
        function clearJob() {
          setActiveJob(null)
        }

        /**
         * 重试失败任务（POST /compile { sourceId }）。
         * @param {any} job 失败任务。
         * @returns {Promise<boolean>}
         */
        async function retryJob(job) {
          const sourceId = asString(job && job.sourceId)
          if (!sourceId) return false
          try {
            const data = await api('/compile', { method: 'POST', body: { sourceId: sourceId } })
            if (!mountedRef.current) return false
            startJob(asString(data.jobId), asString(job.sourceTitle), sourceId)
            return true
          } catch (error) {
            if (isAbort(error)) return false
            showError(t('sources.retryFailed', { message: errorMessage(error, t('error.requestFailed')) }))
            return false
          }
        }

        /**
         * job 进入终态：刷新 meta/列表；成功且当前没有打开页面时才打开首个结果页。
         * 失败不弹全局错误条——JobStrip 内联错误 + 重试入口已经足够，避免双重报错。
         * @param {any} job 终态 job。
         * @returns {void}
         */
        function handleJobFinished(job) {
          setGraphStale(true)
          loadMeta()
          const status = asString(job && job.status)
          if (FAILED_JOB_STATUS.indexOf(status) >= 0) return
          const pages = job && Array.isArray(job.resultPages) ? job.resultPages : []
          const first = pages[0]
          const openPath = cache.page.path
          if (first && asString(first.path) && !openPath) {
            openPage(asString(first.path))
          } else {
            showNotice('info', t('job.done'))
          }
        }

        // --------------------------------------------------------------------
        // 上传 / 链接 / 粘贴
        // --------------------------------------------------------------------

        /**
         * 打开文件选择框（空态 CTA 与上传卡共用；上传中不响应）。
         * @returns {void}
         */
        function pickFiles() {
          if (uploadState.busy) return
          const node = fileInputRef.current
          if (node && typeof node.click === 'function') node.click()
        }

        /**
         * 展开左栏粘贴表单（空态 CTA 使用）。
         * @returns {void}
         */
        function openPaste() {
          setPasteOpen(true)
        }

        /**
         * 串行上传多个文件：大小检查 → FileReader base64 → POST /upload。
         * @param {File[]} files 浏览器文件列表。
         * @returns {Promise<void>}
         */
        async function uploadFiles(files) {
          const list = Array.isArray(files) ? files.filter(function (file) { return file && typeof file === 'object' }) : []
          if (list.length === 0) return
          const limits = metaData && metaData.limits ? metaData.limits : null
          const maxBytes = limits && typeof limits.maxFileBytes === 'number' && limits.maxFileBytes > 0 ? limits.maxFileBytes : DEFAULT_MAX_FILE_BYTES
          const failures = []
          const duplicates = []
          let uploaded = 0
          setUploadState({ busy: true, index: 0, total: list.length, name: '', size: 0, phase: 'reading' })
          for (let index = 0; index < list.length; index += 1) {
            if (!mountedRef.current) break
            const file = list[index]
            const fileName = asString(file.name) || 'file-' + (index + 1)
            const fileSize = typeof file.size === 'number' && isFinite(file.size) ? file.size : 0
            if (fileSize > maxBytes) {
              failures.push(t('upload.tooLarge', { name: fileName, size: formatBytes(fileSize), limit: formatBytes(maxBytes) }))
              continue
            }
            setUploadState({ busy: true, index: index + 1, total: list.length, name: fileName, size: fileSize, phase: 'reading' })
            try {
              const base64 = await readFileAsBase64(file, t)
              if (!mountedRef.current) break
              setUploadState({ busy: true, index: index + 1, total: list.length, name: fileName, size: fileSize, phase: 'uploading' })
              const uploadBody = { name: fileName, dataBase64: base64 }
              const mime = asString(file.type)
              if (mime) uploadBody.mime = mime
              const data = await api('/upload', { method: 'POST', body: uploadBody })
              if (!mountedRef.current) break
              const source = data.source && typeof data.source === 'object' ? data.source : {}
              if (data.existed) {
                // v0.4.0：同一文件 / 同一正文已在知识库 → 不重复入库、不启动编译
                duplicates.push(asString(source.title) || fileName)
                loadTree()
                continue
              }
              uploaded += 1
              if (data.jobId) startJob(asString(data.jobId), asString(source.title) || fileName, asString(source.id))
              loadTree()
            } catch (error) {
              if (isAbort(error)) break
              failures.push(t('upload.failed', { name: fileName, message: errorMessage(error, t('error.requestFailed')) }))
            }
          }
          if (!mountedRef.current) return
          setUploadState({ busy: false, index: 0, total: 0, name: '', size: 0, phase: 'reading' })
          if (uploaded > 0) {
            showNotice('info', t('upload.done', { n: uploaded }))
            loadOverview()
            loadTree()
          }
          if (duplicates.length === 1) showNotice('info', t('dup.existed', { title: duplicates[0] }))
          else if (duplicates.length > 1) showNotice('info', t('dup.skippedMany', { n: duplicates.length }))
          if (failures.length > 0) showError(failures.join(t('common.failureSeparator')))
        }

        /**
         * 消化链接（POST /ingest-url）。
         * @param {string} url 链接。
         * @returns {Promise<{ ok: boolean, message?: string }>}
         */
        async function ingestUrl(url) {
          const target = asString(url).trim()
          if (!isHttpUrl(target)) return { ok: false, message: t('url.invalid') }
          try {
            const data = await api('/ingest-url', { method: 'POST', body: { url: target } })
            if (!mountedRef.current) return { ok: true }
            const source = data.source && typeof data.source === 'object' ? data.source : {}
            if (data.existed) {
              // v0.4.0：同 URL / 同正文已在知识库 → 不重复入库
              const title = asString(source.title) || target
              showNotice(data.contentChanged ? 'warn' : 'info', t(data.contentChanged ? 'dup.changed' : 'dup.existed', { title }))
              loadTree()
              return { ok: true }
            }
            if (data.jobId) startJob(asString(data.jobId), asString(source.title) || target, asString(source.id))
            loadTree()
            showNotice('info', t('url.submitted'))
            return { ok: true }
          } catch (error) {
            if (isAbort(error)) return { ok: false }
            return { ok: false, message: errorMessage(error, t('url.failed')) }
          }
        }

        /**
         * 消化粘贴文本（POST /ingest-text）。
         * @param {string} text 正文。
         * @param {string} [title] 标题。
         * @returns {Promise<{ ok: boolean, message?: string }>}
         */
        async function ingestText(text, title) {
          const content = asString(text).trim()
          if (!content) return { ok: false, message: t('paste.empty') }
          const body = { text: content }
          if (asString(title).trim()) body.title = asString(title).trim()
          try {
            const data = await api('/ingest-text', { method: 'POST', body: body })
            if (!mountedRef.current) return { ok: true }
            const source = data.source && typeof data.source === 'object' ? data.source : {}
            if (data.existed) {
              // v0.4.0：同一正文已在知识库 → 不重复入库
              const title = asString(source.title) || t('paste.toggle')
              showNotice('info', t('dup.existed', { title }))
              loadTree()
              return { ok: true }
            }
            if (data.jobId) startJob(asString(data.jobId), asString(source.title) || t('paste.toggle'), asString(source.id))
            loadTree()
            return { ok: true }
          } catch (error) {
            if (isAbort(error)) return { ok: false }
            return { ok: false, message: errorMessage(error, t('paste.failed')) }
          }
        }

        // --------------------------------------------------------------------
        // 研究方向 / 剪贴板
        // --------------------------------------------------------------------

        /**
         * 更新研究方向草稿（标记 dirty，避免刷新覆盖用户输入）。
         * @param {string} value 文本。
         * @returns {void}
         */
        function setPurposeDraft(value) {
          setPurposeError('')
          setPurposeDirty(true)
          setPurposeDraftState(asString(value))
        }

        /**
         * 保存研究方向（POST /purpose）。
         * @returns {Promise<void>}
         */
        async function savePurpose() {
          if (purposeSaving) return
          const text = purposeDraft.trim()
          if (text.length > MAX_PURPOSE_CHARS) {
            setPurposeError(t('overview.purposeTooLong', { n: MAX_PURPOSE_CHARS }))
            return
          }
          setPurposeSaving(true)
          setPurposeError('')
          try {
            const data = await api('/purpose', { method: 'POST', body: { text: text } })
            if (!mountedRef.current) return
            const saved = typeof data.purpose === 'string' ? data.purpose : text
            setPurposeDirty(false)
            setPurposeDraftState(saved)
            setOverview(function (previous) {
              const base = previous && previous.data && typeof previous.data === 'object' ? previous.data : {}
              return { status: previous ? previous.status : 'ready', data: Object.assign({}, base, { purpose: saved }), error: '' }
            })
            showNotice('info', t('overview.purposeSaved'))
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setPurposeError(t('overview.purposeFailed', { message: errorMessage(error, t('error.requestFailed')) }))
          } finally {
            if (mountedRef.current) setPurposeSaving(false)
          }
        }

        /**
         * 复制文本并提示。
         * @param {string} textValue 待复制文本。
         * @param {string} [message] 成功文案。
         * @returns {Promise<void>}
         */
        async function copyToClipboard(textValue, message) {
          const ok = await copyText(textValue)
          if (ok) showNotice('info', message || t('header.copied'))
          else showError(t('header.copyFailed', { path: asString(textValue) }))
        }

        /** @returns {Promise<void>} 复制知识库根目录。 */
        async function copyRootDir() {
          await copyToClipboard(rootDir || DEFAULT_ROOT_LABEL, t('header.copied'))
        }

        // --------------------------------------------------------------------
        // 问答（SSE 流式）
        // --------------------------------------------------------------------

        /**
         * 更新一条问答消息。
         * @param {string} id 消息 id。
         * @param {Record<string, any>} patch 字段增量。
         * @returns {void}
         */
        function updateAskMessage(id, patch) {
          if (!mountedRef.current) return
          setAskMessages(function (previous) {
            return previous.map(function (message) {
              if (!message || message.id !== id) return message
              return Object.assign({}, message, patch)
            })
          })
        }

        /**
         * 发送问题：POST /ask（SSE）→ 流式渲染 + 引用页面。
         * @param {string} question 问题。
         * @param {any[]} [baseMessages] 基础消息（重试时用）。
         * @returns {Promise<void>}
         */
        async function sendAsk(question, baseMessages) {
          const text = asString(question).trim()
          if (!text || askBusy) return
          const base = Array.isArray(baseMessages) ? baseMessages : askMessages
          const history = buildAskHistory(base)
          const assistantId = nextAskId('a')
          const userMessage = { id: nextAskId('u'), role: 'user', content: text, status: 'done', error: '', sources: [] }
          const assistantMessage = { id: assistantId, role: 'assistant', content: '', status: 'streaming', error: '', sources: [] }
          setAskMessages(base.concat([userMessage, assistantMessage]))
          setAskBusy(true)
          if (askAbortRef.current) {
            try {
              askAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          askAbortRef.current = controller
          try {
            const response = await fetch(ORIGIN + '/ask', {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify({ question: text, history: history }),
              signal: controller.signal,
            })
            if (!response.ok) {
              const detail = await readErrorText(response, t('ask.failed', { message: 'HTTP ' + response.status }))
              throw new ApiError(detail, 'HTTP_' + response.status, response.status)
            }
            let content = ''
            let streamError = ''
            let done = false
            let sources = []
            const onEvent = function (event) {
              if (!event || typeof event !== 'object') return
              if (event.type === 'progress') { updateAskMessage(assistantId, { progress: asString(event.message) }); return }
              if (event.type === 'meta') {
                sources = Array.isArray(event.sources) ? event.sources.filter(function (item) { return item && typeof item === 'object' }) : []
                updateAskMessage(assistantId, { sources: sources, retrieval: event.retrieval })
                return
              }
              if (event.type === 'delta') {
                const piece = asString(event.text)
                if (!piece) return
                content += piece
                updateAskMessage(assistantId, { content: content })
                return
              }
              if (event.type === 'done') {
                done = true
                return
              }
              if (event.type === 'error') {
                streamError = asString(event.message) || asString(event.code) || t('ask.failed', { message: t('error.requestFailed') })
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
            if (controller.signal.aborted) {
              updateAskMessage(assistantId, { status: 'stopped' })
              return
            }
            if (streamError) {
              updateAskMessage(assistantId, { status: 'error', error: streamError })
              return
            }
            if (!done) {
              updateAskMessage(assistantId, { status: 'error', error: t('ask.streamInterrupted') })
              return
            }
            if (!content.trim()) {
              updateAskMessage(assistantId, { status: 'error', error: t('ask.emptyAnswer') })
              return
            }
            updateAskMessage(assistantId, { status: 'done', content: content, sources: sources })
          } catch (error) {
            if (controller.signal.aborted || isAbort(error)) {
              updateAskMessage(assistantId, { status: 'stopped' })
              return
            }
            const code = error && typeof error.code === 'string' ? error.code : ''
            const friendly = code === 'NO_MODEL' ? t('ask.errNoModel') : code === 'NO_KB' ? t('ask.errNoKb') : ''
            updateAskMessage(assistantId, { status: 'error', error: friendly || errorMessage(error, t('ask.failed', { message: t('error.requestFailed') })) })
          } finally {
            releaseController(controller)
            if (askAbortRef.current === controller) askAbortRef.current = null
            if (mountedRef.current) setAskBusy(false)
          }
        }

        /** @returns {void} 停止当前流式回答。 */
        function stopAsk() {
          if (!askAbortRef.current) return
          try {
            askAbortRef.current.abort()
          } catch (error) {
            // ignore
          }
        }

        /**
         * 重试失败 / 停止的回答：回退到该问题之前重发。
         * @param {string} messageId 失败的 assistant 消息 id。
         * @returns {void}
         */
        function retryAsk(messageId) {
          if (askBusy) return
          let failedIndex = -1
          for (let index = 0; index < askMessages.length; index += 1) {
            if (askMessages[index] && askMessages[index].id === messageId) {
              failedIndex = index
              break
            }
          }
          if (failedIndex < 0) return
          let userIndex = -1
          for (let index = failedIndex - 1; index >= 0; index -= 1) {
            if (askMessages[index] && askMessages[index].role === 'user') {
              userIndex = index
              break
            }
          }
          if (userIndex < 0) return
          const question = asString(askMessages[userIndex].content)
          const base = askMessages.slice(0, userIndex)
          cache.askMessages = base
          setAskMessages(base)
          sendAsk(question, base)
        }

        /** @returns {void} 清空问答。 */
        function clearAsk() {
          if (askAbortRef.current) {
            try {
              askAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          cache.askMessages = []
          setAskMessages([])
          setAskBusy(false)
        }

        // --------------------------------------------------------------------
        // 健康检查
        // --------------------------------------------------------------------

        /**
         * 运行健康检查（GET /health-check）。
         * @returns {Promise<void>}
         */
        async function runHealthCheck() {
          if (health.status === 'loading') return
          const controller = registerController(new AbortController())
          setHealth(function (previous) {
            return { status: 'loading', data: previous ? previous.data : null, error: '', checkedAt: previous ? previous.checkedAt : '' }
          })
          try {
            const data = await api('/health-check', { signal: controller.signal })
            if (!mountedRef.current) return
            setHealth({ status: 'ready', data: data, error: '', checkedAt: new Date().toISOString() })
            cache.healthData = data
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setHealth(function (previous) {
              return { status: 'error', data: previous ? previous.data : null, error: errorMessage(error, t('error.requestFailed')), checkedAt: previous ? previous.checkedAt : '' }
            })
          } finally {
            releaseController(controller)
          }
        }

        // --------------------------------------------------------------------
        // 内容管理（附录 A）：编辑 / 删除 / 批量 / 回收站
        // --------------------------------------------------------------------

        /**
         * 让回收站缓存失效；当前停留在健康 tab 时立即重新拉取。
         * @returns {void}
         */
        function invalidateTrash() {
          setTrash({ status: 'idle', data: null, error: '' })
          cache.trashData = null
          if (tab === 'health') loadTrash()
        }

        /**
         * 内容变更后让派生数据失效（图谱 / 健康）。
         * @returns {void}
         */
        function invalidateDerived() {
          setGraphStale(true)
          setHealth({ status: 'idle', data: null, error: '', checkedAt: '' })
          cache.healthData = null
        }

        /**
         * 刷新 tree / overview 并失效派生数据；默认重新打开当前页面（不存在则关闭）。
         * @param {{ reopen?: boolean }} [options] 选项。
         * @returns {Promise<void>}
         */
        async function refreshContent(options) {
          const opts = options || {}
          const currentPage = cache.page
          const treeData = await loadTree()
          await loadOverview()
          invalidateDerived()
          if (!mountedRef.current) return
          if (opts.reopen === false || cache.page !== currentPage || pageAbortRef.current) return
          if (!currentPage.path || !treeData) return
          if (treeHasPath(treeData, currentPage.path)) await openPage(currentPage.path)
          else closePage()
        }

        /**
         * 编辑页面（PUT /page）。
         * @param {any} body 请求体（path/title/aliases/tags/confidence/markdown）。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string, code?: string }>}
         */
        async function updatePage(body) {
          try {
            const data = await api('/page', { method: 'PUT', body: body })
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')), code: error && error.code }
          }
        }

        /**
         * 删除单个页面（DELETE /page?path=，进回收站）。
         * @param {string} targetPath 页面路径。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string, code?: string }>}
         */
        async function deletePageFile(targetPath) {
          const target = asString(targetPath)
          if (!target) return { ok: false, message: t('error.requestFailed') }
          try {
            const data = await api('/page?path=' + encodeURIComponent(target), { method: 'DELETE' })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent()
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')), code: error && error.code }
          }
        }

        /**
         * 批量删除素材（POST /sources/delete，级联永久删除）。
         * @param {string[]} ids 素材 id 列表。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string }>}
         */
        async function deleteSources(ids) {
          const list = (Array.isArray(ids) ? ids : []).map(function (item) { return asString(item) }).filter(Boolean)
          if (list.length === 0) return { ok: false, message: t('manage.emptySources') }
          try {
            const data = await api('/sources/delete', { method: 'POST', body: { ids: list } })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent()
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')) }
          }
        }

        /**
         * 批量删除页面（POST /pages/delete，进回收站）。
         * @param {string[]} paths 页面路径列表。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string }>}
         */
        async function deletePages(paths) {
          const list = (Array.isArray(paths) ? paths : []).map(function (item) { return asString(item) }).filter(Boolean)
          if (list.length === 0) return { ok: false, message: t('manage.emptyPages') }
          try {
            const data = await api('/pages/delete', { method: 'POST', body: { paths: list } })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent()
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')) }
          }
        }

        /**
         * 重新编译前检查素材摘要页是否有手动编辑（有则前端二次确认）。
         * @param {any} source 素材。
         * @returns {Promise<{ confirm: boolean, title?: string }>}
         */
        async function inspectSourceRecompile(source) {
          const pagePath = asString(source && source.pagePath) || (Array.isArray(source && source.pages) && source.pages.length > 0 ? asString(source.pages[0]) : '')
          if (!pagePath) return { confirm: false }
          try {
            const data = await api('/page?path=' + encodeURIComponent(pagePath))
            const pageData = data.page && typeof data.page === 'object' ? data.page : null
            if (pageData && pageData.userEditedAt) return { confirm: true, title: asString(pageData.title) || pagePath }
            return { confirm: false }
          } catch (error) {
            return { confirm: false }
          }
        }

        /**
         * 加载回收站（GET /trash）。
         * @returns {Promise<any>}
         */
        async function loadTrash() {
          if (trashAbortRef.current) {
            try {
              trashAbortRef.current.abort()
            } catch (error) {
              // ignore
            }
          }
          const controller = registerController(new AbortController())
          trashAbortRef.current = controller
          setTrash(function (previous) {
            return { status: 'loading', data: previous ? previous.data : null, error: '' }
          })
          try {
            const data = await api('/trash', { signal: controller.signal })
            if (!mountedRef.current) return
            setTrash({ status: 'ready', data: data, error: '' })
            cache.trashData = data
            return data
          } catch (error) {
            if (!mountedRef.current || isAbort(error)) return
            setTrash(function (previous) {
              return { status: 'error', data: previous ? previous.data : null, error: errorMessage(error, t('error.requestFailed')) }
            })
          } finally {
            releaseController(controller)
            if (trashAbortRef.current === controller) trashAbortRef.current = null
          }
        }

        /**
         * 恢复回收站页面（POST /trash/restore）。
         * @param {string} id trashId。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string }>}
         */
        async function restoreTrash(id) {
          const trashId = asString(id)
          if (!trashId) return { ok: false, message: t('error.requestFailed') }
          try {
            const data = await api('/trash/restore', { method: 'POST', body: { id: trashId } })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent({ reopen: false })
            if (!mountedRef.current) return { ok: true, data: data }
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')) }
          }
        }

        /**
         * 彻底删除一条回收站记录（POST /trash/purge {id}）。
         * @param {string} [id] trashId。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string }>}
         */
        async function purgeTrash(id) {
          const body = {}
          const trashId = asString(id)
          if (trashId) body.id = trashId
          try {
            const data = await api('/trash/purge', { method: 'POST', body: body })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent({ reopen: false })
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')) }
          }
        }

        /**
         * 清空回收站（POST /trash/purge，无 id 清空全部）。
         * @returns {Promise<{ ok: boolean, data?: any, message?: string }>}
         */
        async function clearTrash() {
          try {
            const data = await api('/trash/purge', { method: 'POST', body: {} })
            if (!mountedRef.current) return { ok: true, data: data }
            await refreshContent({ reopen: false })
            invalidateTrash()
            return { ok: true, data: data }
          } catch (error) {
            if (isAbort(error)) return { ok: false, message: t('error.requestFailed') }
            return { ok: false, message: errorMessage(error, t('error.requestFailed')) }
          }
        }

        // --------------------------------------------------------------------
        // 生命周期 effects
        // --------------------------------------------------------------------

        // 挂载：加载 meta；卸载：abort 所有请求 + 清定时器
        useEffect(function () {
          mountedRef.current = true
          loadMeta()
          if (cache.page.status === 'loading') openPage(cache.page.path)
          return function () {
            mountedRef.current = false
            const controllers = controllersRef.current
            if (controllers) {
              controllers.forEach(function (controller) {
                try {
                  controller.abort()
                } catch (error) {
                  // ignore
                }
              })
              controllers.clear()
            }
            if (noticeTimerRef.current) {
              clearTimeout(noticeTimerRef.current)
              noticeTimerRef.current = 0
            }
          }
        }, [])

        // 同步 job ref（轮询里用于合并最新字段）
        useEffect(function () {
          activeJobRef.current = activeJob
        }, [activeJob])

        // job 轮询：每 900ms 一次，终态即停（空闲不轮询）
        useEffect(
          function () {
            const job = activeJob
            if (!job || !asString(job.id)) return undefined
            if (TERMINAL_JOB_STATUS.indexOf(asString(job.status)) >= 0) return undefined
            let cancelled = false
            let inFlight = false
            const timer = setInterval(async function () {
              if (cancelled || inFlight || !mountedRef.current) return
              inFlight = true
              try {
                const data = await api('/job?id=' + encodeURIComponent(job.id))
                if (cancelled || !mountedRef.current) return
                const normalized = normalizeJob(data.job)
                if (!normalized) {
                  throw new ApiError(t('job.pollFailed', { message: t('error.badResponse') }), 'BAD_RESPONSE', 200)
                }
                const previous = activeJobRef.current && activeJobRef.current.id === job.id ? activeJobRef.current : job
                const merged = mergeJob(previous, normalized)
                activeJobRef.current = merged
                setActiveJob(merged)
                if (TERMINAL_JOB_STATUS.indexOf(asString(merged.status)) >= 0) {
                  cancelled = true
                  clearInterval(timer)
                  handleJobFinished(merged)
                }
              } catch (error) {
                if (cancelled || isAbort(error)) return
                cancelled = true
                clearInterval(timer)
                const message = errorMessage(error, t('error.requestFailed'))
                setActiveJob(function (previous) {
                  if (!previous || previous.id !== job.id) return previous
                  return Object.assign({}, previous, { status: 'failed', error: t('job.pollFailed', { message: message }) })
                })
              } finally {
                inFlight = false
              }
            }, JOB_POLL_MS)
            return function () {
              cancelled = true
              clearInterval(timer)
            }
          },
          [activeJob && activeJob.id],
        )

        // 搜索防抖（250ms）；关键词清空时移除结果面板
        useEffect(
          function () {
            const keyword = searchQuery.trim()
            if (!keyword) {
              setSearchResults(null)
              setSearchTotal(0)
              setSearchWarnings([])
              setSearchStatus('idle')
              return undefined
            }
            const timer = setTimeout(function () {
              runSearch(keyword)
            }, SEARCH_DEBOUNCE_MS)
            return function () {
              clearTimeout(timer)
            }
          },
          [searchQuery],
        )

        // Esc：弹层打开时交给 KbModal 栈处理；否则先退出搜索，再关闭阅读页。
        useEffect(function () {
          function handleEscape(event) {
            if (!event || event.key !== 'Escape') return
            if (modalStack.length > 0) return
            if (searchResults !== null || searchQuery) {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              clearSearch()
              return
            }
            if ((tab === 'library' || tab === 'conversations') && page.status !== 'idle') {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              closePage()
            }
          }
          document.addEventListener('keydown', handleEscape)
          return function () {
            document.removeEventListener('keydown', handleEscape)
          }
        }, [tab, page.status, page.path, page.data, searchResults, searchQuery])

        // 进入图谱 tab 时按需加载（失败不自动重试，避免请求风暴）
        useEffect(
          function () {
            if (tab !== 'graph') return
            if (!initialized) return
            if (graph.status === 'loading' || graph.status === 'error') return
            if (graph.status === 'ready' && !graphStale) return
            loadGraph()
          },
          [tab, graphStale, graph.status, initialized],
        )

        // 模块级 cache 同步（切换面板后恢复现场）
        useEffect(function () {
          cache.overview = overview && overview.data ? overview.data : cache.overview
        }, [overview])

        useEffect(function () {
          cache.tree = tree && tree.data ? tree.data : cache.tree
        }, [tree])

        useEffect(function () {
          cache.graphData = graph && graph.data ? graph.data : cache.graphData
        }, [graph])

        useEffect(function () {
          if (health && health.data) cache.healthData = health.data
          else if (health && health.status === 'idle') cache.healthData = null
        }, [health])

        useEffect(function () {
          if (trash && trash.data) cache.trashData = trash.data
          else if (trash && trash.status === 'idle') cache.trashData = null
        }, [trash])

        useEffect(function () {
          cache.searchQuery = searchQuery
        }, [searchQuery])

        useEffect(function () {
          cache.askMessages = askMessages
        }, [askMessages])

        useEffect(function () {
          purposeDirtyRef.current = purposeDirty
        }, [purposeDirty])

        // overview 刷新时同步研究方向（用户正在编辑则不覆盖）
        useEffect(function () {
          if (purposeDirtyRef.current) return
          const purpose = overview && overview.data && typeof overview.data.purpose === 'string' ? overview.data.purpose : ''
          setPurposeDraftState(purpose)
        }, [overview && overview.data])

        // --------------------------------------------------------------------
        // 渲染
        // --------------------------------------------------------------------

        const contextValue = {
          t: t,
          navigationOpen: navigationOpen,
          setNavigationOpen: setNavigationOpen,
          tab: tab,
          setTab: setTab,
          meta: meta,
          initialized: initialized,
          rootDir: rootDir,
          modelLabel: modelLabel,
          modelShort: modelShort,
          overview: overview,
          loadOverview: loadOverview,
          tree: tree,
          loadTree: loadTree,
          page: page,
          openPage: openPage,
          closePage: closePage,
          returnFromPage: returnFromPage,
          pageBackLabel: t(pageBackTab === 'conversations' ? 'page.backConversations' : pageBackTab === 'graph' ? 'graph.return' : 'page.back'),
          searchQuery: searchQuery,
          setSearchQuery: setSearchQuery,
          searchStatus: searchStatus,
          searchWarnings: searchWarnings,
          searchResults: searchResults,
          searchTotal: searchTotal,
          searchNextOffset: searchNextOffset,
          loadMoreSearch: loadMoreSearch,
          runSearchNow: runSearchNow,
          clearSearch: clearSearch,
          activeJob: activeJob,
          clearJob: clearJob,
          retryJob: retryJob,
          retrySource: retrySource,
          uploadState: uploadState,
          uploadFiles: uploadFiles,
          fileInputRef: fileInputRef,
          pasteOpen: pasteOpen,
          setPasteOpen: setPasteOpen,
          pickFiles: pickFiles,
          openPaste: openPaste,
          ingestUrl: ingestUrl,
          ingestText: ingestText,
          deleteSource: deleteSource,
          openSourceRef: openSourceRef,
          openSourceOriginal: openSourceOriginal,
          setSourceSection: setSourceSection,
          closeSourceOriginal: closeSourceOriginal,
          sourceOriginal: sourceOriginal,
          graph: graph,
          graphData: graph.data || null,
          loadGraph: loadGraph,
          health: health,
          healthData: health.data || null,
          runHealthCheck: runHealthCheck,
          trash: trash,
          trashCount: trashCount,
          loadTrash: loadTrash,
          restoreTrash: restoreTrash,
          purgeTrash: purgeTrash,
          clearTrash: clearTrash,
          updatePage: updatePage,
          deletePageFile: deletePageFile,
          deleteSources: deleteSources,
          deletePages: deletePages,
          inspectSourceRecompile: inspectSourceRecompile,
          refreshContent: refreshContent,
          showNotice: showNotice,
          showError: showError,
          notice: notice,
          errorBar: errorBar,
          dismissNotice: dismissNotice,
          dismissError: dismissError,
          refreshing: refreshing,
          refreshAll: refreshAll,
          loadMeta: loadMeta,
          initialize: initialize,
          initBusy: initBusy,
          initError: initError,
          purposeDraft: purposeDraft,
          setPurposeDraft: setPurposeDraft,
          purposeDirty: purposeDirty,
          purposeSaving: purposeSaving,
          purposeError: purposeError,
          savePurpose: savePurpose,
          askMessages: askMessages,
          askBusy: askBusy,
          sendAsk: sendAsk,
          stopAsk: stopAsk,
          retryAsk: retryAsk,
          clearAsk: clearAsk,
          copyRootDir: copyRootDir,
          copyText: copyToClipboard,
        }

        const activeTabLabel = t('tab.' + tab)

        return h(
          KbContext.Provider,
          { value: contextValue },
          h(
            'div',
            { className: 'kb-root', 'data-navigation-open': navigationOpen ? 'true' : 'false' },
            h('style', { key: 'kb-style' }, KB_CSS),
            h(KbHeader, { key: 'header' }),
            h(KbNotices, { key: 'notices' }),
            h(SourceOriginalDialog, { key: 'source-original' }),
            h(
              'div',
              { className: 'kb-body', key: 'body' },
              // 独立全宽页面不显示左侧栏。
              tab === 'books' || tab === 'sources' || tab === 'conversations' || tab === 'graph' ? null : h(KbAside, { key: 'aside' }),
              h(
                'main',
                { className: 'kb-main', key: 'main', ref: mainRef, id: 'kb-main', role: 'tabpanel', 'aria-label': activeTabLabel },
                tab === 'library'
                  ? h(LibraryTab, { key: 'library' })
                  : tab === 'books'
                    ? h(BooksTab, { key: 'books' })
                    : tab === 'conversations'
                      ? page.status === 'idle'
                        ? h(SourcesTab, { key: 'conversations', conversationsOnly: true })
                        : h('div', { className: 'kb-library', key: 'conversation-reading' }, h(PageView))
                    : tab === 'sources'
                      ? h(SourcesTab, { key: 'sources' })
                      : tab === 'graph'
                        ? h(GraphView, { key: 'graph' })
                        : tab === 'ask'
                          ? h(AskView, { key: 'ask' })
                          : h(HealthView, { key: 'health' }),
              ),
            ),
          ),
        )
      }

      // ======================================================================
      // 样式：全部写进组件内渲染的 <style>，颜色只用主题变量（浅/深色自动适配）
      // ======================================================================
      const KB_CSS = [
        '/* ==== DESIGN.md §2 设计令牌（挂在 .kb-root）==== */',
        '.kb-root{container:kb-panel / inline-size;--kb-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",sans-serif;--kb-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;--kb-s1:4px;--kb-s2:8px;--kb-s3:12px;--kb-s4:16px;--kb-s5:20px;--kb-s6:24px;--kb-s7:32px;--kb-s8:40px;--kb-r-xs:5px;--kb-r-sm:8px;--kb-r-md:10px;--kb-r-lg:12px;--kb-r-xl:14px;--kb-r-2xl:14px;--kb-r-pill:999px;--kb-header-h:56px;--kb-nav-w:248px;--kb-content-max:940px;--kb-material:color-mix(in srgb,var(--dsw-alias-bg-base) 76%,transparent);--kb-material-strong:color-mix(in srgb,var(--dsw-alias-bg-base) 90%,transparent);--kb-material-card:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,var(--dsw-alias-bg-base));--kb-hairline:var(--dsw-alias-border-l2);--kb-text-tertiary:color-mix(in srgb,var(--dsw-alias-label-primary) 72%,var(--dsw-alias-bg-base));--kb-text-caption:color-mix(in srgb,var(--dsw-alias-label-primary) 64%,var(--dsw-alias-bg-base));--kb-on-success:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-label-primary));--kb-on-error:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,var(--dsw-alias-label-primary));--kb-on-business:color-mix(in srgb,var(--dsw-alias-state-business-primary) 65%,var(--dsw-alias-label-primary));--kb-surface-2:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));--kb-surface-3:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-bg-base));--kb-tint:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);--kb-tint-strong:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);--kb-ring:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);--kb-ease:cubic-bezier(.25,.1,.25,1);--kb-ease-spring:cubic-bezier(.32,.72,0,1);--kb-fast:140ms;--kb-normal:220ms;--kb-slow:300ms;position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--kb-font);font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
        'html[data-platform="darwin"] .kb-root{padding-top:var(--dsh-frame-top-clearance,48px)}',
        '.kb-root *,.kb-root *::before,.kb-root *::after{box-sizing:border-box}',
        // 注意：这里必须用 :where() 把特异性降到 0，否则会盖掉组件自身的
        // background / border / padding / font-size / color（.kb-btn、.kb-path、
        // .kb-tab、.kb-linkbtn 等单类选择器特异性低于「.kb-root button」）。
        '.kb-root :where(button,input,select,textarea){font-family:inherit;font-size:inherit;color:inherit}',
        '.kb-root :where(button){cursor:pointer;background:none;border:0;padding:0}',
        '.kb-root :where(button:disabled){cursor:default;opacity:.45}',
        '.kb-root a{text-underline-offset:2px}',
        '.kb-root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px;box-shadow:var(--kb-ring)}',
        // 项目选择：文字输入使用系统强调色与单层柔和焦点环，独立于黑色主操作按钮。
        '.kb-root{--kb-field-focus:var(--dsw-alias-state-business-primary);--kb-field-ring:0 0 0 3px color-mix(in srgb,var(--kb-field-focus) 20%,transparent)}',
        '@supports (color:AccentColor){.kb-root{--kb-field-focus:AccentColor}}',
        '.kb-root ::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}',
        '/* ==== 排版（DESIGN §3）==== */',
        '.kb-overview-title,.kb-page-title,.kb-init-title{font-size:24px;font-weight:600;line-height:1.25;letter-spacing:-0.015em;color:var(--dsw-alias-label-primary);margin:0;overflow-wrap:anywhere}',
        '.kb-section-title{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
        '.kb-section-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.kb-counter{font-size:11px;line-height:1.4;color:var(--kb-text-caption);font-variant-numeric:tabular-nums}',
        '.kb-stat-value,.kb-job-percent,.kb-health-summary-text{font-variant-numeric:tabular-nums}',
        '/* ==== 顶栏（56px 玻璃控制层）==== */',
        '.kb-header{flex:0 0 auto;position:relative;z-index:30;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:var(--kb-s3);height:var(--kb-header-h);padding:0 var(--kb-s4);background:var(--kb-material);-webkit-backdrop-filter:blur(22px) saturate(180%);backdrop-filter:blur(22px) saturate(180%);border-bottom:.5px solid var(--kb-hairline)}',
        '.kb-header-left{display:flex;align-items:center;gap:var(--kb-s2);min-width:0;justify-self:start}',
        '.kb-header-center{justify-self:center;min-width:0}',
        '.kb-header-right{display:flex;align-items:center;gap:var(--kb-s2);justify-self:end;min-width:0}',
        '.kb-header-spacer{flex:1 1 auto;min-width:6px}',
        '.kb-logo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--kb-r-sm);color:var(--dsw-alias-brand-primary);background:var(--kb-tint);box-shadow:inset 0 0 0 .5px var(--kb-hairline)}',
        '.kb-title{font-size:15px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
        '.kb-path{flex:0 1 auto;display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:180px;min-height:32px;height:auto;padding:0 10px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.2;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease),border-color var(--kb-fast) var(--kb-ease)}',
        '.kb-path-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-path-sm{max-width:min(340px,40vw);height:26px;font-family:var(--kb-mono);font-size:11px;padding:0 8px;white-space:nowrap;overflow:hidden}',
        '.kb-path-sm code{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit}',
        '.kb-model{flex:0 1 auto;display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;height:26px;padding:0 10px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.2;white-space:nowrap}',
        '.kb-model-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.kb-model[data-state="ready"] .kb-model-dot{background:var(--dsw-alias-state-success-primary)}',
        '.kb-model[data-state="error"] .kb-model-dot{background:var(--dsw-alias-state-error-primary)}',
        '.kb-model-text{min-width:0;overflow:hidden;text-overflow:ellipsis}',
        '.kb-iconbtn-refresh{color:var(--dsw-alias-label-tertiary)}',
        '/* ==== 分段控件（Segmented Control，§5.2）==== */',
        '.kb-segmented{display:inline-flex;align-items:center;gap:2px;height:32px;padding:3px;border-radius:var(--kb-r-pill);background:var(--kb-surface-2)}',
        '.kb-inset{overflow:hidden;border-radius:inherit}',
        '.kb-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-height:20px}',
        '.kb-graph-hit{fill:transparent;cursor:pointer}',
        '.kb-tabs{display:inline-flex;align-items:center;gap:2px;min-height:36px;height:auto;padding:3px;border:.5px solid var(--kb-hairline);border-radius:12px;background:var(--kb-surface-2)}',
        '.kb-tab{position:relative;display:inline-flex;align-items:center;gap:6px;min-height:30px;height:auto;padding:7px 11px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease),box-shadow var(--kb-fast) var(--kb-ease)}',
        '.kb-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 0 0 0 .5px var(--kb-hairline)}',
        '.kb-tab-icon{display:inline-flex;align-items:center;color:inherit;opacity:.75}',
        '.kb-tab[data-active="true"] .kb-tab-icon{color:var(--dsw-alias-brand-primary);opacity:1}',
        '.kb-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 5px;border-radius:var(--kb-r-pill);background:var(--kb-tint);color:var(--dsw-alias-brand-primary);font-size:10.5px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}',
        '/* ==== 骨架布局（§4）==== */',
        '.kb-body{flex:1 1 auto;display:flex;min-width:0;min-height:0}',
        '.kb-nav{flex:0 0 var(--kb-nav-w);width:var(--kb-nav-w);display:flex;flex-direction:column;gap:var(--kb-s5);min-height:0;overflow-y:auto;overflow-x:hidden;padding:var(--kb-s4) var(--kb-s3) var(--kb-s8);border-right:.5px solid var(--kb-hairline);background:var(--dsw-alias-bg-base);scrollbar-gutter:stable;scrollbar-width:thin}',
        '.kb-main{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);scrollbar-gutter:stable;scrollbar-width:thin}',
        '.kb-nav::-webkit-scrollbar,.kb-main::-webkit-scrollbar,.kb-ask-scroll::-webkit-scrollbar,.kb-modal-body::-webkit-scrollbar,.kb-trash-list::-webkit-scrollbar,.kb-groups::-webkit-scrollbar{width:8px;height:8px}',
        '.kb-nav::-webkit-scrollbar-thumb,.kb-main::-webkit-scrollbar-thumb,.kb-ask-scroll::-webkit-scrollbar-thumb,.kb-modal-body::-webkit-scrollbar-thumb,.kb-trash-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border:2px solid transparent;border-radius:var(--kb-r-pill);background-clip:content-box}',
        '.kb-nav::-webkit-scrollbar-thumb:hover,.kb-main::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-border-l4);background-clip:content-box}',
        '/* ==== 侧栏区块（Inset Grouped，§5.3）==== */',
        '.kb-nav-section{display:flex;flex-direction:column;gap:var(--kb-s2);min-width:0}',
        '.kb-nav-head{display:flex;align-items:center;gap:var(--kb-s2);min-height:18px;padding:0 2px}',
        '.kb-nav-title{font-size:11px;font-weight:600;line-height:1.4;text-transform:uppercase;letter-spacing:.06em;color:var(--kb-text-tertiary)}',
        '.kb-nav-count{font-size:11px;line-height:1.4;color:var(--kb-text-caption);font-variant-numeric:tabular-nums}',
        '.kb-nav-tip{font-size:11px;line-height:1.5;color:var(--kb-text-caption);overflow-wrap:anywhere}',
        '.kb-nav-action{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 6px;border:0;border-radius:var(--kb-r-pill);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;font-weight:500;line-height:1;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-nav-empty{padding:var(--kb-s2) var(--kb-s1);color:var(--kb-text-tertiary);font-size:12px;line-height:1.5}',
        '.kb-nav-loading{display:flex;align-items:center;gap:8px;padding:var(--kb-s2) var(--kb-s1);color:var(--kb-text-tertiary);font-size:12px}',
        '.kb-nav-error{padding:var(--kb-s2) var(--kb-s1);color:var(--kb-on-error);font-size:12px;line-height:1.5}',
        '.kb-search-section{gap:var(--kb-s1)}',
        '.kb-search-hint{display:none}',
        '.kb-search-section:focus-within .kb-search-hint{display:block}',
        '/* ==== 上传卡 ==== */',
        '.kb-upload{gap:var(--kb-s2);padding:var(--kb-s3);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-drop{display:flex;flex-direction:column;align-items:center;gap:6px;padding:var(--kb-s4) var(--kb-s3);border:1px dashed var(--dsw-alias-border-l4);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);text-align:center;cursor:pointer;transition:border-color var(--kb-fast) var(--kb-ease),background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-drop[data-drag="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--kb-tint)}',
        '.kb-drop-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}',
        '.kb-drop-title{font-size:12.5px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary)}',
        '.kb-drop-hint{font-size:11px;line-height:1.5;color:var(--kb-text-caption);overflow-wrap:anywhere}',
        '.kb-file-input{position:absolute;width:1em;height:1em;opacity:0;pointer-events:none;border:0;padding:0;margin:0}',
        '.kb-urlbar{display:flex;flex-direction:column;gap:6px}',
        '.kb-input-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.kb-url-input{flex:1 1 140px;min-width:0}',
        '.kb-input-icon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-caption)}',
        '.kb-url-input{height:30px}',
        '.kb-paste{display:flex;flex-direction:column;gap:6px}',
        '.kb-collapse{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px;border:0;border-radius:var(--kb-r-pill);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-collapse-icon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-caption)}',
        '.kb-paste-form{display:flex;flex-direction:column;gap:8px;padding:var(--kb-s2);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-1)}',
        '/* ==== JobStrip ==== */',
        '.kb-job{display:flex;flex-direction:column;gap:6px;padding:var(--kb-s3);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-job[data-state="failed"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--kb-hairline));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-1))}',
        '.kb-job[data-state="done"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 26%,var(--kb-hairline))}',
        '.kb-job-head{display:flex;align-items:center;gap:8px;min-width:0}',
        '.kb-job-title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-job-status{flex:none;font-size:11px;line-height:1.4;color:var(--kb-text-tertiary)}',
        '.kb-job[data-state="failed"] .kb-job-status{color:var(--kb-on-error)}',
        '.kb-job[data-state="done"] .kb-job-status{color:var(--kb-on-success)}',
        '.kb-progress{width:100%;height:4px;overflow:hidden;border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-3)}',
        '.kb-progress-bar{height:100%;width:0;border-radius:var(--kb-r-pill);background:var(--dsw-alias-brand-primary);transition:width var(--kb-normal) var(--kb-ease)}',
        '.kb-progress[data-indeterminate="true"] .kb-progress-bar{width:36%;animation:kb-indeterminate 1.2s var(--kb-ease) infinite}',
        '@keyframes kb-indeterminate{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}',
        '.kb-job-msg{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11.5px;line-height:1.5;color:var(--kb-text-tertiary);overflow-wrap:anywhere}',
        '.kb-job-percent{flex:none}',
        '/* ==== 搜索框（胶囊）==== */',
        '.kb-search{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2);transition:border-color var(--kb-fast) var(--kb-ease),box-shadow var(--kb-fast) var(--kb-ease),background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-root .kb-search:focus-within{border-color:var(--kb-field-focus);box-shadow:var(--kb-field-ring)}',
        '.kb-search-icon{display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}',
        '.kb-search-input{flex:1 1 auto;min-width:0;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4}',
        '.kb-search-input::placeholder{color:var(--kb-text-tertiary)}',
        '/* ==== 素材列表 / 分组列表（inset grouped）==== */',
        '.kb-source-list{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-source{position:relative;display:flex;flex-direction:column;min-width:0}',
        '.kb-source+.kb-source::before{content:"";position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-source-row{display:flex;align-items:center;gap:2px;min-width:0;padding:0 4px 0 10px}',
        '.kb-source-main{flex:1 1 auto;display:flex;align-items:flex-start;gap:8px;min-width:0;min-height:40px;padding:8px 4px 8px 0;border:0;border-radius:var(--kb-r-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-status-dot{flex:none;width:7px;height:7px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.kb-status-dot[data-status="ready"]{background:var(--dsw-alias-state-success-primary)}',
        '.kb-status-dot[data-status="compiling"],.kb-status-dot[data-status="parsing"]{background:var(--dsw-alias-state-business-primary)}',
        '.kb-status-dot[data-status="queued"]{background:var(--dsw-alias-label-caption)}',
        '.kb-status-dot[data-status="failed"]{background:var(--dsw-alias-state-error-primary)}',
        '.kb-source-body{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.kb-source-title{font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
        '.kb-source-meta{display:flex;align-items:center;gap:5px;min-width:0;font-size:11.5px;line-height:1.4;color:var(--kb-text-tertiary);white-space:nowrap;overflow:hidden}',
        '.kb-meta-dot{flex:none;width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
        '.kb-source-actions{flex:none;display:inline-flex;align-items:center;gap:2px;padding-right:2px;opacity:.72;transition:opacity var(--kb-fast) var(--kb-ease)}',
        '.kb-source-confirm{display:flex;flex-direction:column;gap:6px;margin:0 2px 8px;padding:var(--kb-s2);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,var(--kb-hairline));border-radius:var(--kb-r-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}',
        '.kb-confirm-hint{font-size:11px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-groups{display:flex;flex-direction:column;gap:var(--kb-s5)}',
        '.kb-group{display:flex;flex-direction:column;gap:4px;min-width:0}',
        '.kb-group-head{display:flex;align-items:center;gap:6px;height:26px;padding:0 2px;border:0;background:transparent;color:var(--kb-text-tertiary);font:inherit;font-size:11px;font-weight:600;line-height:1;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;text-align:left}',
        '.kb-group-caret{display:inline-flex;align-items:center;color:var(--dsw-alias-label-caption)}',
        '.kb-group-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;letter-spacing:.06em}',
        '.kb-group-count{flex:none;font-size:11px;font-weight:500;color:var(--kb-text-caption);text-transform:none;letter-spacing:0;font-variant-numeric:tabular-nums}',
        '.kb-group-items{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-page-item{position:relative;display:flex;align-items:center;width:100%;min-height:40px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1.4;text-align:left;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-page-item+.kb-page-item::before{content:"";position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-page-item[data-active="true"]{background:var(--kb-tint);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
        '.kb-page-item-title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-page-manage-item{position:relative;display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:1.4;text-align:left;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-page-manage-item+.kb-page-manage-item::before{content:"";position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-page-manage-item[data-selected="true"]{background:var(--kb-tint);color:var(--dsw-alias-label-primary)}',
        '.kb-page-manage-item[data-disabled="true"]{cursor:default;opacity:.5}',
        '.kb-page-manage-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-source-selected{background:var(--kb-tint)}',
        '.kb-manage-bar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;row-gap:4px;min-height:30px;height:auto;padding:3px 8px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2)}',
        '.kb-manage-text{font-size:12px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.kb-checkbox{flex:none;width:16px;height:16px;margin:0;border-radius:var(--kb-r-xs);accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
        '.kb-checkbox:disabled{cursor:default;opacity:.45}',
        '.kb-checkbox:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px;box-shadow:var(--kb-ring)}',
        '/* ==== 素材 tab：素材库独立页（v0.3.0）==== */',
        '.kb-sources{display:flex;flex-direction:column;gap:var(--kb-s5);width:100%;max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s7) var(--kb-s7) var(--kb-s8)}',
        '.kb-sources-head{display:flex;align-items:flex-start;flex-wrap:wrap;gap:var(--kb-s2)}',
        '.kb-sources-head .kb-ask-titles{flex:1 1 240px}',
        '.kb-sources-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:var(--kb-s2)}',
        '.kb-filter-chips{display:inline-flex;align-items:center;gap:2px;padding:3px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-surface-2)}',
        '.kb-filter-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 11px;border:0;border-radius:var(--kb-r-pill);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-filter-chip:hover:not([data-active="true"]){color:var(--dsw-alias-label-primary)}',
        '.kb-filter-chip[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:var(--dsw-elevation-prominent)}',
        '.kb-filter-count{font-size:10.5px;font-weight:500;color:var(--kb-text-caption);font-variant-numeric:tabular-nums}',
        '.kb-filter-chip[data-active="true"] .kb-filter-count{color:var(--dsw-alias-brand-primary)}',
        '.kb-sources .kb-filter-input{flex:0 0 200px;width:200px;height:30px;margin-left:auto}',
        '.kb-manage-bar-page{min-height:38px;height:auto;padding:4px 12px;border-radius:var(--kb-r-lg)}',
        '.kb-manage-selectall{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;-webkit-user-select:none}',
        '.kb-modal .kb-upload .kb-nav-head{display:none}',
        '.kb-sources-card{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-source-item{position:relative;display:flex;align-items:center;gap:var(--kb-s3);min-height:68px;padding:12px 16px}',
        '.kb-source-item+.kb-source-item::before{content:"";position:absolute;left:14px;right:14px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-source-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.kb-source-item-main{flex:1 1 auto;display:flex;align-items:flex-start;gap:var(--kb-s2);min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.kb-source-item .kb-source-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
        '.kb-source-item .kb-source-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;max-width:100%;font-size:14px;font-weight:500;line-height:1.5;white-space:normal;overflow:hidden;overflow-wrap:anywhere}',
        '.kb-source-item .kb-source-meta{display:flex;align-items:center;gap:5px;min-width:0;font-size:11.5px;line-height:1.4;color:var(--kb-text-caption);white-space:nowrap;overflow:hidden}',
        '.kb-source-item-actions{flex:none;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.kb-source-item-manage{cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-source-item-manage:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '/* ==== 原文查看弹层（v0.5.0）==== */',
        '.kb-original-body{display:flex;flex-direction:column;gap:var(--kb-s2);min-width:0}',
        '.kb-original-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-original-pre{max-height:54vh;overflow:auto;margin:0;padding:20px 24px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--kb-font);font-size:15px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;tab-size:2;scrollbar-gutter:stable}',
        '.kb-original-pre:focus-visible{outline:none;box-shadow:var(--kb-ring)}',
        '.kb-original-hint{font-size:11.5px;line-height:1.5;color:var(--kb-text-caption)}',
        // Material sections share the same reading window. Dimensions below are project choices.
        '.kb-material-sections{display:flex;flex-wrap:wrap;gap:4px 6px;min-width:0;border-bottom:1px solid var(--kb-separator);padding-bottom:6px}',
        '.kb-modal .kb-material-sections .kb-graph-chip{height:auto;min-height:32px;padding:5px 10px;border-radius:7px;color:var(--dsw-alias-label-primary);font-size:.8125rem;white-space:normal;line-height:1.45;text-align:left;opacity:1}',
        '.kb-modal .kb-material-sections .kb-graph-chip[aria-pressed="true"]{background:var(--kb-selection);font-weight:600}',
        '.kb-material-reading{min-width:0}',
        '.kb-material-pane{max-height:54dvh;overflow:auto;overscroll-behavior:contain;min-width:0;padding:12px 14px;border:1px solid var(--kb-separator);border-radius:10px;background:var(--kb-panel);color:var(--kb-ink);overflow-wrap:anywhere}',
        '.kb-material-pane-heading{display:flex;align-items:center;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;margin-bottom:8px}',
        '.kb-material-list{margin:0;list-style:none}',
        '.kb-material-list>li+li{border-top:1px solid var(--kb-separator)}',
        '.kb-material-quote{margin:0;padding:9px 0;color:var(--kb-ink);font-size:.875rem;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.kb-material-list>li>.kb-original-hint{display:block;padding-bottom:8px;overflow-wrap:anywhere}',
        '.kb-material-versions{min-width:0;padding:0 8px;border:1px solid var(--kb-separator);border-radius:8px;color:var(--kb-ink-secondary);font-size:.8125rem}',
        '.kb-material-versions summary{min-height:32px;padding:6px 0;cursor:pointer;overflow-wrap:anywhere}',
        '.kb-material-versions .kb-material-list{padding:0}',
        '.kb-material-link{display:flex;align-items:baseline;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;width:100%;min-height:32px;padding:5px 6px;border:0;border-radius:6px;background:transparent;color:var(--kb-ink);font:inherit;text-align:left;overflow-wrap:anywhere;cursor:pointer}',
        '.kb-material-link:hover:not(:disabled){background:var(--kb-soft)}',
        '.kb-material-link:disabled{color:var(--kb-ink-secondary);cursor:default}',
        '@media (pointer:coarse){.kb-modal .kb-material-sections .kb-graph-chip,.kb-material-versions summary,.kb-material-link,.kb-material-pane .kb-linkbtn{min-height:44px}}',
        '/* ==== 按钮（§5.1，控件 30/26，图标 28）==== */',
        '.kb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;height:auto;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--kb-r-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease),border-color var(--kb-fast) var(--kb-ease),transform var(--kb-fast) var(--kb-ease),opacity var(--kb-fast) var(--kb-ease)}',
        '.kb-btn:active:not(:disabled){transform:scale(.985)}',
        '.kb-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
        '.kb-btn-primary:hover:not(:disabled){filter:brightness(1.05)}',
        '.kb-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}',
        '.kb-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--kb-on-error)}',
        '.kb-btn-danger-fill{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}',
        '.kb-btn:disabled{opacity:1;background:var(--kb-surface-2);border-color:var(--kb-hairline);color:var(--kb-text-caption);filter:none;cursor:default}',
        '.kb-btn-primary:disabled{background:var(--kb-surface-3);color:var(--kb-text-caption)}',
        '.kb-btn-sm{min-height:32px;padding:7px 10px;font-size:12px;gap:5px}',
        '.kb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:.5px solid transparent;border-radius:var(--kb-r-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease),border-color var(--kb-fast) var(--kb-ease)}',
        '.kb-iconbtn-danger{color:var(--dsw-alias-state-error-primary)}',
        '.kb-linkbtn{display:inline-flex;align-items:center;height:26px;padding:0 8px;border:0;border-radius:var(--kb-r-pill);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '/* ==== 输入（30/32，§5.4）==== */',
        '.kb-input{flex:1 1 auto;min-width:0;min-height:34px;height:auto;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--kb-r-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;outline:none;transition:border-color var(--kb-fast) var(--kb-ease),box-shadow var(--kb-fast) var(--kb-ease),background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-input::placeholder,.kb-textarea::placeholder,.kb-composer-input::placeholder{color:var(--kb-text-tertiary)}',
        '.kb-root :is(.kb-input,.kb-textarea,.kb-select):is(:focus,:focus-visible){outline:none;outline-offset:0;border-color:var(--kb-field-focus);box-shadow:var(--kb-field-ring)}',
        '.kb-input:disabled,.kb-textarea:disabled{opacity:.45}',
        '.kb-textarea{width:100%;min-height:74px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--kb-r-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.6;resize:vertical;outline:none;transition:border-color var(--kb-fast) var(--kb-ease),box-shadow var(--kb-fast) var(--kb-ease)}',
        '.kb-select{min-height:34px;height:auto;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--kb-r-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;outline:none}',
        '.kb-inline-error{padding:8px 10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 26%,transparent);border-radius:var(--kb-r-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);color:var(--kb-on-error);font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
        '.kb-form-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}',
        '.kb-form-field{display:flex;flex-direction:column;gap:8px;min-width:0}',
        '.kb-form-field-narrow{max-width:220px}',
        '.kb-form-label{font-size:12px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.kb-form-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
        '.kb-form-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.kb-form-hint-warn{padding:8px 10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 42%,transparent);border-radius:var(--kb-r-sm);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 18%,transparent);color:var(--dsw-alias-label-secondary)}',
        '.kb-edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kb-s4)}',
        '.kb-edit-markdown{min-height:240px;font-family:var(--kb-mono);font-size:12px;line-height:1.6;resize:vertical}',
        '.kb-edit-saved{display:flex;flex-direction:column;gap:var(--kb-s3)}',
        '.kb-edit-success-head{display:flex;align-items:center;gap:8px;color:var(--kb-on-success);font-size:13.5px;font-weight:600;line-height:1.4}',
        '.kb-modal-warnings{display:flex;flex-direction:column;gap:6px;padding:var(--kb-s3);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 42%,transparent);border-radius:var(--kb-r-md);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 12%,transparent)}',
        '.kb-modal-warning-item{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.kb-confirm-list{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow-y:auto;padding:var(--kb-s2);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-2);scrollbar-gutter:stable}',
        '.kb-confirm-item{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-confirm-more{font-size:11px;line-height:1.5;color:var(--kb-text-caption)}',
        '/* ==== 通知胶囊（§5.7）==== */',
        // 通知默认贴右上角（macOS 通知习惯），避免遮住内容区左侧的标题/正文。
        '.kb-notices{position:absolute;top:calc(var(--dsh-frame-top-clearance,0px) + var(--kb-header-h) + var(--kb-s3));right:var(--kb-s4);z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:var(--kb-s2);width:max-content;max-width:min(520px,calc(100% - 32px));pointer-events:none}',
        '.kb-notice{display:flex;align-items:center;gap:8px;padding:10px 14px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-material-strong);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.4;pointer-events:auto;animation:kb-notice-in var(--kb-normal) var(--kb-ease-spring)}',
        '.kb-notice-info{color:var(--dsw-alias-label-primary)}',
        '.kb-notice-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,var(--kb-hairline));color:var(--kb-on-error)}',
        '.kb-notice-icon{display:inline-flex;align-items:center;color:var(--dsw-alias-state-success-primary)}',
        '.kb-notice[data-kind="warn"] .kb-notice-icon{color:var(--dsw-alias-label-secondary)}',
        '.kb-notice[data-kind="warn"] .kb-notice-text{color:var(--dsw-alias-label-secondary)}',
        '.kb-notice-error .kb-notice-icon{color:var(--dsw-alias-state-error-primary)}',
        '.kb-notice-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
        '@keyframes kb-notice-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}',
        '/* ==== Badge / Chip（胶囊）==== */',
        '.kb-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-surface-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1;white-space:nowrap}',
        '.kb-badge-type[data-type="source"],.kb-badge-type[data-type="sources"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--kb-on-business)}',
        '.kb-badge-type[data-type="entity"],.kb-badge-type[data-type="entities"]{background:var(--kb-tint);color:var(--dsw-alias-brand-primary)}',
        '.kb-badge-type[data-type="topic"],.kb-badge-type[data-type="topics"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--kb-on-success)}',
        '.kb-badge-type[data-type="synthesis"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 26%,transparent);color:var(--dsw-alias-label-secondary)}',
        '.kb-badge-confidence[data-level="extracted"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent);color:var(--kb-on-success)}',
        '.kb-badge-confidence[data-level="inferred"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--kb-on-business)}',
        '.kb-badge-confidence[data-level="ambiguous"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 30%,transparent);color:var(--dsw-alias-label-secondary)}',
        '.kb-badge-confidence[data-level="unverified"]{background:var(--dsw-alias-bg-layer-3);color:var(--kb-text-tertiary)}',
        '.kb-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 30%,transparent);color:var(--dsw-alias-label-secondary)}',
        '.kb-badge-kind{background:var(--kb-surface-2);color:var(--kb-text-tertiary)}',
        '.kb-chip{display:inline-flex;align-items:center;height:22px;padding:0 9px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-surface-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:500;line-height:1;white-space:nowrap}',
        '.kb-chip-sm{height:20px;padding:0 8px;font-size:11px}',
        '.kb-sev{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-surface-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;line-height:1;white-space:nowrap}',
        '.kb-sev[data-severity="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--kb-on-error)}',
        '.kb-sev[data-severity="warning"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 26%,transparent);color:var(--dsw-alias-label-secondary)}',
        '.kb-sev[data-severity="info"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--kb-on-business)}',
        '/* ==== 总览（§4 内容 940 居中）==== */',
        '.kb-overview{display:flex;flex-direction:column;gap:var(--kb-s6);max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s7) var(--kb-s7) var(--kb-s8);width:100%}',
        '.kb-overview-head{display:flex;align-items:baseline;gap:var(--kb-s3);flex-wrap:wrap}',
        '.kb-overview-sub{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.5;color:var(--kb-text-tertiary);flex-wrap:wrap}',
        '.kb-purpose{display:flex;flex-direction:column;gap:var(--kb-s2);padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-purpose-textarea{min-height:76px;background:var(--dsw-alias-bg-base)}',
        '.kb-purpose-foot{display:flex;align-items:center;gap:8px}',
        '.kb-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--kb-s3)}',
        '.kb-stat{display:flex;flex-direction:column;gap:4px;padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-stat-value{font-size:20px;font-weight:600;line-height:1.2;letter-spacing:-0.01em}',
        '.kb-stat-label{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.kb-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--kb-s4)}',
        '.kb-panel{display:flex;flex-direction:column;gap:var(--kb-s2);min-width:0;padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-list{display:flex;flex-direction:column}',
        '.kb-list-item{display:flex;align-items:center;gap:8px;min-height:40px;padding:6px 10px;border:0;border-radius:var(--kb-r-sm);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-list-main{flex:1 1 auto;display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.kb-list-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
        '.kb-list-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11.5px;line-height:1.4;color:var(--kb-text-tertiary)}',
        '.kb-list-time{flex:none;font-size:11px;line-height:1.4;color:var(--kb-text-caption);font-variant-numeric:tabular-nums}',
        '.kb-graph-preview{padding:var(--kb-s3) var(--kb-s4)}',
        '.kb-mini-graph{display:block;width:100%;height:180px;overflow:hidden;border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-base)}',
        '.kb-mini-graph svg{display:block;width:100%;height:100%}',
        '/* ==== 阅读器（§5.5）==== */',
        '.kb-reader{display:block;width:100%;max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s6) var(--kb-s7) var(--kb-s8)}',
        '.kb-reader-inner{max-width:760px;margin-inline:auto}',
        '.kb-reader-top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:var(--kb-s5);padding:10px 0;background:var(--kb-material);-webkit-backdrop-filter:blur(18px) saturate(160%);backdrop-filter:blur(18px) saturate(160%)}',
        '.kb-reader-actions{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.kb-page-title{margin:0 0 var(--kb-s2)}',
        '.kb-page-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 var(--kb-s4);border-bottom:.5px solid var(--kb-hairline);color:var(--kb-text-tertiary);font-size:12px;line-height:1.5}',
        '.kb-page-time{font-size:11.5px;line-height:1.4;color:var(--kb-text-caption)}',
        '.kb-page-aliases{display:flex;gap:6px;flex-wrap:wrap;padding-top:var(--kb-s2);font-size:12px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-page-aliases-label{color:var(--kb-text-caption)}',
        '.kb-page-edited{display:flex;align-items:center;gap:6px;padding-top:var(--kb-s2);font-size:11.5px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-page-body{padding:var(--kb-s5) 0 var(--kb-s2);font-size:15px;line-height:1.78}',
        '.kb-reader-foot{margin-top:var(--kb-s6)}',
        '.kb-linklist{overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-linkitem{position:relative;display:flex;align-items:center;width:100%;min-height:36px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;font-weight:500;line-height:1.4;text-align:left;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-linkitem+.kb-linkitem::before{content:"";position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-linkitem-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-sourceref{position:relative;display:flex;align-items:center;gap:8px;min-height:36px;padding:0 12px;flex-wrap:wrap}',
        '.kb-sourceref+.kb-sourceref::before{content:"";position:absolute;left:12px;right:12px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-sourceref-main{flex:1 1 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.kb-sourceref-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
        '.kb-sourceref-status{font-size:11px;line-height:1.4;color:var(--kb-text-caption)}',
        '.kb-sourceref-actions{flex:none;display:inline-flex;align-items:center;gap:8px}',
        '.kb-wikilink{display:inline;padding:1px 5px;border:0;border-radius:var(--kb-r-xs);background:var(--kb-tint);color:var(--dsw-alias-brand-primary);font:inherit;line-height:inherit;text-decoration:none;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-wikilink-missing{background:transparent;color:var(--kb-text-tertiary);border:.5px dashed var(--dsw-alias-border-l4);cursor:help}',
        '/* ==== Markdown 排版（§3/§5.5）==== */',
        '.kb-md{font-family:var(--kb-font);font-size:15px;line-height:1.78;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;user-select:text}',
        '.kb-md>:first-child{margin-top:0}',
        '.kb-md-p{margin:0 0 14px;line-height:1.9}',
        '.kb-md-h{margin:28px 0 10px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary)}',
        '.kb-md-h1{font-size:22px}',
        '.kb-md-h2{font-size:19px}',
        '.kb-md-h3{font-size:16px}',
        '.kb-md-list{margin:0 0 14px;padding-left:22px}',
        '.kb-md-list li{margin:4px 0}',
        '.kb-md-quote{margin:0 0 14px;padding:2px 0 2px 12px;border-left:2px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-secondary)}',
        '.kb-md-pre{margin:0 0 14px;padding:14px;overflow-x:auto;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-2);font-family:var(--kb-mono);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.kb-md-pre code{padding:0;border:0;background:none;font-family:inherit;font-size:inherit}',
        '.kb-md-code{padding:1px 5px;border-radius:var(--kb-r-xs);background:var(--dsw-alias-bg-layer-3);font-family:var(--kb-mono);font-size:12px}',
        '.kb-md-hr{height:0;margin:24px 0;border:0;border-top:.5px solid var(--kb-hairline)}',
        '.kb-md a{color:var(--dsw-alias-brand-primary);text-decoration:none;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}',
        '.kb-md strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.kb-md-table-wrap{margin:0 0 14px;overflow-x:auto;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md)}',
        '.kb-md-table{width:100%;border-collapse:collapse;font-size:12.5px;line-height:1.6}',
        '.kb-md-table th,.kb-md-table td{padding:6px 10px;border-bottom:.5px solid var(--kb-hairline);border-right:.5px solid var(--kb-hairline);text-align:left;vertical-align:top}',
        '.kb-md-table th{background:var(--dsw-alias-bg-layer-2);font-size:12px;font-weight:600}',
        '.kb-md-table tr:last-child td{border-bottom:0}',
        '.kb-md-table th:last-child,.kb-md-table td:last-child{border-right:0}',
        '.kb-cursor{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:text-bottom;background:var(--dsw-alias-brand-primary);animation:kb-blink 1s steps(1,end) infinite}',
        '@keyframes kb-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}',
        '/* ==== 搜索结果 ==== */',
        '.kb-search-results{display:flex;flex-direction:column;gap:6px;width:100%;max-width:var(--kb-content-max);margin:var(--kb-s5) auto 0;padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-search-result{align-items:flex-start}',
        '.kb-search-snippet{display:block;font-size:12px;line-height:1.6;color:var(--kb-text-tertiary);overflow-wrap:anywhere}',
        '/* ==== 初始化引导 ==== */',
        '.kb-init{display:flex;align-items:center;justify-content:center;min-height:440px;padding:var(--kb-s8) var(--kb-s6)}',
        '.kb-init-card{display:flex;flex-direction:column;align-items:center;gap:var(--kb-s2);max-width:560px;padding:var(--kb-s7) var(--kb-s6);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-2xl);background:var(--kb-material-card);box-shadow:var(--dsw-elevation-prominent);text-align:center}',
        '.kb-init-icon{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:var(--kb-r-xl);background:var(--kb-tint);color:var(--dsw-alias-brand-primary)}',
        '.kb-init-title{margin:var(--kb-s2) 0 0}',
        '.kb-init-desc{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
        '.kb-init-path{margin:0;font-family:var(--kb-mono);font-size:11.5px;line-height:1.5;color:var(--kb-text-caption);overflow-wrap:anywhere}',
        '/* ==== 图谱（§5.9）==== */',
        '/* ==== 概览小图谱（复用节点/边通用样式）==== */',
        '.kb-graph-edge{stroke:var(--dsw-alias-border-l3);stroke-width:1;stroke-opacity:.6}',
        '.kb-graph-node{cursor:pointer;outline:none}',
        '.kb-graph-circle{stroke:var(--dsw-alias-bg-base);stroke-width:1.5}',
        '.kb-graph-hit{fill:transparent;cursor:pointer}',
        '/* ==== 图谱页（v0.6.0：可缩放/筛选/聚焦的交互式图谱）==== */',
        '.kb-graph-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}',
        '.kb-graph-head{flex:0 0 auto;display:flex;align-items:flex-end;gap:var(--kb-s3);flex-wrap:wrap;padding:var(--kb-s5) var(--kb-s7) var(--kb-s3)}',
        '.kb-graph-head .kb-ask-titles{flex:1 1 260px}',
        '.kb-graph-head-actions{display:inline-flex;align-items:center;gap:var(--kb-s2)}',
        '.kb-graph-search{width:230px}',
        '.kb-graph-stage{position:relative;flex:1 1 auto;min-height:0;margin:0 var(--kb-s4) var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:color-mix(in srgb,var(--dsw-alias-bg-base) 97%,var(--dsw-alias-label-primary));overflow:hidden}',
        '.kb-graph-panlayer{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:grab;outline:none}',
        '.kb-graph-stage[data-dragging="true"] .kb-graph-panlayer{cursor:grabbing}',
        '.kb-graph-panlayer:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
        '.kb-graph-svg{display:block;width:100%;height:100%}',
        '.kb-graph-stage .kb-graph-edge{stroke-width:1.1;stroke-opacity:.5;transition:stroke-opacity var(--kb-fast) var(--kb-ease)}',
        '.kb-graph-stage .kb-graph-edge[data-relation="derived"]{stroke-dasharray:3 3;stroke-opacity:.4}',
        '.kb-graph-stage .kb-graph-edge[data-active="true"]{stroke:var(--dsw-alias-label-tertiary);stroke-opacity:.95}',
        '.kb-graph-stage .kb-graph-edge[data-dim="true"]{stroke-opacity:.1}',
        '.kb-graph-stage .kb-graph-node{cursor:pointer;outline:none}',
        '.kb-graph-halo{fill:none;pointer-events:all}',
        '.kb-graph-stage .kb-graph-circle{stroke-width:1.5;transition:filter var(--kb-fast) var(--kb-ease),stroke-width var(--kb-fast) var(--kb-ease)}',
        '.kb-graph-stage .kb-graph-node:hover .kb-graph-circle,.kb-graph-stage .kb-graph-node[data-selected="true"] .kb-graph-circle,.kb-graph-stage .kb-graph-node:focus-visible .kb-graph-circle{filter:brightness(1.1);stroke:var(--dsw-alias-label-primary);stroke-width:2}',
        '.kb-graph-stage .kb-graph-node[data-dim="true"]{opacity:.2}',
        '.kb-graph-stage .kb-graph-node[data-selected="true"] .kb-graph-halo{fill:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
        '.kb-graph-stage .kb-graph-label{fill:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;text-anchor:middle;paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:3.5;stroke-linejoin:round;pointer-events:none;user-select:none}',
        '.kb-graph-stage .kb-graph-node[data-dim="true"] .kb-graph-label{fill:var(--kb-text-caption)}',
        '.kb-graph-stage .kb-graph-node[data-match="true"] .kb-graph-label{fill:var(--dsw-alias-label-primary);font-weight:600}',
        '.kb-graph-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:var(--kb-r-pill);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease),opacity var(--kb-fast) var(--kb-ease)}',
        '.kb-graph-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-graph-chip[data-active="false"]{opacity:.42}',
        '.kb-graph-chip[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px var(--kb-hairline)}',
        '.kb-graph-chip-static{cursor:default;background:var(--dsw-alias-bg-layer-2)}',
        '.kb-graph-chip-static:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
        '.kb-graph-chip-dot{width:7px;height:7px;border-radius:50%;flex:none}',
        '.kb-graph-chip-count{font-size:10.5px;color:var(--kb-text-caption);font-variant-numeric:tabular-nums}',
        '.kb-graph-rel-line{width:16px;height:0;flex:none;border-top:1.5px solid var(--dsw-alias-border-l4)}',
        '.kb-graph-rel-line[data-relation="derived"]{border-top-style:dashed}',
        '.kb-graph-filter-sep{width:.5px;height:16px;margin:0 2px;background:var(--kb-hairline);flex:none}',
        '.kb-graph-toolbar{position:absolute;top:var(--kb-s3);right:var(--kb-s3);z-index:4;display:inline-flex;align-items:center;gap:2px;padding:3px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-material-strong);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);box-shadow:var(--dsw-elevation-prominent)}',
        '.kb-graph-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-graph-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-graph-iconbtn:focus-visible{outline:none;box-shadow:var(--kb-ring)}',
        '.kb-graph-zoom-label{min-width:34px;padding:0 2px;font-size:10.5px;line-height:1;color:var(--kb-text-caption);text-align:center;font-variant-numeric:tabular-nums}',
        '.kb-graph-hintbar{position:absolute;right:var(--kb-s3);bottom:var(--kb-s3);z-index:3;max-width:calc(100% - 340px);font-size:11px;line-height:1.5;color:var(--kb-text-caption);text-align:right;pointer-events:none}',
        '.kb-graph-search-note{position:absolute;left:50%;bottom:var(--kb-s3);transform:translateX(-50%);z-index:4;display:inline-flex;align-items:center;padding:3px;border-radius:var(--kb-r-pill)}',
        '.kb-graph-detail{position:absolute;top:calc(var(--kb-s3) + 40px);right:var(--kb-s3);z-index:5;display:flex;flex-direction:column;gap:var(--kb-s2);width:300px;max-height:calc(100% - var(--kb-s3) * 2 - 40px);overflow-y:auto;padding:var(--kb-s3);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-strong);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);box-shadow:var(--dsw-elevation-prominent);scrollbar-width:thin}',
        '.kb-graph-detail-head{display:flex;align-items:center;gap:6px;min-height:24px}',
        '.kb-graph-detail-close{margin-left:auto;display:inline-flex}',
        '.kb-graph-detail-title{margin:0;font-size:15px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}',
        '.kb-graph-detail-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-graph-tags{display:flex;flex-wrap:wrap;gap:4px}',
        '.kb-graph-tag{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2);font-size:10.5px;line-height:1;color:var(--kb-text-tertiary)}',
        '.kb-graph-detail-actions{display:flex;flex-wrap:wrap;gap:6px}',
        '.kb-graph-neighbors{display:flex;flex-direction:column;gap:2px;min-height:0;margin-top:2px}',
        '.kb-graph-nb-title{font-size:11px;font-weight:600;line-height:1.4;color:var(--kb-text-tertiary)}',
        '.kb-graph-nb{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 6px;border:0;border-radius:var(--kb-r-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
        '.kb-graph-nb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-graph-nb:focus-visible{outline:none;box-shadow:var(--kb-ring)}',
        '.kb-graph-nb-dot{width:7px;height:7px;border-radius:50%;flex:none}',
        '.kb-graph-nb-title-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-graph-nb-rel{flex:none;font-size:10px;line-height:1;color:var(--kb-text-caption)}',
        '.kb-graph-detail-empty{font-size:11.5px;line-height:1.5;color:var(--kb-text-caption)}',
        '.kb-graph-empty-note{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;display:flex;align-items:center;gap:8px;padding:10px 14px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--kb-material-strong);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:var(--dsw-elevation-prominent);font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.kb-graph-state{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:var(--kb-s7)}',
        "",
        ".kb-graph-view-switch{display:inline-flex;flex:none;padding:3px;border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2)}",
        ".kb-graph-copy{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
        ".kb-graph-reading{display:grid;grid-template-columns:minmax(240px,30%) minmax(0,1fr);flex:1;min-height:0;margin:0 var(--kb-s4) var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
        ".kb-graph-catalog{display:flex;flex-direction:column;gap:12px;min-height:0;padding:16px;border-right:.5px solid var(--kb-hairline);background:var(--dsw-alias-bg-base)}",
        ".kb-graph-catalog-modes{display:flex;gap:4px;flex-wrap:wrap}",
        ".kb-graph-catalog-modes .kb-graph-chip,.kb-graph-view-switch .kb-graph-chip{height:auto;min-height:32px;white-space:normal;line-height:1.4;text-align:left}",
        ".kb-graph-catalog-list{min-height:0;overflow:auto;scrollbar-width:thin}",
        '.kb-graph-catalog-modes .kb-graph-chip[data-active="false"],.kb-graph-view-switch .kb-graph-chip[data-active="false"]{opacity:1;color:var(--dsw-alias-label-secondary)}',
        ".kb-graph-catalog-row{display:flex;flex-direction:column;gap:4px;width:100%;min-height:60px;padding:12px 10px;border:0;border-radius:var(--kb-r-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}",
        ".kb-graph-catalog-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".kb-graph-catalog-row[aria-pressed=\"true\"]{background:var(--kb-tint);box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}",
        ".kb-graph-catalog-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
        ".kb-graph-catalog-title{font-size:13px;font-weight:550;line-height:1.55;overflow-wrap:anywhere}",
        ".kb-graph-catalog-meta{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
        ".kb-graph-reading-content{min-width:0;min-height:0;overflow:auto;padding:clamp(16px,3vw,36px);scrollbar-width:thin}",
        ".kb-graph-reading .kb-graph-detail{position:static;inset:auto;width:auto;max-height:none;overflow:visible;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;gap:18px}",
        ".kb-graph-reading .kb-graph-detail-title,.kb-graph-welcome h3{font-size:22px;line-height:1.45;font-weight:600;margin:0;overflow-wrap:anywhere}",
        ".kb-graph-welcome{display:flex;flex-direction:column;gap:18px;max-width:760px}",
        ".kb-graph-section{display:flex;flex-direction:column;gap:10px}",
        ".kb-graph-section h4{font-size:12px;line-height:1.5;margin:0;font-weight:600;color:var(--dsw-alias-label-primary)}",
        ".kb-graph-source-row{display:flex;align-items:baseline;gap:12px;padding:10px 0;border-bottom:.5px solid var(--kb-hairline)}",
        ".kb-graph-source-title{flex:1;min-width:0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}",
        ".kb-graph-relation-row{padding:8px 0;border-bottom:.5px solid var(--kb-hairline)}",
        ".kb-graph-relation-actions{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;padding:2px 6px}",
        ".kb-graph-relation-label{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
        ".kb-graph-reading .kb-graph-nb-title-text{white-space:normal;overflow:visible;overflow-wrap:anywhere}",
        ".kb-graph-reading .kb-graph-nb{min-height:36px}",
        ".kb-graph-evidence{padding:12px;margin:8px 6px;background:var(--dsw-alias-bg-base);border-left:2px solid var(--dsw-alias-brand-primary);border-radius:var(--kb-r-sm);font-size:12px;line-height:1.75;overflow-wrap:anywhere}",
        ".kb-graph-evidence p{margin:0 0 6px}",
        ".kb-graph-caveat{padding-top:14px;border-top:.5px solid var(--kb-hairline);font-size:11px}",
        "@media(max-width:760px){.kb-graph-reading{display:flex;flex-direction:column;overflow:auto}.kb-graph-catalog{flex:none;max-height:38vh;min-height:200px;border-right:0;border-bottom:.5px solid var(--kb-hairline)}.kb-graph-reading-content{flex:none;overflow:visible}.kb-graph-catalog-modes .kb-graph-chip,.kb-graph-view-switch .kb-graph-chip{min-height:44px}.kb-graph-reading .kb-graph-nb{min-height:44px}.kb-graph-source-row{flex-wrap:wrap}.kb-graph-reading .kb-linkbtn{min-height:44px;display:inline-flex;align-items:center}}",
        ".kb-topic-roots,.kb-topic-children{list-style:none;margin:0;padding:0}",
        ".kb-topic-children{margin-left:12px;padding-left:10px;border-left:1px solid var(--kb-hairline)}",
        ".kb-topic-row{display:flex;align-items:center;min-width:0;border-radius:var(--kb-r-sm)}",
        ".kb-topic-row[data-selected=\"true\"]{background:var(--kb-tint);box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}",
        ".kb-topic-disclosure,.kb-topic-spacer{width:28px;min-width:28px;min-height:36px;display:inline-flex;align-items:center;justify-content:center;background:none;border:0;color:var(--dsw-alias-label-secondary)}",
        ".kb-topic-disclosure{cursor:pointer}",
        ".kb-topic-select{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:42px;padding:8px 6px;background:transparent;border:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5;text-align:left;cursor:pointer}",
        ".kb-topic-select>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}",
        ".kb-topic-count{font-size:11px;color:var(--dsw-alias-label-secondary)}",
        ".kb-topic-row:hover,.kb-topic-child-link:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".kb-topic-select:focus-visible,.kb-topic-disclosure:focus-visible,.kb-topic-child-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:var(--kb-r-sm)}",
        ".kb-topic-breadcrumb{display:flex;gap:6px;flex-wrap:wrap}",
        ".kb-topic-child-link{padding:10px 12px;min-height:40px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;text-align:left;overflow-wrap:anywhere;cursor:pointer}",
        ".kb-entity-categories{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px}",
        ".kb-entity-categories .kb-graph-chip{height:auto;min-height:32px;white-space:normal;line-height:1.4}",
        ".kb-entity-categories .kb-graph-chip[data-active=\"false\"]{opacity:1}",
        ".kb-entity-select{width:100%;margin-bottom:8px}",
        ".kb-taxonomy-form{display:flex;flex-direction:column;gap:16px}",
        ".kb-taxonomy-form .kb-select{width:100%;max-width:100%}",
        ".kb-graph-stage .kb-graph-edge[data-relation=\"topic\"]{stroke:var(--dsw-alias-state-success-primary);stroke-width:1.8;stroke-opacity:.7}",
        ".kb-graph-rel-line[data-relation=\"topic\"]{border-top-color:var(--dsw-alias-state-success-primary);border-top-width:2px}",
        "@media(max-width:760px){.kb-topic-disclosure,.kb-topic-select,.kb-topic-child-link,.kb-entity-categories .kb-graph-chip{min-height:44px}.kb-topic-disclosure,.kb-topic-spacer{min-width:36px;width:36px}.kb-topic-children{margin-left:8px;padding-left:6px}}",
        '.kb-topic-item{min-width:0}',
        '.kb-topic-outline,.kb-entity-catalog{min-width:0}',
        '.kb-graph-detail>.kb-badge{align-self:flex-start}',
        ".kb-books,.kb-book-detail{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0}",
        ".kb-book-detail{overflow:auto;overscroll-behavior:contain}",
        ".kb-books-head,.kb-book-detail-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:24px 32px 16px}",
        ".kb-books-head>div:first-child,.kb-book-titles{min-width:0;flex:1 1 220px}",
        ".kb-book-titles .kb-overview-title{font-size:22px;line-height:1.4}",
        ".kb-books-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".kb-books-scroll{min-height:0;overflow:auto;padding:0 32px 32px;scrollbar-width:thin}",
        ".kb-books-file-input{display:none}",
        ".kb-books-intro{margin:0 0 24px;max-width:780px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.8}",
        ".kb-book-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:18px}",
        ".kb-book-card{display:flex;flex-direction:column;gap:16px;padding:20px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--dsw-alias-bg-layer-1);min-width:0}",
        ".kb-book-card-open{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:100%;text-align:left;border-radius:var(--kb-r-sm)}",
        ".kb-book-cover{display:flex;align-items:center;justify-content:center;width:56px;height:70px;border-radius:6px 10px 10px 6px;border-left:4px solid var(--dsw-alias-label-tertiary);background:var(--kb-surface-2);color:var(--dsw-alias-label-primary);margin-bottom:4px}",
        ".kb-book-card-title{font-size:17px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}",
        ".kb-book-card-name{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
        ".kb-book-card-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto}",
        ".kb-book-progress{display:flex;flex-direction:column;gap:8px}",
        ".kb-book-progress-label{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}",
        ".kb-book-progress progress{width:100%;height:5px;accent-color:var(--dsw-alias-brand-primary);border:0;border-radius:4px}",
        ".kb-book-warning{margin:0;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-primary);padding:10px 12px;border-left:2px solid var(--dsw-alias-state-warn-tertiary);background:var(--kb-surface-2);border-radius:var(--kb-r-sm)}",
        ".kb-book-import-status{display:flex;align-items:center;gap:8px;padding:12px 0;font-size:12px}",
        ".kb-book-summary{display:flex;flex-direction:column;gap:6px;flex-shrink:0}",
        ".kb-book-warnings{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}",
        ".kb-book-warnings summary{cursor:pointer;color:var(--dsw-alias-label-primary)}",
        ".kb-book-warnings p{margin:8px 0}",
        ".kb-book-modes{display:flex;gap:4px;flex-wrap:wrap;padding:4px 32px 14px}",
        ".kb-book-modes .kb-graph-chip,.kb-book-modes .kb-graph-chip[data-active=\"false\"]{min-height:32px;opacity:1}",
        ".kb-book-workspace{display:grid;grid-template-columns:minmax(200px,28%) minmax(0,1fr);flex:1;min-height:0;margin:0 16px 16px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
        ".kb-book-workspace[hidden],.kb-book-ask[hidden]{display:none}",
        ".kb-book-nav{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;padding:14px;border-right:.5px solid var(--kb-hairline);background:var(--dsw-alias-bg-base);scrollbar-width:thin}",
        ".kb-book-nav-row{flex:none;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:10px;min-height:54px;width:100%;text-align:left;border-radius:var(--kb-r-sm)}",
        ".kb-book-nav-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
        ".kb-book-nav-row[aria-current=\"page\"]{background:var(--kb-tint);box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}",
        ".kb-book-nav-title{font-size:12px;line-height:1.6;overflow-wrap:anywhere}",
        ".kb-book-nav-meta,.kb-book-nav-snippet{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
        ".kb-book-reader{min-width:0;min-height:0;overflow:auto;padding:clamp(16px,3vw,32px);scrollbar-width:thin}",
        ".kb-book-reader .kb-page-title{font-size:22px;line-height:1.4;margin:12px 0 20px}",
        ".kb-book-reader-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".kb-book-original{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px;line-height:1.9;margin:0;color:var(--dsw-alias-label-primary)}",
        ".kb-book-reading-sources{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:28px;padding-top:16px;border-top:.5px solid var(--kb-hairline)}",
        ".kb-book-reading-sources h4{margin:0 0 6px;font-size:12px}",
        ".kb-book-ask{flex:1 0 14rem;min-width:0;display:flex}",
        ".kb-book-ask-inner{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}",
        ".kb-book-ask-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}",
        ".kb-book-messages{display:flex;flex-direction:column;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}",
        ".kb-book-question{margin:0}",
        "@container kb-panel (max-width:760px){.kb-books-head,.kb-book-detail-head{padding:18px 16px 12px;gap:12px}.kb-books-scroll{padding:0 16px 20px}.kb-book-workspace{display:flex;flex-direction:column;overflow:auto}.kb-book-nav{flex:none;max-height:32vh;min-height:160px;border-right:0;border-bottom:.5px solid var(--kb-hairline)}.kb-book-reader{flex:none;overflow:visible}.kb-book-nav-row,.kb-book-modes .kb-graph-chip,.kb-book-card-footer button{min-height:44px}}",
        "@media(prefers-reduced-motion:reduce){.kb-book-progress progress{transition:none}}",
        '/* ==== 问答（§5.9）==== */',
        '.kb-ask{display:flex;flex-direction:column;height:100%;min-height:0}',
        '.kb-ask-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s5) var(--kb-s7) var(--kb-s2)}',
        '.kb-ask-titles{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.kb-ask-sub{font-size:12px;line-height:1.5;color:var(--kb-text-tertiary)}',
        '.kb-ask-scroll{flex:1 1 auto;display:flex;flex-direction:column;gap:var(--kb-s6);width:100%;max-width:var(--kb-content-max);margin-inline:auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:var(--kb-s2) var(--kb-s7) var(--kb-s5);scrollbar-width:thin;scrollbar-color:var(--kb-separator) transparent}',
        '.kb-msg{display:flex;flex-direction:column;min-width:0;width:100%;max-width:760px;margin-inline:auto}',
        '.kb-msg-user{align-items:flex-end}',
        '.kb-msg-role{display:flex;align-items:center;gap:5px;margin-bottom:5px;font-size:11px;line-height:1.4;color:var(--kb-text-tertiary)}',
        '.kb-avatar{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:var(--kb-r-xs);background:var(--kb-tint);color:var(--dsw-alias-brand-primary)}',
        '.kb-msg-user-bubble{max-width:86%;padding:10px 14px;border:.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);border-radius:var(--kb-r-xl);border-bottom-right-radius:var(--kb-r-xs);background:var(--kb-tint);color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}',
        '.kb-msg-assistant{align-items:stretch}',
        '.kb-msg-body{min-width:0;padding:var(--kb-s3) var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-xl);background:var(--dsw-alias-bg-layer-1)}',
        '.kb-msg-thinking{display:flex;align-items:center;gap:8px;color:var(--kb-text-tertiary);font-size:12px;line-height:1.5}',
        '.kb-refs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;font-size:11px;line-height:1.4;color:var(--kb-text-caption)}',
        '.kb-refs-label{flex:none}',
        '.kb-refs-empty{color:var(--kb-text-caption)}',
        '.kb-ref-chip{display:inline-flex;align-items:center;gap:4px;max-width:100%;height:24px;padding:0 9px;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-pill);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.2;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:background-color var(--kb-fast) var(--kb-ease),color var(--kb-fast) var(--kb-ease)}',
        '.kb-ref-chip:disabled{opacity:.55;cursor:default}',
        '.kb-msg-error{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent);border-radius:var(--kb-r-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}',
        '.kb-msg-error-text{flex:1 1 auto;margin:0;color:var(--kb-on-error);font-size:12px;line-height:1.5;overflow-wrap:anywhere}',
        '.kb-msg-status{display:flex;align-items:center;gap:8px;margin-top:6px;color:var(--kb-text-tertiary);font-size:12px;line-height:1.5}',
        '.kb-composer{flex:0 0 auto;width:100%;max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s2) var(--kb-s7) var(--kb-s5)}',
        '.kb-ask-hint{margin-bottom:5px;font-size:11px;line-height:1.5;color:var(--kb-text-caption)}',
        '.kb-composer-box{display:grid;gap:6px;min-width:0;padding:8px 10px 10px;border:1px solid var(--kb-separator);border-radius:12px;background:var(--kb-panel);transition:border-color var(--kb-fast) var(--kb-ease),box-shadow var(--kb-fast) var(--kb-ease)}',
        '.kb-root .kb-composer-box:focus-within{border-color:var(--kb-field-focus);box-shadow:var(--kb-field-ring)}',
        // 输入框按内容增高，长问题只滚动文字，操作始终在下方。
        '.kb-composer-input{display:block;width:100%;min-width:0;min-height:2.4em;max-height:clamp(3em,21dvh,8em);padding:6px 4px;border:0;outline:none;resize:none;field-sizing:content;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--kb-separator) transparent;background:transparent;color:var(--kb-ink);font:inherit;font-size:.875rem;line-height:1.55}',
        // 内部编辑区不再叠加通用 :focus-visible 的矩形轮廓，由外层容器承担焦点提示。
        '.kb-root :is(.kb-composer-input,.kb-search-input):is(:focus,:focus-visible){border:0;outline:none;outline-offset:0;box-shadow:none}',
        '@media (forced-colors:active){.kb-root :is(.kb-input,.kb-textarea,.kb-select):is(:focus,:focus-visible),.kb-root :is(.kb-composer-box,.kb-search):focus-within{outline:2px solid Highlight;outline-offset:2px;box-shadow:none}}',
        '.kb-composer-actions{display:flex;align-items:center;flex-wrap:wrap;gap:5px 10px;padding-inline:4px 0}',
        '.kb-composer-keys{min-width:0;color:var(--kb-ink-secondary);font-size:.6875rem;line-height:1.45}',
        '.kb-composer-actions .kb-send{flex:none;min-height:32px;min-width:60px;height:auto;margin-left:auto;padding:5px 12px;border-radius:8px;font-size:.8125rem;line-height:1.35;white-space:normal}',
        '.kb-composer-actions .kb-send:disabled{opacity:1;background:var(--kb-soft);color:var(--kb-ink-secondary);border-color:transparent}',
        '@container kb-panel (max-width:440px){.kb-composer-keys{display:none}}',
        '/* ==== 健康 + 回收站（§5.9）==== */',
        '.kb-health{display:flex;flex-direction:column;gap:var(--kb-s4);width:100%;max-width:var(--kb-content-max);margin-inline:auto;padding:var(--kb-s7) var(--kb-s7) var(--kb-s8)}',
        '.kb-health-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.kb-health-body{display:flex;flex-direction:column;gap:var(--kb-s4)}',
        '.kb-health-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:var(--kb-s3) var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--kb-material-card);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.kb-health-time{margin-left:auto;font-size:11px;color:var(--kb-text-caption)}',
        '.kb-health-good{display:flex;align-items:center;gap:var(--kb-s3);padding:var(--kb-s5);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);border-radius:var(--kb-r-lg);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 6%,transparent)}',
        '.kb-health-good-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--kb-r-pill);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}',
        '.kb-health-good-title{font-size:13.5px;font-weight:600;line-height:1.4;color:var(--kb-on-success)}',
        '.kb-health-good-hint{font-size:12px;line-height:1.5;color:var(--kb-on-success)}',
        '.kb-health-group{display:flex;flex-direction:column;gap:var(--kb-s2);padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-health-group-head{display:flex;align-items:baseline;gap:8px}',
        '.kb-health-issues{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-1)}',
        '.kb-health-issue{position:relative;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;transition:background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-health-issue+.kb-health-issue::before{content:"";position:absolute;left:10px;right:10px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-health-issue-main{flex:1 1 auto;display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.kb-health-detail{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
        '.kb-health-page{font-family:var(--kb-mono);font-size:11px;line-height:1.4;color:var(--kb-text-caption);overflow-wrap:anywhere}',
        '.kb-health-issue .kb-linkbtn{align-self:flex-start;margin-top:2px}',
        '.kb-trash{display:flex;flex-direction:column;gap:var(--kb-s3);padding:var(--kb-s4);border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-lg);background:var(--kb-material-card)}',
        '.kb-trash-list{display:flex;flex-direction:column;max-height:260px;overflow-y:auto;overflow:auto;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-md);background:var(--dsw-alias-bg-layer-1);scrollbar-gutter:stable}',
        '.kb-trash-item{position:relative;display:flex;align-items:center;gap:8px;min-height:40px;padding:6px 10px;transition:background-color var(--kb-fast) var(--kb-ease)}',
        '.kb-trash-item+.kb-trash-item::before{content:"";position:absolute;left:10px;right:10px;top:0;height:.5px;background:var(--kb-hairline)}',
        '.kb-trash-main{flex:1 1 auto;display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.kb-trash-title{font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.kb-trash-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:1.4;color:var(--kb-text-caption)}',
        '.kb-trash-actions{flex:none;display:inline-flex;align-items:center;gap:6px}',
        '.kb-trash-note{font-size:11px;line-height:1.5;color:var(--kb-text-caption)}',
        '.kb-trash-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}',
        '.kb-trash-empty{padding:var(--kb-s3) var(--kb-s1);font-size:12px;line-height:1.5;color:var(--kb-text-tertiary);display:flex;align-items:center;gap:8px}',
        '/* ==== 空 / 加载 / 错误（§5.8）==== */',
        '.kb-loading{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:var(--kb-s8) var(--kb-s6);color:var(--kb-text-tertiary);font-size:12px;line-height:1.5}',
        '.kb-loading-col{flex-direction:column;align-items:flex-start;justify-content:flex-start;padding:var(--kb-s6) var(--kb-s7)}',
        '.kb-spinner{flex:none;width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:kb-spin .8s linear infinite}',
        '.kb-spinner-sm{width:12px;height:12px;border-width:2px}',
        '@keyframes kb-spin{to{transform:rotate(1turn)}}',
        '.kb-error-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
        '.kb-error-inline-text{color:var(--kb-on-error);font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}',
        '.kb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:280px;padding:var(--kb-s8) var(--kb-s6);text-align:center;color:var(--kb-text-tertiary)}',
        '.kb-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:var(--kb-s2);border-radius:12px;background:var(--kb-tint);color:var(--dsw-alias-brand-primary)}',
        '.kb-empty-title{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
        '.kb-empty-hint{max-width:430px;margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
        '.kb-empty-action{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;margin-top:var(--kb-s2)}',
        '.kb-library{display:flex;flex-direction:column;min-height:100%}',
        '/* ==== Modal / Sheet（§5.6）==== */',
        '.kb-modal-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:var(--kb-s6);background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
        '.kb-sheet,.kb-modal{display:flex;flex-direction:column;width:min(540px,100%);max-height:86vh;overflow:hidden;border:.5px solid var(--kb-hairline);border-radius:var(--kb-r-2xl);background:var(--kb-material-strong);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);box-shadow:var(--dsw-elevation-prominent);outline:none;animation:kb-sheet-in var(--kb-slow) var(--kb-ease-spring)}',
        '.kb-modal-wide{width:min(680px,100%)}',
        '.kb-modal-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--kb-hairline))}',
        '.kb-modal-head{display:flex;align-items:center;gap:10px;padding:var(--kb-s5) var(--kb-s5) var(--kb-s3)}',
        '.kb-modal-title-wrap{flex:1 1 auto;display:flex;align-items:center;gap:8px;min-width:0}',
        '.kb-modal-danger-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}',
        '.kb-modal-title{margin:0;font-size:17px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
        '.kb-modal-desc{margin:0;padding:0 var(--kb-s5) var(--kb-s2);font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.kb-modal-body{flex:1 1 auto;display:flex;flex-direction:column;gap:var(--kb-s4);min-height:0;overflow-y:auto;padding:var(--kb-s2) var(--kb-s5) var(--kb-s5);scrollbar-gutter:stable;scrollbar-width:thin}',
        '.kb-modal-foot{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:var(--kb-s3) var(--kb-s5);border-top:.5px solid var(--kb-hairline);background:var(--dsw-alias-bg-layer-2)}',
        '@keyframes kb-sheet-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
        '/* ==== hover（仅 hover 能力设备，§5.10）==== */',
        '@media (hover:hover){',
        '.kb-path:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}',
        '.kb-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-iconbtn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
        '.kb-iconbtn-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
        '.kb-tab:hover:not([data-active="true"]){color:var(--dsw-alias-label-primary)}',
        '.kb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}',
        '.kb-btn-primary:hover:not(:disabled){filter:brightness(1.05)}',
        '.kb-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}',
        '.kb-btn-danger-fill:hover:not(:disabled){filter:brightness(1.05)}',
        '.kb-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-linkbtn:hover:not(:disabled){background:var(--kb-tint);color:var(--dsw-alias-brand-primary)}',
        '.kb-nav-action:hover:not(:disabled){background:var(--kb-tint)}',
        '.kb-drop:hover{border-color:var(--dsw-alias-brand-primary);background:var(--kb-tint)}',
        '.kb-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-source-main:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.kb-source:hover .kb-source-actions,.kb-source:focus-within .kb-source-actions{opacity:1}',
        '.kb-page-item:hover:not([data-active="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-page-manage-item:hover:not([data-disabled="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-list-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.kb-linkitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}',
        '.kb-wikilink:hover{background:var(--kb-tint-strong);color:var(--dsw-alias-brand-primary)}',
        '.kb-wikilink-missing:hover{background:transparent;border-color:var(--dsw-alias-border-l4);color:var(--kb-text-tertiary)}',
        '.kb-ref-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.kb-health-issue:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.kb-trash-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.kb-group-head:hover{color:var(--dsw-alias-label-secondary)}',
        '}',
        '/* ==== 材质降级：不支持 backdrop-filter 时不透明（§6.2）==== */',
        '@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){',
        '.kb-header{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-reader-top{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-notice{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-sheet,.kb-modal{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-modal-overlay{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none;opacity:.92}',
        '.kb-composer-box{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-graph-toolbar,.kb-graph-detail,.kb-graph-empty-note{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '}',
        '@media (prefers-reduced-transparency:reduce){',
        '.kb-header{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-reader-top{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-notice{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-sheet,.kb-modal{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-modal-overlay{background:var(--dsw-alias-bg-base);-webkit-backdrop-filter:none;backdrop-filter:none;opacity:.92}',
        '.kb-composer-box{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '.kb-graph-toolbar,.kb-graph-detail,.kb-graph-empty-note{background:var(--dsw-alias-bg-layer-1);-webkit-backdrop-filter:none;backdrop-filter:none}',
        '}',
        '/* ==== 响应式（§4/§6.6）==== */',
        '@container kb-panel (max-width:1000px){',
        '.kb-nav{flex-basis:232px;width:232px;padding:var(--kb-s3) var(--kb-s2) var(--kb-s7)}',
        '.kb-header{padding:0 var(--kb-s3);gap:var(--kb-s2)}',
        '.kb-path{max-width:150px}',
        '.kb-path-sm{max-width:min(260px,40vw)}',
        '.kb-model{display:none}',
        '.kb-overview,.kb-reader,.kb-health,.kb-ask-head,.kb-ask-scroll,.kb-composer,.kb-search-results{padding-left:var(--kb-s5);padding-right:var(--kb-s5)}',
        '.kb-sources{padding-left:var(--kb-s5);padding-right:var(--kb-s5)}',
        '.kb-graph-head{padding:var(--kb-s4) var(--kb-s5) var(--kb-s3)}',
        '.kb-graph-stage{margin:0 var(--kb-s3) var(--kb-s3)}',
        '.kb-graph-detail{width:268px}',
        '.kb-cols{grid-template-columns:minmax(0,1fr)}',
        '.kb-stats{grid-template-columns:repeat(2,minmax(0,1fr))}',
        '.kb-tab{padding:0 10px}',
        '}',
        '@container kb-panel (max-width:760px){',
        '.kb-nav{flex-basis:200px;width:200px}',
        '.kb-title{display:inline}',
        '.kb-tab-label{display:inline}',
        '.kb-tab{padding:0 9px}',
        '.kb-overview,.kb-reader,.kb-health,.kb-ask-head,.kb-ask-scroll,.kb-composer,.kb-search-results{padding:var(--kb-s5) var(--kb-s4)}',
        '.kb-sources{padding:var(--kb-s5) var(--kb-s4)}',
        '.kb-sources .kb-filter-input{flex:1 1 auto;width:100%;margin-left:0}',
        '.kb-source-item-actions .kb-btn>span{display:none}',
        '.kb-graph-head{padding:var(--kb-s4) var(--kb-s5) var(--kb-s2)}',
        '.kb-graph-search{width:100%}',
        '.kb-graph-head-actions{width:100%}',
        '.kb-graph-stage{margin:0 var(--kb-s3) var(--kb-s3)}',
        '.kb-graph-toolbar{top:auto;bottom:var(--kb-s2);right:var(--kb-s2)}',
        '.kb-graph-hintbar{display:none}',
        '.kb-graph-detail{left:var(--kb-s2);right:var(--kb-s2);top:auto;bottom:var(--kb-s2);width:auto;max-height:54%}',
        '.kb-stats{grid-template-columns:minmax(0,1fr)}',
        '.kb-edit-grid{grid-template-columns:minmax(0,1fr)}',
        '.kb-form-field-narrow{max-width:none}',
        '.kb-modal-overlay{padding:var(--kb-s3)}',
        '}',
        // 项目选择：窄面板的资料导航可展开，五个目的地保留文字名称。
        '.kb-navigation-toggle{display:none}',
        '.kb-source-item-main{min-height:40px}',
        '.kb-overview,.kb-reader,.kb-health,.kb-sources{padding-top:24px;padding-bottom:32px}',
        '.kb-page-body,.kb-md{overflow-wrap:anywhere}',
        '.kb-original-pre:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
        '.kb-modal-foot .kb-btn{max-width:100%;white-space:normal;line-height:1.4}',
        '@container kb-panel (max-width:1000px){.kb-header{height:auto;min-height:96px;display:flex;flex-wrap:wrap;padding:10px 16px;gap:8px}.kb-header-left{flex:1 1 auto}.kb-header-right{margin-left:auto}.kb-header-center{order:3;flex:1 0 100%;overflow-x:auto;scrollbar-width:none}.kb-tabs{display:flex;width:max-content;min-width:100%}.kb-tab{flex:1 0 auto;justify-content:center}.kb-path{max-width:180px}.kb-model{display:none}.kb-notices{top:calc(var(--dsh-frame-top-clearance,0px) + 104px)}.kb-nav{width:232px;flex-basis:232px}.kb-overview,.kb-reader,.kb-health,.kb-sources{padding-left:20px;padding-right:20px}}',
        '@container kb-panel (max-width:760px){.kb-navigation-toggle{display:inline-flex}.kb-header-left>.kb-logo{display:none}.kb-body{flex-direction:column}.kb-nav{flex:0 1 auto;width:100%;max-height:44%;padding:16px;border-right:0;border-bottom:.5px solid var(--kb-hairline)}.kb-root[data-navigation-open="false"] .kb-nav{display:none}.kb-header .kb-path{max-width:140px}.kb-tab-badge{display:none}.kb-tab{padding:8px 10px;min-height:34px}.kb-tab-icon{display:none}.kb-overview,.kb-reader,.kb-health,.kb-sources{padding:20px 16px 28px}.kb-original-pre{font-size:14px;padding:16px;max-height:50vh}.kb-source-item{gap:8px;padding:12px}.kb-source-item-actions{gap:4px;max-width:42%}.kb-source-item .kb-source-meta{white-space:normal;flex-wrap:wrap}.kb-modal-foot{padding:12px 16px}}',
        '@container kb-panel (max-width:480px){.kb-header .kb-path{max-width:88px}.kb-header-left{gap:4px}.kb-tab{font-size:12px;padding:8px}.kb-source-item{align-items:flex-start;flex-wrap:wrap}.kb-source-item-actions{max-width:none;width:100%;padding-left:0}.kb-original-pre{padding:12px}.kb-model{display:none}}',
        '@media (pointer:coarse){.kb-btn,.kb-btn-sm,.kb-iconbtn,.kb-linkbtn,.kb-tab,.kb-nav-action{min-height:44px}.kb-iconbtn{min-width:44px}}',
        "/* UI 2026-11: ui-core.css */",
        "/* Apple HIG principles, web implementation. All sizes and color tokens below are project choices. */",
        ".kb-root{color-scheme:light;--kb-canvas:#f5f5f7;--kb-panel:#ffffff;--kb-sidebar:#f0f1f4;--kb-ink:#1d1d1f;--kb-ink-secondary:#62626b;--kb-separator:#dedee3;--kb-accent:#0066cc;--kb-accent-fill:#0669d5;--kb-accent-hover:#005bbb;--kb-accent-ink:#ffffff;--kb-selection:#dfeafa;--kb-soft:#eceef2;--kb-dim:#71717a;--kb-shadow:0 8px 28px rgba(0,0,0,.10);--kb-overlay:rgba(20,22,28,.34);--kb-shadow-modal:0 18px 60px rgba(0,0,0,.20);--kb-hairline:var(--kb-separator);--kb-material:var(--kb-panel);--kb-material-strong:var(--kb-panel);--kb-material-card:var(--kb-panel);--kb-surface-2:var(--kb-soft);--kb-surface-3:var(--kb-selection);--kb-text-tertiary:var(--kb-ink-secondary);--kb-text-caption:var(--kb-ink-secondary);--kb-tint:var(--kb-selection);--kb-tint-strong:var(--kb-selection);--kb-ring:0 0 0 3px color-mix(in srgb,var(--kb-accent) 23%,transparent);--kb-field-focus:var(--kb-accent);--kb-field-ring:var(--kb-ring);--kb-nav-w:258px;--kb-content-max:1080px;--kb-header-h:66px;--dsw-alias-bg-base:var(--kb-canvas);--dsw-alias-bg-layer-1:var(--kb-panel);--dsw-alias-bg-layer-2:var(--kb-sidebar);--dsw-alias-bg-layer-3:var(--kb-soft);--dsw-alias-label-primary:var(--kb-ink);--dsw-alias-label-secondary:var(--kb-ink-secondary);--dsw-alias-label-tertiary:var(--kb-ink-secondary);--dsw-alias-label-caption:var(--kb-dim);--dsw-alias-border-l2:var(--kb-separator);--dsw-alias-border-l3:var(--kb-separator);--dsw-alias-border-l4:var(--kb-ink-secondary);--dsw-alias-brand-primary:var(--kb-accent);--dsw-alias-interactive-bg-hover:var(--kb-soft);background:var(--kb-canvas);color:var(--kb-ink);font-size:13px;line-height:1.6}",
        "body[data-ds-dark-theme] .kb-root{color-scheme:dark;--kb-canvas:#17181a;--kb-panel:#242528;--kb-sidebar:#1e1f22;--kb-ink:#f5f5f7;--kb-ink-secondary:#b6b7c0;--kb-separator:#414248;--kb-accent:#86baff;--kb-accent-fill:#126bd8;--kb-accent-hover:#0b5fc5;--kb-accent-ink:#ffffff;--kb-selection:#263f61;--kb-soft:#303136;--kb-dim:#aaaab4;--kb-overlay:rgba(0,0,0,.6);--kb-shadow-modal:0 18px 60px rgba(0,0,0,.5);--kb-shadow:0 8px 28px rgba(0,0,0,.3)}",
        ".kb-root{--kb-conversation-bubble:#edf3ff;--kb-warning-ink:#8d620b;--kb-success-ink:#247647;--kb-error-ink:#b43832}",
        "body[data-ds-dark-theme] .kb-root{--kb-conversation-bubble:#25324c;--kb-warning-ink:#e8c57b;--kb-success-ink:#80c79e;--kb-error-ink:#ffaaa5}",
        ".kb-root :focus-visible{outline:2px solid var(--kb-accent);outline-offset:2px;box-shadow:var(--kb-ring)}",
        ".kb-root ::selection{background:var(--kb-selection);color:var(--kb-ink)}",
        ".kb-root :where(button,input,select,textarea){accent-color:var(--kb-accent)}",
        ".kb-overview-title,.kb-page-title,.kb-init-title{font-size:26px;line-height:1.3;letter-spacing:-.025em;font-weight:650;color:var(--kb-ink)}",
        ".kb-section-sub,.kb-counter{color:var(--kb-ink-secondary)}",
        ".kb-header{height:66px;min-height:66px;padding:0 24px;gap:16px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;background:var(--kb-panel);border-bottom:1px solid var(--kb-separator);backdrop-filter:none;-webkit-backdrop-filter:none}",
        ".kb-header-left{gap:9px}.kb-header-center{justify-self:center;max-width:100%}.kb-header-right{gap:8px}",
        ".kb-logo{width:30px;height:30px;box-shadow:none;color:var(--kb-accent);background:var(--kb-selection);border-radius:9px}",
        ".kb-title{font-size:16px;font-weight:650;letter-spacing:0}",
        ".kb-header .kb-path{width:30px;min-width:30px;max-width:30px;height:32px;min-height:32px;padding:0;justify-content:center;border:0;background:none;border-radius:7px;color:var(--kb-ink-secondary)}",
        ".kb-header .kb-path:hover{color:var(--kb-accent);background:var(--kb-soft)}",
        ".kb-model{max-width:180px;height:30px;padding:0 4px;border:0;border-radius:0;background:none;font-size:11px;color:var(--kb-ink-secondary)}",
        ".kb-model-dot{width:5px;height:5px}",
        ".kb-tabs{display:flex;min-width:0;min-height:36px;height:auto;gap:2px;padding:3px;background:var(--kb-soft);border:0;border-radius:10px}",
        ".kb-tab{min-height:30px;padding:7px 11px;font-size:12px;font-weight:500;border-radius:7px;color:var(--kb-ink-secondary);gap:5px}",
        ".kb-tab[data-active=\"true\"]{background:var(--kb-panel);color:var(--kb-accent);font-weight:600;box-shadow:0 1px 3px color-mix(in srgb,var(--kb-ink) 12%,transparent)}",
        ".kb-tab-icon{opacity:1}.kb-tab-badge{font-size:10px;height:16px;padding:0 4px;color:inherit;background:transparent;opacity:.85}",
        ".kb-tab[data-active=\"true\"] .kb-tab-icon{color:var(--kb-accent)}",
        ".kb-btn{min-height:34px;padding:7px 12px;border:1px solid var(--kb-separator);border-radius:8px;background:var(--kb-panel);font-size:13px;line-height:1.35;color:var(--kb-ink);box-shadow:0 1px 1px color-mix(in srgb,var(--kb-ink) 3%,transparent);transition:background-color 140ms ease,color 140ms ease}",
        ".kb-btn:hover:not(:disabled){background:var(--kb-soft);border-color:var(--kb-separator);transform:none}",
        ".kb-btn-primary{background:var(--kb-accent-fill);border-color:transparent;color:var(--kb-accent-ink);font-weight:550;box-shadow:none}",
        ".kb-btn-primary:hover:not(:disabled){background:var(--kb-accent-hover);border-color:transparent;color:var(--kb-accent-ink)}",
        ".kb-btn-ghost{border-color:transparent;box-shadow:none;background:transparent;color:var(--kb-accent)}",
        ".kb-btn-ghost:hover:not(:disabled){background:var(--kb-soft);border-color:transparent}",
        ".kb-btn-danger{color:var(--kb-on-error);background:var(--kb-panel)}",
        ".kb-btn-sm{min-height:32px;padding:6px 11px;font-size:12px;line-height:1.4}",
        ".kb-iconbtn{width:32px;min-width:32px;height:32px;min-height:32px;color:var(--kb-ink-secondary);border-radius:8px}",
        ".kb-iconbtn:hover:not(:disabled){background:var(--kb-soft);color:var(--kb-accent)}",
        ".kb-linkbtn{color:var(--kb-accent);font-size:12px;line-height:1.5;border-radius:5px;min-height:28px;padding:3px 2px}",
        ".kb-input,.kb-select,.kb-textarea{border:1px solid var(--kb-separator);border-radius:8px;background:var(--kb-panel);color:var(--kb-ink);font-size:13px;line-height:1.5}",
        ".kb-input,.kb-select{min-height:36px;height:auto;padding:7px 10px}",
        ".kb-search{height:36px;min-height:36px;border:1px solid var(--kb-separator);border-radius:9px;background:var(--kb-panel);padding:0 10px;gap:7px;box-shadow:0 1px 2px color-mix(in srgb,var(--kb-ink) 3%,transparent)}",
        ".kb-search-input{font-size:13px;color:var(--kb-ink)}",
        ".kb-search-input::placeholder,.kb-textarea::placeholder,.kb-input::placeholder{color:var(--kb-ink-secondary);opacity:1}",
        ".kb-main{background:var(--kb-canvas);scrollbar-gutter:auto}.kb-nav{background:var(--kb-sidebar);border-color:var(--kb-separator)}",
        ".kb-badge{border:0;border-radius:5px;font-size:11px;line-height:1.5;padding:2px 6px;font-weight:500}",
        ".kb-job{background:var(--kb-panel);border:1px solid var(--kb-separator);box-shadow:none;border-radius:10px}",
        ".kb-job-title{font-size:13px}.kb-job-msg,.kb-job-status{font-size:12px}",
        ".kb-progress{height:5px;background:var(--kb-soft)}",
        ".kb-action-disclosure{position:relative;display:inline-flex}",
        ".kb-action-popover{position:absolute;top:calc(100% + 6px);right:0;z-index:25;display:flex;flex-direction:column;min-width:180px;max-width:min(280px,70vw);padding:5px;border:1px solid var(--kb-separator);border-radius:10px;background:var(--kb-panel);box-shadow:var(--kb-shadow)}",
        ".kb-action-option{min-height:36px;padding:8px 12px;text-align:left;border-radius:6px;font-size:13px;line-height:1.5;color:var(--kb-ink);white-space:normal}",
        ".kb-action-option:hover,.kb-action-option:focus-visible{background:var(--kb-selection);color:var(--kb-accent)}",
        "/* Exploration: a source-list and one uninterrupted reading surface. */",
        ".kb-graph-page{background:var(--kb-canvas)}",
        ".kb-graph-head{padding:26px 28px 20px;gap:12px;align-items:center}",
        ".kb-graph-head .kb-ask-titles{gap:4px}.kb-graph-head .kb-ask-sub{font-size:12px;color:var(--kb-ink-secondary)}",
        ".kb-graph-head-actions{width:auto;display:flex;align-items:center;gap:6px}",
        ".kb-graph-search{width:240px;max-width:100%;flex:0 1 240px}",
        ".kb-graph-view-switch{padding:3px;gap:2px;min-height:36px;border-radius:9px;background:var(--kb-soft)}",
        ".kb-graph-view-switch .kb-graph-chip{padding:5px 12px;min-height:30px;border:0;border-radius:6px;font-size:12px;font-weight:500;box-shadow:none}",
        ".kb-graph-view-switch .kb-graph-chip[data-active=\"true\"]{background:var(--kb-panel);color:var(--kb-accent);box-shadow:0 1px 2px color-mix(in srgb,var(--kb-ink) 10%,transparent)}",
        ".kb-graph-view-switch .kb-graph-chip[data-active=\"false\"]{background:transparent;color:var(--kb-ink-secondary)}",
        ".kb-graph-reading{grid-template-columns:286px minmax(0,1fr);margin:0 24px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel);box-shadow:0 2px 6px color-mix(in srgb,var(--kb-ink) 3%,transparent)}",
        ".kb-graph-catalog{padding:14px 10px 12px;gap:0;background:var(--kb-sidebar);border-right:1px solid var(--kb-separator);overflow:hidden}",
        ".kb-graph-catalog-modes{display:flex;flex-direction:column;gap:2px;padding-bottom:16px;border-bottom:1px solid var(--kb-separator);flex:none}",
        ".kb-graph-catalog-modes .kb-graph-chip{width:100%;min-height:36px;height:auto;display:flex;align-items:center;justify-content:flex-start;padding:7px 11px;gap:9px;border:0;border-radius:7px;background:transparent;box-shadow:none;font-size:13px;line-height:1.5;color:var(--kb-ink);text-align:left;opacity:1}",
        ".kb-graph-mode-icon{flex:none;display:inline-flex;align-items:center;color:var(--kb-accent)}",
        ".kb-graph-mode-label{flex:1;min-width:0}.kb-graph-mode-count{font-size:12px;font-variant-numeric:tabular-nums;color:var(--kb-ink-secondary);font-weight:400}",
        ".kb-graph-catalog-modes .kb-graph-chip[data-active=\"true\"]{background:var(--kb-selection);color:var(--kb-accent);font-weight:600}",
        ".kb-graph-catalog-modes .kb-graph-chip[data-active=\"false\"]{color:var(--kb-ink)}",
        ".kb-graph-catalog-modes .kb-graph-chip:hover{background:var(--kb-soft)}",
        ".kb-graph-catalog-section{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 9px 4px;flex:none}",
        ".kb-graph-catalog-heading{margin:0;font-size:12px;line-height:1.5;font-weight:600;color:var(--kb-ink-secondary)}",
        ".kb-graph-catalog-section .kb-linkbtn{font-size:11px}",
        ".kb-graph-catalog-hint{margin:2px 9px 10px;font-size:11px;line-height:1.6;color:var(--kb-ink-secondary);flex:none}",
        ".kb-graph-catalog-list{padding:2px 0 8px;scrollbar-width:thin;flex:1;min-height:70px}",
        ".kb-topic-children{margin-left:15px;padding-left:6px;border-left:0}",
        ".kb-topic-roots>.kb-topic-item{margin-bottom:3px}",
        ".kb-topic-roots>.kb-topic-item>.kb-topic-row>.kb-topic-select{font-weight:600}",
        ".kb-topic-row{border-radius:7px;min-height:36px}",
        ".kb-topic-row[data-selected=\"true\"],.kb-graph-catalog-row[aria-pressed=\"true\"]{background:var(--kb-selection);box-shadow:none}",
        ".kb-topic-row[data-selected=\"true\"] .kb-topic-select,.kb-topic-row[data-selected=\"true\"] .kb-topic-count{color:var(--kb-accent)}",
        ".kb-topic-disclosure,.kb-topic-spacer{width:24px;min-width:24px;min-height:34px;color:var(--kb-ink-secondary)}",
        ".kb-topic-select{padding:7px 9px 7px 1px;font-size:13px;line-height:1.55;min-height:36px;color:var(--kb-ink);gap:6px}",
        ".kb-topic-count{font-size:11px;color:var(--kb-ink-secondary);font-weight:400}",
        ".kb-graph-catalog-row{min-height:58px;padding:10px 12px;gap:3px;border-radius:7px}",
        ".kb-graph-catalog-meta{font-size:11px;color:var(--kb-ink-secondary)}",
        ".kb-entity-select{margin:2px 0 10px;font-size:12px}",
        ".kb-graph-reading-content{padding:32px clamp(24px,3.5vw,48px) 48px;background:var(--kb-panel)}",
        ".kb-graph-reading .kb-graph-detail{gap:0;max-width:820px;margin:0 auto;color:var(--kb-ink)}",
        ".kb-graph-detail-head{min-height:28px;margin-bottom:12px}",
        ".kb-topic-breadcrumb{gap:5px;margin:0 0 7px;font-size:12px}",
        ".kb-topic-breadcrumb .kb-linkbtn{font-size:12px;min-height:24px;padding:0;color:var(--kb-ink-secondary);display:flex;gap:7px;align-items:center}",
        ".kb-topic-breadcrumb .kb-linkbtn:hover{color:var(--kb-accent)}",
        ".kb-topic-breadcrumb span{color:var(--kb-ink-secondary)}",
        ".kb-graph-reading .kb-graph-detail-title,.kb-graph-welcome h3{font-size:27px;line-height:1.4;font-weight:650;letter-spacing:-.025em;margin:0 0 12px;color:var(--kb-ink)}",
        ".kb-graph-detail-meta{font-size:12px;gap:10px;color:var(--kb-ink-secondary);margin-bottom:10px}",
        ".kb-graph-detail>.kb-badge{margin-bottom:8px}",
        ".kb-graph-tags{gap:7px;margin:0 0 14px}",
        ".kb-graph-tag{font-size:11px;line-height:1.5;padding:3px 7px;background:var(--kb-soft);border:0;border-radius:5px;color:var(--kb-ink-secondary)}",
        ".kb-graph-detail-actions{gap:8px;padding:4px 0 24px;margin:0 0 24px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-graph-detail-actions .kb-btn-primary{min-height:34px;padding:7px 14px}",
        ".kb-graph-section{gap:10px;margin:0 0 26px}",
        ".kb-graph-section h4,.kb-graph-nb-title{margin:0;font-size:14px;line-height:1.5;font-weight:600;color:var(--kb-ink)}",
        ".kb-graph-reading .kb-graph-copy{font-size:14px;line-height:1.9;color:var(--kb-ink-secondary)}",
        ".kb-graph-reading .kb-graph-section>.kb-graph-copy{color:var(--kb-ink);font-size:15px}",
        ".kb-graph-source-row{padding:10px 0;align-items:center;gap:16px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-graph-source-title{display:flex;align-items:center;gap:9px;font-size:13px;line-height:1.7;color:var(--kb-ink)}",
        ".kb-graph-source-title>svg{flex:none;color:var(--kb-accent)}",
        ".kb-graph-source-title>span{min-width:0;overflow-wrap:anywhere}",
        ".kb-graph-source-row .kb-linkbtn{flex:none;font-size:12px}",
        ".kb-graph-neighbors{gap:0}.kb-graph-nb-title{padding:0 0 10px}",
        ".kb-graph-relation-row{padding:10px 0 12px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-graph-nb{padding:4px 2px;min-height:28px;height:auto;gap:8px;color:var(--kb-ink);border-radius:5px}",
        ".kb-graph-reading .kb-graph-nb{min-height:30px}",
        ".kb-graph-nb-title-text{font-size:14px;line-height:1.6;color:var(--kb-ink)}",
        ".kb-graph-nb-dot{width:6px;height:6px}",
        ".kb-graph-relation-actions{padding:2px 0 0 16px;gap:8px;align-items:center}",
        ".kb-graph-relation-label{font-size:12px;color:var(--kb-ink-secondary)}",
        ".kb-graph-relation-actions .kb-linkbtn{font-size:11px;min-height:26px}",
        ".kb-graph-evidence{font-size:13px;line-height:1.85;margin:10px 0 0 16px;padding:14px 16px;border-left:3px solid var(--kb-accent);border-radius:0 8px 8px 0;background:var(--kb-canvas)}",
        ".kb-topic-child-link{min-height:38px;background:var(--kb-canvas);border:0;font-size:13px;color:var(--kb-accent);padding:8px 12px}",
        ".kb-graph-welcome{gap:0;max-width:780px;margin:12px auto}",
        ".kb-graph-welcome>p{margin-bottom:30px;max-width:560px}",
        ".kb-graph-welcome .kb-graph-section{gap:6px;margin-bottom:28px}",
        ".kb-graph-welcome .kb-graph-catalog-row{border-bottom:1px solid var(--kb-separator);border-radius:0;padding:14px 2px;min-height:68px}",
        ".kb-graph-welcome .kb-graph-catalog-title{font-size:15px;font-weight:500}",
        ".kb-graph-welcome .kb-graph-catalog-meta{font-size:12px}",
        ".kb-graph-welcome .kb-graph-caveat{font-size:12px;margin:0;padding-top:20px;max-width:none}",
        ".kb-graph-stage{margin:0 24px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel)}",
        ".kb-graph-toolbar{background:var(--kb-panel);border:1px solid var(--kb-separator);box-shadow:0 2px 8px color-mix(in srgb,var(--kb-ink) 6%,transparent);backdrop-filter:none;-webkit-backdrop-filter:none}",
        ".kb-graph-chip{border-color:var(--kb-separator);color:var(--kb-ink-secondary);background:var(--kb-panel)}",
        ".kb-graph-chip[data-active=\"true\"]{color:var(--kb-ink);background:var(--kb-soft);border-color:var(--kb-separator)}",
        ".kb-graph-stage .kb-graph-detail{background:var(--kb-panel);border:1px solid var(--kb-separator);border-radius:12px;box-shadow:var(--kb-shadow);gap:8px;padding:18px;width:330px;backdrop-filter:none;-webkit-backdrop-filter:none}",
        ".kb-graph-stage .kb-graph-detail-actions{padding-bottom:14px;margin-bottom:8px;flex-wrap:nowrap}",
        ".kb-graph-stage .kb-graph-detail-title{font-size:19px}",
        ".kb-graph-stage .kb-graph-section{margin-bottom:12px}",
        ".kb-graph-stage .kb-graph-detail-meta{margin-bottom:0}",
        "@container kb-panel (max-width:1100px){.kb-header{padding:0 18px;gap:12px}.kb-model{max-width:130px;font-size:10px}.kb-tab{padding:7px 9px}.kb-tab-icon{display:none}.kb-graph-reading{grid-template-columns:264px minmax(0,1fr)}.kb-graph-search{width:215px;flex-basis:215px}.kb-graph-head{padding:22px 24px 18px}}",
        "@container kb-panel (max-width:900px){.kb-header{display:flex;flex-wrap:wrap;height:auto;min-height:100px;padding:12px 20px;gap:10px}.kb-header-left{flex:1}.kb-header-right{margin-left:auto}.kb-header-center{order:3;flex:1 0 100%;overflow:auto;scrollbar-width:none}.kb-tabs{min-width:100%;width:max-content}.kb-tab{flex:1;justify-content:center}.kb-model{display:inline-flex;max-width:160px}.kb-graph-head{gap:10px}.kb-graph-head .kb-header-spacer{display:none}.kb-graph-head .kb-ask-titles{flex:1}.kb-graph-search{flex:1 1 200px;width:auto}.kb-graph-reading{grid-template-columns:240px minmax(0,1fr);margin:0 18px 18px}.kb-graph-reading-content{padding:26px 26px 40px}.kb-graph-reading .kb-graph-detail-title{font-size:24px}.kb-notices{top:calc(var(--dsh-frame-top-clearance,0px) + 108px)}}",
        "@container kb-panel (max-width:760px){.kb-header{padding:10px 16px;gap:9px}.kb-header-left{gap:8px}.kb-header-left>.kb-logo{display:inline-flex}.kb-header .kb-path{min-width:32px;max-width:32px}.kb-navigation-toggle{min-height:36px}.kb-title{font-size:15px}.kb-tab{min-height:40px;padding:8px 10px}.kb-tab-badge{display:none}.kb-model{max-width:125px;font-size:10px}.kb-graph-head{padding:20px 16px 14px;gap:10px}.kb-graph-head .kb-ask-titles{flex:1 1 120px}.kb-graph-view-switch .kb-graph-chip{min-height:38px;padding:7px 10px}.kb-graph-search{order:3;flex:1 1 calc(100% - 46px);width:auto}.kb-graph-head-actions{order:4;width:auto}.kb-graph-head-actions .kb-btn{font-size:11px}.kb-graph-reading{display:flex;flex-direction:column;overflow:auto;margin:0 12px 12px;border-radius:12px}.kb-graph-catalog{flex:0 0 auto;max-height:34vh;min-height:190px;padding:8px;border-right:0;border-bottom:1px solid var(--kb-separator)}.kb-graph-catalog-modes{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:3px;padding:0 0 7px;scrollbar-width:thin;border-bottom:0}.kb-graph-catalog-modes .kb-graph-chip{width:auto;flex:none;min-height:44px;padding:7px 10px;gap:6px;font-size:12px;white-space:nowrap}.kb-graph-mode-count{font-size:11px}.kb-graph-mode-icon{display:none}.kb-graph-catalog-section{padding:2px 7px}.kb-graph-catalog-hint{display:none}.kb-graph-catalog-list{min-height:82px;padding-bottom:0}.kb-topic-row,.kb-topic-select,.kb-topic-disclosure{min-height:44px}.kb-topic-disclosure,.kb-topic-spacer{width:28px;min-width:28px}.kb-topic-children{margin-left:15px;padding-left:6px}.kb-graph-reading-content{flex:0 0 auto;overflow:visible;padding:24px 20px 36px}.kb-graph-reading .kb-graph-detail-title{font-size:23px}.kb-graph-reading .kb-graph-copy{font-size:14px;line-height:1.85}.kb-graph-detail-actions{padding-bottom:20px;margin-bottom:22px}.kb-graph-source-row{flex-wrap:wrap;gap:4px}.kb-graph-source-title{flex-basis:100%}.kb-graph-source-row .kb-linkbtn{margin-left:25px}.kb-graph-relation-actions{gap:4px}.kb-graph-source-row .kb-linkbtn,.kb-graph-relation-actions .kb-linkbtn,.kb-graph-catalog-section .kb-linkbtn,.kb-action-option{min-height:44px;display:inline-flex;align-items:center}.kb-graph-reading .kb-graph-nb{min-height:44px}.kb-graph-stage{margin:0 12px 12px}.kb-graph-stage .kb-graph-detail{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-height:55%;padding:16px}.kb-btn,.kb-btn-sm{min-height:40px}.kb-iconbtn{min-width:36px;min-height:36px}.kb-graph-detail-actions .kb-btn{min-height:44px}}",
        "@container kb-panel (max-width:480px){.kb-model{display:none}.kb-header-left>.kb-logo{width:26px;height:26px}.kb-header .kb-path{width:30px;min-width:30px}.kb-tab{font-size:12px;padding:8px;min-height:44px}.kb-overview-title,.kb-page-title{font-size:24px}.kb-graph-view-switch .kb-graph-chip{font-size:11px;padding:7px 9px}.kb-graph-head-actions .kb-btn{padding-inline:7px}.kb-graph-search{flex-basis:calc(100% - 86px)}.kb-graph-head-actions .kb-iconbtn{width:36px}.kb-graph-reading-content{padding:22px 18px 32px}.kb-graph-detail-actions{gap:6px}.kb-graph-reading .kb-graph-detail-title{font-size:22px}.kb-graph-detail-head{margin-bottom:10px}.kb-action-popover{right:0}}",
        "@media(pointer:coarse){.kb-root :where(button,.kb-linkbtn){min-height:44px}.kb-iconbtn{min-width:44px}}",
        "@media(prefers-contrast:more){.kb-root{--kb-separator:var(--kb-ink-secondary)}.kb-btn,.kb-input,.kb-select,.kb-search,.kb-textarea{border-width:1px}.kb-tab[data-active=\"true\"],.kb-graph-chip[data-active=\"true\"],.kb-topic-row[data-selected=\"true\"]{outline:1px solid var(--kb-accent);outline-offset:-1px}}",
        "@media(prefers-reduced-transparency:reduce){.kb-header,.kb-action-popover,.kb-graph-detail{backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--kb-panel)}}",
        ".kb-purpose-summary{margin:0;color:var(--kb-ink-secondary);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}",
        ".kb-purpose-editor{display:flex;flex-direction:column;gap:12px}.kb-purpose-editor>p{margin:0}.kb-purpose-editor .kb-textarea{width:100%}",
        "@container kb-panel (max-width:760px){.kb-btn,.kb-btn-sm,.kb-iconbtn,.kb-tab,.kb-navigation-toggle,.kb-graph-view-switch .kb-graph-chip{min-height:44px}.kb-iconbtn{min-width:44px}.kb-graph-head-actions .kb-iconbtn{width:44px}.kb-graph-search{min-height:44px}}",
        "",
        ".kb-graph-catalog-body{display:contents}.kb-graph-catalog-toggle{display:none}",
        "@container kb-panel (max-width:760px){.kb-graph-catalog{min-height:60px;max-height:42vh}.kb-graph-catalog-toggle{display:flex;flex:none;align-items:center;gap:8px;width:100%;padding:6px 9px;min-height:44px;font-size:13px;text-align:left;color:var(--kb-accent);border-radius:7px}.kb-graph-catalog-toggle>span:first-of-type{flex:1}.kb-graph-toggle-mode{font-size:11px;color:var(--kb-ink-secondary)}.kb-graph-catalog-body{display:flex;flex-direction:column;min-height:0;overflow:hidden}.kb-graph-catalog[data-open=\"false\"] .kb-graph-catalog-body{display:none}.kb-graph-catalog-modes{padding-top:5px}.kb-graph-catalog-list{min-height:90px}.kb-graph-reading-content{flex:none}}",
        "/* UI 2026-11: ui-library.css */",
        "/* Library, navigation, reading and task sheets.",
        "   Web project choices: 12–16px corners, 26px page titles and 44px touch targets.",
        "   Semantic colors are supplied by the application theme. */",
        "",
        "/* A quiet source list gives the sidebar a familiar document-browser rhythm. */",
        ".kb-nav .kb-nav-section { gap: 8px; }",
        ".kb-nav .kb-nav-head { min-height: 28px; padding: 0 8px; gap: 6px; }",
        ".kb-nav .kb-nav-title,",
        ".kb-nav .kb-group-label { font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-nav-count,",
        ".kb-nav .kb-group-count { font-size: 12px; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-nav-tip { padding: 0 8px; font-size: 12px; line-height: 1.6; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-nav-action { min-height: 28px; height: auto; padding: 5px 8px; border-radius: 7px; font-size: 12px; color: var(--kb-accent); }",
        ".kb-nav .kb-nav-empty,",
        ".kb-nav .kb-nav-loading { padding: 12px 8px; font-size: 12px; line-height: 1.65; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-search { min-height: 36px; height: auto; gap: 8px; padding: 7px 10px; border: 1px solid var(--kb-separator); border-radius: 9px; background: var(--kb-panel); box-shadow: none; }",
        ".kb-nav .kb-search-input { color: var(--kb-ink); font-size: 13px; }",
        ".kb-nav .kb-search-input::placeholder,",
        ".kb-nav .kb-search-icon { color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-search:focus-within { border-color: var(--kb-accent); box-shadow: 0 0 0 3px var(--kb-selection); }",
        ".kb-nav .kb-upload { padding: 0 0 16px; gap: 10px; border: 0; border-bottom: 1px solid var(--kb-separator); border-radius: 0; background: transparent; }",
        ".kb-nav .kb-drop { min-height: 108px; justify-content: center; gap: 5px; padding: 16px 12px; border: 1px dashed color-mix(in srgb, var(--kb-accent) 30%, var(--kb-separator)); border-radius: 12px; background: var(--kb-panel); }",
        ".kb-nav .kb-drop-icon { width: 26px; height: 26px; margin-bottom: 2px; color: var(--kb-accent); }",
        ".kb-nav .kb-drop-title { color: var(--kb-ink); font-size: 13px; font-weight: 600; }",
        ".kb-nav .kb-drop-hint { max-width: 220px; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.55; }",
        ".kb-nav .kb-drop[data-drag=\"true\"] { border-style: solid; border-color: var(--kb-accent); background: var(--kb-selection); }",
        ".kb-nav .kb-urlbar,",
        ".kb-nav .kb-paste { gap: 8px; }",
        ".kb-nav .kb-input-row { gap: 6px; align-items: stretch; }",
        ".kb-nav .kb-url-input { min-height: 34px; height: auto; padding: 7px 9px; border: 1px solid var(--kb-separator); border-radius: 8px; background: var(--kb-panel); color: var(--kb-ink); font-size: 12px; }",
        ".kb-nav .kb-collapse { align-self: flex-start; height: auto; min-height: 30px; padding: 6px 7px; color: var(--kb-ink-secondary); border-radius: 7px; }",
        ".kb-nav .kb-paste-form { gap: 10px; padding: 12px; border: 1px solid var(--kb-separator); border-radius: 10px; background: var(--kb-panel); }",
        ".kb-nav .kb-paste-form :is(.kb-input, .kb-textarea) { color: var(--kb-ink); background: var(--kb-soft); border-color: var(--kb-separator); }",
        ".kb-nav .kb-job { padding: 12px; gap: 8px; border-color: var(--kb-separator); border-radius: 10px; background: var(--kb-panel); }",
        ".kb-nav .kb-job-title { font-size: 12px; line-height: 1.5; color: var(--kb-ink); }",
        ".kb-nav :is(.kb-job-status, .kb-job-msg) { font-size: 12px; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-job[data-state=\"failed\"] .kb-job-status { color: var(--kb-on-error); }",
        ".kb-nav .kb-job[data-state=\"done\"] .kb-job-status { color: var(--kb-on-success); }",
        ".kb-nav .kb-progress { height: 4px; background: var(--kb-soft); }",
        ".kb-nav .kb-progress-bar { background: var(--kb-accent); }",
        ".kb-nav .kb-source-list,",
        ".kb-nav .kb-group-items { gap: 2px; padding: 2px; border: 0; border-radius: 10px; background: transparent; }",
        ".kb-nav .kb-source { border-radius: 8px; }",
        ".kb-nav .kb-source + .kb-source::before,",
        ".kb-nav .kb-page-item + .kb-page-item::before,",
        ".kb-nav .kb-page-manage-item + .kb-page-manage-item::before { display: none; }",
        ".kb-nav .kb-source-row { padding: 0 3px 0 8px; gap: 2px; border-radius: 8px; }",
        ".kb-nav .kb-source-main { min-height: 50px; padding: 8px 3px 8px 0; gap: 8px; }",
        ".kb-nav .kb-source-title { color: var(--kb-ink); font-size: 13px; font-weight: 400; line-height: 1.5; }",
        ".kb-nav .kb-source-meta { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.5; }",
        ".kb-nav .kb-source-actions { opacity: 1; }",
        ".kb-nav .kb-source-confirm { margin: 2px 4px 8px; padding: 10px; border-radius: 9px; }",
        ".kb-nav .kb-source-selected { background: var(--kb-selection); }",
        ".kb-nav .kb-groups { gap: 16px; overflow: visible; }",
        ".kb-nav .kb-group { gap: 3px; }",
        ".kb-nav .kb-group-head { height: auto; min-height: 30px; padding: 5px 8px; gap: 6px; }",
        ".kb-nav .kb-page-item,",
        ".kb-nav .kb-page-manage-item { min-height: 36px; padding: 8px 10px; border-radius: 8px; color: var(--kb-ink); font-size: 13px; font-weight: 400; line-height: 1.5; }",
        ".kb-nav .kb-page-item[data-active=\"true\"],",
        ".kb-nav .kb-page-manage-item[data-selected=\"true\"] { box-shadow: none; background: var(--kb-selection); color: var(--kb-accent); font-weight: 500; }",
        ".kb-nav .kb-page-item-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }",
        ".kb-nav .kb-manage-bar { padding: 8px; gap: 6px; border-color: var(--kb-separator); border-radius: 9px; background: var(--kb-panel); }",
        ".kb-nav .kb-manage-text { font-size: 12px; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-checkbox { accent-color: var(--kb-accent); }",
        ".kb-nav .kb-topic-children { margin-left: 11px; padding-left: 8px; border-color: var(--kb-separator); }",
        ".kb-nav .kb-topic-row { border-radius: 8px; }",
        ".kb-nav .kb-topic-row[data-selected=\"true\"] { box-shadow: none; background: var(--kb-selection); }",
        ".kb-nav .kb-topic-row[data-selected=\"true\"] .kb-topic-select { color: var(--kb-accent); font-weight: 500; }",
        ".kb-nav .kb-topic-disclosure,",
        ".kb-nav .kb-topic-spacer { width: 26px; min-width: 26px; min-height: 36px; color: var(--kb-ink-secondary); }",
        ".kb-nav .kb-topic-select { min-height: 36px; padding: 8px 6px 8px 2px; color: var(--kb-ink); font-size: 13px; line-height: 1.5; }",
        ".kb-nav .kb-topic-count { font-size: 12px; color: var(--kb-ink-secondary); font-variant-numeric: tabular-nums; }",
        ".kb-nav .kb-entity-select { width: 100%; min-height: 34px; margin-bottom: 6px; border-color: var(--kb-separator); border-radius: 8px; background: var(--kb-panel); color: var(--kb-ink); }",
        ".kb-nav .kb-graph-catalog-row { min-height: 38px; padding: 8px 10px; border-radius: 8px; color: var(--kb-ink); }",
        ".kb-nav .kb-graph-catalog-title { font-size: 13px; line-height: 1.5; }",
        ".kb-nav .kb-graph-catalog-meta { font-size: 12px; color: var(--kb-ink-secondary); }",
        "",
        "/* Overview: one reading hierarchy, grouped counters and generous document rows. */",
        ".kb-overview { gap: 24px; max-width: 1120px; padding: 32px 36px 48px; }",
        ".kb-overview-head { flex-direction: column; align-items: flex-start; gap: 7px; }",
        ".kb-overview .kb-overview-title { font-size: 26px; line-height: 1.3; font-weight: 650; letter-spacing: -.025em; color: var(--kb-ink); }",
        ".kb-overview-sub { gap: 7px; font-size: 12px; line-height: 1.6; color: var(--kb-ink-secondary); }",
        ".kb-overview .kb-purpose { padding: 20px; gap: 12px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-overview .kb-purpose-textarea { padding: 12px 14px; min-height: 88px; border: 1px solid var(--kb-separator); border-radius: 9px; background: var(--kb-soft); color: var(--kb-ink); font-size: 14px; line-height: 1.75; }",
        ".kb-overview .kb-purpose-foot { gap: 10px; flex-wrap: wrap; }",
        ".kb-overview .kb-stats { gap: 0; overflow: hidden; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-overview .kb-stat { gap: 6px; padding: 20px 24px; border: 0; border-radius: 0; background: transparent; }",
        ".kb-overview .kb-stat + .kb-stat { border-left: 1px solid var(--kb-separator); }",
        ".kb-overview .kb-stat-value { color: var(--kb-ink); font-size: 26px; font-weight: 600; line-height: 1.2; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }",
        ".kb-overview .kb-stat-label { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.5; }",
        ".kb-overview .kb-cols { gap: 20px; }",
        ".kb-overview .kb-panel { gap: 14px; padding: 20px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-overview .kb-section-head { gap: 8px; min-height: 20px; }",
        ".kb-overview .kb-section-title,",
        ".kb-reader .kb-section-title,",
        ".kb-search-results .kb-section-title { color: var(--kb-ink); font-size: 14px; font-weight: 600; line-height: 1.5; }",
        ".kb-overview .kb-section-sub { font-size: 12px; line-height: 1.5; color: var(--kb-ink-secondary); }",
        ".kb-overview .kb-list { margin: 0 -8px -6px; overflow: visible; }",
        ".kb-overview .kb-list-item { min-height: 62px; gap: 12px; padding: 12px 8px; border-radius: 8px; border-top: 1px solid var(--kb-separator); }",
        ".kb-overview .kb-list-item:first-child { border-top: 0; }",
        ".kb-overview .kb-list-main { gap: 5px; }",
        ".kb-overview .kb-list-title { color: var(--kb-ink); font-size: 13px; font-weight: 500; line-height: 1.55; }",
        ".kb-overview .kb-list-meta,",
        ".kb-overview .kb-list-time { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.5; }",
        ".kb-overview .kb-list-time { align-self: flex-start; padding-top: 2px; }",
        ".kb-overview .kb-graph-preview { gap: 16px; }",
        ".kb-overview .kb-mini-graph { height: 200px; border-radius: 10px; background: var(--kb-soft); }",
        ".kb-overview .kb-empty { min-height: 300px; gap: 10px; padding: 40px 24px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-overview .kb-empty-title { color: var(--kb-ink); font-size: 18px; }",
        ".kb-overview .kb-empty-hint { color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.75; }",
        "",
        "/* Stable, opaque paper is deliberately separate from navigation material. */",
        ".kb-reader { width: calc(100% - 64px); max-width: 960px; margin: 24px auto 48px; padding: 0 36px 40px; border: 1px solid var(--kb-separator); border-radius: 16px; background: var(--kb-panel); color: var(--kb-ink); }",
        ".kb-reader-inner { width: 100%; max-width: 760px; margin-inline: auto; }",
        ".kb-reader-top { top: 0; gap: 8px; min-height: 58px; margin: 0 -12px 30px; padding: 12px 0; border-bottom: 1px solid var(--kb-separator); border-radius: 0; background: var(--kb-panel); -webkit-backdrop-filter: none; backdrop-filter: none; }",
        ".kb-reader-actions { gap: 5px; min-width: 0; }",
        ".kb-reader-actions .kb-path { max-width: 170px; background: var(--kb-soft); border-color: var(--kb-separator); color: var(--kb-ink-secondary); }",
        ".kb-reader-actions .kb-path code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".kb-reader .kb-page-title { margin: 0 0 14px; color: var(--kb-ink); font-size: 28px; line-height: 1.4; font-weight: 650; letter-spacing: -.025em; }",
        ".kb-reader .kb-page-meta { gap: 8px; padding-bottom: 18px; border-bottom: 1px solid var(--kb-separator); color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.6; }",
        ".kb-reader .kb-page-time { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.6; }",
        ".kb-reader :is(.kb-page-aliases, .kb-page-edited) { padding-top: 12px; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        ".kb-reader .kb-page-aliases-label { color: var(--kb-ink-secondary); }",
        ".kb-reader .kb-page-body { padding: 28px 0 8px; font-size: 15px; line-height: 1.85; }",
        ".kb-reader .kb-md { color: var(--kb-ink); font-size: 15px; line-height: 1.85; }",
        ".kb-reader .kb-md-p { margin-bottom: 18px; line-height: 1.9; }",
        ".kb-reader .kb-md-h { margin: 32px 0 12px; color: var(--kb-ink); font-weight: 600; line-height: 1.5; letter-spacing: -.015em; }",
        ".kb-reader .kb-md-h1 { font-size: 23px; }",
        ".kb-reader .kb-md-h2 { font-size: 20px; }",
        ".kb-reader .kb-md-h3 { font-size: 17px; }",
        ".kb-reader .kb-md-list { margin-bottom: 20px; padding-left: 24px; }",
        ".kb-reader .kb-md-list li { margin: 7px 0; }",
        ".kb-reader .kb-md-quote { margin: 20px 0; padding: 4px 0 4px 18px; border-left: 3px solid var(--kb-separator); color: var(--kb-ink-secondary); }",
        ".kb-reader .kb-md-pre { margin: 18px 0 22px; padding: 16px 18px; border: 1px solid var(--kb-separator); border-radius: 10px; background: var(--kb-soft); color: var(--kb-ink); font-size: 13px; line-height: 1.75; }",
        ".kb-reader .kb-md-code { padding: 2px 5px; border-radius: 4px; background: var(--kb-soft); color: var(--kb-ink); font-size: .88em; }",
        ".kb-reader .kb-md a { color: var(--kb-accent); border-bottom-color: color-mix(in srgb, var(--kb-accent) 35%, transparent); }",
        ".kb-reader .kb-md strong { color: var(--kb-ink); }",
        ".kb-reader .kb-md-hr { margin: 30px 0; border-color: var(--kb-separator); }",
        ".kb-reader .kb-md-table-wrap { margin: 20px 0 24px; border: 1px solid var(--kb-separator); border-radius: 10px; }",
        ".kb-reader .kb-md-table { font-size: 13px; line-height: 1.75; }",
        ".kb-reader .kb-md-table :is(th, td) { padding: 10px 12px; border-color: var(--kb-separator); }",
        ".kb-reader .kb-md-table th { background: var(--kb-soft); font-size: 12px; color: var(--kb-ink-secondary); }",
        ".kb-reader .kb-wikilink { padding: 1px 4px; border-radius: 4px; background: var(--kb-selection); color: var(--kb-accent); }",
        ".kb-reader .kb-wikilink-missing { background: transparent; color: var(--kb-ink-secondary); border-color: var(--kb-separator); }",
        ".kb-reader .kb-panel { gap: 10px; margin-top: 24px; padding: 22px 0 0; border: 0; border-top: 1px solid var(--kb-separator); border-radius: 0; background: transparent; }",
        ".kb-reader .kb-reader-foot { margin-top: 32px; }",
        ".kb-reader .kb-linklist { border: 0; border-radius: 8px; background: var(--kb-soft); }",
        ".kb-reader .kb-linkitem { min-height: 44px; padding: 11px 14px; color: var(--kb-accent); font-size: 13px; line-height: 1.6; }",
        ".kb-reader :is(.kb-linkitem, .kb-sourceref) + :is(.kb-linkitem, .kb-sourceref)::before { height: 1px; background: var(--kb-separator); }",
        ".kb-reader .kb-sourceref { min-height: 60px; padding: 12px 14px; gap: 10px; }",
        ".kb-reader .kb-sourceref-main { gap: 6px; }",
        ".kb-reader .kb-sourceref-title { color: var(--kb-ink); font-size: 13px; line-height: 1.6; }",
        ".kb-reader .kb-sourceref-status { color: var(--kb-ink-secondary); font-size: 12px; }",
        ".kb-reader .kb-sourceref-actions { gap: 6px; }",
        ".kb-reader .kb-nav-empty { padding: 6px 0; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        "",
        "/* Search preserves context and gives every result enough room for evidence. */",
        ".kb-search-results { width: calc(100% - 64px); max-width: 1048px; gap: 16px; margin: 24px auto 0; padding: 20px 24px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-search-results .kb-section-head { align-items: center; }",
        ".kb-search-results .kb-section-title { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }",
        ".kb-search-results .kb-list { overflow: visible; }",
        ".kb-search-results .kb-search-result { min-height: 72px; padding: 15px 10px; border-top: 1px solid var(--kb-separator); border-radius: 8px; }",
        ".kb-search-results .kb-search-result:first-child { border-top: 0; }",
        ".kb-search-results .kb-list-main { gap: 8px; }",
        ".kb-search-results .kb-list-title { gap: 8px; color: var(--kb-ink); font-size: 14px; font-weight: 500; line-height: 1.6; }",
        ".kb-search-results .kb-search-snippet { color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.8; }",
        ".kb-search-results .kb-search-material { display:flex; align-items:center; flex-wrap:wrap; column-gap:8px; min-width:0; border-top:1px solid var(--kb-separator); padding-right:10px; }",
        ".kb-search-results .kb-search-material:first-child { border-top:0; }",
        ".kb-search-results .kb-search-material .kb-search-result { flex:1 1 18rem; min-width:0; width:auto; }",
        ".kb-search-results .kb-search-material>.kb-linkbtn { margin:0 0 5px 10px; height:auto; white-space:normal; text-align:left; }",
        ".kb-search-tail { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:8px; padding-top:10px; border-top:1px solid var(--kb-separator); }",
        "@media (pointer:coarse){.kb-search-results .kb-search-material>.kb-linkbtn,.kb-search-tail .kb-btn{min-height:44px}}",
        ".kb-search-results .kb-nav-empty { padding: 18px 10px 24px; color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.7; }",
        "",
        "/* Maintenance uses calm grouped lists rather than nested card chrome. */",
        ".kb-health { gap: 24px; max-width: 1120px; padding: 32px 36px 48px; }",
        ".kb-health-head { align-items: flex-start; gap: 12px; }",
        ".kb-health .kb-overview-title { color: var(--kb-ink); font-size: 26px; line-height: 1.3; letter-spacing: -.025em; }",
        ".kb-health .kb-ask-sub { margin-top: 6px; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        ".kb-health-body { gap: 20px; }",
        ".kb-health-summary { gap: 12px; padding: 16px 20px; border: 1px solid var(--kb-separator); border-radius: 12px; background: var(--kb-panel); color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.7; }",
        ".kb-health-time { color: var(--kb-ink-secondary); font-size: 12px; }",
        ".kb-health-good { gap: 14px; padding: 24px; border-radius: 14px; }",
        ".kb-health-good-title { font-size: 15px; line-height: 1.6; }",
        ".kb-health-good-hint { margin-top: 3px; font-size: 13px; line-height: 1.7; }",
        ".kb-health-group { gap: 14px; padding: 20px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-health-group-head { flex-wrap: wrap; gap: 8px; color: var(--kb-ink); }",
        ".kb-health-issues { border: 0; border-radius: 0; background: transparent; }",
        ".kb-health-issue { gap: 12px; padding: 14px 0; }",
        ".kb-health-issue + .kb-health-issue::before { left: 0; right: 0; height: 1px; background: var(--kb-separator); }",
        ".kb-health-issue-main { gap: 5px; }",
        ".kb-health-detail { color: var(--kb-ink); font-size: 13px; line-height: 1.75; }",
        ".kb-health-page { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.6; }",
        ".kb-trash { gap: 16px; padding: 20px; border: 1px solid var(--kb-separator); border-radius: 14px; background: var(--kb-panel); }",
        ".kb-trash-list { max-height: 360px; border: 0; border-radius: 0; background: transparent; }",
        ".kb-trash-item { min-height: 64px; padding: 14px 2px; gap: 16px; }",
        ".kb-trash-item + .kb-trash-item::before { left: 0; right: 0; height: 1px; background: var(--kb-separator); }",
        ".kb-trash-main { gap: 5px; }",
        ".kb-trash-title { color: var(--kb-ink); font-size: 13px; line-height: 1.6; font-weight: 500; white-space: normal; }",
        ".kb-trash-meta { gap: 6px; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.6; }",
        ".kb-trash-actions { gap: 8px; }",
        ".kb-trash-note { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        ".kb-trash-foot { padding-top: 0; }",
        ".kb-trash-empty { padding: 24px 0; color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.7; }",
        "",
        "/* A task sheet keeps stable surfaces, visible labels and reachable actions. */",
        ".kb-modal-overlay { padding: 24px; background: var(--kb-overlay); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }",
        ".kb-sheet,",
        ".kb-modal { width: min(560px, 100%); max-height: min(88dvh, 920px); border: 1px solid var(--kb-separator); border-radius: 16px; background: var(--kb-panel); color: var(--kb-ink); -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: var(--kb-shadow-modal); }",
        ".kb-modal-wide { width: min(780px, 100%); }",
        ".kb-modal-head { gap: 12px; padding: 24px 24px 12px; align-items: flex-start; }",
        ".kb-modal-title-wrap { gap: 10px; min-height: 28px; }",
        ".kb-modal-title { color: var(--kb-ink); font-size: 20px; font-weight: 600; line-height: 1.45; letter-spacing: -.02em; }",
        ".kb-modal-desc { padding: 0 24px 8px; color: var(--kb-ink-secondary); font-size: 13px; line-height: 1.75; }",
        ".kb-modal-body { gap: 20px; padding: 12px 24px 24px; overscroll-behavior: contain; }",
        ".kb-modal-foot { gap: 10px; padding: 16px 24px; border-top: 1px solid var(--kb-separator); background: var(--kb-soft); }",
        ".kb-modal .kb-form-field,",
        ".kb-sheet .kb-form-field { gap: 8px; }",
        ".kb-modal .kb-form-label,",
        ".kb-sheet .kb-form-label { color: var(--kb-ink); font-size: 13px; font-weight: 500; line-height: 1.6; }",
        ".kb-modal .kb-form-label-row { align-items: flex-start; flex-wrap: wrap; }",
        ".kb-modal .kb-form-hint,",
        ".kb-sheet .kb-form-hint { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.75; }",
        ".kb-modal :is(.kb-input, .kb-select),",
        ".kb-sheet :is(.kb-input, .kb-select) { width: 100%; min-height: 38px; height: auto; padding: 8px 10px; border: 1px solid var(--kb-separator); border-radius: 8px; background: var(--kb-panel); color: var(--kb-ink); font-size: 13px; line-height: 1.6; }",
        ".kb-modal .kb-textarea,",
        ".kb-sheet .kb-textarea { padding: 11px 12px; border: 1px solid var(--kb-separator); border-radius: 9px; background: var(--kb-panel); color: var(--kb-ink); font-size: 13px; line-height: 1.75; }",
        ".kb-modal .kb-edit-grid { gap: 20px 16px; }",
        ".kb-modal .kb-edit-markdown { min-height: 300px; font-size: 13px; line-height: 1.8; }",
        ".kb-modal .kb-confirm-list { gap: 0; max-height: 200px; padding: 6px 12px; border: 1px solid var(--kb-separator); border-radius: 9px; background: var(--kb-soft); }",
        ".kb-modal .kb-confirm-item { padding: 6px 0; color: var(--kb-ink); font-size: 13px; line-height: 1.6; white-space: normal; }",
        ".kb-modal .kb-confirm-more { padding: 6px 0; color: var(--kb-ink-secondary); font-size: 12px; }",
        ".kb-modal .kb-modal-warning-item { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.75; }",
        ".kb-modal .kb-original-body { gap: 12px; }",
        ".kb-modal .kb-original-meta { gap: 8px; color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        ".kb-modal .kb-original-pre { max-height: 54dvh; padding: 20px 22px; border: 1px solid var(--kb-separator); border-radius: 10px; background: var(--kb-soft); color: var(--kb-ink); font-size: 15px; line-height: 1.85; }",
        ".kb-modal .kb-original-hint { color: var(--kb-ink-secondary); font-size: 12px; line-height: 1.7; }",
        "",
        "/* Focus is independent of hover, including on the compact source navigator. */",
        ".kb-nav :is(.kb-source-main, .kb-page-item, .kb-page-manage-item, .kb-nav-action, .kb-group-head, .kb-drop, .kb-collapse, .kb-topic-select, .kb-topic-disclosure, .kb-graph-catalog-row):focus-visible,",
        ".kb-overview .kb-list-item:focus-visible,",
        ".kb-search-results .kb-list-item:focus-visible,",
        ".kb-reader :is(.kb-linkitem, .kb-wikilink):focus-visible { outline: 2px solid var(--kb-accent); outline-offset: -2px; }",
        ".kb-modal :is(.kb-input, .kb-textarea, .kb-select, .kb-original-pre):is(:focus, :focus-visible),",
        ".kb-sheet :is(.kb-input, .kb-textarea, .kb-select):is(:focus, :focus-visible),",
        ".kb-overview .kb-purpose-textarea:is(:focus, :focus-visible),",
        ".kb-nav :is(.kb-input, .kb-textarea, .kb-select):is(:focus, :focus-visible) { outline: 2px solid var(--kb-accent); outline-offset: 2px; border-color: var(--kb-accent); box-shadow: none; }",
        "@media (hover: hover) {",
        "  .kb-nav :is(.kb-source-row, .kb-page-item, .kb-page-manage-item, .kb-topic-row, .kb-graph-catalog-row):hover,",
        "  .kb-overview .kb-list-item:hover,",
        "  .kb-search-results .kb-list-item:hover,",
        "  .kb-reader .kb-linkitem:hover,",
        "  .kb-health-issue:hover,",
        "  .kb-trash-item:hover { background: var(--kb-soft); }",
        "  .kb-nav .kb-page-item[data-active=\"true\"]:hover,",
        "  .kb-nav .kb-topic-row[data-selected=\"true\"]:hover { background: var(--kb-selection); }",
        "  .kb-nav .kb-drop:hover { background: var(--kb-selection); border-color: var(--kb-accent); }",
        "}",
        "@container kb-panel (max-width: 1000px) {",
        "  .kb-overview, .kb-health { padding: 28px 24px 40px; }",
        "  .kb-overview .kb-cols { grid-template-columns: minmax(0, 1fr); }",
        "  .kb-overview .kb-stat { padding: 18px; }",
        "  .kb-reader { width: calc(100% - 40px); padding: 0 28px 32px; margin-top: 20px; }",
        "  .kb-search-results { width: calc(100% - 48px); }",
        "}",
        "@container kb-panel (max-width: 760px) {",
        "  .kb-nav :is(.kb-nav-action, .kb-group-head, .kb-page-item, .kb-page-manage-item, .kb-source-main, .kb-collapse, .kb-topic-select, .kb-topic-disclosure, .kb-graph-catalog-row, .kb-select, .kb-input),",
        "  .kb-nav .kb-source-actions .kb-iconbtn,",
        "  .kb-modal :is(.kb-input, .kb-select, .kb-btn, .kb-iconbtn),",
        "  .kb-sheet :is(.kb-input, .kb-select, .kb-btn, .kb-iconbtn),",
        "  .kb-reader :is(.kb-btn, .kb-path, .kb-linkbtn),",
        "  .kb-health :is(.kb-btn, .kb-linkbtn) { min-height: 44px; }",
        "  .kb-nav .kb-source-actions .kb-iconbtn,",
        "  .kb-modal .kb-iconbtn,",
        "  .kb-sheet .kb-iconbtn,",
        "  .kb-nav .kb-topic-disclosure { min-width: 44px; }",
        "  .kb-overview, .kb-health { gap: 20px; padding: 24px 16px 32px; }",
        "  .kb-overview .kb-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
        "  .kb-overview .kb-stat { padding: 18px 20px; }",
        "  .kb-overview .kb-stat:nth-child(3) { border-left: 0; }",
        "  .kb-overview .kb-stat:nth-child(n+3) { border-top: 1px solid var(--kb-separator); }",
        "  .kb-overview .kb-panel, .kb-overview .kb-purpose, .kb-health-group, .kb-trash { padding: 16px; }",
        "  .kb-reader { width: calc(100% - 24px); max-width: none; margin: 12px auto 28px; padding: 0 20px 28px; border-radius: 12px; }",
        "  .kb-reader-top { margin: 0 -8px 24px; gap: 6px; padding: 10px 0; }",
        "  .kb-reader-actions { justify-content: flex-start; flex: 1 1 auto; }",
        "  .kb-reader-actions .kb-path { max-width: 130px; }",
        "  .kb-reader .kb-page-title { font-size: 25px; }",
        "  .kb-reader .kb-page-body { padding-top: 24px; }",
        "  .kb-reader .kb-sourceref { align-items: flex-start; flex-direction: column; }",
        "  .kb-reader .kb-sourceref-actions { flex-wrap: wrap; }",
        "  .kb-search-results { width: calc(100% - 32px); margin-top: 16px; padding: 16px; }",
        "  .kb-health-summary { padding: 16px; }",
        "  .kb-health-time { flex-basis: 100%; margin-left: 0; }",
        "  .kb-health-issue { flex-wrap: wrap; }",
        "  .kb-health-issue-main { flex-basis: calc(100% - 80px); }",
        "  .kb-trash-item { align-items: flex-start; flex-wrap: wrap; gap: 10px; }",
        "  .kb-trash-main { flex-basis: 100%; }",
        "  .kb-trash-actions { margin-left: auto; }",
        "  .kb-modal-overlay { padding: 16px; }",
        "  .kb-modal, .kb-sheet { max-height: calc(100dvh - 32px); border-radius: 14px; }",
        "  .kb-modal .kb-edit-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }",
        "  .kb-modal .kb-form-field-narrow { max-width: none; }",
        "  .kb-modal-head { padding: 20px 20px 10px; }",
        "  .kb-modal-desc { padding: 0 20px 8px; }",
        "  .kb-modal-body { padding: 12px 20px 20px; }",
        "  .kb-modal-foot { padding: 14px 20px; }",
        "  .kb-modal .kb-original-pre { padding: 16px; }",
        "}",
        "@media (pointer: coarse) {",
        "  .kb-nav :is(.kb-nav-action, .kb-group-head, .kb-page-item, .kb-page-manage-item, .kb-source-main, .kb-collapse, .kb-topic-select, .kb-topic-disclosure, .kb-graph-catalog-row, .kb-select, .kb-input),",
        "  .kb-nav .kb-source-actions .kb-iconbtn,",
        "  .kb-modal :is(.kb-input, .kb-select, .kb-btn, .kb-iconbtn),",
        "  .kb-sheet :is(.kb-input, .kb-select, .kb-btn, .kb-iconbtn),",
        "  .kb-reader :is(.kb-btn, .kb-path, .kb-linkbtn),",
        "  .kb-health :is(.kb-btn, .kb-linkbtn) { min-height: 44px; }",
        "  .kb-nav .kb-source-actions .kb-iconbtn,",
        "  .kb-modal .kb-iconbtn,",
        "  .kb-sheet .kb-iconbtn,",
        "  .kb-nav .kb-topic-disclosure { min-width: 44px; }",
        "}",
        "@container kb-panel (max-width: 480px) {",
        "  .kb-overview .kb-overview-title, .kb-health .kb-overview-title { font-size: 24px; }",
        "  .kb-overview .kb-list-time { max-width: 72px; text-align: right; white-space: normal; }",
        "  .kb-reader { padding-inline: 16px; }",
        "  .kb-reader-top { margin-inline: -4px; }",
        "  .kb-reader .kb-page-title { font-size: 23px; }",
        "  .kb-reader .kb-md-h1 { font-size: 21px; }",
        "  .kb-reader .kb-md-h2 { font-size: 19px; }",
        "  .kb-modal-overlay { padding: 8px; }",
        "  .kb-modal, .kb-sheet { max-height: calc(100dvh - 16px); }",
        "  .kb-modal-head { padding: 20px 16px 10px; }",
        "  .kb-modal-desc { padding-inline: 16px; }",
        "  .kb-modal-body { padding: 10px 16px 20px; }",
        "  .kb-modal-foot { padding: 12px 16px; }",
        "  .kb-modal .kb-original-pre { padding: 14px; }",
        "}",
        "@media (prefers-reduced-transparency: reduce) {",
        "  .kb-modal-overlay { background: var(--kb-overlay); -webkit-backdrop-filter: none; backdrop-filter: none; }",
        "}",
        "@media (prefers-reduced-motion: reduce) {",
        "  .kb-modal, .kb-sheet { animation: none; }",
        "}",
        "@media (forced-colors: active) {",
        "  .kb-nav :is(.kb-source-main, .kb-page-item, .kb-nav-action, .kb-drop):focus-visible,",
        "  .kb-overview .kb-list-item:focus-visible,",
        "  .kb-search-results .kb-list-item:focus-visible,",
        "  .kb-modal :is(.kb-input, .kb-textarea, .kb-select, .kb-original-pre):focus-visible { outline: 2px solid Highlight; }",
        "}",
        "/* UI 2026-11: ui-workspaces.css */",
        "/* Books, sources and questions. Layout dimensions are project choices for the web UI. */",
        ".kb-books,.kb-book-detail{background:var(--kb-canvas);color:var(--kb-ink)}",
        ".kb-reading{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;margin:0 24px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel)}",
        ".kb-reading[hidden],.kb-book-summary[hidden]{display:none}",
        ".kb-reading-shelf{padding:0 20px 12px;font-size:14px;line-height:1.6}.kb-reading-shelf p{margin:4px 0}",
        ".kb-reading-inner{max-width:1120px;margin:0 auto;padding:28px 32px 48px;color:var(--kb-ink)}",
        ".kb-reading-toolbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.kb-reading-toolbar h3{margin:0 0 8px;font-size:22px;line-height:1.4;font-weight:650}.kb-reading-toolbar .kb-btn{flex-shrink:0}",
        ".kb-reading-coverage{margin:20px 0 16px;padding:14px 18px;background:var(--kb-soft);border-radius:10px;font-size:13px;line-height:1.65}.kb-reading-coverage p{margin:0}.kb-reading-coverage p+p{margin-top:5px}.kb-reading-source-note{color:var(--kb-ink-secondary)}",
        ".kb-reading-progress{font-size:13px;line-height:1.65;color:var(--kb-ink-secondary);margin:12px 0}.kb-reading-progress progress{display:block;width:100%;height:5px;accent-color:var(--kb-accent)}",
        ".kb-reading-welcome{padding:18px 0;line-height:1.8;font-size:16px}.kb-reading-preview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px;margin:28px 0}.kb-reading-preview>div{padding-top:18px;border-top:1px solid var(--kb-separator)}.kb-reading-preview h4{margin:0 0 8px;font-size:16px}.kb-reading-preview p{margin:0;font-size:14px;color:var(--kb-ink-secondary)}",
        ".kb-reading-views{display:flex;flex-wrap:wrap;gap:8px;padding:14px 0 24px}.kb-reading-views .kb-btn[data-active=true]{background:var(--kb-selection);border-color:var(--kb-accent);color:var(--kb-accent)}",
        ".kb-reading-prose{max-width:780px;margin:0 auto;font-size:16px;line-height:1.85;overflow-wrap:anywhere}.kb-reading-prose .kb-md{font-size:16px;line-height:1.85}.kb-reading-prose h4{margin:0 0 16px;font-size:21px;line-height:1.5;font-weight:650}.kb-reading-thesis{padding:24px;background:var(--kb-soft);border-radius:12px;margin-bottom:34px}.kb-reading-thesis p{margin:0}.kb-reading-section{margin-bottom:38px}.kb-reading-section p{margin-block:0 1em}",
        ".kb-reading-sources,.kb-reading-chapter{font-size:13px;line-height:1.7}.kb-reading-sources summary,.kb-reading-chapter summary,.kb-reading-relations summary{cursor:pointer;padding:10px 0;color:var(--kb-accent)}.kb-reading-citations{display:flex;flex-wrap:wrap;gap:4px 16px;padding:8px 0}.kb-reading-citations .kb-linkbtn{white-space:normal;text-align:left;overflow-wrap:anywhere;min-height:32px;line-height:1.5}.kb-reading-chapter{border-top:1px solid var(--kb-separator);padding:6px 0 12px}.kb-reading-chapter summary{font-size:15px;color:var(--kb-ink);font-weight:550}.kb-reading-chapter h5{font-size:18px;line-height:1.55;margin:20px 0 12px}.kb-reading-chapter-thesis{color:var(--kb-ink-secondary);font-size:15px}.kb-reading-prose h4.kb-reading-chapter-title{margin-top:48px;font-size:18px}",
        ".kb-reading-card-controls{display:flex;align-items:flex-end;gap:20px;justify-content:space-between;flex-wrap:wrap;margin:0 0 24px}.kb-reading-card-controls>label:first-child{display:flex;flex-direction:column;gap:8px;flex:1;max-width:380px;font-size:13px}.kb-reading-checkbox{display:flex;align-items:center;gap:8px;min-height:40px;font-size:13px;color:var(--kb-ink-secondary)}.kb-reading-checkbox input{accent-color:var(--kb-accent);width:16px;height:16px}",
        // Project choices: compact responsive tiles, two-line preview, and a readable in-place detail sheet.
        ".kb-reading-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));gap:14px}.kb-reading-card{appearance:none;display:flex;flex-direction:column;align-items:stretch;gap:10px;min-width:0;min-height:186px;padding:18px;border:1px solid var(--kb-separator);border-radius:12px;background:var(--kb-panel);color:var(--kb-ink);font:inherit;text-align:left;cursor:pointer;overflow-wrap:anywhere;transition:border-color var(--kb-fast),background var(--kb-fast),box-shadow var(--kb-fast)}.kb-reading-card:active{background:var(--kb-soft)}.kb-reading-card-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.5;color:var(--kb-ink-secondary)}.kb-reading-card-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:16px;font-weight:600;line-height:1.5;letter-spacing:-.01em}.kb-reading-card-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:13px;line-height:1.65;color:var(--kb-ink-secondary)}.kb-reading-card-open{display:flex;align-items:center;gap:5px;margin-top:auto;padding-top:3px;color:var(--kb-accent);font-size:12px;line-height:1.5}.kb-reading-card-open svg{flex:none}",
        "@media(hover:hover){.kb-reading-card:hover{border-color:var(--kb-accent);box-shadow:0 2px 8px color-mix(in srgb,var(--kb-ink) 7%,transparent)}}",
        ".kb-reading-card-modal .kb-modal{width:min(700px,100%)}.kb-reading-card-modal .kb-modal-title{font-size:22px;line-height:1.5}.kb-reading-card-modal .kb-modal-desc{font-size:13px}.kb-reading-card-modal .kb-modal-foot .kb-btn{min-height:36px}.kb-reading-card-full{min-width:0;overflow-wrap:anywhere}.kb-reading-card-full .kb-md{font-size:16px;line-height:1.85}.kb-reading-card-full .kb-md>:first-child{margin-top:0}.kb-reading-card-full .kb-md>:last-child{margin-bottom:0}.kb-reading-card-detail{padding-top:18px;margin-top:18px;border-top:1px solid var(--kb-separator)}.kb-reading-card-detail h3{font-size:13px;line-height:1.6;color:var(--kb-ink-secondary);font-weight:600;margin:0 0 8px}.kb-reading-card-detail p{font-size:15px;line-height:1.8;margin:0}.kb-reading-card-full .kb-reading-citations{margin-top:18px;padding-top:14px;border-top:1px solid var(--kb-separator)}",
        "/* Project choices: web diagram explorer, 196x88 SVG nodes and responsive reading detail. */",
        ".kb-reading-map-tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px;margin:0 0 24px}",
        ".kb-reading-map-tabs .kb-graph-chip{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:6px;min-height:112px;padding:16px;text-align:left;border-radius:12px;background:var(--kb-panel);border:1px solid var(--kb-separator);color:var(--kb-ink);line-height:1.5;white-space:normal;opacity:1}",
        ".kb-reading-map-tabs .kb-graph-chip[data-active=true]{border-color:var(--kb-accent);background:var(--kb-selection);color:var(--kb-ink)}",
        ".kb-reading-map-kind{font-size:12px;color:var(--kb-accent);font-weight:600}.kb-reading-map-title{font-size:16px;font-weight:600}.kb-reading-map-count{font-size:12px;color:var(--kb-ink-secondary);margin-top:auto}",
        ".kb-reading-maps h4{font-size:20px;line-height:1.5;margin:16px 0 10px}.kb-reading-map-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-top:20px}.kb-reading-map-modes{display:flex;flex-wrap:wrap;gap:6px}.kb-reading-map-toolbar .kb-btn{min-height:36px;gap:6px}.kb-reading-map-modes .kb-btn[data-active=true]{color:var(--kb-accent);border-color:var(--kb-accent);background:var(--kb-selection)}",
        ".kb-reading-map-legend{display:flex;flex-wrap:wrap;gap:18px;font-size:12px;color:var(--kb-ink-secondary);margin:14px 0 10px;line-height:1.5}.kb-reading-map-legend span{display:flex;gap:7px;align-items:center}.kb-reading-map-legend i{display:block;width:22px;border-top:2px solid var(--kb-ink-secondary)}.kb-reading-map-legend i.is-inference{border-top-style:dashed}",
        ".kb-reading-diagram-scroll{overflow:auto;overscroll-behavior:contain;max-height:570px;border:1px solid var(--kb-separator);border-radius:12px;background:var(--kb-soft);margin:10px 0 12px;scrollbar-gutter:stable}",
        ".kb-reading-diagram-scroll>svg{display:block;width:100%;min-width:760px}.kb-reading-node{cursor:pointer}.kb-reading-node rect{fill:var(--kb-panel);stroke:var(--kb-separator);stroke-width:1.5}.kb-reading-node text{fill:var(--kb-ink);font-size:14px;font-weight:550;pointer-events:none}.kb-reading-node text.kb-reading-node-caption{fill:var(--kb-ink-secondary);font-size:11px;font-weight:400}.kb-reading-node[aria-pressed=true] rect{fill:var(--kb-selection);stroke:var(--kb-accent);stroke-width:2}.kb-reading-node:focus{outline:none}.kb-reading-node:focus-visible rect{stroke:var(--kb-accent);stroke-width:4}",
        ".kb-reading-edge-label{font-size:12px;fill:var(--kb-ink-secondary);paint-order:stroke;stroke:var(--kb-soft);stroke-width:5px;stroke-linejoin:round}.kb-reading-edge[data-active=true] .kb-reading-edge-label{fill:var(--kb-accent);font-weight:600}.kb-reading-edge[data-active=false] path{opacity:.45}",
        ".kb-reading-map-hint{font-size:12px;line-height:1.7;color:var(--kb-ink-secondary);margin:8px 0 18px}.kb-reading-node-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}.kb-reading-node-buttons .kb-graph-chip{display:flex;align-items:center;gap:7px;min-height:40px;height:auto;padding:8px 10px;font-size:13px;line-height:1.5;white-space:normal;opacity:1}.kb-reading-node-buttons .kb-graph-chip[data-active=true]{background:var(--kb-selection);color:var(--kb-accent);box-shadow:inset 0 0 0 1px var(--kb-accent)}.kb-reading-node-number{font-size:11px;font-variant-numeric:tabular-nums;color:var(--kb-ink-secondary)}",
        ".kb-reading-node-detail{padding:24px 0 0;background:transparent;border-top:1px solid var(--kb-separator);border-radius:0;font-size:15px;line-height:1.8;overflow-wrap:anywhere;min-width:0}.kb-reading-node-detail p{margin:0}.kb-reading-node-detail .kb-reading-node-eyebrow{font-size:12px;font-weight:600;color:var(--kb-accent);margin-bottom:6px}.kb-reading-node-detail h5{font-size:22px;line-height:1.5;margin:0 0 10px}.kb-reading-node-explanation{max-width:800px;font-size:16px;line-height:1.85}.kb-reading-node-detail h6,.kb-reading-expanded-note h6{font-size:13px;line-height:1.6;font-weight:600;margin:0 0 10px;color:var(--kb-ink-secondary)}",
        ".kb-reading-connections{margin:22px 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kb-reading-connections>h6{grid-column:1/-1;margin-bottom:0}.kb-reading-connection{appearance:none;display:flex;flex-direction:column;align-items:flex-start;gap:5px;width:100%;text-align:left;font:inherit;line-height:1.65;color:var(--kb-ink);background:var(--kb-soft);border:1px solid var(--kb-separator);border-radius:10px;padding:12px;cursor:pointer;overflow-wrap:anywhere;min-height:44px}.kb-reading-connection-path{font-size:13px;font-weight:500}.kb-reading-connection-meta{font-size:11px;color:var(--kb-accent)}",
        ".kb-reading-node-study{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(240px,.85fr);gap:28px;align-items:start;margin-top:28px}.kb-reading-study-cards,.kb-reading-study-chapters{min-width:0}.kb-reading-study-hint{font-size:12px;line-height:1.7;color:var(--kb-ink-secondary);margin:0 0 12px!important}.kb-reading-study-card{border:1px solid var(--kb-separator);border-radius:10px;margin-bottom:10px;overflow:hidden;background:var(--kb-panel)}.kb-reading-study-card>summary{cursor:pointer;padding:14px 16px;font-size:14px;line-height:1.6;color:var(--kb-ink);min-height:44px;box-sizing:border-box}.kb-reading-study-card-title{font-weight:600}.kb-reading-study-card-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;font-weight:400;line-height:1.7;color:var(--kb-ink-secondary);margin:6px 0 0 14px}.kb-reading-study-card[open] .kb-reading-study-card-preview{display:none}.kb-reading-study-card[open]>summary{background:var(--kb-soft)}",
        ".kb-reading-study-card-body{padding:16px;font-size:14px;line-height:1.85}.kb-reading-study-card-body .kb-md{font-size:14px;line-height:1.85}.kb-reading-study-card-body .kb-md>:first-child{margin-top:8px}.kb-reading-study-card-body .kb-md>:last-child{margin-bottom:0}.kb-reading-study-card-body>section{margin-top:16px;padding-top:14px;border-top:1px solid var(--kb-separator)}.kb-reading-study-card-body>section h6{margin:0 0 6px}.kb-reading-study-meta{font-size:11px;line-height:1.7;color:var(--kb-ink-secondary)}.kb-reading-node-study .kb-reading-citations .kb-linkbtn{min-height:44px;font-size:12px}.kb-reading-node-study .kb-reading-chapter{padding:4px 0 12px}.kb-reading-node-study .kb-reading-chapter summary{font-size:14px;min-height:44px;box-sizing:border-box}.kb-reading-node-study .kb-reading-chapter h5{font-size:17px;margin:14px 0 8px}.kb-reading-node-study .kb-reading-chapter .kb-md{font-size:14px;line-height:1.85}",
        ".kb-reading-map-modal .kb-modal{width:min(1220px,100%)}.kb-reading-map-modal .kb-modal-body{display:block;padding-top:8px}.kb-reading-map-modal .kb-reading-diagram-scroll{max-height:60dvh;margin-top:8px}.kb-reading-map-modal .kb-reading-diagram-scroll>svg{display:block;width:100%;min-width:900px}.kb-reading-expanded-note h3{font-size:18px;margin:16px 0 8px}.kb-reading-expanded-note p{font-size:15px;line-height:1.8;margin:0}.kb-reading-expanded-note .kb-reading-connections{margin:16px 0 0}.kb-reading-relations{font-size:14px;line-height:1.8;margin-top:20px}.kb-reading-relations li{margin-bottom:10px}.kb-reading :is(button,input,summary,[tabindex]):focus-visible,.kb-reading-map-modal :is(button,[tabindex]):focus-visible{outline:2px solid var(--kb-accent);outline-offset:3px}",
        "@media(hover:hover){.kb-reading-connection:hover,.kb-reading-study-card>summary:hover{background:var(--kb-selection)}.kb-reading-map-tabs .kb-graph-chip:hover{border-color:var(--kb-accent)}}",
        "@container kb-panel (max-width:900px){.kb-reading-node-study{grid-template-columns:1fr;gap:24px}.kb-reading-node-detail h5{font-size:20px}}",
        "@container kb-panel (max-width:760px){.kb-reading-map-tabs{grid-template-columns:1fr}.kb-reading-map-tabs .kb-graph-chip{min-height:96px;padding:14px}.kb-reading-map-toolbar .kb-btn,.kb-reading-node-buttons .kb-graph-chip,.kb-reading-map-modal .kb-modal-foot .kb-btn{min-height:44px}.kb-reading-diagram-scroll{max-height:450px}.kb-reading-node-buttons .kb-graph-chip{justify-content:flex-start;max-width:100%;text-align:left}.kb-reading-node-detail{padding-top:20px}.kb-reading-connections{grid-template-columns:1fr}.kb-reading-node-explanation{font-size:15px}.kb-reading-study-card-body{padding:14px}}",
        "@container kb-panel (max-width:760px){.kb-reading{margin:0 16px 16px}.kb-reading-inner{padding:22px 18px 32px}.kb-reading-toolbar{flex-wrap:wrap;gap:12px}.kb-reading-preview{grid-template-columns:1fr;gap:16px;margin:16px 0}.kb-reading-card{padding:16px}.kb-reading-views .kb-btn,.kb-reading-citations .kb-linkbtn,.kb-reading-map-tabs button,.kb-reading-node-buttons button,.kb-reading-card-modal .kb-modal-foot .kb-btn{min-height:44px}.kb-reading-thesis{padding:20px}.kb-reading-prose h4{font-size:19px}.kb-reading-checkbox{min-height:44px}}",
        ".kb-books-head,.kb-book-detail-head{gap:16px;padding:28px 32px 20px;flex-shrink:0}",
        ".kb-books-head .kb-overview-title,.kb-book-detail-head .kb-overview-title{margin:0;color:var(--kb-ink);font-size:26px;font-weight:650;line-height:1.35;letter-spacing:-.025em;overflow-wrap:anywhere}",
        ".kb-books-head .kb-graph-copy,.kb-book-titles .kb-graph-copy{margin:7px 0 0;color:var(--kb-ink-secondary);font-size:13px;line-height:1.65}",
        ".kb-books-actions{gap:8px}",
        ".kb-books-scroll{padding:0 32px 32px;scrollbar-gutter:stable}",
        ".kb-books-intro{max-width:780px;margin:0 0 20px;font-size:12px;line-height:1.75;color:var(--kb-ink-secondary)}",
        ".kb-books-scroll>.kb-empty{min-height:350px;padding:48px 24px;background:var(--kb-panel);border:1px solid var(--kb-separator);border-radius:16px}",
        ".kb-books .kb-empty-icon,.kb-book-reader .kb-empty-icon{width:56px;height:56px;margin-bottom:8px;background:var(--kb-selection);color:var(--kb-accent);border-radius:15px}",
        ".kb-books .kb-empty-title,.kb-book-reader .kb-empty-title{color:var(--kb-ink);font-size:19px;line-height:1.5;letter-spacing:-.015em}",
        ".kb-books .kb-empty-hint,.kb-book-reader .kb-empty-hint,.kb-book-messages .kb-empty-hint{max-width:450px;color:var(--kb-ink-secondary);font-size:13px;line-height:1.8}",
        ".kb-books .kb-empty-action{margin-top:12px}",
        ".kb-book-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:16px}",
        ".kb-book-card{gap:20px;min-width:0;padding:22px;background:var(--kb-panel);border:1px solid var(--kb-separator);border-radius:14px;box-shadow:none}",
        ".kb-book-card:focus-within{border-color:var(--kb-accent)}",
        ".kb-book-card-open{display:grid;grid-template-columns:58px minmax(0,1fr);grid-template-rows:auto 1fr;column-gap:16px;row-gap:5px;align-items:start;padding:0;border-radius:8px;min-height:78px}",
        ".kb-book-cover{grid-row:1 / span 2;width:58px;height:76px;margin:0;border:1px solid var(--kb-separator);border-left:5px solid var(--kb-accent);border-radius:4px 9px 9px 4px;background:var(--kb-selection);color:var(--kb-accent)}",
        ".kb-book-card-title{padding-top:2px;color:var(--kb-ink);font-size:16px;font-weight:600;line-height:1.55;letter-spacing:-.015em}",
        ".kb-book-card-name{color:var(--kb-ink-secondary);font-size:12px;line-height:1.55}",
        ".kb-book-card-footer{padding-top:14px;border-top:1px solid var(--kb-separator);gap:8px}",
        ".kb-book-card-footer .kb-linkbtn{height:auto;min-height:32px;padding:4px 0;color:var(--kb-accent);font-size:13px}",
        ".kb-book-card-footer .kb-btn-ghost{color:var(--kb-ink-secondary)}",
        ".kb-book-progress{gap:9px;min-width:0}",
        ".kb-book-progress-label{gap:8px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums}",
        ".kb-book-progress progress{display:block;width:100%;height:5px;border-radius:5px;overflow:hidden;background:var(--kb-soft);accent-color:var(--kb-accent-fill)}",
        ".kb-book-progress progress::-webkit-progress-bar{background:var(--kb-soft);border-radius:5px}",
        ".kb-book-progress progress::-webkit-progress-value{background:var(--kb-accent-fill);border-radius:5px}",
        ".kb-book-progress progress::-moz-progress-bar{background:var(--kb-accent-fill);border-radius:5px}",
        ".kb-book-warning{padding:11px 13px;color:var(--kb-ink);background:var(--kb-soft);font-size:12px;line-height:1.75;border-radius:7px}",
        ".kb-book-import-status{gap:9px;margin:0 0 16px;padding:12px 14px;color:var(--kb-ink);background:var(--kb-selection);border-radius:9px;font-size:13px;line-height:1.6}",
        ".kb-book-detail-head{flex-shrink:0;align-items:center;gap:8px 16px;padding:16px 24px 6px}",
        ".kb-book-detail-head>.kb-btn{padding-inline:0;color:var(--kb-accent)}",
        ".kb-book-titles{flex:1 1 12rem}",
        ".kb-book-detail-head .kb-book-titles .kb-overview-title{margin:0;font-size:1.5rem;overflow-wrap:anywhere}",
        ".kb-book-detail-head .kb-books-actions .kb-btn{height:auto;white-space:normal;text-align:center;text-decoration:none}",
        ".kb-book-summary{margin:0 24px 10px}",
        ".kb-book-summary .kb-graph-copy{margin:0;color:var(--kb-ink-secondary);font-size:12px;line-height:1.7}",
        ".kb-book-summary .kb-book-progress{gap:6px}",
        ".kb-book-summary progress{max-width:760px}",
        ".kb-book-summary .kb-inline-error{margin:0}",
        ".kb-book-diagnostics>summary{width:fit-content;max-width:100%;min-height:32px;gap:5px 9px;padding:4px 3px;cursor:pointer;list-style:none;border-radius:6px;overflow-wrap:anywhere}",
        ".kb-book-diagnostics>summary::-webkit-details-marker{display:none}",
        ".kb-book-diagnostics>summary::before{content:'';width:6px;height:6px;margin-inline:1px 3px;flex:none;border-inline-end:1.5px solid currentColor;border-block-end:1.5px solid currentColor;transform:rotate(-45deg);color:var(--kb-accent)}",
        ".kb-book-diagnostics[open]>summary::before{transform:rotate(45deg)}",
        ".kb-book-diagnostics-title{color:var(--kb-accent);font-weight:500}",
        ".kb-book-diagnostics>summary:hover .kb-book-diagnostics-title{text-decoration:underline}",
        ".kb-book-coverage{padding:2px 7px;border-radius:var(--kb-r-pill);background:var(--kb-soft);color:var(--kb-ink-secondary)}",
        ".kb-book-diagnostics-body{display:flex;flex-direction:column;gap:8px;max-width:760px;max-height:min(14rem,30vh);margin-top:4px;padding:12px 14px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;border:1px solid var(--kb-separator);border-radius:10px;background:var(--kb-panel);overflow-wrap:anywhere}",
        ".kb-book-diagnostics-body>*{flex-shrink:0}",
        ".kb-book-warnings{color:var(--kb-ink-secondary);font-size:12px;line-height:1.75}",
        ".kb-book-warnings summary{min-height:28px;padding-block:3px;color:var(--kb-accent)}",
        ".kb-book-warnings ul{margin:4px 0 0;padding-inline-start:20px}",
        ".kb-book-warnings li+li{margin-top:6px}",
        ".kb-book-modes{flex-shrink:0;align-self:flex-start;gap:3px;margin:0 24px 12px;padding:3px;border:1px solid var(--kb-separator);border-radius:9px;background:var(--kb-soft)}",
        ".kb-book-modes .kb-graph-chip,.kb-book-modes .kb-graph-chip[data-active=\"false\"]{height:auto;min-height:32px;justify-content:center;padding:7px 16px;background:transparent;border:1px solid transparent;border-radius:6px;color:var(--kb-ink-secondary);font-size:13px;line-height:1.25;text-align:center;box-shadow:none;transition:none}",
        ".kb-book-modes .kb-graph-chip[data-active=\"false\"]:hover{background:var(--kb-sidebar)}",
        ".kb-book-modes .kb-graph-chip[data-active=\"true\"]{background:var(--kb-panel);border-color:var(--kb-separator);color:var(--kb-accent);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--kb-ink) 6%,transparent)}",
        ".kb-book-detail>.kb-reading,.kb-book-detail>.kb-book-workspace{flex:1 0 12rem}",
        ".kb-book-workspace{grid-template-columns:minmax(220px,280px) minmax(0,1fr);margin:0 24px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel)}",
        ".kb-book-nav{gap:5px;padding:14px 10px;background:var(--kb-sidebar);border-right:1px solid var(--kb-separator)}",
        ".kb-book-nav>.kb-graph-copy{margin:0;padding:5px 10px 10px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.6}",
        ".kb-book-nav>.kb-form-label{margin:2px 6px 3px;color:var(--kb-ink-secondary);font-size:12px}",
        ".kb-book-nav>.kb-input,.kb-book-nav>.kb-select{flex:none;width:calc(100% - 12px);margin:0 6px 6px;background:var(--kb-panel)}",
        ".kb-book-nav-row{gap:4px;min-height:60px;padding:10px 12px;border:1px solid transparent;border-radius:8px;color:var(--kb-ink);box-shadow:none}",
        ".kb-book-nav-row:hover{background:var(--kb-soft)}",
        ".kb-book-nav-row[aria-current=\"page\"]{background:var(--kb-selection);border-color:transparent;color:var(--kb-accent);box-shadow:none}",
        ".kb-book-nav-title{font-size:13px;line-height:1.6;font-weight:500}",
        ".kb-book-nav-meta,.kb-book-nav-snippet{color:var(--kb-ink-secondary);font-size:12px;line-height:1.6}",
        ".kb-book-nav-row[aria-current=\"page\"] .kb-book-nav-title{font-weight:600}",
        ".kb-book-nav-row[aria-current=\"page\"] .kb-book-nav-meta{color:var(--kb-accent)}",
        ".kb-book-reader{padding:32px 36px;background:var(--kb-panel)}",
        ".kb-book-reader>article{max-width:780px;margin-inline:auto}",
        ".kb-book-reader .kb-page-title{margin:16px 0 26px;color:var(--kb-ink);font-size:26px;font-weight:650;line-height:1.45;letter-spacing:-.025em;overflow-wrap:anywhere}",
        ".kb-book-reader-meta{gap:8px;color:var(--kb-ink-secondary)}",
        ".kb-book-original{font-size:15px;line-height:1.9;color:var(--kb-ink);tab-size:2}",
        ".kb-book-reading-sources{gap:8px;margin-top:36px;padding-top:20px;border-top:1px solid var(--kb-separator)}",
        ".kb-book-reading-sources h4{margin:0 0 5px;color:var(--kb-ink-secondary);font-size:12px;font-weight:600;line-height:1.6}",
        ".kb-book-reading-sources .kb-linkbtn{min-height:32px;height:auto;padding:4px 0;color:var(--kb-accent);font-size:13px;line-height:1.6;text-align:left;white-space:normal}",
        ".kb-book-ask{margin:0 24px 24px;overflow:hidden;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel)}",
        ".kb-book-ask-head,.kb-book-question{padding-inline:max(16px,calc((100% - 820px)/2))}",
        ".kb-book-ask-head{padding-block:6px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-book-ask-head .kb-graph-copy{margin:0;color:var(--kb-ink-secondary);font-size:12px;line-height:1.65}",
        ".kb-book-messages{gap:20px;padding:12px 16px;background:var(--kb-panel)}",
        ".kb-book-messages>.kb-msg{width:100%;margin-inline:auto;flex-shrink:0}",
        ".kb-book-citation{min-height:24px;min-width:24px;padding:0 3px;border-radius:4px;color:var(--kb-accent);font-size:.9em;font-weight:600;text-decoration:underline;text-underline-offset:2px}",
        ".kb-book-citation:hover{background:var(--kb-selection)}",
        ".kb-book-messages>.kb-empty{flex:none;min-height:0;gap:5px;margin-block:auto;padding:12px 0}",
        ".kb-book-messages .kb-empty-icon{width:38px;height:38px;margin-bottom:4px;border-radius:10px;background:var(--kb-selection);color:var(--kb-accent)}",
        ".kb-book-messages .kb-empty-title{color:var(--kb-ink);font-size:1rem;line-height:1.5;letter-spacing:-.015em}",
        ".kb-book-question{padding-block:10px 14px;border-top:1px solid var(--kb-separator);background:var(--kb-panel)}",
        "",
        "/* A quiet list rather than a wall of bordered action buttons. */",
        ".kb-sources{max-width:1240px;gap:20px;padding:28px 32px 36px;color:var(--kb-ink)}",
        ".kb-sources-head{gap:10px;align-items:center}",
        ".kb-sources-head .kb-ask-titles{gap:7px;flex:1 1 280px}",
        ".kb-sources-head .kb-overview-title{margin:0;color:var(--kb-ink);font-size:26px;font-weight:650;line-height:1.35;letter-spacing:-.025em}",
        ".kb-sources-head .kb-ask-sub{color:var(--kb-ink-secondary);font-size:13px;line-height:1.65}",
        ".kb-sources-head>.kb-header-spacer{display:none}",
        ".kb-sources-toolbar{gap:12px;padding:0 0 2px}",
        ".kb-sources .kb-filter-chips{max-width:100%;gap:2px;padding:3px;border:1px solid var(--kb-separator);border-radius:9px;background:var(--kb-soft)}",
        ".kb-sources .kb-filter-chip{height:auto;min-height:30px;padding:7px 11px;gap:6px;border:1px solid transparent;border-radius:6px;color:var(--kb-ink-secondary);font-size:12px;font-weight:500;line-height:1.2}",
        ".kb-sources .kb-filter-chip:hover:not([data-active=\"true\"]){color:var(--kb-ink)}",
        ".kb-sources .kb-filter-chip[data-active=\"true\"]{border-color:var(--kb-separator);background:var(--kb-panel);color:var(--kb-ink);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--kb-ink) 6%,transparent)}",
        ".kb-sources .kb-filter-count{color:var(--kb-ink-secondary);font-size:11px;font-weight:500}",
        ".kb-sources .kb-filter-chip[data-active=\"true\"] .kb-filter-count{color:var(--kb-accent)}",
        ".kb-sources .kb-filter-input{flex:0 1 240px;width:240px;min-height:36px;margin-left:auto;border-color:var(--kb-separator);border-radius:9px;background:var(--kb-panel);font-size:13px}",
        ".kb-sources .kb-manage-bar-page{min-height:44px;padding:8px 14px;border:1px solid var(--kb-separator);border-radius:10px;background:var(--kb-selection)}",
        ".kb-sources .kb-manage-selectall{color:var(--kb-ink);font-size:13px;line-height:1.6}",
        ".kb-sources-card{border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel);box-shadow:none}",
        ".kb-sources .kb-source-item{gap:18px;min-height:84px;padding:16px 20px;background:transparent}",
        ".kb-sources .kb-source-item+.kb-source-item::before{left:20px;right:20px;height:1px;background:var(--kb-separator)}",
        ".kb-sources .kb-source-item:hover{background:var(--kb-soft)}",
        ".kb-sources .kb-source-item-main{gap:12px;min-height:44px;align-items:center;border-radius:6px}",
        ".kb-sources .kb-source-item .kb-status-dot{width:7px;height:7px;margin-top:0;align-self:center}",
        ".kb-sources .kb-source-item .kb-source-body{gap:6px}",
        ".kb-sources .kb-source-item .kb-source-title{color:var(--kb-ink);font-size:14px;font-weight:550;line-height:1.6}",
        ".kb-sources .kb-source-item .kb-source-meta{gap:6px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.5}",
        ".kb-sources .kb-source-item-actions{gap:6px;align-self:center;max-width:44%}",
        ".kb-sources .kb-source-item-actions .kb-btn{min-height:34px;padding:7px 9px;border-color:transparent;background:transparent;color:var(--kb-accent);font-size:12px}",
        ".kb-sources .kb-source-item-actions .kb-btn:hover:not(:disabled){background:var(--kb-selection)}",
        ".kb-sources .kb-source-item-actions .kb-btn-danger{color:var(--kb-on-error)}",
        ".kb-sources .kb-source-item-actions .kb-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--kb-panel))}",
        ".kb-sources .kb-source-item-manage{min-height:84px;align-items:center}",
        ".kb-sources .kb-source-selected{background:var(--kb-selection)}",
        ".kb-sources>.kb-empty{min-height:340px;padding:48px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel)}",
        ".kb-sources .kb-empty-title{color:var(--kb-ink);font-size:19px;line-height:1.5}",
        ".kb-sources .kb-empty-hint{color:var(--kb-ink-secondary);font-size:13px;line-height:1.8}",
        "",
        "/* Questions retain room for reading; the composer is the primary control. */",
        ".kb-ask{background:var(--kb-canvas);color:var(--kb-ink)}",
        ".kb-ask>.kb-ask-head{max-width:1040px;align-items:flex-start;gap:12px;padding:28px 32px 20px}",
        ".kb-ask>.kb-ask-head .kb-ask-titles{gap:7px}",
        ".kb-ask>.kb-ask-head .kb-overview-title{margin:0;color:var(--kb-ink);font-size:26px;font-weight:650;line-height:1.35;letter-spacing:-.025em}",
        ".kb-ask>.kb-ask-head .kb-ask-sub{color:var(--kb-ink-secondary);font-size:13px;line-height:1.65}",
        ".kb-ask-scroll{max-width:1040px;gap:30px;padding:8px 32px 24px}",
        ".kb-ask-example{flex:none;min-width:0;max-width:420px;margin:auto;padding:4px 8px;text-align:center;color:var(--kb-ink-secondary);font-size:.8125rem;line-height:1.65;overflow-wrap:anywhere}",
        ".kb-ask .kb-msg,.kb-book-messages .kb-msg{max-width:820px}",
        ".kb-ask .kb-msg-role,.kb-book-messages .kb-msg-role{margin-bottom:8px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.5}",
        ".kb-ask .kb-avatar,.kb-book-messages .kb-avatar{width:22px;height:22px;border-radius:6px;background:var(--kb-selection);color:var(--kb-accent)}",
        ".kb-ask .kb-msg-user-bubble,.kb-book-messages .kb-msg-user-bubble{max-width:86%;padding:12px 16px;border:0;border-radius:14px 14px 4px 14px;background:var(--kb-selection);color:var(--kb-ink);font-size:14px;line-height:1.75}",
        ".kb-ask .kb-msg-body,.kb-book-messages .kb-msg-body{padding:20px 24px;border:1px solid var(--kb-separator);border-radius:14px;background:var(--kb-panel);color:var(--kb-ink)}",
        ".kb-ask .kb-msg-thinking,.kb-book-messages .kb-msg-thinking{color:var(--kb-ink-secondary);font-size:13px;line-height:1.65}",
        ".kb-ask .kb-refs,.kb-book-messages .kb-refs{gap:6px;margin-top:12px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.6}",
        ".kb-ask .kb-ref-chip,.kb-book-messages .kb-ref-chip{height:auto;min-height:30px;max-width:100%;padding:5px 9px;gap:5px;border:1px solid var(--kb-separator);border-radius:7px;background:var(--kb-panel);color:var(--kb-accent);font-size:12px;line-height:1.4;text-align:left}",
        ".kb-ask .kb-ref-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis}",
        ".kb-ask .kb-ref-chip:hover:not(:disabled),.kb-book-messages .kb-ref-chip:hover:not(:disabled){border-color:var(--kb-accent);background:var(--kb-selection)}",
        ".kb-ask .kb-refs-empty,.kb-book-messages .kb-refs-empty{color:var(--kb-ink-secondary)}",
        ".kb-ask .kb-msg-error,.kb-book-messages .kb-msg-error{gap:10px;margin-top:12px;padding:12px 14px;border-radius:8px;font-size:13px;line-height:1.65}",
        ".kb-ask .kb-msg-error-text,.kb-book-messages .kb-msg-error-text{font-size:13px;line-height:1.65}",
        ".kb-ask .kb-msg-status,.kb-book-messages .kb-msg-status{color:var(--kb-ink-secondary);font-size:12px;line-height:1.65}",
        ".kb-ask>.kb-composer{max-width:1040px;padding:10px 32px 24px;background:var(--kb-canvas)}",
        ".kb-ask .kb-ask-hint{margin-bottom:9px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.6}",
        "",
        "@container kb-panel (max-width:1000px){",
        " .kb-books-head,.kb-book-detail-head{padding-inline:24px}",
        " .kb-books-scroll{padding-inline:24px}",
        " .kb-book-workspace{grid-template-columns:minmax(200px,240px) minmax(0,1fr)}",
        " .kb-book-reader{padding:28px}",
        " .kb-sources{padding-inline:24px}",
        " .kb-sources-toolbar>.kb-header-spacer{display:none}",
        " .kb-sources .kb-filter-input{flex:1 1 180px;width:180px}",
        " .kb-ask>.kb-ask-head,.kb-ask-scroll,.kb-ask>.kb-composer{padding-inline:24px}",
        "}",
        "@container kb-panel (max-width:760px){",
        " .kb-books-head{padding:22px 16px 16px;gap:12px}",
        " .kb-books-head .kb-overview-title{font-size:24px}",
        " .kb-book-detail-head{padding:10px 16px 4px;gap:6px 12px}",
        " .kb-books-head>div:first-child{flex:1 0 100%}",
        " .kb-books-scroll{padding:0 16px 24px}",
        " .kb-books-intro{font-size:12px;margin-bottom:16px}",
        " .kb-books-scroll>.kb-empty{min-height:300px;padding:32px 20px}",
        " .kb-book-card{padding:18px}",
        " .kb-book-card-open{min-height:80px}",
        " .kb-books-actions .kb-btn,.kb-book-card-footer .kb-btn,.kb-book-card-footer .kb-linkbtn,.kb-book-detail-head>.kb-btn{min-height:44px}",
        " .kb-book-detail-head>.kb-btn{padding:8px 0;margin:0}",
        " .kb-book-titles{flex-basis:9rem}",
        " .kb-book-summary{margin:0 16px 8px}",
        " .kb-book-diagnostics>summary,.kb-book-warnings>summary{min-height:44px}",
        " .kb-book-modes{align-self:stretch;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 16px 12px;padding:3px}",
        " .kb-book-modes .kb-graph-chip,.kb-book-modes .kb-graph-chip[data-active=\"false\"]{min-width:0;min-height:44px;padding:6px;white-space:normal;overflow-wrap:anywhere}",
        " .kb-book-workspace{display:flex;flex-direction:column;margin:0 16px 16px;overflow:auto}",
        " .kb-book-nav{flex:none;min-height:160px;max-height:32vh;padding:10px;border-right:0;border-bottom:1px solid var(--kb-separator)}",
        " .kb-book-nav-row{min-height:58px;padding:10px}",
        " .kb-book-reader{flex:none;min-height:250px;padding:24px 20px;overflow:visible}",
        " .kb-book-reader .kb-page-title{font-size:24px;margin-bottom:22px}",
        " .kb-book-reading-sources .kb-linkbtn{min-height:44px}",
        " .kb-book-ask{margin:0 16px 16px}",
        " .kb-book-ask-head>.kb-btn{min-height:44px}",
        " .kb-sources{gap:16px;padding:22px 16px 28px}",
        " .kb-sources-head{gap:8px}",
        " .kb-sources-head .kb-ask-titles{flex:1 0 100%;margin-bottom:4px}",
        " .kb-sources-head .kb-overview-title{font-size:24px}",
        " .kb-sources-head>.kb-btn{min-height:44px}",
        " .kb-sources-head>.kb-btn:last-child{margin-left:auto}",
        " .kb-sources-toolbar{gap:12px}",
        " .kb-sources .kb-filter-chips{display:flex;width:100%;flex-wrap:wrap;gap:2px}",
        " .kb-sources .kb-filter-chip{flex:1 1 auto;justify-content:center;min-height:44px;padding:8px 9px}",
        " .kb-sources .kb-filter-input{flex:1 0 100%;width:100%;margin:0;min-height:44px;font-size:16px}",
        " .kb-sources .kb-source-item{align-items:flex-start;gap:8px 12px;padding:15px 16px;flex-wrap:wrap}",
        " .kb-sources .kb-source-item+.kb-source-item::before{left:16px;right:16px}",
        " .kb-sources .kb-source-item-main{flex:1 0 100%;gap:10px}",
        " .kb-sources .kb-source-item .kb-source-title{font-size:14px;-webkit-line-clamp:3}",
        " .kb-sources .kb-source-item .kb-source-meta{flex-wrap:wrap;white-space:normal;font-size:12px;line-height:1.6}",
        " .kb-sources .kb-source-item-actions{width:100%;max-width:none;justify-content:flex-end;gap:8px;padding-left:17px}",
        " .kb-sources .kb-source-item-actions .kb-btn{min-width:44px;min-height:44px;padding:10px;font-size:13px}",
        " .kb-sources .kb-source-item-actions .kb-btn>span{display:inline}",
        " .kb-sources .kb-source-item-manage{flex-wrap:nowrap;align-items:center;min-height:88px}",
        " .kb-sources .kb-manage-selectall{min-height:44px}",
        " .kb-sources .kb-manage-bar-page .kb-btn{min-height:44px}",
        " .kb-sources>.kb-empty{min-height:300px;padding:32px 20px}",
        " .kb-ask>.kb-ask-head{padding:22px 16px 16px;gap:10px}",
        " .kb-ask>.kb-ask-head .kb-overview-title{font-size:24px}",
        " .kb-ask>.kb-ask-head .kb-ask-titles{flex:1 1 150px}",
        " .kb-ask>.kb-ask-head>.kb-header-spacer{display:none}",
        " .kb-ask>.kb-ask-head>.kb-btn{min-height:44px;margin-left:auto}",
        " .kb-ask-scroll{gap:24px;padding:4px 16px 20px}",
        " .kb-ask .kb-msg-user-bubble,.kb-book-messages .kb-msg-user-bubble{max-width:94%;padding:11px 14px}",
        " .kb-ask .kb-msg-body,.kb-book-messages .kb-msg-body{padding:16px;border-radius:12px}",
        " .kb-ask .kb-ref-chip,.kb-book-messages .kb-ref-chip{min-height:44px;white-space:normal;padding:9px 10px}",
        " .kb-ask .kb-ref-chip>span{overflow:visible;overflow-wrap:anywhere}",
        " .kb-ask>.kb-composer{padding:10px 16px 16px}",
        " .kb-composer-input{min-height:44px;font-size:1rem}",
        " .kb-composer-actions .kb-send{min-height:44px}",
        "}",
        "@media (forced-colors:active){",
        " .kb-book-nav-row[aria-current=\"page\"],.kb-book-modes .kb-graph-chip[data-active=\"true\"],.kb-sources .kb-filter-chip[data-active=\"true\"]{outline:2px solid Highlight;outline-offset:-2px}",
        " .kb-book-progress progress{forced-color-adjust:auto}",
        " .kb-composer-actions .kb-send{border:1px solid ButtonText}",
        "}",
        '/* ==== 动效降级（§5.10）==== */',
        '@media (prefers-reduced-motion:reduce){',
        '.kb-root,.kb-root *{animation:none!important;transition-property:opacity!important;transition-duration:var(--kb-fast)!important;scroll-behavior:auto!important}',
        '.kb-btn:active:not(:disabled),.kb-send:active:not(:disabled){transform:none!important}',
        '.kb-notice,.kb-modal-overlay{transition:opacity var(--kb-normal) var(--kb-ease)!important}',
        '.kb-spinner{animation:none!important}',
        '.kb-progress[data-indeterminate="true"] .kb-progress-bar{animation:none!important;transform:none!important}',
        '.kb-cursor{animation:none!important}',
        '}',
        '/* ==== 高对比度（§6.2 可选增强）==== */',
        '@media (prefers-contrast:more){',
        '.kb-root{--kb-hairline:var(--dsw-alias-border-l3)}',
        '.kb-btn,.kb-input,.kb-textarea,.kb-select{border-color:var(--dsw-alias-border-l3)}',
        '}',
        "/* Topic map: project-chosen web spacing and readable screen-space labels. */",
        ".kb-graph-back{flex:none}" ,
        ".kb-graph-mapnav{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 24px 14px;min-height:34px;font-size:13px;color:var(--kb-ink-secondary)}",
        ".kb-graph-mapnav .kb-linkbtn{min-height:32px;white-space:normal;text-align:left}",
        ".kb-graph-mapnav .kb-graph-all{margin-left:auto}",
        ".kb-graph-mapnav .kb-graph-current{min-width:0;overflow-wrap:anywhere;color:var(--kb-ink);font-weight:550}",
        ".kb-graph-overview{flex:1;min-height:0;overflow:auto;padding:10px 24px 32px;background:var(--kb-canvas);scrollbar-width:thin}",
        ".kb-graph-overview-intro{margin:0 0 24px;max-width:620px}",
        ".kb-graph-overview-intro h3{margin:0 0 8px;font-size:24px;line-height:1.4;font-weight:650;letter-spacing:-.02em;color:var(--kb-ink)}",
        ".kb-graph-overview-intro p,.kb-graph-overview-footnote{margin:0;font-size:13px;line-height:1.8;color:var(--kb-ink-secondary)}",
        ".kb-graph-group-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:14px}",
        ".kb-graph-group-card{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;min-height:162px;padding:20px;border:1px solid var(--kb-separator);border-radius:12px;background:var(--kb-panel);color:var(--kb-ink);text-align:left;font:inherit;cursor:pointer;transition:border-color var(--kb-fast),background-color var(--kb-fast)}",
        ".kb-graph-group-card:hover{border-color:var(--kb-accent);background:var(--kb-selection)}",
        ".kb-graph-group-card:focus-visible,.kb-graph-result:focus-visible{outline:2px solid var(--kb-accent);outline-offset:3px}",
        ".kb-graph-group-top{display:flex;align-items:center;gap:10px;color:var(--kb-accent);margin-bottom:4px}",
        ".kb-graph-group-index{font-size:11px;font-variant-numeric:tabular-nums;color:var(--kb-ink-secondary)}",
        ".kb-graph-group-arrow{margin-left:auto;font-size:18px;color:var(--kb-ink-secondary)}",
        ".kb-graph-group-title{font-size:17px;line-height:1.45;font-weight:600;overflow-wrap:anywhere}",
        ".kb-graph-group-meta{font-size:12px;line-height:1.5;color:var(--kb-ink-secondary)}",
        ".kb-graph-group-examples{font-size:12px;line-height:1.75;color:var(--kb-ink-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px}",
        ".kb-graph-overview-footnote{margin-top:20px;font-size:12px}",
        ".kb-graph-search-results{margin:0 0 24px;padding:0 0 20px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-graph-search-results h4{margin:0 0 12px;font-size:14px;font-weight:600;color:var(--kb-ink)}",
        ".kb-graph-search-results p{font-size:13px;line-height:1.7;color:var(--kb-ink-secondary)}",
        ".kb-graph-result{display:flex;align-items:center;gap:10px;min-height:40px;width:100%;padding:8px 4px;border:0;border-radius:6px;background:transparent;color:var(--kb-ink);font:inherit;font-size:14px;text-align:left;cursor:pointer}",
        ".kb-graph-result>span:last-child{min-width:0;overflow-wrap:anywhere}",
        ".kb-graph-result:hover{background:var(--kb-selection)}",
        ".kb-graph-map-status{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0 24px 12px;font-size:12px;line-height:1.6;color:var(--kb-ink-secondary)}",
        ".kb-graph-shown{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}",
        ".kb-graph-filterbar{display:flex;align-items:center;flex-wrap:wrap;gap:3px;margin:0 24px 12px}",
        ".kb-graph-filterbar .kb-graph-chip{min-height:30px;font-size:11px}",
        ".kb-graph-workspace{display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;margin:0 24px 20px;gap:16px}",
        ".kb-graph-workspace[data-detail=true]{grid-template-columns:minmax(0,1fr) 300px}",
        ".kb-graph-workspace>.kb-graph-stage{margin:0;min-width:0;min-height:0;background:var(--kb-panel);border:1px solid var(--kb-separator);border-radius:12px}",
        ".kb-graph-workspace>.kb-graph-detail{position:static;inset:auto;z-index:auto;width:auto;min-width:0;max-height:none;overflow:auto;margin:0;padding:20px;border:1px solid var(--kb-separator);border-radius:12px;box-shadow:none;background:var(--kb-panel);backdrop-filter:none;-webkit-backdrop-filter:none}",
        ".kb-graph-workspace .kb-graph-detail-title{font-size:19px;line-height:1.5}",
        ".kb-graph-workspace .kb-graph-copy{font-size:13px;line-height:1.8}",
        ".kb-graph-workspace .kb-graph-nb-title-text{white-space:normal;overflow-wrap:anywhere;font-size:13px}",
        ".kb-graph-workspace .kb-graph-neighbors{flex-shrink:0}",
        ".kb-graph-stage .kb-graph-halo{fill:none;pointer-events:all}",
        ".kb-graph-stage .kb-graph-circle{stroke:var(--kb-panel);stroke-width:1.5}",
        ".kb-graph-stage .kb-graph-node[data-selected=true] .kb-graph-halo{fill:var(--kb-selection)}",
        ".kb-graph-stage .kb-graph-node[data-selected=true] .kb-graph-circle{stroke:var(--kb-accent);stroke-width:2}",
        ".kb-graph-label-layer{pointer-events:none}",
        ".kb-graph-label-layer .kb-graph-label{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:500;text-anchor:start;fill:var(--kb-ink-secondary);stroke:var(--kb-panel);stroke-width:4;paint-order:stroke;stroke-linejoin:round;letter-spacing:0}",
        ".kb-graph-label-layer .kb-graph-screen-label[data-selected=true] .kb-graph-label{fill:var(--kb-accent);font-weight:600}",
        ".kb-graph-label-leader{stroke:var(--kb-ink-secondary);stroke-width:.7;stroke-opacity:.4}",
        ".kb-graph-stage .kb-graph-hintbar{left:12px;right:12px;bottom:10px;max-width:none;font-size:11px;line-height:1.6;text-align:left}",
        ".kb-graph-stage .kb-graph-toolbar{top:12px;right:12px;bottom:auto;left:auto}",
        ".kb-graph-stage .kb-graph-edge{stroke-opacity:.22;stroke-width:1}",
        ".kb-graph-stage .kb-graph-edge[data-active=true]{stroke:var(--kb-accent);stroke-opacity:.42}",
        ".kb-graph-stage .kb-graph-edge[data-relation=CEO]{stroke:var(--kb-accent);stroke-width:1.6;stroke-opacity:.9;vector-effect:non-scaling-stroke}",
        ".kb-graph-ceo-edge[data-dim=true]{opacity:.2}",
        ".kb-graph-ceo-arrow{fill:var(--kb-accent)}",
        ".kb-graph-ceo-label{font-size:12px;font-weight:650;fill:var(--kb-ink);stroke:var(--kb-panel);stroke-width:5;paint-order:stroke;stroke-linejoin:round;text-anchor:middle;dominant-baseline:central}",
        ".kb-graph-rel-line[data-relation=CEO]{border-top:2px solid var(--kb-accent)}",
        ".kb-graph-ceo-sources{list-style:none;margin:2px 0 0;padding:0 0 0 16px}",
        ".kb-graph-ceo-source{min-height:28px;max-width:100%;white-space:normal;text-align:left;overflow-wrap:anywhere}",
        "@media(pointer:coarse){.kb-graph-ceo-source{min-height:44px}}",
        "@media(forced-colors:active){.kb-graph-stage .kb-graph-edge[data-relation=CEO]{stroke:CanvasText}.kb-graph-ceo-arrow,.kb-graph-ceo-label{fill:CanvasText}.kb-graph-ceo-label{stroke:Canvas}}",
        "@media(max-width:900px){.kb-graph-workspace[data-detail=true]{grid-template-columns:minmax(0,1fr) 264px}.kb-graph-workspace>.kb-graph-detail{padding:16px}}",
        "@media(max-width:700px){.kb-graph-mapnav,.kb-graph-map-status,.kb-graph-filterbar{margin-left:16px;margin-right:16px}.kb-graph-overview{padding-left:16px;padding-right:16px}.kb-graph-group-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}.kb-graph-workspace,.kb-graph-workspace[data-detail=true]{display:flex;flex-direction:column;overflow:auto;margin:0 16px 16px}.kb-graph-workspace>.kb-graph-stage{flex:none;min-height:380px;height:50vh}.kb-graph-workspace>.kb-graph-detail{flex:none;overflow:visible}.kb-graph-mapnav button,.kb-graph-expand,.kb-graph-filterbar .kb-graph-chip,.kb-graph-result{min-height:44px}.kb-graph-map-status>.kb-graph-shown{margin-left:0}.kb-graph-mapnav .kb-graph-all{margin-left:auto}}",
        "@media(forced-colors:active){.kb-graph-halo{fill:none!important}.kb-graph-label-layer .kb-graph-label{fill:CanvasText;stroke:Canvas}.kb-graph-group-card{border:1px solid ButtonText}}",
        ".kb-conversation-reader{padding:20px 32px 64px;width:100%;margin:0;border:0;border-radius:0;box-shadow:none;max-width:none;color:var(--kb-ink);background:var(--kb-panel)}",
        ".kb-conversation-reader .kb-reader-inner{max-width:900px}",
        ".kb-conversation-toolbar{display:flex;align-items:center;gap:8px;margin:0 0 30px}",
        ".kb-conversation-toolbar .kb-btn{min-height:34px;font-size:13px}",
        ".kb-conversation-heading{margin:0 0 36px;padding:0 0 26px;border-bottom:1px solid var(--kb-separator)}",
        ".kb-conversation-eyebrow{margin:0 0 10px;font-size:12px;font-weight:550;letter-spacing:.08em;color:var(--kb-ink-secondary)}",
        ".kb-conversation-heading h1{margin:0;font-size:28px;line-height:1.4;letter-spacing:-.025em;font-weight:650;overflow-wrap:anywhere}",
        ".kb-conversation-subtitle{margin:12px 0 16px;color:var(--kb-ink-secondary);font-size:12px;line-height:1.7}",
        ".kb-conversation-models{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--kb-ink-secondary);font-size:12px}",
        ".kb-conversation-model{display:inline-flex;align-items:center;max-width:100%;padding:3px 8px;border:1px solid var(--kb-separator);border-radius:6px;color:var(--kb-ink);background:var(--kb-soft);font-size:12px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}",
        ".kb-conversation-unknown{font-weight:400;color:var(--kb-ink-secondary)}",
        ".kb-conversation-timeline{display:flex;flex-direction:column;gap:30px}",
        ".kb-conversation-message{min-width:0;width:100%}",
        ".kb-conversation-byline{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:13px;flex-wrap:wrap}",
        ".kb-conversation-byline strong{font-weight:550}",
        ".kb-conversation-message[data-role=user]{align-self:flex-end;width:fit-content;max-width:78%}",
        ".kb-conversation-message[data-role=user] .kb-conversation-byline{justify-content:flex-end;color:var(--kb-ink-secondary)}",
        ".kb-conversation-message[data-role=user] .kb-conversation-text{padding:12px 16px;background:var(--kb-conversation-bubble);color:var(--kb-ink);border-radius:18px}",
        ".kb-conversation-prompt{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,16px);line-height:1.65}",
        ".kb-conversation-text{min-width:0;overflow-wrap:anywhere;user-select:text}",
        ".kb-conversation-text .kb-md{font-size:var(--dsh-content-font-size,16px);line-height:1.65}",
        ".kb-conversation-reader .kb-md-p{margin:0 0 14px;line-height:1.65}",
        ".kb-conversation-reader .kb-md-h{margin:24px 0 10px;line-height:1.5}",
        ".kb-conversation-reader .kb-md-h1{font-size:22px}",
        ".kb-conversation-reader .kb-md-h2{font-size:19px}",
        ".kb-conversation-reader .kb-md-h3{font-size:17px}",
        ".kb-conversation-reader .kb-md-pre{margin:14px 0;font-size:var(--dsh-code-font-size,13px);white-space:pre-wrap;overflow-wrap:anywhere}",
        ".kb-conversation-fragment+.kb-conversation-fragment{margin-top:14px}",
        ".kb-conversation-fragment .kb-md>:last-child{margin-bottom:0}",
        ".kb-conversation-model-change{display:inline-block;margin:2px 0 10px;color:var(--kb-ink-secondary);font-size:12px}",
        ".kb-conversation-time{display:block;margin-top:10px;color:var(--kb-ink-secondary);font-size:12px}",
        ".kb-conversation-message[data-role=user] .kb-conversation-time{text-align:right}",
        ".kb-conversation-details{margin-top:48px;padding-top:18px;border-top:1px solid var(--kb-separator);font-size:12px;line-height:1.7;color:var(--kb-ink-secondary)}",
        ".kb-conversation-details summary{width:fit-content;min-height:32px;padding:4px 0;cursor:pointer;color:var(--kb-ink)}",
        ".kb-conversation-details dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 20px;margin:16px 0}",
        ".kb-conversation-details dt,.kb-conversation-details dd{margin:0;overflow-wrap:anywhere}",
        ".kb-conversation-details p{margin:16px 0}",
        ".kb-conversation-reader button:focus-visible,.kb-conversation-reader summary:focus-visible{outline:2px solid var(--kb-accent);outline-offset:3px}",
        ".kb-conversation-collection .kb-source-item{padding:14px 16px}",
        ".kb-conversation-collection .kb-source-title{font-size:16px;font-weight:550;line-height:1.5}",
        ".kb-conversation-collection .kb-source-meta{margin-top:8px;line-height:1.7;flex-wrap:wrap;white-space:normal}",
        ".kb-conversation-collection .kb-status-dot{display:none}",
        "@media(max-width:700px){.kb-conversation-reader{padding:14px 18px 40px}.kb-conversation-toolbar{margin-bottom:24px;gap:4px}.kb-conversation-toolbar .kb-btn{min-height:44px;padding-inline:10px}.kb-conversation-heading h1{font-size:24px}.kb-conversation-heading{margin-bottom:26px}.kb-conversation-message[data-role=user]{max-width:92%}.kb-conversation-timeline{gap:26px}.kb-conversation-details summary{min-height:44px}.kb-conversation-collection .kb-source-item{padding:12px}.kb-conversation-collection .kb-source-meta{font-size:12px}}",
        "@media(forced-colors:active){.kb-conversation-message[data-role=user] .kb-conversation-text,.kb-conversation-model{border:1px solid CanvasText}}",
        ".kb-dshui{display:flex;flex-direction:column;max-width:100%;min-width:0;margin:22px 0 28px;color:var(--kb-ink)}",
        ".kb-dshui-title{margin:0 0 2px;font-size:1.05em;line-height:1.55;font-weight:600;overflow-wrap:anywhere}",
        ".kb-dshui-table-wrap{max-width:100%;min-width:0;overflow-x:auto;border:1px solid var(--kb-separator);border-radius:10px;overscroll-behavior-x:contain}",
        ".kb-dshui-table-wrap:focus-visible{outline:2px solid var(--kb-accent);outline-offset:3px}",
        ".kb-dshui-table{width:100%;border-collapse:collapse;background:var(--kb-panel);color:var(--kb-ink);font-size:.9em;line-height:1.7;text-align:left}",
        ".kb-dshui-table th,.kb-dshui-table td{padding:11px 14px;vertical-align:top;border-bottom:1px solid var(--kb-separator);border-right:1px solid var(--kb-separator);overflow-wrap:anywhere;min-width:5em}",
        ".kb-dshui-table th{background:var(--kb-soft);font-weight:600}.kb-dshui-table th:last-child,.kb-dshui-table td:last-child{border-right:0}.kb-dshui-table tbody tr:last-child td{border-bottom:0}",
        ".kb-dshui-callout{--kb-callout-tone:var(--kb-accent);padding:12px 16px;border:1px solid var(--kb-separator);border-left:3px solid var(--kb-callout-tone);border-radius:8px;background:color-mix(in srgb,var(--kb-callout-tone) 5%,var(--kb-panel));color:var(--kb-ink);overflow-wrap:anywhere}",
        ".kb-dshui-callout[data-tone=warning]{--kb-callout-tone:var(--kb-warning-ink)}.kb-dshui-callout[data-tone=success]{--kb-callout-tone:var(--kb-success-ink)}.kb-dshui-callout[data-tone=error]{--kb-callout-tone:var(--kb-error-ink)}",
        ".kb-dshui-callout-label{margin-bottom:5px;font-size:.8em;font-weight:600;color:var(--kb-callout-tone)}.kb-dshui-callout-content{line-height:1.75}",
        "@media(max-width:700px){.kb-dshui-table th,.kb-dshui-table td{padding:10px 12px}.kb-dshui-callout{padding:12px}.kb-dshui{margin:18px 0 24px}}",
        "@media(forced-colors:active){.kb-dshui-callout{border:1px solid CanvasText;border-left-width:3px}.kb-dshui-callout-label{color:CanvasText}}",
        "/* 2026-11-07: quiet segmented filters + compact search field (Apple HIG: one selection cue, no nested borders). */",
        ".kb-sources .kb-filter-chips{gap:2px;padding:2px;border:0;border-radius:9px;background:var(--kb-soft)}",
        ".kb-sources .kb-filter-chip{height:28px;min-height:28px;padding:4px 11px;gap:6px;border:0;border-radius:7px;background:transparent;color:var(--kb-ink-secondary);font-size:12.5px;font-weight:500;line-height:1.2;box-shadow:none}",
        ".kb-sources .kb-filter-chip:hover:not([data-active=\"true\"]){background:color-mix(in srgb,var(--kb-panel) 55%,transparent);color:var(--kb-ink)}",
        ".kb-sources .kb-filter-chip[data-active=\"true\"]{border:0;background:var(--kb-panel);color:var(--kb-ink);font-weight:600;box-shadow:0 1px 2px color-mix(in srgb,var(--kb-separator) 40%,transparent),0 0 0 .5px color-mix(in srgb,var(--kb-separator) 60%,transparent)}",
        ".kb-sources .kb-filter-count{font-size:11px;font-weight:500;color:var(--kb-ink-secondary);font-variant-numeric:tabular-nums}",
        ".kb-sources .kb-filter-chip[data-active=\"true\"] .kb-filter-count{color:var(--kb-ink-secondary)}",
        ".kb-sources .kb-sources-count{align-self:center;color:var(--kb-ink-secondary);font-size:13px;line-height:1.6;white-space:nowrap;font-variant-numeric:tabular-nums}",
        ".kb-sources .kb-search-field{position:relative;display:flex;align-items:center;flex:0 0 240px;width:240px;margin-left:auto}",
        ".kb-sources .kb-search-field-icon{position:absolute;left:10px;display:inline-flex;color:var(--kb-ink-secondary);pointer-events:none}",
        ".kb-sources .kb-search-field .kb-filter-input{flex:1 1 auto;width:100%;min-height:34px;margin:0;padding-left:30px;border-color:var(--kb-separator);border-radius:9px;background:var(--kb-panel);font-size:13px}",
        ".kb-sources .kb-search-field .kb-filter-input::placeholder{color:var(--kb-ink-secondary)}",
        ".kb-sources .kb-search-field .kb-filter-input:focus{border-color:var(--kb-accent)}",
        "@container kb-panel (max-width:1000px){.kb-sources .kb-search-field{flex-basis:200px;width:200px}",
        " .kb-sources .kb-search-field .kb-filter-input{min-height:36px}}",
        "@container kb-panel (max-width:760px){.kb-sources .kb-filter-chips{display:flex;width:100%;flex-wrap:wrap}",
        " .kb-sources .kb-filter-chip{flex:1 1 auto;justify-content:center;min-height:40px;padding:8px 9px}",
        " .kb-sources .kb-sources-count{width:100%}",
        " .kb-sources .kb-search-field{flex:1 1 100%;width:100%;margin:0}",
        " .kb-sources .kb-search-field .kb-filter-input{min-height:44px;font-size:16px}}",
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
        ctx.effect(() => {
          const open = () => {
            cache.tab = 'conversations'
            cache.page = IDLE_PAGE
            cache.pageOrigin = ''
          }
          window.addEventListener('dsh-kb:conversations', open)
          return () => window.removeEventListener('dsh-kb:conversations', open)
        }, 'kb: conversation category')
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        }, 'kb: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: function () { return { t: t } } },
            KbPanel,
          )
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 21, locale: NS, label: function () { return t('panel.label') } },
            KbIcon,
          )
        })
      }

      return { name: PANEL_ID, inject: ['slots', 'locale'], apply: apply }
    },
  })
} else {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[dsh-kb] __ModuleLoader__ 不可用，client.js 未加载')
  }
}
