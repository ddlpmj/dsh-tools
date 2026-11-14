/**
 * dsh-deep-search — 浏览器半侧（client.js）
 * ============================================================================
 * 职责
 *   DSH Web GUI 内的「AI 大搜索」主面板（main key = deep-search）与左侧栏入口
 *   （sidebar.panellist id = deep-search，order = 23）。面板分三态：
 *     空状态：大标题 + 主题输入 + 深度切换 + 示例 chip + 方法论；
 *     运行态：九阶段步骤条（理解输入/基础检索与认识/讨论检索与地图/覆盖检查/
 *             问题规划/定向深搜/证据核查/形成判断/校验）、进度、当前动作、
 *             最近 30 条日志、取消；每 1000ms 轮询 /jobs/:id；
 *     阅读态：顶部元信息与操作 + 锚点导航 + 这是什么/大家在讨论什么/
 *             值得深入理解什么/目前能确定什么/接下来值得查什么/资料来源。
 *   签名交互：
 *     - 点击论断 / 判断 / source chip / 问题 → 右侧「证据链」抽屉；
 *     - 点击正文 [n] 注释 chip → 注释抽屉（来源、定位、摘录、读取范围、被引用位置），
 *       注释抽屉里可继续打开该条证据的证据链；
 *     - 点击来源 → 来源抽屉（元信息、作者、摘要、原文摘录、注释位置）；
 *     - 继续追问（弹层，推荐问题来自 branches）、导出（完整/简报/JSON）、
 *       刷新、删除、设置；左栏档案搜索与今天/本周/更早分组。
 *
 * 注册方式（普通副作用脚本，不能有顶层 import/export）
 *   window.__ModuleLoader__.load({ id:'dsh-deep-search', factory(require) {...} })
 *   factory 内只 require('react')，不依赖任何 Harness 客户端包；返回
 *   { name:'deep-search', inject:['slots','locale'], apply }。
 *
 * 健壮性约定
 *   - 所有网络请求统一走 api()：try/catch、非 2xx 归一为 { ok:false, error }、
 *     支持 AbortSignal；写请求统一 JSON。
 *   - 主面板整体包 DsErrorBoundary；任何组件异常都不会炸掉 slot。
 *   - 切换档案 / 卸载时 abort 进行中的请求与定时器；空闲不轮询。
 *   - 不使用 localStorage / sessionStorage；列表滚动、选中档案、当前视图等放模块级 cache。
 *   - 不注入 HTML 字符串：Markdown 渲染器返回 React 元素，外链带 noreferrer。
 *   - 样式只使用 --dsw-alias-* 主题变量与 --ds-* 派生令牌，颜色一律用 color-mix 推导，
 *     浅色 / 深色自动适配；类名前缀 ds-。
 *   - 文案全部走 t()；zh / en 两套字典内嵌（locale/*.json 只放包元信息）。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-deep-search',

    /**
     * DSH 客户端插件 factory：注入 react 平台种子模块，组装面板，返回插件三件套。
     * @param {(id: string) => any} require 平台种子模块加载器（此处只用 'react'）。
     * @returns {{ name: string, inject: string[], apply: (ctx: any) => void }}
     */
    factory(require) {
      // ---- 平台种子模块（只允许 react） --------------------------------------
      const React = require('react')
      const { useState, useEffect, useRef, useMemo, useCallback, useContext } = React
      const h = React.createElement

      // ---- 恒定标识（与 CONTRACT.md §1 / §8 一致） ---------------------------
      /** 浏览器模块 id / 包名。 */
      const MODULE_ID = 'dsh-deep-search'
      /** 主面板 key 与侧边栏 id（两者必须一致）。 */
      const PANEL_ID = 'deep-search'
      /** client locale 命名空间。 */
      const NS = 'deepSearch'
      /** Host HTTP 路由前缀。 */
      const ORIGIN = '/dsh-deep-search'
      /** 运行态轮询间隔（CONTRACT §8.3）。 */
      const JOB_POLL_MS = 1000
      /** 日志最多展示 30 条（CONTRACT §8.3）。 */
      const LOG_LIMIT = 30
      /** 左栏档案搜索防抖。 */
      const SEARCH_DEBOUNCE_MS = 180
      /** Toast 自动消失时间。 */
      const NOTICE_MS = 2600
      /** 追问完成后的高亮时长。 */
      const HIGHLIGHT_MS = 6000
      /** 阅读正文最大宽度（CONTRACT §8.5）。 */
      const ARTICLE_MAX = 760

      /** 九阶段（id 与 CONTRACT §4 一致）。 */
      const STAGES = [
        { id: 'framing', key: 'stage.framing' },
        { id: 'basics', key: 'stage.basics' },
        { id: 'discussion', key: 'stage.discussion' },
        { id: 'coverage', key: 'stage.coverage' },
        { id: 'planning', key: 'stage.planning' },
        { id: 'researching', key: 'stage.researching' },
        { id: 'verifying', key: 'stage.verifying' },
        { id: 'synthesizing', key: 'stage.synthesizing' },
        { id: 'linking', key: 'stage.linking' },
      ]
      /** 阶段顺序索引（宿主给出 done 时用于判断已完成阶段）。 */
      const STAGE_INDEX = STAGES.reduce(function (map, stage, index) {
        map[stage.id] = index
        return map
      }, {})
      /** 任务终态（终态即停止轮询）。 */
      const TERMINAL_JOB_STATUS = ['done', 'partial', 'failed', 'canceled']
      /** 任务状态 → 文案 key。 */
      const JOB_STATUS_KEYS = {
        queued: 'jobStatus.queued',
        running: 'jobStatus.running',
        done: 'jobStatus.done',
        partial: 'jobStatus.partial',
        failed: 'jobStatus.failed',
        canceled: 'jobStatus.canceled',
      }
      /** 档案状态 → 文案 key。 */
      const ARCHIVE_STATUS_KEYS = {
        draft: 'archiveStatus.draft',
        running: 'archiveStatus.running',
        done: 'archiveStatus.done',
        partial: 'archiveStatus.partial',
        failed: 'archiveStatus.failed',
      }
      /** 问题状态 → 文案 key。 */
      const QUESTION_STATUS_KEYS = {
        pending: 'questionStatus.pending',
        researching: 'questionStatus.researching',
        done: 'questionStatus.done',
        partial: 'questionStatus.partial',
        failed: 'questionStatus.failed',
      }
      /** 身份 → 文案 key（事实 / 声称 / 分析 / 未知）。 */
      const IDENTITY_KEYS = {
        fact: 'identity.fact',
        claim: 'identity.claim',
        analysis: 'identity.analysis',
        unknown: 'identity.unknown',
      }
      /** 置信度 → 文案 key。 */
      const CONFIDENCE_KEYS = {
        high: 'confidence.high',
        medium: 'confidence.medium',
        low: 'confidence.low',
      }
      /** 证据立场 → 文案 key。 */
      const STANCE_KEYS = {
        support: 'stance.support',
        oppose: 'stance.oppose',
        context: 'stance.context',
      }
      /** 证据强度 → 文案 key。 */
      const STRENGTH_KEYS = {
        primary: 'strength.primary',
        secondary: 'strength.secondary',
        'single-source': 'strength.singleSource',
        contested: 'strength.contested',
      }
      /** 来源独立性 → 文案 key。 */
      const INDEPENDENCE_KEYS = {
        primary: 'independence.primary',
        independent: 'independence.independent',
        syndicated: 'independence.syndicated',
        unknown: 'independence.unknown',
      }
      /** 可靠度 → 文案 key。 */
      const RELIABILITY_KEYS = {
        high: 'reliability.high',
        medium: 'reliability.medium',
        low: 'reliability.low',
      }
      /** 来源类型 → 文案 key。 */
      const SOURCE_KIND_KEYS = {
        primary: 'sourceKind.primary',
        report: 'sourceKind.report',
        data: 'sourceKind.data',
        analysis: 'sourceKind.analysis',
        interview: 'sourceKind.interview',
        social: 'sourceKind.social',
        other: 'sourceKind.other',
      }
      /** 主题类型 → 文案 key。 */
      const TOPIC_KIND_KEYS = {
        technology: 'topicKind.technology',
        company: 'topicKind.company',
        phenomenon: 'topicKind.phenomenon',
        event: 'topicKind.event',
        person: 'topicKind.person',
        concept: 'topicKind.concept',
        policy: 'topicKind.policy',
      }
      /** 问题角色 → 文案 key。 */
      const ROLE_KEYS = {
        definition: 'role.definition',
        mechanism: 'role.mechanism',
        evidence: 'role.evidence',
        'political-economy': 'role.politicalEconomy',
        uncertainty: 'role.uncertainty',
        context: 'role.context',
        custom: 'role.custom',
      }
      /** 问题关系 → 文案 key。 */
      const RELATION_KEYS = {
        opens: 'relation.opens',
        deepens: 'relation.deepens',
        contrasts: 'relation.contrasts',
        depends: 'relation.depends',
        closes: 'relation.closes',
      }
      /** 关联类型 → 文案 key。 */
      const CONNECTION_KIND_KEYS = {
        constraint: 'connectionKind.constraint',
        dependency: 'connectionKind.dependency',
        analogy: 'connectionKind.analogy',
        'same-root': 'connectionKind.sameRoot',
        counterweight: 'connectionKind.counterweight',
      }
      /** 关联状态 → 文案 key。 */
      const CONNECTION_STATUS_KEYS = {
        verified: 'connectionStatus.verified',
        suggested: 'connectionStatus.suggested',
        unverified: 'connectionStatus.unverified',
      }
      /** 锚点章节（阅读态六节固定顺序，不可变）。 */
      const SECTIONS = [
        { id: 'understanding', key: 'section.understanding' },
        { id: 'discussion', key: 'section.discussion' },
        { id: 'questions', key: 'section.questions' },
        { id: 'judgments', key: 'section.judgments' },
        { id: 'branches', key: 'section.branches' },
        { id: 'sources', key: 'section.sources' },
      ]
      /** 理解分块类型 → 文案 key。 */
      const BLOCK_KIND_KEYS = {
        definition: 'blockKind.definition',
        purpose: 'blockKind.purpose',
        'how-it-works': 'blockKind.howItWorks',
        background: 'blockKind.background',
        confusable: 'blockKind.confusable',
        fact: 'blockKind.fact',
      }
      /** 模块覆盖状态 → 文案 key。 */
      const COVERAGE_KEYS = {
        covered: 'coverage.covered',
        partial: 'coverage.partial',
        missing: 'coverage.missing',
      }
      /** 问题覆盖状态 → 文案 key。 */
      const QUESTION_COVERAGE_KEYS = {
        answered: 'questionCoverage.answered',
        partial: 'questionCoverage.partial',
        disputed: 'questionCoverage.disputed',
        'no-evidence': 'questionCoverage.noEvidence',
      }
      /** 论断证据状态 → 文案 key。 */
      const EVIDENCE_STATUS_KEYS = {
        supported: 'evidenceStatus.supported',
        limited: 'evidenceStatus.limited',
        conflicted: 'evidenceStatus.conflicted',
        unsupported: 'evidenceStatus.unsupported',
      }
      /** 优先级 → 文案 key。 */
      const PRIORITY_KEYS = {
        high: 'priority.high',
        medium: 'priority.medium',
        low: 'priority.low',
      }
      /** 读取范围 → 文案 key。 */
      const READ_SCOPE_KEYS = {
        'full-text': 'readScope.fullText',
        section: 'readScope.section',
        abstract: 'readScope.abstract',
        snippet: 'readScope.snippet',
        transcript: 'readScope.transcript',
      }
      /** 讨论发言身份 → 文案 key。 */
      const DISCUSSION_IDENTITY_KEYS = {
        company: 'discussionIdentity.company',
        researcher: 'discussionIdentity.researcher',
        user: 'discussionIdentity.user',
        media: 'discussionIdentity.media',
        official: 'discussionIdentity.official',
        other: 'discussionIdentity.other',
      }
      /** 注释被引用模块 → 文案 key。 */
      const MODULE_KEYS = {
        understanding: 'module.understanding',
        discussion: 'module.discussion',
        question: 'module.question',
        judgment: 'module.judgment',
      }
      /** 空状态示例（label / query / hint）。 */
      const EXAMPLES = [
        { id: 'ai', labelKey: 'example.ai', query: 'AI 搜索' },
        { id: 'company', labelKey: 'example.company', query: '腾讯元宝搜索' },
        { id: 'phenomenon', labelKey: 'example.phenomenon', query: '注意力经济' },
      ]
      /** 知识库插件路由前缀（同源）。 */
      const KB_ORIGIN = '/dsh-kb'
      /** 知识库面板 id（apply 中用于 ctx.layout.selectPanel）。 */
      const KB_PANEL_ID = 'kb'
      /** 知识库编译任务轮询间隔。 */
      const KB_POLL_MS = 900
      /** 知识库编译超时（毫秒）。 */
      const KB_TIMEOUT_MS = 180000
      /** 知识库编译阶段 → 文案 key。 */
      const KB_STAGE_KEYS = {
        queued: 'kb.stageQueued',
        pending: 'kb.stageQueued',
        parsing: 'kb.stageParsing',
        analyzing: 'kb.stageParsing',
        reading: 'kb.stageParsing',
        compiling: 'kb.stageCompiling',
        generating: 'kb.stageCompiling',
        writing: 'kb.stageWriting',
        indexing: 'kb.stageWriting',
        linking: 'kb.stageCompiling',
        done: 'kb.stageDone',
      }

      /** 导出格式。 */
      const EXPORT_FORMATS = [
        { id: 'full', key: 'export.full', ext: 'md', mime: 'text/markdown;charset=utf-8' },
        { id: 'brief', key: 'export.brief', ext: 'md', mime: 'text/markdown;charset=utf-8' },
        { id: 'json', key: 'export.json', ext: 'json', mime: 'application/json;charset=utf-8' },
      ]

      // ---- 模块级 cache（不使用 localStorage / sessionStorage） --------------
      /** @type {any} 跨挂载保留的轻量 UI 状态：选中档案、滚动位置、输入草稿。 */
      const cache = {
        selectedId: '',
        view: 'empty',
        jobId: '',
        listQuery: '',
        newQuery: '',
        depth: 'deep',
        searchProviderMode: '',
        anySearchDraft: { domain: '', tag: '', values: {} },
        directResult: null,
        scrollTop: 0,
        scrollPositions: {},
        lastQuery: '',
        health: null,
        settings: null,
        kbMeasure: {},
      }
      /** @type {any} 当前绑定的翻译函数（apply 时替换，供非组件 helper 使用）。 */
      let runtimeT = null
      /** @type {Function | null} 全局 AbortController 回收函数（卸载时调用）。 */
      let abortAll = null

      // ======================================================================
      // 文案字典（zh / en）。所有可见文字都从这里取，组件里不写死中文。
      // ======================================================================
      const zh = {
        'panel.label': 'AI 大搜索',
        'direct.query': '输入关键词或问题',
        'direct.search': '搜索',
        'direct.searching': '搜索中…',
        'direct.cancel': '取消搜索',
        'direct.canceled': '已取消搜索。',
        'direct.result': '「{query}」的搜索结果',
        'direct.resultCount': '{count} 条结果',
        'direct.empty': '没有找到结果。可以换个关键词再试。',
        'direct.error': '搜索失败：{message}',
        'direct.record': '数据记录',
        'direct.history': '历史档案',
        'direct.back': '返回搜索',
        'direct.pickArchive': '从档案列表选择一份档案查看或导出。',
        'app.tagline': '深度研究',
        'app.brandCaption': '主题档案',
        'app.newSearch': '新建研究',

        'rail.new': '新建研究',
        'rail.queryPlaceholder': '一个话题、公司或现象',
        'rail.depth': '研究深度',
        'rail.depth.quick': '快速',
        'rail.depth.deep': '深入',
        'rail.depth.quickHint': '3–4 个问题',
        'rail.depth.deepHint': '5–8 个问题',
        'rail.start': '开始搜索',
        'rail.filterPlaceholder': '搜索档案',
        'rail.counts': '{q} 问 · {s} 源',
        'rail.noMatch': '没有匹配的档案',
        'rail.emptyList': '还没有档案。新建一次研究，它会留在这里。',
        'rail.group.today': '今天',
        'rail.group.week': '本周',
        'rail.group.earlier': '更早',
        'rail.footer.searchMode': '检索',
        'rail.footer.model': '模型',
        'rail.footer.loading': '正在读取运行状态…',
        'rail.settings': '设置',
        'rail.close': '关闭侧栏',
        'rail.open': '打开侧栏',
        'rail.runningBadge': '运行中',

        'status.loading': '加载中',
        'status.saving': '保存中',
        'status.deleting': '删除中',
        'status.retry': '重试',
        'status.close': '关闭',
        'status.cancel': '取消',
        'status.back': '返回',
        'status.confirm': '确定',
        'status.unknown': '未知',
        'status.done': '完成',

        'archiveStatus.draft': '草稿',
        'archiveStatus.running': '进行中',
        'archiveStatus.done': '已完成',
        'archiveStatus.partial': '部分完成',
        'archiveStatus.failed': '失败',

        'jobStatus.queued': '排队中',
        'jobStatus.running': '进行中',
        'jobStatus.done': '已完成',
        'jobStatus.partial': '部分完成',
        'jobStatus.failed': '失败',
        'jobStatus.canceled': '已取消',

        'empty.title': '一个词，读出三层',
        'empty.subtitle': '输入一个主题。先建立基础认识与讨论地图，再做深度分析；每个事实、说法与判断都能追到来源注释。',
        'empty.placeholder': '想研究什么？例如：AI 搜索',
        'empty.start': '开始搜索',
        'empty.starting': '正在创建…',
        'empty.examples': '试试这些',
        'example.ai': 'AI 搜索',
        'example.company': '一家公司',
        'example.phenomenon': '一个社会现象',
        'empty.method': '先基础认识，再讨论地图，最后深度分析；事实、说法、判断与未知分开写，每个论断带来源注释。',
        'empty.keyboard': '⌘↵ 开始',
        'empty.chain': '一个词 → 基础认识 · 讨论地图 · 深度分析',
        'empty.chainCaption': '六个模块，注释贯穿全程',

        'stage.framing': '理解输入',
        'stage.basics': '基础检索与认识',
        'stage.discussion': '讨论检索与地图',
        'stage.coverage': '覆盖检查',
        'stage.planning': '问题规划',
        'stage.researching': '定向深搜',
        'stage.verifying': '证据核查',
        'stage.synthesizing': '形成判断',
        'stage.linking': '校验',
        'stage.hint.framing': '定对象、用途、范围与时间窗口',
        'stage.hint.basics': '基础检索与精读，建立基础认识',
        'stage.hint.discussion': '按议题检索，整理讨论地图',
        'stage.hint.coverage': '检查基础与讨论的缺口',
        'stage.hint.planning': '生成随主题变化的深度问题',
        'stage.hint.researching': '逐问题检索、精读并形成论断',
        'stage.hint.verifying': '补查反证，核查证据状态',
        'stage.hint.synthesizing': '写判断、未知、分支与关联',
        'stage.hint.linking': '校验注释与引用并写盘',

        'running.title': '正在研究「{title}」',
        'running.subtitle': '可以离开这个面板，任务会在后台继续；完成后自动打开档案。',
        'running.percent': '{n}%',
        'running.current': '当前动作',
        'running.queued': '排队中，等待当前任务结束…',
        'running.log': '实时日志',
        'running.logEmpty': '等待日志…',
        'running.logMore': '共 {n} 条',
        'running.cancel': '取消任务',
        'running.canceling': '正在取消…',
        'running.failed': '研究没有跑完',
        'running.failedHint': '检查检索与模型配置后重试；已经写入的内容不会丢失。',
        'running.canceled': '任务已取消',
        'running.back': '返回档案列表',
        'running.time': '已用 {time}',
        'running.stageDone': '已完成',
        'running.stageCurrent': '进行中',
        'running.stagePending': '待处理',
        'running.waiting': '正在建立任务…',

        'reading.back': '档案列表',
        'reading.meta': '{questions} 个问题 · {sources} 条来源 · 约 {minutes} 分钟',
        'reading.cutoff': '信息截止 {date}',
        'reading.depth.deep': '深入',
        'reading.depth.quick': '快速',
        'reading.actions.ask': '继续追问',
        'reading.actions.refresh': '刷新',
        'reading.actions.export': '导出',
        'reading.actions.delete': '删除',
        'reading.actions.kb': '存入知识库',
        'kb.savedButton': '已存入知识库',
        'kb.savedTitle': '已存入知识库 {n} 次',
        'kb.title': '存入知识库',
        'kb.subtitle': '把这份档案作为素材加入本地知识库',
        'kb.desc': '「{title}」会作为素材存入本地知识库，并编译成互相链接的 Wiki 页面。来源、证据链与身份标注都会保留。',
        'kb.format': '存入格式',
        'kb.formatFull': '完整档案',
        'kb.formatBrief': '一页简报',
        'kb.formatChars': '约 {n} 字',
        'kb.status': '知识库状态',
        'kb.statusLine': '{label}：{value}',
        'kb.statusChecking': '检测中…',
        'kb.statusReady': '可用',
        'kb.unavailable': '未安装或未启用知识库插件',
        'kb.unavailableHint': '请先在 DSH 中安装并启用「知识库」插件，然后重新打开此弹层。',
        'kb.records': '存入记录',
        'kb.recordsHint': '再次存入会新增一条素材，不覆盖已有记录。',
        'kb.pages': '{n} 页',
        'kb.stage': '知识库任务',
        'kb.exporting': '正在导出档案…',
        'kb.ingesting': '正在提交到知识库…',
        'kb.savingRecord': '正在写入档案记录…',
        'kb.backgroundHint': '可以关闭这个弹层，编译会在后台继续。',
        'kb.saved': '已存入知识库 · {n} 页',
        'kb.openKb': '打开知识库',
        'kb.close': '关闭',
        'kb.failed': '存入失败：{message}',
        'kb.compileFailed': '知识库编译失败',
        'kb.timeout': '编译超过 180 秒，后台可能仍在编译；稍后重新打开档案查看记录。',
        'kb.retryHint': '可以重试；已生成的素材不会重复提交。',
        'kb.retry': '重试',
        'kb.submit': '存入知识库',
        'kb.submitAgain': '再次存入',
        'kb.working': '处理中…',
        'kb.savedToast': '已存入知识库 · {n} 页',
        'kb.savedExisting': '知识库已有相同素材 · 已关联 {n} 页',
        'kb.existedNote': '知识库已有相同素材，本次为再次存入的关联记录。',
        'kb.existedToast': '知识库已有相同素材，已新增一条档案记录',
        'kb.failedToast': '存入知识库失败',
        'kb.recordFailed': '知识库已编译完成，但写入档案记录失败：{message}',
        'kb.recordFailedToast': '知识库已编译，但档案记录写入失败',
        'kb.stageQueued': '排队中',
        'kb.stageParsing': '解析素材',
        'kb.stageCompiling': '编译 Wiki 页面',
        'kb.stageWriting': '写入索引与链接',
        'kb.stageDone': '完成',
        'reading.refreshing': '正在刷新…',
        'reading.definition': '定义',
        'reading.tensions': '核心张力',
        'reading.howToRead': '阅读路径',
        'reading.toc': '本页目录',
        'reading.stats': '研究统计',
        'reading.stats.questions': '问题',
        'reading.stats.annotations': '注释',
        'reading.stats.sources': '来源',
        'reading.stats.independent': '独立信源',
        'reading.stats.searches': '检索',
        'reading.stats.searchesValue': '{n} 次',
        'reading.stats.unjudged': '（未判定 {m}）',
        'reading.stats.unjudgedOnly': '未判定 {m}',
        'reading.stats.duration': '用时',
        'reading.hint': '← → 切换问题 · Esc 关闭弹层',
        'reading.followupCta': '还有想问的？继续追问这份档案',
        'reading.followupPlaceholder': '提出一个后续问题…',
        'reading.newContent': '新增内容已高亮',

        'export.full': '完整档案（Markdown）',
        'export.brief': '简报（Markdown）',
        'export.json': 'JSON 数据',
        'export.done': '已导出 {filename}',
        'export.failed': '导出失败：{message}',

        'delete.title': '删除这份档案？',
        'delete.body': '「{title}」会被移入回收站，之后可以在数据目录里找回。',
        'delete.confirm': '删除',
        'delete.cancel': '取消',
        'delete.done': '已移入回收站',

        'section.understanding': '这是什么',
        'section.discussion': '大家在讨论什么',
        'section.questions': '值得深入理解什么',
        'section.judgments': '目前能确定什么',
        'section.branches': '接下来值得查什么',
        'section.sources': '资料来源',

        'overview.brief': '综述',
        'overview.findings': '最重要的发现',
        'overview.findingsHint': '点击任意一条，查看它的证据链',
        'overview.meta': '{confidence}置信度 · {n} 条独立信源',
        'overview.independent': '{n} 条独立信源',
        'overview.singleSource': '单一信源 · 不宜作定论',
        'overview.empty': '这份档案还没有概览。',
        'overview.timeline': '时间线',
        'overview.definition': '主题定义',

        'map.title': '问题地图',
        'map.hint': '按研究顺序排列。点击卡片进入对应研究单元。',
        'map.why': '为什么问这个',
        'map.summary': '一句话回答',
        'map.evidence': '{n} 条证据',
        'map.gaps': '{n} 个缺口',
        'map.confidence': '置信度 {level}',
        'map.relationFrom': '承接 {id}',
        'map.relationStart': '研究起点',
        'map.open': '进入分题',
        'map.empty': '这份档案还没有问题。',
        'relation.opens': '开启',
        'relation.deepens': '深化',
        'relation.contrasts': '对照',
        'relation.depends': '依赖',
        'relation.closes': '收敛',

        'research.q': '问题 {n}',
        'research.why': '为什么问',
        'research.conclusion': '结论',
        'research.basis': '依据',
        'research.conditions': '成立条件',
        'research.evidence': '证据',
        'research.support': '支持',
        'research.oppose': '反对',
        'research.context': '背景',
        'research.mechanism': '机制',
        'research.counter': '反例与限制',
        'research.gap': '缺口',
        'research.gapWhy': '补上会改变什么',
        'research.gapHow': '怎么补',
        'research.followup': '后续追问',
        'research.followupHook': '补上会改变什么',
        'research.relation': '与其它问题的关系',
        'research.entities': '相关实体',
        'research.evidenceCount': '{n} 条证据',
        'research.emptyEvidence': '这个问题还没有证据。',
        'research.searchFollowup': '继续搜',
        'research.empty': '暂无研究内容。',
        'research.quoteToggle': '原文摘录',
        'research.note': '口径',
        'research.independent': '独立信源 {n}',
        'research.openChain': '查看证据链',
        'research.noBasis': '未记录推导依据',

        'identity.fact': '事实',
        'identity.claim': '声称',
        'identity.analysis': '分析',
        'identity.unknown': '未知',
        'confidence.high': '高',
        'confidence.medium': '中',
        'confidence.low': '低',
        'stance.support': '支持',
        'stance.oppose': '反对',
        'stance.context': '背景',
        'strength.primary': '一手',
        'strength.secondary': '二手',
        'strength.singleSource': '单一信源',
        'strength.contested': '有争议',
        'independence.unjudged': '独立性未判定',
        'independence.primary': '原始',
        'independence.independent': '独立',
        'independence.syndicated': '转述',
        'independence.unknown': '未知',
        'reliability.high': '高',
        'reliability.medium': '中',
        'reliability.low': '低',
        'sourceKind.primary': '原始',
        'sourceKind.report': '报道',
        'sourceKind.data': '数据',
        'sourceKind.analysis': '分析',
        'sourceKind.interview': '访谈',
        'sourceKind.social': '社交',
        'sourceKind.other': '其他',
        'topicKind.technology': '技术',
        'topicKind.company': '公司',
        'topicKind.phenomenon': '现象',
        'topicKind.event': '事件',
        'topicKind.person': '人物',
        'topicKind.concept': '概念',
        'topicKind.policy': '政策',
        'role.definition': '定义',
        'role.mechanism': '机制',
        'role.evidence': '证据',
        'role.politicalEconomy': '政治经济',
        'role.uncertainty': '不确定性',
        'role.context': '背景',
        'role.custom': '自定',
        'questionStatus.pending': '待研究',
        'questionStatus.researching': '研究中',
        'questionStatus.done': '已完成',
        'questionStatus.partial': '部分完成',
        'questionStatus.failed': '失败',

        // ---- v2 六模块 / 讨论地图 / 注释 ----
        'reading.noteLabel': '导读',
        'blockKind.definition': '这是什么',
        'blockKind.purpose': '解决什么问题',
        'blockKind.howItWorks': '怎样运作',
        'blockKind.background': '必要背景',
        'blockKind.confusable': '容易混淆',
        'blockKind.fact': '事实',
        'understanding.hint': '它是什么、有什么用途、怎样运作，以及哪些概念容易混淆。',
        'understanding.empty': '这份档案还没有基础认识。',
        'understanding.summary': '一句话解释',
        'understanding.blocks': '分块说明',
        'understanding.entities': '相关实体',
        'understanding.confusables': '容易混淆',
        'understanding.timeline': '时间线',
        'understanding.coverage': '基础认识覆盖',
        'understanding.scope': '研究范围',
        'understanding.exclusions': '不覆盖',
        'coverage.covered': '覆盖充分',
        'coverage.partial': '部分覆盖',
        'coverage.missing': '覆盖不足',
        'coverage.limits': '限制',
        'coverage.partialHint': '本轮只覆盖部分材料；缺口与限制如实列出，未用概括补齐。',
        'coverage.missingHint': '本轮没有取得可用材料；保留模块并写明限制，不把空白补成结论。',
        'discussion.hint': '本次查阅到的讨论议题、发言者与分歧来源。',
        'discussion.scope': '讨论范围',
        'discussion.window': '时间窗口',
        'discussion.platforms': '平台',
        'discussion.languages': '语言',
        'discussion.materials': '材料数',
        'discussion.speakers': '发言主体',
        'discussion.limits': '访问限制',
        'discussion.checkedAt': '查阅时间',
        'discussion.issues': '议题',
        'discussion.items': '讨论项',
        'discussion.basis': '依据',
        'discussion.holders': '持有者',
        'discussion.disagreement': '分歧来源',
        'discussion.gaps': '还缺什么',
        'discussion.status': '讨论覆盖',
        'discussion.empty': '在本轮可访问范围内，尚不足以归纳公开讨论。',
        'discussion.emptyHint': '模块保留，覆盖限制如实列出，不为结构完整而编造内容。',
        'discussion.speakerUnknown': '来源主体未确认',
        'discussionIdentity.company': '公司',
        'discussionIdentity.researcher': '研究者',
        'discussionIdentity.user': '用户',
        'discussionIdentity.media': '媒体',
        'discussionIdentity.official': '官方',
        'discussionIdentity.other': '其他',
        'questions.hint': '问题地图与研究单元；每个论断标身份、置信度与证据状态。',
        'questions.map': '问题地图',
        'questions.units': '研究单元',
        'questions.empty': '这份档案还没有深度问题。',
        'questions.why': '为什么问',
        'questions.summary': '一句话回答',
        'questions.evidenceNeed': '需要的证据',
        'questions.claims': '论断',
        'questions.mechanism': '机制',
        'questions.counterpoints': '反例与边界',
        'questions.gaps': '缺口',
        'questions.branches': '相关分支',
        'questions.attribution': '谁说的',
        'questions.basis': '依据',
        'questions.scope': '适用范围',
        'questions.conditions': '成立条件',
        'questions.emptyEvidence': '这个问题还没有证据。',
        'priority.high': '高',
        'priority.medium': '中',
        'priority.low': '低',
        'questionCoverage.answered': '已回答',
        'questionCoverage.partial': '部分回答',
        'questionCoverage.disputed': '有争议',
        'questionCoverage.noEvidence': '无证据',
        'evidenceStatus.supported': '有支持',
        'evidenceStatus.limited': '证据有限',
        'evidenceStatus.conflicted': '证据冲突',
        'evidenceStatus.unsupported': '无证据',
        'judgments.hint': '哪些有依据、哪些只是当事方说法、哪些还不能判断。',
        'judgments.emptyAll': '暂无判断、未知与关联。',
        'judgments.conditions': '成立条件',
        'judgments.stale': '可能过时',
        'judgments.unknowns': '未知',
        'judgments.unknownWhy': '为什么重要',
        'judgments.unknownHow': '怎么关闭',
        'judgments.connections': '关联发现',
        'branches.hint': '按优先级排列；补上可能改变判断的缺口。',
        'branches.empty': '暂无下一步分支。',
        'branches.search': '继续搜',
        'branches.hook': '补上会改变什么',
        'branches.question': '关联问题 {id}',
        'branchStatus.open': '待查',
        'branchStatus.answered': '已回答',
        'module.understanding': '这是什么',
        'module.discussion': '大家在讨论什么',
        'module.question': '深度分析',
        'module.judgment': '判断',
        'readScope.fullText': '全文',
        'readScope.section': '章节',
        'readScope.abstract': '摘要',
        'readScope.snippet': '搜索片段',
        'readScope.transcript': '转写',
        'readScope.unknown': '未标注',
        'annotation.title': '注释 {n}',
        'annotation.subtitle': '{count} 个来源 · {module}',
        'annotation.open': '打开注释 {n}',
        'annotation.label': '来源注释',
        'annotation.quote': '原文摘录',
        'annotation.openChain': '查看证据链',
        'annotation.noQuote': '未取得原文连续片段，只读到{scope}。',
        'annotation.locator': '定位',
        'annotation.readScope': '读取范围',
        'annotation.retrievedAt': '获取时间',
        'annotation.identity': '内容身份',
        'annotation.sourceKind': '来源性质',
        'annotation.sources': '来源',
        'annotation.usedBy': '被用于哪些论断',
        'annotation.usedSummary': '这是什么 · 一句话解释',
        'annotation.usedUnderstanding': '这是什么 · {title}',
        'annotation.usedDiscussion': '大家在讨论什么 · {title}',
        'annotation.usedClaim': '论断 {id}',
        'annotation.usedJudgment': '目前能确定什么 · 判断',
        'annotation.usedQuestion': '问题 {id}',
        'annotation.usedOther': '其它引用',
        'annotation.empty': '找不到这条注释。',
        'annotation.untitledBlock': '分块说明',
        'annotation.untitledIssue': '讨论项',
        'annotation.sourceOpen': '来源详情',
        'annotation.unknownSource': '来源信息缺失',
        'sources.module': '筛选',
        'sources.all': '全部',
        'sources.cited': '已引用',
        'sources.uncited': '补充阅读',
        'sources.sortByNumber': '按注释编号排序',
        'sources.col.number': '编号',
        'sources.col.author': '作者',
        'sources.col.scope': '读取范围',
        'sources.supplementary': '补充',
        'sources.citedNone': '未被正文引用',
        'sources.emptyFilter': '当前筛选下没有来源。',
        'chain.claim': '论断',
        'chain.claims': '相关论断',
        'chain.judgment': '判断',
        'chain.attribution': '谁说的',
        'chain.basis': '依据',
        'chain.open': '查看',
        'chain.branch': '分支',
        'sourceDrawer.author': '作者/机构',
        'sourceDrawer.publishedAt': '发布日期',
        'sourceDrawer.retrievedAt': '获取时间',
        'sourceDrawer.locator': '定位',
        'sourceDrawer.readScope': '读取范围',
        'sourceDrawer.annotations': '注释位置',
        'sourceDrawer.otherUses': '其它引用',
        'sourceDrawer.supplementary': '未被正文引用，作为补充阅读保留。',
        'sourceDrawer.usageEntity': '实体',

        'disputes.title': '分歧与未知',
        'disputes.hint': '说法冲突、分歧来源，以及还缺什么证据。',
        'disputes.origin': '分歧来源',
        'disputes.missing': '还缺什么',
        'disputes.ourRead': '我们的读法',
        'disputes.holders': '持有者',
        'disputes.evidence': '证据',
        'disputes.unknowns': '未知',
        'disputes.unknownWhy': '为什么重要',
        'disputes.unknownHow': '怎么关闭',
        'disputes.unknownQuestion': '关联问题 {id}',
        'disputes.empty': '暂无分歧与未知。',

        'connections.title': '关联发现',
        'connections.hint': '跨领域的连接机制；证据不足的标为待验证。',
        'connections.from': '从 {id}',
        'connections.to': '指向「{to}」',
        'connections.note': '备注',
        'connections.empty': '暂无关联发现。',
        'connectionKind.constraint': '约束',
        'connectionKind.dependency': '依赖',
        'connectionKind.analogy': '类比',
        'connectionKind.sameRoot': '同源',
        'connectionKind.counterweight': '制衡',
        'connectionStatus.verified': '已证实',
        'connectionStatus.suggested': '待验证',
        'connectionStatus.unverified': '线索',

        'sources.title': '来源资料',
        'sources.hint': '点击一行查看摘要、原文与引用位置。',
        'sources.col.title': '标题',
        'sources.col.publisher': '站点',
        'sources.col.date': '日期',
        'sources.col.kind': '类型',
        'sources.col.independence': '独立性',
        'sources.col.reliability': '可靠度',
        'sources.col.used': '被引用',
        'sources.usedCount': '{n} 处',
        'sources.empty': '还没有来源。',
        'sources.openTip': '打开原文',

        'chain.title': '证据链',
        'chain.subtitle': '从主题一路追到来源与缺口',
        'chain.theme': '主题',
        'chain.question': '问题',
        'chain.conclusion': '结论',
        'chain.support': '支持证据',
        'chain.oppose': '反对证据',
        'chain.sources': '来源',
        'chain.gaps': '缺口',
        'chain.noConclusion': '该问题还没有结论',
        'chain.noEvidence': '没有证据',
        'chain.noGaps': '没有记录缺口',
        'chain.openSource': '查看来源',
        'chain.openQuestion': '查看问题',
        'chain.current': '当前',
        'chain.empty': '无法组装证据链：档案里找不到这个引用。',
        'chain.backToChain': '返回证据链',
        'chain.conditions': '成立条件',
        'chain.why': '补上会改变什么',

        'sourceDrawer.title': '来源',
        'sourceDrawer.open': '打开原文',
        'sourceDrawer.quote': '关键原文',
        'sourceDrawer.summary': '搜索摘要',
        'sourceDrawer.excerpt': '精读摘录',
        'sourceDrawer.used': '被引用位置',
        'sourceDrawer.emptyExcerpt': '未抓取到原文。',
        'sourceDrawer.fetched': '已抓取 {chars} 字',
        'sourceDrawer.fetchFailed': '未抓取',
        'sourceDrawer.meta': '{publisher} · {date}',
        'sourceDrawer.independence': '独立性',
        'sourceDrawer.reliability': '可靠度',
        'sourceDrawer.kind': '类型',
        'sourceDrawer.none': '这条来源没有更多信息。',
        'sourceDrawer.usageEvidence': '证据 {id} · 问题 {qid}',
        'sourceDrawer.usageConnection': '关联 {id}',
        'sourceDrawer.usageTimeline': '时间线 {id}',

        'ask.title': '继续追问',
        'ask.subtitle': '针对「{title}」补一个问题；完成后会更新这份档案。',
        'ask.placeholder': '追问什么？例如：这些结论有哪些反例？',
        'ask.recommended': '推荐问题',
        'ask.submit': '开始追问',
        'ask.submitting': '正在提交…',
        'ask.keyboard': '⌘↵ 提交',
        'ask.cancel': '取消',
        'ask.noFollowups': '没有推荐问题，直接写你想问的。',
        'ask.started': '已提交追问，正在更新档案',
        'ask.prefill': '已填入推荐问题',

        'settings.title': '设置',
        'settings.rootDir': '数据目录',
        'settings.rootDirHint': '档案与日志的保存位置。留空使用默认目录。',
        'settings.defaultDepth': '默认深度',
        'settings.searchMode': '检索来源',
        'settings.defaultSearchMode': '默认检索来源',
        'settings.activeSearchMode': '当前检索来源',
        'settings.searchMode.auto': '自动选择',
        'settings.searchMode.account': 'DeepSeek 账号',
        'settings.searchMode.web': 'DSH 网页检索',
        'settings.searchMode.api': 'DeepSeek API Key',
        'settings.searchMode.anysearch': 'AnySearch',
        'settings.anySearchKeyMissing': '配置 AnySearch API Key 后即可选择。',
        'anySearch.scope': '检索领域',
        'anySearch.auto': '自动选择',
        'anySearch.autoHint': 'AnySearch 根据每条查询选择信源。',
        'anySearch.capability': '检索类型',
        'anySearch.chooseCapability': '请选择',
        'anySearch.loading': '正在加载检索目录…',
        'anySearch.loadFailed': '无法加载 AnySearch 检索目录。',
        'anySearch.noCapabilities': '该领域目前没有可选的检索类型。',
        'anySearch.retry': '重试',
        'anySearch.params': '检索参数',
        'anySearch.optionalParams': '可选参数',
        'anySearch.chooseToStart': '请选择 AnySearch 检索类型，或将领域切回自动选择。',
        'anySearch.fillFields': '请填写：{fields}。',
        'anySearch.esports.description': '查《英雄联盟》的玩家战绩、排位榜、英雄和装备。',
        'anySearch.esports.type': '查询内容',
        'anySearch.esports.typeHint': '先选要查什么，表单会显示对应的填写项。',
        'anySearch.esports.player': '对局记录与排位概览',
        'anySearch.esports.ranked': '排位数据',
        'anySearch.esports.mastery': '英雄熟练度',
        'anySearch.esports.live_game': '正在进行的对局',
        'anySearch.esports.match_detail': '单场对局详情',
        'anySearch.esports.leaderboard': '排位排行榜',
        'anySearch.esports.champion': '英雄资料',
        'anySearch.esports.item': '装备资料',
        'anySearch.esports.champion_rotation': '当前免费英雄',
        'anySearch.esports.championQuery': '在上方搜索框填英雄名，例如「亚索」。',
        'anySearch.esports.itemQuery': '在上方搜索框填装备名，例如「无尽之刃」。',
        'anySearch.esports.region': '服务器',
        'anySearch.esports.regionHint': '填区服代码，例如韩服 kr、北美 na、西欧 euw。',
        'anySearch.esports.rotationRegionHint': '填区服代码，例如韩服 kr。留空查北美服。',
        'anySearch.esports.game_name': 'Riot ID',
        'anySearch.esports.game_nameHint': '填游戏昵称和 # 后缀，例如 Hide on Bush#KR1。',
        'anySearch.esports.match_id': '对局 ID',
        'anySearch.esports.match_idHint': '填带区服前缀的完整对局 ID，例如 KR_7482819248。',
        'anySearch.esports.queue': '排位队列',
        'anySearch.esports.queueHint': '单双排填 RANKED_SOLO_5x5，灵活排位填 RANKED_FLEX_SR。',
        'anySearch.esports.tier': '段位',
        'anySearch.esports.tierHint': '填英文段位代码，例如钻石 DIAMOND。留空查王者、宗师和大师。',
        'anySearch.esports.division': '小段位',
        'anySearch.esports.divisionHint': '钻石到黑铁可填 I、II、III 或 IV，留空按 I。',
        'anySearch.esports.championFilter': '英雄名称',
        'anySearch.esports.championHint': '按英雄名筛选，例如 Yasuo。留空查所有英雄的熟练度。',
        'anySearch.records': 'AnySearch 结构化数据',
        'anySearch.recordHint': '这些记录由 AnySearch 返回，未提供可引用的网页链接。',
        'anySearch.domain.academic': '学术',
        'anySearch.domain.agriculture': '农业',
        'anySearch.domain.business': '商业',
        'anySearch.domain.code': '代码',
        'anySearch.domain.energy': '能源',
        'anySearch.domain.environment': '环境',
        'anySearch.domain.film': '影视音乐',
        'anySearch.domain.finance': '金融',
        'anySearch.domain.gaming': '游戏',
        'anySearch.domain.general': '通用网页',
        'anySearch.domain.health': '医药健康',
        'anySearch.domain.ip': '知识产权',
        'anySearch.domain.legal': '法律',
        'anySearch.domain.resource': '图片素材',
        'anySearch.domain.security': '网络安全',
        'anySearch.domain.social_media': '社交媒体',
        'anySearch.domain.travel': '旅行',
        'anySearch.tag.academic.citation': '引用与文献标识',
        'anySearch.tag.academic.dataset': '研究数据集',
        'anySearch.tag.academic.paper': '学术论文',
        'anySearch.tag.academic.person': '研究人员',
        'anySearch.tag.agriculture.fao': '粮农组织统计',
        'anySearch.tag.business.company': '企业与披露',
        'anySearch.tag.business.jobs': '招聘职位',
        'anySearch.tag.business.people': '商业联系人',
        'anySearch.tag.business.trade': '国际贸易',
        'anySearch.tag.code.doc': '开发文档',
        'anySearch.tag.code.snippet': '代码片段',
        'anySearch.tag.energy.electricity': '电力市场',
        'anySearch.tag.energy.production': '能源统计',
        'anySearch.tag.environment.aqi': '空气质量',
        'anySearch.tag.film.torrent': '影视音乐种子',
        'anySearch.tag.finance.calendar': '财经日历',
        'anySearch.tag.finance.fundamental': '基本面',
        'anySearch.tag.finance.macro': '宏观数据',
        'anySearch.tag.finance.news': '财经新闻',
        'anySearch.tag.finance.quote': '行情',
        'anySearch.tag.finance.screen': '资产筛选',
        'anySearch.tag.gaming.esports': '电竞数据',
        'anySearch.tag.gaming.store': 'Steam 商店',
        'anySearch.tag.general.general': '通用网页',
        'anySearch.tag.health.drug': '药品',
        'anySearch.tag.health.stats': '公共卫生统计',
        'anySearch.tag.health.trial': '临床试验',
        'anySearch.tag.ip.global': '全球专利',
        'anySearch.tag.legal.enforcement': '执法信息',
        'anySearch.tag.legal.judicial': '司法案例',
        'anySearch.tag.legal.legislation': '立法资料',
        'anySearch.tag.resource.image': '图片',
        'anySearch.tag.security.intel': '威胁情报',
        'anySearch.tag.security.noise': '背景流量',
        'anySearch.tag.security.scan': '恶意软件扫描',
        'anySearch.tag.security.vuln': '漏洞记录',
        'anySearch.tag.social_media.social_media': '社交媒体内容',
        'anySearch.tag.travel.flight': '机票',
        'anySearch.tag.travel.flight_status': '航班状态',
        'settings.model': '模型路由',
        'settings.version': '版本',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '设置已保存',
        'settings.cancel': '取消',
        'settings.unavailable': '设置暂不可用',
        'settings.healthFailed': '无法读取运行状态',

        'notice.created': '已开始研究',
        'notice.askStarted': '已提交追问',
        'notice.done': '研究完成',
        'notice.partial': '研究完成，部分问题未跑完',
        'notice.failed': '研究失败',
        'notice.canceled': '任务已取消',
        'notice.refreshed': '档案已更新',
        'notice.copied': '已复制',

        'error.loadTopics': '无法加载档案列表：{message}',
        'error.loadTopic': '无法加载档案：{message}',
        'error.loadSettings': '无法加载设置：{message}',
        'error.loadHealth': '无法读取运行状态：{message}',
        'error.start': '无法开始研究：{message}',
        'error.ask': '无法提交追问：{message}',
        'error.export': '导出失败：{message}',
        'error.delete': '删除失败：{message}',
        'error.refresh': '刷新失败：{message}',
        'error.cancel': '取消失败：{message}',
        'error.saveSettings': '保存失败：{message}',
        'error.network': '网络不可用',
        'error.badResponse': '返回数据格式不正确',
        'error.requestFailed': '请求失败',
        'error.jobPoll': '无法获取任务进度：{message}',
        'error.routeHint': '宿主路由可能尚未就绪，稍后刷新页面重试。',

        'crash.title': '面板渲染出错',
        'crash.hint': '重新打开面板；若仍然出错，请查看浏览器控制台。',

        'time.justNow': '刚刚',
        'time.minutesAgo': '{n} 分钟前',
        'time.hoursAgo': '{n} 小时前',
        'time.daysAgo': '{n} 天前',
        'time.minutes': '{n} 分钟',
        'time.seconds': '{n} 秒',
      }

      const en = {
        'panel.label': 'Deep Search',
        'direct.query': 'Enter a keyword or question',
        'direct.search': 'Search',
        'direct.searching': 'Searching…',
        'direct.cancel': 'Cancel search',
        'direct.canceled': 'Search canceled.',
        'direct.result': 'Search results for “{query}”',
        'direct.resultCount': '{count} results',
        'direct.empty': 'No results found. Try a different keyword.',
        'direct.error': 'Search failed: {message}',
        'direct.record': 'Data record',
        'direct.history': 'Past dossiers',
        'direct.back': 'Back to search',
        'direct.pickArchive': 'Choose a dossier from the list to read or export it.',
        'app.tagline': 'Deep research',
        'app.brandCaption': 'Topic dossier',
        'app.newSearch': 'New research',

        'rail.new': 'New research',
        'rail.queryPlaceholder': 'A topic, company, or phenomenon',
        'rail.depth': 'Depth',
        'rail.depth.quick': 'Quick',
        'rail.depth.deep': 'Deep',
        'rail.depth.quickHint': '3–4 questions',
        'rail.depth.deepHint': '5–8 questions',
        'rail.start': 'Start',
        'rail.filterPlaceholder': 'Search dossiers',
        'rail.counts': '{q}Q · {s}S',
        'rail.noMatch': 'No matching dossiers',
        'rail.emptyList': 'No dossiers yet. Start a research and it will appear here.',
        'rail.group.today': 'Today',
        'rail.group.week': 'This week',
        'rail.group.earlier': 'Earlier',
        'rail.footer.searchMode': 'Search',
        'rail.footer.model': 'Model',
        'rail.footer.loading': 'Reading runtime status…',
        'rail.settings': 'Settings',
        'rail.close': 'Close sidebar',
        'rail.open': 'Open sidebar',
        'rail.runningBadge': 'Running',

        'status.loading': 'Loading',
        'status.saving': 'Saving',
        'status.deleting': 'Deleting',
        'status.retry': 'Retry',
        'status.close': 'Close',
        'status.cancel': 'Cancel',
        'status.back': 'Back',
        'status.confirm': 'Confirm',
        'status.unknown': 'Unknown',
        'status.done': 'Done',

        'archiveStatus.draft': 'Draft',
        'archiveStatus.running': 'Running',
        'archiveStatus.done': 'Done',
        'archiveStatus.partial': 'Partial',
        'archiveStatus.failed': 'Failed',

        'jobStatus.queued': 'Queued',
        'jobStatus.running': 'Running',
        'jobStatus.done': 'Done',
        'jobStatus.partial': 'Partial',
        'jobStatus.failed': 'Failed',
        'jobStatus.canceled': 'Canceled',

        'empty.title': 'One word, three layers',
        'empty.subtitle': 'Enter a topic. Start with a shared understanding and a discussion map, then go deeper; every fact, claim, and judgment traces to a source note.',
        'empty.placeholder': 'What do you want to research? e.g. AI search',
        'empty.start': 'Start search',
        'empty.starting': 'Creating…',
        'empty.examples': 'Try one',
        'example.ai': 'AI search',
        'example.company': 'A company',
        'example.phenomenon': 'A social phenomenon',
        'empty.method': 'Understand first, map the discussion, then analyze. Keep facts, claims, analysis, and unknowns separate; every claim carries source notes.',
        'empty.keyboard': '⌘↵ to start',
        'empty.chain': 'One word → understanding · discussion map · deep analysis',
        'empty.chainCaption': 'Six modules, annotated throughout',

        'stage.framing': 'Understand input',
        'stage.basics': 'Basics',
        'stage.discussion': 'Discussion map',
        'stage.coverage': 'Coverage check',
        'stage.planning': 'Plan questions',
        'stage.researching': 'Research',
        'stage.verifying': 'Verify evidence',
        'stage.synthesizing': 'Form judgments',
        'stage.linking': 'Validate & save',
        'stage.hint.framing': 'Set object, purpose, scope, and time window',
        'stage.hint.basics': 'Search and read for the basics',
        'stage.hint.discussion': 'Search by issue and build the discussion map',
        'stage.hint.coverage': 'Check gaps in basics and discussion',
        'stage.hint.planning': 'Plan topic-specific deep questions',
        'stage.hint.researching': 'Research each question and form claims',
        'stage.hint.verifying': 'Look for counter-evidence and verify claims',
        'stage.hint.synthesizing': 'Write judgments, unknowns, branches, connections',
        'stage.hint.linking': 'Resolve annotations and persist',

        'running.title': 'Researching “{title}”',
        'running.subtitle': 'You can leave this panel; the job keeps running and the dossier opens when it finishes.',
        'running.percent': '{n}%',
        'running.current': 'Current action',
        'running.queued': 'Queued behind the current job…',
        'running.log': 'Live log',
        'running.logEmpty': 'Waiting for logs…',
        'running.logMore': '{n} entries',
        'running.cancel': 'Cancel job',
        'running.canceling': 'Canceling…',
        'running.failed': 'Research did not finish',
        'running.failedHint': 'Check search and model configuration and retry; written content is kept.',
        'running.canceled': 'Job canceled',
        'running.back': 'Back to dossiers',
        'running.time': 'Elapsed {time}',
        'running.stageDone': 'Done',
        'running.stageCurrent': 'Current',
        'running.stagePending': 'Pending',
        'running.waiting': 'Setting up the job…',

        'reading.back': 'Dossiers',
        'reading.meta': '{questions} questions · {sources} sources · ~{minutes} min',
        'reading.cutoff': 'Information cut-off {date}',
        'reading.depth.deep': 'Deep',
        'reading.depth.quick': 'Quick',
        'reading.actions.ask': 'Ask follow-up',
        'reading.actions.refresh': 'Refresh',
        'reading.actions.export': 'Export',
        'reading.actions.delete': 'Delete',
        'reading.actions.kb': 'Save to knowledge base',
        'kb.savedButton': 'Saved to knowledge base',
        'kb.savedTitle': 'Saved {n} times',
        'kb.title': 'Save to knowledge base',
        'kb.subtitle': 'Add this dossier to your local knowledge base as a source',
        'kb.desc': '“{title}” will be ingested as a source and compiled into linked Wiki pages. Sources, evidence chains, and identity labels are preserved.',
        'kb.format': 'Format',
        'kb.formatFull': 'Full dossier',
        'kb.formatBrief': 'One-page brief',
        'kb.formatChars': '~{n} chars',
        'kb.status': 'Knowledge base',
        'kb.statusLine': '{label}: {value}',
        'kb.statusChecking': 'Checking…',
        'kb.statusReady': 'Available',
        'kb.unavailable': 'Knowledge base plugin is not installed or enabled',
        'kb.unavailableHint': 'Install and enable the Knowledge Base plugin in DSH, then reopen this dialog.',
        'kb.records': 'Saved records',
        'kb.recordsHint': 'Saving again adds a new source; existing records are kept.',
        'kb.pages': '{n} pages',
        'kb.stage': 'KB job',
        'kb.exporting': 'Exporting dossier…',
        'kb.ingesting': 'Submitting to knowledge base…',
        'kb.savingRecord': 'Writing dossier record…',
        'kb.backgroundHint': 'You can close this dialog; compilation continues in the background.',
        'kb.saved': 'Saved to knowledge base · {n} pages',
        'kb.openKb': 'Open knowledge base',
        'kb.close': 'Close',
        'kb.failed': 'Save failed: {message}',
        'kb.compileFailed': 'Knowledge base compilation failed',
        'kb.timeout': 'Compilation took over 180 seconds and may still be running; reopen the dossier later to check its records.',
        'kb.retryHint': 'You can retry; already generated sources are not resubmitted.',
        'kb.retry': 'Retry',
        'kb.submit': 'Save to knowledge base',
        'kb.submitAgain': 'Save again',
        'kb.working': 'Working…',
        'kb.savedToast': 'Saved to knowledge base · {n} pages',
        'kb.savedExisting': 'Same source already in the knowledge base · linked {n} pages',
        'kb.existedNote': 'The same source already existed; this is a linked record for a repeated save.',
        'kb.existedToast': 'Source already existed; a dossier record was added',
        'kb.failedToast': 'Failed to save to knowledge base',
        'kb.recordFailed': 'Compilation finished, but writing the dossier record failed: {message}',
        'kb.recordFailedToast': 'Compiled, but the dossier record could not be written',
        'kb.stageQueued': 'Queued',
        'kb.stageParsing': 'Parsing source',
        'kb.stageCompiling': 'Compiling Wiki pages',
        'kb.stageWriting': 'Writing index and links',
        'kb.stageDone': 'Done',
        'reading.refreshing': 'Refreshing…',
        'reading.definition': 'Definition',
        'reading.tensions': 'Core tensions',
        'reading.howToRead': 'How to read',
        'reading.toc': 'On this page',
        'reading.stats': 'Research stats',
        'reading.stats.questions': 'Questions',
        'reading.stats.annotations': 'Notes',
        'reading.stats.sources': 'Sources',
        'reading.stats.independent': 'Independent',
        'reading.stats.searches': 'Searches',
        'reading.stats.searchesValue': '{n}',
        'reading.stats.unjudged': ' ({m} unjudged)',
        'reading.stats.unjudgedOnly': '{m} unjudged',
        'reading.stats.duration': 'Duration',
        'reading.hint': '← → switch question · Esc closes overlays',
        'reading.followupCta': 'Still curious? Ask this dossier a follow-up',
        'reading.followupPlaceholder': 'Ask a follow-up…',
        'reading.newContent': 'New content highlighted',

        'export.full': 'Full dossier (Markdown)',
        'export.brief': 'Brief (Markdown)',
        'export.json': 'JSON data',
        'export.done': 'Exported {filename}',
        'export.failed': 'Export failed: {message}',

        'delete.title': 'Delete this dossier?',
        'delete.body': '“{title}” will be moved to trash and can be recovered from the data directory.',
        'delete.confirm': 'Delete',
        'delete.cancel': 'Cancel',
        'delete.done': 'Moved to trash',

        'section.understanding': 'What this is',
        'section.discussion': 'What people discuss',
        'section.questions': 'What is worth understanding',
        'section.judgments': 'What we can establish',
        'section.branches': 'What to look into next',
        'section.sources': 'Sources',

        'overview.brief': 'Brief',
        'overview.findings': 'Key findings',
        'overview.findingsHint': 'Click any finding to trace its evidence chain',
        'overview.meta': '{confidence} confidence · {n} independent sources',
        'overview.independent': '{n} independent sources',
        'overview.singleSource': 'Single source; not conclusive',
        'overview.empty': 'No overview yet.',
        'overview.timeline': 'Timeline',
        'overview.definition': 'Definition',

        'map.title': 'Question map',
        'map.hint': 'Ordered by research sequence. Click a card to jump to its research unit.',
        'map.why': 'Why this question',
        'map.summary': 'One-line answer',
        'map.evidence': '{n} evidence',
        'map.gaps': '{n} gaps',
        'map.confidence': '{level} confidence',
        'map.relationFrom': 'Follows {id}',
        'map.relationStart': 'Starting point',
        'map.open': 'Open research',
        'map.empty': 'No questions yet.',
        'relation.opens': 'opens',
        'relation.deepens': 'deepens',
        'relation.contrasts': 'contrasts',
        'relation.depends': 'depends',
        'relation.closes': 'closes',

        'research.q': 'Question {n}',
        'research.why': 'Why',
        'research.conclusion': 'Conclusion',
        'research.basis': 'Basis',
        'research.conditions': 'Conditions',
        'research.evidence': 'Evidence',
        'research.support': 'Support',
        'research.oppose': 'Oppose',
        'research.context': 'Context',
        'research.mechanism': 'Mechanism',
        'research.counter': 'Counterpoints & limits',
        'research.gap': 'Gaps',
        'research.gapWhy': 'What it would change',
        'research.gapHow': 'How to close',
        'research.followup': 'Follow-ups',
        'research.followupHook': 'What it would change',
        'research.relation': 'Relations to other questions',
        'research.entities': 'Entities',
        'research.evidenceCount': '{n} evidence',
        'research.emptyEvidence': 'No evidence yet.',
        'research.searchFollowup': 'Search this',
        'research.empty': 'No research content yet.',
        'research.quoteToggle': 'Excerpt',
        'research.note': 'Note',
        'research.independent': '{n} independent sources',
        'research.openChain': 'View evidence chain',
        'research.noBasis': 'No derivation recorded',

        'identity.fact': 'Fact',
        'identity.claim': 'Claim',
        'identity.analysis': 'Analysis',
        'identity.unknown': 'Unknown',
        'confidence.high': 'High',
        'confidence.medium': 'Medium',
        'confidence.low': 'Low',
        'stance.support': 'Support',
        'stance.oppose': 'Oppose',
        'stance.context': 'Context',
        'strength.primary': 'Primary',
        'strength.secondary': 'Secondary',
        'strength.singleSource': 'Single source',
        'strength.contested': 'Contested',
        'independence.unjudged': 'Independence not assessed',
        'independence.primary': 'Primary',
        'independence.independent': 'Independent',
        'independence.syndicated': 'Syndicated',
        'independence.unknown': 'Unknown',
        'reliability.high': 'High',
        'reliability.medium': 'Medium',
        'reliability.low': 'Low',
        'sourceKind.primary': 'Primary',
        'sourceKind.report': 'Report',
        'sourceKind.data': 'Data',
        'sourceKind.analysis': 'Analysis',
        'sourceKind.interview': 'Interview',
        'sourceKind.social': 'Social',
        'sourceKind.other': 'Other',
        'topicKind.technology': 'Technology',
        'topicKind.company': 'Company',
        'topicKind.phenomenon': 'Phenomenon',
        'topicKind.event': 'Event',
        'topicKind.person': 'Person',
        'topicKind.concept': 'Concept',
        'topicKind.policy': 'Policy',
        'role.definition': 'Definition',
        'role.mechanism': 'Mechanism',
        'role.evidence': 'Evidence',
        'role.politicalEconomy': 'Political economy',
        'role.uncertainty': 'Uncertainty',
        'role.context': 'Context',
        'role.custom': 'Custom',
        'questionStatus.pending': 'Pending',
        'questionStatus.researching': 'Researching',
        'questionStatus.done': 'Done',
        'questionStatus.partial': 'Partial',
        'questionStatus.failed': 'Failed',

        // ---- v2 modules / discussion map / annotations ----
        'reading.noteLabel': 'Reading note',
        'blockKind.definition': 'What this is',
        'blockKind.purpose': 'What it solves',
        'blockKind.howItWorks': 'How it works',
        'blockKind.background': 'Background',
        'blockKind.confusable': 'Often confused',
        'blockKind.fact': 'Fact',
        'understanding.hint': 'What it is, what it is for, how it works, and which concepts are easy to confuse.',
        'understanding.empty': 'No shared understanding in this dossier yet.',
        'understanding.summary': 'In one line',
        'understanding.blocks': 'Explained in parts',
        'understanding.entities': 'Entities',
        'understanding.confusables': 'Easy to confuse',
        'understanding.timeline': 'Timeline',
        'understanding.coverage': 'Understanding coverage',
        'understanding.scope': 'Scope',
        'understanding.exclusions': 'Not covered',
        'coverage.covered': 'Covered',
        'coverage.partial': 'Partial',
        'coverage.missing': 'Not covered',
        'coverage.limits': 'Limits',
        'coverage.partialHint': 'Only part of the material was covered; gaps and limits are listed as they are, not filled with generalities.',
        'coverage.missingHint': 'No usable material was obtained in this pass; the module stays and the gap is not filled with invented content.',
        'discussion.hint': 'Issues, speakers, and sources of disagreement found in this pass.',
        'discussion.scope': 'Discussion scope',
        'discussion.window': 'Time window',
        'discussion.platforms': 'Platforms',
        'discussion.languages': 'Languages',
        'discussion.materials': 'Materials',
        'discussion.speakers': 'Speakers',
        'discussion.limits': 'Access limits',
        'discussion.checkedAt': 'Checked at',
        'discussion.issues': 'Issues',
        'discussion.items': 'Discussion items',
        'discussion.basis': 'Basis',
        'discussion.holders': 'Holders',
        'discussion.disagreement': 'Disagreement comes from',
        'discussion.gaps': 'Missing',
        'discussion.status': 'Discussion coverage',
        'discussion.empty': 'Within this pass, there is not enough access to summarize public discussion.',
        'discussion.emptyHint': 'The module stays; coverage limits are listed honestly instead of inventing content.',
        'discussion.speakerUnknown': 'Speaker unconfirmed',
        'discussionIdentity.company': 'Company',
        'discussionIdentity.researcher': 'Researcher',
        'discussionIdentity.user': 'User',
        'discussionIdentity.media': 'Media',
        'discussionIdentity.official': 'Official',
        'discussionIdentity.other': 'Other',
        'questions.hint': 'Question map and research units; every claim carries identity, confidence, and evidence status.',
        'questions.map': 'Question map',
        'questions.units': 'Research units',
        'questions.empty': 'No deep questions in this dossier yet.',
        'questions.why': 'Why ask',
        'questions.summary': 'One-line answer',
        'questions.evidenceNeed': 'Evidence needed',
        'questions.claims': 'Claims',
        'questions.mechanism': 'Mechanism',
        'questions.counterpoints': 'Counterpoints & limits',
        'questions.gaps': 'Gaps',
        'questions.branches': 'Related branches',
        'questions.attribution': 'Attributed to',
        'questions.basis': 'Basis',
        'questions.scope': 'Scope',
        'questions.conditions': 'Conditions',
        'questions.emptyEvidence': 'No evidence for this question yet.',
        'priority.high': 'High',
        'priority.medium': 'Medium',
        'priority.low': 'Low',
        'questionCoverage.answered': 'Answered',
        'questionCoverage.partial': 'Partial',
        'questionCoverage.disputed': 'Disputed',
        'questionCoverage.noEvidence': 'No evidence',
        'evidenceStatus.supported': 'Supported',
        'evidenceStatus.limited': 'Limited',
        'evidenceStatus.conflicted': 'Conflicted',
        'evidenceStatus.unsupported': 'Unsupported',
        'judgments.hint': 'What is supported, what is only a party’s claim, and what cannot be judged yet.',
        'judgments.emptyAll': 'No judgments, unknowns, or connections yet.',
        'judgments.conditions': 'Conditions',
        'judgments.stale': 'May be stale',
        'judgments.unknowns': 'Unknowns',
        'judgments.unknownWhy': 'Why it matters',
        'judgments.unknownHow': 'How to close',
        'judgments.connections': 'Connections',
        'branches.hint': 'Ordered by priority; the gaps that could change a judgment.',
        'branches.empty': 'No next-step branches.',
        'branches.search': 'Search this',
        'branches.hook': 'What it would change',
        'branches.question': 'Question {id}',
        'branchStatus.open': 'Open',
        'branchStatus.answered': 'Answered',
        'module.understanding': 'What this is',
        'module.discussion': 'What people discuss',
        'module.question': 'Deep analysis',
        'module.judgment': 'Judgments',
        'readScope.fullText': 'Full text',
        'readScope.section': 'Section',
        'readScope.abstract': 'Abstract',
        'readScope.snippet': 'Snippet',
        'readScope.transcript': 'Transcript',
        'readScope.unknown': 'Not stated',
        'annotation.title': 'Note {n}',
        'annotation.subtitle': '{count} sources · {module}',
        'annotation.open': 'Open note {n}',
        'annotation.label': 'Source note',
        'annotation.quote': 'Excerpt',
        'annotation.openChain': 'View evidence chain',
        'annotation.noQuote': 'No continuous passage was obtained; only the {scope} was read.',
        'annotation.locator': 'Locator',
        'annotation.readScope': 'Read scope',
        'annotation.retrievedAt': 'Retrieved',
        'annotation.identity': 'Identity',
        'annotation.sourceKind': 'Source nature',
        'annotation.sources': 'Sources',
        'annotation.usedBy': 'Used by',
        'annotation.usedSummary': 'What this is · one-line summary',
        'annotation.usedUnderstanding': 'What this is · {title}',
        'annotation.usedDiscussion': 'What people discuss · {title}',
        'annotation.usedClaim': 'Claim {id}',
        'annotation.usedJudgment': 'What we can establish · judgment',
        'annotation.usedQuestion': 'Question {id}',
        'annotation.usedOther': 'Other reference',
        'annotation.empty': 'This note could not be found.',
        'annotation.untitledBlock': 'Explained in parts',
        'annotation.untitledIssue': 'Discussion item',
        'annotation.sourceOpen': 'Source details',
        'annotation.unknownSource': 'Source information is missing',
        'sources.module': 'Filter',
        'sources.all': 'All',
        'sources.cited': 'Cited',
        'sources.uncited': 'Supplementary',
        'sources.sortByNumber': 'Sorted by note number',
        'sources.col.number': 'Note',
        'sources.col.author': 'Author',
        'sources.col.scope': 'Read scope',
        'sources.supplementary': 'Extra',
        'sources.citedNone': 'Not cited in text',
        'sources.emptyFilter': 'No sources match this filter.',
        'chain.claim': 'Claim',
        'chain.claims': 'Claims',
        'chain.judgment': 'Judgment',
        'chain.attribution': 'Attributed to',
        'chain.basis': 'Basis',
        'chain.open': 'Open',
        'chain.branch': 'Branch',
        'sourceDrawer.author': 'Author / institution',
        'sourceDrawer.publishedAt': 'Published',
        'sourceDrawer.retrievedAt': 'Retrieved',
        'sourceDrawer.locator': 'Locator',
        'sourceDrawer.readScope': 'Read scope',
        'sourceDrawer.annotations': 'Note positions',
        'sourceDrawer.otherUses': 'Other references',
        'sourceDrawer.supplementary': 'Not cited in text; kept as supplementary reading.',
        'sourceDrawer.usageEntity': 'Entity',

        'disputes.title': 'Disputes & unknowns',
        'disputes.hint': 'Conflicting claims, where the disagreement comes from, and what evidence is missing.',
        'disputes.origin': 'Origin',
        'disputes.missing': 'Missing',
        'disputes.ourRead': 'Our read',
        'disputes.holders': 'Holders',
        'disputes.evidence': 'Evidence',
        'disputes.unknowns': 'Unknowns',
        'disputes.unknownWhy': 'Why it matters',
        'disputes.unknownHow': 'How to close',
        'disputes.unknownQuestion': 'Question {id}',
        'disputes.empty': 'No disputes or unknowns.',

        'connections.title': 'Connections',
        'connections.hint': 'Cross-domain mechanisms; unsupported ones are marked as suggestions.',
        'connections.from': 'From {id}',
        'connections.to': 'To “{to}”',
        'connections.note': 'Note',
        'connections.empty': 'No connections.',
        'connectionKind.constraint': 'Constraint',
        'connectionKind.dependency': 'Dependency',
        'connectionKind.analogy': 'Analogy',
        'connectionKind.sameRoot': 'Same root',
        'connectionKind.counterweight': 'Counterweight',
        'connectionStatus.verified': 'Verified',
        'connectionStatus.suggested': 'Suggested',
        'connectionStatus.unverified': 'Unverified',

        'sources.title': 'Sources',
        'sources.hint': 'Click a row for summary, excerpt, and where it is cited.',
        'sources.col.title': 'Title',
        'sources.col.publisher': 'Publisher',
        'sources.col.date': 'Date',
        'sources.col.kind': 'Kind',
        'sources.col.independence': 'Independence',
        'sources.col.reliability': 'Reliability',
        'sources.col.used': 'Cited',
        'sources.usedCount': '{n}',
        'sources.empty': 'No sources.',
        'sources.openTip': 'Open source',

        'chain.title': 'Evidence chain',
        'chain.subtitle': 'Trace from topic to sources and gaps',
        'chain.theme': 'Topic',
        'chain.question': 'Question',
        'chain.conclusion': 'Conclusion',
        'chain.support': 'Supporting evidence',
        'chain.oppose': 'Opposing evidence',
        'chain.sources': 'Sources',
        'chain.gaps': 'Gaps',
        'chain.noConclusion': 'No conclusion for this question',
        'chain.noEvidence': 'No evidence',
        'chain.noGaps': 'No gaps recorded',
        'chain.openSource': 'View source',
        'chain.openQuestion': 'View question',
        'chain.current': 'Current',
        'chain.empty': 'Cannot assemble the chain: this reference is not in the dossier.',
        'chain.backToChain': 'Back to chain',
        'chain.conditions': 'Conditions',
        'chain.why': 'What it would change',

        'sourceDrawer.title': 'Source',
        'sourceDrawer.open': 'Open original',
        'sourceDrawer.quote': 'Key quote',
        'sourceDrawer.summary': 'Search summary',
        'sourceDrawer.excerpt': 'Reading excerpt',
        'sourceDrawer.used': 'Cited in',
        'sourceDrawer.emptyExcerpt': 'No page text was fetched.',
        'sourceDrawer.fetched': '{chars} chars fetched',
        'sourceDrawer.fetchFailed': 'Not fetched',
        'sourceDrawer.meta': '{publisher} · {date}',
        'sourceDrawer.independence': 'Independence',
        'sourceDrawer.reliability': 'Reliability',
        'sourceDrawer.kind': 'Kind',
        'sourceDrawer.none': 'No further information for this source.',
        'sourceDrawer.usageEvidence': 'Evidence {id} · Question {qid}',
        'sourceDrawer.usageConnection': 'Connection {id}',
        'sourceDrawer.usageTimeline': 'Timeline {id}',

        'ask.title': 'Ask a follow-up',
        'ask.subtitle': 'Add one question to “{title}”; the dossier updates when it finishes.',
        'ask.placeholder': 'What do you want to ask? e.g. What counterexamples exist?',
        'ask.recommended': 'Suggested questions',
        'ask.submit': 'Ask',
        'ask.submitting': 'Submitting…',
        'ask.keyboard': '⌘↵ to submit',
        'ask.cancel': 'Cancel',
        'ask.noFollowups': 'No suggestions yet. Write your own question.',
        'ask.started': 'Follow-up submitted; updating the dossier',
        'ask.prefill': 'Suggested question filled in',

        'settings.title': 'Settings',
        'settings.rootDir': 'Data directory',
        'settings.rootDirHint': 'Where dossiers and logs are stored. Leave empty for the default.',
        'settings.defaultDepth': 'Default depth',
        'settings.searchMode': 'Search provider',
        'settings.defaultSearchMode': 'Default search provider',
        'settings.activeSearchMode': 'Current search provider',
        'settings.searchMode.auto': 'Automatic',
        'settings.searchMode.account': 'DeepSeek account',
        'settings.searchMode.web': 'DSH web search',
        'settings.searchMode.api': 'DeepSeek API Key',
        'settings.searchMode.anysearch': 'AnySearch',
        'settings.anySearchKeyMissing': 'Configure an AnySearch API key to select this provider.',
        'anySearch.scope': 'Search domain',
        'anySearch.auto': 'Automatic',
        'anySearch.autoHint': 'AnySearch chooses sources for each query.',
        'anySearch.capability': 'Search type',
        'anySearch.chooseCapability': 'Choose a type',
        'anySearch.loading': 'Loading the search directory…',
        'anySearch.loadFailed': 'Could not load the AnySearch directory.',
        'anySearch.noCapabilities': 'No search types are available for this domain.',
        'anySearch.retry': 'Retry',
        'anySearch.params': 'Search parameters',
        'anySearch.optionalParams': 'Optional parameters',
        'anySearch.chooseToStart': 'Choose an AnySearch search type or set the domain to Automatic.',
        'anySearch.fillFields': 'Fill in: {fields}.',
        'anySearch.esports.description': 'Look up League of Legends players, rankings, champions, and items.',
        'anySearch.esports.type': 'Look up',
        'anySearch.esports.typeHint': 'Choose what to look up to see the relevant fields.',
        'anySearch.esports.player': 'Match history and ranked overview',
        'anySearch.esports.ranked': 'Ranked stats',
        'anySearch.esports.mastery': 'Champion mastery',
        'anySearch.esports.live_game': 'Live game',
        'anySearch.esports.match_detail': 'Single match details',
        'anySearch.esports.leaderboard': 'Ranked leaderboard',
        'anySearch.esports.champion': 'Champion details',
        'anySearch.esports.item': 'Item details',
        'anySearch.esports.champion_rotation': 'Current free champions',
        'anySearch.esports.championQuery': 'Enter a champion name, such as Yasuo, in the search box above.',
        'anySearch.esports.itemQuery': 'Enter an item name, such as Infinity Edge, in the search box above.',
        'anySearch.esports.region': 'Server',
        'anySearch.esports.regionHint': 'Enter a server code, such as kr for Korea, na for North America, or euw for Western Europe.',
        'anySearch.esports.rotationRegionHint': 'Enter a server code such as kr, or leave blank for North America.',
        'anySearch.esports.game_name': 'Riot ID',
        'anySearch.esports.game_nameHint': 'Include the name and # tag, for example Hide on Bush#KR1.',
        'anySearch.esports.match_id': 'Match ID',
        'anySearch.esports.match_idHint': 'Include the server prefix, for example KR_7482819248.',
        'anySearch.esports.queue': 'Ranked queue',
        'anySearch.esports.queueHint': 'Use RANKED_SOLO_5x5 for solo/duo, or RANKED_FLEX_SR for flex.',
        'anySearch.esports.tier': 'Rank tier',
        'anySearch.esports.tierHint': 'Enter a tier code such as DIAMOND, or leave blank for Challenger, Grandmaster, and Master.',
        'anySearch.esports.division': 'Division',
        'anySearch.esports.divisionHint': 'For Diamond through Iron, enter I, II, III, or IV. Defaults to I.',
        'anySearch.esports.championFilter': 'Champion name',
        'anySearch.esports.championHint': 'Filter by a name such as Yasuo, or leave blank for all champions.',
        'anySearch.records': 'AnySearch structured data',
        'anySearch.recordHint': 'AnySearch returned these records without links to cite.',
        'anySearch.domain.academic': 'Academic',
        'anySearch.domain.agriculture': 'Agriculture',
        'anySearch.domain.business': 'Business',
        'anySearch.domain.code': 'Code',
        'anySearch.domain.energy': 'Energy',
        'anySearch.domain.environment': 'Environment',
        'anySearch.domain.film': 'Film and music',
        'anySearch.domain.finance': 'Finance',
        'anySearch.domain.gaming': 'Gaming',
        'anySearch.domain.general': 'General web',
        'anySearch.domain.health': 'Health',
        'anySearch.domain.ip': 'Intellectual property',
        'anySearch.domain.legal': 'Legal',
        'anySearch.domain.resource': 'Images',
        'anySearch.domain.security': 'Cybersecurity',
        'anySearch.domain.social_media': 'Social media',
        'anySearch.domain.travel': 'Travel',
        'anySearch.tag.academic.citation': 'Citations and identifiers',
        'anySearch.tag.academic.dataset': 'Research datasets',
        'anySearch.tag.academic.paper': 'Academic papers',
        'anySearch.tag.academic.person': 'Researchers',
        'anySearch.tag.agriculture.fao': 'FAO statistics',
        'anySearch.tag.business.company': 'Companies and filings',
        'anySearch.tag.business.jobs': 'Job listings',
        'anySearch.tag.business.people': 'Business contacts',
        'anySearch.tag.business.trade': 'International trade',
        'anySearch.tag.code.doc': 'Developer documentation',
        'anySearch.tag.code.snippet': 'Code snippets',
        'anySearch.tag.energy.electricity': 'Electricity markets',
        'anySearch.tag.energy.production': 'Energy statistics',
        'anySearch.tag.environment.aqi': 'Air quality',
        'anySearch.tag.film.torrent': 'Film and music torrents',
        'anySearch.tag.finance.calendar': 'Financial calendar',
        'anySearch.tag.finance.fundamental': 'Fundamentals',
        'anySearch.tag.finance.macro': 'Macroeconomic data',
        'anySearch.tag.finance.news': 'Financial news',
        'anySearch.tag.finance.quote': 'Market quotes',
        'anySearch.tag.finance.screen': 'Asset screening',
        'anySearch.tag.gaming.esports': 'Esports data',
        'anySearch.tag.gaming.store': 'Steam store',
        'anySearch.tag.general.general': 'General web',
        'anySearch.tag.health.drug': 'Drug information',
        'anySearch.tag.health.stats': 'Public health statistics',
        'anySearch.tag.health.trial': 'Clinical trials',
        'anySearch.tag.ip.global': 'Global patents',
        'anySearch.tag.legal.enforcement': 'Enforcement actions',
        'anySearch.tag.legal.judicial': 'Court cases',
        'anySearch.tag.legal.legislation': 'Legislation',
        'anySearch.tag.resource.image': 'Images',
        'anySearch.tag.security.intel': 'Threat intelligence',
        'anySearch.tag.security.noise': 'Background traffic',
        'anySearch.tag.security.scan': 'Malware scanning',
        'anySearch.tag.security.vuln': 'Vulnerability records',
        'anySearch.tag.social_media.social_media': 'Social media content',
        'anySearch.tag.travel.flight': 'Flight tickets',
        'anySearch.tag.travel.flight_status': 'Flight status',
        'settings.model': 'Model route',
        'settings.version': 'Version',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Settings saved',
        'settings.cancel': 'Cancel',
        'settings.unavailable': 'Settings unavailable',
        'settings.healthFailed': 'Cannot read runtime status',

        'notice.created': 'Research started',
        'notice.askStarted': 'Follow-up submitted',
        'notice.done': 'Research finished',
        'notice.partial': 'Research finished; some questions did not complete',
        'notice.failed': 'Research failed',
        'notice.canceled': 'Job canceled',
        'notice.refreshed': 'Dossier updated',
        'notice.copied': 'Copied',

        'error.loadTopics': 'Could not load dossiers: {message}',
        'error.loadTopic': 'Could not load the dossier: {message}',
        'error.loadSettings': 'Could not load settings: {message}',
        'error.loadHealth': 'Could not read runtime status: {message}',
        'error.start': 'Could not start research: {message}',
        'error.ask': 'Could not submit the follow-up: {message}',
        'error.export': 'Export failed: {message}',
        'error.delete': 'Delete failed: {message}',
        'error.refresh': 'Refresh failed: {message}',
        'error.cancel': 'Cancel failed: {message}',
        'error.saveSettings': 'Save failed: {message}',
        'error.network': 'Network unavailable',
        'error.badResponse': 'Unexpected response shape',
        'error.requestFailed': 'Request failed',
        'error.jobPoll': 'Could not read job progress: {message}',
        'error.routeHint': 'The host route may not be ready yet; refresh the page and retry.',

        'crash.title': 'The panel crashed',
        'crash.hint': 'Reopen the panel; if it keeps failing, check the browser console.',

        'time.justNow': 'just now',
        'time.minutesAgo': '{n} min ago',
        'time.hoursAgo': '{n} h ago',
        'time.daysAgo': '{n} d ago',
        'time.minutes': '{n} min',
        'time.seconds': '{n} s',
      }

      /**
       * 生成字典绑定函数：缺 key 时向 fallback 字典回退，最后回退 key 本身。
       * @param {Record<string,string>} dict 主字典。
       * @param {Record<string,string>} fallback 回退字典。
       * @param {string} [prefix] key 前缀（locale 命名空间）。
       * @returns {(key: string, vars?: Record<string, any>) => string}
       */
      function makeT(dict, fallback, prefix) {
        const scope = prefix ? prefix + '.' : ''
        return function (key, vars) {
          const full = scope + key
          let text = dict[full]
          if (text == null) text = fallback[full]
          if (text == null) text = key
          if (vars && typeof text === 'string') {
            for (const name in vars) {
              if (!Object.prototype.hasOwnProperty.call(vars, name)) continue
              text = text.split('{' + name + '}').join(String(vars[name]))
            }
          }
          return text
        }
      }
      /** 非组件路径的默认翻译（中文优先，缺 key 回退 key）。 */
      const fallbackT = makeT(zh, en)
      /**
       * 非组件 helper 使用的翻译函数：优先当前 locale 绑定。
       * @param {string} key 文案 key。
       * @param {Record<string, any>} [vars] 插值变量。
       * @returns {string}
       */
      function tr(key, vars) {
        return (runtimeT || fallbackT)(key, vars)
      }

      // ======================================================================
      // 通用工具（字符串 / 数字 / 时间 / URL）
      // ======================================================================

      /** 安全字符串。 @param {any} value 任意值。 @returns {string} */
      function asString(value) {
        return typeof value === 'string' ? value : value == null ? '' : String(value)
      }

      /** 安全数组。 @param {any} value 任意值。 @returns {any[]} */
      function asArray(value) {
        return Array.isArray(value) ? value : []
      }

      /** 安全对象。 @param {any} value 任意值。 @returns {any} */
      function asObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      }

      /** 安全数字。 @param {any} value 任意值。 @param {number} [fallback] 回退。 @returns {number} */
      function asNumber(value, fallback) {
        const n = typeof value === 'number' ? value : Number(value)
        return Number.isFinite(n) ? n : typeof fallback === 'number' ? fallback : 0
      }

      /** 文本裁剪（按字符）。 @param {string} text 文本。 @param {number} max 上限。 @returns {string} */
      function truncate(text, max) {
        const source = asString(text)
        if (source.length <= max) return source
        return source.slice(0, max).trim() + '…'
      }

      /**
       * 错误对象 → 可展示文本。
       * @param {any} error 异常。
       * @param {string} fallback 回退文案。
       * @returns {string}
       */
      function errorMessage(error, fallback) {
        if (error && typeof error.message === 'string' && error.message) return error.message
        if (typeof error === 'string' && error) return error
        return fallback || tr('error.requestFailed')
      }

      /** 是否 AbortError（取消不算错误）。 @param {any} error 异常。 @returns {boolean} */
      function isAbort(error) {
        return !!(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'))
      }

      /** 数字补零。 @param {number} n 数字。 @returns {string} */
      function pad2(n) {
        return n < 10 ? '0' + n : String(n)
      }

      /**
       * ISO 时间 → YYYY-MM-DD（本地时区）。
       * @param {string} value ISO 字符串。
       * @returns {string}
       */
      function formatDate(value) {
        const time = Date.parse(asString(value))
        if (!Number.isFinite(time)) return ''
        const date = new Date(time)
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      }

      /**
       * ISO 时间 → YYYY-MM-DD HH:mm（本地时区）。
       * @param {string} value ISO 字符串。
       * @returns {string}
       */
      function formatDateTime(value) {
        const time = Date.parse(asString(value))
        if (!Number.isFinite(time)) return ''
        const date = new Date(time)
        return formatDate(value) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      }

      /**
       * 毫秒 → 可读时长（中文/英文单位来自字典）。
       * @param {any} ms 毫秒。
       * @returns {string}
       */
      function formatDuration(ms) {
        const value = asNumber(ms, 0)
        if (!value) return '—'
        if (value < 60000) return tr('time.seconds', { n: Math.round(value / 1000) })
        return tr('time.minutes', { n: Math.max(1, Math.round(value / 60000)) })
      }

      /**
       * 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）。
       * @param {string} value ISO 时间。
       * @returns {string}
       */
      function relativeTime(value) {
        const time = Date.parse(asString(value))
        if (!Number.isFinite(time)) return ''
        const diff = Date.now() - time
        if (diff < 60000) return tr('time.justNow')
        if (diff < 3600000) return tr('time.minutesAgo', { n: Math.floor(diff / 60000) })
        if (diff < 86400000) return tr('time.hoursAgo', { n: Math.floor(diff / 3600000) })
        return tr('time.daysAgo', { n: Math.floor(diff / 86400000) })
      }

      /**
       * 档案列表分组：今天 / 本周 / 更早。
       * @param {string} value ISO 时间。
       * @returns {'today'|'week'|'earlier'}
       */
      function dayBucket(value) {
        const time = Date.parse(asString(value))
        if (!Number.isFinite(time)) return 'earlier'
        const now = new Date()
        const then = new Date(time)
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        if (time >= startOfToday) return 'today'
        if (time >= startOfToday - 6 * 86400000) return 'week'
        return 'earlier'
      }

      /**
       * 只放行 http(s) / mailto 链接，避免把 javascript: 等协议塞进 UI。
       * @param {string} raw 原始链接。
       * @returns {string | null}
       */
      function safeHref(raw) {
        const text = asString(raw).trim()
        if (!text) return null
        if (/^(https?:|mailto:)/i.test(text)) return text
        return null
      }

      /** 域名提取。 @param {string} url 链接。 @returns {string} */
      function hostOf(url) {
        const text = asString(url)
        const match = /^https?:\/\/([^/?#]+)/i.exec(text)
        return match ? match[1] : ''
      }

      /** 生成稳定的 DOM id（用于锚点）。 @param {string} prefix 前缀。 @param {string} id 标识。 @returns {string} */
      function domId(prefix, id) {
        return 'ds-' + prefix + '-' + asString(id).replace(/[^a-zA-Z0-9_-]/g, '-')
      }

      /**
       * 由证据/来源推导独立信源数（宿主已计算时优先用宿主的）。
       * @param {any} evidence 证据。
       * @param {any} sourceById 来源索引。
       * @returns {number}
       */
      function independentCount(evidence, sourceById) {
        if (typeof evidence.independentSources === 'number') return evidence.independentSources
        const seen = {}
        let count = 0
        for (const sourceId of asArray(evidence.sourceIds)) {
          const source = sourceById[sourceId]
          if (!source) continue
          const key = asString(source.canonicalUrl) || asString(source.url) || sourceId
          if (seen[key]) continue
          seen[key] = true
          count += 1
        }
        return count
      }

      // ======================================================================
      // Markdown 渲染（返回 React 元素，绝不注入 HTML 字符串）
      // 支持：**粗体**、*斜体*、`行内代码`、[文字](url)、段落与单换行。
      // 档案里的 brief / mechanism 只用到这些语法；标题与列表不作为正文输出。
      // ======================================================================
      const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g

      /**
       * 渲染一段行内 Markdown。
       * @param {string} text 原文。
       * @param {string} keyPrefix React key 前缀。
       * @returns {any[]} React 子节点。
       */
      function renderInline(text, keyPrefix) {
        const source = asString(text)
        if (!source) return []
        const nodes = []
        let lastIndex = 0
        let match
        let tokenIndex = 0
        INLINE_PATTERN.lastIndex = 0
        while ((match = INLINE_PATTERN.exec(source)) !== null) {
          if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index))
          const token = match[0]
          const key = keyPrefix + '-i' + tokenIndex
          tokenIndex += 1
          if (token.slice(0, 2) === '**') {
            nodes.push(h('strong', { key: key }, token.slice(2, -2)))
          } else if (token.charAt(0) === '`') {
            nodes.push(h('code', { key: key, className: 'ds-inline-code' }, token.slice(1, -1)))
          } else if (token.charAt(0) === '[') {
            const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
            const href = link ? safeHref(link[2]) : null
            if (link && href) {
              nodes.push(h('a', { key: key, href: href, target: '_blank', rel: 'noreferrer noopener' }, link[1]))
            } else {
              nodes.push(token)
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
       * 渲染多段文本（空行分段，单换行 <br>）。
       * @param {string} source Markdown 源文本。
       * @param {string} keyPrefix React key 前缀。
       * @returns {any[]} 段落节点。
       */
      function renderMarkdown(source, keyPrefix) {
        const text = asString(source).replace(/\r\n?/g, '\n').trim()
        if (!text) return []
        const blocks = text.split(/\n{2,}/)
        const nodes = []
        for (let index = 0; index < blocks.length; index += 1) {
          const lines = blocks[index].split('\n')
          const children = []
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            if (lineIndex > 0) children.push(h('br', { key: keyPrefix + '-p' + index + '-br' + lineIndex }))
            const inline = renderInline(lines[lineIndex], keyPrefix + '-p' + index + '-l' + lineIndex)
            for (let nodeIndex = 0; nodeIndex < inline.length; nodeIndex += 1) children.push(inline[nodeIndex])
          }
          nodes.push(h('p', { key: keyPrefix + '-p' + index, className: 'ds-prose-p' }, children))
        }
        return nodes
      }

      /**
       * Markdown 渲染组件。
       * @param {{ source: string, className?: string }} props 属性。
       * @returns {any}
       */
      function MarkdownBlock(props) {
        const nodes = useMemo(function () {
          return renderMarkdown(props.source, 'md')
        }, [props.source])
        return h('div', { className: props.className ? 'ds-prose ' + props.className : 'ds-prose' }, nodes)
      }

      // ======================================================================
      // Host API（统一同源 JSON；非 2xx 归一为 ApiError{code,message}）
      // ======================================================================
      /** Host API 错误。 */
      class ApiError extends Error {
        /**
         * @param {string} message 可展示信息。
         * @param {string} code 错误码。
         * @param {number} status HTTP 状态。
         */
        constructor(message, code, status) {
          super(message)
          this.name = 'ApiError'
          this.code = code || 'INTERNAL'
          this.status = typeof status === 'number' ? status : 0
        }
      }

      /** 进行中的 AbortController 集合（卸载 / 切换时统一 abort）。 */
      const inflight = new Set()

      /**
       * 调用 Host 接口。GET 带 no-store；写请求自动 JSON 序列化。
       * @param {string} path 以 / 开头的路由（如 '/topics'）。
       * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] 选项。
       * @returns {Promise<any>} 解析后的 JSON（{ok:true,...}）。
       */
      async function requestJson(base, path, options) {
        const opts = options || {}
        const method = opts.method || 'GET'
        const controller = new AbortController()
        const external = opts.signal
        const onAbort = function () {
          controller.abort()
        }
        if (external) {
          if (external.aborted) controller.abort()
          else external.addEventListener('abort', onAbort)
        }
        inflight.add(controller)
        const init = {
          method: method,
          signal: controller.signal,
          cache: 'no-store',
          headers: { accept: 'application/json' },
        }
        if (opts.body !== undefined) {
          init.headers['content-type'] = 'application/json'
          init.body = JSON.stringify(opts.body)
        }
        let response
        try {
          response = await fetch(base + path, init)
        } catch (error) {
          if (isAbort(error)) throw error
          throw new ApiError(tr('error.network'), 'NETWORK', 0)
        } finally {
          inflight.delete(controller)
          if (external) external.removeEventListener('abort', onAbort)
        }
        let data = null
        try {
          data = await response.json()
        } catch (error) {
          if (isAbort(error)) throw error
          data = null
        }
        if (!response.ok) {
          const detail = data && data.error ? data.error : null
          throw new ApiError(
            detail && asString(detail.message) ? asString(detail.message) : 'HTTP ' + response.status,
            detail && asString(detail.code) ? asString(detail.code) : 'HTTP_' + response.status,
            response.status,
          )
        }
        if (data && data.ok === false) {
          const detail = data.error || {}
          throw new ApiError(
            asString(detail.message) || tr('error.requestFailed'),
            asString(detail.code) || 'INTERNAL',
            response.status,
          )
        }
        if (!data || typeof data !== 'object') {
          throw new ApiError(tr('error.badResponse'), 'BAD_RESPONSE', response.status)
        }
        return data
      }

      /**
       * 调用 AI 大搜索 Host 接口（路由前缀 ORIGIN）。
       * @param {string} path 以 / 开头的路由。
       * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] 选项。
       * @returns {Promise<any>}
       */
      function api(path, options) {
        return requestJson(ORIGIN, path, options)
      }

      /**
       * 调用知识库 Host 接口（同源，前缀 /dsh-kb）。
       * @param {string} path 以 / 开头的路由。
       * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] 选项。
       * @returns {Promise<any>}
       */
      function kbApi(path, options) {
        return requestJson(KB_ORIGIN, path, options)
      }

      /**
       * 只读拉取，失败归一为 { ok:false, error }。
       * @param {string} path 路由。
       * @param {{ signal?: AbortSignal }} [options] 选项。
       * @returns {Promise<any>}
       */
      async function apiSafe(path, options) {
        try {
          const data = await api(path, options)
          return { ok: true, data: data }
        } catch (error) {
          if (isAbort(error)) throw error
          return {
            ok: false,
            error: {
              code: error && error.code ? error.code : 'INTERNAL',
              message: errorMessage(error, tr('error.requestFailed')),
            },
          }
        }
      }

      /** abort 所有进行中的请求（卸载时调用）。 */
      abortAll = function () {
        for (const controller of Array.from(inflight)) {
          try {
            controller.abort()
          } catch (error) {
            /* ignore */
          }
        }
        inflight.clear()
      }

      // ======================================================================
      // 图标（自绘 SVG，stroke / fill 用 currentColor，不依赖图标包）
      // ======================================================================
      /**
       * 统一规格的线性图标。
       * @param {{ name: string, size?: number, strokeWidth?: number, className?: string }} props 属性。
       * @returns {any}
       */
      function Icon(props) {
        const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
        const strokeWidth = typeof props.strokeWidth === 'number' ? props.strokeWidth : 1.7
        const name = asString(props.name)
        const children = []
        const add = function (key, tag, attrs) {
          children.push(h(tag, Object.assign({ key: key }, attrs)))
        }
        if (name === 'search') {
          add('circle', 'circle', { cx: 10.5, cy: 10.5, r: 5.8 })
          add('line', 'path', { d: 'M15 15l4.6 4.6' })
        } else if (name === 'plus') {
          add('v', 'path', { d: 'M12 5v14' })
          add('h', 'path', { d: 'M5 12h14' })
        } else if (name === 'close') {
          add('a', 'path', { d: 'M6 6l12 12' })
          add('b', 'path', { d: 'M18 6 6 18' })
        } else if (name === 'chevron-down') {
          add('a', 'path', { d: 'm6 9 6 6 6-6' })
        } else if (name === 'chevron-right') {
          add('a', 'path', { d: 'm9 6 6 6-6 6' })
        } else if (name === 'arrow-left') {
          add('a', 'path', { d: 'M19 12H5' })
          add('b', 'path', { d: 'm11 6-6 6 6 6' })
        } else if (name === 'arrow-right') {
          add('a', 'path', { d: 'M5 12h14' })
          add('b', 'path', { d: 'm13 6 6 6-6 6' })
        } else if (name === 'menu') {
          add('a', 'path', { d: 'M4 7h16' })
          add('b', 'path', { d: 'M4 12h16' })
          add('c', 'path', { d: 'M4 17h16' })
        } else if (name === 'settings') {
          add('a', 'path', { d: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z' })
          add('b', 'path', { d: 'M19.4 13.5c.1-.5.1-1 0-1.5l1.7-1.3-1.7-3-2 .8c-.4-.3-.9-.6-1.4-.8l-.3-2.1h-3.4l-.3 2.1c-.5.2-1 .5-1.4.8l-2-.8-1.7 3L7.6 12c-.1.5-.1 1 0 1.5l-1.7 1.3 1.7 3 2-.8c.4.3.9.6 1.4.8l.3 2.1h3.4l.3-2.1c.5-.2 1-.5 1.4-.8l2 .8 1.7-3-1.7-1.3Z' })
        } else if (name === 'trash') {
          add('a', 'path', { d: 'M4 7h16' })
          add('b', 'path', { d: 'M9 7V5h6v2' })
          add('c', 'path', { d: 'M6 7l1 13h10l1-13' })
          add('d', 'path', { d: 'M10 11v5M14 11v5' })
        } else if (name === 'refresh') {
          add('a', 'path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' })
          add('b', 'path', { d: 'M20 4v4h-4' })
        } else if (name === 'download') {
          add('a', 'path', { d: 'M12 4v11' })
          add('b', 'path', { d: 'm8 11 4 4 4-4' })
          add('c', 'path', { d: 'M5 19h14' })
        } else if (name === 'ask') {
          add('a', 'path', { d: 'M4 5.8A1.8 1.8 0 0 1 5.8 4h12.4A1.8 1.8 0 0 1 20 5.8v8.4a1.8 1.8 0 0 1-1.8 1.8H9l-5 4V5.8Z' })
          add('b', 'path', { d: 'M8.5 10h7' })
        } else if (name === 'external') {
          add('a', 'path', { d: 'M14 4h6v6' })
          add('b', 'path', { d: 'M20 4 10 14' })
          add('c', 'path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' })
        } else if (name === 'check') {
          add('a', 'path', { d: 'm5 12.5 4.5 4.5L19 7.5' })
        } else if (name === 'alert') {
          add('a', 'path', { d: 'M12 4 3.2 20h17.6L12 4Z' })
          add('b', 'path', { d: 'M12 10v4.5' })
          add('c', 'path', { d: 'M12 17.4v.1' })
        } else if (name === 'clock') {
          add('a', 'circle', { cx: 12, cy: 12, r: 8 })
          add('b', 'path', { d: 'M12 7.5V12l3 1.8' })
        } else if (name === 'book') {
          add('a', 'path', { d: 'M4.5 5.5A1.5 1.5 0 0 1 6 4h5v16H6a1.5 1.5 0 0 1-1.5-1.5v-13Z' })
          add('b', 'path', { d: 'M19.5 5.5A1.5 1.5 0 0 0 18 4h-5v16h5a1.5 1.5 0 0 0 1.5-1.5v-13Z' })
          add('c', 'path', { d: 'M11 4v16' })
        } else if (name === 'link') {
          add('a', 'path', { d: 'M10.5 13.5 13.5 10.5' })
          add('b', 'path', { d: 'M8.6 15.4 6.8 17.2a3.4 3.4 0 0 1-4.8-4.8l3-3a3.4 3.4 0 0 1 4.8 0' })
          add('c', 'path', { d: 'M15.4 8.6l1.8-1.8a3.4 3.4 0 0 1 4.8 4.8l-3 3a3.4 3.4 0 0 1-4.8 0' })
        } else if (name === 'spark') {
          add('a', 'path', { d: 'M12 3.5c.8 4.4 1.6 5.2 6 6-4.4.8-5.2 1.6-6 6-.8-4.4-1.6-5.2-6-6 4.4-.8 5.2-1.6 6-6Z' })
        } else if (name === 'folder') {
          add('a', 'path', { d: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h7.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-10Z' })
        } else if (name === 'dots') {
          add('a', 'circle', { cx: 6, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' })
          add('b', 'circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' })
          add('c', 'circle', { cx: 18, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' })
        }
        return h(
          'svg',
          {
            className: props.className ? 'ds-icon ' + props.className : 'ds-icon',
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: strokeWidth,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          children,
        )
      }

      /**
       * 侧栏入口图标（sidebar.panellist）：档案页 + 放大镜 + 证据点。
       * @param {{ size?: number, active?: boolean }} [props] 属性。
       * @returns {any}
       */
      function DeepSearchIcon(props) {
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
          h('path', { key: 'page', d: 'M6 3.8h7.6L18 8.2v11.2a1.6 1.6 0 0 1-1.6 1.6H7.6A1.6 1.6 0 0 1 6 19.4V5.4A1.6 1.6 0 0 1 7.6 3.8Z' }),
          h('path', { key: 'fold', d: 'M13.4 3.9v4.4h4.4' }),
          h('path', { key: 'lines', d: 'M9 11.4h3.2M9 14.2h2.4' }),
          h('circle', { key: 'lens', cx: 15.2, cy: 14.6, r: 2.9 }),
          h('path', { key: 'handle', d: 'm17.4 16.8 2.1 2.1' }),
          h('circle', { key: 'dot', cx: 10.1, cy: 18.4, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        )
      }

      // ======================================================================
      // 面板渲染异常兜底（组件抛错时不让整个 slot entry 变白）
      // ======================================================================
      class DsErrorBoundary extends React.Component {
        /**
         * @param {any} props 属性（title / hint / children）。
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
            console.warn('[dsh-deep-search] 面板渲染异常：' + errorMessage(error, 'unknown'))
          }
        }

        /** @returns {any} 界面。 */
        render() {
          if (!this.state.failed) return this.props.children
          return h(
            'div',
            { className: 'ds-root' },
            h('style', { key: 'ds-style-crash' }, DS_CSS),
            h(
              'div',
              { className: 'ds-crash', key: 'crash' },
              h('span', { className: 'ds-crash-icon' }, h(Icon, { name: 'alert', size: 24 })),
              h('p', { className: 'ds-crash-title' }, this.props.title),
              h('p', { className: 'ds-crash-hint' }, this.props.hint),
            ),
          )
        }
      }

      // ======================================================================
      // 展示原子组件
      // ======================================================================

      /**
       * 身份徽章（事实=绿 / 声称=琥珀 / 分析=蓝 / 未知=灰）。
       * @param {{ identity?: string }} props 属性。
       * @returns {any}
       */
      function IdentityBadge(props) {
        const identity = asString(props.identity) || 'unknown'
        const key = IDENTITY_KEYS[identity]
        return h('span', { className: 'ds-badge ds-identity', 'data-identity': identity }, key ? tr(key) : identity)
      }

      /**
       * 置信度徽章。
       * @param {{ confidence?: string, withLabel?: boolean }} props 属性。
       * @returns {any}
       */
      function ConfidenceBadge(props) {
        const confidence = asString(props.confidence)
        if (!confidence) return null
        const key = CONFIDENCE_KEYS[confidence]
        const label = key ? tr(key) : confidence
        return h(
          'span',
          { className: 'ds-badge ds-confidence', 'data-level': confidence, title: label },
          label,
        )
      }

      /**
       * 通用小标签。
       * @param {{ children?: any, tone?: string, className?: string, title?: string }} props 属性。
       * @returns {any}
       */
      function Chip(props) {
        const className = 'ds-chip' + (props.tone ? ' ds-chip-' + props.tone : '') + (props.className ? ' ' + props.className : '')
        return h('span', { className: className, title: props.title }, props.children)
      }

      /**
       * 可点击的文本按钮（用于卡片内跳转）。
       * @param {{ onClick: Function, children?: any, className?: string, title?: string, ariaLabel?: string }} props 属性。
       * @returns {any}
       */
      function TextButton(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'ds-linkbtn' + (props.className ? ' ' + props.className : ''),
            onClick: props.onClick,
            title: props.title,
            'aria-label': props.ariaLabel,
          },
          props.children,
        )
      }

      /**
       * 来源 chip：点击打开来源抽屉。
       * @param {{ source: any, onOpen: Function, compact?: boolean }} props 属性。
       * @returns {any}
       */
      function SourceChip(props) {
        const source = props.source
        if (!source) return null
        const label = asString(source.publisher) || hostOf(source.url) || asString(source.id)
        return h(
          'button',
          {
            type: 'button',
            className: 'ds-source-chip',
            title: (asString(source.title) || label) + (asString(source.id) ? ' · ' + source.id : ''),
            onClick: function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              props.onOpen(asString(source.id))
            },
          },
          h('span', { className: 'ds-source-chip-dot', 'data-independence': asString(source.independence) || 'unknown' }),
          h('span', { className: 'ds-source-chip-label' }, label),
          source.id ? h('span', { className: 'ds-source-chip-id' }, source.id) : null,
        )
      }

      /**
       * 加载态骨架。
       * @param {{ rows?: number, label?: string }} props 属性。
       * @returns {any}
       */
      function LoadingBlock(props) {
        const rows = Math.max(1, Math.min(6, asNumber(props.rows, 3)))
        const items = []
        for (let index = 0; index < rows; index += 1) {
          items.push(h('div', { key: 'sk' + index, className: 'ds-skeleton-row', style: { width: 100 - index * 12 + '%' } }))
        }
        return h(
          'div',
          { className: 'ds-loading', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'ds-spinner' }),
          h('span', { className: 'ds-loading-label' }, props.label || tr('status.loading')),
          h('div', { className: 'ds-skeleton' }, items),
        )
      }

      /**
       * 错误块（带重试）。
       * @param {{ text?: string, hint?: string, onRetry?: Function, retryLabel?: string }} props 属性。
       * @returns {any}
       */
      function ErrorBlock(props) {
        return h(
          'div',
          { className: 'ds-errorblock', role: 'alert' },
          h('div', { className: 'ds-errorblock-head' }, h(Icon, { name: 'alert', size: 16 }), h('span', null, props.text || tr('error.requestFailed'))),
          props.hint ? h('p', { className: 'ds-errorblock-hint' }, props.hint) : null,
          props.onRetry
            ? h(
                'button',
                { type: 'button', className: 'ds-btn ds-btn-sm', onClick: props.onRetry },
                h(Icon, { name: 'refresh', size: 14 }),
                h('span', null, props.retryLabel || tr('status.retry')),
              )
            : null,
        )
      }

      // DS_CSS / 其余组件在后续片段中定义（见文件末尾）。

      // ======================================================================
      // 档案视图模型（Archive v2：全局 claims / evidence + 六模块索引）
      // 不 import 服务端模块：注释索引在本地同构生成，保证编号与阅读顺序一致。
      // ======================================================================

      /**
       * 由证据推导论断的证据状态（宿主已计算时优先用宿主的）。
       * @param {any} claim 论断。
       * @param {Record<string, any>} evidenceById 证据索引。
       * @returns {string} supported | limited | conflicted | unsupported。
       */
      function deriveEvidenceStatus(claim, evidenceById) {
        const support = asArray(claim && claim.evidenceIds).filter(function (id) {
          return !!evidenceById[asString(id)]
        })
        const oppose = asArray(claim && claim.opposeEvidenceIds).filter(function (id) {
          return !!evidenceById[asString(id)]
        })
        if (support.length === 0 && oppose.length === 0) return 'unsupported'
        if (oppose.length > 0) return 'conflicted'
        let allSingle = true
        for (const id of support) {
          if (asString(asObject(evidenceById[asString(id)]).strength) !== 'single-source') allSingle = false
        }
        return support.length <= 1 || allSingle ? 'limited' : 'supported'
      }

      /**
       * 本地注释索引：understanding blocks → discussion items → questions claims → judgments。
       * 同一 evidence 只编号一次，按阅读顺序递增；source 与 evidence 可一对多。
       * @param {any} model 归一后的档案模块。
       * @returns {any} {entries, byEvidenceId, bySourceId, byNumber, claimNumbers, ...}。
       */
      function buildAnnotationIndex(model) {
        const entries = []
        const byEvidenceId = {}
        const byNumber = {}
        const bySourceId = {}
        const claimNumbers = {}
        const judgmentNumbers = {}
        const blockNumbers = {}
        const itemNumbers = {}
        const sideNumbers = {}
        const questionNumbers = {}
        let summaryNumbers = []
        const evidenceById = model.evidenceById
        const claimById = model.claimById
        const sourceById = model.sourceById

        /**
         * 登记一条证据（首次出现时分配编号，之后只补 usedBy）。
         * @param {string} rawId 证据 id。
         * @param {any} usage 使用位置。
         * @returns {any | null} 注释条目。
         */
        function ensure(rawId, usage) {
          const id = asString(rawId)
          const evidence = evidenceById[id]
          if (!evidence) return null
          let entry = byEvidenceId[id]
          if (!entry) {
            const sourceIds = []
            for (const sourceId of asArray(evidence.sourceIds)) {
              const sid = asString(sourceId)
              if (!sid || !sourceById[sid] || sourceIds.indexOf(sid) >= 0) continue
              sourceIds.push(sid)
            }
            entry = {
              number: entries.length + 1,
              evidenceId: id,
              sourceIds: sourceIds,
              locator: asString(evidence.locator),
              readScope: asString(evidence.readScope),
              quote: asString(evidence.quote),
              text: asString(evidence.text),
              identity: asString(evidence.identity) || 'analysis',
              stance: asString(evidence.stance) || 'support',
              module: asString(evidence.module) || (usage && usage.module) || 'question',
              questionId: asString(evidence.questionId) || (usage && usage.questionId) || '',
              retrievedAt: asString(evidence.retrievedAt),
              usedBy: [],
            }
            entries.push(entry)
            byEvidenceId[id] = entry
            byNumber[entry.number] = entry
            for (const sid of sourceIds) {
              if (!bySourceId[sid]) bySourceId[sid] = []
              bySourceId[sid].push({ number: entry.number, evidenceId: id })
            }
          }
          if (usage) {
            const key = usage.kind + ':' + asString(usage.id)
            let exists = false
            for (const used of entry.usedBy) {
              if (used.key === key) {
                exists = true
                break
              }
            }
            if (!exists) {
              entry.usedBy.push({
                key: key,
                kind: usage.kind,
                id: asString(usage.id),
                title: asString(usage.title),
                module: asString(usage.module) || entry.module,
                questionId: asString(usage.questionId) || entry.questionId,
                claimId: asString(usage.claimId),
              })
            }
          }
          return entry
        }

        /**
         * 把一组证据登记到某个使用位置，返回编号列表。
         * @param {any[]} evidenceIds 证据 id 列表。
         * @param {any} usage 使用位置。
         * @returns {number[]}
         */
        function noteList(evidenceIds, usage) {
          const numbers = []
          for (const evidenceId of asArray(evidenceIds)) {
            const entry = ensure(evidenceId, usage)
            if (entry && numbers.indexOf(entry.number) < 0) numbers.push(entry.number)
          }
          return numbers
        }

        /**
         * 论断绑定的全部证据编号。
         * @param {any} claim 论断。
         * @param {any} usage 使用位置。
         * @returns {number[]}
         */
        function claimNotes(claim, usage) {
          const ids = asArray(claim.evidenceIds).concat(asArray(claim.opposeEvidenceIds))
          return noteList(ids, usage)
        }

        // 00 一句话解释（summary）先编号：understanding.summaryClaimIds / summaryEvidenceIds
        if (model.summary) {
          const summaryUsage = {
            kind: 'summary',
            id: 'summary',
            title: asString(model.summary.text),
            module: 'understanding',
          }
          for (const claimId of asArray(model.summary.claimIds)) {
            const claim = claimById[asString(claimId)]
            if (!claim) continue
            for (const number of claimNotes(claim, summaryUsage)) {
              if (summaryNumbers.indexOf(number) < 0) summaryNumbers.push(number)
            }
          }
          for (const number of noteList(model.summary.evidenceIds, summaryUsage)) {
            if (summaryNumbers.indexOf(number) < 0) summaryNumbers.push(number)
          }
        }

        // 01 这是什么：分块
        for (const block of asArray(model.blocks)) {
          const usage = {
            kind: 'block',
            id: asString(block.id),
            title: asString(block.title),
            module: 'understanding',
          }
          if (!blockNumbers[asString(block.id)]) blockNumbers[asString(block.id)] = []
          const numbers = blockNumbers[asString(block.id)]
          for (const claimId of asArray(block.claimIds)) {
            const claim = claimById[asString(claimId)]
            if (!claim) continue
            for (const number of claimNotes(claim, usage)) {
              if (numbers.indexOf(number) < 0) numbers.push(number)
            }
          }
          for (const number of noteList(block.evidenceIds, usage)) {
            if (numbers.indexOf(number) < 0) numbers.push(number)
          }
        }

        // 02 大家在讨论什么：议题讨论项 / 立场
        for (const issue of asArray(model.discussion.issues)) {
          for (const item of asArray(issue.items)) {
            const usage = {
              kind: 'item',
              id: asString(item.id),
              title: asString(issue.question),
              module: 'discussion',
            }
            const numbers = []
            for (const claimId of asArray(item.claimIds)) {
              const claim = claimById[asString(claimId)]
              if (!claim) continue
              for (const number of claimNotes(claim, usage)) {
                if (numbers.indexOf(number) < 0) numbers.push(number)
              }
            }
            for (const number of noteList(item.evidenceIds, usage)) {
              if (numbers.indexOf(number) < 0) numbers.push(number)
            }
            itemNumbers[asString(item.id)] = numbers
          }
          for (let sideIndex = 0; sideIndex < asArray(issue.sides).length; sideIndex += 1) {
            const side = issue.sides[sideIndex]
            const key = asString(issue.id) + ':' + sideIndex
            const usage = {
              kind: 'side',
              id: key,
              title: asString(issue.question),
              module: 'discussion',
            }
            sideNumbers[key] = noteList(side.evidenceIds, usage)
          }
        }

        // 03 值得深入理解什么：逐问题论断
        for (const question of asArray(model.questions)) {
          const qid = asString(question.id)
          const numbers = []
          for (const claim of asArray(model.claimsByQuestion[qid])) {
            const usage = {
              kind: 'claim',
              id: asString(claim.id),
              claimId: asString(claim.id),
              title: asString(claim.statement),
              module: 'question',
              questionId: qid,
            }
            const list = claimNotes(claim, usage)
            claimNumbers[asString(claim.id)] = list
            for (const number of list) {
              if (numbers.indexOf(number) < 0) numbers.push(number)
            }
          }
          for (const number of noteList(question.evidenceIds, { kind: 'question', id: qid, title: asString(question.question), module: 'question', questionId: qid })) {
            if (numbers.indexOf(number) < 0) numbers.push(number)
          }
          questionNumbers[qid] = numbers
        }
        // 没挂到任何问题上的论断也要有编号，避免注释缺口。
        for (const claim of asArray(model.claims)) {
          if (claimNumbers[asString(claim.id)]) continue
          claimNumbers[asString(claim.id)] = claimNotes(claim, {
            kind: 'claim',
            id: asString(claim.id),
            claimId: asString(claim.id),
            title: asString(claim.statement),
            module: asString(claim.module) || 'question',
            questionId: asString(asArray(claim.questionIds)[0]),
          })
        }

        // 04 目前能确定什么：判断
        for (const judgment of asArray(model.judgments)) {
          const usage = {
            kind: 'judgment',
            id: asString(judgment.id),
            title: asString(judgment.text),
            module: 'judgment',
            questionId: asString(asArray(judgment.claimIds)[0]),
          }
          let numbers = []
          for (const claimId of asArray(judgment.claimIds)) {
            const claim = claimById[asString(claimId)]
            if (!claim) continue
            for (const number of claimNotes(claim, usage)) {
              if (numbers.indexOf(number) < 0) numbers.push(number)
            }
          }
          for (const number of noteList(judgment.evidenceIds, usage)) {
            if (numbers.indexOf(number) < 0) numbers.push(number)
          }
          judgmentNumbers[asString(judgment.id)] = numbers
        }

        // 汇总：来源 → 编号 / 模块 / 读取范围
        const sourceNumbers = {}
        const sourceModules = {}
        const sourceReadScopes = {}
        for (const entry of entries) {
          for (const sourceId of entry.sourceIds) {
            if (!sourceNumbers[sourceId]) sourceNumbers[sourceId] = []
            if (sourceNumbers[sourceId].indexOf(entry.number) < 0) sourceNumbers[sourceId].push(entry.number)
            if (!sourceModules[sourceId]) sourceModules[sourceId] = {}
            if (entry.module) sourceModules[sourceId][entry.module] = true
            if (!sourceReadScopes[sourceId]) sourceReadScopes[sourceId] = []
            if (entry.readScope && sourceReadScopes[sourceId].indexOf(entry.readScope) < 0) {
              sourceReadScopes[sourceId].push(entry.readScope)
            }
          }
        }
        for (const sourceId in sourceNumbers) {
          if (!Object.prototype.hasOwnProperty.call(sourceNumbers, sourceId)) continue
          sourceNumbers[sourceId].sort(function (a, b) {
            return a - b
          })
        }

        return {
          entries: entries,
          byEvidenceId: byEvidenceId,
          byNumber: byNumber,
          bySourceId: bySourceId,
          sourceNumbers: sourceNumbers,
          sourceModules: sourceModules,
          sourceReadScopes: sourceReadScopes,
          claimNumbers: claimNumbers,
          judgmentNumbers: judgmentNumbers,
          blockNumbers: blockNumbers,
          itemNumbers: itemNumbers,
          sideNumbers: sideNumbers,
          questionNumbers: questionNumbers,
          summaryNumbers: summaryNumbers,
        }
      }

      /**
       * 由完整档案构建只读视图模型（所有数组都做防御性归一，兼容旧档案）。
       * @param {any} archive 完整档案（Archive v2；字段缺失时降级）。
       * @returns {any} 视图模型。
       */
      function buildView(archive) {
        const root = asObject(archive)
        const input = asObject(root.input)
        const topic = asObject(root.topic)
        const overview = asObject(root.overview)
        const rawUnderstanding = asObject(root.understanding)
        const rawDiscussion = asObject(root.discussion)

        // ---- 来源 ----------------------------------------------------------
        const sourceById = {}
        const sources = []
        for (const raw of asArray(root.sources)) {
          const source = asObject(raw)
          const id = asString(source.id)
          if (!id) continue
          sourceById[id] = source
          sources.push(source)
        }

        // ---- 问题 ----------------------------------------------------------
        const questionById = {}
        const questions = asArray(root.questions)
          .map(function (raw, index) {
            const question = asObject(raw)
            const id = asString(question.id)
            if (!id) return null
            return Object.assign({}, question, {
              id: id,
              order: asNumber(question.order, index + 1),
              question: asString(question.question) || asString(question.title),
              why: asString(question.why),
              role: asString(question.role),
              priority: PRIORITY_KEYS[asString(question.priority)] ? asString(question.priority) : 'medium',
              evidenceNeed: asString(question.evidenceNeed),
              summary: asString(question.summary),
              confidence: asString(question.confidence),
              workStatus: asString(question.workStatus) || asString(question.status) || 'pending',
              claimIds: asArray(question.claimIds).map(asString).filter(Boolean),
              evidenceIds: asArray(question.evidenceIds).map(asString).filter(Boolean),
              mechanism: asArray(question.mechanism),
              counterpoints: asArray(question.counterpoints),
              gaps: asArray(question.gaps),
              branchIds: asArray(question.branchIds).map(asString).filter(Boolean),
              entityIds: asArray(question.entityIds).map(asString).filter(Boolean),
            })
          })
          .filter(Boolean)
          .sort(function (a, b) {
            return a.order - b.order
          })
        for (const question of questions) questionById[asString(question.id)] = question

        // ---- 证据：全局数组 + v1 嵌套 evidence 兜底 --------------------------
        const evidenceById = {}
        const evidence = []
        const addEvidence = function (raw, fallbackQuestionId, fallbackModule) {
          const item = asObject(raw)
          const id = asString(item.id)
          if (!id || evidenceById[id]) return evidenceById[id] || null
          const normalized = Object.assign({}, item, {
            id: id,
            questionId: asString(item.questionId) || asString(fallbackQuestionId),
            module: asString(item.module) || asString(fallbackModule) || 'question',
            text: asString(item.text),
            quote: asString(item.quote),
            locator: asString(item.locator),
            readScope: asString(item.readScope),
            identity: IDENTITY_KEYS[asString(item.identity)] ? asString(item.identity) : 'analysis',
            stance: STANCE_KEYS[asString(item.stance)] ? asString(item.stance) : 'support',
            sourceIds: asArray(item.sourceIds).map(asString).filter(Boolean),
            strength: asString(item.strength),
            independentSources: asNumber(item.independentSources, 0),
            originGroupId: asString(item.originGroupId),
            retrievedAt: asString(item.retrievedAt),
            note: asString(item.note),
          })
          evidenceById[id] = normalized
          evidence.push(normalized)
          return normalized
        }
        for (const raw of asArray(root.evidence)) addEvidence(raw, '', 'question')
        for (const question of questions) {
          for (const raw of asArray(question.evidence)) addEvidence(raw, question.id, 'question')
          for (const conclusion of asArray(question.conclusions)) {
            for (const raw of asArray(asObject(conclusion).evidence)) addEvidence(raw, question.id, 'question')
          }
        }

        // ---- 论断：全局 claims；v1 conclusions 提升为 claims -----------------
        const claimById = {}
        const claims = []
        const addClaim = function (raw, fallbackQuestionId, fallbackModule) {
          const item = asObject(raw)
          const id = asString(item.id)
          if (!id || claimById[id]) return claimById[id] || null
          const questionIds = asArray(item.questionIds).map(asString).filter(Boolean)
          if (fallbackQuestionId && questionIds.indexOf(asString(fallbackQuestionId)) < 0) {
            questionIds.push(asString(fallbackQuestionId))
          }
          const normalized = {
            id: id,
            questionIds: questionIds,
            module: asString(item.module) || asString(fallbackModule) || 'question',
            statement: asString(item.statement) || asString(item.text) || asString(item.conclusion),
            identity: IDENTITY_KEYS[asString(item.identity)] ? asString(item.identity) : 'analysis',
            confidence: CONFIDENCE_KEYS[asString(item.confidence)] ? asString(item.confidence) : 'low',
            attribution: asString(item.attribution),
            scope: asString(item.scope),
            basis: asString(item.basis),
            conditions: asString(item.conditions),
            evidenceIds: asArray(item.evidenceIds).map(asString).filter(Boolean),
            opposeEvidenceIds: asArray(item.opposeEvidenceIds).map(asString).filter(Boolean),
            evidenceStatus: EVIDENCE_STATUS_KEYS[asString(item.evidenceStatus)] ? asString(item.evidenceStatus) : '',
            supersededBy: asString(item.supersededBy),
          }
          claimById[id] = normalized
          claims.push(normalized)
          return normalized
        }
        for (const raw of asArray(root.claims)) addClaim(raw, '', '')
        if (claims.length === 0) {
          for (const question of questions) {
            for (const conclusion of asArray(question.conclusions)) addClaim(conclusion, question.id, 'question')
          }
        }
        for (const claim of claims) {
          if (!claim.evidenceStatus) claim.evidenceStatus = deriveEvidenceStatus(claim, evidenceById)
        }

        // ---- 论断 / 证据按问题分组（问题内的 claimIds 顺序优先） -------------
        const claimsByQuestion = {}
        const evidenceByQuestion = {}
        for (const question of questions) {
          const qid = asString(question.id)
          const ordered = []
          const seenClaim = {}
          const pushClaim = function (claim) {
            if (!claim || seenClaim[asString(claim.id)]) return
            seenClaim[asString(claim.id)] = true
            ordered.push(claim)
          }
          for (const claimId of question.claimIds) pushClaim(claimById[asString(claimId)])
          for (const claim of claims) {
            if (asArray(claim.questionIds).indexOf(qid) >= 0) pushClaim(claim)
          }
          claimsByQuestion[qid] = ordered
          const evidenceList = []
          for (const item of evidence) {
            if (asString(item.questionId) === qid && evidenceList.indexOf(item) < 0) evidenceList.push(item)
          }
          for (const claim of ordered) {
            for (const evidenceId of asArray(claim.evidenceIds).concat(asArray(claim.opposeEvidenceIds))) {
              const item = evidenceById[asString(evidenceId)]
              if (item && evidenceList.indexOf(item) < 0) evidenceList.push(item)
            }
          }
          evidenceByQuestion[qid] = evidenceList
        }
        const claimsByEvidence = {}
        for (const claim of claims) {
          for (const evidenceId of asArray(claim.evidenceIds).concat(asArray(claim.opposeEvidenceIds))) {
            const key = asString(evidenceId)
            if (!claimsByEvidence[key]) claimsByEvidence[key] = []
            claimsByEvidence[key].push(claim)
          }
        }
        const judgmentsByClaim = {}

        // ---- 问题覆盖状态（宿主优先；缺失时由 claims 推导） -----------------
        for (const question of questions) {
          const qClaims = asArray(claimsByQuestion[asString(question.id)])
          let coverage = asString(question.coverage)
          if (!QUESTION_COVERAGE_KEYS[coverage]) {
            if (qClaims.length === 0) coverage = 'no-evidence'
            else if (
              qClaims.some(function (claim) {
                return asString(claim.evidenceStatus) === 'conflicted'
              })
            ) {
              coverage = 'disputed'
            } else if (
              qClaims.some(function (claim) {
                return asString(claim.evidenceStatus) === 'supported'
              })
            ) {
              coverage = 'answered'
            } else {
              coverage = 'partial'
            }
          }
          question.coverage = coverage
        }

        // ---- 这是什么 ------------------------------------------------------
        const summaryClaimIds = []
        const summaryClaimId = asString(rawUnderstanding.summaryClaimId)
        if (summaryClaimId && summaryClaimIds.indexOf(summaryClaimId) < 0) summaryClaimIds.push(summaryClaimId)
        for (const item of asArray(rawUnderstanding.summaryClaimIds)) {
          const claimId = asString(item)
          if (claimId && summaryClaimIds.indexOf(claimId) < 0) summaryClaimIds.push(claimId)
        }
        const summaryEvidenceIds = []
        const summaryEvidenceId = asString(rawUnderstanding.summaryEvidenceId)
        if (summaryEvidenceId && summaryEvidenceIds.indexOf(summaryEvidenceId) < 0) summaryEvidenceIds.push(summaryEvidenceId)
        for (const item of asArray(rawUnderstanding.summaryEvidenceIds)) {
          const evidenceId = asString(item)
          if (evidenceId && summaryEvidenceIds.indexOf(evidenceId) < 0) summaryEvidenceIds.push(evidenceId)
        }
        const blocks = asArray(rawUnderstanding.blocks)
          .map(function (raw, index) {
            const block = asObject(raw)
            const kind = BLOCK_KIND_KEYS[asString(block.kind)] ? asString(block.kind) : 'definition'
            const id = asString(block.id) || 'u' + (index + 1)
            return {
              id: id,
              kind: kind,
              title: asString(block.title),
              text: asString(block.text),
              claimIds: asArray(block.claimIds).map(asString).filter(Boolean),
              evidenceIds: asArray(block.evidenceIds).map(asString).filter(Boolean),
            }
          })
          .filter(function (block) {
            return !!block.text
          })
        const summary = asString(rawUnderstanding.summary) || asString(topic.definition) || asString(overview.brief)
        if (blocks.length === 0 && asString(overview.brief) && asString(overview.brief) !== summary) {
          blocks.push({
            id: 'legacy-brief',
            kind: 'background',
            title: '',
            text: asString(overview.brief),
            claimIds: [],
            evidenceIds: [],
          })
        }
        const understandingCoverageRaw = asObject(rawUnderstanding.coverage)
        const understandingCoverage = {
          status: COVERAGE_KEYS[asString(understandingCoverageRaw.status)]
            ? asString(understandingCoverageRaw.status)
            : summary || blocks.length > 0
              ? 'partial'
              : 'missing',
          note: asString(understandingCoverageRaw.note),
          limits: asString(understandingCoverageRaw.limits),
        }

        // ---- 实体 / 混淆项 / 时间线 ----------------------------------------
        const entityById = {}
        const entityRaw = asArray(rawUnderstanding.entities).length > 0 ? asArray(rawUnderstanding.entities) : asArray(root.entities)
        const entities = entityRaw
          .map(function (raw, index) {
            const entity = asObject(raw)
            const id = asString(entity.id) || 'e' + (index + 1)
            const normalized = {
              id: id,
              name: asString(entity.name) || asString(entity.title),
              type: asString(entity.type),
              role: asString(entity.role),
              claimIds: asArray(entity.claimIds).map(asString).filter(Boolean),
              sourceIds: asArray(entity.sourceIds).map(asString).filter(Boolean),
            }
            entityById[id] = normalized
            return normalized
          })
          .filter(function (entity) {
            return !!entity.name
          })
        const confusables = asArray(rawUnderstanding.confusables)
          .map(function (raw, index) {
            const item = asObject(raw)
            return {
              id: asString(item.id) || 'cf' + (index + 1),
              term: asString(item.term),
              confusedWith: asString(item.confusedWith) || asString(item.with),
              note: asString(item.note),
              sourceIds: asArray(item.sourceIds).map(asString).filter(Boolean),
            }
          })
          .filter(function (item) {
            return !!item.term
          })
        const timelineRaw = asArray(rawUnderstanding.timeline).length > 0 ? asArray(rawUnderstanding.timeline) : asArray(root.timeline)
        const timeline = timelineRaw
          .map(function (raw, index) {
            const item = asObject(raw)
            return {
              id: asString(item.id) || 't' + (index + 1),
              at: asString(item.at) || asString(item.date),
              text: asString(item.text),
              sourceIds: asArray(item.sourceIds).map(asString).filter(Boolean),
            }
          })
          .filter(function (item) {
            return !!item.text
          })

        // ---- 大家在讨论什么 ------------------------------------------------
        const rawScope = asObject(rawDiscussion.scope)
        const discussionScope = {
          window: asString(rawScope.window) || asString(input.discussionWindow),
          platforms: asArray(rawScope.platforms).map(asString).filter(Boolean),
          languages: asArray(rawScope.languages).map(asString).filter(Boolean),
          materialCount: asNumber(rawScope.materialCount, 0),
          speakerCount: asNumber(rawScope.speakerCount, 0),
          limits: asString(rawScope.limits),
          checkedAt: asString(rawScope.checkedAt),
        }
        const issueById = {}
        const discussionIssues = asArray(rawDiscussion.issues)
          .map(function (raw, index) {
            const issue = asObject(raw)
            const id = asString(issue.id) || 'd' + (index + 1)
            const items = asArray(issue.items)
              .map(function (itemRaw, itemIndex) {
                const item = asObject(itemRaw)
                return {
                  id: asString(item.id) || 'di' + (index + 1) + '.' + (itemIndex + 1),
                  speaker: asString(item.speaker),
                  affiliation: asString(item.affiliation),
                  identity: DISCUSSION_IDENTITY_KEYS[asString(item.identity)] ? asString(item.identity) : 'other',
                  at: asString(item.at),
                  channel: asString(item.channel),
                  view: asString(item.view) || asString(item.text),
                  basis: asString(item.basis),
                  claimIds: asArray(item.claimIds).map(asString).filter(Boolean),
                  evidenceIds: asArray(item.evidenceIds).map(asString).filter(Boolean),
                  sourceIds: asArray(item.sourceIds).map(asString).filter(Boolean),
                }
              })
              .filter(function (item) {
                return !!item.view || !!item.speaker
              })
            const sides = asArray(issue.sides).map(function (sideRaw) {
              const side = asObject(sideRaw)
              return {
                position: asString(side.position),
                holders: asArray(side.holders).map(asString).filter(Boolean),
                evidenceIds: asArray(side.evidenceIds).map(asString).filter(Boolean),
              }
            })
            const statusRaw = asString(issue.status)
            const normalized = {
              id: id,
              question: asString(issue.question) || asString(issue.title),
              summary: asString(issue.summary),
              status: COVERAGE_KEYS[statusRaw] ? statusRaw : items.length > 0 ? 'covered' : 'missing',
              items: items,
              sides: sides,
              disagreement: {
                origin: asString(asObject(issue.disagreement).origin),
                note: asString(asObject(issue.disagreement).note),
              },
              gaps: asString(issue.gaps),
            }
            issueById[id] = normalized
            return normalized
          })
          .filter(function (issue) {
            return !!issue.question
          })
        const discussionCoverageRaw = asObject(rawDiscussion.coverage)
        const discussionCoverage = {
          status: COVERAGE_KEYS[asString(discussionCoverageRaw.status)]
            ? asString(discussionCoverageRaw.status)
            : discussionIssues.length > 0
              ? 'partial'
              : 'missing',
          note: asString(discussionCoverageRaw.note),
          limits: asString(discussionCoverageRaw.limits),
        }

        // ---- 目前能确定什么：判断 / 未知 / 关联 -----------------------------
        const judgmentById = {}
        const judgments = []
        const addJudgment = function (raw, index) {
          const item = asObject(raw)
          const id = asString(item.id) || 'j' + (index + 1)
          const claimIds = asArray(item.claimIds).map(asString).filter(Boolean)
          const evidenceIds = asArray(item.evidenceIds).map(asString).filter(Boolean)
          const sourceIds = asArray(item.sourceIds).map(asString).filter(Boolean)
          const judgment = {
            id: id,
            text: asString(item.text) || asString(item.statement),
            identity: IDENTITY_KEYS[asString(item.identity)] ? asString(item.identity) : 'analysis',
            confidence: CONFIDENCE_KEYS[asString(item.confidence)] ? asString(item.confidence) : 'low',
            conditions: asString(item.conditions),
            claimIds: claimIds,
            evidenceIds: evidenceIds,
            sourceIds: sourceIds,
            independentSources: asNumber(item.independentSources, 0),
            stale: !!item.stale,
            note: asString(item.note),
          }
          judgmentById[id] = judgment
          judgments.push(judgment)
          return judgment
        }
        if (asArray(root.judgments).length > 0) {
          asArray(root.judgments).forEach(addJudgment)
        } else {
          asArray(overview.findings).forEach(function (raw, index) {
            const finding = asObject(raw)
            addJudgment(
              {
                id: asString(finding.id) || 'j' + (index + 1),
                text: asString(finding.text),
                identity: finding.identity,
                confidence: finding.confidence,
                conditions: finding.conditions,
                claimIds: finding.claimId ? [finding.claimId] : asArray(finding.claimIds),
                evidenceIds: finding.evidenceIds,
                sourceIds: finding.sourceIds,
                independentSources: finding.independentSources,
                note: finding.note,
              },
              index,
            )
          })
        }
        // 判断的 evidence/source 由 claimIds 聚合（程序派生，不依赖模型自报）。
        for (const judgment of judgments) {
          const evidenceIds = []
          const sourceIds = []
          for (const claimId of asArray(judgment.claimIds)) {
            const claim = claimById[asString(claimId)]
            if (!claim) continue
            judgmentsByClaim[asString(claimId)] = judgment
            for (const evidenceId of asArray(claim.evidenceIds).concat(asArray(claim.opposeEvidenceIds))) {
              if (evidenceIds.indexOf(asString(evidenceId)) < 0) evidenceIds.push(asString(evidenceId))
            }
          }
          for (const evidenceId of asArray(judgment.evidenceIds)) {
            if (evidenceIds.indexOf(asString(evidenceId)) < 0) evidenceIds.push(asString(evidenceId))
          }
          for (const evidenceId of evidenceIds) {
            const item = evidenceById[asString(evidenceId)]
            for (const sourceId of asArray(item && item.sourceIds)) {
              if (sourceIds.indexOf(asString(sourceId)) < 0) sourceIds.push(asString(sourceId))
            }
          }
          for (const sourceId of asArray(judgment.sourceIds)) {
            if (sourceIds.indexOf(asString(sourceId)) < 0) sourceIds.push(asString(sourceId))
          }
          judgment.evidenceIds = evidenceIds
          judgment.sourceIds = sourceIds
          if (!judgment.independentSources) judgment.independentSources = countIndependentSourceIds(sourceIds, sourceById)
        }

        const unknownById = {}
        const unknowns = asArray(root.unknowns)
          .map(function (raw, index) {
            const item = asObject(raw)
            const id = asString(item.id) || 'un' + (index + 1)
            const unknown = {
              id: id,
              questionId: asString(item.questionId),
              text: asString(item.text),
              whyItMatters: asString(item.whyItMatters),
              howToClose: asString(item.howToClose),
            }
            unknownById[id] = unknown
            return unknown
          })
          .filter(function (item) {
            return !!item.text
          })

        const connectionById = {}
        const connections = asArray(root.connections)
          .map(function (raw, index) {
            const item = asObject(raw)
            const id = asString(item.id) || 'x' + (index + 1)
            const connection = {
              id: id,
              from: asString(item.from),
              to: asString(item.to),
              kind: asString(item.kind),
              mechanism: asString(item.mechanism),
              claimIds: asArray(item.claimIds).map(asString).filter(Boolean),
              sourceIds: asArray(item.sourceIds).map(asString).filter(Boolean),
              status: asString(item.status) || 'unverified',
              note: asString(item.note),
            }
            connectionById[id] = connection
            return connection
          })
          .filter(function (item) {
            return !!item.to || !!item.mechanism
          })

        // ---- 接下来值得查什么：分支（兼容 v1 followups） --------------------
        const branchById = {}
        const branches = []
        const addBranch = function (raw, fallbackQuestionId, index) {
          const item = asObject(raw)
          const text = asString(item.text) || asString(item.question) || asString(item.summary)
          if (!text) return null
          const id = asString(item.id) || 'b' + (index + 1)
          if (branchById[id]) return branchById[id]
          const branch = {
            id: id,
            text: text,
            hook: asString(item.hook) || asString(item.why),
            priority: PRIORITY_KEYS[asString(item.priority)] ? asString(item.priority) : 'medium',
            status: asString(item.status) === 'answered' ? 'answered' : 'open',
            questionId: asString(item.questionId) || asString(fallbackQuestionId),
            answeredBy: asString(item.answeredBy),
          }
          branchById[id] = branch
          branches.push(branch)
          return branch
        }
        asArray(root.branches).forEach(function (raw, index) {
          addBranch(raw, '', index)
        })
        if (branches.length === 0) {
          asArray(root.followups).forEach(function (raw, index) {
            addBranch(raw, '', index)
          })
          for (const question of questions) {
            asArray(question.followups).forEach(function (raw, index) {
              addBranch(raw, question.id, branches.length + index)
            })
          }
        }
        const priorityRank = { high: 0, medium: 1, low: 2 }
        const sortedBranches = branches.slice().sort(function (a, b) {
          const rankA = priorityRank[asString(a.priority)] != null ? priorityRank[asString(a.priority)] : 1
          const rankB = priorityRank[asString(b.priority)] != null ? priorityRank[asString(b.priority)] : 1
          if (rankA !== rankB) return rankA - rankB
          if (a.status !== b.status) return a.status === 'open' ? -1 : 1
          return branches.indexOf(a) - branches.indexOf(b)
        })
        const seenBranchText = {}
        const uniqueBranches = []
        for (const branch of sortedBranches) {
          const text = asString(branch.text).trim()
          if (text && seenBranchText[text]) {
            delete branchById[asString(branch.id)]
            continue
          }
          if (text) seenBranchText[text] = true
          uniqueBranches.push(branch)
        }
        const openBranches = uniqueBranches.filter(function (branch) {
          return branch.status !== 'answered'
        })

        for (const question of questions) {
          question.branchIds = question.branchIds.filter(function (id) {
            return !!branchById[asString(id)]
          })
          if (question.branchIds.length === 0) {
            question.branchIds = branches
              .filter(function (branch) {
                return branch.questionId === asString(question.id)
              })
              .map(function (branch) {
                return branch.id
              })
          }
          question.branchList = question.branchIds.map(function (id) {
            return branchById[asString(id)]
          }).filter(Boolean)
        }

        // ---- 来源被引用位置（关联 / 时间线，用于来源抽屉补充信息） ----------
        const sourceUsage = {}
        const pushUsage = function (sourceId, usage) {
          const id = asString(sourceId)
          if (!id) return
          if (!sourceUsage[id]) sourceUsage[id] = []
          sourceUsage[id].push(usage)
        }
        for (const connection of connections) {
          for (const sourceId of asArray(connection.sourceIds)) pushUsage(sourceId, { kind: 'connection', connection: connection })
        }
        for (const item of timeline) {
          for (const sourceId of asArray(item.sourceIds)) pushUsage(sourceId, { kind: 'timeline', item: item })
        }
        for (const entity of entities) {
          for (const sourceId of asArray(entity.sourceIds)) pushUsage(sourceId, { kind: 'entity', entity: entity })
        }
        for (const item of confusables) {
          for (const sourceId of asArray(item.sourceIds)) pushUsage(sourceId, { kind: 'confusable', item: item })
        }

        // ---- 注释索引 ------------------------------------------------------
        const annotationIndex = buildAnnotationIndex({
          summary: {
            text: summary,
            claimIds: summaryClaimIds,
            evidenceIds: summaryEvidenceIds,
          },
          blocks: blocks,
          discussion: { issues: discussionIssues },
          questions: questions,
          claims: claims,
          claimsByQuestion: claimsByQuestion,
          claimById: claimById,
          evidenceById: evidenceById,
          sourceById: sourceById,
          judgments: judgments,
        })

        // ---- 统计 ----------------------------------------------------------
        const stats = Object.assign({}, asObject(root.stats))
        stats.questionCount = asNumber(stats.questionCount, questions.length) || questions.length
        stats.sourceCount = asNumber(stats.sourceCount, sources.length) || sources.length
        stats.claimCount = asNumber(stats.claimCount, claims.length) || claims.length
        stats.evidenceCount = asNumber(stats.evidenceCount, evidence.length) || evidence.length
        stats.annotationCount = annotationIndex.entries.length
        if (!asNumber(stats.independentSourceCount, 0)) {
          const sourceIds = sources.map(function (source) {
            return asString(source.id)
          })
          stats.independentSourceCount = countIndependentSourceIds(sourceIds, sourceById)
        }
        return {
          archive: root,
          input: input,
          topic: topic,
          understanding: {
            status: understandingCoverage.status,
            summary: summary,
            blocks: blocks,
            entities: entities,
            confusables: confusables,
            timeline: timeline,
            coverage: understandingCoverage,
          },
          discussion: {
            scope: discussionScope,
            issues: discussionIssues,
            coverage: discussionCoverage,
          },
          questions: questions,
          claims: claims,
          evidence: evidence,
          judgments: judgments,
          unknowns: unknowns,
          branches: uniqueBranches,
          sortedBranches: uniqueBranches,
          openBranches: openBranches,
          connections: connections,
          sources: sources,
          anySearchRecords: asArray(root.anySearchRecords).map(asObject).filter(function (record) { return !!asString(record.content).trim() }),
          entities: entities,
          confusables: confusables,
          timeline: timeline,
          revisions: asArray(root.revisions),
          tensions: asArray(root.tensions).map(asString).filter(Boolean),
          readingNote: asString(root.readingNote),
          stats: stats,
          knowledgeBase: asArray(root.knowledgeBase),
          claimById: claimById,
          evidenceById: evidenceById,
          questionById: questionById,
          sourceById: sourceById,
          entityById: entityById,
          issueById: issueById,
          judgmentById: judgmentById,
          branchById: branchById,
          unknownById: unknownById,
          connectionById: connectionById,
          claimsByQuestion: claimsByQuestion,
          evidenceByQuestion: evidenceByQuestion,
          claimsByEvidence: claimsByEvidence,
          judgmentsByClaim: judgmentsByClaim,
          annotations: annotationIndex,
          annotationCount: annotationIndex.entries.length,
          annotationByNumber: annotationIndex.byNumber,
          summaryNumbers: annotationIndex.summaryNumbers,
          sourceUsage: sourceUsage,
          sourceNumbers: annotationIndex.sourceNumbers,
          sourceModules: annotationIndex.sourceModules,
          sourceReadScopes: annotationIndex.sourceReadScopes,
        }
      }

      /**
       * 统计一组来源里的独立信源数（primary / independent，按 canonicalUrl 去重）。
       * @param {any[]} sourceIds 来源 id 列表。
       * @param {Record<string, any>} sourceById 来源索引。
       * @returns {number}
       */
      function countIndependentSourceIds(sourceIds, sourceById) {
        const seen = {}
        let count = 0
        for (const rawId of asArray(sourceIds)) {
          const source = sourceById[asString(rawId)]
          if (!source) continue
          const independence = asString(source.independence)
          if (independence !== 'primary' && independence !== 'independent') continue
          const key = asString(source.canonicalUrl) || asString(source.url) || asString(source.id)
          if (seen[key]) continue
          seen[key] = true
          count += 1
        }
        return count
      }

      /**
       * 证据链组装：claim / evidence / judgment / question / branch → 支持与反对证据 → 来源 → 缺口。
       * @param {any} view buildView() 结果。
       * @param {{ type: string, id: string }} ref 引用。
       * @returns {any | null} 可展示的链。
       */
      function buildChain(view, ref) {
        if (!view || !ref) return null
        const type = asString(ref.type)
        const id = asString(ref.id)
        let question = null
        let claim = null
        let judgment = null
        let evidence = null
        let branch = null

        if (type === 'claim') claim = view.claimById[id] || null
        else if (type === 'judgment') judgment = view.judgmentById[id] || null
        else if (type === 'evidence') evidence = view.evidenceById[id] || null
        else if (type === 'branch') branch = view.branchById[id] || null
        else if (type === 'question') question = view.questionById[id] || null

        if (evidence) {
          question = question || view.questionById[asString(evidence.questionId)] || null
          const owners = asArray(view.claimsByEvidence[id])
          claim = owners[0] || null
        }
        if (claim) {
          const qid = asString(asArray(claim.questionIds)[0])
          question = question || view.questionById[qid] || null
        }
        if (judgment) {
          const firstClaimId = asString(asArray(judgment.claimIds)[0])
          const firstClaim = view.claimById[firstClaimId]
          const qid = asString(firstClaim && asArray(firstClaim.questionIds)[0])
          question = question || view.questionById[qid] || null
        }
        if (branch) {
          question = question || view.questionById[asString(branch.questionId)] || null
        }
        if (!question && !claim && !judgment && !evidence && !branch) return null

        const claimList = []
        const seenClaim = {}
        const pushClaim = function (item) {
          const key = asString(item && item.id)
          if (!key || seenClaim[key]) return
          seenClaim[key] = true
          claimList.push(item)
        }
        if (claim) pushClaim(claim)
        if (judgment) {
          for (const claimId of asArray(judgment.claimIds)) pushClaim(view.claimById[asString(claimId)])
        }
        if (evidence) {
          for (const item of asArray(view.claimsByEvidence[id])) pushClaim(item)
        }
        if (question && claimList.length === 0) {
          for (const item of asArray(view.claimsByQuestion[asString(question.id)])) pushClaim(item)
        }

        const support = []
        const oppose = []
        const seenEvidence = {}
        const pushEvidence = function (evidenceId, stance) {
          const item = view.evidenceById[asString(evidenceId)]
          if (!item) return
          const key = asString(item.id)
          if (seenEvidence[key]) return
          seenEvidence[key] = true
          const group = stance === 'oppose' ? oppose : support
          group.push({
            evidence: item,
            sources: asArray(item.sourceIds)
              .map(function (sourceId) {
                return view.sourceById[asString(sourceId)]
              })
              .filter(Boolean),
          })
        }
        for (const item of claimList) {
          for (const evidenceId of asArray(item.evidenceIds)) pushEvidence(evidenceId, 'support')
          for (const evidenceId of asArray(item.opposeEvidenceIds)) pushEvidence(evidenceId, 'oppose')
        }
        if (evidence) pushEvidence(evidence.id, asString(evidence.stance) === 'oppose' ? 'oppose' : 'support')
        if (judgment) {
          for (const evidenceId of asArray(judgment.evidenceIds)) {
            const item = view.evidenceById[asString(evidenceId)]
            pushEvidence(evidenceId, asString(item && item.stance) === 'oppose' ? 'oppose' : 'support')
          }
        }
        if (claimList.length === 0 && question) {
          for (const evidenceId of asArray(question.evidenceIds)) {
            const item = view.evidenceById[asString(evidenceId)]
            pushEvidence(evidenceId, asString(item && item.stance) === 'oppose' ? 'oppose' : 'support')
          }
        }

        const sources = []
        const seenSource = {}
        for (const group of support.concat(oppose)) {
          for (const item of group.sources) {
            if (seenSource[asString(item.id)]) continue
            seenSource[asString(item.id)] = true
            sources.push(item)
          }
        }
        return {
          kind: judgment ? 'judgment' : claim ? 'claim' : evidence ? 'evidence' : branch ? 'branch' : 'question',
          topic: view.topic,
          question: question,
          claim: claim,
          judgment: judgment,
          evidence: evidence,
          branch: branch,
          claims: claimList,
          support: support,
          oppose: oppose,
          sources: sources,
          gaps: asArray(question && question.gaps),
        }
      }

      /**
       * 来源被引用位置（关联 / 时间线 / 实体 / 混淆项）。
       * @param {any} view 视图模型。
       * @param {string} sourceId 来源 id。
       * @returns {any[]}
       */
      function sourceUsages(view, sourceId) {
        return asArray(view && view.sourceUsage && view.sourceUsage[asString(sourceId)])
      }

      // ======================================================================
      // 共享原子：品牌标记 / 分组标题 / 深度切换
      // ======================================================================

      /**
       * 品牌标记（面板内，非侧栏）。
       * @param {{ size?: number }} [props] 尺寸。
       * @returns {any}
       */
      function BrandMark(props) {
        const size = props && props.size ? props.size : 18
        return h(
          'span',
          { className: 'ds-brand-mark' },
          h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.7,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': 'true',
              focusable: 'false',
            },
            h('path', { key: 'a', d: 'M5 4.6h8.2L18 9.5V20a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 20V4.6Z' }),
            h('path', { key: 'b', d: 'M13.2 4.7v4.7h4.7' }),
            h('path', { key: 'c', d: 'M8 12h4M8 15h3' }),
            h('circle', { key: 'd', cx: 15.6, cy: 15.4, r: 2.5 }),
            h('path', { key: 'e', d: 'm17.5 17.3 1.7 1.7' }),
          ),
        )
      }

      /**
       * 章节标题（编号 + 标题 + 说明）。
       * @param {{ index?: string, title: string, hint?: string, count?: any }} props 属性。
       * @returns {any}
       */
      function SectionHead(props) {
        return h(
          'div',
          { className: 'ds-section-head' },
          h(
            'div',
            { className: 'ds-section-head-main' },
            props.index ? h('span', { className: 'ds-section-index' }, props.index) : null,
            h('h2', { className: 'ds-section-title' }, props.title),
            props.count != null ? h('span', { className: 'ds-section-count' }, String(props.count)) : null,
          ),
          props.hint ? h('p', { className: 'ds-section-hint' }, props.hint) : null,
        )
      }

      /**
       * 深度切换（快速 / 深入）。
       * @param {{ value: string, onChange: Function, disabled?: boolean, size?: string, t?: Function }} props 属性。
       * @returns {any}
       */
      function DepthSwitch(props) {
        const options = [
          { id: 'quick', label: tr('rail.depth.quick'), hint: tr('rail.depth.quickHint') },
          { id: 'deep', label: tr('rail.depth.deep'), hint: tr('rail.depth.deepHint') },
        ]
        return h(
          'div',
          { className: 'ds-depth' + (props.size === 'lg' ? ' ds-depth-lg' : ''), role: 'radiogroup', 'aria-label': tr('rail.depth') },
          options.map(function (option) {
            const active = props.value === option.id
            return h(
              'button',
              {
                key: option.id,
                type: 'button',
                role: 'radio',
                'aria-checked': active,
                'data-depth': option.id,
                className: 'ds-depth-btn' + (active ? ' ds-depth-active' : ''),
                disabled: props.disabled,
                title: option.hint,
                onClick: function () {
                  props.onChange(option.id)
                },
              },
              h('span', { className: 'ds-depth-label' }, option.label),
              props.size === 'lg' ? h('span', { className: 'ds-depth-hint' }, option.hint) : null,
            )
          }),
        )
      }

      const SEARCH_PROVIDER_MODES = ['auto', 'account', 'web', 'api', 'anysearch']

      function searchModeLabel(mode, t) {
        if (SEARCH_PROVIDER_MODES.includes(mode)) return t('settings.searchMode.' + mode)
        return asString(mode) || '—'
      }

      function SearchProviderSelect(props) {
        return h(
          'label',
          { className: props.className },
          h('span', { className: props.labelClassName }, props.t(props.labelKey || 'settings.searchMode')),
          h(
            'select',
            {
              className: 'ds-input',
              value: props.value,
              disabled: props.disabled,
              'aria-describedby': props.describedBy,
              onChange: function (event) { props.onChange(event.target.value) },
            },
            SEARCH_PROVIDER_MODES.map(function (mode) {
              const keyMissing = mode === 'anysearch' && !props.hasAnySearchApiKey
              return h('option', { key: mode, value: mode, disabled: keyMissing }, searchModeLabel(mode, props.t))
            }),
          ),
        )
      }

      function anySearchLabel(type, id, t) {
        const key = 'anySearch.' + type + '.' + id
        const label = t(key)
        return label === key ? id : label
      }

      const ESPORTS_PLAYER_FIELDS = ['region', 'game_name']
      const ESPORTS_TYPES = {
        player: { required: ESPORTS_PLAYER_FIELDS, optional: ['queue'] },
        ranked: { required: ESPORTS_PLAYER_FIELDS, optional: ['queue'] },
        mastery: { required: ESPORTS_PLAYER_FIELDS, optional: ['champion'] },
        live_game: { required: ESPORTS_PLAYER_FIELDS },
        match_detail: { required: ['match_id'] },
        leaderboard: { required: ['region'], optional: ['queue', 'tier', 'division'] },
        champion: { queryHint: 'championQuery' },
        item: { queryHint: 'itemQuery' },
        champion_rotation: { optional: ['region'] },
      }

      function esportsType(value) {
        return Object.hasOwn(ESPORTS_TYPES, value) ? ESPORTS_TYPES[value] : {}
      }

      function anySearchFieldsFor(selected, values) {
        const fields = asArray(selected?.params)
        if (selected?.tag !== 'gaming.esports') return fields
        const type = esportsType(values.type)
        const required = ['type', ...(type.required || [])]
        const optional = (type.optional || []).filter(function (key) {
          return key !== 'division' || /^(DIAMOND|EMERALD|PLATINUM|GOLD|SILVER|BRONZE|IRON)$/i.test(asString(values.tier).trim())
        })
        return fields.filter(function (field) {
          return required.includes(field.key) || optional.includes(field.key)
        }).map(function (field) {
          return { ...field, required: required.includes(field.key) }
        })
      }

      function esportsFieldLabel(key, t) {
        return t('anySearch.esports.' + (key === 'champion' ? 'championFilter' : key))
      }

      function anySearchParamValue(input, description) {
        if (/^[\[\{"]/.test(input)) {
          try { return JSON.parse(input) } catch { return input }
        }
        if (/^(true|false)$/.test(input) && /\b(boolean|whether|true|false)\b/i.test(description)) {
          return input === 'true'
        }
        if (/^\d+$/.test(input) && /^number of (adults|children|infants)\b/i.test(description)) {
          return Number(input)
        }
        return input
      }

      // 两个新建表单共用草稿和目录请求，避免重复加载或提交旧领域的参数。
      function useAnySearchSelection(enabled) {
        const [draft, setDraft] = useState(cache.anySearchDraft)
        const [domains, setDomains] = useState({ status: 'idle', items: [] })
        const [capabilities, setCapabilities] = useState({ status: 'idle', items: [], domain: '' })
        const [domainAttempt, setDomainAttempt] = useState(0)
        const [capabilityAttempt, setCapabilityAttempt] = useState(0)

        useEffect(function () {
          if (!enabled) return
          const controller = new AbortController()
          setDomains({ status: 'loading', items: [] })
          api('/anysearch/domains', { signal: controller.signal })
            .then(function (data) {
              if (!controller.signal.aborted) setDomains({ status: 'ready', items: asArray(data.domains) })
            })
            .catch(function () {
              if (!controller.signal.aborted) setDomains({ status: 'error', items: [] })
            })
          return function () { controller.abort() }
        }, [enabled, domainAttempt])

        useEffect(function () {
          if (!enabled || !draft.domain) return
          const controller = new AbortController()
          const domain = draft.domain
          setCapabilities({ status: 'loading', items: [], domain: domain })
          api('/anysearch/capabilities?domain=' + encodeURIComponent(domain), { signal: controller.signal })
            .then(function (data) {
              if (!controller.signal.aborted) setCapabilities({ status: 'ready', items: asArray(data.capabilities), domain: domain })
            })
            .catch(function () {
              if (!controller.signal.aborted) setCapabilities({ status: 'error', items: [], domain: domain })
            })
          return function () { controller.abort() }
        }, [enabled, draft.domain, capabilityAttempt])

        const current = capabilities.domain === draft.domain ? capabilities : { status: 'loading', items: [] }
        const selected = current.items.find(function (entry) { return entry.tag === draft.tag })
          || (current.items.length === 1 && !draft.tag ? current.items[0] : null)
        const blocked = enabled && !!draft.domain && !selected
        const fields = anySearchFieldsFor(selected, draft.values)
        const missingEsportsFields = enabled && selected?.tag === 'gaming.esports' ? fields.filter(function (field) {
          return field.required && !asString(draft.values[field.key]).trim()
        }).map(function (field) { return field.key }) : []

        function update(next) {
          cache.anySearchDraft = next
          setDraft(next)
        }

        function getSelection() {
          if (!enabled || !draft.domain || !selected) return undefined
          const params = Object.fromEntries(fields.flatMap(function (field) {
            const input = asString(draft.values[field.key]).trim()
            return input ? [[field.key, anySearchParamValue(input, field.description)]] : []
          }))
          return { tag: selected.tag, params: params }
        }

        return {
          enabled: enabled,
          draft: draft,
          domains: domains,
          capabilities: current,
          selected: selected,
          fields: fields,
          blocked: blocked,
          missingEsportsFields: missingEsportsFields,
          getSelection: getSelection,
          onDomain: function (domain) {
            if (domain === draft.domain) return
            setCapabilities({ status: 'loading', items: [], domain: domain })
            update({ domain: domain, tag: '', values: {} })
          },
          onTag: function (tag) { update({ domain: draft.domain, tag: tag, values: {} }) },
          onParam: function (key, value) {
            update({ ...draft, values: { ...draft.values, [key]: value } })
          },
          retryDomains: function () { setDomainAttempt(function (value) { return value + 1 }) },
          retryCapabilities: function () { setCapabilityAttempt(function (value) { return value + 1 }) },
        }
      }

      function AnySearchFields(props) {
        const { selection, disabled, id, t } = props
        if (!selection.enabled) return null
        const { draft, domains, capabilities, selected } = selection
        const knownDomain = domains.items.some(function (item) { return item.id === draft.domain })
        const params = selection.fields
        const esports = selected?.tag === 'gaming.esports'
        const esportsQueryHint = esports ? esportsType(draft.values.type).queryHint : ''
        const description = esports ? t('anySearch.esports.description') : selected?.description
        const primary = params.filter(function (field) { return field.required && !/^optional\b/i.test(field.description) })
        const optional = params.filter(function (field) { return !primary.includes(field) })
        const scopeLabel = id + '-scope-label'

        function field(param) {
          const helpId = id + '-' + param.key + '-help'
          const inputProps = {
            className: 'ds-input',
            value: asString(draft.values[param.key]),
            disabled: disabled,
            'aria-required': esports && param.required ? true : undefined,
            'aria-describedby': esports || param.description ? helpId : undefined,
            onChange: function (event) { selection.onParam(param.key, event.target.value) },
          }
          if (esports && param.key === 'type') {
            return h('label', { key: param.key, className: 'ds-anysearch-field' },
              h('span', null, esportsFieldLabel(param.key, t)),
              h('select', inputProps,
                h('option', { value: '' }, t('anySearch.chooseCapability')),
                Object.keys(ESPORTS_TYPES).map(function (type) {
                  return h('option', { key: type, value: type }, t('anySearch.esports.' + type))
                })),
              h('small', { id: helpId, className: 'ds-anysearch-help' }, t('anySearch.esports.' + (esportsQueryHint || 'typeHint'))),
            )
          }
          const hintKey = param.key === 'region' && draft.values.type === 'champion_rotation' ? 'rotationRegionHint' : param.key + 'Hint'
          const hint = esports ? t('anySearch.esports.' + hintKey) : param.description
          return h('label', { key: param.key, className: 'ds-anysearch-field' },
            h('span', null, esports ? esportsFieldLabel(param.key, t) : param.key),
            h('input', {
              ...inputProps,
              type: 'text',
              maxLength: 2048,
              autoComplete: 'off',
              spellCheck: false,
            }),
            hint ? h('small', { id: helpId, className: 'ds-anysearch-help' }, hint) : null,
          )
        }

        function catalogStatus(status, retry, empty) {
          if (status === 'loading' || status === 'idle') {
            return h('span', { className: 'ds-anysearch-help', role: 'status' }, t('anySearch.loading'))
          }
          if (status === 'error' || empty) {
            return h('div', { className: 'ds-anysearch-status' },
              h('span', { className: 'ds-anysearch-help', role: 'status' }, t(status === 'error' ? 'anySearch.loadFailed' : 'anySearch.noCapabilities')),
              h('button', { type: 'button', className: 'ds-btn ds-btn-sm', disabled: disabled, onClick: retry }, t('anySearch.retry')),
            )
          }
          return null
        }

        return h('div', { className: 'ds-anysearch', role: 'group', 'aria-labelledby': scopeLabel },
          h('div', { className: 'ds-anysearch-selects' },
            h('label', { className: 'ds-anysearch-field' },
              h('span', { id: scopeLabel }, t('anySearch.scope')),
              h('select', {
                className: 'ds-input',
                value: draft.domain,
                disabled: disabled,
                'aria-describedby': !draft.domain ? id + '-auto-hint' : undefined,
                onChange: function (event) { selection.onDomain(event.target.value) },
              },
              h('option', { value: '' }, t('anySearch.auto')),
              draft.domain && !knownDomain ? h('option', { value: draft.domain, disabled: true }, anySearchLabel('domain', draft.domain, t)) : null,
              domains.items.map(function (item) {
                return h('option', { key: item.id, value: item.id }, anySearchLabel('domain', item.id, t))
              })),
            ),
            draft.domain && capabilities.items.length > 1
              ? h('label', { className: 'ds-anysearch-field' },
                  h('span', null, t('anySearch.capability')),
                  h('select', {
                    className: 'ds-input',
                    value: selected ? selected.tag : '',
                    disabled: disabled,
                    'aria-describedby': description ? id + '-tag-help' : undefined,
                    onChange: function (event) { selection.onTag(event.target.value) },
                  },
                  h('option', { value: '' }, t('anySearch.chooseCapability')),
                  capabilities.items.map(function (entry) {
                    return h('option', { key: entry.tag, value: entry.tag }, anySearchLabel('tag', entry.tag, t))
                  })),
                )
              : null,
          ),
          !draft.domain
            ? h('span', { id: id + '-auto-hint', className: 'ds-anysearch-help' }, t('anySearch.autoHint'))
            : description && draft.domain !== 'general'
              ? h('span', { id: id + '-tag-help', className: 'ds-anysearch-help' }, description)
              : null,
          catalogStatus(domains.status, selection.retryDomains, false),
          draft.domain && domains.status !== 'error'
            ? catalogStatus(capabilities.status, selection.retryCapabilities, capabilities.status === 'ready' && !capabilities.items.length)
            : null,
          params.length ? h('div', { className: 'ds-anysearch-params', key: selected.tag },
            primary.length ? h('div', { className: 'ds-anysearch-param-grid', role: 'group', 'aria-label': t('anySearch.params') }, primary.map(field)) : null,
            optional.length ? h('details', { className: 'ds-anysearch-optional' },
              h('summary', null, t('anySearch.optionalParams')),
              h('div', { className: 'ds-anysearch-param-grid' }, optional.map(field)),
            ) : null,
          ) : null,
        )
      }

      // ======================================================================
      // 左栏：品牌 / 新建 / 深度 / 档案分组 / 底部状态
      // ======================================================================
      /**
       * 左侧栏。
       * @param {any} props 属性。
       * @returns {any}
       */
      function Rail(props) {
        const t = props.t
        const groups = props.groups || []
        const activeId = props.activeId
        const listStatus = props.listStatus
        const listError = props.listError
        const runningTopicId = props.runningTopicId
        return h(
          'aside',
          {
            className: 'ds-rail' + (props.open ? ' ds-rail-open' : ''),
            'aria-label': t('panel.label'),
            'data-open': props.open ? 'true' : 'false',
          },
          h(
            'div',
            { className: 'ds-rail-inner' },
            h(
              'div',
              { className: 'ds-brand' },
              h(BrandMark, { size: 20 }),
              h(
                'div',
                { className: 'ds-brand-text' },
                h('span', { className: 'ds-brand-name' }, t('panel.label')),
                h('span', { className: 'ds-brand-caption' }, t(props.onBackToSearch ? 'direct.history' : 'app.brandCaption')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-rail-close',
                  onClick: props.onCloseRail,
                  'aria-label': t('rail.close'),
                  title: t('rail.close'),
                },
                h(Icon, { name: 'close', size: 16 }),
              ),
            ),
            props.onBackToSearch ? h('div', { className: 'ds-new' },
              h('button', { type: 'button', className: 'ds-btn', onClick: props.onBackToSearch },
                h(Icon, { name: 'arrow-left', size: 15 }),
                h('span', null, t('direct.back')),
              ),
            ) : h(
              'form',
              {
                className: 'ds-new',
                onSubmit: function (event) {
                  if (event && event.preventDefault) event.preventDefault()
                  props.onStart()
                },
              },
              h('label', { className: 'ds-sr-only', htmlFor: 'ds-rail-query' }, t('rail.queryPlaceholder')),
              h(
                'div',
                { className: 'ds-new-box' },
                h(Icon, { name: 'search', size: 15, className: 'ds-new-icon' }),
                h('input', {
                  id: 'ds-rail-query',
                  className: 'ds-input ds-new-input',
                  type: 'text',
                  value: props.query,
                  placeholder: t('rail.queryPlaceholder'),
                  maxLength: 200,
                  disabled: props.starting,
                  onChange: function (event) {
                    props.onQuery(event.target.value)
                  },
                }),
              ),
              h(SearchProviderSelect, {
                ...props.provider,
                t: t,
                className: 'ds-search-provider ds-new-provider',
                labelClassName: 'ds-empty-control-label',
                disabled: props.starting,
              }),
              h(AnySearchFields, { selection: props.anySearch, disabled: props.starting, id: 'ds-rail-anysearch', t: t }),
              props.error ? h('div', { className: 'ds-empty-error', role: 'alert' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, props.error)) : null,
              h(
                'div',
                { className: 'ds-new-depth' },
                h(DepthSwitch, { value: props.depth, onChange: props.onDepth, disabled: props.starting }),
                h(
                  'button',
                  { type: 'submit', className: 'ds-btn ds-btn-primary ds-new-submit', disabled: props.starting || props.anySearch.blocked || !asString(props.query).trim() },
                  props.starting ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h(Icon, { name: 'arrow-right', size: 14 }),
                  h('span', null, props.starting ? t('empty.starting') : t('rail.start')),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ds-list-tools' },
              h(Icon, { name: 'search', size: 14, className: 'ds-list-tools-icon' }),
              h('input', {
                className: 'ds-input ds-list-search',
                type: 'search',
                value: props.listQuery,
                placeholder: t('rail.filterPlaceholder'),
                'aria-label': t('rail.filterPlaceholder'),
                onChange: function (event) {
                  props.onListQuery(event.target.value)
                },
              }),
              props.topicCount > 0 ? h('span', { className: 'ds-list-count' }, String(props.topicCount)) : null,
            ),
            h(
              'div',
              { className: 'ds-rail-list', role: 'navigation', 'aria-label': t('reading.back') },
              listStatus === 'loading'
                ? h('div', { className: 'ds-rail-list-state' }, h('span', { className: 'ds-spinner ds-spinner-sm' }), h('span', null, t('status.loading')))
                : listError
                  ? h(ErrorBlock, { text: listError, hint: t('error.routeHint'), onRetry: props.onRetryTopics, retryLabel: t('status.retry') })
                  : groups.length === 0
                    ? h(
                        'p',
                        { className: 'ds-rail-empty' },
                        props.topicCount > 0 ? t('rail.noMatch') : t('rail.emptyList'),
                      )
                    : groups.map(function (group) {
                        return h(
                          'section',
                          { key: group.id, className: 'ds-group' },
                          h('div', { className: 'ds-group-title' }, t(group.key), h('span', { className: 'ds-group-count' }, String(group.items.length))),
                          group.items.map(function (row) {
                            const active = asString(row.id) === asString(activeId)
                            const running = asString(row.id) === asString(runningTopicId) || asString(row.status) === 'running'
                            return h(
                              'button',
                              {
                                key: row.id,
                                type: 'button',
                                className: 'ds-topic-row' + (active ? ' ds-topic-active' : ''),
                                'data-topic-id': row.id,
                                'aria-current': active ? 'true' : undefined,
                                onClick: function () {
                                  props.onSelect(row.id)
                                },
                              },
                              h(
                                'span',
                                { className: 'ds-topic-title-row' },
                                h('span', { className: 'ds-status-dot', 'data-status': asString(row.status) || 'draft' }),
                                h('span', { className: 'ds-topic-title' }, asString(row.title) || asString(row.query) || row.id),
                                running ? h('span', { className: 'ds-topic-running' }, t('rail.runningBadge')) : null,
                              ),
                              h(
                                'span',
                                { className: 'ds-topic-meta' },
                                h('span', null, asString(row.query) && asString(row.query) !== asString(row.title) ? truncate(row.query, 22) : (TOPIC_KIND_KEYS[asString(row.kind)] ? t(TOPIC_KIND_KEYS[asString(row.kind)]) : t('status.unknown'))),
                                h('span', { className: 'ds-dot-sep' }),
                                h('span', null, t('rail.counts', { q: asNumber(row.questionCount, 0), s: asNumber(row.sourceCount, 0) })),
                                h('span', { className: 'ds-row-updated' }, relativeTime(row.updatedAt || row.createdAt)),
                              ),
                            )
                          }),
                        )
                      }),
            ),
            h(
              'div',
              { className: 'ds-rail-foot' },
              h(
                'div',
                { className: 'ds-foot-status' },
                h('span', { className: 'ds-status-dot', 'data-status': props.health ? 'done' : 'pending' }),
                h(
                  'span',
                  { className: 'ds-foot-text' },
                  props.health
                    ? t('rail.footer.searchMode') + ' ' + searchModeLabel(props.health.searchMode, t) + ' · ' + t('rail.footer.model') + ' ' + (asString(props.health.model) || '—')
                    : t('rail.footer.loading'),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-iconbtn',
                  onClick: props.onSettings,
                  title: t('rail.settings'),
                  'aria-label': t('rail.settings'),
                },
                h(Icon, { name: 'settings', size: 16 }),
              ),
            ),
          ),
        )
      }

      // ======================================================================
      // 空状态
      // ======================================================================
      /**
       * 空状态：标题 / 输入 / 深度 / 示例 / 方法论。
       * @param {any} props 属性。
       * @returns {any}
       */
      function EmptyView(props) {
        const t = props.t
        const examples = EXAMPLES
        return h(
          'div',
          { className: 'ds-empty', 'data-ds-view': 'empty' },
          h(
            'div',
            { className: 'ds-empty-inner' },
            h(
              'div',
              { className: 'ds-empty-eyebrow' },
              h(BrandMark, { size: 15 }),
              h('span', null, t('app.tagline')),
            ),
            h('h1', { className: 'ds-empty-title' }, t('empty.title')),
            h('p', { className: 'ds-empty-subtitle' }, t('empty.subtitle')),
            h(
              'form',
              {
                className: 'ds-empty-form',
                onSubmit: function (event) {
                  if (event && event.preventDefault) event.preventDefault()
                  props.onStart()
                },
              },
              h(
                'div',
                { className: 'ds-searchbox' },
                h(Icon, { name: 'search', size: 19, className: 'ds-searchbox-icon' }),
                h('input', {
                  id: 'ds-empty-query',
                  className: 'ds-searchbox-input',
                  type: 'text',
                  value: props.query,
                  placeholder: t('empty.placeholder'),
                  maxLength: 200,
                  disabled: props.starting,
                  'aria-label': t('empty.placeholder'),
                  onChange: function (event) {
                    props.onQuery(event.target.value)
                  },
                }),
                h(
                  'button',
                  { type: 'submit', className: 'ds-btn ds-btn-primary ds-searchbox-submit', disabled: props.starting || props.anySearch.blocked || !asString(props.query).trim() },
                  props.starting ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : null,
                  h('span', null, props.starting ? t('empty.starting') : t('empty.start')),
                ),
              ),
              h(
                'div',
                { className: 'ds-empty-controls' },
                h(
                  'div',
                  { className: 'ds-empty-depth' },
                  h('span', { className: 'ds-empty-control-label' }, t('rail.depth')),
                  h(DepthSwitch, { value: props.depth, onChange: props.onDepth, disabled: props.starting }),
                ),
                h(SearchProviderSelect, {
                  ...props.provider,
                  t: t,
                  className: 'ds-search-provider',
                  labelClassName: 'ds-empty-control-label',
                  disabled: props.starting,
                }),
                h('span', { className: 'ds-empty-kbd' }, t('empty.keyboard')),
                props.error ? h('div', { className: 'ds-empty-error', role: 'alert' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, props.error)) : null,
              ),
              h(AnySearchFields, { selection: props.anySearch, disabled: props.starting, id: 'ds-empty-anysearch', t: t }),
            ),
            h(
              'div',
              { className: 'ds-examples' },
              h('span', { className: 'ds-examples-label' }, t('empty.examples')),
              examples.map(function (example) {
                return h(
                  'button',
                  {
                    key: example.id,
                    type: 'button',
                    className: 'ds-example',
                    disabled: props.starting,
                    onClick: function () {
                      props.onExample(example.query)
                    },
                  },
                  h('span', { className: 'ds-example-label' }, t(example.labelKey)),
                  example.query === t(example.labelKey) ? null : h('span', { className: 'ds-example-query' }, example.query),
                )
              }),
            ),
            h(
              'div',
              { className: 'ds-empty-method' },
              h('span', { className: 'ds-empty-method-line' }),
              h('p', null, t('empty.method')),
              h('p', { className: 'ds-empty-chain' }, t('empty.chain')),
              h('span', { className: 'ds-empty-chain-caption' }, t('empty.chainCaption')),
            ),
          ),
        )
      }

      // ======================================================================
      // 运行态：阶段步骤条 / 进度 / 当前动作 / 日志 / 取消
      // ======================================================================
      /**
       * 运行态。
       * @param {any} props 属性。
       * @returns {any}
       */
      function RunningView(props) {
        const t = props.t
        const job = props.job || {}
        const status = asString(job.status) || 'queued'
        const stage = asString(job.stage)
        const stageIndex = STAGE_INDEX[stage]
        const terminal = TERMINAL_JOB_STATUS.indexOf(status) >= 0
        const failed = status === 'failed'
        const canceled = status === 'canceled'
        const current = asObject(job.current)
        const percent = Math.max(0, Math.min(100, Math.round(asNumber(job.progress, 0))))
        const logRef = useRef(null)
        const log = asArray(job.log).slice(-LOG_LIMIT)

        useEffect(
          function () {
            const node = logRef.current
            if (node) node.scrollTop = node.scrollHeight
          },
          [log.length],
        )

        return h(
          'div',
          { className: 'ds-running', 'data-ds-view': 'running' },
          h(
            'div',
            { className: 'ds-running-inner' },
            h(
              'header',
              { className: 'ds-running-head' },
              h(
                'div',
                { className: 'ds-running-status' },
                h('span', { className: 'ds-runtime-pill', 'data-status': status },
                  h('span', { className: 'ds-status-dot', 'data-status': status === 'done' ? 'done' : status }),
                  (JOB_STATUS_KEYS[status] ? t(JOB_STATUS_KEYS[status]) : status),
                ),
                job.startedAt && !terminal ? h('span', { className: 'ds-running-elapsed' }, t('running.time', { time: formatDuration(Date.now() - asNumber(Date.parse(asString(job.startedAt)), Date.now())) })) : null,
                job.searchProviderMode ? h('span', { className: 'ds-running-elapsed' }, t('settings.searchMode') + ' · ' + searchModeLabel(job.searchProviderMode, t)) : null,
                job.searchProviderMode === 'anysearch'
                  ? h('span', { className: 'ds-running-elapsed' }, job.anySearchTag ? anySearchLabel('tag', job.anySearchTag, t) : t('anySearch.auto'))
                  : null,
              ),
              h('h1', { className: 'ds-running-title' }, t('running.title', { title: asString(props.title) || asString(props.query) || '—' })),
              h('p', { className: 'ds-running-subtitle' }, t('running.subtitle')),
            ),
            h(
              'section',
              { className: 'ds-progress-card', 'aria-label': t('running.current') },
              h(
                'div',
                { className: 'ds-stages' },
                STAGES.map(function (item, index) {
                  let state = 'pending'
                  if (terminal && !failed && !canceled) state = 'done'
                  else if (typeof stageIndex === 'number') {
                    if (index < stageIndex) state = 'done'
                    else if (index === stageIndex) state = 'current'
                  } else if (status === 'running' || status === 'queued') {
                    state = 'pending'
                  }
                  return h(
                    'div',
                    { key: item.id, className: 'ds-stage', 'data-state': state },
                    h(
                      'div',
                      { className: 'ds-stage-line' },
                      h('span', { className: 'ds-stage-dot' }, state === 'done' ? h(Icon, { name: 'check', size: 11, strokeWidth: 2.4 }) : h('span', { className: 'ds-stage-dot-core' })),
                    ),
                    h('span', { className: 'ds-stage-label' }, t(item.key)),
                    h('span', { className: 'ds-stage-state' }, t('running.stage' + (state === 'done' ? 'Done' : state === 'current' ? 'Current' : 'Pending'))),
                  )
                }),
              ),
              h(
                'div',
                { className: 'ds-progress-row' },
                h(
                  'div',
                  { className: 'ds-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent },
                  h('span', { className: 'ds-progress-bar', style: { width: percent + '%' } }),
                ),
                h('span', { className: 'ds-progress-value' }, t('running.percent', { n: percent })),
              ),
              h(
                'div',
                { className: 'ds-current' },
                h('span', { className: 'ds-current-label' }, t('running.current')),
                h(
                  'span',
                  { className: 'ds-current-text' },
                  status === 'queued'
                    ? t('running.queued')
                    : canceled
                      ? t('running.canceled')
                      : asString(current.label) || (stage ? t('stage.hint.' + stage) : t('running.waiting')),
                ),
                current.total ? h('span', { className: 'ds-current-count' }, asNumber(current.index, 0) + '/' + asNumber(current.total, 0)) : null,
              ),
            ),
            failed
              ? h(ErrorBlock, {
                  text: asString(job.error) || t('running.failed'),
                  hint: t('running.failedHint'),
                  onRetry: props.onBack,
                  retryLabel: t('running.back'),
                })
              : null,
            h(
              'section',
              { className: 'ds-log' },
              h(
                'div',
                { className: 'ds-log-head' },
                h('span', { className: 'ds-log-title' }, t('running.log')),
                h('span', { className: 'ds-log-count' }, log.length > 0 ? t('running.logMore', { n: Math.min(log.length, LOG_LIMIT) }) : ''),
              ),
              h(
                'div',
                { className: 'ds-log-body', ref: logRef, role: 'log', 'aria-live': 'polite' },
                log.length === 0
                  ? h('div', { className: 'ds-log-empty' }, t('running.logEmpty'))
                  : log.map(function (entry, index) {
                      return h(
                        'div',
                        { key: 'log' + index, className: 'ds-log-line', 'data-level': asString(entry.level) || 'info' },
                        h('span', { className: 'ds-log-time' }, formatDateTime(entry.at).slice(11) || '—'),
                        h('span', { className: 'ds-log-text' }, asString(entry.text)),
                      )
                    }),
              ),
            ),
            h(
              'div',
              { className: 'ds-running-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-btn ds-btn-danger',
                  disabled: props.canceling || terminal,
                  onClick: props.onCancel,
                },
                h(Icon, { name: 'close', size: 14 }),
                h('span', null, props.canceling ? t('running.canceling') : t('running.cancel')),
              ),
              h(
                'button',
                { type: 'button', className: 'ds-btn ds-btn-ghost', onClick: props.onBack },
                h(Icon, { name: 'arrow-left', size: 14 }),
                h('span', null, t('running.back')),
              ),
            ),
          ),
        )
      }

      // 阅读态 / 抽屉 / 弹层 / PanelBody / CSS / apply 见后续片段。

      // ======================================================================
      // 阅读态：六模块（这是什么 / 大家在讨论什么 / 值得深入理解什么 /
      // 目前能确定什么 / 接下来值得查什么 / 资料来源）+ 注释 chip
      // ======================================================================

      /**
       * 章节导航（右侧竖向 + 窄屏横向共用）。
       * @param {{ t?: Function, sections: any[], active: string, onSelect: Function, counts: any, horizontal?: boolean }} props 属性。
       * @returns {any}
       */
      function SectionNav(props) {
        const t = props.t || tr
        return h(
          'nav',
          { className: props.horizontal ? 'ds-anchorbar' : 'ds-toc-nav', 'aria-label': t('reading.toc') },
          props.sections.map(function (section) {
            const active = section.id === props.active
            const count = props.counts ? props.counts[section.id] : null
            return h(
              'button',
              {
                key: section.id,
                type: 'button',
                className: 'ds-anchor' + (active ? ' ds-anchor-active' : ''),
                'aria-current': active ? 'true' : undefined,
                onClick: function () {
                  props.onSelect(section.id)
                },
              },
              h('span', { className: 'ds-anchor-label' }, t(section.key)),
              count != null ? h('span', { className: 'ds-anchor-count' }, String(count)) : null,
            )
          }),
        )
      }

      /**
       * 覆盖状态徽章。
       * @param {{ t: Function, status?: string }} props 属性。
       * @returns {any}
       */
      function CoverageBadge(props) {
        const status = COVERAGE_KEYS[asString(props.status)] ? asString(props.status) : 'missing'
        return h(
          'span',
          { className: 'ds-badge ds-coverage', 'data-status': status },
          props.t(COVERAGE_KEYS[status]),
        )
      }

      /**
       * 优先级徽章。
       * @param {{ t: Function, priority?: string }} props 属性。
       * @returns {any}
       */
      function PriorityBadge(props) {
        const priority = PRIORITY_KEYS[asString(props.priority)] ? asString(props.priority) : 'medium'
        return h(
          'span',
          { className: 'ds-badge ds-priority', 'data-priority': priority },
          props.t(PRIORITY_KEYS[priority]),
        )
      }

      /**
       * 问题覆盖状态徽章。
       * @param {{ t: Function, status?: string }} props 属性。
       * @returns {any}
       */
      function QuestionCoverageBadge(props) {
        const status = QUESTION_COVERAGE_KEYS[asString(props.status)] ? asString(props.status) : 'partial'
        return h(
          'span',
          { className: 'ds-badge ds-question-coverage', 'data-status': status },
          props.t(QUESTION_COVERAGE_KEYS[status]),
        )
      }

      /**
       * 论断证据状态徽章。
       * @param {{ t: Function, status?: string }} props 属性。
       * @returns {any}
       */
      function EvidenceStatusBadge(props) {
        const status = EVIDENCE_STATUS_KEYS[asString(props.status)] ? asString(props.status) : 'unsupported'
        return h(
          'span',
          { className: 'ds-badge ds-evidence-status', 'data-status': status },
          props.t(EVIDENCE_STATUS_KEYS[status]),
        )
      }

      /**
       * 分支状态徽章。
       * @param {{ t: Function, status?: string }} props 属性。
       * @returns {any}
       */
      function BranchStatusBadge(props) {
        const status = asString(props.status) === 'answered' ? 'answered' : 'open'
        return h(
          'span',
          { className: 'ds-badge ds-branch-status', 'data-status': status },
          props.t(status === 'answered' ? 'branchStatus.answered' : 'branchStatus.open'),
        )
      }

      /**
       * 读取范围标签。
       * @param {{ t: Function, scope?: string }} props 属性。
       * @returns {any}
       */
      function ReadScopeChip(props) {
        const scope = asString(props.scope)
        const key = READ_SCOPE_KEYS[scope]
        return h(
          'span',
          { className: 'ds-badge ds-readscope', 'data-scope': scope || 'unknown' },
          key ? props.t(key) : props.t('readScope.unknown'),
        )
      }

      /**
       * 注释编号 chip（正文里的 [n]，点击打开注释抽屉）。
       * @param {{ t: Function, numbers?: number[], onOpen: Function, className?: string }} props 属性。
       * @returns {any}
       */
      function NoteChips(props) {
        const numbers = asArray(props.numbers)
        if (numbers.length === 0) return null
        return h(
          'span',
          { className: 'ds-annots' + (props.className ? ' ' + props.className : '') },
          numbers.map(function (number) {
            return h(
              'button',
              {
                key: 'n' + number,
                type: 'button',
                className: 'ds-annot-chip',
                title: props.t('annotation.open', { n: number }),
                'aria-label': props.t('annotation.open', { n: number }),
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  props.onOpen(number)
                },
              },
              '[' + number + ']',
            )
          }),
        )
      }

      /**
       * 论断引用 chip（点击打开证据链抽屉）。
       * @param {{ t: Function, view: any, claimIds?: any[], onOpenChain: Function }} props 属性。
       * @returns {any}
       */
      function ClaimChips(props) {
        const ids = asArray(props.claimIds).filter(function (claimId) {
          return !!props.view.claimById[asString(claimId)]
        })
        if (ids.length === 0) return null
        return h(
          'span',
          { className: 'ds-claimchips' },
          ids.map(function (claimId) {
            const claim = props.view.claimById[asString(claimId)]
            return h(
              'button',
              {
                key: claimId,
                type: 'button',
                className: 'ds-claim-chip',
                title: truncate(asString(claim.statement), 160),
                onClick: function (event) {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  props.onOpenChain({ type: 'claim', id: asString(claimId) })
                },
              },
              asString(claimId),
            )
          }),
        )
      }

      /**
       * 一组来源对应的注释编号（去重、按编号排序）。
       * @param {any} view 视图模型。
       * @param {any[]} sourceIds 来源 id。
       * @returns {number[]}
       */
      function sourceNoteNumbers(view, sourceIds) {
        const numbers = []
        for (const sourceId of asArray(sourceIds)) {
          for (const number of asArray(view.sourceNumbers[asString(sourceId)])) {
            if (numbers.indexOf(number) < 0) numbers.push(number)
          }
        }
        numbers.sort(function (a, b) {
          return a - b
        })
        return numbers
      }

      /**
       * 问题层面的证据状态（由问题内 claims 归并）。
       * @param {any} view 视图模型。
       * @param {any} question 问题。
       * @returns {string} supported | limited | conflicted | unsupported | ''。
       */
      function questionEvidenceStatus(view, question) {
        const claims = asArray(view.claimsByQuestion[asString(question.id)])
        if (claims.length === 0) return ''
        let limited = false
        let supported = false
        for (const claim of claims) {
          const status = asString(claim.evidenceStatus)
          if (status === 'conflicted') return 'conflicted'
          if (status === 'supported') supported = true
          if (status === 'limited') limited = true
        }
        if (supported) return 'supported'
        if (limited) return 'limited'
        return 'unsupported'
      }

      /**
       * 覆盖说明（限制 / 说明 / 状态）。
       * @param {{ t: Function, status: string, note?: string, limits?: string, label: string }} props 属性。
       * @returns {any}
       */
      function CoverageNote(props) {
        if (props.status === 'covered' && !props.note && !props.limits) return null
        return h(
          'div',
          { className: 'ds-coverage-note', 'data-status': props.status },
          h(
            'div',
            { className: 'ds-coverage-head' },
            h('span', { className: 'ds-meta-label' }, props.label),
            h(CoverageBadge, { t: props.t, status: props.status }),
          ),
          props.note ? h('p', null, props.note) : null,
          props.limits
            ? h('p', null, h('span', { className: 'ds-meta-label' }, props.t('coverage.limits')), asString(props.limits))
            : null,
          !props.note && !props.limits
            ? h('p', { className: 'ds-muted' }, props.status === 'missing' ? props.t('coverage.missingHint') : props.t('coverage.partialHint'))
            : null,
        )
      }

      /**
       * 统计网格（右侧目录）。
       * @param {{ t: Function, view: any }} props 属性。
       * @returns {any}
       */
      function StatsGrid(props) {
        const t = props.t
        const view = props.view
        const stats = asObject(view.stats)
        const independent = asNumber(stats.independentSourceCount, 0)
        const unjudged = asNumber(stats.unjudgedSourceCount, 0)
        return h(
          'dl',
          { className: 'ds-stats' },
          h('div', { className: 'ds-stat' }, h('dt', null, t('reading.stats.questions')), h('dd', null, String(view.questions.length))),
          h('div', { className: 'ds-stat' }, h('dt', null, t('reading.stats.sources')), h('dd', null, String(view.sources.length))),
          h('div', { className: 'ds-stat' }, h('dt', null, t('reading.stats.annotations')), h('dd', null, String(view.annotationCount))),
          h(
            'div',
            { className: 'ds-stat' },
            h('dt', null, t('reading.stats.independent')),
            h(
              'dd',
              null,
              independent > 0 ? String(independent) : unjudged > 0 ? t('reading.stats.unjudgedOnly', { m: unjudged }) : '0',
              independent > 0 && unjudged > 0 ? h('span', { className: 'ds-stat-hint' }, t('reading.stats.unjudged', { m: unjudged })) : null,
            ),
          ),
          h('div', { className: 'ds-stat' }, h('dt', null, t('reading.stats.searches')), h('dd', null, t('reading.stats.searchesValue', { n: asNumber(stats.searches, 0) }))),
          h('div', { className: 'ds-stat' }, h('dt', null, t('reading.stats.duration')), h('dd', null, formatDuration(stats.durationMs))),
        )
      }

      /**
       * 阅读态。
       * @param {any} props 属性。
       * @returns {any}
       */
      function ReadingView(props) {
        const t = props.t
        const view = props.view
        const archive = view.archive
        const topic = view.topic
        const [exportOpen, setExportOpen] = useState(false)
        const exportRef = useRef(null)
        const kbCount = asArray(view.knowledgeBase).length
        const counts = {
          understanding: view.understanding.blocks.length,
          discussion: view.discussion.issues.length,
          questions: view.questions.length,
          judgments: view.judgments.length + view.unknowns.length + view.connections.length,
          branches: view.branches.length,
          sources: view.sources.length,
        }
        const minutes = asNumber(topic.readingMinutes, 0)
        const statusKey = ARCHIVE_STATUS_KEYS[asString(archive.status)]

        useEffect(
          function () {
            if (!exportOpen) return undefined
            function onPointerDown(event) {
              if (exportRef.current && !exportRef.current.contains(event.target)) setExportOpen(false)
            }
            document.addEventListener('mousedown', onPointerDown)
            return function () {
              document.removeEventListener('mousedown', onPointerDown)
            }
          },
          [exportOpen],
        )

        return h(
          'div',
          { className: 'ds-reading', 'data-ds-view': 'reading', 'data-topic': asString(archive.id) },
          h(
            'header',
            { className: 'ds-reading-head' },
            h(
              'div',
              { className: 'ds-reading-topline' },
              h(
                'button',
                { type: 'button', className: 'ds-backbtn', onClick: props.onBack },
                h(Icon, { name: 'arrow-left', size: 15 }),
                h('span', null, t('reading.back')),
              ),
              h(
                'div',
                { className: 'ds-reading-actions' },
                props.onAsk ? h(
                  'button',
                  { type: 'button', className: 'ds-btn ds-btn-primary ds-btn-sm', onClick: props.onAsk },
                  h(Icon, { name: 'ask', size: 14 }),
                  h('span', null, t('reading.actions.ask')),
                ) : null,
                props.onRefresh ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ds-btn ds-btn-sm' + (props.refreshing ? ' is-busy' : ''),
                    onClick: props.onRefresh,
                    disabled: props.refreshing,
                    title: t('reading.actions.refresh'),
                  },
                  props.refreshing ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h(Icon, { name: 'refresh', size: 14 }),
                  h('span', { className: 'ds-action-label' }, props.refreshing ? t('reading.refreshing') : t('reading.actions.refresh')),
                ) : null,
                h(
                  'div',
                  { className: 'ds-export', ref: exportRef },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ds-btn ds-btn-sm',
                      title: t('reading.actions.export'),
                      'aria-label': t('reading.actions.export'),
                      onClick: function () {
                        setExportOpen(!exportOpen)
                      },
                      'aria-expanded': exportOpen ? 'true' : 'false',
                      'aria-haspopup': 'menu',
                    },
                    h(Icon, { name: 'download', size: 14 }),
                    h('span', { className: 'ds-action-label' }, t('reading.actions.export')),
                    h(Icon, { name: 'chevron-down', size: 12 }),
                  ),
                  exportOpen
                    ? h(
                        'div',
                        { className: 'ds-menu', role: 'menu' },
                        EXPORT_FORMATS.map(function (format) {
                          return h(
                            'button',
                            {
                              key: format.id,
                              type: 'button',
                              role: 'menuitem',
                              className: 'ds-menu-item',
                              onClick: function () {
                                setExportOpen(false)
                                props.onExport(format.id)
                              },
                            },
                            h('span', null, t(format.key)),
                          )
                        }),
                      )
                    : null,
                ),
                props.onOpenKb ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ds-btn ds-btn-sm ds-kb-btn' + (kbCount > 0 ? ' ds-kb-saved' : ''),
                    onClick: props.onOpenKb,
                    title: kbCount > 0 ? t('kb.savedTitle', { n: kbCount }) : t('reading.actions.kb'),
                    'aria-label': kbCount > 0 ? t('kb.savedTitle', { n: kbCount }) : t('reading.actions.kb'),
                  },
                  h(Icon, { name: 'book', size: 14 }),
                  h('span', { className: 'ds-action-label' }, kbCount > 0 ? t('kb.savedButton') : t('reading.actions.kb')),
                  kbCount > 0 ? h('span', { className: 'ds-kb-dot', 'aria-hidden': 'true' }) : null,
                ) : null,
                props.onDelete ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ds-btn ds-btn-sm ds-btn-danger',
                    onClick: props.onDelete,
                    title: t('reading.actions.delete'),
                  },
                  h(Icon, { name: 'trash', size: 14 }),
                  h('span', { className: 'ds-action-label' }, t('reading.actions.delete')),
                ) : null,
              ),
            ),
            h(
              'div',
              { className: 'ds-reading-titleblock' },
              h(
                'div',
                { className: 'ds-reading-titlerow' },
                h('h1', { className: 'ds-reading-title' }, asString(topic.title) || asString(archive.input && archive.input.query) || archive.id),
                TOPIC_KIND_KEYS[asString(topic.kind)]
                  ? h('span', { className: 'ds-kind-badge', 'data-kind': asString(topic.kind) }, t(TOPIC_KIND_KEYS[asString(topic.kind)]))
                  : null,
                statusKey && asString(archive.status) !== 'done'
                  ? h('span', { className: 'ds-kind-badge ds-status-badge', 'data-status': asString(archive.status) }, t(statusKey))
                  : null,
              ),
              h(
                'div',
                { className: 'ds-reading-meta' },
                h('span', null, t('reading.meta', { questions: view.questions.length, sources: view.sources.length, minutes: Math.max(1, minutes) })),
                topic.cutoffAt ? h('span', { className: 'ds-meta-sep' }) : null,
                topic.cutoffAt ? h('span', null, t('reading.cutoff', { date: formatDate(topic.cutoffAt) })) : null,
                topic.depth ? h('span', { className: 'ds-meta-sep' }) : null,
                topic.depth ? h('span', null, t('reading.depth.' + asString(topic.depth)) || asString(topic.depth)) : null,
              ),
              asString(view.readingNote)
                ? h(
                    'p',
                    { className: 'ds-reading-note' },
                    h('span', { className: 'ds-meta-label' }, t('reading.noteLabel')),
                    asString(view.readingNote),
                  )
                : null,
            ),
          ),
          h(SectionNav, { t: t, sections: SECTIONS, active: props.activeSection, onSelect: props.onSection, counts: counts, horizontal: true }),
          h(
            'div',
            { className: 'ds-reading-grid' },
            h(
              'article',
              { className: 'ds-article' },
              h(UnderstandingSection, {
                t: t,
                view: view,
                onOpenChain: props.onOpenChain,
                onOpenSource: props.onOpenSource,
                onOpenAnnotation: props.onOpenAnnotation,
              }),
              h(DiscussionSection, {
                t: t,
                view: view,
                onOpenChain: props.onOpenChain,
                onOpenSource: props.onOpenSource,
                onOpenAnnotation: props.onOpenAnnotation,
              }),
              h(QuestionsSection, {
                t: t,
                view: view,
                highlight: props.highlight,
                onOpenChain: props.onOpenChain,
                onOpenAnnotation: props.onOpenAnnotation,
                onFollowup: props.onFollowup,
                onJumpQuestion: props.onJumpQuestion,
              }),
              h(JudgmentsSection, {
                t: t,
                view: view,
                onOpenChain: props.onOpenChain,
                onOpenSource: props.onOpenSource,
                onOpenAnnotation: props.onOpenAnnotation,
                onJumpQuestion: props.onJumpQuestion,
              }),
              h(BranchesSection, {
                t: t,
                view: view,
                onFollowup: props.onFollowup,
                onJumpQuestion: props.onJumpQuestion,
              }),
              h(SourcesSection, {
                t: t,
                view: view,
                onOpenSource: props.onOpenSource,
                onOpenAnnotation: props.onOpenAnnotation,
              }),
              props.onAsk ? h(
                'div',
                { className: 'ds-ask-cta' },
                h('div', { className: 'ds-ask-cta-text' }, t('reading.followupCta')),
                h(
                  'button',
                  { type: 'button', className: 'ds-btn ds-btn-primary', onClick: props.onAsk },
                  h(Icon, { name: 'ask', size: 15 }),
                  h('span', null, t('reading.actions.ask')),
                ),
              ) : null,
            ),
            h(
              'aside',
              { className: 'ds-toc', 'aria-label': t('reading.toc') },
              h(
                'div',
                { className: 'ds-toc-block' },
                h('div', { className: 'ds-toc-title' }, t('reading.toc')),
                h(SectionNav, { t: t, sections: SECTIONS, active: props.activeSection, onSelect: props.onSection, counts: counts }),
              ),
              h(
                'div',
                { className: 'ds-toc-block ds-toc-stats' },
                h('div', { className: 'ds-toc-title' }, t('reading.stats')),
                h(StatsGrid, { t: t, view: view }),
              ),
              h('p', { className: 'ds-toc-hint' }, t('reading.hint')),
            ),
          ),
        )
      }

      // ----------------------------------------------------------------------
      // 01 这是什么
      // ----------------------------------------------------------------------
      /**
       * 基础认识：summary / blocks / 实体 / 混淆项 / 时间线 / 覆盖限制。
       * @param {any} props 属性。
       * @returns {any}
       */
      function UnderstandingSection(props) {
        const t = props.t
        const view = props.view
        const understanding = view.understanding
        const blocks = understanding.blocks
        const entities = understanding.entities
        const confusables = understanding.confusables
        const timeline = understanding.timeline
        const hasContent = !!understanding.summary || blocks.length > 0
        return h(
          'section',
          { id: 'ds-section-understanding', className: 'ds-section', 'data-section': 'understanding' },
          h(SectionHead, { index: '01', title: t('section.understanding'), hint: t('understanding.hint') }),
          !hasContent ? h('p', { className: 'ds-muted' }, t('understanding.empty')) : null,
          understanding.summary
            ? h(
                'div',
                { className: 'ds-lead' },
                h('p', { className: 'ds-lead-text' }, understanding.summary, h(NoteChips, { t: t, numbers: view.summaryNumbers, onOpen: props.onOpenAnnotation })),
              )
            : null,
          asString(view.topic.scope) || asString(view.topic.exclusions)
            ? h(
                'dl',
                { className: 'ds-topic-facts' },
                asString(view.topic.scope)
                  ? h('div', null, h('dt', null, t('understanding.scope')), h('dd', null, asString(view.topic.scope)))
                  : null,
                asString(view.topic.exclusions)
                  ? h('div', null, h('dt', null, t('understanding.exclusions')), h('dd', null, asString(view.topic.exclusions)))
                  : null,
              )
            : null,
          blocks.length > 0
            ? h(
                'div',
                { className: 'ds-blocks' },
                blocks.map(function (block) {
                  const kindKey = BLOCK_KIND_KEYS[asString(block.kind)] || BLOCK_KIND_KEYS.definition
                  const kindLabel = t(kindKey)
                  const numbers = asArray(view.annotations.blockNumbers[asString(block.id)])
                  return h(
                    'article',
                    { key: block.id, className: 'ds-block', 'data-kind': block.kind },
                    h(
                      'div',
                      { className: 'ds-block-head' },
                      block.title && block.title !== kindLabel ? h('span', { className: 'ds-block-kind' }, kindLabel) : null,
                      h('h3', { className: 'ds-block-title' }, block.title || kindLabel),
                    ),
                    h('p', { className: 'ds-block-text' }, block.text, h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation })),
                    block.claimIds.length > 0
                      ? h('div', { className: 'ds-block-foot' }, h(ClaimChips, { t: t, view: view, claimIds: block.claimIds, onOpenChain: props.onOpenChain }))
                      : null,
                  )
                }),
              )
            : null,
          entities.length > 0
            ? h(
                'div',
                { className: 'ds-subblock' },
                h(
                  'div',
                  { className: 'ds-subhead' },
                  h('h3', null, t('understanding.entities')),
                  h('span', { className: 'ds-subhead-hint' }, String(entities.length)),
                ),
                h(
                  'div',
                  { className: 'ds-entities' },
                  entities.map(function (entity) {
                    const numbers = sourceNoteNumbers(view, entity.sourceIds)
                    return h(
                      'span',
                      { key: entity.id, className: 'ds-entity-chip', title: asString(entity.role) },
                      h('span', { className: 'ds-entity-name' }, entity.name),
                      entity.role ? h('span', { className: 'ds-entity-role' }, entity.role) : null,
                      h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }),
                      h(ClaimChips, { t: t, view: view, claimIds: entity.claimIds, onOpenChain: props.onOpenChain }),
                    )
                  }),
                ),
              )
            : null,
          confusables.length > 0
            ? h(
                'div',
                { className: 'ds-subblock' },
                h('div', { className: 'ds-subhead' }, h('h3', null, t('understanding.confusables'))),
                h(
                  'div',
                  { className: 'ds-confusables' },
                  confusables.map(function (item) {
                    const numbers = sourceNoteNumbers(view, item.sourceIds)
                    return h(
                      'div',
                      { key: item.id, className: 'ds-confusable' },
                      h(
                        'div',
                        { className: 'ds-confusable-head' },
                        h('span', { className: 'ds-confusable-term' }, item.term),
                        item.confusedWith ? h('span', { className: 'ds-confusable-with' }, '↔ ' + item.confusedWith) : null,
                      ),
                      item.note ? h('p', { className: 'ds-confusable-note' }, item.note, h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation })) : null,
                    )
                  }),
                ),
              )
            : null,
          timeline.length > 0
            ? h(
                'div',
                { className: 'ds-subblock' },
                h('div', { className: 'ds-subhead' }, h('h3', null, t('understanding.timeline'))),
                h(
                  'ol',
                  { className: 'ds-timeline' },
                  timeline.map(function (item) {
                    const numbers = sourceNoteNumbers(view, item.sourceIds)
                    return h(
                      'li',
                      { key: item.id, className: 'ds-timeline-item' },
                      h('span', { className: 'ds-timeline-at' }, item.at),
                      h(
                        'span',
                        { className: 'ds-timeline-text' },
                        item.text,
                        numbers.length > 0
                          ? h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation })
                          : asArray(item.sourceIds).map(function (sourceId) {
                              const source = view.sourceById[asString(sourceId)]
                              return source ? h(SourceChip, { key: sourceId, source: source, onOpen: props.onOpenSource }) : null
                            }),
                      ),
                    )
                  }),
                ),
              )
            : null,
          h(CoverageNote, {
            t: t,
            status: understanding.coverage.status,
            note: understanding.coverage.note,
            limits: understanding.coverage.limits,
            label: t('understanding.coverage'),
          }),
        )
      }

      // ----------------------------------------------------------------------
      // 02 大家在讨论什么
      // ----------------------------------------------------------------------
      /**
       * 讨论地图：范围条 + 议题卡片。
       * @param {any} props 属性。
       * @returns {any}
       */
      function DiscussionSection(props) {
        const t = props.t
        const view = props.view
        const discussion = view.discussion
        const scope = discussion.scope
        const issues = discussion.issues
        const scopeItems = [
          { key: 'discussion.window', value: scope.window },
          { key: 'discussion.platforms', value: scope.platforms.length > 0 ? scope.platforms.join(' / ') : '' },
          { key: 'discussion.languages', value: scope.languages.length > 0 ? scope.languages.join(' / ') : '' },
          { key: 'discussion.materials', value: scope.materialCount > 0 ? String(scope.materialCount) : '' },
          { key: 'discussion.speakers', value: scope.speakerCount > 0 ? String(scope.speakerCount) : '' },
          { key: 'discussion.checkedAt', value: formatDateTime(scope.checkedAt) || formatDate(scope.checkedAt) },
        ]
        return h(
          'section',
          { id: 'ds-section-discussion', className: 'ds-section', 'data-section': 'discussion' },
          h(SectionHead, { index: '02', title: t('section.discussion'), hint: t('discussion.hint'), count: issues.length }),
          h(
            'div',
            { className: 'ds-scope' },
            scopeItems.map(function (item) {
              return h(
                'div',
                { key: item.key, className: 'ds-scope-item' },
                h('span', { className: 'ds-scope-key' }, t(item.key)),
                h('span', { className: 'ds-scope-value' }, item.value || '—'),
              )
            }),
            h(
              'div',
              { className: 'ds-scope-item ds-scope-limits' },
              h('span', { className: 'ds-scope-key' }, t('discussion.limits')),
              h('span', { className: 'ds-scope-value' }, scope.limits || '—'),
            ),
          ),
          h(CoverageNote, {
            t: t,
            status: discussion.coverage.status,
            note: discussion.coverage.note,
            limits: discussion.coverage.limits,
            label: t('discussion.status'),
          }),
          issues.length === 0
            ? h(
                'div',
                { className: 'ds-empty-block' },
                h('p', { className: 'ds-muted' }, t('discussion.empty')),
                h('p', { className: 'ds-muted' }, t('discussion.emptyHint')),
              )
            : h(
                'div',
                { className: 'ds-issues' },
                issues.map(function (issue) {
                  return h(DiscussionIssue, {
                    key: issue.id,
                    t: t,
                    view: view,
                    issue: issue,
                    onOpenChain: props.onOpenChain,
                    onOpenAnnotation: props.onOpenAnnotation,
                  })
                }),
              ),
        )
      }

      /**
       * 单个讨论议题。
       * @param {any} props 属性。
       * @returns {any}
       */
      function DiscussionIssue(props) {
        const t = props.t
        const view = props.view
        const issue = props.issue
        return h(
          'article',
          { className: 'ds-issue', 'data-status': issue.status },
          h(
            'div',
            { className: 'ds-issue-head' },
            h('h3', { className: 'ds-issue-question' }, issue.question),
            h('span', { className: 'ds-spacer' }),
            h(CoverageBadge, { t: t, status: issue.status }),
          ),
          issue.summary ? h('p', { className: 'ds-issue-summary' }, issue.summary) : null,
          issue.items.length > 0
            ? h(
                'div',
                { className: 'ds-items' },
                issue.items.map(function (item) {
                  const numbers = asArray(view.annotations.itemNumbers[asString(item.id)])
                  return h(
                    'div',
                    { key: item.id, className: 'ds-item' },
                    h(
                      'div',
                      { className: 'ds-item-head' },
                      h('span', { className: 'ds-item-speaker' }, item.speaker || t('discussion.speakerUnknown')),
                      item.affiliation ? h('span', { className: 'ds-item-affiliation' }, item.affiliation) : null,
                      h('span', { className: 'ds-badge ds-discussion-identity', 'data-identity': item.identity }, t(DISCUSSION_IDENTITY_KEYS[item.identity])),
                      item.at || item.channel
                        ? h('span', { className: 'ds-item-meta' }, [item.at, item.channel].filter(Boolean).join(' · '))
                        : null,
                    ),
                    item.view
                      ? h('p', { className: 'ds-item-view' }, item.view, h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }))
                      : null,
                    item.basis
                      ? h('p', { className: 'ds-item-basis' }, h('span', { className: 'ds-meta-label' }, t('discussion.basis')), item.basis)
                      : null,
                    item.claimIds.length > 0
                      ? h('div', { className: 'ds-item-foot' }, h(ClaimChips, { t: t, view: view, claimIds: item.claimIds, onOpenChain: props.onOpenChain }))
                      : null,
                  )
                }),
              )
            : null,
          issue.sides.length > 1
            ? h(
                'div',
                { className: 'ds-sides' },
                issue.sides.map(function (side, index) {
                  const key = asString(issue.id) + ':' + index
                  return h(
                    'div',
                    { key: key, className: 'ds-side' },
                    h('span', { className: 'ds-side-label' }, String.fromCharCode(65 + index)),
                    h('p', { className: 'ds-side-position' }, side.position),
                    side.holders.length > 0
                      ? h('p', { className: 'ds-side-holders' }, h('span', null, t('discussion.holders')), side.holders.join('、'))
                      : null,
                    h(NoteChips, { t: t, numbers: asArray(view.annotations.sideNumbers[key]), onOpen: props.onOpenAnnotation }),
                  )
                }),
              )
            : null,
          issue.disagreement.origin || issue.disagreement.note
            ? h(
                'div',
                { className: 'ds-issue-disagreement' },
                h('span', { className: 'ds-meta-label' }, t('discussion.disagreement')),
                h('span', { className: 'ds-disagreement-origin' }, issue.disagreement.origin || '—'),
                issue.disagreement.note ? h('p', null, issue.disagreement.note) : null,
              )
            : null,
          issue.gaps
            ? h('p', { className: 'ds-issue-gaps' }, h('span', { className: 'ds-meta-label' }, t('discussion.gaps')), issue.gaps)
            : null,
        )
      }

      // ----------------------------------------------------------------------
      // 03 值得深入理解什么
      // ----------------------------------------------------------------------
      /**
       * 问题地图 + 研究单元。
       * @param {any} props 属性。
       * @returns {any}
       */
      function QuestionsSection(props) {
        const t = props.t
        const view = props.view
        const questions = view.questions
        return h(
          'section',
          { id: 'ds-section-questions', className: 'ds-section', 'data-section': 'questions' },
          h(SectionHead, { index: '03', title: t('section.questions'), hint: t('questions.hint'), count: questions.length }),
          questions.length === 0
            ? h('p', { className: 'ds-muted' }, t('questions.empty'))
            : h(
                'div',
                null,
                h('div', { className: 'ds-subhead' }, h('h3', null, t('questions.map'))),
                h(
                  'div',
                  { className: 'ds-qmap' },
                  questions.map(function (question) {
                    const evidenceStatus = questionEvidenceStatus(view, question)
                    const relation = asObject(question.relation)
                    const to = asString(relation.to)
                    const relationKey = RELATION_KEYS[asString(relation.kind)]
                    return h(
                      'button',
                      {
                        key: question.id,
                        type: 'button',
                        className: 'ds-qmap-row',
                        onClick: function () {
                          props.onJumpQuestion(asString(question.id))
                        },
                      },
                      h('span', { className: 'ds-qmap-order' }, pad2(asNumber(question.order, 0))),
                      h(
                        'span',
                        { className: 'ds-qmap-main' },
                        h(
                          'span',
                          { className: 'ds-qmap-q' },
                          asString(question.question),
                          h('span', { className: 'ds-qmap-id' }, asString(question.id)),
                        ),
                        asString(question.summary) ? h('span', { className: 'ds-qmap-summary' }, question.summary) : null,
                        h(
                          'span',
                          { className: 'ds-qmap-meta' },
                          h(PriorityBadge, { t: t, priority: question.priority }),
                          h(QuestionCoverageBadge, { t: t, status: question.coverage }),
                          evidenceStatus ? h(EvidenceStatusBadge, { t: t, status: evidenceStatus }) : null,
                          ROLE_KEYS[asString(question.role)] ? h('span', { className: 'ds-qmap-role' }, t(ROLE_KEYS[asString(question.role)])) : null,
                          to && relationKey ? h('span', { className: 'ds-qmap-relation' }, t('map.relationFrom', { id: to }) + ' · ' + t(relationKey)) : null,
                        ),
                      ),
                      h(Icon, { name: 'chevron-right', size: 14, className: 'ds-qmap-chevron' }),
                    )
                  }),
                ),
                h('div', { className: 'ds-subhead ds-subhead-units' }, h('h3', null, t('questions.units'))),
                h(
                  'div',
                  { className: 'ds-units' },
                  questions.map(function (question) {
                    return h(QuestionUnit, {
                      key: question.id,
                      t: t,
                      view: view,
                      question: question,
                      highlighted: asArray(props.highlight).indexOf(asString(question.id)) >= 0,
                      onOpenChain: props.onOpenChain,
                      onOpenAnnotation: props.onOpenAnnotation,
                      onFollowup: props.onFollowup,
                      onJumpQuestion: props.onJumpQuestion,
                    })
                  }),
                ),
              ),
        )
      }

      /**
       * 单个问题的研究单元。
       * @param {any} props 属性。
       * @returns {any}
       */
      function QuestionUnit(props) {
        const t = props.t
        const view = props.view
        const question = props.question
        const claims = asArray(view.claimsByQuestion[asString(question.id)])
        const evidenceStatus = questionEvidenceStatus(view, question)
        const unitId = domId('q', asString(question.id))
        const relation = asObject(question.relation)
        const to = asString(relation.to)
        const relationKey = RELATION_KEYS[asString(relation.kind)]
        return h(
          'article',
          {
            id: unitId,
            className: 'ds-unit' + (props.highlighted ? ' ds-unit-new' : ''),
            'data-question-id': asString(question.id),
            'aria-labelledby': unitId + '-title',
          },
          props.highlighted ? h('span', { className: 'ds-new-flag' }, t('reading.newContent')) : null,
          h(
            'header',
            { className: 'ds-unit-head' },
            h('span', { className: 'ds-unit-index' }, pad2(asNumber(question.order, 0))),
            h(
              'div',
              { className: 'ds-unit-headtext' },
              h(
                'div',
                { className: 'ds-unit-kicker' },
                h(PriorityBadge, { t: t, priority: question.priority }),
                h(QuestionCoverageBadge, { t: t, status: question.coverage }),
                evidenceStatus ? h(EvidenceStatusBadge, { t: t, status: evidenceStatus }) : null,
                QUESTION_STATUS_KEYS[question.workStatus] ? h('span', { className: 'ds-qstatus', 'data-status': asString(question.workStatus) }, t(QUESTION_STATUS_KEYS[question.workStatus])) : null,
                ROLE_KEYS[asString(question.role)] ? h('span', { className: 'ds-role' }, t(ROLE_KEYS[asString(question.role)])) : null,
                asString(question.confidence) ? h('span', { className: 'ds-unit-confidence' }, t('map.confidence', { level: CONFIDENCE_KEYS[asString(question.confidence)] ? t(CONFIDENCE_KEYS[asString(question.confidence)]) : asString(question.confidence) })) : null,
              ),
              h('h3', { className: 'ds-unit-question', id: unitId + '-title' }, asString(question.question)),
              asString(question.why) ? h('p', { className: 'ds-unit-why' }, h('span', null, t('questions.why')), asString(question.why)) : null,
              asString(question.evidenceNeed) ? h('p', { className: 'ds-unit-need' }, h('span', null, t('questions.evidenceNeed')), asString(question.evidenceNeed)) : null,
              to && relationKey
                ? h('p', { className: 'ds-unit-relation' }, t('map.relationFrom', { id: to }) + ' · ' + t(relationKey), asString(relation.note) ? h('span', { className: 'ds-unit-relation-note' }, asString(relation.note)) : null)
                : null,
            ),
          ),
          h(
            'div',
            { className: 'ds-claims' },
            claims.length > 0
              ? claims.map(function (claim) {
                  return h(ClaimCard, {
                    key: claim.id,
                    t: t,
                    view: view,
                    claim: claim,
                    onOpenChain: props.onOpenChain,
                    onOpenAnnotation: props.onOpenAnnotation,
                  })
                })
              : h('p', { className: 'ds-muted' }, t('questions.emptyEvidence')),
          ),
          asArray(question.mechanism).length > 0
            ? h(
                'div',
                { className: 'ds-mechanism' },
                h('h4', { className: 'ds-block-title' }, t('questions.mechanism')),
                asArray(question.mechanism).map(function (item, index) {
                  return h(
                    'p',
                    { key: asString(item.id) || 'm' + index, className: 'ds-mechanism-p' },
                    asString(item.text),
                    h(ClaimChips, { t: t, view: view, claimIds: item.claimIds, onOpenChain: props.onOpenChain }),
                  )
                }),
              )
            : null,
          asArray(question.counterpoints).length > 0
            ? h(
                'div',
                { className: 'ds-callout ds-callout-counter' },
                h('h4', null, t('questions.counterpoints')),
                asArray(question.counterpoints).map(function (item, index) {
                  return h(
                    'p',
                    { key: asString(item.id) || 'cp' + index },
                    asString(item.text),
                    asString(item.condition) ? h('span', { className: 'ds-callout-condition' }, t('questions.conditions') + ' · ' + asString(item.condition)) : null,
                  )
                }),
              )
            : null,
          asArray(question.gaps).length > 0
            ? h(
                'div',
                { className: 'ds-gaps' },
                h('h4', { className: 'ds-block-title' }, t('questions.gaps')),
                asArray(question.gaps).map(function (gap) {
                  return h(
                    'div',
                    { key: gap.id, className: 'ds-gap' },
                    h('div', { className: 'ds-gap-text' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, asString(gap.text))),
                    asString(gap.whyItMatters) ? h('p', { className: 'ds-gap-why' }, h('span', null, t('research.gapWhy')), asString(gap.whyItMatters)) : null,
                    asString(gap.howToClose) ? h('p', { className: 'ds-gap-how' }, h('span', null, t('research.gapHow')), asString(gap.howToClose)) : null,
                  )
                }),
              )
            : null,
          asArray(question.branchList).length > 0
            ? h(
                'div',
                { className: 'ds-branches ds-branches-inline' },
                h('h4', { className: 'ds-block-title' }, t('questions.branches')),
                asArray(question.branchList).map(function (branch) {
                  return h(BranchItem, {
                    key: branch.id,
                    t: t,
                    view: view,
                    branch: branch,
                    compact: true,
                    onFollowup: props.onFollowup,
                    onJumpQuestion: props.onJumpQuestion,
                  })
                }),
              )
            : null,
        )
      }

      /**
       * 论断卡片。
       * @param {any} props 属性。
       * @returns {any}
       */
      function ClaimCard(props) {
        const t = props.t
        const view = props.view
        const claim = props.claim
        const numbers = asArray(view.annotations.claimNumbers[asString(claim.id)])
        const open = function () {
          props.onOpenChain({ type: 'claim', id: asString(claim.id) })
        }
        return h(
          'div',
          {
            className: 'ds-claim',
            role: 'button',
            tabIndex: 0,
            'data-identity': claim.identity,
            'data-status': claim.evidenceStatus,
            onClick: open,
            onKeyDown: function (event) {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              }
            },
          },
          h(
            'div',
            { className: 'ds-claim-head' },
            h('span', { className: 'ds-mini-label' }, t('questions.claims')),
            h('span', { className: 'ds-claim-id' }, asString(claim.id)),
            h('span', { className: 'ds-spacer' }),
            h(IdentityBadge, { identity: claim.identity }),
            h(ConfidenceBadge, { confidence: claim.confidence }),
            h(EvidenceStatusBadge, { t: t, status: claim.evidenceStatus }),
            h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }),
          ),
          h('p', { className: 'ds-claim-text' }, asString(claim.statement)),
          asString(claim.attribution)
            ? h('p', { className: 'ds-claim-meta' }, h('span', null, t('questions.attribution')), asString(claim.attribution))
            : null,
          asString(claim.basis)
            ? h('p', { className: 'ds-claim-meta' }, h('span', null, t('questions.basis')), asString(claim.basis))
            : null,
          asString(claim.scope)
            ? h('p', { className: 'ds-claim-meta' }, h('span', null, t('questions.scope')), asString(claim.scope))
            : null,
          asString(claim.conditions)
            ? h('p', { className: 'ds-claim-meta ds-claim-conditions' }, h('span', null, t('questions.conditions')), asString(claim.conditions))
            : null,
        )
      }

      // ----------------------------------------------------------------------
      // 04 目前能确定什么
      // ----------------------------------------------------------------------
      /**
       * 判断 / 未知 / 关联。
       * @param {any} props 属性。
       * @returns {any}
       */
      function JudgmentsSection(props) {
        const t = props.t
        const view = props.view
        const judgments = view.judgments
        const unknowns = view.unknowns
        const connections = view.connections
        const empty = judgments.length === 0 && unknowns.length === 0 && connections.length === 0
        return h(
          'section',
          { id: 'ds-section-judgments', className: 'ds-section', 'data-section': 'judgments' },
          h(SectionHead, {
            index: '04',
            title: t('section.judgments'),
            hint: t('judgments.hint'),
            count: judgments.length + unknowns.length + connections.length,
          }),
          empty ? h('p', { className: 'ds-muted' }, t('judgments.emptyAll')) : null,
          asArray(view.tensions).length > 0
            ? h(
                'div',
                { className: 'ds-tensions ds-judgment-tensions' },
                h('span', { className: 'ds-tensions-label' }, t('reading.tensions')),
                h(
                  'ul',
                  { className: 'ds-tension-list' },
                  asArray(view.tensions).slice(0, 3).map(function (tension, index) {
                    return h('li', { key: 'tension' + index, className: 'ds-tension' }, asString(tension))
                  }),
                ),
              )
            : null,
          judgments.length > 0
            ? h(
                'div',
                { className: 'ds-judgments' },
                judgments.map(function (judgment) {
                  const numbers = asArray(view.annotations.judgmentNumbers[asString(judgment.id)])
                  const open = function () {
                    props.onOpenChain({ type: 'judgment', id: asString(judgment.id) })
                  }
                  return h(
                    'div',
                    {
                      key: judgment.id,
                      className: 'ds-judgment',
                      role: 'button',
                      tabIndex: 0,
                      onClick: open,
                      onKeyDown: function (event) {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          open()
                        }
                      },
                    },
                    h(
                      'div',
                      { className: 'ds-judgment-head' },
                      h(IdentityBadge, { identity: judgment.identity }),
                      h(ConfidenceBadge, { confidence: judgment.confidence }),
                      judgment.stale ? h('span', { className: 'ds-badge ds-stale' }, t('judgments.stale')) : null,
                      h('span', { className: 'ds-spacer' }),
                      asNumber(judgment.independentSources, 0) > 0
                        ? h('span', { className: 'ds-meta-item' }, t('overview.independent', { n: asNumber(judgment.independentSources, 0) }))
                        : null,
                      h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }),
                    ),
                    h('p', { className: 'ds-judgment-text' }, asString(judgment.text)),
                    asString(judgment.conditions) ? h('p', { className: 'ds-claim-meta ds-claim-conditions' }, h('span', null, t('judgments.conditions')), asString(judgment.conditions)) : null,
                    asString(judgment.note) ? h('p', { className: 'ds-judgment-note' }, asString(judgment.note)) : null,
                  )
                }),
              )
            : null,
          unknowns.length > 0
            ? h(
                'div',
                { className: 'ds-unknowns' },
                h('div', { className: 'ds-subhead' }, h('h3', null, t('judgments.unknowns')), h('span', { className: 'ds-subhead-hint' }, String(unknowns.length))),
                unknowns.map(function (unknown) {
                  return h(
                    'div',
                    { key: unknown.id, className: 'ds-unknown' },
                    h(
                      'div',
                      { className: 'ds-unknown-head' },
                      h('span', { className: 'ds-unknown-id' }, asString(unknown.id)),
                      h('p', { className: 'ds-unknown-text' }, asString(unknown.text)),
                      asString(unknown.questionId)
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'ds-dispute-qref',
                              onClick: function () {
                                props.onJumpQuestion(asString(unknown.questionId))
                              },
                            },
                            t('disputes.unknownQuestion', { id: asString(unknown.questionId) }),
                          )
                        : null,
                    ),
                    asString(unknown.whyItMatters) ? h('p', { className: 'ds-unknown-row' }, h('span', null, t('judgments.unknownWhy')), asString(unknown.whyItMatters)) : null,
                    asString(unknown.howToClose) ? h('p', { className: 'ds-unknown-row' }, h('span', null, t('judgments.unknownHow')), asString(unknown.howToClose)) : null,
                  )
                }),
              )
            : null,
          connections.length > 0
            ? h(
                'div',
                { className: 'ds-connections' },
                h('div', { className: 'ds-subhead' }, h('h3', null, t('judgments.connections')), h('span', { className: 'ds-subhead-hint' }, String(connections.length))),
                connections.map(function (connection) {
                  const status = asString(connection.status) || 'unverified'
                  const fromQuestion = view.questionById[asString(connection.from)]
                  const claimIds = asArray(connection.claimIds)
                  const numbers = sourceNoteNumbers(view, connection.sourceIds)
                  return h(
                    'div',
                    { key: connection.id, className: 'ds-connection', 'data-status': status },
                    h(
                      'div',
                      { className: 'ds-connection-head' },
                      h('span', { className: 'ds-connection-kind' }, CONNECTION_KIND_KEYS[asString(connection.kind)] ? t(CONNECTION_KIND_KEYS[asString(connection.kind)]) : asString(connection.kind)),
                      fromQuestion
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'ds-connection-from',
                              onClick: function () {
                                props.onJumpQuestion(asString(connection.from))
                              },
                            },
                            t('connections.from', { id: asString(connection.from) }),
                          )
                        : h('span', { className: 'ds-connection-from' }, t('connections.from', { id: asString(connection.from) })),
                      h(Icon, { name: 'arrow-right', size: 13, className: 'ds-connection-arrow' }),
                      h('span', { className: 'ds-connection-to' }, t('connections.to', { to: asString(connection.to) })),
                      h('span', { className: 'ds-spacer' }),
                      h('span', { className: 'ds-connection-status', 'data-status': status }, CONNECTION_STATUS_KEYS[status] ? t(CONNECTION_STATUS_KEYS[status]) : status),
                    ),
                    asString(connection.mechanism) ? h('p', { className: 'ds-connection-mechanism' }, asString(connection.mechanism)) : null,
                    h(
                      'div',
                      { className: 'ds-connection-foot' },
                      h(ClaimChips, { t: t, view: view, claimIds: claimIds, onOpenChain: props.onOpenChain }),
                      h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }),
                      asArray(connection.sourceIds).map(function (sourceId) {
                        const source = view.sourceById[asString(sourceId)]
                        return source ? h(SourceChip, { key: sourceId, source: source, onOpen: props.onOpenSource }) : null
                      }),
                    ),
                    asString(connection.note) ? h('p', { className: 'ds-connection-note' }, h('span', null, t('connections.note')), asString(connection.note)) : null,
                  )
                }),
              )
            : null,
        )
      }

      // ----------------------------------------------------------------------
      // 05 接下来值得查什么
      // ----------------------------------------------------------------------
      /**
       * 分支列表。
       * @param {any} props 属性。
       * @returns {any}
       */
      function BranchesSection(props) {
        const t = props.t
        const view = props.view
        const branches = view.sortedBranches
        return h(
          'section',
          { id: 'ds-section-branches', className: 'ds-section', 'data-section': 'branches' },
          h(SectionHead, { index: '05', title: t('section.branches'), hint: t('branches.hint'), count: branches.length }),
          branches.length === 0
            ? h('p', { className: 'ds-muted' }, t('branches.empty'))
            : h(
                'div',
                { className: 'ds-branches' },
                branches.map(function (branch) {
                  return h(BranchItem, {
                    key: branch.id,
                    t: t,
                    view: view,
                    branch: branch,
                    onFollowup: props.onFollowup,
                    onJumpQuestion: props.onJumpQuestion,
                  })
                }),
              ),
        )
      }

      /**
       * 单条分支。
       * @param {any} props 属性。
       * @returns {any}
       */
      function BranchItem(props) {
        const t = props.t
        const view = props.view
        const branch = props.branch
        const question = view.questionById[asString(branch.questionId)]
        return h(
          'div',
          { className: 'ds-branch' + (props.compact ? ' ds-branch-compact' : ''), 'data-status': branch.status, 'data-priority': branch.priority },
          h(
            'div',
            { className: 'ds-branch-main' },
            h(
              'div',
              { className: 'ds-branch-head' },
              h(PriorityBadge, { t: t, priority: branch.priority }),
              h(BranchStatusBadge, { t: t, status: branch.status }),
              question
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ds-branch-qref',
                      onClick: function () {
                        props.onJumpQuestion(asString(question.id))
                      },
                    },
                    t('branches.question', { id: asString(question.id) }),
                  )
                : null,
            ),
            h('p', { className: 'ds-branch-text' }, asString(branch.text)),
            asString(branch.hook)
              ? h('p', { className: 'ds-branch-hook' }, h('span', null, t('branches.hook')), asString(branch.hook))
              : null,
            branch.status === 'answered' && asString(branch.answeredBy)
              ? h('p', { className: 'ds-branch-hook' }, h('span', null, t('branchStatus.answered')), asString(branch.answeredBy))
              : null,
          ),
          branch.status !== 'answered' && props.onFollowup
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ds-btn ds-btn-sm ds-btn-ghost ds-branch-search',
                  onClick: function () {
                    props.onFollowup({ text: asString(branch.text), hook: asString(branch.hook), priority: branch.priority })
                  },
                },
                h(Icon, { name: 'search', size: 13 }),
                h('span', null, t('branches.search')),
              )
            : null,
        )
      }

      // ----------------------------------------------------------------------
      // 06 资料来源
      // ----------------------------------------------------------------------
      /**
       * 来源表：按注释编号排序，可按模块 / 引用状态筛选。
       * @param {any} props 属性。
       * @returns {any}
       */
      function SourcesSection(props) {
        const t = props.t
        const view = props.view
        const [filter, setFilter] = useState('all')
        useEffect(
          function () {
            setFilter('all')
          },
          [asString(view.archive.id), asString(view.archive.updatedAt)],
        )
        const rows = []
        for (const source of view.sources) {
          const annotations = asArray(view.annotations.bySourceId[asString(source.id)])
            .map(function (item) {
              return view.annotationByNumber[asNumber(item.number, 0)]
            })
            .filter(Boolean)
          const numbers = []
          const modules = []
          const scopes = []
          for (const entry of annotations) {
            if (numbers.indexOf(entry.number) < 0) numbers.push(entry.number)
            if (asString(entry.module) && modules.indexOf(asString(entry.module)) < 0) modules.push(asString(entry.module))
            if (asString(entry.readScope) && scopes.indexOf(asString(entry.readScope)) < 0) scopes.push(asString(entry.readScope))
          }
          numbers.sort(function (a, b) {
            return a - b
          })
          rows.push({
            source: source,
            numbers: numbers,
            modules: modules,
            scopes: scopes,
            first: numbers.length > 0 ? numbers[0] : Number.MAX_SAFE_INTEGER,
          })
        }
        const filters = [
          { id: 'all', key: 'sources.all' },
          { id: 'cited', key: 'sources.cited' },
          { id: 'uncited', key: 'sources.uncited' },
          { id: 'understanding', key: 'module.understanding' },
          { id: 'discussion', key: 'module.discussion' },
          { id: 'question', key: 'module.question' },
          { id: 'judgment', key: 'module.judgment' },
        ]
        const visible = rows
          .filter(function (row) {
            if (filter === 'all') return true
            if (filter === 'cited') return row.numbers.length > 0
            if (filter === 'uncited') return row.numbers.length === 0
            return row.modules.indexOf(filter) >= 0
          })
          .sort(function (a, b) {
            if (a.first !== b.first) return a.first - b.first
            return asString(a.source.title).localeCompare(asString(b.source.title))
          })
        const uncitedCount = rows.filter(function (row) {
          return row.numbers.length === 0
        }).length
        return h(
          'section',
          { id: 'ds-section-sources', className: 'ds-section', 'data-section': 'sources' },
          h(SectionHead, {
            index: '06',
            title: t('section.sources'),
            hint: t('sources.hint'),
            count: view.sources.length,
          }),
          view.sources.length === 0
            ? h('p', { className: 'ds-muted' }, t('sources.empty'))
            : h(
                'div',
                { className: 'ds-source-tools' },
                h('span', { className: 'ds-source-tools-label' }, t('sources.module')),
                h(
                  'div',
                  { className: 'ds-filter-chips', role: 'group', 'aria-label': t('sources.module') },
                  filters.map(function (item) {
                    const active = filter === item.id
                    return h(
                      'button',
                      {
                        key: item.id,
                        type: 'button',
                        className: 'ds-filter-chip' + (active ? ' ds-filter-active' : ''),
                        'aria-pressed': active ? 'true' : 'false',
                        onClick: function () {
                          setFilter(item.id)
                        },
                      },
                      t(item.key),
                    )
                  }),
                ),
                h('span', { className: 'ds-source-tools-hint' }, t('sources.sortByNumber'), uncitedCount > 0 ? ' · ' + t('sources.uncited') + ' ' + uncitedCount : ''),
              ),
          view.sources.length > 0
            ? h(
                'div',
                { className: 'ds-sources-wrap' },
                h(
                  'table',
                  { className: 'ds-sources ds-sources-wide' },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { className: 'ds-th-number' }, t('sources.col.number')),
                      h('th', { className: 'ds-th-title' }, t('sources.col.title')),
                      h('th', null, t('sources.col.publisher')),
                      h('th', null, t('sources.col.author')),
                      h('th', null, t('sources.col.date')),
                      h('th', null, t('sources.col.kind')),
                      h('th', null, t('sources.col.independence')),
                      h('th', null, t('sources.col.scope')),
                      h('th', null, t('sources.col.used')),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    visible.map(function (row) {
                      const source = row.source
                      return h(
                        'tr',
                        {
                          key: source.id,
                          className: 'ds-source-row' + (row.numbers.length === 0 ? ' ds-source-supplementary' : ''),
                          tabIndex: 0,
                          onClick: function () {
                            props.onOpenSource(asString(source.id))
                          },
                          onKeyDown: function (event) {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              props.onOpenSource(asString(source.id))
                            }
                          },
                        },
                        h(
                          'td',
                          { className: 'ds-td-number' },
                          row.numbers.length > 0
                            ? h(NoteChips, { t: t, numbers: row.numbers, onOpen: props.onOpenAnnotation })
                            : h('span', { className: 'ds-source-supplementary-badge' }, t('sources.supplementary')),
                        ),
                        h(
                          'td',
                          { className: 'ds-td-title' },
                          h('span', { className: 'ds-source-title-text' }, asString(source.title) || asString(source.url)),
                          h('span', { className: 'ds-source-id' }, asString(source.id)),
                        ),
                        h('td', null, asString(source.publisher) || hostOf(source.url) || '—'),
                        h('td', null, asString(source.author) || '—'),
                        h('td', { className: 'ds-td-nowrap' }, formatDate(source.publishedAt) || '—'),
                        h('td', null, SOURCE_KIND_KEYS[asString(source.kind)] ? t(SOURCE_KIND_KEYS[asString(source.kind)]) : asString(source.kind) || '—'),
                        h('td', null, INDEPENDENCE_KEYS[asString(source.independence)] ? t(INDEPENDENCE_KEYS[asString(source.independence)]) : '—'),
                        h(
                          'td',
                          null,
                          row.scopes.length > 0
                            ? row.scopes
                                .map(function (scope) {
                                  return READ_SCOPE_KEYS[scope] ? t(READ_SCOPE_KEYS[scope]) : scope
                                })
                                .join(' / ')
                            : '—',
                        ),
                        h(
                          'td',
                          { className: 'ds-td-used' },
                          row.modules.length > 0
                            ? row.modules
                                .map(function (module) {
                                  return MODULE_KEYS[module] ? t(MODULE_KEYS[module]) : module
                                })
                                .join(' · ')
                            : t('sources.citedNone'),
                        ),
                      )
                    }),
                  ),
                ),
              )
            : null,
          visible.length === 0 && view.sources.length > 0 ? h('p', { className: 'ds-muted' }, t('sources.emptyFilter')) : null,
          view.anySearchRecords.length ? h(
            'div',
            { className: 'ds-anysearch-records', 'aria-labelledby': 'ds-anysearch-records-title' },
            h('h3', { id: 'ds-anysearch-records-title' }, t('anySearch.records')),
            h('p', { className: 'ds-muted' }, t('anySearch.recordHint')),
            h('ul', null, view.anySearchRecords.map(function (record, index) {
              const title = asString(record.title) || asString(record.query) || t('anySearch.records')
              const metadata = [
                asString(record.tag) ? anySearchLabel('tag', asString(record.tag), t) : '',
                formatDateTime(record.capturedAt),
                asString(record.query) !== title ? asString(record.query) : '',
              ].filter(Boolean).join(' · ')
              return h('li', { key: index }, h('details', { open: view.anySearchRecords.length === 1 || undefined },
                h('summary', null, title),
                metadata ? h('p', { className: 'ds-anysearch-help' }, metadata) : null,
                h('p', { className: 'ds-anysearch-record-content' }, asString(record.content)),
              ))
            })),
          ) : null,
        )
      }

      // ======================================================================
      // 抽屉：证据链 / 来源
      // ======================================================================

      /**
       * 右侧抽屉外壳。
       * @param {any} props 属性（title / subtitle / onClose / onBack / children）。
       * @returns {any}
       */
      function DrawerShell(props) {
        const t = props.t
        const titleId = props.titleId || 'ds-drawer-title'
        return h(
          'div',
          { className: 'ds-drawer-layer' },
          h('div', { className: 'ds-drawer-scrim', onClick: props.onClose, 'aria-hidden': 'true' }),
          h(
            'aside',
            {
              className: 'ds-drawer',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': titleId,
            },
            h(
              'header',
              { className: 'ds-drawer-head' },
              props.onBack
                ? h(
                    'button',
                    { type: 'button', className: 'ds-drawer-back', onClick: props.onBack, title: t('status.back') },
                    h(Icon, { name: 'arrow-left', size: 15 }),
                    h('span', null, props.backLabel || t('status.back')),
                  )
                : null,
              h(
                'div',
                { className: 'ds-drawer-titles' },
                h('h2', { className: 'ds-drawer-title', id: titleId }, props.title),
                props.subtitle ? h('p', { className: 'ds-drawer-subtitle' }, props.subtitle) : null,
              ),
              h(
                'button',
                { type: 'button', className: 'ds-iconbtn ds-drawer-close', onClick: props.onClose, title: t('status.close'), 'aria-label': t('status.close') },
                h(Icon, { name: 'close', size: 16 }),
              ),
            ),
            h('div', { className: 'ds-drawer-body' }, props.children),
          ),
        )
      }

      /**
       * 模块名称文案。
       * @param {Function} t 翻译函数。
       * @param {string} module 模块 id。
       * @returns {string}
       */
      function moduleText(t, module) {
        const key = MODULE_KEYS[asString(module)]
        return key ? t(key) : asString(module)
      }

      /**
       * 注释使用位置文案。
       * @param {Function} t 翻译函数。
       * @param {any} usage 使用位置。
       * @returns {string}
       */
      function annotationUsageLabel(t, usage) {
        const kind = asString(usage && usage.kind)
        const title = asString(usage && usage.title)
        if (kind === 'summary') return t('annotation.usedSummary')
        if (kind === 'block') return t('annotation.usedUnderstanding', { title: title || t('annotation.untitledBlock') })
        if (kind === 'item' || kind === 'side') return t('annotation.usedDiscussion', { title: title || t('annotation.untitledIssue') })
        if (kind === 'claim') return t('annotation.usedClaim', { id: asString(usage.claimId) || asString(usage.id) })
        if (kind === 'judgment') return t('annotation.usedJudgment')
        if (kind === 'question') return t('annotation.usedQuestion', { id: asString(usage.id) })
        return t('annotation.usedOther')
      }

      /**
       * 证据链抽屉：claim / evidence / judgment / question / branch。
       * @param {any} props 属性（view / chainRef / onClose / onBack / onOpenSource / onOpenQuestion）。
       * @returns {any}
       */
      function ChainDrawer(props) {
        const t = props.t
        const chain = useMemo(
          function () {
            return buildChain(props.view, props.chainRef)
          },
          [props.view, props.chainRef],
        )
        const body = !chain
          ? h(
              'div',
              { className: 'ds-chain-empty' },
              h(Icon, { name: 'alert', size: 18 }),
              h('p', null, t('chain.empty')),
            )
          : h(
              'div',
              { className: 'ds-chain' },
              h(
                'div',
                { className: 'ds-chain-theme' },
                h('span', { className: 'ds-chain-label' }, t('chain.theme')),
                h('h3', null, asString(chain.topic.title)),
                asString(chain.topic.definition) ? h('p', null, asString(chain.topic.definition)) : null,
              ),
              chain.branch
                ? h(
                    'div',
                    { className: 'ds-chain-node' },
                    h(
                      'div',
                      { className: 'ds-chain-node-head' },
                      h('span', { className: 'ds-chain-label' }, t('chain.branch')),
                      h(BranchStatusBadge, { t: t, status: asString(chain.branch.status) }),
                      h('span', { className: 'ds-spacer' }),
                    ),
                    h('p', { className: 'ds-chain-question-text' }, asString(chain.branch.text)),
                    asString(chain.branch.hook) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('branches.hook')), asString(chain.branch.hook)) : null,
                  )
                : null,
              chain.question
                ? h(
                    'div',
                    { className: 'ds-chain-node ds-chain-question' },
                    h(
                      'div',
                      { className: 'ds-chain-node-head' },
                      h('span', { className: 'ds-chain-label' }, t('chain.question') + ' ' + asString(chain.question.id)),
                      h('button', {
                        type: 'button',
                        className: 'ds-chain-open',
                        onClick: function () {
                          props.onOpenQuestion(asString(chain.question.id))
                        },
                      }, t('chain.openQuestion'), h(Icon, { name: 'chevron-right', size: 11 })),
                    ),
                    h('p', { className: 'ds-chain-question-text' }, asString(chain.question.question)),
                    asString(chain.question.why) ? h('p', { className: 'ds-chain-note' }, asString(chain.question.why)) : null,
                  )
                : null,
              chain.claims.length > 0
                ? h(
                    'div',
                    { className: 'ds-chain-group' },
                    h('div', { className: 'ds-chain-group-title' }, t('chain.claims'), h('span', null, String(chain.claims.length))),
                    chain.claims.map(function (claim) {
                      const numbers = asArray(props.view.annotations.claimNumbers[asString(claim.id)])
                      return h(
                        'div',
                        { key: claim.id, className: 'ds-chain-node ds-chain-claim' },
                        h(
                          'div',
                          { className: 'ds-chain-node-head' },
                          h('span', { className: 'ds-chain-label' }, t('chain.claim') + ' ' + asString(claim.id)),
                          h('span', { className: 'ds-spacer' }),
                          h(IdentityBadge, { identity: claim.identity }),
                          h(ConfidenceBadge, { confidence: claim.confidence }),
                          h(EvidenceStatusBadge, { t: t, status: claim.evidenceStatus }),
                          h(NoteChips, { t: t, numbers: numbers, onOpen: props.onOpenAnnotation }),
                        ),
                        h('p', { className: 'ds-chain-conclusion-text' }, asString(claim.statement)),
                        asString(claim.attribution) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('chain.attribution')), asString(claim.attribution)) : null,
                        asString(claim.basis) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('chain.basis')), asString(claim.basis)) : null,
                        asString(claim.conditions) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('chain.conditions')), asString(claim.conditions)) : null,
                      )
                    }),
                  )
                : null,
              chain.judgment
                ? h(
                    'div',
                    { className: 'ds-chain-node ds-chain-judgment' },
                    h(
                      'div',
                      { className: 'ds-chain-node-head' },
                      h('span', { className: 'ds-chain-label' }, t('chain.judgment') + ' ' + asString(chain.judgment.id)),
                      h('span', { className: 'ds-spacer' }),
                      h(IdentityBadge, { identity: chain.judgment.identity }),
                      h(ConfidenceBadge, { confidence: chain.judgment.confidence }),
                      chain.judgment.stale ? h('span', { className: 'ds-badge ds-stale' }, t('judgments.stale')) : null,
                      h(NoteChips, {
                        t: t,
                        numbers: asArray(props.view.annotations.judgmentNumbers[asString(chain.judgment.id)]),
                        onOpen: props.onOpenAnnotation,
                      }),
                    ),
                    h('p', { className: 'ds-chain-conclusion-text' }, asString(chain.judgment.text)),
                    asString(chain.judgment.conditions)
                      ? h('p', { className: 'ds-chain-note' }, h('span', null, t('chain.conditions')), asString(chain.judgment.conditions))
                      : null,
                    asString(chain.judgment.note) ? h('p', { className: 'ds-chain-note' }, asString(chain.judgment.note)) : null,
                  )
                : null,
              h(
                'div',
                { className: 'ds-chain-group' },
                h('div', { className: 'ds-chain-group-title' }, t('chain.support'), h('span', null, String(chain.support.length))),
                chain.support.length === 0
                  ? h('p', { className: 'ds-muted' }, t('chain.noEvidence'))
                  : chain.support.map(function (item, index) {
                      return h(ChainEvidence, {
                        key: 'sup' + index,
                        t: t,
                        view: props.view,
                        item: item,
                        stance: 'support',
                        onOpenSource: props.onOpenSource,
                        onOpenAnnotation: props.onOpenAnnotation,
                      })
                    }),
              ),
              h(
                'div',
                { className: 'ds-chain-group' },
                h('div', { className: 'ds-chain-group-title' }, t('chain.oppose'), h('span', null, String(chain.oppose.length))),
                chain.oppose.length === 0
                  ? h('p', { className: 'ds-muted' }, t('chain.noEvidence'))
                  : chain.oppose.map(function (item, index) {
                      return h(ChainEvidence, {
                        key: 'opp' + index,
                        t: t,
                        view: props.view,
                        item: item,
                        stance: 'oppose',
                        onOpenSource: props.onOpenSource,
                        onOpenAnnotation: props.onOpenAnnotation,
                      })
                    }),
              ),
              h(
                'div',
                { className: 'ds-chain-group' },
                h('div', { className: 'ds-chain-group-title' }, t('chain.sources'), h('span', null, String(chain.sources.length))),
                chain.sources.length === 0
                  ? h('p', { className: 'ds-muted' }, t('chain.noEvidence'))
                  : h(
                      'div',
                      { className: 'ds-chain-sources' },
                      chain.sources.map(function (source) {
                        return h(SourceChip, { key: source.id, source: source, onOpen: props.onOpenSource })
                      }),
                    ),
              ),
              h(
                'div',
                { className: 'ds-chain-group' },
                h('div', { className: 'ds-chain-group-title' }, t('chain.gaps'), h('span', null, String(chain.gaps.length))),
                chain.gaps.length === 0
                  ? h('p', { className: 'ds-muted' }, t('chain.noGaps'))
                  : chain.gaps.map(function (gap) {
                      return h(
                        'div',
                        { key: gap.id, className: 'ds-chain-gap' },
                        h('div', { className: 'ds-chain-gap-text' }, h(Icon, { name: 'alert', size: 13 }), h('span', null, asString(gap.text))),
                        asString(gap.whyItMatters) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('chain.why')), asString(gap.whyItMatters)) : null,
                        asString(gap.howToClose) ? h('p', { className: 'ds-chain-note' }, h('span', null, t('research.gapHow')), asString(gap.howToClose)) : null,
                      )
                    }),
              ),
            )
        return h(
          DrawerShell,
          {
            t: t,
            title: t('chain.title'),
            subtitle: t('chain.subtitle'),
            onClose: props.onClose,
            onBack: props.onBack,
            backLabel: props.backLabel || t('chain.backToChain'),
            titleId: 'ds-chain-title',
          },
          body,
        )
      }

      /**
       * 证据链中的一条证据。
       * @param {{ t: Function, view: any, item: any, stance: string, onOpenSource: Function, onOpenAnnotation: Function }} props 属性。
       * @returns {any}
       */
      function ChainEvidence(props) {
        const t = props.t
        const item = props.item
        const evidence = item.evidence
        if (!evidence) return null
        const annotationEntry = props.view.annotations.byEvidenceId[asString(evidence.id)]
        const annotation = annotationEntry ? annotationEntry.number : null
        return h(
          'div',
          { className: 'ds-chain-evidence', 'data-stance': props.stance },
          h(
            'div',
            { className: 'ds-chain-evidence-head' },
            h('span', { className: 'ds-stance', 'data-stance': props.stance }, t('stance.' + props.stance)),
            h(IdentityBadge, { identity: evidence.identity }),
            STRENGTH_KEYS[asString(evidence.strength)] ? h('span', { className: 'ds-chain-strength' }, t(STRENGTH_KEYS[asString(evidence.strength)])) : null,
            h(
              'span',
              { className: 'ds-chain-independent', 'data-unjudged': independentCount(evidence, props.view.sourceById) === 0 ? 'true' : 'false' },
              independentCount(evidence, props.view.sourceById) > 0
                ? t('overview.independent', { n: independentCount(evidence, props.view.sourceById) })
                : t('independence.unjudged'),
            ),
            annotation != null
              ? h(NoteChips, { t: t, numbers: [annotation], onOpen: props.onOpenAnnotation })
              : null,
            evidence.id ? h('span', { className: 'ds-chain-id' }, evidence.id) : null,
          ),
          h('p', { className: 'ds-chain-evidence-text' }, asString(evidence.text)),
          asString(evidence.quote) ? h('blockquote', { className: 'ds-chain-quote' }, asString(evidence.quote)) : null,
          h(
            'div',
            { className: 'ds-chain-sources' },
            asArray(item.sources).map(function (source) {
              return h(SourceChip, { key: source.id, source: source, onOpen: props.onOpenSource })
            }),
          ),
        )
      }

      /**
       * 注释抽屉：编号 / 来源 / 定位 / 摘录 / 读取范围 / 被用于哪些论断。
       * @param {any} props 属性（view / number / onClose / onBack / onOpenSource / onOpenChain）。
       * @returns {any}
       */
      function AnnotationDrawer(props) {
        const t = props.t
        const view = props.view
        const entry = view.annotationByNumber[asNumber(props.number, 0)]
        if (!entry) {
          return h(
            DrawerShell,
            { t: t, title: t('annotation.title', { n: asNumber(props.number, 0) }), onClose: props.onClose, onBack: props.onBack, backLabel: props.backLabel || t('status.back'), titleId: 'ds-annotation-title' },
            h('p', { className: 'ds-muted' }, t('annotation.empty')),
          )
        }
        const sources = asArray(entry.sourceIds)
          .map(function (sourceId) {
            return view.sourceById[asString(sourceId)]
          })
          .filter(Boolean)
        const scopeKey = READ_SCOPE_KEYS[asString(entry.readScope)]
        return h(
          DrawerShell,
          {
            t: t,
            title: t('annotation.title', { n: entry.number }),
            subtitle: t('annotation.subtitle', { count: sources.length, module: moduleText(t, entry.module) }),
            onClose: props.onClose,
            onBack: props.onBack,
            backLabel: props.backLabel || t('status.back'),
            titleId: 'ds-annotation-title',
          },
          h(
            'div',
            { className: 'ds-annotation' },
            h(
              'div',
              { className: 'ds-annotation-meta' },
              h('span', { className: 'ds-annotation-number' }, '[' + entry.number + ']'),
              h(IdentityBadge, { identity: entry.identity }),
              h(ReadScopeChip, { t: t, scope: entry.readScope }),
              h('span', { className: 'ds-annotation-meta-item' }, t('annotation.locator') + ' · ' + (entry.locator || '—')),
              h('span', { className: 'ds-annotation-meta-item' }, t('annotation.retrievedAt') + ' · ' + (formatDateTime(entry.retrievedAt) || '—')),
            ),
            h('p', { className: 'ds-annotation-text' }, asString(entry.text)),
            h(
              'div',
              { className: 'ds-annotation-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-btn ds-btn-sm ds-btn-ghost',
                  onClick: function () {
                    props.onOpenChain({ type: 'evidence', id: asString(entry.evidenceId) })
                  },
                },
                h(Icon, { name: 'link', size: 13 }),
                h('span', null, t('annotation.openChain')),
              ),
            ),
            asString(entry.quote)
              ? h(
                  'section',
                  { className: 'ds-annotation-section' },
                  h('h4', { className: 'ds-block-title' }, t('annotation.quote')),
                  h('blockquote', { className: 'ds-source-quote' }, asString(entry.quote)),
                )
              : h(
                  'section',
                  { className: 'ds-annotation-section' },
                  h('h4', { className: 'ds-block-title' }, t('annotation.quote')),
                  h('p', { className: 'ds-muted' }, t('annotation.noQuote', { scope: scopeKey ? t(scopeKey) : t('readScope.unknown') })),
                ),
            h(
              'section',
              { className: 'ds-annotation-section' },
              h('h4', { className: 'ds-block-title' }, t('annotation.sources'), h('span', { className: 'ds-block-count' }, String(sources.length))),
              sources.length === 0
                ? h('p', { className: 'ds-muted' }, t('annotation.unknownSource'))
                : sources.map(function (source) {
                    const href = safeHref(source.url)
                    return h(
                      'div',
                      { key: source.id, className: 'ds-annotation-source' },
                      h(
                        'div',
                        { className: 'ds-annotation-source-head' },
                        href
                          ? h(
                              'a',
                              { className: 'ds-annotation-source-title', href: href, target: '_blank', rel: 'noreferrer noopener' },
                              asString(source.title) || asString(source.url),
                              h(Icon, { name: 'external', size: 12 }),
                            )
                          : h('span', { className: 'ds-annotation-source-title' }, asString(source.title) || source.id),
                        h('span', { className: 'ds-chain-id' }, asString(source.id)),
                      ),
                      h(
                        'p',
                        { className: 'ds-annotation-source-meta' },
                        [asString(source.publisher) || hostOf(source.url), asString(source.author), formatDate(source.publishedAt)].filter(Boolean).join(' · ') || '—',
                      ),
                      h(
                        'div',
                        { className: 'ds-source-tags' },
                        SOURCE_KIND_KEYS[asString(source.kind)] ? h('span', { className: 'ds-badge ds-badge-neutral' }, t('annotation.sourceKind') + ' · ' + t(SOURCE_KIND_KEYS[asString(source.kind)])) : null,
                        INDEPENDENCE_KEYS[asString(source.independence)] ? h('span', { className: 'ds-badge ds-badge-neutral' }, t('sourceDrawer.independence') + ' · ' + t(INDEPENDENCE_KEYS[asString(source.independence)])) : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ds-linkbtn ds-annotation-source-open',
                            onClick: function () {
                              props.onOpenSource(asString(source.id))
                            },
                          },
                          t('annotation.sourceOpen'),
                          h(Icon, { name: 'chevron-right', size: 11 }),
                        ),
                      ),
                    )
                  }),
            ),
            h(
              'section',
              { className: 'ds-annotation-section' },
              h('h4', { className: 'ds-block-title' }, t('annotation.usedBy'), h('span', { className: 'ds-block-count' }, String(entry.usedBy.length))),
              entry.usedBy.length === 0
                ? h('p', { className: 'ds-muted' }, t('annotation.usedOther'))
                : h(
                    'div',
                    { className: 'ds-annotation-usages' },
                    entry.usedBy.map(function (usage, index) {
                      const clickable = usage.kind === 'claim' || usage.kind === 'judgment' || usage.kind === 'question'
                      return h(
                        'div',
                        { key: asString(usage.key) || 'u' + index, className: 'ds-annotation-usage' },
                        h('span', { className: 'ds-annotation-usage-label' }, annotationUsageLabel(t, usage)),
                        clickable
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'ds-linkbtn',
                                onClick: function () {
                                  if (usage.kind === 'claim') props.onOpenChain({ type: 'claim', id: asString(usage.claimId || usage.id) })
                                  else if (usage.kind === 'judgment') props.onOpenChain({ type: 'judgment', id: asString(usage.id) })
                                  else props.onOpenChain({ type: 'question', id: asString(usage.id) })
                                },
                              },
                              t('chain.open'),
                              h(Icon, { name: 'chevron-right', size: 11 }),
                            )
                          : null,
                      )
                    }),
                  ),
            ),
          ),
        )
      }

      /**
       * 来源抽屉：元信息 / 作者 / 摘要 / 原文摘录 / 注释位置 / 读取范围 / 获取时间。
       * @param {any} props 属性（view / sourceId / onClose / onBack / onOpenChain / onOpenAnnotation）。
       * @returns {any}
       */
      function SourceDrawer(props) {
        const t = props.t
        const view = props.view
        const source = view.sourceById[asString(props.sourceId)]
        if (!source) {
          return h(
            DrawerShell,
            { t: t, title: t('sourceDrawer.title'), onClose: props.onClose, onBack: props.onBack, backLabel: props.backLabel || t('status.back'), titleId: 'ds-source-title' },
            h('p', { className: 'ds-muted' }, t('sourceDrawer.none')),
          )
        }
        const annotations = asArray(view.annotations.bySourceId[asString(source.id)])
          .map(function (item) {
            return view.annotationByNumber[asNumber(item.number, 0)]
          })
          .filter(Boolean)
        const scopes = []
        const locators = []
        for (const entry of annotations) {
          if (entry.readScope && scopes.indexOf(entry.readScope) < 0) scopes.push(entry.readScope)
          if (entry.locator && locators.indexOf(entry.locator) < 0) locators.push(entry.locator)
        }
        const usages = sourceUsages(view, asString(source.id))
        const href = safeHref(source.url)
        const fetchInfo = asObject(source.fetch)
        const fetched = !!fetchInfo.ok
        return h(
          DrawerShell,
          {
            t: t,
            title: t('sourceDrawer.title'),
            subtitle: asString(source.publisher) || hostOf(source.url),
            onClose: props.onClose,
            onBack: props.onBack,
            backLabel: props.backLabel || t('status.back'),
            titleId: 'ds-source-title',
          },
          h(
            'div',
            { className: 'ds-source-detail' },
            h(
              'div',
              { className: 'ds-source-detail-head' },
              h('h3', { className: 'ds-source-detail-title' }, asString(source.title) || asString(source.url) || source.id),
              h(
                'div',
                { className: 'ds-source-detail-meta' },
                h('span', null, t('sourceDrawer.meta', { publisher: asString(source.publisher) || hostOf(source.url) || '—', date: formatDate(source.publishedAt) || '—' })),
                source.id ? h('span', { className: 'ds-chain-id' }, source.id) : null,
              ),
              h(
                'div',
                { className: 'ds-source-tags' },
                SOURCE_KIND_KEYS[asString(source.kind)] ? h('span', { className: 'ds-badge ds-badge-neutral' }, t(SOURCE_KIND_KEYS[asString(source.kind)])) : null,
                INDEPENDENCE_KEYS[asString(source.independence)] ? h('span', { className: 'ds-badge ds-badge-neutral' }, t('sourceDrawer.independence') + ' · ' + t(INDEPENDENCE_KEYS[asString(source.independence)])) : null,
                RELIABILITY_KEYS[asString(source.reliability)] ? h('span', { className: 'ds-badge ds-badge-neutral' }, t('sourceDrawer.reliability') + ' · ' + t(RELIABILITY_KEYS[asString(source.reliability)])) : null,
                h('span', { className: 'ds-badge ds-badge-neutral', 'data-fetched': fetched ? 'true' : 'false' }, fetched ? t('sourceDrawer.fetched', { chars: asNumber(fetchInfo.chars, 0) }) : t('sourceDrawer.fetchFailed')),
              ),
              href
                ? h(
                    'a',
                    { className: 'ds-source-link', href: href, target: '_blank', rel: 'noreferrer noopener' },
                    h(Icon, { name: 'external', size: 14 }),
                    h('span', null, t('sourceDrawer.open')),
                    h('span', { className: 'ds-source-link-host' }, hostOf(href)),
                  )
                : h('p', { className: 'ds-muted' }, source.url ? asString(source.url) : t('sourceDrawer.none')),
              h(
                'dl',
                { className: 'ds-source-facts' },
                h('div', null, h('dt', null, t('sourceDrawer.author')), h('dd', null, asString(source.author) || '—')),
                h('div', null, h('dt', null, t('sourceDrawer.publishedAt')), h('dd', null, formatDate(source.publishedAt) || '—')),
                h('div', null, h('dt', null, t('sourceDrawer.retrievedAt')), h('dd', null, formatDateTime(source.retrievedAt) || '—')),
                h(
                  'div',
                  null,
                  h('dt', null, t('sourceDrawer.readScope')),
                  h(
                    'dd',
                    null,
                    scopes.length > 0
                      ? scopes
                          .map(function (scope) {
                            return READ_SCOPE_KEYS[scope] ? t(READ_SCOPE_KEYS[scope]) : scope
                          })
                          .join(' / ')
                      : '—',
                  ),
                ),
                h('div', null, h('dt', null, t('sourceDrawer.locator')), h('dd', null, locators.length > 0 ? locators.join(' / ') : '—')),
              ),
            ),
            asString(source.summary)
              ? h(
                  'section',
                  { className: 'ds-source-section' },
                  h('h4', { className: 'ds-block-title' }, t('sourceDrawer.summary')),
                  h('p', { className: 'ds-source-paragraph' }, asString(source.summary)),
                )
              : null,
            asString(source.quote)
              ? h(
                  'section',
                  { className: 'ds-source-section' },
                  h('h4', { className: 'ds-block-title' }, t('sourceDrawer.quote')),
                  h('blockquote', { className: 'ds-source-quote' }, asString(source.quote)),
                )
              : null,
            asString(source.excerpt)
              ? h(
                  'section',
                  { className: 'ds-source-section' },
                  h('h4', { className: 'ds-block-title' }, t('sourceDrawer.excerpt')),
                  h('pre', { className: 'ds-source-excerpt' }, asString(source.excerpt)),
                )
              : h(
                  'section',
                  { className: 'ds-source-section' },
                  h('h4', { className: 'ds-block-title' }, t('sourceDrawer.excerpt')),
                  h('p', { className: 'ds-muted' }, t('sourceDrawer.emptyExcerpt')),
                ),
            h(
              'section',
              { className: 'ds-source-section' },
              h('h4', { className: 'ds-block-title' }, t('sourceDrawer.annotations'), h('span', { className: 'ds-block-count' }, String(annotations.length))),
              annotations.length === 0
                ? h('p', { className: 'ds-muted' }, t('sourceDrawer.supplementary'))
                : h(
                    'div',
                    { className: 'ds-source-usage' },
                    annotations.map(function (entry) {
                      return h(
                        'button',
                        {
                          key: 'a' + entry.number,
                          type: 'button',
                          className: 'ds-source-usage-item',
                          onClick: function () {
                            props.onOpenAnnotation(entry.number)
                          },
                        },
                        h('span', { className: 'ds-source-usage-label' }, '[' + entry.number + ']'),
                        h('span', { className: 'ds-source-usage-text' }, moduleText(t, entry.module) + ' · ' + truncate(asString(entry.text), 72)),
                        h(Icon, { name: 'chevron-right', size: 12 }),
                      )
                    }),
                  ),
            ),
            usages.length > 0
              ? h(
                  'section',
                  { className: 'ds-source-section' },
                  h('h4', { className: 'ds-block-title' }, t('sourceDrawer.otherUses'), h('span', { className: 'ds-block-count' }, String(usages.length))),
                  h(
                    'div',
                    { className: 'ds-source-usage' },
                    usages.map(function (usage, index) {
                      if (usage.kind === 'connection') {
                        return h(
                          'button',
                          {
                            key: 'o' + index,
                            type: 'button',
                            className: 'ds-source-usage-item',
                            onClick: function () {
                              props.onOpenChain({ type: 'question', id: asString(usage.connection.from) })
                            },
                          },
                          h('span', { className: 'ds-source-usage-label' }, t('sourceDrawer.usageConnection', { id: asString(usage.connection.id) })),
                          h('span', { className: 'ds-source-usage-text' }, truncate(asString(usage.connection.to), 60)),
                          h(Icon, { name: 'chevron-right', size: 12 }),
                        )
                      }
                      if (usage.kind === 'entity' || usage.kind === 'confusable') {
                        return h(
                          'div',
                          { key: 'o' + index, className: 'ds-source-usage-item' },
                          h('span', { className: 'ds-source-usage-label' }, t('sourceDrawer.usageEntity')),
                          h('span', { className: 'ds-source-usage-text' }, truncate(asString(usage.entity && usage.entity.name) || asString(usage.item && usage.item.term), 60)),
                        )
                      }
                      return h(
                        'div',
                        { key: 'o' + index, className: 'ds-source-usage-item' },
                        h('span', { className: 'ds-source-usage-label' }, t('sourceDrawer.usageTimeline', { id: asString(usage.item.id) })),
                        h('span', { className: 'ds-source-usage-text' }, truncate(asString(usage.item.text), 60)),
                      )
                    }),
                  ),
                )
              : null,
          ),
        )
      }

      // ======================================================================
      // 弹层：继续追问 / 设置 / 删除确认
      // ======================================================================

      /**
       * 弹层外壳。
       * @param {any} props 属性。
       * @returns {any}
       */
      function Modal(props) {
        return h(
          'div',
          { className: 'ds-modal-layer' },
          h('div', { className: 'ds-modal-scrim', onClick: props.onClose, 'aria-hidden': 'true' }),
          h(
            'div',
            { className: 'ds-modal' + (props.wide ? ' ds-modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': props.titleId || 'ds-modal-title' },
            h(
              'header',
              { className: 'ds-modal-head' },
              h(
                'div',
                { className: 'ds-modal-titles' },
                h('h2', { className: 'ds-modal-title', id: props.titleId || 'ds-modal-title' }, props.title),
                props.subtitle ? h('p', { className: 'ds-modal-subtitle' }, props.subtitle) : null,
              ),
              h(
                'button',
                { type: 'button', className: 'ds-iconbtn', onClick: props.onClose, title: props.closeLabel || 'Close', 'aria-label': props.closeLabel || 'Close' },
                h(Icon, { name: 'close', size: 16 }),
              ),
            ),
            props.children,
          ),
        )
      }

      /**
       * 继续追问弹层。
       * @param {any} props 属性（view / prefill / onSubmit / onClose / submitting / error）。
       * @returns {any}
       */
      function FollowupDialog(props) {
        const t = props.t
        const [text, setText] = useState(asString(props.prefill))
        const textareaRef = useRef(null)
        const title = asString(props.view.topic.title)

        useEffect(
          function () {
            const node = textareaRef.current
            if (node) {
              node.focus()
              const length = node.value.length
              try {
                node.setSelectionRange(length, length)
              } catch (error) {
                /* ignore */
              }
            }
          },
          [],
        )

        const submit = function () {
          const question = text.trim()
          if (!question || props.submitting) return
          props.onSubmit(question)
        }

        const suggestions = asArray(props.view.openBranches).slice(0, 6)
        return h(
          Modal,
          {
            title: t('ask.title'),
            subtitle: t('ask.subtitle', { title: title }),
            onClose: props.onClose,
            closeLabel: t('ask.cancel'),
            titleId: 'ds-ask-title',
          },
          h(
            'div',
            { className: 'ds-modal-body' },
            h(
              'div',
              { className: 'ds-field' },
              h('label', { className: 'ds-field-label', htmlFor: 'ds-ask-input' }, t('ask.placeholder')),
              h('textarea', {
                id: 'ds-ask-input',
                ref: textareaRef,
                className: 'ds-textarea',
                rows: 4,
                value: text,
                maxLength: 2000,
                placeholder: t('ask.placeholder'),
                disabled: props.submitting,
                onChange: function (event) {
                  setText(event.target.value)
                },
                onKeyDown: function (event) {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    submit()
                  }
                },
              }),
              h('div', { className: 'ds-field-hint' }, t('ask.keyboard')),
            ),
            suggestions.length > 0
              ? h(
                  'div',
                  { className: 'ds-recommended' },
                  h('div', { className: 'ds-field-label' }, t('ask.recommended')),
                  suggestions.map(function (item, index) {
                    return h(
                      'button',
                      {
                        key: 'sg' + index,
                        type: 'button',
                        className: 'ds-recommend',
                        onClick: function () {
                          setText(asString(item.text))
                          if (textareaRef.current) textareaRef.current.focus()
                        },
                      },
                      h('span', { className: 'ds-recommend-priority', 'data-priority': asString(item.priority) || 'medium' }),
                      h(
                        'span',
                        { className: 'ds-recommend-main' },
                        h('span', { className: 'ds-recommend-text' }, asString(item.text)),
                        asString(item.hook) ? h('span', { className: 'ds-recommend-hook' }, asString(item.hook)) : null,
                      ),
                    )
                  }),
                )
              : h('p', { className: 'ds-muted' }, t('ask.noFollowups')),
            props.error ? h('p', { className: 'ds-modal-error' }, props.error) : null,
          ),
          h(
            'footer',
            { className: 'ds-modal-foot' },
            h(
              'button',
              { type: 'button', className: 'ds-btn', onClick: props.onClose, disabled: props.submitting },
              t('ask.cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'ds-btn ds-btn-primary', onClick: submit, disabled: props.submitting || !text.trim() },
              props.submitting ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h(Icon, { name: 'ask', size: 14 }),
              h('span', null, props.submitting ? t('ask.submitting') : t('ask.submit')),
            ),
          ),
        )
      }

      /**
       * 设置弹层：数据目录、默认深度及检索来源可改。
       * @param {any} props 属性（settings / health / onSave / onClose / saving / error）。
       * @returns {any}
       */
      function SettingsDialog(props) {
        const t = props.t
        const settings = asObject(props.settings)
        const health = asObject(props.health)
        const [rootDir, setRootDir] = useState(asString(settings.rootDir))
        const [depth, setDepth] = useState(asString(settings.defaultDepth) || 'deep')
        const initialMode = asString(settings.searchProviderMode) || 'auto'
        const [searchMode, setSearchMode] = useState(initialMode)
        const modeChanged = searchMode !== initialMode
        const dirty = rootDir !== asString(settings.rootDir) || depth !== (asString(settings.defaultDepth) || 'deep') || modeChanged
        const anySearchKeyMissing = !settings.hasAnySearchApiKey
        return h(
          Modal,
          {
            title: t('settings.title'),
            onClose: props.onClose,
            closeLabel: t('settings.cancel'),
            titleId: 'ds-settings-title',
            wide: true,
          },
          h(
            'div',
            { className: 'ds-modal-body' },
            h(
              'div',
              { className: 'ds-field' },
              h('label', { className: 'ds-field-label', htmlFor: 'ds-settings-root' }, t('settings.rootDir')),
              h('input', {
                id: 'ds-settings-root',
                className: 'ds-input',
                type: 'text',
                value: rootDir,
                placeholder: health.dataDir || '~/Documents/DSH工具数据/AI大搜索',
                disabled: props.saving,
                onChange: function (event) {
                  setRootDir(event.target.value)
                },
              }),
              h('div', { className: 'ds-field-hint' }, t('settings.rootDirHint')),
            ),
            h(
              'div',
              { className: 'ds-field' },
              h('span', { className: 'ds-field-label' }, t('settings.defaultDepth')),
              h(DepthSwitch, { value: depth, onChange: setDepth, disabled: props.saving, size: 'lg' }),
            ),
            h(
              'div',
              { className: 'ds-field' },
              h(SearchProviderSelect, {
                t: t,
                className: 'ds-field',
                labelClassName: 'ds-field-label',
                labelKey: 'settings.defaultSearchMode',
                value: searchMode,
                onChange: setSearchMode,
                disabled: props.saving,
                hasAnySearchApiKey: settings.hasAnySearchApiKey,
                describedBy: anySearchKeyMissing ? 'ds-settings-anysearch-hint' : undefined,
              }),
              anySearchKeyMissing ? h('div', { id: 'ds-settings-anysearch-hint', className: 'ds-field-hint' }, t('settings.anySearchKeyMissing')) : null,
            ),
            h(
              'dl',
              { className: 'ds-readonly-grid' },
              h(
                'div',
                { className: 'ds-readonly-row' },
                h('dt', null, t('settings.activeSearchMode')),
                h('dd', null, searchModeLabel(health.searchMode, t)),
              ),
              h('div', { className: 'ds-readonly-row' }, h('dt', null, t('settings.model')), h('dd', null, asString(health.model) || '—')),
              h('div', { className: 'ds-readonly-row' }, h('dt', null, t('settings.version')), h('dd', null, asString(health.version) || '—')),
            ),
            props.error ? h('p', { className: 'ds-modal-error' }, props.error) : null,
          ),
          h(
            'footer',
            { className: 'ds-modal-foot' },
            h('button', { type: 'button', className: 'ds-btn', onClick: props.onClose, disabled: props.saving }, t('settings.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'ds-btn ds-btn-primary',
                disabled: props.saving || !dirty,
                onClick: function () {
                  const patch = { rootDir: rootDir.trim(), defaultDepth: depth }
                  if (modeChanged) patch.searchProviderMode = searchMode
                  props.onSave(patch)
                },
              },
              props.saving ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : null,
              h('span', null, props.saving ? t('settings.saving') : t('settings.save')),
            ),
          ),
        )
      }

      /**
       * 存入知识库弹层：格式选择 / 可用性检测 / 编译进度 / 已存记录 / 成功态。
       * @param {any} props 属性（view / format / onFormat / estimates / status / meta / healthError /
       *   phase / job / error / result / records / onSubmit / onClose / onOpenKb）。
       * @returns {any}
       */
      function KnowledgeBaseDialog(props) {
        const t = props.t
        const records = asArray(props.records)
        const saved = records.length > 0
        const phase = asString(props.phase) || 'idle'
        const busy = ['exporting', 'ingesting', 'compiling', 'saving'].indexOf(phase) >= 0
        const done = phase === 'done'
        const status = asString(props.status) || 'checking'
        const title = asString(asObject(props.view.topic).title) || 'AI 搜索'
        const estimates = asObject(props.estimates)
        const formats = [
          { id: 'full', title: t('kb.formatFull'), meta: t('kb.formatChars', { n: formatCount(Math.round(asNumber(estimates.full, 0) / 100) * 100) }) },
          { id: 'brief', title: t('kb.formatBrief'), meta: t('kb.formatChars', { n: formatCount(Math.round(asNumber(estimates.brief, 0) / 100) * 100) }) },
        ]
        const primaryLabel = busy
          ? t('kb.working')
          : props.error
            ? t('kb.retry')
            : saved
              ? t('kb.submitAgain')
              : t('kb.submit')
        const canSubmit = status === 'ready' && !busy
        const statusText =
          status === 'ready'
            ? t('kb.statusReady')
            : status === 'unavailable'
              ? t('kb.unavailable')
              : t('kb.statusChecking')
        return h(
          Modal,
          {
            t: t,
            title: t('kb.title'),
            subtitle: t('kb.subtitle'),
            onClose: props.onClose,
            closeLabel: t('kb.close'),
            titleId: 'ds-kb-title',
            wide: true,
          },
          h(
            'div',
            { className: 'ds-modal-body ds-kb-body' },
            h('p', { className: 'ds-kb-desc' }, t('kb.desc', { title: title })),
            h(
              'div',
              { className: 'ds-kb-section' },
              h('div', { className: 'ds-field-label' }, t('kb.format')),
              h(
                'div',
                { className: 'ds-kb-formats', role: 'radiogroup', 'aria-label': t('kb.format') },
                formats.map(function (format) {
                  const active = asString(props.format) === format.id
                  return h(
                    'label',
                    { key: format.id, className: 'ds-kb-format' + (active ? ' ds-kb-format-active' : ''), 'data-format': format.id },
                    h('input', {
                      type: 'radio',
                      name: 'ds-kb-format',
                      value: format.id,
                      className: 'ds-kb-radio',
                      checked: active,
                      disabled: busy,
                      onChange: function () {
                        props.onFormat(format.id)
                      },
                    }),
                    h(
                      'span',
                      { className: 'ds-kb-format-main' },
                      h('span', { className: 'ds-kb-format-title' }, format.title),
                      h('span', { className: 'ds-kb-format-meta' }, format.meta),
                    ),
                  )
                }),
              ),
            ),
            h(
              'div',
              { className: 'ds-kb-status', 'data-status': status },
              status === 'checking' ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h('span', { className: 'ds-kb-status-dot', 'data-status': status }),
              h(
                'div',
                { className: 'ds-kb-status-main' },
                h('span', { className: 'ds-kb-status-text' }, t('kb.statusLine', { label: t('kb.status'), value: statusText })),
                status === 'ready' && asString(asObject(props.meta).rootDir)
                  ? h('span', { className: 'ds-kb-rootdir' }, asString(asObject(props.meta).rootDir))
                  : null,
                status === 'unavailable'
                  ? h('span', { className: 'ds-kb-hint' }, asString(props.healthError) || t('kb.unavailableHint'))
                  : null,
              ),
            ),
            saved
              ? h(
                  'div',
                  { className: 'ds-kb-section' },
                  h(
                    'div',
                    { className: 'ds-kb-records-head' },
                    h('span', { className: 'ds-field-label' }, t('kb.records')),
                    h('span', { className: 'ds-kb-hint' }, t('kb.recordsHint')),
                  ),
                  h(
                    'div',
                    { className: 'ds-kb-records' },
                    records.map(function (record, index) {
                      return h(
                        'div',
                        { key: asString(record.id) || asString(record.kbJobId) || 'kb' + index, className: 'ds-kb-record' },
                        h(Icon, { name: 'book', size: 13, className: 'ds-kb-record-icon' }),
                        h(
                          'span',
                          { className: 'ds-kb-record-main' },
                          h('span', { className: 'ds-kb-record-title' }, kbFormatText(record, t)),
                          h(
                            'span',
                            { className: 'ds-kb-record-meta' },
                            (formatDateTime(record.ingestedAt) || formatDate(record.ingestedAt) || '—') + ' · ' + t('kb.pages', { n: kbPageCount(record) }),
                          ),
                        ),
                        asString(record.status) && asString(record.status) !== 'done'
                          ? h('span', { className: 'ds-kb-record-status' }, asString(record.status))
                          : null,
                      )
                    }),
                  ),
                )
              : null,
            busy
              ? h(
                  'div',
                  { className: 'ds-kb-progress', role: 'status', 'aria-live': 'polite' },
                  h('span', { className: 'ds-spinner ds-spinner-sm' }),
                  h(
                    'div',
                    { className: 'ds-kb-progress-main' },
                    h(
                      'span',
                      { className: 'ds-kb-stage' },
                      phase === 'exporting'
                        ? t('kb.exporting')
                        : phase === 'ingesting'
                          ? t('kb.ingesting')
                          : phase === 'saving'
                            ? t('kb.savingRecord')
                            : t('kb.stage') + '：' + kbStageText(props.job, t),
                    ),
                    h('span', { className: 'ds-kb-hint' }, t('kb.backgroundHint')),
                  ),
                )
              : null,
            done && props.result
              ? h(
                  'div',
                  { className: 'ds-kb-success' },
                  h(Icon, { name: 'check', size: 15 }),
                  h(
                    'span',
                    { className: 'ds-kb-success-text' },
                    asObject(props.result).existed
                      ? t('kb.savedExisting', { n: asNumber(asObject(props.result).pages, 0) })
                      : t('kb.saved', { n: asNumber(asObject(props.result).pages, 0) }),
                  ),
                  props.onOpenKb
                    ? h(
                        'button',
                        { type: 'button', className: 'ds-btn ds-btn-sm ds-kb-open', onClick: props.onOpenKb },
                        h(Icon, { name: 'external', size: 13 }),
                        h('span', null, t('kb.openKb')),
                      )
                    : null,
                )
              : null,
            props.error
              ? h(
                  'div',
                  { className: 'ds-kb-error', role: 'alert' },
                  h(Icon, { name: 'alert', size: 14 }),
                  h(
                    'div',
                    { className: 'ds-kb-error-main' },
                    h('p', null, asString(props.error)),
                    h('span', { className: 'ds-kb-hint' }, t('kb.retryHint')),
                  ),
                  status === 'ready' && !busy
                    ? h(
                        'button',
                        { type: 'button', className: 'ds-btn ds-btn-sm', onClick: props.onSubmit },
                        h(Icon, { name: 'refresh', size: 13 }),
                        h('span', null, t('kb.retry')),
                      )
                    : null,
                )
              : null,
          ),
          h(
            'footer',
            { className: 'ds-modal-foot' },
            h('button', { type: 'button', className: 'ds-btn', onClick: props.onClose }, t('kb.close')),
            h(
              'button',
              {
                type: 'button',
                className: 'ds-btn ds-btn-primary',
                disabled: !canSubmit,
                onClick: props.onSubmit,
              },
              busy ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h(Icon, { name: 'book', size: 14 }),
              h('span', null, primaryLabel),
            ),
          ),
        )
      }

      /**
       * 删除确认弹层。
       * @param {any} props 属性（title / body / busy / onConfirm / onClose）。
       * @returns {any}
       */
      function ConfirmDialog(props) {
        const t = props.t
        return h(
          Modal,
          {
            title: props.title || t('delete.title'),
            onClose: props.onClose,
            closeLabel: t('delete.cancel'),
            titleId: 'ds-confirm-title',
          },
          h('div', { className: 'ds-modal-body' }, h('p', { className: 'ds-confirm-body' }, props.body)),
          h(
            'footer',
            { className: 'ds-modal-foot' },
            h('button', { type: 'button', className: 'ds-btn', onClick: props.onClose, disabled: props.busy }, t('delete.cancel')),
            h(
              'button',
              { type: 'button', className: 'ds-btn ds-btn-danger ds-btn-solid', onClick: props.onConfirm, disabled: props.busy },
              props.busy ? h('span', { className: 'ds-spinner ds-spinner-sm' }) : h(Icon, { name: 'trash', size: 14 }),
              h('span', null, props.busy ? t('status.deleting') : t('delete.confirm')),
            ),
          ),
        )
      }

      /**
       * 轻提示。
       * @param {{ notice: any }} props 属性。
       * @returns {any}
       */
      function Notice(props) {
        if (!props.notice) return null
        return h(
          'div',
          { className: 'ds-notice', 'data-tone': asString(props.notice.tone) || 'info', role: 'status', 'aria-live': 'polite' },
          h(Icon, { name: props.notice.tone === 'error' ? 'alert' : 'check', size: 14 }),
          h('span', null, asString(props.notice.text)),
        )
      }

      // ======================================================================
      // 面板主体：状态机 / API 编排 / 键盘 / 轮询
      // ======================================================================

      /**
       * 触发浏览器下载（Blob + a[download]）。
       * @param {string} filename 文件名。
       * @param {string} content 文本内容。
       * @param {string} mime MIME。
       * @returns {void}
       */
      function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename || 'dossier.md'
        anchor.rel = 'noopener'
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        window.setTimeout(function () {
          try {
            URL.revokeObjectURL(url)
          } catch (error) {
            /* ignore */
          }
        }, 1200)
      }

      /**
       * 档案摘要行归一。
       * @param {any} raw 原始行。
       * @returns {any}
       */
      function normalizeTopicRow(raw) {
        const row = asObject(raw)
        return {
          id: asString(row.id),
          title: asString(row.title) || asString(row.query) || asString(row.id),
          kind: asString(row.kind),
          query: asString(row.query),
          status: asString(row.status) || 'draft',
          createdAt: asString(row.createdAt),
          updatedAt: asString(row.updatedAt) || asString(row.createdAt),
          questionCount: asNumber(row.questionCount, 0),
          sourceCount: asNumber(row.sourceCount, 0),
          followupCount: asNumber(row.followupCount, 0),
          depth: asString(row.depth),
        }
      }

      /**
       * 任务归一（兼容 {job:{...}} 与扁平结构）。
       * @param {any} raw 原始任务。
       * @returns {any}
       */
      function normalizeJob(raw) {
        const job = asObject(raw)
        const current = asObject(job.current)
        return {
          id: asString(job.id),
          topicId: asString(job.topicId),
          kind: asString(job.kind) || 'initial',
          searchProviderMode: asString(job.searchProviderMode),
          anySearchTag: asString(job.anySearchTag),
          status: asString(job.status) || 'queued',
          stage: asString(job.stage),
          progress: Math.max(0, Math.min(100, asNumber(job.progress, 0))),
          current: {
            index: asNumber(current.index, 0),
            total: asNumber(current.total, 0),
            label: asString(current.label),
          },
          log: asArray(job.log)
            .slice(-60)
            .map(function (entry) {
              const item = asObject(entry)
              return { at: asString(item.at), level: asString(item.level) || 'info', text: asString(item.text) }
            })
            .filter(function (entry) {
              return entry.text
            }),
          error: asString(job.error),
          createdAt: asString(job.createdAt),
          startedAt: asString(job.startedAt),
          finishedAt: asString(job.finishedAt),
        }
      }

      /**
       * 千分位数字（用于“约 26,000 字”）。
       * @param {any} value 数字。
       * @returns {string}
       */
      function formatCount(value) {
        const n = Math.max(0, Math.round(asNumber(value, 0)))
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      }

      /**
       * 粗略估算完整档案 / 一页简报的正文字数（仅用于弹层文案）。
       * @param {any} archive 完整档案。
       * @returns {{ full: number, brief: number }}
       */
      function estimateArchiveChars(archive) {
        const root = asObject(archive)
        const understanding = asObject(root.understanding)
        const discussion = asObject(root.discussion)
        const questions = asArray(root.questions)
        const claims = asArray(root.claims)
        const evidence = asArray(root.evidence)
        const sources = asArray(root.sources)
        const add = function (text) {
          return asString(text).length
        }
        let full = 0
        let brief = 0
        full += add(understanding.summary) + add(root.readingNote) + 40
        brief += add(understanding.summary) + add(root.readingNote) + 30
        for (const tension of asArray(root.tensions)) {
          full += add(tension) + 6
          brief += add(tension) + 6
        }
        for (const block of asArray(understanding.blocks)) {
          full += add(block.title) + add(block.text) + 40
          brief += add(block.text) + 20
        }
        for (const entity of asArray(understanding.entities)) full += add(entity.name) + add(entity.role) + 20
        for (const item of asArray(understanding.confusables)) full += add(item.term) + add(item.note) + 24
        for (const item of asArray(understanding.timeline)) full += add(item.at) + add(item.text) + 20
        const scope = asObject(discussion.scope)
        full += add(scope.window) + add(scope.limits) + asArray(scope.platforms).join('').length + 60
        for (const issue of asArray(discussion.issues)) {
          full += add(issue.question) + add(issue.summary) + add(issue.gaps) + 60
          brief += add(issue.question) + add(issue.summary) + 50
          for (const item of asArray(issue.items)) full += add(item.speaker) + add(item.view) + add(item.basis) + 40
          for (const side of asArray(issue.sides)) full += add(side.position) + asArray(side.holders).join('、').length + 24
        }
        for (const question of questions) {
          full += add(question.question) + add(question.why) + add(question.evidenceNeed) + add(question.summary) + 80
          brief += add(question.question) + add(question.summary) + 50
          for (const item of asArray(question.mechanism)) full += add(item.text) + 20
          for (const item of asArray(question.counterpoints)) full += add(item.text) + add(item.condition) + 20
          for (const gap of asArray(question.gaps)) full += add(gap.text) + add(gap.whyItMatters) + add(gap.howToClose) + 25
        }
        for (const claim of claims) full += add(claim.statement) + add(claim.basis) + add(claim.conditions) + 40
        for (const item of evidence) full += add(item.text) + add(item.quote) + add(item.note) + 40
        for (const judgment of asArray(root.judgments)) {
          full += add(judgment.text) + add(judgment.conditions) + add(judgment.note) + 40
          brief += add(judgment.text) + 30
        }
        for (const unknown of asArray(root.unknowns)) full += add(unknown.text) + add(unknown.whyItMatters) + add(unknown.howToClose) + 30
        for (const branch of asArray(root.branches)) {
          full += add(branch.text) + add(branch.hook) + 24
          brief += add(branch.text) + 16
        }
        for (const connection of asArray(root.connections)) full += add(connection.to) + add(connection.mechanism) + add(connection.note) + 40
        for (const source of sources) {
          full += add(source.title) + add(source.publisher) + add(source.summary) + 40
          brief += 24
        }
        full += 320 + questions.length * 140 + sources.length * 30
        brief += 180
        // 粗校准：真实 Markdown 比逐字段相加短；精确值由弹层打开时的 export 测量覆盖。
        return { full: Math.max(600, Math.round(full * 0.47)), brief: Math.max(200, Math.round(brief * 0.42)) }
      }
      /**
       * 知识库编译任务归一。
       * @param {any} raw 原始任务。
       * @returns {any}
       */
      function normalizeKbJob(raw) {
        const job = asObject(raw)
        return {
          id: asString(job.id),
          status: asString(job.status) || 'queued',
          stage: asString(job.stage),
          message: asString(job.message),
          error: asString(job.error),
          result: asObject(job.result),
          createdAt: asString(job.createdAt),
          startedAt: asString(job.startedAt),
          finishedAt: asString(job.finishedAt),
        }
      }

      /**
       * 从知识库任务里取页面列表（兼容数组 / 对象 / 缺失）。
       * @param {any} job 任务。
       * @returns {any[]}
       */
      function kbPagesOf(job) {
        const pages = asObject(asObject(job).result).pages
        if (Array.isArray(pages)) return pages
        if (pages && typeof pages === 'object') {
          return Object.keys(pages).map(function (key) {
            return pages[key]
          })
        }
        return []
      }

      /**
       * 记录里的页数。
       * @param {any} record knowledgeBase 记录。
       * @returns {number}
       */
      function kbPageCount(record) {
        const pages = asObject(record).pages
        if (Array.isArray(pages)) return pages.length
        if (typeof pages === 'number') return Math.max(0, Math.round(pages))
        if (pages && typeof pages === 'object') return Object.keys(pages).length
        return 0
      }

      /**
       * 知识库阶段可读文案。
       * @param {any} job 任务。
       * @param {Function} t 翻译函数。
       * @returns {string}
       */
      function kbStageText(job, t) {
        const stage = asString(asObject(job).stage)
        if (asString(job.message)) return asString(job.message)
        const key = KB_STAGE_KEYS[stage]
        if (key) return t(key)
        if (stage) return stage
        return t('kb.stageCompiling')
      }

      /**
       * 知识库记录格式文案。
       * @param {any} record 记录。
       * @param {Function} t 翻译函数。
       * @returns {string}
       */
      function kbFormatText(record, t) {
        return asString(asObject(record).format) === 'brief' ? t('kb.formatBrief') : t('kb.formatFull')
      }

      /**
       * 健康信息归一（兼容扁平与分组两种形状）。
       * @param {any} raw 原始健康数据。
       * @returns {any}
       */
      function pickHealth(raw) {
        const data = asObject(raw)
        const search = asObject(data.search)
        const searchModeRaw = data.searchMode
        let searchMode = ''
        if (typeof searchModeRaw === 'string') searchMode = searchModeRaw
        else if (searchModeRaw && typeof searchModeRaw === 'object') searchMode = asString(searchModeRaw.mode) || asString(searchModeRaw.primary)
        if (!searchMode) searchMode = asString(search.mode) || asString(search.primary)
        const llm = asObject(data.llm)
        const selection = asObject(llm.selection)
        const modelObj = asObject(data.model)
        const model =
          asString(data.model) && typeof data.model !== 'object'
            ? asString(data.model)
            : asString(modelObj.model) || asString(llm.model) || asString(selection.model)
        const dataDir =
          asString(data.dataRoot) ||
          asString(data.dataDir) ||
          asString(data.rootDir) ||
          asString(asObject(data.data).rootDir)
        return {
          version: asString(data.version),
          dataDir: dataDir,
          searchMode: searchMode,
          model: model,
          raw: data,
        }
      }

      /**
       * 主面板状态容器。
       * @param {{ t: Function }} props 属性。
       * @returns {any}
       */
      function PanelBody(props) {
        const t = props.t
        const openKbPanel = typeof props.openKbPanel === 'function' ? props.openKbPanel : null
        const mounted = useRef(true)
        const mainRef = useRef(null)
        const noticeTimer = useRef(0)
        const highlightTimer = useRef(0)
        const scrollTick = useRef(0)
        const kbHealthAbort = useRef(null)
        const kbMeasureAbort = useRef(null)
        const latest = useRef({})

        const [health, setHealth] = useState(cache.health || null)
        const [settings, setSettings] = useState(cache.settings || null)
        const [topics, setTopics] = useState([])
        const [listStatus, setListStatus] = useState('loading')
        const [listError, setListError] = useState('')
        const [listQuery, setListQuery] = useState(cache.listQuery || '')
        const [view, setView] = useState(cache.view || 'empty')
        const [archive, setArchive] = useState(null)
        const [archiveError, setArchiveError] = useState('')
        const [job, setJob] = useState(cache.jobId ? { id: cache.jobId, topicId: cache.selectedId, kind: 'initial', status: 'queued', stage: '', progress: 0, current: {}, log: [], error: '' } : null)
        const [newQuery, setNewQuery] = useState(cache.newQuery || '')
        const [depth, setDepth] = useState(cache.depth || 'deep')
        const [searchProviderMode, setSearchProviderMode] = useState(cache.searchProviderMode)
        const providerConfig = settings || asObject(asObject(health && health.raw).config)
        const effectiveProvider = searchProviderMode || asString(providerConfig.searchProviderMode) || 'auto'
        const anySearch = useAnySearchSelection(effectiveProvider === 'anysearch')
        const [starting, setStarting] = useState(false)
        const [errorBar, setErrorBar] = useState('')
        const [canceling, setCanceling] = useState(false)
        const [refreshing, setRefreshing] = useState(false)
        const [drawer, setDrawer] = useState(null)
        const [dialog, setDialog] = useState(null)
        const [notice, setNotice] = useState(null)
        const [railOpen, setRailOpen] = useState(false)
        const [highlight, setHighlight] = useState([])
        const [activeQuestion, setActiveQuestion] = useState('')
        const [activeSection, setActiveSection] = useState('understanding')
        const [followupPrefill, setFollowupPrefill] = useState('')
        const [submittingAsk, setSubmittingAsk] = useState(false)
        const [askError, setAskError] = useState('')
        const [savingSettings, setSavingSettings] = useState(false)
        const [settingsError, setSettingsError] = useState('')
        const [deleting, setDeleting] = useState(false)
        // 知识库联动：弹层 / 可用性 / 编译任务 / 已存记录
        const [kbDialogOpen, setKbDialogOpen] = useState(false)
        const [kbFormat, setKbFormat] = useState('full')
        const [kbHealthStatus, setKbHealthStatus] = useState('idle')
        const [kbHealthMeta, setKbHealthMeta] = useState(null)
        const [kbHealthError, setKbHealthError] = useState('')
        const [kbPhase, setKbPhase] = useState('idle')
        const [kbJob, setKbJob] = useState(null)
        const [kbError, setKbError] = useState('')
        const [kbResult, setKbResult] = useState(null)
        const [kbTask, setKbTask] = useState(null)
        const [kbMeasured, setKbMeasured] = useState({})

        const viewModel = useMemo(
          function () {
            return archive ? buildView(archive) : null
          },
          [archive],
        )
        const kbEstimate = useMemo(
          function () {
            return estimateArchiveChars(archive)
          },
          [archive],
        )
        const kbEstimates = {
          full: asNumber(kbMeasured.full, 0) || kbEstimate.full,
          brief: asNumber(kbMeasured.brief, 0) || kbEstimate.brief,
        }
        const kbRecords = viewModel ? viewModel.knowledgeBase : []
        const kbBusy = ['exporting', 'ingesting', 'compiling', 'saving'].indexOf(kbPhase) >= 0

        // ---- 轻提示 --------------------------------------------------------
        /**
         * 显示轻提示。
         * @param {string} text 文案。
         * @param {string} [tone] success | warn | error | info。
         * @returns {void}
         */
        function showNotice(text, tone) {
          if (!mounted.current) return
          if (noticeTimer.current) clearTimeout(noticeTimer.current)
          setNotice({ text: text, tone: tone || 'info' })
          noticeTimer.current = window.setTimeout(function () {
            noticeTimer.current = 0
            if (mounted.current) setNotice(null)
          }, NOTICE_MS)
        }

        // ---- 数据加载 ------------------------------------------------------
        /**
         * 读取健康状态。
         * @param {AbortSignal} [signal] 取消信号。
         * @returns {Promise<void>}
         */
        async function loadHealth(signal) {
          const result = await apiSafe('/health', { signal })
          if (!mounted.current) return
          if (result.ok) {
            const info = pickHealth(result.data)
            setHealth(info)
            cache.health = info
          } else {
            setHealth(null)
            cache.health = null
          }
        }

        /**
         * 读取档案列表。
         * @param {AbortSignal} [signal] 取消信号。
         * @returns {Promise<void>}
         */
        async function loadTopics(signal) {
          if (mounted.current) {
            setListStatus(function (previous) {
              return previous === 'ready' ? previous : 'loading'
            })
            setListError('')
          }
          const result = await apiSafe('/topics?limit=100', { signal })
          if (!mounted.current) return
          if (!result.ok) {
            setListStatus('error')
            setListError(t('error.loadTopics', { message: result.error.message }))
            return
          }
          const data = result.data
          const list = asArray(data.topics || data.items || data.list || data.rows || (Array.isArray(data) ? data : []))
          setTopics(list.map(normalizeTopicRow).filter(function (row) { return !!row.id }))
          setListStatus('ready')
        }

        /**
         * 读取设置。
         * @param {AbortSignal} [signal] 取消信号。
         * @returns {Promise<void>}
         */
        async function loadSettings(signal) {
          const result = await apiSafe('/settings', { signal })
          if (!mounted.current) return
          if (result.ok) {
            const data = result.data.settings && typeof result.data.settings === 'object' ? result.data.settings : result.data
            setSettings(data)
            cache.settings = data
            if (asString(data.defaultDepth) === 'quick' || asString(data.defaultDepth) === 'deep') {
              if (!cache.depth) setDepth(asString(data.defaultDepth))
            }
          }
        }

        // ---- 打开档案 ------------------------------------------------------
        /**
         * 打开一份档案（带滚动位置恢复与新增内容高亮）。
         * @param {string} topicId 档案 id。
         * @param {{ resetScroll?: boolean, highlightRevision?: boolean }} [options] 选项。
         * @returns {Promise<void>}
         */
        async function openTopic(topicId, options) {
          const id = asString(topicId)
          if (!id) return
          const opts = options || {}
          if (mainRef.current && cache.selectedId && cache.selectedId !== id) {
            cache.scrollPositions[asString(cache.selectedId)] = mainRef.current.scrollTop
          }
          cache.selectedId = id
          if (kbMeasureAbort.current) {
            try {
              kbMeasureAbort.current.abort()
            } catch (error) {
              /* ignore */
            }
          }
          setView('loading')
          setArchiveError('')
          setDrawer(null)
          setDialog(null)
          setKbDialogOpen(false)
          setRailOpen(false)
          try {
            const data = await api('/topics/' + encodeURIComponent(id))
            if (!mounted.current) return
            const raw = data.topic && typeof data.topic === 'object' ? data.topic : data.archive && typeof data.archive === 'object' ? data.archive : data
            if (!raw || !asString(raw.id)) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            const latestJob = data.job && typeof data.job === 'object' ? normalizeJob(data.job) : null
            if (latestJob && (latestJob.status === 'running' || latestJob.status === 'queued')) {
              // 列表里正在运行的档案：直接进运行态并轮询该任务，结束后回到阅读态。
              latestJob.topicId = latestJob.topicId || asString(raw.id)
              cache.selectedId = asString(raw.id)
              cache.jobId = latestJob.id
              cache.view = 'running'
              setArchive(raw)
              setJob(latestJob)
              setView('running')
              setActiveQuestion('')
              setHighlight([])
              return
            }
            setArchive(raw)
            setView('reading')
            cache.view = 'reading'
            setActiveSection('understanding')
            cache.selectedId = asString(raw.id)
            const firstQuestion = asArray(raw.questions)[0]
            setActiveQuestion(firstQuestion ? asString(firstQuestion.id) : '')
            const savedTop = opts.resetScroll ? 0 : asNumber(cache.scrollPositions[asString(raw.id)], 0)
            requestAnimationFrame(function () {
              if (mainRef.current) mainRef.current.scrollTop = savedTop
            })
            if (opts.highlightRevision) {
              const revisions = asArray(raw.revisions)
              const last = revisions.length > 0 ? asObject(revisions[revisions.length - 1]) : {}
              const questionIds = asArray(last.questionIds).map(asString).filter(Boolean)
              if (questionIds.length > 0) {
                setHighlight(questionIds)
                setActiveQuestion(questionIds[0])
                if (highlightTimer.current) clearTimeout(highlightTimer.current)
                highlightTimer.current = window.setTimeout(function () {
                  highlightTimer.current = 0
                  if (mounted.current) setHighlight([])
                }, HIGHLIGHT_MS)
                window.setTimeout(function () {
                  if (mounted.current) scrollToQuestion(questionIds[0], 'auto')
                }, 120)
              }
            } else {
              setHighlight([])
            }
          } catch (error) {
            if (isAbort(error)) return
            if (!mounted.current) return
            setArchiveError(t('error.loadTopic', { message: errorMessage(error, t('error.requestFailed')) }))
            setView('error')
            cache.view = 'error'
          }
        }

        // ---- 新建 / 追问 / 刷新 / 取消 / 删除 / 导出 ------------------------
        /**
         * 新建一次研究。
         * @returns {Promise<void>}
         */
        async function startSearch() {
          const query = asString(newQuery).trim()
          if (!query || starting) return
          if (anySearch.blocked) {
            setErrorBar(t('anySearch.chooseToStart'))
            return
          }
          if (anySearch.missingEsportsFields.length) {
            const fields = anySearch.missingEsportsFields.map(function (key) { return esportsFieldLabel(key, t) })
            setErrorBar(t('anySearch.fillFields', { fields: fields.join('、') }))
            return
          }
          const selection = anySearch.getSelection()
          setStarting(true)
          setErrorBar('')
          setNotice(null)
          try {
            const body = { query: query, depth: depth }
            if (searchProviderMode) body.searchProviderMode = searchProviderMode
            if (selection) {
              body.searchProviderMode = 'anysearch'
              body.anySearch = selection
            }
            const data = await api('/topics', { method: 'POST', body: body })
            const topicId = asString(data.topicId) || asString(asObject(data.topic).id)
            const jobId = asString(data.jobId) || asString(asObject(data.job).id)
            if (!topicId) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            cache.newQuery = ''
            cache.lastQuery = query
            cache.depth = depth
            setNewQuery('')
            setArchive(null)
            setActiveQuestion('')
            setHighlight([])
            cache.selectedId = ''
            if (jobId) {
              cache.jobId = jobId
              cache.view = 'running'
              setView('running')
              setJob({
                id: jobId,
                topicId: topicId,
                kind: 'initial',
                searchProviderMode: effectiveProvider,
                anySearchTag: selection?.tag || '',
                status: 'queued',
                stage: '',
                progress: 0,
                current: {},
                log: [],
                error: '',
              })
            } else {
              await openTopic(topicId)
            }
            await loadTopics()
            showNotice(t('notice.created'), 'success')
          } catch (error) {
            if (isAbort(error)) return
            setErrorBar(t('error.start', { message: errorMessage(error, t('error.requestFailed')) }))
          } finally {
            if (mounted.current) setStarting(false)
          }
        }

        /**
         * 提交追问。
         * @param {string} question 追问内容。
         * @returns {Promise<void>}
         */
        async function submitAsk(question) {
          const topicId = asString(archive && archive.id) || asString(cache.selectedId)
          const text = asString(question).trim()
          if (!topicId || !text || submittingAsk) return
          setSubmittingAsk(true)
          setAskError('')
          try {
            const data = await api('/topics/' + encodeURIComponent(topicId) + '/ask', { method: 'POST', body: { question: text } })
            const jobId = asString(data.jobId) || asString(asObject(data.job).id)
            setDialog(null)
            if (jobId) {
              cache.jobId = jobId
              cache.view = 'running'
              setView('running')
              setJob({ id: jobId, topicId: topicId, kind: 'followup', status: 'queued', stage: '', progress: 0, current: {}, log: [], error: '' })
              showNotice(t('notice.askStarted'), 'success')
            } else {
              await openTopic(topicId, { highlightRevision: true })
            }
          } catch (error) {
            if (isAbort(error)) return
            setAskError(t('error.ask', { message: errorMessage(error, t('error.requestFailed')) }))
          } finally {
            if (mounted.current) setSubmittingAsk(false)
          }
        }

        /**
         * 刷新当前档案。
         * @returns {Promise<void>}
         */
        async function refreshTopic() {
          const topicId = asString(archive && archive.id) || asString(cache.selectedId)
          if (!topicId || refreshing) return
          setRefreshing(true)
          try {
            const data = await api('/topics/' + encodeURIComponent(topicId) + '/refresh', { method: 'POST' })
            const jobId = asString(data.jobId) || asString(asObject(data.job).id)
            if (jobId) {
              cache.jobId = jobId
              cache.view = 'running'
              setView('running')
              setJob({ id: jobId, topicId: topicId, kind: 'refresh', status: 'queued', stage: '', progress: 0, current: {}, log: [], error: '' })
              showNotice(t('reading.refreshing'), 'info')
            } else {
              await openTopic(topicId, { highlightRevision: true })
            }
          } catch (error) {
            if (isAbort(error)) return
            showNotice(t('error.refresh', { message: errorMessage(error, t('error.requestFailed')) }), 'error')
          } finally {
            if (mounted.current) setRefreshing(false)
          }
        }

        /**
         * 取消当前任务。
         * @returns {Promise<void>}
         */
        async function cancelJob() {
          const jobId = asString(job && job.id)
          if (!jobId || canceling) return
          setCanceling(true)
          try {
            await api('/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' })
          } catch (error) {
            if (!isAbort(error)) showNotice(t('error.cancel', { message: errorMessage(error, t('error.requestFailed')) }), 'error')
          } finally {
            if (mounted.current) setCanceling(false)
          }
        }

        /**
         * 删除当前档案。
         * @returns {Promise<void>}
         */
        async function deleteTopic() {
          const topicId = asString(archive && archive.id) || asString(cache.selectedId)
          if (!topicId || deleting) return
          setDeleting(true)
          try {
            await api('/topics/' + encodeURIComponent(topicId), { method: 'DELETE' })
            setDialog(null)
            setTopics(function (previous) {
              return previous.filter(function (row) {
                return asString(row.id) !== topicId
              })
            })
            setArchive(null)
            setView('empty')
            cache.view = 'empty'
            cache.selectedId = ''
            cache.jobId = ''
            cache.scrollPositions[topicId] = 0
            setHighlight([])
            setActiveQuestion('')
            showNotice(t('delete.done'), 'success')
          } catch (error) {
            if (isAbort(error)) return
            setDialog(null)
            showNotice(t('error.delete', { message: errorMessage(error, t('error.requestFailed')) }), 'error')
          } finally {
            if (mounted.current) setDeleting(false)
          }
        }

        /**
         * 导出当前档案。
         * @param {string} format full | brief | json。
         * @returns {Promise<void>}
         */
        async function exportTopic(format) {
          const topicId = asString(archive && archive.id) || asString(cache.selectedId)
          if (!topicId) return
          const spec = EXPORT_FORMATS.find(function (item) {
            return item.id === format
          })
          try {
            const data = await api('/topics/' + encodeURIComponent(topicId) + '/export', { method: 'POST', body: { format: format } })
            const content = asString(data.content)
            if (!content) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            const filename = asString(data.filename) || topicId + '.' + (spec ? spec.ext : 'md')
            downloadFile(filename, content, spec ? spec.mime : 'text/plain;charset=utf-8')
            showNotice(t('export.done', { filename: filename }), 'success')
          } catch (error) {
            if (isAbort(error)) return
            showNotice(t('export.failed', { message: errorMessage(error, t('error.requestFailed')) }), 'error')
          }
        }

        /**
         * 保存设置（只提交可编辑字段）。
         * @param {{ rootDir: string, defaultDepth: string, searchProviderMode?: string }} patch 变更。
         * @returns {Promise<void>}
         */
        async function saveSettings(patch) {
          if (savingSettings) return
          setSavingSettings(true)
          setSettingsError('')
          try {
            const data = await api('/settings', { method: 'PUT', body: patch })
            const next = data.settings && typeof data.settings === 'object' ? data.settings : data
            setSettings(next)
            cache.settings = next
            if (asString(next.defaultDepth) === 'quick' || asString(next.defaultDepth) === 'deep') {
              setDepth(asString(next.defaultDepth))
              cache.depth = asString(next.defaultDepth)
            }
            setDialog(null)
            showNotice(t('settings.saved'), 'success')
            if (patch.searchProviderMode) {
              setSearchProviderMode('')
              cache.searchProviderMode = ''
              loadHealth()
            }
          } catch (error) {
            if (isAbort(error)) return
            setSettingsError(t('error.saveSettings', { message: errorMessage(error, t('error.requestFailed')) }))
          } finally {
            if (mounted.current) setSavingSettings(false)
          }
        }

        /**
         * 任务进入终态后的收尾：刷新列表、打开档案、按需高亮新增内容。
         * @param {any} finished 归一后的任务。
         * @returns {Promise<void>}
         */
        async function handleJobFinished(finished) {
          if (!mounted.current) return
          cache.jobId = ''
          const status = asString(finished.status)
          const topicId = asString(finished.topicId) || asString(cache.selectedId)
          if (status === 'done' || status === 'partial') {
            showNotice(status === 'done' ? t('notice.done') : t('notice.partial'), status === 'done' ? 'success' : 'warn')
            await loadTopics()
            if (topicId) {
              await openTopic(topicId, {
                highlightRevision: asString(finished.kind) === 'followup' || asString(finished.kind) === 'refresh',
                resetScroll: asString(finished.kind) !== 'followup',
              })
            } else {
              setView('empty')
              cache.view = 'empty'
            }
          } else if (status === 'failed') {
            showNotice(t('notice.failed'), 'error')
          } else if (status === 'canceled') {
            showNotice(t('notice.canceled'), 'warn')
          }
        }

        // 保持最新函数引用，供轮询 / 键盘 / 初始加载等只注册一次的回调使用
        latest.current = {
          loadHealth: loadHealth,
          loadTopics: loadTopics,
          loadSettings: loadSettings,
          openTopic: openTopic,
          startSearch: startSearch,
          handleJobFinished: handleJobFinished,
          finishKbTask: finishKbTask,
          failKbTask: failKbTask,
          scrollToSection: scrollToSection,
          scrollToQuestion: scrollToQuestion,
        }

        // ---- 滚动与定位 ----------------------------------------------------
        /**
         * 平滑滚动到章节。
         * @param {string} sectionId 章节 id。
         * @returns {void}
         */
        function scrollToSection(sectionId) {
          const node = mainRef.current
          const element = document.getElementById('ds-section-' + asString(sectionId))
          if (!node || !element) return
          const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 64
          const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          node.scrollTo({ top: Math.max(0, offset), behavior: reduce ? 'auto' : 'smooth' })
          setActiveSection(asString(sectionId))
        }

        /**
         * 滚动到某个问题的研究单元。
         * @param {string} questionId 问题 id。
         * @param {ScrollBehavior} [behavior] 滚动行为。
         * @returns {void}
         */
        function scrollToQuestion(questionId, behavior) {
          const node = mainRef.current
          const element = document.getElementById(domId('q', asString(questionId)))
          if (!node || !element) return
          const offset = element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - 56
          const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          node.scrollTo({ top: Math.max(0, offset), behavior: behavior || (reduce ? 'auto' : 'smooth') })
          setActiveQuestion(asString(questionId))
        }

        /**
         * 主区滚动：记录位置、更新当前章节。
         * @returns {void}
         */
        function handleMainScroll() {
          const node = mainRef.current
          if (!node) return
          if (archive) cache.scrollPositions[asString(archive.id)] = node.scrollTop
          if (view !== 'reading') return
          if (scrollTick.current) return
          scrollTick.current = requestAnimationFrame(function () {
            scrollTick.current = 0
            const containerTop = node.getBoundingClientRect().top
            let current = 'understanding'
            for (const section of SECTIONS) {
              const element = document.getElementById('ds-section-' + section.id)
              if (!element) continue
              const top = element.getBoundingClientRect().top - containerTop + node.scrollTop
              if (node.scrollTop >= top - 120) current = section.id
            }
            setActiveSection(current)
          })
        }

        // ---- 抽屉 / 弹层 ---------------------------------------------------
        /**
         * 打开证据链抽屉。
         * @param {{ type: string, id: string }} ref 引用。
         * @returns {void}
         */
        function openChain(ref) {
          if (!ref) return
          if (asString(ref.type) === 'source') {
            setDrawer({ type: 'source', id: asString(ref.id), parent: null })
            return
          }
          setDrawer({ type: 'chain', ref: { type: asString(ref.type), id: asString(ref.id) }, parent: null })
        }

        /**
         * 打开来源抽屉。
         * @param {string} sourceId 来源 id。
         * @returns {void}
         */
        function openSource(sourceId) {
          if (!asString(sourceId)) return
          setDrawer({ type: 'source', id: asString(sourceId), parent: null })
        }

        /**
         * 打开注释抽屉。
         * @param {number} number 注释编号。
         * @returns {void}
         */
        function openAnnotation(number) {
          const value = asNumber(number, 0)
          if (!value) return
          setDrawer({ type: 'annotation', number: value, parent: null })
        }

        /**
         * 关闭当前抽屉（有父级时返回父级）。
         * @returns {void}
         */
        function closeDrawer() {
          setDrawer(null)
        }

        /**
         * 抽屉内打开下一层，保留返回栈。
         * @param {any} next 下一层抽屉。
         * @returns {void}
         */
        function pushDrawer(next) {
          setDrawer(function (previous) {
            if (!next) return previous
            return Object.assign({}, next, { parent: previous })
          })
        }

        /**
         * 返回上一层抽屉。
         * @returns {void}
         */
        function drawerBack() {
          setDrawer(function (previous) {
            if (!previous) return null
            return previous.parent || null
          })
        }

        /**
         * 抽屉返回按钮文案：指明返回到哪一层。
         * @param {any} parent 父级抽屉。
         * @returns {string}
         */
        function drawerParentLabel(parent) {
          if (!parent) return t('status.back')
          if (parent.type === 'annotation') return t('annotation.title', { n: asNumber(parent.number, 0) })
          if (parent.type === 'source') return t('sourceDrawer.title')
          if (parent.type === 'chain') return t('chain.title')
          return t('status.back')
        }

        // ---- 知识库联动 ----------------------------------------------------
        /**
         * 打开弹层时用真实 export 校准字数（本地渲染，成本低；失败保留估算）。
         * @returns {Promise<void>}
         */
        async function measureKbExports() {
          const topicId = asString(archive && archive.id)
          if (!topicId) return
          const key = topicId + ':' + asString(archive.updatedAt)
          if (cache.kbMeasure[key]) {
            setKbMeasured(function (previous) {
              return Object.assign({}, previous, cache.kbMeasure[key])
            })
            return
          }
          if (kbMeasureAbort.current) {
            try {
              kbMeasureAbort.current.abort()
            } catch (error) {
              /* ignore */
            }
          }
          const controller = new AbortController()
          kbMeasureAbort.current = controller
          try {
            const formats = ['full', 'brief']
            const results = await Promise.all(
              formats.map(function (format) {
                return api('/topics/' + encodeURIComponent(topicId) + '/export', {
                  method: 'POST',
                  body: { format: format },
                  signal: controller.signal,
                })
                  .then(function (data) {
                    return { format: format, length: asString(data.content).length }
                  })
                  .catch(function (error) {
                    if (isAbort(error)) throw error
                    return null
                  })
              }),
            )
            if (!mounted.current || controller.signal.aborted) return
            const measured = {}
            for (const result of results) {
              if (result && result.length > 0) measured[result.format] = result.length
            }
            if (!Object.keys(measured).length) return
            cache.kbMeasure[key] = measured
            setKbMeasured(function (previous) {
              return Object.assign({}, previous, measured)
            })
          } catch (error) {
            if (isAbort(error)) return
            // 测量失败保留估算值
          }
        }

        /**
         * 检测知识库插件是否可用；可用时顺带取 meta.rootDir（失败忽略）。
         * @returns {Promise<void>}
         */
        async function checkKbHealth() {
          if (kbHealthAbort.current) {
            try {
              kbHealthAbort.current.abort()
            } catch (error) {
              /* ignore */
            }
          }
          const controller = new AbortController()
          kbHealthAbort.current = controller
          setKbHealthStatus('checking')
          setKbHealthError('')
          try {
            const data = await kbApi('/health', { signal: controller.signal })
            if (!mounted.current || controller.signal.aborted) return
            if (data.ok === false) throw new ApiError(t('kb.unavailable'), 'KB_UNAVAILABLE', 200)
            const version = asString(data.version)
            setKbHealthStatus('ready')
            setKbHealthMeta({ version: version })
            try {
              const meta = await kbApi('/meta', { signal: controller.signal })
              if (!mounted.current || controller.signal.aborted) return
              const rootDir =
                asString(meta.rootDir) ||
                asString(asObject(meta.meta).rootDir) ||
                asString(asObject(meta.data).rootDir)
              if (rootDir) setKbHealthMeta({ version: version, rootDir: rootDir })
            } catch (metaError) {
              if (isAbort(metaError)) return
              // meta 是可选信息，失败不影响可用性判断
            }
          } catch (error) {
            if (isAbort(error)) return
            if (!mounted.current) return
            const message = error && error.status === 404 ? t('kb.unavailable') : errorMessage(error, t('kb.unavailable'))
            setKbHealthStatus('unavailable')
            setKbHealthError(message)
          }
        }

        /**
         * 打开「存入知识库」弹层。
         * @returns {void}
         */
        function openKbDialog() {
          if (!archive) return
          setKbDialogOpen(true)
          if (!kbTask && (kbPhase === 'done' || kbPhase === 'error')) {
            setKbPhase('idle')
            setKbResult(null)
          }
          checkKbHealth()
          measureKbExports()
        }

        /**
         * 关闭弹层（不取消知识库编译任务）。
         * @returns {void}
         */
        function closeKbDialog() {
          setKbDialogOpen(false)
        }

        /**
         * 导出 → ingest-text → 拿 jobId 开始轮询。
         * @param {string} format full | brief。
         * @returns {Promise<void>}
         */
        async function startKbIngest(format) {
          const topicId = asString(archive && archive.id) || asString(cache.selectedId)
          if (!topicId || kbBusy || kbHealthStatus !== 'ready') return
          const activeFormat = format === 'brief' ? 'brief' : 'full'
          setKbPhase('exporting')
          setKbError('')
          setKbResult(null)
          setKbJob(null)
          try {
            const exported = await api('/topics/' + encodeURIComponent(topicId) + '/export', {
              method: 'POST',
              body: { format: activeFormat },
            })
            const text = asString(exported.content)
            if (!text) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            setKbMeasured(function (previous) {
              return Object.assign({}, previous, { [activeFormat]: text.length })
            })
            setKbPhase('ingesting')
            const title = 'AI 大搜索 · ' + (asString(asObject(archive && archive.topic).title) || topicId)
            const ingested = await kbApi('/ingest-text', { method: 'POST', body: { title: title, text: text } })
            const jobId = asString(ingested.jobId) || asString(asObject(ingested.job).id)
            const sourceId = asString(asObject(ingested.source).id) || asString(ingested.sourceId)
            const existed = !!ingested.existed || (!jobId && !!sourceId)
            if (existed && sourceId) {
              // 知识库对相同正文会去重，不返回新 jobId；关联已有素材并新增一条档案记录。
              const records = asArray(archive && archive.knowledgeBase)
              const sameSource = records.find(function (record) {
                return asString(record.sourceId) === sourceId
              })
              const sameFormat = records.find(function (record) {
                return asString(record.format) === activeFormat
              })
              const existing = sameSource || sameFormat || null
              const pageCount = existing ? kbPageCount(existing) : 0
              const existingTask = {
                topicId: topicId,
                // 用独立的记录 id 触发服务端“新增记录”（同 kbJobId 会被视为重复上报而更新）。
                jobId: 'existing-' + sourceId + '-' + Date.now().toString(36),
                sourceId: sourceId,
                format: activeFormat,
                title: title,
                note: t('kb.existedNote'),
                startedAt: Date.now(),
              }
              await saveKbRecord(existingTask, pageCount, null, true)
              return
            }
            if (!jobId) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            setKbJob({ status: 'queued', stage: 'queued', message: '' })
            setKbPhase('compiling')
            setKbTask({
              jobId: jobId,
              sourceId: sourceId,
              topicId: topicId,
              format: activeFormat,
              title: title,
              startedAt: Date.now(),
            })
          } catch (error) {
            if (isAbort(error)) return
            if (!mounted.current) return
            setKbPhase('error')
            setKbError(t('kb.failed', { message: errorMessage(error, t('error.requestFailed')) }))
          }
        }

        /**
         * 写入 topics/:id/kb 记录，并把记录合并回本地档案。
         * @param {any} task 任务信息（topicId / format / title / jobId / sourceId）。
         * @param {number} pageCount 编译产出的页数（必须是数字，服务端按 Number 存）。
         * @param {any} doneJob 终态任务（已有素材时为 null）。
         * @param {boolean} existed 知识库是否已有相同素材。
         * @returns {Promise<void>}
         */
        async function saveKbRecord(task, pageCount, doneJob, existed) {
          const ingestedAt = new Date().toISOString()
          const record = {
            id: task.sourceId || task.jobId,
            format: task.format,
            title: task.title,
            kbJobId: task.jobId,
            sourceId: task.sourceId,
            pages: pageCount,
            ingestedAt: ingestedAt,
            status: 'done',
            note: asString(task.note),
          }
          const payload = {
            format: task.format,
            title: task.title,
            kbJobId: task.jobId,
            sourceId: task.sourceId,
            pages: pageCount,
            ingestedAt: ingestedAt,
            status: 'done',
            note: asString(task.note),
          }
          setKbPhase('saving')
          try {
            const data = await api('/topics/' + encodeURIComponent(task.topicId) + '/kb', { method: 'POST', body: payload })
            if (!mounted.current) return
            const list = asArray(data.knowledgeBase)
            setArchive(function (previous) {
              if (!previous || asString(previous.id) !== task.topicId) return previous
              const next = list.length > 0 ? list : asArray(previous.knowledgeBase).concat([record])
              return Object.assign({}, previous, { knowledgeBase: next })
            })
            setKbTask(null)
            setKbPhase('done')
            setKbResult({ pages: pageCount, sourceId: task.sourceId, existed: !!existed })
            setKbJob(doneJob)
            setKbError('')
            showNotice(existed ? t('kb.existedToast') : t('kb.savedToast', { n: pageCount }), 'success')
          } catch (error) {
            if (isAbort(error)) return
            if (!mounted.current) return
            setKbTask(null)
            setKbPhase('error')
            setKbError(t('kb.recordFailed', { message: errorMessage(error, t('error.requestFailed')) }))
            showNotice(t('kb.recordFailedToast'), 'error')
          }
        }

        /**
         * 编译完成：记录页数并写回档案。
         * @param {any} task 编译任务。
         * @param {any} doneJob 终态任务。
         * @returns {Promise<void>}
         */
        async function finishKbTask(task, doneJob) {
          const pagesArr = kbPagesOf(doneJob)
          await saveKbRecord(task, pagesArr.length, doneJob, false)
        }

        /**
         * 编译失败 / 超时 / 轮询失败收尾。
         * @param {any} task 编译任务。
         * @param {string} message 可展示错误。
         * @returns {void}
         */
        function failKbTask(task, message) {
          setKbTask(null)
          setKbPhase('error')
          setKbError(asString(message) || t('kb.compileFailed'))
          showNotice(t('kb.failedToast'), 'error')
        }

        /**
         * 打开宿主知识库面板（apply 注入；不存在时静默失败）。
         * @returns {void}
         */
        function openKbInPanel() {
          setKbDialogOpen(false)
          try {
            if (openKbPanel) openKbPanel()
          } catch (error) {
            /* ignore */
          }
        }

        /**
         * 打开追问弹层。
         * @param {any} [followup] 推荐问题（预填）。
         * @returns {void}
         */
        function openAsk(followup) {
          setFollowupPrefill(followup ? asString(followup.text) : '')
          setAskError('')
          setDialog({ type: 'followup' })
        }

        // ---- 初始加载 ------------------------------------------------------
        useEffect(function () {
          mounted.current = true
          const controller = new AbortController()
          loadHealth(controller.signal)
          loadSettings(controller.signal)
          loadTopics(controller.signal)
          const restoredId = asString(cache.selectedId)
          if (asString(cache.view) === 'running' && asString(cache.jobId)) {
            setView('running')
          } else if (restoredId) {
            openTopic(restoredId)
          }
          return function () {
            mounted.current = false
            controller.abort()
            abortAll()
            if (kbHealthAbort.current) {
              try {
                kbHealthAbort.current.abort()
              } catch (error) {
                /* ignore */
              }
            }
            if (kbMeasureAbort.current) {
              try {
                kbMeasureAbort.current.abort()
              } catch (error) {
                /* ignore */
              }
            }
            if (noticeTimer.current) clearTimeout(noticeTimer.current)
            if (highlightTimer.current) clearTimeout(highlightTimer.current)
            if (scrollTick.current) cancelAnimationFrame(scrollTick.current)
          }
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        // ---- 任务轮询（1000ms；终态即停；空闲不轮询） -----------------------
        useEffect(
          function () {
            const current = job
            if (!current || !asString(current.id)) return undefined
            if (TERMINAL_JOB_STATUS.indexOf(asString(current.status)) >= 0) return undefined
            let cancelled = false
            let inFlight = false
            let finished = false
            const tick = async function () {
              if (cancelled || inFlight) return
              inFlight = true
              try {
                const data = await api('/jobs/' + encodeURIComponent(asString(current.id)))
                if (cancelled) return
                const normalized = normalizeJob(data.job || data.jobStatus || data)
                if (!normalized.id) normalized.id = asString(current.id)
                if (!normalized.status) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
                setJob(function (previous) {
                  if (!previous || previous.id !== normalized.id) return normalized
                  return Object.assign({}, previous, normalized)
                })
                if (TERMINAL_JOB_STATUS.indexOf(asString(normalized.status)) >= 0 && !finished) {
                  finished = true
                  cancelled = true
                  clearInterval(timer)
                  latest.current.handleJobFinished(normalized)
                }
              } catch (error) {
                if (isAbort(error) || cancelled) return
                cancelled = true
                clearInterval(timer)
                cache.jobId = ''
                setJob(function (previous) {
                  if (!previous) return previous
                  return Object.assign({}, previous, { status: 'failed', error: t('error.jobPoll', { message: errorMessage(error, t('error.requestFailed')) }) })
                })
              } finally {
                inFlight = false
              }
            }
            const timer = setInterval(tick, JOB_POLL_MS)
            tick()
            return function () {
              cancelled = true
              clearInterval(timer)
            }
          },
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [job && job.id],
        )

        // ---- 知识库编译轮询（900ms；终态 / 超时即停；卸载时 abort） ----------
        useEffect(
          function () {
            const task = kbTask
            if (!task || !asString(task.jobId)) return undefined
            let cancelled = false
            let inFlight = false
            let finished = false
            const tick = async function () {
              if (cancelled || inFlight) return
              inFlight = true
              try {
                if (Date.now() - asNumber(task.startedAt, Date.now()) > KB_TIMEOUT_MS) {
                  cancelled = true
                  clearInterval(timer)
                  if (!finished) {
                    finished = true
                    latest.current.failKbTask(task, t('kb.timeout'))
                  }
                  return
                }
                const data = await kbApi('/job?id=' + encodeURIComponent(asString(task.jobId)))
                if (cancelled) return
                const normalized = normalizeKbJob(data.job || data)
                if (!normalized.status) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
                setKbJob(normalized)
                if (normalized.status === 'done' && !finished) {
                  finished = true
                  cancelled = true
                  clearInterval(timer)
                  latest.current.finishKbTask(task, normalized)
                } else if (normalized.status === 'failed' && !finished) {
                  finished = true
                  cancelled = true
                  clearInterval(timer)
                  latest.current.failKbTask(
                    task,
                    t('kb.failed', { message: normalized.error || normalized.message || t('kb.compileFailed') }),
                  )
                } else if (Date.now() - asNumber(task.startedAt, Date.now()) > KB_TIMEOUT_MS && !finished) {
                  finished = true
                  cancelled = true
                  clearInterval(timer)
                  latest.current.failKbTask(task, t('kb.timeout'))
                }
              } catch (error) {
                if (isAbort(error) || cancelled) return
                cancelled = true
                clearInterval(timer)
                if (!finished) {
                  finished = true
                  latest.current.failKbTask(task, t('kb.failed', { message: errorMessage(error, t('error.requestFailed')) }))
                }
              } finally {
                inFlight = false
              }
            }
            const timer = setInterval(tick, KB_POLL_MS)
            tick()
            return function () {
              cancelled = true
              clearInterval(timer)
            }
          },
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [kbTask && kbTask.jobId],
        )

        // ---- 键盘：Esc / ← → / ⌘↵ ------------------------------------------
        useEffect(
          function () {
            function handleKey(event) {
              if (!event) return
              if (event.key === 'Escape') {
                if (kbDialogOpen) {
                  event.preventDefault()
                  setKbDialogOpen(false)
                  return
                }
                if (dialog) {
                  event.preventDefault()
                  setDialog(null)
                  return
                }
                if (drawer) {
                  event.preventDefault()
                  setDrawer(null)
                  return
                }
                if (railOpen) {
                  event.preventDefault()
                  setRailOpen(false)
                }
                return
              }
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                if (!props.onBackToSearch && !dialog && view === 'empty') {
                  event.preventDefault()
                  latest.current.startSearch()
                }
                return
              }
              const target = event.target
              const tag = target && target.tagName ? String(target.tagName).toUpperCase() : ''
              const editable = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!(target && target.isContentEditable)
              if (editable) return
              if (dialog || drawer || railOpen) return
              if (view !== 'reading' || !viewModel) return
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              const questions = viewModel.questions
              if (questions.length === 0) return
              const currentIndex = questions.findIndex(function (question) {
                return asString(question.id) === asString(activeQuestion)
              })
              const step = event.key === 'ArrowRight' ? 1 : -1
              let nextIndex = currentIndex + step
              if (currentIndex < 0) nextIndex = 0
              if (nextIndex < 0) nextIndex = 0
              if (nextIndex > questions.length - 1) nextIndex = questions.length - 1
              event.preventDefault()
              scrollToQuestion(asString(questions[nextIndex].id))
            }
            document.addEventListener('keydown', handleKey)
            return function () {
              document.removeEventListener('keydown', handleKey)
            }
          },
          [dialog, drawer, railOpen, view, viewModel, activeQuestion, kbDialogOpen],
        )

        // ---- 派生数据 ------------------------------------------------------
        const filteredTopics = useMemo(
          function () {
            const keyword = asString(listQuery).trim().toLowerCase()
            if (!keyword) return topics
            return topics.filter(function (row) {
              return (asString(row.title) + ' ' + asString(row.query)).toLowerCase().indexOf(keyword) >= 0
            })
          },
          [topics, listQuery],
        )
        const groups = useMemo(
          function () {
            const buckets = { today: [], week: [], earlier: [] }
            const sorted = filteredTopics.slice().sort(function (a, b) {
              return asNumber(Date.parse(asString(b.updatedAt || b.createdAt)), 0) - asNumber(Date.parse(asString(a.updatedAt || a.createdAt)), 0)
            })
            for (const row of sorted) {
              buckets[dayBucket(row.updatedAt || row.createdAt)].push(row)
            }
            return [
              { id: 'today', key: 'rail.group.today', items: buckets.today },
              { id: 'week', key: 'rail.group.week', items: buckets.week },
              { id: 'earlier', key: 'rail.group.earlier', items: buckets.earlier },
            ].filter(function (group) {
              return group.items.length > 0
            })
          },
          [filteredTopics],
        )
        const runningTopicId = job && TERMINAL_JOB_STATUS.indexOf(asString(job.status)) < 0 ? asString(job.topicId) : ''
        const runningTopic = topics.find(function (row) {
          return asString(row.id) === asString(job && job.topicId)
        })
        const runningTitle =
          asString(runningTopic && runningTopic.title) ||
          (archive && asString(archive.id) === asString(job && job.topicId) ? asString(asObject(archive.topic).title) : '') ||
          asString(cache.lastQuery) ||
          asString(newQuery)
        const provider = {
          value: effectiveProvider,
          hasAnySearchApiKey: providerConfig.hasAnySearchApiKey,
          onChange: function (mode) {
            setSearchProviderMode(mode)
            cache.searchProviderMode = mode
            if (errorBar) setErrorBar('')
          },
        }

        // ---- 渲染 ----------------------------------------------------------
        let mainContent = null
        if (view === 'reading' && archive && viewModel) {
          mainContent = h(ReadingView, {
            key: 'reading',
            t: t,
            view: viewModel,
            activeSection: activeSection,
            activeQuestion: activeQuestion,
            highlight: highlight,
            onSection: scrollToSection,
            onBack: function () {
              cache.view = 'empty'
              cache.selectedId = ''
              setView('empty')
              setArchive(null)
              setHighlight([])
              setActiveQuestion('')
            },
            onAsk: props.onBackToSearch ? undefined : function () { openAsk(null) },
            onRefresh: props.onBackToSearch ? undefined : refreshTopic,
            refreshing: refreshing,
            onExport: exportTopic,
            onOpenKb: props.onBackToSearch ? undefined : openKbDialog,
            onDelete: props.onBackToSearch ? undefined : function () { setDialog({ type: 'delete' }) },
            onOpenChain: openChain,
            onOpenSource: openSource,
            onOpenAnnotation: openAnnotation,
            onJumpQuestion: scrollToQuestion,
            onFollowup: props.onBackToSearch ? undefined : openAsk,
          })
        } else if (view === 'running' && job) {
          mainContent = h(RunningView, {
            key: 'running',
            t: t,
            job: job,
            title: runningTitle,
            query: runningTitle,
            canceling: canceling,
            onCancel: cancelJob,
            onBack: function () {
              cache.view = 'empty'
              setView('empty')
              setRailOpen(true)
            },
          })
        } else if (view === 'loading') {
          mainContent = h(
            'div',
            { key: 'loading', className: 'ds-main-state' },
            h(LoadingBlock, { rows: 4, label: t('status.loading') }),
          )
        } else if (view === 'error') {
          mainContent = h(
            'div',
            { key: 'error', className: 'ds-main-state' },
            h(ErrorBlock, {
              text: archiveError || t('error.requestFailed'),
              hint: t('error.routeHint'),
              onRetry: function () {
                openTopic(asString(cache.selectedId))
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'ds-btn',
                onClick: function () {
                  cache.view = 'empty'
                  cache.selectedId = ''
                  setView('empty')
                },
              },
              h(Icon, { name: 'arrow-left', size: 14 }),
              h('span', null, t('reading.back')),
            ),
          )
        } else if (props.onBackToSearch) {
          mainContent = h('div', { key: 'history-empty', className: 'ds-direct-shell' },
            h('h1', { className: 'ds-direct-title' }, t('direct.history')),
            h('p', { className: 'ds-direct-state' }, t('direct.pickArchive')),
          )
        } else {
          mainContent = h(EmptyView, {
            key: 'empty',
            t: t,
            query: newQuery,
            depth: depth,
            provider: provider,
            anySearch: anySearch,
            starting: starting,
            error: railOpen ? '' : errorBar,
            onQuery: function (value) {
              setNewQuery(value)
              cache.newQuery = value
              if (errorBar) setErrorBar('')
            },
            onDepth: function (value) {
              setDepth(value)
              cache.depth = value
            },
            onExample: function (value) {
              setNewQuery(value)
              cache.newQuery = value
              if (errorBar) setErrorBar('')
            },
            onStart: startSearch,
          })
        }

        return h(
          'div',
          { className: 'ds-root', 'data-ds-root': 'true' },
          h('style', { key: 'ds-style' }, DS_CSS),
          railOpen
            ? h('div', { key: 'rail-scrim', className: 'ds-rail-scrim', onClick: function () { setRailOpen(false) }, 'aria-hidden': 'true' })
            : null,
          h(Rail, {
            key: 'rail',
            t: t,
            health: health,
            topics: topics,
            topicCount: topics.length,
            groups: groups,
            listStatus: listStatus,
            listError: listError,
            listQuery: listQuery,
            activeId: asString(cache.selectedId),
            runningTopicId: runningTopicId,
            query: newQuery,
            depth: depth,
            provider: provider,
            anySearch: anySearch,
            starting: starting,
            error: railOpen || view !== 'empty' ? errorBar : '',
            open: railOpen,
            onBackToSearch: props.onBackToSearch,
            onCloseRail: function () { setRailOpen(false) },
            onQuery: function (value) {
              setNewQuery(value)
              cache.newQuery = value
            },
            onDepth: function (value) {
              setDepth(value)
              cache.depth = value
            },
            onStart: startSearch,
            onSelect: function (id) {
              setRailOpen(false)
              if (asString(id) === asString(cache.selectedId) && view === 'reading') return
              openTopic(id)
            },
            onListQuery: function (value) {
              setListQuery(value)
              cache.listQuery = value
            },
            onSettings: function () {
              setSettingsError('')
              setDialog({ type: 'settings' })
            },
            onRetryTopics: function () {
              loadTopics()
            },
          }),
          h(
            'div',
            { key: 'mainwrap', className: 'ds-main-wrap' },
            h(
              'div',
              { className: 'ds-mobilebar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ds-iconbtn',
                  onClick: function () { setRailOpen(true) },
                  'aria-label': t('rail.open'),
                  title: t('rail.open'),
                },
                h(Icon, { name: 'menu', size: 18 }),
              ),
              h('span', { className: 'ds-mobilebar-title' }, t(props.onBackToSearch ? 'direct.history' : 'panel.label')),
              props.onBackToSearch ? h(
                'button',
                {
                  type: 'button',
                  className: 'ds-iconbtn',
                  onClick: props.onBackToSearch,
                  'aria-label': t('direct.back'),
                  title: t('direct.back'),
                },
                h(Icon, { name: 'arrow-left', size: 17 }),
              ) : h(
                'button',
                {
                  type: 'button',
                  className: 'ds-iconbtn',
                  onClick: function () { setSettingsError(''); setDialog({ type: 'settings' }) },
                  'aria-label': t('rail.settings'),
                  title: t('rail.settings'),
                },
                h(Icon, { name: 'settings', size: 17 }),
              ),
            ),
            h(
              'main',
              {
                key: 'main',
                className: 'ds-main',
                ref: mainRef,
                onScroll: handleMainScroll,
                'data-view': view,
                id: 'ds-main',
              },
              mainContent,
            ),
          ),
          drawer
            ? drawer.type === 'chain'
              ? h(ChainDrawer, {
                  key: 'chain-drawer',
                  t: t,
                  view: viewModel,
                  chainRef: drawer.ref,
                  onClose: closeDrawer,
                  onBack: drawer.parent ? drawerBack : null,
                  backLabel: drawerParentLabel(drawer.parent),
                  onOpenSource: function (id) { pushDrawer({ type: 'source', id: asString(id) }) },
                  onOpenAnnotation: function (number) { pushDrawer({ type: 'annotation', number: asNumber(number, 0) }) },
                  onOpenQuestion: function (questionId) {
                    setDrawer(null)
                    scrollToQuestion(questionId)
                  },
                })
              : drawer.type === 'annotation'
                ? h(AnnotationDrawer, {
                    key: 'annotation-drawer',
                    t: t,
                    view: viewModel,
                    number: drawer.number,
                    onClose: closeDrawer,
                    onBack: drawer.parent ? drawerBack : null,
                    backLabel: drawerParentLabel(drawer.parent),
                    onOpenSource: function (id) { pushDrawer({ type: 'source', id: asString(id) }) },
                    onOpenChain: function (ref) { pushDrawer({ type: 'chain', ref: ref }) },
                  })
                : h(SourceDrawer, {
                    key: 'source-drawer',
                    t: t,
                    view: viewModel,
                    sourceId: drawer.id,
                    onClose: closeDrawer,
                    onBack: drawer.parent ? drawerBack : null,
                    backLabel: drawerParentLabel(drawer.parent),
                    onOpenChain: function (ref) { pushDrawer({ type: 'chain', ref: ref }) },
                    onOpenAnnotation: function (number) { pushDrawer({ type: 'annotation', number: asNumber(number, 0) }) },
                    onJumpSection: function (sectionId) {
                      setDrawer(null)
                      scrollToSection(sectionId)
                    },
                  })
            : null,
          dialog && dialog.type === 'followup' && viewModel
            ? h(FollowupDialog, {
                key: 'ask-dialog',
                t: t,
                view: viewModel,
                prefill: followupPrefill,
                submitting: submittingAsk,
                error: askError,
                onSubmit: submitAsk,
                onClose: function () {
                  if (submittingAsk) return
                  setDialog(null)
                },
              })
            : null,
          dialog && dialog.type === 'settings'
            ? h(SettingsDialog, {
                key: 'settings-dialog',
                t: t,
                settings: settings || {},
                health: health || {},
                saving: savingSettings,
                error: settingsError,
                onSave: saveSettings,
                onClose: function () {
                  if (savingSettings) return
                  setDialog(null)
                },
              })
            : null,
          kbDialogOpen && viewModel
            ? h(KnowledgeBaseDialog, {
                key: 'kb-dialog',
                t: t,
                view: viewModel,
                format: kbFormat,
                onFormat: function (format) {
                  setKbFormat(format === 'brief' ? 'brief' : 'full')
                },
                estimates: kbEstimates,
                status: kbHealthStatus,
                meta: kbHealthMeta,
                healthError: kbHealthError,
                phase: kbPhase,
                job: kbJob,
                error: kbError,
                result: kbResult,
                records: kbRecords,
                onSubmit: function () {
                  startKbIngest(kbFormat)
                },
                onClose: closeKbDialog,
                onOpenKb: openKbInPanel,
              })
            : null,
          dialog && dialog.type === 'delete'
            ? h(ConfirmDialog, {
                key: 'delete-dialog',
                t: t,
                title: t('delete.title'),
                body: t('delete.body', { title: asString(asObject(archive && archive.topic).title) || t('panel.label') }),
                busy: deleting,
                onConfirm: deleteTopic,
                onClose: function () {
                  if (!deleting) setDialog(null)
                },
              })
            : null,
          h(Notice, { key: 'notice', notice: notice }),
        )
      }

      // ======================================================================
      // 主面板入口（main key='deep-search'）：ErrorBoundary + 状态容器
      // ======================================================================
      /**
       * 面板根组件。
       * @param {{ t: Function }} props 属性。
       * @returns {any}
       */
      function RootPanel(props) {
        const t = props.t
        const [history, setHistory] = useState(false)
        return h(
          DsErrorBoundary,
          { title: t('crash.title'), hint: t('crash.hint') },
          history
            ? h(PanelBody, { t: t, onBackToSearch: function () { setHistory(false) } })
            : h(DirectSearchPanel, { t: t, onOpenHistory: function () { setHistory(true) } }),
        )
      }

      function DirectSearchResults({ result, t }) {
        const rows = [
          ...result.sources.map(function (source) { return { source: asObject(source) } }),
          ...result.records.map(function (record) { return { record: asObject(record) } }),
        ]
        const positionOf = function (row) { return (row.source || row.record).position }
        if (rows.every(function (row) { return Number.isInteger(positionOf(row)) })) {
          rows.sort(function (left, right) { return positionOf(left) - positionOf(right) })
        }
        return h('section', { className: 'ds-direct-results', 'aria-labelledby': 'ds-direct-result-title' },
          h('h2', { id: 'ds-direct-result-title' }, t('direct.result', { query: result.query })),
          h('p', { className: 'ds-direct-meta', role: 'status' },
            [t('direct.resultCount', { count: rows.length }), result.mode ? searchModeLabel(result.mode, t) : ''].filter(Boolean).join(' · '),
          ),
          rows.length ? h('ol', { className: 'ds-direct-list', role: 'list' }, rows.map(function (row, index) {
            if (row.record) {
              return h('li', { className: 'ds-direct-item', key: index },
                h('h3', null, asString(row.record.title) || t('direct.record')),
                h('p', { className: 'ds-direct-record' }, asString(row.record.content)),
              )
            }
            const source = row.source
            const url = asString(source.url).trim()
            const href = /^https?:\/\//i.test(url) ? safeHref(url) : null
            const host = hostOf(href)
            const publisher = asString(source.publisher)
            const date = formatDate(source.publishedAt)
            const title = asString(source.title) || host || t('direct.record')
            const summary = asString(source.snippet) || asString(source.summary)
            return h('li', { className: 'ds-direct-item', key: index },
              h('p', { className: 'ds-direct-meta' },
                [publisher || host, publisher !== host && publisher ? host : '', date].filter(Boolean).join(' · '),
              ),
              h('h3', null, href ? h('a', { href: href, target: '_blank', rel: 'noreferrer noopener' }, title) : title),
              summary ? h('p', { className: 'ds-direct-summary' }, summary) : null,
            )
          })) : h('p', { className: 'ds-direct-state' }, t('direct.empty')),
        )
      }

      function DirectSearchSettings(props) {
        const t = props.t
        const dialogRef = useRef(null)
        const configured = asString(props.settings?.searchProviderMode) || 'auto'
        const [mode, setMode] = useState(configured)

        useEffect(function () {
          const dialog = dialogRef.current
          dialog.showModal()
          return function () { if (dialog.open) dialog.close() }
        }, [])

        return h('dialog', {
          ref: dialogRef,
          className: 'ds-modal ds-direct-dialog',
          'aria-labelledby': 'ds-direct-settings-title',
          onCancel: function (event) {
            event.preventDefault()
            if (!props.saving) props.onClose()
          },
        },
          h('header', { className: 'ds-modal-head' },
            h('h2', { id: 'ds-direct-settings-title', className: 'ds-modal-title' }, t('settings.title')),
            h('button', { type: 'button', className: 'ds-iconbtn', disabled: props.saving, onClick: props.onClose, 'aria-label': t('settings.cancel') },
              h(Icon, { name: 'close', size: 16 }),
            ),
          ),
          h('div', { className: 'ds-modal-body' },
            h(SearchProviderSelect, {
              t: t,
              className: 'ds-field',
              labelClassName: 'ds-field-label',
              labelKey: 'settings.defaultSearchMode',
              value: mode,
              onChange: setMode,
              disabled: !props.settings || props.loading || props.saving,
              hasAnySearchApiKey: props.settings?.hasAnySearchApiKey,
              describedBy: props.settings && !props.settings.hasAnySearchApiKey ? 'ds-direct-anysearch-key' : undefined,
            }),
            props.settings && !props.settings.hasAnySearchApiKey
              ? h('p', { id: 'ds-direct-anysearch-key', className: 'ds-field-hint' }, t('settings.anySearchKeyMissing'))
              : null,
            props.loading ? h('p', { className: 'ds-direct-state', role: 'status' }, t('status.loading')) : null,
            props.error ? h('p', { className: 'ds-modal-error', role: 'alert' }, props.error) : null,
            props.onRetry ? h('button', { type: 'button', className: 'ds-btn ds-btn-sm', onClick: props.onRetry }, t('status.retry')) : null,
            h('div', { className: 'ds-direct-history' },
              h('button', { type: 'button', className: 'ds-btn', disabled: props.saving, onClick: props.onOpenHistory },
                h(Icon, { name: 'book', size: 15 }),
                h('span', null, t('direct.history')),
              ),
            ),
          ),
          h('footer', { className: 'ds-modal-foot' },
            h('button', { type: 'button', className: 'ds-btn', disabled: props.saving, onClick: props.onClose }, t('settings.cancel')),
            h('button', {
              type: 'button',
              className: 'ds-btn ds-btn-primary',
              disabled: !props.settings || props.loading || props.saving || mode === configured,
              onClick: function () { props.onSave(mode) },
            }, props.saving ? t('settings.saving') : t('settings.save')),
          ),
        )
      }

      function DirectSearchPanel({ t, onOpenHistory }) {
        const [query, setQuery] = useState(cache.newQuery || '')
        const [provider, setProvider] = useState(cache.searchProviderMode || '')
        const [settings, setSettings] = useState(cache.settings)
        const [showSettings, setShowSettings] = useState(false)
        const [loadingSettings, setLoadingSettings] = useState(true)
        const [savingSettings, setSavingSettings] = useState(false)
        const [settingsError, setSettingsError] = useState('')
        const [result, setResult] = useState(cache.directResult)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const [canceled, setCanceled] = useState(false)
        const pending = useRef(null)
        const settingsRequest = useRef(null)
        const searchInput = useRef(null)
        const settingsButton = useRef(null)
        const effectiveProvider = provider || asString(settings?.searchProviderMode) || 'auto'
        const anySearch = useAnySearchSelection(effectiveProvider === 'anysearch')

        async function updateSettings(mode) {
          if (settingsRequest.current) return
          const saving = !!mode
          const controller = new AbortController()
          settingsRequest.current = controller
          setSettingsError('')
          if (saving) setSavingSettings(true)
          else setLoadingSettings(true)
          try {
            const data = await api('/settings', {
              method: saving ? 'PUT' : 'GET',
              body: saving ? { searchProviderMode: mode } : undefined,
              signal: controller.signal,
            })
            if (settingsRequest.current !== controller) return
            const next = data.settings && typeof data.settings === 'object' ? data.settings : data
            cache.settings = next
            setSettings(next)
            if (saving) {
              cache.searchProviderMode = ''
              setProvider('')
              closeSettings()
            }
          } catch (requestError) {
            if (settingsRequest.current !== controller || isAbort(requestError)) return
            setSettingsError(t(saving ? 'error.saveSettings' : 'error.loadSettings', { message: errorMessage(requestError) }))
          } finally {
            if (settingsRequest.current === controller) {
              settingsRequest.current = null
              if (saving) setSavingSettings(false)
              else setLoadingSettings(false)
            }
          }
        }

        useEffect(function () {
          updateSettings()
          return function () {
            pending.current?.abort()
            pending.current = null
            settingsRequest.current?.abort()
            settingsRequest.current = null
          }
        }, [])

        function closeSettings() {
          setShowSettings(false)
          requestAnimationFrame(function () { settingsButton.current?.focus() })
        }

        function cancelSearch() {
          const controller = pending.current
          if (!controller) return
          pending.current = null
          controller.abort()
          setBusy(false)
          setCanceled(true)
          requestAnimationFrame(function () { searchInput.current?.focus() })
        }

        async function search(event) {
          event?.preventDefault()
          if (!query.trim() || pending.current) return
          if (anySearch.blocked) {
            setError(t('anySearch.chooseToStart'))
            return
          }
          if (anySearch.missingEsportsFields.length) {
            const fields = anySearch.missingEsportsFields.map(function (key) { return esportsFieldLabel(key, t) })
            setError(t('anySearch.fillFields', { fields: fields.join('、') }))
            return
          }
          const body = { query: query }
          const selection = anySearch.getSelection()
          if (provider) body.searchProviderMode = provider
          if (selection) {
            body.searchProviderMode = 'anysearch'
            body.anySearch = selection
          }
          const controller = new AbortController()
          pending.current = controller
          setBusy(true)
          setError('')
          setCanceled(false)
          cache.directResult = null
          setResult(null)
          try {
            const data = await api('/search', { method: 'POST', body: body, signal: controller.signal })
            if (pending.current !== controller) return
            if (!Array.isArray(data.sources)) throw new ApiError(t('error.badResponse'), 'BAD_RESPONSE', 200)
            const next = { query: query, mode: asString(data.mode), sources: data.sources, records: asArray(data.records) }
            cache.directResult = next
            setResult(next)
          } catch (requestError) {
            if (pending.current !== controller || isAbort(requestError)) return
            setError(t('direct.error', { message: errorMessage(requestError) }))
          } finally {
            if (pending.current === controller) {
              pending.current = null
              setBusy(false)
            }
          }
        }

        return h('div', { className: 'ds-root ds-direct-root', 'data-ds-root': 'true' },
          h('style', { key: 'ds-style' }, DS_CSS),
          h('main', { className: 'ds-main ds-direct-main', 'data-view': 'search', id: 'ds-main' },
            h('div', { className: 'ds-direct-shell' },
              h('header', { className: 'ds-direct-head' },
                h('h1', { className: 'ds-direct-title' }, t('panel.label')),
                h('button', {
                  ref: settingsButton,
                  type: 'button',
                  className: 'ds-iconbtn',
                  title: t('settings.title'),
                  'aria-label': t('settings.title'),
                  'aria-haspopup': 'dialog',
                  onClick: function () { setShowSettings(true) },
                }, h(Icon, { name: 'settings', size: 18 })),
              ),
              h('form', { className: 'ds-direct-form', role: 'search', onSubmit: search },
                h('div', { className: 'ds-searchbox ds-direct-searchbox' },
                  h(Icon, { name: 'search', size: 19, className: 'ds-searchbox-icon' }),
                  h('input', {
                    ref: searchInput,
                    className: 'ds-searchbox-input',
                    type: 'search',
                    maxLength: 500,
                    value: query,
                    placeholder: t('direct.query'),
                    'aria-label': t('direct.query'),
                    onChange: function (event) {
                      const next = event.target.value
                      setQuery(next)
                      cache.newQuery = next
                      if (!busy) setError('')
                    },
                  }),
                  h('button', {
                    type: 'submit',
                    className: 'ds-btn ds-btn-primary ds-searchbox-submit',
                    disabled: busy || anySearch.blocked || !query.trim(),
                  }, busy ? t('direct.searching') : t('direct.search')),
                ),
                h('div', { className: 'ds-direct-controls' },
                  h(SearchProviderSelect, {
                    t: t,
                    className: 'ds-search-provider',
                    labelClassName: 'ds-direct-label',
                    value: effectiveProvider,
                    hasAnySearchApiKey: settings?.hasAnySearchApiKey,
                    disabled: busy,
                    onChange: function (mode) {
                      setProvider(mode)
                      cache.searchProviderMode = mode
                      setError('')
                    },
                  }),
                  busy ? h('button', { type: 'button', className: 'ds-btn ds-btn-sm', onClick: cancelSearch }, t('direct.cancel')) : null,
                ),
                h(AnySearchFields, { selection: anySearch, disabled: busy, id: 'ds-direct-anysearch', t: t }),
              ),
              error ? h('p', { className: 'ds-direct-error', role: 'alert' }, error) : null,
              busy ? h('p', { className: 'ds-direct-state', role: 'status' }, t('direct.searching')) : null,
              canceled && !busy ? h('p', { className: 'ds-direct-state', role: 'status' }, t('direct.canceled')) : null,
              result ? h(DirectSearchResults, { result: result, t: t }) : null,
            ),
          ),
          showSettings ? h(DirectSearchSettings, {
            key: asString(settings?.searchProviderMode) || 'auto',
            t: t,
            settings: settings,
            loading: loadingSettings,
            saving: savingSettings,
            error: settingsError,
            onRetry: settingsError && !settings ? function () { updateSettings() } : undefined,
            onSave: updateSettings,
            onOpenHistory: onOpenHistory,
            onClose: closeSettings,
          }) : null,
        )
      }

      // CSS 与 apply 见后续片段。

      // ======================================================================
      // 样式：全部写进组件内渲染的 <style>；颜色只用主题变量 + color-mix。
      // 令牌挂 .ds-root，类名前缀 ds-，浅色 / 深色自动适配。
      // ======================================================================
      const DS_CSS = [
        '/* ==== 设计令牌 ==== */',
        '.ds-root{--ds-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",sans-serif;--ds-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;--ds-s1:4px;--ds-s2:8px;--ds-s3:12px;--ds-s4:16px;--ds-s5:20px;--ds-s6:24px;--ds-s7:32px;--ds-s8:40px;--ds-r-xs:5px;--ds-r-sm:8px;--ds-r-md:12px;--ds-r-lg:14px;--ds-r-pill:999px;--ds-rail-w:280px;--ds-header-h:56px;--ds-article-max:760px;--ds-hairline:var(--dsw-alias-border-l2);--ds-text-1:var(--dsw-alias-label-primary);--ds-text-2:var(--dsw-alias-label-secondary);--ds-text-3:var(--dsw-alias-label-tertiary);--ds-text-caption:var(--dsw-alias-label-caption);--ds-surface-2:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,var(--dsw-alias-bg-base));--ds-surface-3:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,var(--dsw-alias-bg-base));--ds-card:var(--dsw-alias-bg-layer-1);--ds-tint:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);--ds-tint-strong:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);--ds-material:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);--ds-material-strong:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,transparent);--ds-success:var(--dsw-alias-state-success-primary);--ds-warning:var(--dsw-alias-state-warn-primary);--ds-warning-soft:var(--dsw-alias-state-warn-tertiary);--ds-danger:var(--dsw-alias-state-error-primary);--ds-info:var(--dsw-alias-state-business-primary);--ds-ring:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent);--ds-fast:120ms;--ds-normal:200ms;--ds-ease:cubic-bezier(.2,.8,.2,1);--ds-ease-spring:cubic-bezier(.32,.72,0,1);position:relative;box-sizing:border-box;display:flex;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--ds-text-1);font-family:var(--ds-font);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
        'html[data-platform="darwin"] .ds-root{padding-top:var(--dsh-frame-top-clearance,48px)}',
        '.ds-root *,.ds-root *::before,.ds-root *::after{box-sizing:border-box}',
        '.ds-root :where(button,input,textarea,select){font-family:inherit;font-size:inherit;color:inherit;letter-spacing:inherit}',
        '.ds-root :where(button){cursor:pointer;background:none;border:0;padding:0}',
        '.ds-root :where(button:disabled){cursor:default;opacity:.45}',
        '.ds-root a{color:var(--dsw-alias-brand-primary);text-underline-offset:2px}',
        '.ds-root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px;box-shadow:var(--ds-ring)}',
        '.ds-root ::selection{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}',
        '.ds-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
        '.ds-muted{margin:0;color:var(--ds-text-3);font-size:12.5px;line-height:1.65}',
        '.ds-spacer{flex:1 1 auto}',
        '.ds-icon{flex:none;display:block}',
        '/* ==== 直接搜索 ==== */',
        '.ds-direct-main{width:100%}',
        '.ds-direct-shell{max-width:860px;margin:0 auto;padding:clamp(20px,5vw,60px) clamp(16px,5vw,52px) 56px;min-width:0}',
        '.ds-direct-head{display:flex;align-items:center;justify-content:space-between;gap:var(--ds-s3);margin-bottom:var(--ds-s4)}',
        '.ds-direct-head>.ds-iconbtn{flex:none}',
        '.ds-direct-title{margin:0;color:var(--ds-text-1);font-size:clamp(1.4rem,3vw,1.85rem);line-height:1.2;font-weight:600;letter-spacing:-.025em}',
        '.ds-direct-form{width:100%;min-width:0}',
        '.ds-direct-searchbox .ds-searchbox-submit{padding-inline:clamp(10px,3vw,18px);overflow-wrap:anywhere}',
        '.ds-direct-controls{display:flex;align-items:center;gap:var(--ds-s2);flex-wrap:wrap;margin-top:var(--ds-s3)}',
        '.ds-direct-label,.ds-direct-meta,.ds-direct-state{color:var(--ds-text-2);font-size:.8125rem;overflow-wrap:anywhere}',
        '.ds-direct-state,.ds-direct-error{margin:var(--ds-s4) 0 0}',
        '.ds-direct-error{color:var(--ds-danger);overflow-wrap:anywhere}',
        '.ds-direct-results{margin-top:var(--ds-s6);padding-top:var(--ds-s4);border-top:1px solid var(--ds-hairline);min-width:0}',
        '.ds-direct-results h2{margin:0 0 var(--ds-s1);font-size:1rem;line-height:1.35;font-weight:600;overflow-wrap:anywhere}',
        '.ds-direct-meta{margin:0}',
        '.ds-direct-meta:empty{display:none}',
        '.ds-direct-list{display:grid;margin:var(--ds-s2) 0 0;padding:0;list-style:none}',
        '.ds-direct-item{padding:var(--ds-s4) 0;border-bottom:1px solid var(--ds-hairline);min-width:0;overflow-wrap:anywhere}',
        '.ds-direct-item:last-child{border-bottom:0}',
        '.ds-direct-item h3{margin:var(--ds-s1) 0;font-size:1.0625rem;line-height:1.35;font-weight:600;color:var(--ds-text-1)}',
        '.ds-direct-item a{text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 55%,transparent);text-underline-offset:.18em}',
        '.ds-direct-item a:hover{text-decoration-color:currentColor}',
        '.ds-direct-summary,.ds-direct-record{margin:var(--ds-s1) 0 0;color:var(--ds-text-2);line-height:1.55;white-space:pre-wrap}',
        '.ds-modal.ds-direct-dialog{position:fixed;inset:0;margin:auto;padding:0;width:min(440px,calc(100% - 28px));height:fit-content;max-height:min(80vh,620px);color:var(--ds-text-1)}',
        '.ds-modal.ds-direct-dialog:not([open]){display:none}',
        '.ds-direct-dialog::backdrop{background:color-mix(in srgb,#000 30%,transparent)}',
        '.ds-direct-history{padding-top:var(--ds-s3);border-top:1px solid var(--ds-hairline)}',
        '@media (pointer:coarse){.ds-direct-head .ds-iconbtn,.ds-direct-controls .ds-btn,.ds-direct-controls select,.ds-direct-dialog .ds-btn,.ds-direct-dialog .ds-iconbtn,.ds-direct-dialog select,.ds-direct-searchbox .ds-searchbox-submit{min-height:44px}.ds-direct-head .ds-iconbtn,.ds-direct-dialog .ds-iconbtn{min-width:44px}.ds-direct-searchbox{height:auto;min-height:58px}}',
        '/* ==== 左栏 ==== */',
        '.ds-rail{flex:0 0 var(--ds-rail-w);width:var(--ds-rail-w);min-width:0;height:100%;display:flex;flex-direction:column;border-right:.5px solid var(--ds-hairline);background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));z-index:40}',
        '.ds-rail-inner{display:flex;flex-direction:column;height:100%;min-height:0;padding:var(--ds-s4) var(--ds-s3) var(--ds-s2)}',
        '.ds-brand{display:flex;align-items:center;gap:var(--ds-s2);min-width:0;padding:2px var(--ds-s2) var(--ds-s4)}',
        '.ds-brand-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--ds-r-sm);background:var(--ds-tint);color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}',
        '.ds-brand-text{display:flex;flex-direction:column;gap:0;min-width:0;flex:1 1 auto}',
        '.ds-brand-name{font-size:13.5px;font-weight:600;line-height:1.35;letter-spacing:-0.01em;color:var(--ds-text-1);white-space:nowrap}',
        '.ds-brand-caption{font-size:10.5px;line-height:1.3;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-rail-close{display:none;flex:none;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--ds-r-sm);color:var(--ds-text-2)}',
        '.ds-rail-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-new{display:flex;flex-direction:column;gap:var(--ds-s2);padding:0 var(--ds-s2) var(--ds-s4)}',
        '.ds-new-box{position:relative;display:flex;align-items:center}',
        '.ds-new-icon{position:absolute;left:10px;color:var(--ds-text-3);pointer-events:none}',
        '.ds-input{width:100%;height:32px;padding:0 var(--ds-s3);border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);color:var(--ds-text-1);font-size:12.5px;line-height:1.4;outline:none;transition:border-color var(--ds-fast) var(--ds-ease),box-shadow var(--ds-fast) var(--ds-ease)}',
        '.ds-input::placeholder{color:var(--ds-text-caption)}',
        '.ds-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,var(--ds-hairline));box-shadow:var(--ds-ring)}',
        '.ds-new-input{padding-left:31px;background:var(--ds-card)}',
        '.ds-new-depth{display:flex;align-items:center;gap:var(--ds-s2)}',
        '.ds-depth{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-surface-2);min-width:0}',
        '.ds-depth-lg{gap:4px;padding:3px;border-radius:var(--ds-r-md)}',
        '.ds-depth-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 9px;border-radius:calc(var(--ds-r-sm) - 2px);color:var(--ds-text-2);font-size:11.5px;font-weight:500;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease),box-shadow var(--ds-fast) var(--ds-ease)}',
        '.ds-depth-lg .ds-depth-btn{height:32px;padding:0 14px;font-size:12.5px}',
        '.ds-depth-btn:hover:not(.ds-depth-active){color:var(--ds-text-1)}',
        '.ds-depth-active{background:var(--ds-card);color:var(--ds-text-1);font-weight:600;box-shadow:var(--dsw-elevation-prominent)}',
        '.ds-depth-hint{font-size:10.5px;color:var(--ds-text-3);font-weight:400}',
        '.ds-depth-active .ds-depth-hint{color:var(--ds-text-2)}',
        '.ds-new-submit{flex:1 1 auto;height:32px;padding:0 10px;font-size:12px}',
        '/* ==== 按钮 / 徽章 / 输入 ==== */',
        '.ds-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);color:var(--ds-text-1);font-size:12.5px;font-weight:500;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease),filter var(--ds-fast) var(--ds-ease),transform var(--ds-fast) var(--ds-ease)}',
        '.ds-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-btn:active:not(:disabled){transform:translateY(.5px)}',
        '.ds-btn-sm{height:28px;padding:0 10px;font-size:12px}',
        '.ds-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
        '.ds-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}',
        '.ds-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-brand-primary)}',
        '.ds-btn-ghost:hover:not(:disabled){background:var(--ds-tint)}',
        '.ds-btn-danger{border-color:transparent;background:transparent;color:var(--ds-danger)}',
        '.ds-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--ds-danger) 11%,transparent)}',
        '.ds-btn-solid{background:var(--ds-danger);color:var(--dsw-alias-bg-base);border-color:transparent}',
        '.ds-btn-solid:hover:not(:disabled){background:var(--ds-danger);filter:brightness(1.05)}',
        '.ds-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:var(--ds-r-sm);color:var(--ds-text-2);transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease)}',
        '.ds-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-spinner{width:14px;height:14px;border:1.5px solid color-mix(in srgb,var(--ds-text-3) 45%,transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:ds-spin .8s linear infinite;flex:none}',
        '.ds-spinner-sm{width:11px;height:11px;border-width:1.5px}',
        '@keyframes ds-spin{to{transform:rotate(360deg)}}',
        '.ds-badge{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:var(--ds-r-pill);font-size:10.5px;font-weight:600;line-height:1;white-space:nowrap}',
        '.ds-badge-neutral{background:var(--ds-surface-3);color:var(--ds-text-2)}',
        '.ds-identity[data-identity="fact"]{background:color-mix(in srgb,var(--ds-success) 13%,transparent);color:color-mix(in srgb,var(--ds-success) 62%,var(--ds-text-1))}',
        '.ds-identity[data-identity="claim"]{background:color-mix(in srgb,var(--ds-warning) 18%,transparent);color:color-mix(in srgb,var(--ds-warning) 55%,var(--ds-text-1))}',
        '.ds-identity[data-identity="analysis"]{background:color-mix(in srgb,var(--ds-info) 13%,transparent);color:color-mix(in srgb,var(--ds-info) 66%,var(--ds-text-1))}',
        '.ds-identity[data-identity="unknown"]{background:var(--ds-surface-3);color:var(--ds-text-2)}',
        '.ds-confidence{background:transparent;padding:0 2px;color:var(--ds-text-2);font-weight:500}',
        '.ds-confidence::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.9}',
        '.ds-confidence[data-level="high"]{color:color-mix(in srgb,var(--ds-success) 66%,var(--ds-text-1))}',
        '.ds-confidence[data-level="medium"]{color:color-mix(in srgb,var(--ds-warning) 60%,var(--ds-text-1))}',
        '.ds-confidence[data-level="low"]{color:color-mix(in srgb,var(--ds-danger) 62%,var(--ds-text-1))}',
        '.ds-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);color:var(--ds-text-2);font-size:11px;line-height:1;white-space:nowrap}',
        '.ds-linkbtn{display:inline-flex;align-items:center;gap:3px;color:var(--dsw-alias-brand-primary);font-size:11.5px;font-weight:500;line-height:1.2;white-space:nowrap}',
        '.ds-linkbtn:hover{text-decoration:underline}',
        '.ds-status-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--ds-text-caption)}',
        '.ds-status-dot[data-status="done"]{background:var(--ds-success)}',
        '.ds-status-dot[data-status="partial"]{background:var(--ds-warning)}',
        '.ds-status-dot[data-status="failed"]{background:var(--ds-danger)}',
        '.ds-status-dot[data-status="running"],.ds-status-dot[data-status="researching"],.ds-status-dot[data-status="running"]{background:var(--dsw-alias-brand-primary)}',
        '.ds-status-dot[data-status="running"]{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);animation:ds-pulse 1.8s ease-in-out infinite}',
        '.ds-status-dot[data-status="queued"],.ds-status-dot[data-status="draft"],.ds-status-dot[data-status="pending"]{background:var(--ds-text-caption)}',
        '@keyframes ds-pulse{0%,100%{opacity:.55}50%{opacity:1}}',
        '/* ==== 档案列表 ==== */',
        '.ds-list-tools{display:flex;align-items:center;gap:6px;padding:0 var(--ds-s2) var(--ds-s2);position:relative}',
        '.ds-list-tools-icon{position:absolute;left:18px;color:var(--ds-text-3);pointer-events:none}',
        '.ds-list-search{height:28px;padding-left:28px;font-size:11.5px;background:transparent;border-color:transparent}',
        '.ds-list-search:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-list-search:focus{background:var(--ds-card);border-color:var(--ds-hairline)}',
        '.ds-list-count{flex:none;font-size:10.5px;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-rail-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 var(--ds-s2);scrollbar-width:thin;scrollbar-gutter:stable}',
        '.ds-rail-list::-webkit-scrollbar{width:8px}',
        '.ds-rail-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border:2px solid transparent;border-radius:var(--ds-r-pill);background-clip:content-box}',
        '.ds-rail-list-state{display:flex;align-items:center;gap:8px;padding:var(--ds-s3) var(--ds-s2);font-size:11.5px;color:var(--ds-text-3)}',
        '.ds-rail-empty{margin:0;padding:var(--ds-s3) var(--ds-s2);font-size:11.5px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-group{padding-bottom:var(--ds-s2)}',
        '.ds-group-title{display:flex;align-items:center;gap:6px;padding:var(--ds-s2) var(--ds-s2) 4px;font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3)}',
        '.ds-group-count{font-weight:400;color:var(--ds-text-caption);font-variant-numeric:tabular-nums}',
        '.ds-topic-row{display:flex;flex-direction:column;gap:3px;width:100%;min-width:0;padding:8px var(--ds-s2) 9px;border:0;border-left:2px solid transparent;border-radius:var(--ds-r-xs);background:transparent;text-align:left;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-topic-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-topic-active{background:var(--ds-tint);border-left-color:var(--dsw-alias-brand-primary)}',
        '.ds-topic-active:hover{background:var(--ds-tint)}',
        '.ds-topic-title-row{display:flex;align-items:center;gap:6px;min-width:0}',
        '.ds-topic-title{min-width:0;flex:1 1 auto;font-size:12.5px;font-weight:500;line-height:1.4;color:var(--ds-text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ds-topic-running{flex:none;font-size:9.5px;font-weight:600;color:var(--dsw-alias-brand-primary);background:var(--ds-tint);padding:1px 5px;border-radius:var(--ds-r-pill);line-height:1.3}',
        '.ds-topic-meta{display:flex;align-items:center;gap:5px;min-width:0;padding-left:12px;font-size:10.5px;line-height:1.4;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-dot-sep{width:2px;height:2px;border-radius:50%;background:var(--ds-text-caption);flex:none}',
        '.ds-row-updated{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ds-text-caption)}',
        '.ds-rail-foot{flex:none;display:flex;align-items:center;gap:6px;padding:var(--ds-s2) var(--ds-s3);border-top:.5px solid var(--ds-hairline)}',
        '.ds-foot-status{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto}',
        '.ds-foot-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;line-height:1.35;color:var(--ds-text-3)}',
        '/* ==== 主区骨架 ==== */',
        '.ds-main-wrap{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;container-type:inline-size;container-name:dsmain}',
        '.ds-main{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin}',
        '.ds-main::-webkit-scrollbar{width:10px}',
        '.ds-main::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border:3px solid transparent;border-radius:var(--ds-r-pill);background-clip:content-box}',
        '.ds-mobilebar{display:none;flex:none;align-items:center;gap:6px;height:48px;padding:0 var(--ds-s3);border-bottom:.5px solid var(--ds-hairline);background:var(--ds-material);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%)}',
        '.ds-mobilebar-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;text-align:center}',
        '.ds-rail-scrim{display:none}',
        '.ds-main-state{display:flex;flex-direction:column;align-items:center;gap:var(--ds-s3);padding:64px 24px;max-width:520px;margin:0 auto;width:100%}',
        '/* ==== 空状态 ==== */',
        '.ds-empty{display:flex;align-items:flex-start;justify-content:center;min-height:100%;padding:7vh 32px 48px}',
        '.ds-empty-inner{display:flex;flex-direction:column;align-items:flex-start;width:100%;max-width:720px}',
        '.ds-empty-eyebrow{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px 0 4px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);color:var(--ds-text-2);font-size:11.5px;font-weight:500;letter-spacing:.01em}',
        '.ds-empty-eyebrow .ds-brand-mark{width:22px;height:22px;border-radius:var(--ds-r-pill);background:var(--ds-tint)}',
        '.ds-empty-title{margin:22px 0 0;font-size:28px;font-weight:600;line-height:1.18;letter-spacing:-0.022em;color:var(--ds-text-1);max-width:15em;text-wrap:balance}',
        '.ds-empty-subtitle{margin:12px 0 0;max-width:34em;font-size:14px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-empty-form{width:100%;margin-top:28px}',
        '.ds-searchbox{display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:54px;padding:6px 6px 6px 16px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);box-shadow:var(--dsw-elevation-prominent);transition:border-color var(--ds-fast) var(--ds-ease),box-shadow var(--ds-fast) var(--ds-ease)}',
        '.ds-searchbox:focus-within{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--ds-hairline));box-shadow:var(--dsw-elevation-prominent),var(--ds-ring)}',
        '.ds-searchbox-icon{flex:none;color:var(--ds-text-3)}',
        '.ds-searchbox-input{flex:1 1 auto;min-width:0;height:100%;border:0;background:transparent;outline:none;font-size:15.5px;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-searchbox-input::placeholder{color:var(--ds-text-caption)}',
        '.ds-searchbox-submit{flex:none;height:42px;padding:0 18px;border-radius:calc(var(--ds-r-lg) - 5px);font-size:13px}',
        '.ds-empty-controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:12px;min-height:32px}',
        '.ds-empty-depth{display:inline-flex;align-items:center;gap:8px}',
        '.ds-search-provider{display:inline-flex;align-items:center;gap:var(--ds-s2);max-width:100%}',
        '.ds-search-provider .ds-input{width:auto;min-width:0;cursor:pointer}',
        '.ds-search-provider .ds-input:disabled{cursor:default}',
        '.ds-new-provider .ds-input{flex:1}',
        '.ds-anysearch{display:grid;gap:var(--ds-s2);width:100%;min-width:0;margin-top:var(--ds-s3);padding:var(--ds-s3);border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--ds-surface-2)}',
        '.ds-new .ds-anysearch{margin-top:0;padding:var(--ds-s2)}',
        '.ds-anysearch-selects,.ds-anysearch-param-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:var(--ds-s2);min-width:0}',
        '.ds-anysearch-field{display:grid;gap:var(--ds-s1);align-content:start;min-width:0;color:var(--ds-text-2);font-size:.8125rem;line-height:1.4;overflow-wrap:anywhere}',
        '.ds-anysearch-field .ds-input{min-width:0;min-height:34px;height:auto;padding-block:5px;font-size:.8125rem}',
        '.ds-anysearch-help{font-size:.75rem;line-height:1.45;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-anysearch-status{display:flex;align-items:center;flex-wrap:wrap;gap:var(--ds-s2)}',
        '.ds-anysearch-params{display:grid;gap:var(--ds-s2);min-width:0}',
        '.ds-new .ds-anysearch-params{max-height:28vh;overflow:auto;padding:2px;overscroll-behavior:contain}',
        '.ds-anysearch-optional>summary{cursor:pointer;padding-block:8px;color:var(--ds-text-2);font-size:.8125rem}',
        '.ds-anysearch-optional[open]>summary{margin-bottom:var(--ds-s1)}',
        '@media (pointer:coarse){.ds-anysearch-field .ds-input,.ds-anysearch-status .ds-btn,.ds-anysearch-optional>summary{min-height:44px}}',
        '.ds-empty-control-label{font-size:11px;color:var(--ds-text-3)}',
        '.ds-empty-kbd{margin-left:auto;font-size:10.5px;color:var(--ds-text-caption);font-family:var(--ds-mono);white-space:nowrap}',
        '.ds-empty-error{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.5;color:var(--ds-danger)}',
        '.ds-examples{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:22px}',
        '.ds-examples-label{font-size:11px;color:var(--ds-text-3);margin-right:2px}',
        '.ds-example{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 11px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-pill);background:transparent;color:var(--ds-text-2);font-size:11.5px;line-height:1;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-example:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-example-label{font-weight:600}',
        '.ds-example-query{color:var(--ds-text-3)}',
        '.ds-example:hover .ds-example-query{color:var(--ds-text-2)}',
        '.ds-empty-method{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:38px;padding-top:16px;border-top:.5px solid var(--ds-hairline);width:100%;max-width:640px}',
        '.ds-empty-method-line{width:24px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary);opacity:.7;margin-bottom:2px}',
        '.ds-empty-method p{margin:0;font-size:12px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-empty-chain{margin-top:2px !important;color:var(--ds-text-3) !important;font-family:var(--ds-mono);font-size:10.5px !important;letter-spacing:.01em}',
        '.ds-empty-chain-caption{font-size:10.5px;color:var(--ds-text-caption)}',
        '/* ==== 运行态 ==== */',
        '.ds-running{display:flex;justify-content:center;min-height:100%;padding:6vh 32px 48px}',
        '.ds-running-inner{display:flex;flex-direction:column;gap:18px;width:100%;max-width:720px}',
        '.ds-running-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.ds-runtime-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);color:var(--ds-text-2);font-size:11px;font-weight:600;line-height:1}',
        '.ds-runtime-pill[data-status="failed"]{background:color-mix(in srgb,var(--ds-danger) 12%,transparent);color:color-mix(in srgb,var(--ds-danger) 70%,var(--ds-text-1))}',
        '.ds-runtime-pill[data-status="done"]{background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 62%,var(--ds-text-1))}',
        '.ds-running-elapsed{font-size:11px;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-running-title{margin:0;font-size:28px;font-weight:600;line-height:1.24;letter-spacing:-0.018em;color:var(--ds-text-1);text-wrap:balance}',
        '.ds-running-subtitle{margin:0;font-size:12.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-progress-card{display:flex;flex-direction:column;gap:16px;padding:20px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card)}',
        '.ds-stages{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));align-items:start;gap:0;width:100%}',
        '.ds-stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;text-align:center}',
        '.ds-stage-line{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:18px}',
        '.ds-stage-line::before{content:"";position:absolute;left:0;right:50%;top:50%;height:1px;background:var(--ds-hairline)}',
        '.ds-stage-line::after{content:"";position:absolute;left:50%;right:0;top:50%;height:1px;background:var(--ds-hairline)}',
        '.ds-stage:first-child .ds-stage-line::before{display:none}',
        '.ds-stage:last-child .ds-stage-line::after{display:none}',
        '.ds-stage[data-state="done"] .ds-stage-line::before,.ds-stage[data-state="done"] .ds-stage-line::after,.ds-stage[data-state="current"] .ds-stage-line::before{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
        '.ds-stage-dot{position:relative;z-index:1;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--ds-hairline);background:var(--ds-card);color:var(--dsw-alias-bg-base)}',
        '.ds-stage[data-state="done"] .ds-stage-dot{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
        '.ds-stage[data-state="current"] .ds-stage-dot{border-color:var(--dsw-alias-brand-primary);background:var(--ds-card)}',
        '.ds-stage-dot-core{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
        '.ds-stage-label{font-size:10px;line-height:1.32;color:var(--ds-text-3);white-space:normal;overflow-wrap:anywhere;padding:0 1px;text-align:center}',
        '.ds-stage[data-state="current"] .ds-stage-label{color:var(--ds-text-1);font-weight:600}',
        '.ds-stage[data-state="done"] .ds-stage-label{color:var(--ds-text-2)}',
        '.ds-stage-state{font-size:9px;line-height:1.2;color:var(--ds-text-caption);white-space:nowrap}',
        '.ds-stage[data-state="current"] .ds-stage-state{color:var(--dsw-alias-brand-primary)}',
        '.ds-progress-row{display:flex;align-items:center;gap:10px}',
        '.ds-progress{flex:1 1 auto;height:5px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);overflow:hidden}',
        '.ds-progress-bar{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);transition:width var(--ds-normal) var(--ds-ease)}',
        '.ds-progress-value{flex:none;font-size:11.5px;font-weight:600;color:var(--ds-text-2);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}',
        '.ds-current{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding-top:2px}',
        '.ds-current-label{font-size:10.5px;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-current-text{font-size:12.5px;line-height:1.5;color:var(--ds-text-1)}',
        '.ds-current-count{font-size:10.5px;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-log{display:flex;flex-direction:column;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);overflow:hidden}',
        '.ds-log-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--ds-hairline)}',
        '.ds-log-title{font-size:11px;font-weight:600;color:var(--ds-text-2)}',
        '.ds-log-count{font-size:10px;color:var(--ds-text-3)}',
        '.ds-log-body{height:220px;overflow-y:auto;padding:8px 14px;font-family:var(--ds-mono);font-size:11px;line-height:1.7;scrollbar-width:thin}',
        '.ds-log-empty{padding:10px 0;color:var(--ds-text-3);font-family:var(--ds-font);font-size:11.5px}',
        '.ds-log-line{display:flex;gap:10px;min-width:0}',
        '.ds-log-time{flex:none;color:var(--ds-text-caption);font-variant-numeric:tabular-nums}',
        '.ds-log-text{min-width:0;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-log-line[data-level="warn"] .ds-log-text{color:color-mix(in srgb,var(--ds-warning) 62%,var(--ds-text-1))}',
        '.ds-log-line[data-level="error"] .ds-log-text{color:color-mix(in srgb,var(--ds-danger) 72%,var(--ds-text-1))}',
        '.ds-running-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ds-errorblock{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 14px;border:.5px solid color-mix(in srgb,var(--ds-danger) 32%,var(--ds-hairline));border-radius:var(--ds-r-md);background:color-mix(in srgb,var(--ds-danger) 6%,transparent)}',
        '.ds-errorblock-head{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.55;color:color-mix(in srgb,var(--ds-danger) 76%,var(--ds-text-1))}',
        '.ds-errorblock-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-loading{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;width:100%;color:var(--ds-text-3)}',
        '.ds-loading-label{font-size:12px}',
        '.ds-skeleton{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;margin-top:8px}',
        '.ds-skeleton-row{height:10px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);animation:ds-pulse 1.6s ease-in-out infinite}',
        '/* ==== 阅读态 ==== */',
        '.ds-reading{display:flex;flex-direction:column;min-height:100%;padding-bottom:64px}',
        '.ds-reading-head{display:flex;flex-direction:column;gap:14px;width:100%;max-width:calc(var(--ds-article-max) + 220px + 48px);margin:0 auto;padding:26px 32px 0}',
        '.ds-reading-topline{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}',
        '.ds-backbtn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 2px;color:var(--ds-text-3);font-size:11.5px;line-height:1;white-space:nowrap;transition:color var(--ds-fast) var(--ds-ease)}',
        '.ds-backbtn:hover{color:var(--ds-text-1)}',
        '.ds-reading-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
        '.ds-kb-btn{position:relative}',
        '.ds-kb-saved{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--ds-hairline))}',
        '.ds-kb-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);margin-left:-1px}',
        '.ds-export{position:relative;display:inline-flex}',
        '.ds-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:210px;padding:5px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);animation:ds-menu-in var(--ds-fast) var(--ds-ease)}',
        '.ds-menu-item{display:flex;align-items:center;width:100%;height:30px;padding:0 9px;border-radius:var(--ds-r-xs);color:var(--ds-text-1);font-size:12px;line-height:1;text-align:left;white-space:nowrap}',
        '.ds-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '@keyframes ds-menu-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}',
        '.ds-reading-titleblock{display:flex;flex-direction:column;gap:7px;min-width:0}',
        '.ds-reading-titlerow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}',
        '.ds-reading-title{margin:0;font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-0.02em;color:var(--ds-text-1);overflow-wrap:anywhere;text-wrap:balance}',
        '.ds-kind-badge{display:inline-flex;align-items:center;height:21px;padding:0 8px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);color:var(--ds-text-2);font-size:10.5px;font-weight:600;line-height:1;white-space:nowrap}',
        '.ds-status-badge[data-status="partial"]{background:color-mix(in srgb,var(--ds-warning) 16%,transparent);color:color-mix(in srgb,var(--ds-warning) 58%,var(--ds-text-1))}',
        '.ds-status-badge[data-status="failed"]{background:color-mix(in srgb,var(--ds-danger) 12%,transparent);color:color-mix(in srgb,var(--ds-danger) 70%,var(--ds-text-1))}',
        '.ds-reading-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;line-height:1.5;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-meta-sep{width:2px;height:2px;border-radius:50%;background:var(--ds-text-caption)}',
        '.ds-definition{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;padding:14px 0 2px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-definition-label{font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3);padding-top:2px;white-space:nowrap}',
        '.ds-definition-text{margin:0;font-size:14px;line-height:1.75;color:var(--ds-text-1);max-width:66ch}',
        '.ds-tensions{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start}',
        '.ds-tensions-label{font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3);padding-top:3px;white-space:nowrap}',
        '.ds-tension-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
        '.ds-tension{position:relative;padding-left:13px;font-size:12.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-tension::before{content:"";position:absolute;left:0;top:.62em;width:5px;height:5px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}',
        '.ds-howto{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;padding:10px 12px;border-radius:var(--ds-r-md);background:var(--ds-surface-2)}',
        '.ds-howto-label{font-size:10.5px;font-weight:600;color:var(--ds-text-3);white-space:nowrap;padding-top:2px}',
        '.ds-howto p{margin:0;font-size:12px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-anchorbar{display:none;position:sticky;top:0;z-index:20;align-items:center;gap:2px;width:100%;margin-top:18px;padding:6px 20px;border-top:.5px solid var(--ds-hairline);border-bottom:.5px solid var(--ds-hairline);background:var(--ds-material);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);overflow-x:auto;scrollbar-width:none}',
        '.ds-anchorbar::-webkit-scrollbar{display:none}',
        '.ds-anchor{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:var(--ds-r-sm);color:var(--ds-text-2);font-size:11.5px;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease)}',
        '.ds-anchor:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-anchor-active{background:var(--ds-tint);color:var(--dsw-alias-brand-primary);font-weight:600}',
        '.ds-anchor-count{font-size:9.5px;font-weight:400;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-anchor-active .ds-anchor-count{color:var(--dsw-alias-brand-primary);opacity:.75}',
        '.ds-reading-grid{display:grid;grid-template-columns:minmax(0,var(--ds-article-max)) 220px;gap:48px;justify-content:center;width:100%;max-width:calc(var(--ds-article-max) + 220px + 48px);margin:0 auto;padding:28px 32px 0;align-items:start}',
        '.ds-article{min-width:0;max-width:var(--ds-article-max)}',
        '.ds-toc{position:sticky;top:24px;display:flex;flex-direction:column;gap:20px;min-width:0;max-height:calc(100vh - 120px);overflow-y:auto;padding-right:2px;scrollbar-width:none}',
        '.ds-toc::-webkit-scrollbar{display:none}',
        '.ds-toc-block{display:flex;flex-direction:column;gap:6px}',
        '.ds-toc-title{font-size:10.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3);padding:0 8px}',
        '.ds-toc-nav{display:flex;flex-direction:column;gap:1px}',
        '.ds-toc-nav .ds-anchor{justify-content:space-between;width:100%;height:28px;padding:0 8px;border-radius:var(--ds-r-xs);text-align:left}',
        '.ds-toc-nav .ds-anchor-active{background:var(--ds-tint)}',
        '.ds-toc-nav .ds-anchor-count{margin-left:auto}',
        '.ds-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:0;padding:0 0 0 8px}',
        '.ds-stats-inline{display:none;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;width:100%;margin:14px 0 4px;padding:0}',
        '.ds-stat{display:flex;flex-direction:column;gap:0;min-width:0;padding:6px 8px;border-radius:var(--ds-r-xs);background:var(--ds-surface-2)}',
        '.ds-stat dt{font-size:9.5px;line-height:1.3;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-stat dd{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--ds-text-1);font-variant-numeric:tabular-nums}',
        '.ds-stat-hint{display:block;font-size:9px;font-weight:400;line-height:1.35;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-toc-hint{margin:0;padding:0 8px;font-size:10px;line-height:1.55;color:var(--ds-text-caption)}',
        '.ds-section{padding:30px 0 4px;border-top:.5px solid var(--ds-hairline);margin-top:24px;scroll-margin-top:64px}',
        '.ds-section:first-of-type{border-top:0;margin-top:0;padding-top:0}',
        '.ds-section-head{display:flex;flex-direction:column;gap:4px;margin-bottom:16px}',
        '.ds-section-head-main{display:flex;align-items:baseline;gap:10px;min-width:0}',
        '.ds-section-index{font-family:var(--ds-mono);font-size:10.5px;color:var(--ds-text-caption);font-variant-numeric:tabular-nums;flex:none}',
        '.ds-section-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.012em;color:var(--ds-text-1)}',
        '.ds-section-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);color:var(--ds-text-3);font-size:10px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}',
        '.ds-section-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-subhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin:22px 0 10px}',
        '.ds-subhead h3,.ds-subhead h4{margin:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-subhead-hint{font-size:10.5px;color:var(--ds-text-3);line-height:1.4}',
        '.ds-block-title{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:12px;font-weight:600;line-height:1.4;color:var(--ds-text-2)}',
        '.ds-block-count{font-size:10px;font-weight:400;color:var(--ds-text-3)}',
        '.ds-prose{display:flex;flex-direction:column;gap:11px}',
        '.ds-prose-p{margin:0;font-size:14px;line-height:1.72;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-prose-p strong{font-weight:600;color:var(--ds-text-1)}',
        '.ds-inline-code{padding:1px 5px;border-radius:4px;background:var(--ds-surface-3);font-family:var(--ds-mono);font-size:12px}',
        '.ds-overview-brief{padding-top:2px}',
        '.ds-findings-block{margin-top:6px}',
        '.ds-findings{display:flex;flex-direction:column;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);overflow:hidden;background:var(--ds-card)}',
        '.ds-finding{display:flex;align-items:flex-start;gap:12px;width:100%;padding:14px 14px 13px;border-bottom:.5px solid var(--ds-hairline);background:transparent;text-align:left;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-finding:last-child{border-bottom:0}',
        '.ds-finding:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-finding-index{flex:none;font-family:var(--ds-mono);font-size:10px;color:var(--ds-text-caption);padding-top:3px;font-variant-numeric:tabular-nums}',
        '.ds-finding-body{display:flex;flex-direction:column;gap:7px;min-width:0;flex:1 1 auto}',
        '.ds-finding-text{font-size:13px;line-height:1.62;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-finding-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;line-height:1.4;color:var(--ds-text-3)}',
        '.ds-meta-item{color:var(--ds-text-3)}',
        '.ds-meta-warn{color:color-mix(in srgb,var(--ds-warning) 58%,var(--ds-text-1))}',
        '.ds-finding-chevron{flex:none;color:var(--ds-text-caption);margin-top:3px;transition:transform var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease)}',
        '.ds-finding:hover .ds-finding-chevron{color:var(--ds-text-2);transform:translateX(1px)}',
        '.ds-timeline-block{margin-top:26px}',
        '.ds-timeline{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}',
        '.ds-timeline-item{display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;padding:9px 0;border-top:.5px solid var(--ds-hairline)}',
        '.ds-timeline-item:first-child{border-top:0}',
        '.ds-timeline-at{font-family:var(--ds-mono);font-size:10.5px;color:var(--ds-text-3);padding-top:1px}',
        '.ds-timeline-text{font-size:12.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-timeline-sources{grid-column:2;display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
        '/* ==== 问题地图 ==== */',
        '.ds-map{display:flex;flex-direction:column;margin-top:4px}',
        '.ds-map-row{display:flex;gap:12px;min-width:0}',
        '.ds-map-rail{flex:none;display:flex;flex-direction:column;align-items:center;width:12px;padding-top:18px}',
        '.ds-map-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.7}',
        '.ds-map-line{flex:1 1 auto;width:1px;background:var(--ds-hairline);margin-top:6px;min-height:18px}',
        '.ds-map-card{flex:1 1 auto;display:flex;flex-direction:column;gap:9px;min-width:0;margin-bottom:10px;padding:14px 15px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);text-align:left;transition:border-color var(--ds-fast) var(--ds-ease),background-color var(--ds-fast) var(--ds-ease),transform var(--ds-fast) var(--ds-ease)}',
        '.ds-map-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,var(--ds-hairline));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3%,var(--ds-card))}',
        '.ds-map-card:active{transform:translateY(.5px)}',
        '.ds-map-card-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
        '.ds-map-index{font-family:var(--ds-mono);font-size:10px;color:var(--ds-text-caption);font-variant-numeric:tabular-nums}',
        '.ds-role{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--ds-surface-3);color:var(--ds-text-2);font-size:9.5px;font-weight:600;line-height:1;white-space:nowrap}',
        '.ds-relation{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;line-height:1.3;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-relation-kind{color:var(--ds-text-caption)}',
        '.ds-qstatus{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);color:var(--ds-text-3);font-size:9.5px;line-height:1;white-space:nowrap}',
        '.ds-qstatus[data-status="done"]{background:color-mix(in srgb,var(--ds-success) 11%,transparent);color:color-mix(in srgb,var(--ds-success) 58%,var(--ds-text-1))}',
        '.ds-qstatus[data-status="partial"]{background:color-mix(in srgb,var(--ds-warning) 15%,transparent);color:color-mix(in srgb,var(--ds-warning) 55%,var(--ds-text-1))}',
        '.ds-qstatus[data-status="failed"]{background:color-mix(in srgb,var(--ds-danger) 11%,transparent);color:color-mix(in srgb,var(--ds-danger) 66%,var(--ds-text-1))}',
        '.ds-map-question{margin:0;font-size:14px;font-weight:600;line-height:1.5;letter-spacing:-0.005em;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-map-why{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-map-why-label{font-weight:600;color:var(--ds-text-3);margin-right:5px}',
        '.ds-map-summary{margin:0;font-size:12.5px;line-height:1.62;color:var(--ds-text-2);padding-left:10px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent)}',
        '.ds-map-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:10.5px;line-height:1.4;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-map-open{display:inline-flex;align-items:center;gap:2px;margin-left:auto;color:var(--dsw-alias-brand-primary);font-weight:500}',
        '/* ==== 分题研究 ==== */',
        '.ds-unit{position:relative;padding:26px 0 8px;border-top:.5px solid var(--ds-hairline);margin-top:22px;scroll-margin-top:64px;border-radius:var(--ds-r-lg);transition:background-color var(--ds-normal) var(--ds-ease)}',
        '.ds-unit:first-of-type{margin-top:0;padding-top:0;border-top:0}',
        '.ds-unit-active{background:linear-gradient(to bottom,color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent),transparent 120px)}',
        '.ds-unit-new{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary);padding-inline:14px;margin-inline:-14px}',
        '.ds-new-flag{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--ds-r-pill);background:var(--ds-tint);color:var(--dsw-alias-brand-primary);font-size:9.5px;font-weight:600;line-height:1}',
        '.ds-unit-head{display:flex;gap:12px;align-items:flex-start;min-width:0}',
        '.ds-unit-index{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2);color:var(--ds-text-3);font-family:var(--ds-mono);font-size:11px;font-variant-numeric:tabular-nums}',
        '.ds-unit-headtext{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 auto}',
        '.ds-unit-kicker{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.ds-unit-confidence{font-size:9.5px;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-unit-question{margin:0;font-size:19px;font-weight:600;line-height:1.4;letter-spacing:-0.012em;color:var(--ds-text-1);overflow-wrap:anywhere;max-width:40em}',
        '.ds-unit-why{margin:0;font-size:12px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-unit-why-label{font-weight:600;margin-right:5px}',
        '.ds-conclusion{display:flex;flex-direction:column;gap:7px;margin-top:16px;padding:15px 16px;border:.5px solid var(--ds-hairline);border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);border-radius:var(--ds-r-md);background:var(--ds-card);cursor:pointer;transition:border-color var(--ds-fast) var(--ds-ease),background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-conclusion:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3%,var(--ds-card));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--ds-hairline))}',
        '.ds-conclusion-empty{cursor:default;border-left-color:var(--ds-hairline);background:var(--ds-surface-2)}',
        '.ds-conclusion-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
        '.ds-mini-label{font-size:9.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-conclusion-openhint{display:inline-flex;align-items:center;gap:2px;font-size:10px;color:var(--ds-text-caption);white-space:nowrap;margin-left:2px}',
        '.ds-conclusion:hover .ds-conclusion-openhint{color:var(--dsw-alias-brand-primary)}',
        '.ds-conclusion-text{margin:0;font-size:14.5px;line-height:1.66;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-conclusion-note{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-conclusion-note span{font-size:10px;font-weight:600;color:var(--ds-text-3);white-space:nowrap;padding-top:1px}',
        '.ds-conclusion-conditions{color:var(--ds-text-3)}',
        '.ds-evidence-block{margin-top:20px}',
        '.ds-evidence-groups{display:flex;flex-direction:column;gap:12px}',
        '.ds-evidence-group{display:flex;flex-direction:column;gap:7px}',
        '.ds-evidence-group-title{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3)}',
        '.ds-evidence-group-title span{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);font-size:9px;font-weight:500;color:var(--ds-text-3)}',
        '.ds-evidence{display:flex;flex-direction:column;gap:7px;padding:11px 13px 10px;border:.5px solid var(--ds-hairline);border-left:2px solid color-mix(in srgb,var(--ds-success) 45%,transparent);border-radius:var(--ds-r-sm);background:var(--ds-card);cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-evidence[data-stance="oppose"]{border-left-color:color-mix(in srgb,var(--ds-danger) 45%,transparent)}',
        '.ds-evidence:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-evidence-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.ds-stance{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 62%,var(--ds-text-1));font-size:9.5px;font-weight:600;line-height:1}',
        '.ds-stance[data-stance="oppose"]{background:color-mix(in srgb,var(--ds-danger) 11%,transparent);color:color-mix(in srgb,var(--ds-danger) 68%,var(--ds-text-1))}',
        '.ds-evidence-strength,.ds-evidence-independent{font-size:9.5px;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-evidence-independent[data-unjudged="true"],.ds-chain-independent[data-unjudged="true"]{color:var(--ds-text-caption)}',
        '.ds-evidence-id{margin-left:auto;font-family:var(--ds-mono);font-size:9px;color:var(--ds-text-caption)}',
        '.ds-evidence-text{margin:0;font-size:12.5px;line-height:1.64;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-evidence-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
        '.ds-evidence-note{font-size:10px;line-height:1.5;color:var(--ds-text-caption);max-width:60%}',
        '.ds-source-chips{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}',
        '.ds-source-chip{display:inline-flex;align-items:center;gap:4px;height:21px;padding:0 7px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-pill);background:transparent;color:var(--ds-text-2);font-size:10px;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-source-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1);border-color:var(--dsw-alias-border-l3)}',
        '.ds-source-chip-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--ds-text-caption)}',
        '.ds-source-chip-dot[data-independence="primary"]{background:var(--ds-info)}',
        '.ds-source-chip-dot[data-independence="independent"]{background:var(--ds-success)}',
        '.ds-source-chip-dot[data-independence="syndicated"]{background:var(--ds-warning)}',
        '.ds-source-chip-id{font-family:var(--ds-mono);font-size:8.5px;color:var(--ds-text-caption)}',
        '.ds-quote{margin:0;padding-left:0}',
        '.ds-quote summary{cursor:pointer;list-style:none;font-size:9.5px;color:var(--ds-text-3);width:max-content;padding:1px 0}',
        '.ds-quote summary::-webkit-details-marker{display:none}',
        '.ds-quote summary::before{content:"⌄";display:inline-block;margin-right:4px;transform:translateY(-1px);color:var(--ds-text-caption)}',
        '.ds-quote[open] summary::before{content:"⌃"}',
        '.ds-quote blockquote{margin:6px 0 2px;padding:7px 10px;border-left:2px solid var(--ds-hairline);background:var(--ds-surface-2);border-radius:0 var(--ds-r-xs) var(--ds-r-xs) 0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-mechanism{margin-top:20px}',
        '.ds-mechanism-p{margin:0 0 8px;font-size:12.5px;line-height:1.72;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-callout{margin-top:18px;padding:12px 14px;border-radius:var(--ds-r-md);background:color-mix(in srgb,var(--ds-warning) 7%,var(--ds-surface-2));border:.5px solid color-mix(in srgb,var(--ds-warning) 22%,var(--ds-hairline))}',
        '.ds-callout h4{margin:0 0 6px;font-size:11.5px;font-weight:600;color:color-mix(in srgb,var(--ds-warning) 55%,var(--ds-text-1))}',
        '.ds-callout p{margin:0 0 5px;font-size:12px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-callout p:last-child{margin-bottom:0}',
        '.ds-callout-condition{display:block;margin-top:4px;font-size:10.5px;color:var(--ds-text-3)}',
        '.ds-gaps{margin-top:20px}',
        '.ds-gap{padding:11px 13px;border:.5px dashed var(--ds-hairline);border-radius:var(--ds-r-sm);margin-bottom:7px;cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-gap:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-gap-text{display:flex;align-items:flex-start;gap:7px;font-size:12.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-gap-text .ds-icon{color:var(--ds-text-3);margin-top:2px}',
        '.ds-gap-why,.ds-gap-how{margin:5px 0 0;padding-left:21px;font-size:11px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-gap-why span,.ds-gap-how span{font-weight:600;color:var(--ds-text-2);margin-right:5px}',
        '.ds-followups{margin-top:20px}',
        '.ds-followup{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-top:.5px solid var(--ds-hairline)}',
        '.ds-followup:first-of-type{border-top:0}',
        '.ds-followup-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}',
        '.ds-followup-text{margin:0;font-size:12.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-followup-hook{margin:0;font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-followup-hook span{font-weight:600;margin-right:4px}',
        '.ds-followup .ds-btn{flex:none;margin-top:1px}',
        '.ds-unit-foot{display:flex;flex-wrap:wrap;gap:14px;margin-top:18px;padding-top:12px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-unit-foot-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.ds-foot-label{font-size:9.5px;font-weight:600;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-rel-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--ds-r-pill);background:transparent;border:.5px solid var(--ds-hairline);color:var(--ds-text-2);font-size:10px;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease)}',
        '.ds-rel-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-rel-kind{font-weight:600}',
        '.ds-rel-id{font-family:var(--ds-mono);font-size:8.5px;color:var(--ds-text-caption)}',
        '.ds-rel-text{color:var(--ds-text-3);max-width:180px;overflow:hidden;text-overflow:ellipsis}',
        '.ds-entity{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:2px 8px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);font-size:10px;line-height:1.5;color:var(--ds-text-2)}',
        '.ds-entity-name{font-weight:600;color:var(--ds-text-1);white-space:nowrap}',
        '.ds-entity-role{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
        '/* ==== 分歧 / 关联 / 来源 ==== */',
        '.ds-dispute{margin-bottom:14px;padding:15px 16px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card)}',
        '.ds-dispute-head{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;min-width:0}',
        '.ds-dispute-topic{margin:0;font-size:13.5px;font-weight:600;line-height:1.5;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-dispute-qref{display:inline-flex;align-items:center;gap:2px;flex:none;height:20px;padding:0 6px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);color:var(--ds-text-3);font-family:var(--ds-mono);font-size:9.5px;line-height:1;white-space:nowrap}',
        '.ds-dispute-qref:hover{color:var(--dsw-alias-brand-primary)}',
        '.ds-sides{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}',
        '.ds-side{display:flex;flex-direction:column;gap:5px;padding:10px 11px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2);min-width:0}',
        '.ds-side-label{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--ds-surface-3);color:var(--ds-text-3);font-family:var(--ds-mono);font-size:9px;font-weight:600;line-height:1}',
        '.ds-side-position{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-side-holders{margin:0;font-size:10px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-side-holders span{font-weight:600;margin-right:4px}',
        '.ds-side-evidence{display:flex;gap:4px;flex-wrap:wrap}',
        '.ds-evidence-ref{display:inline-flex;align-items:center;gap:1px;height:19px;padding:0 5px;border-radius:4px;background:var(--ds-card);border:.5px solid var(--ds-hairline);color:var(--ds-text-3);font-family:var(--ds-mono);font-size:8.5px;line-height:1}',
        '.ds-evidence-ref:hover{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--ds-hairline))}',
        '.ds-dispute-meta{display:flex;flex-direction:column;gap:5px;margin:12px 0 0;padding-top:10px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-dispute-meta>div{display:grid;grid-template-columns:64px minmax(0,1fr);gap:8px}',
        '.ds-dispute-meta dt{font-size:10px;font-weight:600;color:var(--ds-text-3);line-height:1.55}',
        '.ds-dispute-meta dd{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-unknowns{margin-top:20px}',
        '.ds-unknown{padding:11px 0;border-top:.5px solid var(--ds-hairline)}',
        '.ds-unknown:first-of-type{border-top:0}',
        '.ds-unknown-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;min-width:0}',
        '.ds-unknown-id{font-family:var(--ds-mono);font-size:9.5px;color:var(--ds-text-caption);padding-top:2px}',
        '.ds-unknown-text{flex:1 1 260px;margin:0;font-size:12.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-unknown-row{margin:4px 0 0;padding-left:22px;font-size:11px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-unknown-row span{font-weight:600;color:var(--ds-text-2);margin-right:5px}',
        '.ds-connection{padding:14px 15px;margin-bottom:10px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card)}',
        '.ds-connection[data-status="unverified"],.ds-connection[data-status="suggested"]{background:var(--ds-surface-2)}',
        '.ds-connection-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}',
        '.ds-connection-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--ds-surface-3);color:var(--ds-text-2);font-size:9.5px;font-weight:600;line-height:1;white-space:nowrap}',
        '.ds-connection-from{display:inline-flex;align-items:center;height:18px;padding:0 2px;color:var(--ds-text-3);font-family:var(--ds-mono);font-size:9.5px;line-height:1}',
        '.ds-connection-arrow{color:var(--ds-text-caption)}',
        '.ds-connection-to{font-size:12.5px;font-weight:600;color:var(--ds-text-1)}',
        '.ds-connection-status{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);color:var(--ds-text-3);font-size:9.5px;line-height:1}',
        '.ds-connection-status[data-status="verified"]{background:color-mix(in srgb,var(--ds-success) 11%,transparent);color:color-mix(in srgb,var(--ds-success) 58%,var(--ds-text-1))}',
        '.ds-connection-status[data-status="suggested"]{background:color-mix(in srgb,var(--ds-warning) 14%,transparent);color:color-mix(in srgb,var(--ds-warning) 55%,var(--ds-text-1))}',
        '.ds-connection-mechanism{margin:9px 0 0;font-size:12px;line-height:1.68;color:var(--ds-text-2)}',
        '.ds-connection-foot{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:9px}',
        '.ds-connection-note{margin:7px 0 0;font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-connection-note span{font-weight:600;margin-right:4px}',
        '.ds-sources-wrap{width:100%;overflow-x:auto;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);scrollbar-width:thin}',
        '.ds-sources{width:100%;min-width:680px;border-collapse:collapse;font-size:11.5px;line-height:1.5}',
        '.ds-sources th{padding:9px 12px;border-bottom:.5px solid var(--ds-hairline);text-align:left;font-size:9.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3);white-space:nowrap;background:var(--ds-surface-2)}',
        '.ds-sources td{padding:10px 12px;border-bottom:.5px solid var(--ds-hairline);color:var(--ds-text-2);vertical-align:top}',
        '.ds-sources tr:last-child td{border-bottom:0}',
        '.ds-source-row{cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-source-row:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-td-title{max-width:320px}',
        '.ds-source-title-text{display:block;font-size:12px;line-height:1.5;color:var(--ds-text-1);font-weight:500;overflow-wrap:anywhere}',
        '.ds-source-id{display:inline-block;margin-top:2px;font-family:var(--ds-mono);font-size:8.5px;color:var(--ds-text-caption)}',
        '.ds-td-nowrap{white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.ds-td-used{white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.ds-ask-cta{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:34px;padding:16px 18px;border:.5px dashed var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-surface-2)}',
        '.ds-ask-cta-text{font-size:12.5px;line-height:1.55;color:var(--ds-text-2)}',
        '/* ==== 抽屉 ==== */',
        '.ds-drawer-layer{position:absolute;inset:0;z-index:80;display:flex;justify-content:flex-end}',
        '.ds-drawer-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);animation:ds-fade-in var(--ds-normal) var(--ds-ease)}',
        '.ds-drawer{position:relative;display:flex;flex-direction:column;width:min(480px,92vw);height:100%;border-left:.5px solid var(--ds-hairline);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);animation:ds-slide-in var(--ds-normal) var(--ds-ease-spring)}',
        '.ds-drawer-head{flex:none;display:flex;align-items:flex-start;gap:8px;padding:14px 14px 12px;border-bottom:.5px solid var(--ds-hairline);background:var(--ds-material);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%)}',
        '.ds-drawer-titles{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
        '.ds-drawer-title{margin:0;font-size:14px;font-weight:600;line-height:1.35;color:var(--ds-text-1)}',
        '.ds-drawer-subtitle{margin:0;font-size:10.5px;line-height:1.45;color:var(--ds-text-3)}',
        '.ds-drawer-close{flex:none}',
        '.ds-drawer-back{display:inline-flex;align-items:center;gap:3px;flex:none;height:26px;padding:0 4px 0 0;color:var(--ds-text-3);font-size:11px;line-height:1;white-space:nowrap}',
        '.ds-drawer-back:hover{color:var(--ds-text-1)}',
        '.ds-drawer-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 16px 28px;scrollbar-width:thin}',
        '.ds-drawer-body::-webkit-scrollbar{width:8px}',
        '.ds-drawer-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border:2px solid transparent;border-radius:var(--ds-r-pill);background-clip:content-box}',
        '/* ==== 证据链 ==== */',
        '.ds-chain{display:flex;flex-direction:column;gap:14px}',
        '.ds-chain-theme{padding:12px 13px;border-radius:var(--ds-r-md);background:var(--ds-surface-2)}',
        '.ds-chain-label{display:block;margin-bottom:3px;font-size:9.5px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3)}',
        '.ds-chain-theme h3{margin:0 0 4px;font-size:15px;font-weight:600;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-chain-theme p{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-chain-node{position:relative;padding:12px 13px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--ds-card)}',
        '.ds-chain-node-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;margin-bottom:5px}',
        '.ds-chain-node-head .ds-chain-label{margin:0}',
        '.ds-chain-open{display:inline-flex;align-items:center;gap:1px;margin-left:auto;font-size:9.5px;color:var(--dsw-alias-brand-primary);line-height:1;white-space:nowrap}',
        '.ds-chain-open:hover{text-decoration:underline}',
        '.ds-chain-question-text{margin:0;font-size:12.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-chain-note{margin:5px 0 0;font-size:10.5px;line-height:1.62;color:var(--ds-text-3)}',
        '.ds-chain-note span{font-weight:600;color:var(--ds-text-2);margin-right:4px}',
        '.ds-chain-conclusion-text{margin:0;font-size:13px;line-height:1.62;color:var(--ds-text-1)}',
        '.ds-chain-no-conclusion{margin:0}',
        '.ds-chain-group{display:flex;flex-direction:column;gap:7px;padding-top:2px}',
        '.ds-chain-group-title{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--ds-text-3)}',
        '.ds-chain-group-title span{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:var(--ds-r-pill);background:var(--ds-surface-3);font-size:9px;font-weight:500;color:var(--ds-text-3)}',
        '.ds-chain-evidence{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border:.5px solid var(--ds-hairline);border-left:2px solid color-mix(in srgb,var(--ds-success) 45%,transparent);border-radius:var(--ds-r-sm);background:var(--ds-card)}',
        '.ds-chain-evidence[data-stance="oppose"]{border-left-color:color-mix(in srgb,var(--ds-danger) 45%,transparent)}',
        '.ds-chain-evidence-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
        '.ds-chain-strength,.ds-chain-independent{font-size:9px;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-chain-id{margin-left:auto;font-family:var(--ds-mono);font-size:8.5px;color:var(--ds-text-caption)}',
        '.ds-chain-evidence-text{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-chain-quote{margin:0;padding:6px 8px;border-left:2px solid var(--ds-hairline);background:var(--ds-surface-2);font-size:10.5px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-chain-sources{display:flex;gap:5px;flex-wrap:wrap}',
        '.ds-chain-gap{padding:9px 10px;border:.5px dashed var(--ds-hairline);border-radius:var(--ds-r-sm);margin-bottom:6px}',
        '.ds-chain-gap-text{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;line-height:1.6;color:var(--ds-text-1)}',
        '.ds-chain-gap-text .ds-icon{color:var(--ds-text-3);margin-top:2px}',
        '.ds-chain-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;color:var(--ds-text-3);text-align:center}',
        '.ds-chain-empty p{margin:0;font-size:12px;line-height:1.6}',
        '/* ==== 来源详情 ==== */',
        '.ds-source-detail{display:flex;flex-direction:column;gap:18px}',
        '.ds-source-detail-head{display:flex;flex-direction:column;gap:7px;padding-bottom:14px;border-bottom:.5px solid var(--ds-hairline)}',
        '.ds-source-detail-title{margin:0;font-size:16px;font-weight:600;line-height:1.45;letter-spacing:-0.008em;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-source-detail-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10.5px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-source-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
        '.ds-source-link{display:inline-flex;align-items:center;gap:5px;width:max-content;max-width:100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-brand-primary);text-decoration:none}',
        '.ds-source-link:hover{text-decoration:underline}',
        '.ds-source-link-host{color:var(--ds-text-3);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
        '.ds-source-section{display:flex;flex-direction:column;gap:6px}',
        '.ds-source-paragraph{margin:0;font-size:12px;line-height:1.7;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-source-quote{margin:0;padding:9px 11px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:var(--ds-surface-2);border-radius:0 var(--ds-r-xs) var(--ds-r-xs) 0;font-size:11.5px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-source-excerpt{margin:0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2);font-family:var(--ds-font);font-size:11.5px;line-height:1.7;color:var(--ds-text-2);white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:thin}',
        '.ds-source-usage{display:flex;flex-direction:column;gap:5px}',
        '.ds-source-usage-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);text-align:left;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-source-usage-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-source-usage-label{flex:none;font-family:var(--ds-mono);font-size:9px;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-source-usage-text{min-width:0;flex:1 1 auto;font-size:10.5px;line-height:1.5;color:var(--ds-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ds-source-usage-item .ds-icon{flex:none;color:var(--ds-text-caption)}',
        '/* ==== 弹层 ==== */',
        '.ds-modal-layer{position:absolute;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:24px}',
        '.ds-modal-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent);animation:ds-fade-in var(--ds-normal) var(--ds-ease)}',
        '.ds-modal{position:relative;display:flex;flex-direction:column;width:min(520px,100%);max-height:min(86vh,760px);border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-xl,20px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);animation:ds-pop-in var(--ds-normal) var(--ds-ease-spring);overflow:hidden}',
        '.ds-modal-wide{width:min(600px,100%)}',
        '.ds-modal-head{flex:none;display:flex;align-items:flex-start;gap:10px;padding:16px 16px 10px}',
        '.ds-modal-titles{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}',
        '.ds-modal-title{margin:0;font-size:15px;font-weight:600;line-height:1.35;color:var(--ds-text-1)}',
        '.ds-modal-subtitle{margin:0;font-size:11.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-modal-body{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:6px 16px 16px;scrollbar-width:thin}',
        '.ds-modal-foot{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:.5px solid var(--ds-hairline);background:var(--ds-surface-2)}',
        '.ds-field{display:flex;flex-direction:column;gap:6px}',
        '.ds-field-label{font-size:11px;font-weight:600;line-height:1.4;color:var(--ds-text-2)}',
        '.ds-field-hint{font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-textarea{width:100%;min-height:96px;padding:9px 11px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);color:var(--ds-text-1);font-size:13px;line-height:1.62;resize:vertical;outline:none}',
        '.ds-textarea::placeholder{color:var(--ds-text-caption)}',
        '.ds-textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--ds-hairline));box-shadow:var(--ds-ring)}',
        '.ds-recommended{display:flex;flex-direction:column;gap:5px;padding-top:2px}',
        '.ds-recommend{display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px 9px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);text-align:left;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-recommend:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-recommend-priority{flex:none;width:5px;height:5px;margin-top:6px;border-radius:50%;background:var(--ds-text-caption)}',
        '.ds-recommend-priority[data-priority="high"]{background:var(--dsw-alias-brand-primary)}',
        '.ds-recommend-priority[data-priority="medium"]{background:var(--ds-warning)}',
        '.ds-recommend-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.ds-recommend-text{font-size:11.5px;line-height:1.55;color:var(--ds-text-1)}',
        '.ds-recommend-hook{font-size:10px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-modal-error{margin:0;padding:8px 10px;border-radius:var(--ds-r-sm);background:color-mix(in srgb,var(--ds-danger) 8%,transparent);color:color-mix(in srgb,var(--ds-danger) 74%,var(--ds-text-1));font-size:11px;line-height:1.55}',
        '/* ==== 存入知识库 ==== */',
        '.ds-kb-body{gap:14px}',
        '.ds-kb-desc{margin:0;font-size:12px;line-height:1.7;color:var(--ds-text-2)}',
        '.ds-kb-section{display:flex;flex-direction:column;gap:7px}',
        '.ds-kb-formats{display:flex;flex-direction:column;gap:6px}',
        '.ds-kb-format{position:relative;display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-card);cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-kb-format:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-kb-format-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--ds-hairline));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,var(--ds-card))}',
        '.ds-kb-radio{flex:none;width:14px;height:14px;margin:1px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
        '.ds-kb-format-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.ds-kb-format-title{font-size:12.5px;font-weight:600;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-kb-format-meta{font-size:10.5px;line-height:1.4;color:var(--ds-text-3)}',
        '.ds-kb-status{display:flex;align-items:flex-start;gap:8px;padding:9px 11px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-kb-status[data-status="unavailable"]{border-color:color-mix(in srgb,var(--ds-danger) 28%,var(--ds-hairline));background:color-mix(in srgb,var(--ds-danger) 5%,transparent)}',
        '.ds-kb-status-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--ds-text-caption);margin-top:5px}',
        '.ds-kb-status-dot[data-status="ready"]{background:var(--ds-success)}',
        '.ds-kb-status-dot[data-status="unavailable"]{background:var(--ds-danger)}',
        '.ds-kb-status-main{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.ds-kb-status-text{font-size:11.5px;line-height:1.5;color:var(--ds-text-2)}',
        '.ds-kb-rootdir{font-family:var(--ds-mono);font-size:9.5px;line-height:1.45;color:var(--ds-text-3);overflow-wrap:anywhere}',
        '.ds-kb-hint{margin:0;font-size:10px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-kb-records-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}',
        '.ds-kb-records{display:flex;flex-direction:column;gap:4px}',
        '.ds-kb-record{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--ds-r-xs);background:var(--ds-surface-2);min-width:0}',
        '.ds-kb-record-icon{flex:none;color:var(--ds-text-3)}',
        '.ds-kb-record-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
        '.ds-kb-record-title{font-size:11.5px;font-weight:500;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-kb-record-meta{font-size:10px;line-height:1.4;color:var(--ds-text-3);font-variant-numeric:tabular-nums}',
        '.ds-kb-record-status{flex:none;font-size:9.5px;color:var(--ds-text-3)}',
        '.ds-kb-progress{display:flex;align-items:flex-start;gap:8px;padding:10px 11px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-kb-progress-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.ds-kb-stage{font-size:11.5px;line-height:1.5;color:var(--ds-text-1)}',
        '.ds-kb-success{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 11px;border:.5px solid color-mix(in srgb,var(--ds-success) 26%,var(--ds-hairline));border-radius:var(--ds-r-sm);background:color-mix(in srgb,var(--ds-success) 7%,transparent);color:color-mix(in srgb,var(--ds-success) 58%,var(--ds-text-1))}',
        '.ds-kb-success-text{font-size:11.5px;line-height:1.5;flex:1 1 auto}',
        '.ds-kb-open{flex:none}',
        '.ds-kb-error{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;padding:10px 11px;border:.5px solid color-mix(in srgb,var(--ds-danger) 28%,var(--ds-hairline));border-radius:var(--ds-r-sm);background:color-mix(in srgb,var(--ds-danger) 6%,transparent)}',
        '.ds-kb-error-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 220px}',
        '.ds-kb-error-main p{margin:0;font-size:11.5px;line-height:1.55;color:color-mix(in srgb,var(--ds-danger) 72%,var(--ds-text-1))}',
        '.ds-kb-error .ds-btn{flex:none;margin-left:auto}',
        '.ds-readonly-grid{display:flex;flex-direction:column;gap:0;margin:0;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--ds-surface-2);overflow:hidden}',
        '.ds-readonly-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;padding:8px 11px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-readonly-row:first-child{border-top:0}',
        '.ds-readonly-row dt{font-size:10.5px;line-height:1.6;color:var(--ds-text-3);font-weight:500}',
        '.ds-readonly-row dd{margin:0;font-size:11px;line-height:1.6;color:var(--ds-text-2);font-family:var(--ds-mono);overflow-wrap:anywhere}',
        '.ds-confirm-body{margin:0;font-size:13px;line-height:1.65;color:var(--ds-text-2)}',
        '/* ==== 轻提示 / 崩溃页 ==== */',
        '.ds-notice{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:100;display:inline-flex;align-items:center;gap:7px;max-width:min(520px,calc(100% - 32px));padding:9px 14px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-pill);background:var(--dsw-alias-bg-layer-1);color:var(--ds-text-1);font-size:11.5px;line-height:1.45;box-shadow:var(--dsw-elevation-prominent);animation:ds-notice-in var(--ds-normal) var(--ds-ease-spring)}',
        '.ds-notice[data-tone="success"] .ds-icon{color:var(--ds-success)}',
        '.ds-notice[data-tone="warn"] .ds-icon{color:var(--ds-warning)}',
        '.ds-notice[data-tone="error"] .ds-icon{color:var(--ds-danger)}',
        '.ds-notice[data-tone="info"] .ds-icon{color:var(--dsw-alias-brand-primary)}',
        '.ds-crash{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:40px;text-align:center;color:var(--ds-text-3)}',
        '.ds-crash-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:var(--ds-surface-2);color:var(--ds-warning)}',
        '.ds-crash-title{margin:6px 0 0;font-size:14px;font-weight:600;color:var(--ds-text-1)}',
        '.ds-crash-hint{margin:0;font-size:12px;line-height:1.6;color:var(--ds-text-3)}',
        '@keyframes ds-fade-in{from{opacity:0}to{opacity:1}}',
        '@keyframes ds-slide-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}',
        '@keyframes ds-pop-in{from{transform:translateY(8px) scale(.985);opacity:0}to{transform:none;opacity:1}}',
        '@keyframes ds-notice-in{from{transform:translate(-50%,6px);opacity:0}to{transform:translate(-50%,0);opacity:1}}',
        // ---- v2 六模块阅读态 ----
        '/* ==== 六模块阅读态 v2 ==== */',
        '.ds-reading-note{margin:8px 0 0;padding:9px 12px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2);font-size:12px;line-height:1.68;color:var(--ds-text-2)}',
        '.ds-reading-note .ds-meta-label{margin-right:6px}',
        '.ds-lead{margin:2px 0 6px;padding:2px 0 2px 14px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,transparent)}',
        '.ds-lead-text{margin:0;font-size:17px;line-height:1.76;color:var(--ds-text-1);font-weight:500;letter-spacing:-0.003em;overflow-wrap:anywhere}',
        '.ds-topic-facts{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 0 0;padding:10px 12px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-topic-facts>div{display:flex;align-items:baseline;gap:7px;min-width:0;max-width:100%}',
        '.ds-topic-facts dt{flex:none;font-size:10px;font-weight:600;color:var(--ds-text-3)}',
        '.ds-topic-facts dd{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-blocks{display:flex;flex-direction:column;gap:10px;margin-top:18px}',
        '.ds-block{display:flex;flex-direction:column;gap:7px;padding:14px 16px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card)}',
        '.ds-block-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
        '.ds-block-kind{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;background:var(--ds-surface-3);color:var(--ds-text-3);font-size:9.5px;font-weight:600;line-height:1}',
        '.ds-block-title{margin:0;font-size:14px;font-weight:600;line-height:1.45;color:var(--ds-text-1)}',
        '.ds-block-text{margin:0;font-size:14.5px;line-height:1.75;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-block-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:1px}',
        '.ds-annots{display:inline-flex;align-items:center;gap:2px;margin-left:4px;vertical-align:baseline;flex-wrap:wrap}',
        '.ds-annot-chip{display:inline-flex;align-items:center;justify-content:center;height:17px;min-width:18px;padding:0 3px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary);font-family:var(--ds-mono);font-size:9px;line-height:1;font-variant-numeric:tabular-nums;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-annot-chip:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 17%,transparent)}',
        '.ds-claimchips{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}',
        '.ds-claim-chip{display:inline-flex;align-items:center;height:18px;padding:0 5px;border-radius:4px;border:.5px solid var(--ds-hairline);color:var(--ds-text-3);font-family:var(--ds-mono);font-size:8.5px;line-height:1}',
        '.ds-claim-chip:hover{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--ds-hairline))}',
        '.ds-subblock{margin-top:22px}',
        '.ds-entities{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}',
        '.ds-entity-chip{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;max-width:100%;padding:3px 8px;border-radius:var(--ds-r-pill);background:var(--ds-surface-2);font-size:10px;line-height:1.5;color:var(--ds-text-2)}',
        '.ds-entity-chip .ds-annots,.ds-entity-chip .ds-claimchips{margin-left:0}',
        '.ds-confusables{display:flex;flex-direction:column;gap:8px}',
        '.ds-confusable{padding:10px 12px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-confusable-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}',
        '.ds-confusable-term{font-size:12px;font-weight:600;color:var(--ds-text-1)}',
        '.ds-confusable-with{font-size:11px;color:var(--ds-text-3)}',
        '.ds-confusable-note{margin:4px 0 0;font-size:11.5px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-coverage-note{display:flex;flex-direction:column;gap:5px;margin-top:22px;padding:11px 13px;border:.5px dashed color-mix(in srgb,var(--ds-warning) 35%,var(--ds-hairline));border-radius:var(--ds-r-md);background:color-mix(in srgb,var(--ds-warning) 5%,transparent)}',
        '.ds-coverage-note[data-status="missing"]{border-color:color-mix(in srgb,var(--ds-danger) 30%,var(--ds-hairline));background:color-mix(in srgb,var(--ds-danger) 5%,transparent)}',
        '.ds-coverage-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.ds-coverage-note p{margin:0;font-size:11.5px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-meta-label{font-size:10px;font-weight:600;letter-spacing:.01em;color:var(--ds-text-3)}',
        '.ds-scope{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:12px}',
        '.ds-scope-item{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-scope-key{font-size:9.5px;line-height:1.3;color:var(--ds-text-3)}',
        '.ds-scope-value{font-size:11.5px;line-height:1.5;color:var(--ds-text-1);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
        '.ds-scope-limits{grid-column:1/-1}',
        '.ds-issues{display:flex;flex-direction:column;gap:12px;margin-top:14px}',
        '.ds-issue{padding:15px 16px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card)}',
        '.ds-issue-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;min-width:0}',
        '.ds-issue-question{margin:0;font-size:14.5px;font-weight:600;line-height:1.5;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-issue-summary{margin:6px 0 0;font-size:12px;line-height:1.65;color:var(--ds-text-2)}',
        '.ds-items{display:flex;flex-direction:column;margin-top:10px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-item{display:flex;flex-direction:column;gap:5px;padding:11px 0 12px;border-bottom:.5px solid var(--ds-hairline)}',
        '.ds-item:last-child{border-bottom:0;padding-bottom:2px}',
        '.ds-item-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.ds-item-speaker{font-size:12px;font-weight:600;line-height:1.4;color:var(--ds-text-1)}',
        '.ds-item-affiliation{font-size:10.5px;line-height:1.4;color:var(--ds-text-3)}',
        '.ds-item-meta{margin-left:auto;font-size:9.5px;line-height:1.4;color:var(--ds-text-3);white-space:nowrap;font-variant-numeric:tabular-nums}',
        '.ds-item-view{margin:0;font-size:12.5px;line-height:1.68;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-item-basis{margin:0;font-size:11px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-item-basis .ds-meta-label{margin-right:5px}',
        '.ds-item-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.ds-discussion-identity{background:var(--ds-surface-3);color:var(--ds-text-2)}',
        '.ds-issue-disagreement{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin-top:11px;padding-top:10px;border-top:.5px solid var(--ds-hairline);font-size:11px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-disagreement-origin{font-weight:600;color:var(--ds-text-1)}',
        '.ds-issue-disagreement p{flex:1 1 100%;margin:0;font-size:11px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-issue-gaps{margin:8px 0 0;font-size:11px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-issue-gaps .ds-meta-label{margin-right:5px}',
        '.ds-empty-block{margin-top:12px;padding:14px 15px;border:.5px dashed var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--ds-surface-2)}',
        '.ds-empty-block .ds-muted+.ds-muted{margin-top:4px}',
        '.ds-coverage[data-status="covered"]{background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 60%,var(--ds-text-1))}',
        '.ds-coverage[data-status="partial"]{background:color-mix(in srgb,var(--ds-warning) 15%,transparent);color:color-mix(in srgb,var(--ds-warning) 56%,var(--ds-text-1))}',
        '.ds-coverage[data-status="missing"]{background:color-mix(in srgb,var(--ds-danger) 12%,transparent);color:color-mix(in srgb,var(--ds-danger) 68%,var(--ds-text-1))}',
        '.ds-priority{background:var(--ds-surface-3);color:var(--ds-text-2)}',
        '.ds-priority[data-priority="high"]{background:var(--ds-tint);color:var(--dsw-alias-brand-primary)}',
        '.ds-priority[data-priority="medium"]{background:color-mix(in srgb,var(--ds-warning) 13%,transparent);color:color-mix(in srgb,var(--ds-warning) 56%,var(--ds-text-1))}',
        '.ds-question-coverage[data-status="answered"]{background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 60%,var(--ds-text-1))}',
        '.ds-question-coverage[data-status="partial"]{background:color-mix(in srgb,var(--ds-warning) 14%,transparent);color:color-mix(in srgb,var(--ds-warning) 56%,var(--ds-text-1))}',
        '.ds-question-coverage[data-status="disputed"]{background:color-mix(in srgb,var(--ds-danger) 12%,transparent);color:color-mix(in srgb,var(--ds-danger) 68%,var(--ds-text-1))}',
        '.ds-question-coverage[data-status="no-evidence"]{background:var(--ds-surface-3);color:var(--ds-text-3)}',
        '.ds-evidence-status{background:var(--ds-surface-3);color:var(--ds-text-3)}',
        '.ds-evidence-status[data-status="supported"]{background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 60%,var(--ds-text-1))}',
        '.ds-evidence-status[data-status="limited"]{background:color-mix(in srgb,var(--ds-warning) 14%,transparent);color:color-mix(in srgb,var(--ds-warning) 56%,var(--ds-text-1))}',
        '.ds-evidence-status[data-status="conflicted"]{background:color-mix(in srgb,var(--ds-danger) 12%,transparent);color:color-mix(in srgb,var(--ds-danger) 68%,var(--ds-text-1))}',
        '.ds-branch-status[data-status="open"]{background:var(--ds-tint);color:var(--dsw-alias-brand-primary)}',
        '.ds-branch-status[data-status="answered"]{background:color-mix(in srgb,var(--ds-success) 12%,transparent);color:color-mix(in srgb,var(--ds-success) 60%,var(--ds-text-1))}',
        '.ds-readscope{background:var(--ds-surface-3);color:var(--ds-text-2);font-weight:500}',
        '.ds-stale{background:color-mix(in srgb,var(--ds-warning) 15%,transparent);color:color-mix(in srgb,var(--ds-warning) 56%,var(--ds-text-1))}',
        '.ds-qmap{display:flex;flex-direction:column;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);overflow:hidden}',
        '.ds-qmap-row{display:flex;align-items:flex-start;gap:11px;width:100%;padding:12px 14px;border-bottom:.5px solid var(--ds-hairline);background:transparent;text-align:left;transition:background-color var(--ds-fast) var(--ds-ease)}',
        '.ds-qmap-row:last-child{border-bottom:0}',
        '.ds-qmap-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.ds-qmap-order{flex:none;padding-top:2px;font-family:var(--ds-mono);font-size:10px;color:var(--ds-text-caption);font-variant-numeric:tabular-nums}',
        '.ds-qmap-main{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 auto}',
        '.ds-qmap-q{font-size:13px;font-weight:600;line-height:1.5;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-qmap-id{margin-left:6px;font-family:var(--ds-mono);font-size:8.5px;font-weight:400;color:var(--ds-text-caption)}',
        '.ds-qmap-summary{font-size:11.5px;line-height:1.6;color:var(--ds-text-2);padding-left:9px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
        '.ds-qmap-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.ds-qmap-role,.ds-qmap-relation{font-size:9.5px;line-height:1.4;color:var(--ds-text-3);white-space:nowrap}',
        '.ds-qmap-chevron{flex:none;color:var(--ds-text-caption);margin-top:4px}',
        '.ds-subhead-units{margin-top:26px}',
        '.ds-units{display:flex;flex-direction:column}',
        '.ds-unit-need{margin:0;font-size:11.5px;line-height:1.6;color:var(--ds-text-3)}',
        '.ds-unit-need span,.ds-unit-why span{font-weight:600;margin-right:5px}',
        '.ds-unit-relation{margin:0;font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-unit-relation-note{margin-left:6px;color:var(--ds-text-caption)}',
        '.ds-claims{display:flex;flex-direction:column;gap:9px;margin-top:14px}',
        '.ds-claim{display:flex;flex-direction:column;gap:5px;padding:13px 14px;border:.5px solid var(--ds-hairline);border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);border-radius:var(--ds-r-md);background:var(--ds-card);cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-claim:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3%,var(--ds-card));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--ds-hairline))}',
        '.ds-claim[data-identity="claim"]{border-left-color:color-mix(in srgb,var(--ds-warning) 45%,transparent)}',
        '.ds-claim[data-status="conflicted"]{border-left-color:color-mix(in srgb,var(--ds-danger) 50%,transparent)}',
        '.ds-claim-head{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0}',
        '.ds-claim-id{font-family:var(--ds-mono);font-size:8.5px;color:var(--ds-text-caption)}',
        '.ds-claim-text{margin:2px 0 0;font-size:14.5px;line-height:1.75;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-claim-meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;margin:0;font-size:11px;line-height:1.6;color:var(--ds-text-2)}',
        '.ds-claim-meta>span:first-child{font-size:9.5px;font-weight:600;color:var(--ds-text-3);white-space:nowrap;padding-top:1px}',
        '.ds-claim-conditions{color:var(--ds-text-3)}',
        '.ds-judgment-tensions{margin:0 0 16px}',
        '.ds-judgments{display:flex;flex-direction:column;gap:9px}',
        '.ds-judgment{display:flex;flex-direction:column;gap:6px;padding:14px 15px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-lg);background:var(--ds-card);cursor:pointer;transition:background-color var(--ds-fast) var(--ds-ease),border-color var(--ds-fast) var(--ds-ease)}',
        '.ds-judgment:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3%,var(--ds-card));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--ds-hairline))}',
        '.ds-judgment-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
        '.ds-judgment-text{margin:0;font-size:14px;line-height:1.65;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-judgment-chevron{color:var(--ds-text-caption);margin-left:5px;vertical-align:-1px}',
        '.ds-judgment-note{margin:0;font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-branches{display:flex;flex-direction:column;gap:8px}',
        '.ds-branches-inline{margin-top:20px}',
        '.ds-branches-inline .ds-block-title{margin-bottom:2px}',
        '.ds-branch{display:flex;align-items:flex-start;gap:14px;padding:12px 14px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-md);background:var(--ds-card)}',
        '.ds-branch[data-priority="high"]{border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
        '.ds-branch[data-status="answered"]{background:var(--ds-surface-2)}',
        '.ds-branch-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 auto}',
        '.ds-branch-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.ds-branch-text{margin:0;font-size:12.5px;line-height:1.62;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-branch-hook{margin:0;font-size:10.5px;line-height:1.55;color:var(--ds-text-3)}',
        '.ds-branch-hook span{font-weight:600;margin-right:4px}',
        '.ds-branch-qref{font-size:9.5px;color:var(--ds-text-3);font-family:var(--ds-mono);white-space:nowrap}',
        '.ds-branch-qref:hover{color:var(--dsw-alias-brand-primary)}',
        '.ds-branch-search{flex:none;margin-top:1px}',
        '.ds-branch-compact{padding:9px 11px;background:var(--ds-surface-2)}',
        '.ds-branch-compact .ds-branch-text{font-size:12px}',
        '.ds-source-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
        '.ds-anysearch-records{margin-top:var(--ds-s4);min-width:0;overflow-wrap:anywhere}',
        '.ds-anysearch-records h3{margin:0 0 var(--ds-s1);color:var(--ds-text-1);font-size:.9375rem}',
        '.ds-anysearch-records ul{display:grid;gap:var(--ds-s2);margin:var(--ds-s2) 0 0;padding:0;list-style:none}',
        '.ds-anysearch-records details{padding:var(--ds-s2) var(--ds-s3);border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-anysearch-records summary{cursor:pointer;color:var(--ds-text-1);font-size:.875rem;font-weight:500}',
        '.ds-anysearch-records details p{margin:var(--ds-s2) 0 0}',
        '.ds-anysearch-record-content{white-space:pre-wrap;color:var(--ds-text-2);font-size:.8125rem}',
        '@media (pointer:coarse){.ds-anysearch-records summary{min-height:44px;align-content:center}}',
        '.ds-source-tools-label{font-size:10px;font-weight:600;color:var(--ds-text-3)}',
        '.ds-source-tools-hint{font-size:9.5px;color:var(--ds-text-caption)}',
        '.ds-filter-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
        '.ds-filter-chip{display:inline-flex;align-items:center;height:24px;padding:0 9px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-pill);background:transparent;color:var(--ds-text-2);font-size:10.5px;line-height:1;white-space:nowrap;transition:background-color var(--ds-fast) var(--ds-ease),color var(--ds-fast) var(--ds-ease)}',
        '.ds-filter-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--ds-text-1)}',
        '.ds-filter-active{background:var(--ds-tint);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--ds-hairline));color:var(--dsw-alias-brand-primary);font-weight:600}',
'.ds-sources-wide{table-layout:fixed;min-width:900px}',
        '.ds-sources-wide th:nth-child(1),.ds-sources-wide td:nth-child(1){width:92px}',
        '.ds-sources-wide th:nth-child(2),.ds-sources-wide td:nth-child(2){width:224px}',
        '.ds-sources-wide th:nth-child(3),.ds-sources-wide td:nth-child(3){width:84px}',
        '.ds-sources-wide th:nth-child(4),.ds-sources-wide td:nth-child(4){width:72px}',
        '.ds-sources-wide th:nth-child(5),.ds-sources-wide td:nth-child(5){width:82px}',
        '.ds-sources-wide th:nth-child(6),.ds-sources-wide td:nth-child(6){width:58px}',
        '.ds-sources-wide th:nth-child(7),.ds-sources-wide td:nth-child(7){width:68px}',
        '.ds-sources-wide th:nth-child(8),.ds-sources-wide td:nth-child(8){width:80px}',
        '.ds-sources-wide th:nth-child(9),.ds-sources-wide td:nth-child(9){width:96px}',
        '.ds-sources-wide th{white-space:nowrap}',
        '.ds-sources-wide td:nth-child(5),.ds-sources-wide td:nth-child(6),.ds-sources-wide td:nth-child(7),.ds-sources-wide td:nth-child(8),.ds-sources-wide td:nth-child(9){white-space:nowrap}',
        '.ds-th-number{width:96px}',
        '.ds-td-number{white-space:nowrap}',
        '.ds-td-number .ds-annots{margin-left:0;max-width:88px}',
        '.ds-source-supplementary td{color:var(--ds-text-3)}',
        '.ds-source-supplementary-badge{display:inline-flex;align-items:center;height:17px;padding:0 5px;border-radius:4px;background:var(--ds-surface-3);color:var(--ds-text-caption);font-size:9px}',
        '.ds-annotation{display:flex;flex-direction:column;gap:16px}',
        '.ds-annotation-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding-bottom:12px;border-bottom:.5px solid var(--ds-hairline)}',
        '.ds-annotation-number{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:24px;padding:0 7px;border-radius:var(--ds-r-sm);background:var(--ds-tint);color:var(--dsw-alias-brand-primary);font-family:var(--ds-mono);font-size:11px;font-weight:600}',
        '.ds-annotation-meta-item{font-size:10px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-annotation-text{margin:0;font-size:14.5px;line-height:1.75;color:var(--ds-text-1);overflow-wrap:anywhere}',
        '.ds-annotation-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:-6px}',
        '.ds-annotation-section{display:flex;flex-direction:column;gap:7px}',
        '.ds-annotation-source{display:flex;flex-direction:column;gap:5px;padding:10px 11px;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);background:var(--ds-surface-2)}',
        '.ds-annotation-source-head{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}',
        '.ds-annotation-source-title{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:1.5;color:var(--ds-text-1);text-decoration:none;overflow-wrap:anywhere}',
        'a.ds-annotation-source-title:hover{text-decoration:underline;color:var(--dsw-alias-brand-primary)}',
        '.ds-annotation-source-meta{margin:0;font-size:10px;line-height:1.5;color:var(--ds-text-3)}',
        '.ds-annotation-source-open{font-size:10px}',
        '.ds-annotation-usages{display:flex;flex-direction:column;gap:4px}',
        '.ds-annotation-usage{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;border-radius:var(--ds-r-xs);background:var(--ds-surface-2);min-width:0}',
        '.ds-annotation-usage-label{font-size:11px;line-height:1.5;color:var(--ds-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.ds-annotation-usage .ds-linkbtn{flex:none}',
        '.ds-source-facts{display:flex;flex-direction:column;gap:0;margin:2px 0 0;border:.5px solid var(--ds-hairline);border-radius:var(--ds-r-sm);overflow:hidden}',
        '.ds-source-facts>div{display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;padding:7px 10px;border-top:.5px solid var(--ds-hairline)}',
        '.ds-source-facts>div:first-child{border-top:0}',
        '.ds-source-facts dt{font-size:10px;line-height:1.55;color:var(--ds-text-3);font-weight:600}',
        '.ds-source-facts dd{margin:0;font-size:11px;line-height:1.55;color:var(--ds-text-2);overflow-wrap:anywhere}',
        '.ds-chain-claim,.ds-chain-judgment{gap:4px}',
        '@container dsmain (max-width:720px){',
        '.ds-scope{grid-template-columns:repeat(2,minmax(0,1fr))}',
        '.ds-lead-text{font-size:15.5px}',
        '.ds-item-meta{margin-left:0;width:100%}',
        '}',
        '@container dsmain (max-width:480px){',
        '.ds-scope{grid-template-columns:minmax(0,1fr)}',
        '.ds-branch{flex-direction:column}',
        '.ds-branch-search{align-self:flex-start}',
        '}',
        '@media (max-width:719px){',
        '.ds-sources-wide{min-width:780px}',
        '.ds-block{padding:12px 13px}',
        '.ds-qmap-row{padding:11px 12px}',
        '}',
        '@media (max-width:539px){',
        '.ds-stages{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:12px}',
        '.ds-claim-head .ds-spacer,.ds-issue-head .ds-spacer{display:none}',
        '.ds-qmap-meta{gap:4px}',
        '.ds-unit-relation{display:none}',
        '}',
        '/* ==== 容器查询：面板实际宽度（嵌在宿主侧栏旁时比视口窄）==== */',
        '@container dsmain (max-width:1000px){',
        '.ds-toc{display:none}',
        '.ds-stats-inline{display:grid}',
        '.ds-stats-inline .ds-stat{padding:7px 9px;border:.5px solid var(--ds-hairline);background:var(--ds-surface-2)}',
        '.ds-stats-inline .ds-stat dt{font-size:9.5px}',
        '.ds-stats-inline .ds-stat dd{font-size:13px}',
        '.ds-stats-inline .ds-stat-hint{font-size:9px}',
        '.ds-reading-grid{grid-template-columns:minmax(0,var(--ds-article-max));max-width:calc(var(--ds-article-max) + 64px);padding-top:24px}',
        '.ds-reading-head{max-width:calc(var(--ds-article-max) + 64px)}',
        '.ds-anchorbar{display:flex}',
        '.ds-action-label{display:inline}',
        '}',
        '@container dsmain (max-width:720px){',
        '.ds-stats-inline{grid-template-columns:repeat(3,minmax(0,1fr))}',
        '.ds-reading-title{font-size:26px}',
        '.ds-reading-head{padding:18px 18px 0}',
        '.ds-reading-grid{padding:20px 18px 0}',
        '.ds-anchorbar{padding:6px 14px}',
        '.ds-definition,.ds-tensions{grid-template-columns:minmax(0,1fr);gap:4px}',
        '.ds-definition-label,.ds-tensions-label{padding-top:0}',
        '.ds-sides{grid-template-columns:minmax(0,1fr)}',
        '.ds-empty-title{font-size:29px}',
        '.ds-empty{padding:5vh 24px 40px}',
        '.ds-running{padding:5vh 24px 40px}',
        '}',
        '@container dsmain (max-width:600px){',
        '.ds-action-label{display:none}',
        '}',
        '@container dsmain (max-width:480px){',
        '.ds-stats-inline{grid-template-columns:repeat(2,minmax(0,1fr))}',
        '}',
        '/* ==== 响应式（视口兜底）==== */',
        '@media (max-width:1199px){',
        '.ds-toc{display:none}',
        '.ds-reading-grid{grid-template-columns:minmax(0,var(--ds-article-max));max-width:calc(var(--ds-article-max) + 64px);padding-top:24px}',
        '.ds-reading-head{max-width:calc(var(--ds-article-max) + 64px)}',
        '.ds-anchorbar{display:flex}',
        '}',
        '@media (max-width:959px){',
        '.ds-rail{position:fixed;left:0;top:0;bottom:0;width:min(300px,86vw);flex-basis:auto;transform:translateX(-102%);visibility:hidden;opacity:0;pointer-events:none;transition:transform var(--ds-normal) var(--ds-ease-spring);box-shadow:var(--dsw-elevation-prominent);z-index:70}',
        '.ds-rail-open{transform:none;visibility:visible;opacity:1;pointer-events:auto}',
        '.ds-rail-close{display:inline-flex}',
        '.ds-rail-scrim{display:block;position:fixed;inset:0;z-index:65;background:color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent)}',
        '.ds-mobilebar{display:flex}',
        '.ds-empty{padding:5vh 24px 40px}',
        '.ds-running{padding:5vh 24px 40px}',
        '}',
        '@media (max-width:719px){',
        '.ds-empty-title{font-size:29px}',
        '.ds-empty-subtitle{font-size:13px}',
        '.ds-reading-head{padding:18px 18px 0}',
        '.ds-reading-title{font-size:26px}',
        '.ds-reading-grid{padding:20px 18px 0;gap:0}',
        '.ds-anchorbar{padding:6px 14px;margin-top:14px}',
        '.ds-definition,.ds-tensions{grid-template-columns:minmax(0,1fr);gap:4px}',
        '.ds-definition-label,.ds-tensions-label{padding-top:0}',
        '.ds-sides{grid-template-columns:minmax(0,1fr)}',
        '.ds-sources{min-width:600px}',
        '.ds-drawer{width:100%;border-left:0}',
        '.ds-modal-layer{padding:12px;align-items:flex-end}',
        '.ds-modal{max-height:92vh;border-radius:18px}',
        '.ds-drawer-head,.ds-modal-head{padding-inline:14px}',
        '.ds-drawer-body{padding:14px 14px 24px}',
        '.ds-modal-body{padding-inline:14px}',
        '.ds-modal-foot{padding-inline:14px}',
        '.ds-finding{padding:12px}',
        '.ds-finding-index{display:none}',
        '.ds-unit-question{font-size:17px}',
        '.ds-searchbox{padding-left:13px;height:50px}',
        '.ds-searchbox-input{font-size:14px}',
        '.ds-searchbox-submit{height:38px;padding:0 13px;font-size:12px}',
        '.ds-empty-method{margin-top:30px}',
        '.ds-action-label{display:none}',
        '.ds-toc-hint{display:none}',
        '.ds-log-body{height:180px}',
        '.ds-stages .ds-stage-state{display:none}',
        '.ds-stage-label{font-size:9.5px}',
        '.ds-running-title{font-size:23px}',
        '.ds-reading-actions{gap:4px}',
        '.ds-reading-actions .ds-btn-sm{height:27px;padding:0 8px}',
        '.ds-connection-head .ds-spacer{display:none}',
        '}',
        '@media (max-width:539px){',
        '.ds-empty-title{font-size:25px}',
        '.ds-empty{padding:4vh 16px 32px}',
        '.ds-running{padding:4vh 16px 32px}',
        '.ds-reading-head{padding:14px 14px 0}',
        '.ds-reading-grid{padding:16px 14px 0}',
        '.ds-examples{gap:6px}',
        '.ds-example{padding:0 9px}',
        '.ds-example-query{display:none}',
        '.ds-stage-label{font-size:9px}',
        '.ds-stages .ds-stage-line::before,.ds-stages .ds-stage-line::after{display:none}',
        '.ds-stage{flex:1 1 0}',
        '.ds-finding-meta{gap:6px}',
        '.ds-unit-head{gap:8px}',
        '.ds-unit-index{width:24px;height:24px;font-size:10px}',
        '.ds-map-row{gap:8px}',
        '.ds-map-rail{padding-top:16px}',
        '.ds-article{font-size:13px}',
        '.ds-reading-actions .ds-btn-sm{padding:0 7px}',
        '}',
        '/* ==== 动效降级 ==== */',
        '@media (prefers-reduced-motion:reduce){',
        '.ds-root,.ds-root *{animation:none!important;transition-property:opacity!important;transition-duration:var(--ds-fast)!important;scroll-behavior:auto!important}',
        '.ds-btn:active:not(:disabled),.ds-map-card:active{transform:none!important}',
        '.ds-drawer,.ds-modal,.ds-notice,.ds-modal-scrim,.ds-drawer-scrim{animation:none!important}',
        '.ds-spinner{animation:ds-spin 1.2s linear infinite!important}',
        '.ds-status-dot[data-status="running"]{animation:none!important}',
        '}',
        '/* ==== 高对比度 ==== */',
        '@media (prefers-contrast:more){',
        '.ds-root{--ds-hairline:var(--dsw-alias-border-l3)}',
        '.ds-btn,.ds-input,.ds-textarea,.ds-source-chip,.ds-map-card{border-color:var(--dsw-alias-border-l3)}',
        '}',
        "/* Apple HIG web refinement: project-selected sizes; host semantic colors remain authoritative. */",
        ".ds-root :where(.ds-btn,.ds-depth-btn){min-height:34px;height:auto;line-height:1.35}.ds-btn{font-size:13px;padding-top:7px;padding-bottom:7px}.ds-btn-sm{min-height:32px;font-size:12.5px}.ds-iconbtn{width:34px;height:34px}.ds-input,.ds-list-search{min-height:34px;font-size:13px}",
        ".ds-btn-primary,.ds-btn-solid{color:var(--dsw-alias-label-primary-foreground,#fff)}.ds-new-submit{min-height:34px}.ds-depth-btn{font-size:12px;padding-top:5px;padding-bottom:5px}.ds-brand-name{font-size:16px}.ds-brand-caption{font-size:12px}",
        ".ds-reading-head{gap:16px;padding-top:20px}.ds-reading-actions{gap:8px;row-gap:8px}.ds-reading-actions .ds-btn-sm{min-height:32px;height:auto}.ds-section-title{font-size:20px}.ds-empty{padding-top:32px}.ds-empty-title{margin-top:16px;font-size:28px}.ds-reading-title{font-size:26px}.ds-topic-title{font-size:13px}.ds-topic-meta,.ds-foot-text{font-size:11.5px}",
        ".ds-block,.ds-claim,.ds-judgment{padding:16px}.ds-qmap-q,.ds-source-title-text{font-size:14px}.ds-qmap-summary,.ds-claim-meta,.ds-judgment-note,.ds-annotation-text{font-size:13px;line-height:1.65}.ds-definition-text,.ds-block-text,.ds-claim-text,.ds-judgment-text{font-size:14.5px;line-height:1.75}.ds-drawer-title{font-size:16px}",
        ".ds-root :focus-visible{outline-color:var(--dsw-alias-brand-primary);outline-offset:3px}.ds-reading-actions .ds-btn{white-space:normal;text-align:center}.ds-root :where(input,textarea,select){min-width:0}",
        "@container dsmain (max-width:720px){.ds-reading-title{font-size:24px}.ds-reading-actions{justify-content:flex-start;gap:8px}.ds-reading-actions .ds-btn-sm{min-height:34px;padding:6px 10px}.ds-reading-head{padding-top:16px}.ds-empty-title{font-size:24px}.ds-block,.ds-claim,.ds-judgment{padding:14px}}",
        "@media (max-width:539px){.ds-reading-actions .ds-btn-sm{min-height:34px;padding:6px 10px}.ds-empty-title,.ds-reading-title{font-size:22px}.ds-article{font-size:14px}}",
        "@media (pointer:coarse){.ds-root :where(.ds-btn,.ds-depth-btn,.ds-iconbtn,.ds-anchor,.ds-linkbtn){min-height:44px}.ds-iconbtn{min-width:44px}}",
        "@media (prefers-reduced-motion:reduce){.ds-root .ds-spinner{animation:none!important}.ds-root :where(button){transform:none!important}}",
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
        }, 'deep-search: dictionaries')
        const t = ctx.locale.bind(NS)
        runtimeT = t

        /**
         * 打开知识库面板（KB 面板 id 稳定为 'kb'）。
         * KB 未安装 / 没有 layout 服务时静默失败，不影响本面板。
         * @returns {void}
         */
        function openKbPanel() {
          try {
            if (ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel(KB_PANEL_ID)
              return
            }
          } catch (error) {
            /* ignore */
          }
          try {
            if (ctx && typeof ctx.get === 'function') {
              const layout = ctx.get('layout')
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(KB_PANEL_ID)
            }
          } catch (error) {
            /* ignore */
          }
        }

        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS, inject: function () { return { t: t, openKbPanel: openKbPanel } } },
            RootPanel,
          )
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 23, locale: NS, label: function () { return t('panel.label') } },
            DeepSearchIcon,
          )
        })
      }

      return { name: PANEL_ID, inject: ['slots', 'locale'], apply: apply }
    },
  })
} else {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[dsh-deep-search] __ModuleLoader__ 不可用，client.js 未加载')
  }
}
