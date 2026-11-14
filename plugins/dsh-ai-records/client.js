/**
 * dsh-ai-records —— 浏览器半侧：AI 访谈档案面板。
 *
 * 注册：window.__ModuleLoader__.load({ id, factory(require) })，
 * factory 内只 require('react')，返回 { name, inject:['slots','locale'], apply }。
 *
 * 面板分两栏：左侧条目库（搜索 + 列表 + 任务进度），右侧阅读页
 * （标题信息 / 播放器 / 中英对照逐字稿 / 时间戳跳转）。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-ai-records',

    factory(require) {
      const React = require('react')
      const { useState, useEffect, useRef, useMemo, useCallback, memo } = React
      const h = React.createElement

      const PANEL_ID = 'ai-records'
      const NS = 'aiRecords'
      const ORIGIN = '/dsh-ai-records'
      const POLL_MS = 2500

      const zh = {
        'panel.label': 'AI 访谈档案',
        'panel.title': 'AI 访谈档案',
        'panel.subtitle': '访谈、圆桌、发布会 · 带时间戳原文 + 中文',
        'empty.title': '还没有内容',
        'empty.desc': '把一个可公网访问的音频链接放进来（播客 RSS 直链最稳），后台会转写并翻译成中英对照。',
        'empty.url': '音频直链（https://…）',
        'empty.name': '标题（可留空）',
        'empty.source': '节目或发布方',
        'empty.submit': '加入档案',
        'empty.hint': 'YouTube 链接需要先有可访问的音频地址；短切片、广告先不收。',
        'list.search': '搜索标题或正文',
        'list.empty': '没有匹配的条目',
        'reader.pick': '从左边选一条开始读',
        'reader.translate': '翻译成中文',
        'reader.translating': '翻译中…',
        'reader.bilingual': '中英对照',
        'reader.zhOnly': '只看中文',
        'reader.pending': '这条还没有译文',
        'reader.segments': '段',
        'reader.duration': '时长',
        'reader.source': '来源',
        'reader.open': '打开原页面',
        'status.asr.pending': '待转写',
        'status.asr.running': '转写中',
        'status.asr.done': '已转写',
        'status.asr.failed': '转写失败',
        'status.translate.running': '翻译中',
        'status.translate.done': '已翻译',
        'status.translate.partial': '部分翻译',
        'status.translate.failed': '翻译失败',
        'job.running': '后台任务',
      }
      const en = {
        'panel.label': 'AI Archive',
        'panel.title': 'AI Interview Archive',
        'panel.subtitle': 'Interviews, roundtables, launches — timestamped, bilingual',
        'empty.title': 'Nothing here yet',
        'empty.desc': 'Paste a public audio URL (podcast RSS enclosures work best). It will be transcribed and translated.',
        'empty.url': 'Audio URL (https://…)',
        'empty.name': 'Title (optional)',
        'empty.source': 'Show or publisher',
        'empty.submit': 'Add to archive',
        'empty.hint': 'YouTube links need a direct audio URL first; clips and ads stay out.',
        'list.search': 'Search title or transcript',
        'list.empty': 'No matching entries',
        'reader.pick': 'Pick an entry on the left',
        'reader.translate': 'Translate to Chinese',
        'reader.translating': 'Translating…',
        'reader.bilingual': 'Bilingual',
        'reader.zhOnly': 'Chinese only',
        'reader.pending': 'No translation yet',
        'reader.segments': 'segments',
        'reader.duration': 'duration',
        'reader.source': 'source',
        'reader.open': 'Open original',
        'status.asr.pending': 'pending',
        'status.asr.running': 'transcribing',
        'status.asr.done': 'transcribed',
        'status.asr.failed': 'failed',
        'status.translate.running': 'translating',
        'status.translate.done': 'translated',
        'status.translate.partial': 'partly translated',
        'status.translate.failed': 'translation failed',
        'job.running': 'Running',
      }

      const CSS = `
.ar-root { display:flex; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif; }
.ar-list { width:288px; flex:0 0 288px; border-right:1px solid var(--dsw-alias-border-l1); display:flex; flex-direction:column; min-height:0;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 60%, var(--dsw-alias-bg-base)); }
.ar-list-head { padding:14px 14px 8px; }
.ar-title { font-size:16px; font-weight:650; letter-spacing:-0.01em; margin:0; }
.ar-sub { margin:4px 0 0; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ar-search { margin:9px 0 0; width:100%; box-sizing:border-box; padding:7px 10px; font-size:12.5px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:inherit; outline:none; }
.ar-search:focus { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); }
.ar-items { flex:1; overflow-y:auto; padding:4px 8px 16px; }
.ar-item { padding:9px 10px; border-radius:9px; cursor:pointer; border:1px solid transparent; }
.ar-item:hover { background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent); }
.ar-item.active { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l1); }
.ar-item-title { font-size:12.8px; line-height:1.45; font-weight:520; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.ar-item-meta { margin-top:3px; font-size:11px; color:var(--dsw-alias-label-secondary); display:flex; gap:6px; align-items:center; }
.ar-dot { width:5px; height:5px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:0 0 auto; }
.ar-dot.done { background:var(--dsw-alias-state-success-primary); }
.ar-dot.running { background:var(--dsw-alias-state-warn-primary); }
.ar-dot.failed { background:var(--dsw-alias-state-error-primary); }
.ar-main { flex:1; min-width:0; display:flex; flex-direction:column; }
.ar-scroll { flex:1; overflow-y:auto; }
.ar-article { width:100%; max-width:836px; margin:0 auto; padding:24px 32px 72px; }
.ar-eyebrow { display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.ar-h1 { font-size:24px; line-height:1.25; letter-spacing:-0.021em; font-weight:680; margin:10px 0 0; }
.ar-toolbar { display:flex; gap:8px; align-items:center; margin:18px 0 6px; flex-wrap:wrap; }
.ar-btn { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:inherit; border-radius:8px;
  padding:5px 11px; font-size:12px; cursor:pointer; font-family:inherit; }
.ar-btn:hover { border-color:var(--dsw-alias-border-l2); }
.ar-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:var(--dsw-alias-label-primary-foreground,#fff); }
.ar-btn:disabled { opacity:.55; cursor:default; }
.ar-audio { width:100%; margin:16px 0 4px; height:34px; }
.ar-seg { display:grid; grid-template-columns:56px 1fr; gap:12px; padding:9px 0; border-top:1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent); }
.ar-time { font-variant-numeric:tabular-nums; font-size:11px; color:var(--dsw-alias-label-secondary); padding-top:3px; text-align:right;
  cursor:pointer; user-select:none; }
.ar-time:hover { color:var(--dsw-alias-brand-primary); }
.ar-src { font-size:15px; line-height:1.72; letter-spacing:0.003em; }
.ar-zh { font-size:14px; line-height:1.8; margin-top:5px; color:color-mix(in srgb, var(--dsw-alias-label-primary) 78%, var(--dsw-alias-label-secondary)); }
.ar-zh.only { margin-top:0; font-size:15px; }
.ar-empty { max-width:520px; margin:clamp(24px,7vh,56px) auto 0; padding:0 32px; text-align:center; }
.ar-empty h2 { font-size:20px; font-weight:640; margin:0 0 8px; letter-spacing:-0.01em; }
.ar-empty p { font-size:13px; line-height:1.7; color:var(--dsw-alias-label-secondary); margin:0 0 18px; }
.ar-form { display:flex; flex-direction:column; gap:8px; text-align:left; }
.ar-input { padding:9px 11px; font-size:13px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:inherit; outline:none; font-family:inherit; }
.ar-input:focus { border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); }
.ar-row { display:flex; gap:8px; }
.ar-hint { font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.ar-jobs { border-top:1px solid var(--dsw-alias-border-l1); padding:10px 14px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.ar-bar { height:3px; border-radius:2px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; margin-top:6px; }
.ar-bar span { display:block; height:100%; background:var(--dsw-alias-brand-primary); transition:width .3s ease; }
.ar-err { color:var(--dsw-alias-state-error-primary); font-size:11.5px; margin-top:6px; }
.ar-speaker { font-size:13px; font-weight:700; letter-spacing:0.01em; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
.ar-speaker i { width:7px; height:7px; border-radius:50%; display:inline-block; }
.ar-seg.start { border-top-color:color-mix(in srgb, var(--dsw-alias-border-l1) 90%, transparent); }
.ar-names { margin:10px 0 0; display:flex; flex-direction:column; gap:8px; max-width:460px; }
.ar-name-row { display:grid; grid-template-columns:96px 1fr; gap:8px; align-items:center; }
.ar-name-src { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.ar-name-actions { display:flex; gap:8px; margin-top:2px; }
.ar-chapters { margin:14px 0 0; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden; }
.ar-chapter { padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l1); }
.ar-chapter:first-child { border-top:0; }
.ar-chapter-head { display:flex; gap:8px; align-items:baseline; cursor:pointer; }
.ar-chapter-time { font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.ar-chapter-title { font-size:12.5px; font-weight:600; }
.ar-moment { margin:6px 0 0 44px; font-size:11.5px; line-height:1.55; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.ar-moment:hover { color:var(--dsw-alias-brand-primary); }
.ar-star { border:0; background:transparent; cursor:pointer; font-size:12px; padding:0 2px; color:var(--dsw-alias-label-secondary); }
.ar-star.on { color:#f59e0b; }
.ar-copy { border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:10px; opacity:0; padding:0 2px; }
.ar-seg:hover .ar-copy { opacity:1; }
.ar-copy:hover { color:var(--dsw-alias-brand-primary); }
.ar-section { margin:6px 0 2px; }
.ar-section-head { display:flex; align-items:baseline; gap:6px; padding:6px 8px 4px; cursor:pointer; user-select:none; }
.ar-section-name { font-size:12px; font-weight:650; }
.ar-section-count { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.ar-section-caret { font-size:9px; color:var(--dsw-alias-label-secondary); width:10px; }
.ar-section-body { padding-left:2px; }
.ar-group-title { font-size:11px; font-weight:650; letter-spacing:0.03em; color:var(--dsw-alias-label-secondary); margin:10px 0 4px 4px; }
.ar-hit { padding:8px 10px; border-radius:8px; cursor:pointer; }
.ar-hit:hover { background:var(--dsw-alias-bg-layer-2); }
.ar-hit-title { font-size:12px; font-weight:600; }
.ar-hit-seg { margin-top:4px; font-size:11px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.ar-summary { margin:18px 0 4px; padding:14px 16px; border-radius:11px; background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);
  border:1px solid var(--dsw-alias-border-l1); }
.ar-summary-topic { font-size:12px; font-weight:650; letter-spacing:0.02em; color:var(--dsw-alias-label-secondary); margin-bottom:6px; }
.ar-summary-body { font-size:13.5px; line-height:1.75; }
.ar-summary-points { margin:10px 0 0; padding-left:18px; font-size:12.5px; line-height:1.7; color:var(--dsw-alias-label-secondary); }
.ar-oneline { font-size:14px; line-height:1.65; font-weight:600; margin:2px 0 8px; letter-spacing:-0.005em; }
.ar-points { margin:10px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:6px; }
.ar-points li { font-size:12.5px; line-height:1.65; padding-left:10px; border-left:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent); }
.ar-point-by { font-weight:650; margin-right:4px; }
.ar-highlights { margin:10px 0 0; display:flex; flex-wrap:wrap; gap:6px; }
.ar-highlight { font-size:11.5px; padding:3px 8px; border-radius:999px; background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.ar-kind { font-size:10px; padding:1px 5px; border-radius:4px; background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color:color-mix(in srgb, var(--dsw-alias-brand-primary) 80%, var(--dsw-alias-label-primary)); }
.ar-del { margin-left:auto; border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:11px; padding:0 2px; opacity:0; }
.ar-item:hover .ar-del { opacity:1; }
.ar-del:hover { color:var(--dsw-alias-state-error-primary); }
.ar-auto { margin-top:8px; font-size:10.5px; line-height:1.5; color:var(--dsw-alias-label-secondary);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ar-actions { display:flex; align-items:center; gap:8px; margin-top:7px; flex-wrap:wrap; }
.ar-btn.sm { padding:3px 9px; font-size:11.5px; }
.ar-cands { margin-top:8px; display:flex; flex-direction:column; gap:4px; max-height:132px; overflow-y:auto; }
.ar-cand { display:flex; gap:6px; align-items:center; font-size:11px; line-height:1.45; padding:4px 6px; border-radius:6px;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent); }
.ar-cand span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ar-cand button { border:0; background:transparent; color:var(--dsw-alias-brand-primary); font-size:11px; cursor:pointer; font-family:inherit; }
.ar-chips { display:flex; flex-wrap:wrap; gap:4px; margin-top:7px; }
.ar-chips.nowrap { flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; -ms-overflow-style:none; }
.ar-chips.nowrap::-webkit-scrollbar { display:none; }
.ar-chips.nowrap .ar-chip { flex:0 0 auto; }
.ar-chips.ar-views { gap:2px; padding:2px; border-radius:9px;
  background:color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.ar-chips.ar-views .ar-chip { flex:1 1 0; text-align:center; border:0; border-radius:7px; padding:3px 0;
  color:var(--dsw-alias-label-secondary); background:transparent; }
.ar-chips.ar-views .ar-chip:hover { color:var(--dsw-alias-label-primary); }
.ar-chips.ar-views .ar-chip.on { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  box-shadow:0 0 0 1px var(--dsw-alias-border-l2), 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.ar-chips.nowrap.ar-people:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
  outline-offset:2px; border-radius:8px; }
.ar-chips.nowrap.ar-people { mask-image:linear-gradient(to right, #000 0, #000 calc(100% - 16px), transparent 100%);
  -webkit-mask-image:linear-gradient(to right, #000 0, #000 calc(100% - 16px), transparent 100%); }
.ar-chip { font-size:11px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1);
  background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; font-family:inherit; white-space:nowrap; }
.ar-chip.on { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
/* Apple HIG web adaptation; all CSS sizes below are project choices. */
.ar-frame { height:100%; min-height:0; min-width:0; container-type:inline-size; container-name:archive; }
.ar-root { min-width:0; font-size:14px; line-height:1.55; }
.ar-root *, .ar-root *::before, .ar-root *::after { box-sizing:border-box; }
.ar-root :where(button,input) { font-family:inherit; }
.ar-root :where(button,[role="button"],input,a):focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:3px; }
.ar-list-head { padding:16px 16px 12px; }
.ar-sub { font-size:12px; white-space:normal; overflow:visible; line-height:1.6; }
.ar-search,.ar-input { min-height:36px; min-width:0; font-size:14px; border-radius:10px; }
.ar-items { padding:4px 10px 16px; scrollbar-width:thin; }
.ar-item { padding:12px; border-radius:12px; }
.ar-item-title,.ar-hit-title { font-size:14px; line-height:1.55; }
.ar-item-meta { flex-wrap:wrap; font-size:12px; gap:6px; }
.ar-item-meta > span:not(.ar-kind):not(.ar-dot) { min-width:0; overflow-wrap:anywhere; }
.ar-btn { min-height:34px; padding:6px 12px; font-size:13px; border-radius:9px; line-height:1.4; }
.ar-btn.sm { min-height:32px; padding:5px 10px; font-size:12.5px; }
.ar-chip { min-height:32px; padding:4px 10px; font-size:12px; }
.ar-chips.ar-views .ar-chip { min-height:32px; }
.ar-toolbar { gap:8px; margin-top:16px; }
.ar-empty { width:100%; padding:0 24px; }
.ar-empty p { font-size:14px; }
.ar-row { flex-wrap:wrap; }.ar-row .ar-input { flex:1 1 160px; }
.ar-summary,.ar-chapters { border-radius:14px; }
.ar-summary { padding:16px; margin-top:20px; }.ar-summary-body,.ar-points li { font-size:14px; line-height:1.75; }
.ar-seg { gap:16px; padding:14px 0; }.ar-time { font-size:12px; }
.ar-time button { color:inherit; font:inherit; background:transparent; border:0; cursor:pointer; }
.ar-seek { min-height:32px; padding:0 2px; }
.ar-copy,.ar-del,.ar-star { min-width:28px; min-height:28px; display:inline-flex; align-items:center; justify-content:center; font-size:14px; }
.ar-item:focus-within .ar-del,.ar-seg:focus-within .ar-copy { opacity:1; }
.ar-star.on { color:var(--dsw-alias-state-warn-primary); }
.ar-section-head { min-height:36px; }.ar-section-name { font-size:13px; }.ar-section-count,.ar-hit-seg,.ar-auto,.ar-hint,.ar-err { font-size:12px; }
.ar-chapter { padding:12px 14px; }.ar-chapter-head { min-height:32px; }.ar-chapter-title { font-size:14px; }.ar-moment { min-height:32px; font-size:13px; margin-left:0; padding-left:44px; }
.ar-cand { min-height:36px; gap:8px; padding:8px; }.ar-cand button { min-height:32px; font-size:12px; }
.ar-hit { padding:12px; }.ar-article { overflow-wrap:anywhere; }
@container archive (max-width:760px) { .ar-list { width:248px; flex-basis:248px; }.ar-article { padding:20px 24px 56px; }.ar-h1 { font-size:22px; } }
@container archive (max-width:600px) { .ar-root { flex-direction:column; }.ar-list { width:100%; flex:0 0 42%; height:42%; min-height:180px; max-height:46%; border-right:0; border-bottom:1px solid var(--dsw-alias-border-l1); }.ar-list-head { max-height:160px; overflow:auto; flex-shrink:0; }.ar-items { min-height:56px; }.ar-main { min-height:0; flex:1 1 auto; }.ar-article { padding:20px 16px 48px; }.ar-h1 { font-size:20px; }.ar-seg { grid-template-columns:48px minmax(0,1fr); gap:10px; }.ar-empty { margin-top:24px; padding:0 16px 24px; } }
@media (pointer:coarse) { .ar-btn,.ar-chip,.ar-copy,.ar-del,.ar-star,.ar-seek,.ar-cand button { min-height:44px; }.ar-copy,.ar-del { opacity:1; } }
@media (prefers-reduced-motion:reduce) { .ar-root * { transition:none!important; animation:none!important; scroll-behavior:auto!important; } }
@media (prefers-contrast:more) { .ar-item.active,.ar-btn,.ar-input,.ar-search,.ar-chip,.ar-summary,.ar-chapters { border-color:var(--dsw-alias-border-l2); } }

`

      function useStyles() {
        useEffect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-dsh-ai-records', '')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => {
            el.remove()
          }
        }, [])
      }

      function fmtClock(ms) {
        const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
        const hrs = Math.floor(total / 3600)
        const mins = Math.floor((total % 3600) / 60)
        const secs = total % 60
        const pad = (n) => String(n).padStart(2, '0')
        return hrs ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`
      }

      async function api(path, options) {
        const response = await fetch(ORIGIN + path, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
        })
        const text = await response.text()
        let json
        try {
          json = JSON.parse(text)
        } catch {
          return { ok: false, error: `返回非 JSON（HTTP ${response.status}）` }
        }
        return json
      }

      function statusOf(item) {
        const status = item && item.status ? item.status : {}
        if (status.asr === 'failed') return 'failed'
        if (status.asr !== 'done') return status.asr === 'running' ? 'running' : 'pending'
        if (status.translate === 'running') return 'running'
        if (status.translate === 'done' || status.translate === 'skipped') return 'done'
        return 'pending'
      }

      const SPEAKER_COLORS = ['#3b82f6', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#06b6d4']

      const KINDS = [
        { id: 'interview', label: '访谈' },
        { id: 'roundtable', label: '圆桌' },
        { id: 'keynote', label: '演讲' },
        { id: 'event', label: '发布会' },
      ]
      const kindLabel = (kind) => (KINDS.find((k) => k.id === kind) || { label: '其他' }).label

      function activateWithKeyboard(event) {
        if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.currentTarget.click();
      }

      function ListItem({ item, active, onSelect, onDelete, onToggleFav, onRetry }) {
        const state = statusOf(item)
        const bits = []
        if (item.sourceName) bits.push(item.sourceName)
        if (item.durationSec) bits.push(fmtClock(item.durationSec * 1000))
        return h(
          'div',
          { className: 'ar-item' + (active ? ' active' : ''), onClick: () => onSelect(item.id), role: 'button', tabIndex: 0, onKeyDown: activateWithKeyboard, 'aria-pressed': active },
          h('div', { className: 'ar-item-title' }, item.title || '未命名'),
          h(
            'div',
            { className: 'ar-item-meta' },
            h('button', { className: 'ar-star' + (item.favorite ? ' on' : ''), title: item.favorite ? '取消收藏' : '收藏', 'aria-label': item.favorite ? '取消收藏' : '收藏', 'aria-pressed': Boolean(item.favorite), onClick: (e) => { e.stopPropagation(); onToggleFav(item) } }, item.favorite ? '★' : '☆'),
            h('span', { className: 'ar-kind' }, kindLabel(item.kind)),
            h('span', { className: 'ar-dot ' + state }),
            h('span', null, bits.join(' · ') || '待补信息'),
            state === 'failed'
              ? h(
                  'button',
                  {
                    className: 'ar-del',
                    style: { opacity: 1 },
                    title: '重试',
                    'aria-label': '重试这条访谈',
                    onClick: (event) => {
                      event.stopPropagation()
                      onRetry(item)
                    },
                  },
                  '↻',
                )
              : null,
            h(
              'button',
              {
                className: 'ar-del',
                title: '删除这条',
                'aria-label': '删除这条访谈',
                onClick: (event) => {
                  event.stopPropagation()
                  onDelete(item)
                },
              },
              '✕',
            ),
          ),
        )
      }

      const Segment = memo(function Segment({ seg, zh, bilingual, onSeek, showSpeaker, label, color, isStart, quoteTitle }) {
        const hasZh = Boolean(zh)
        // 只看中文：有译文就只显示译文；没译文时回退显示原文，避免整段空白
        const showSource = bilingual || !hasZh
        return h(
          'div',
          { className: 'ar-seg' + (isStart ? ' start' : ''), id: `seg-${seg.startMs}` },
          h(
            'div',
            { className: 'ar-time' },
            h('button', { type: 'button', className: 'ar-seek', onClick: () => onSeek(seg.startMs), title: '跳到这一句', 'aria-label': '跳到 ' + fmtClock(seg.startMs) }, fmtClock(seg.startMs)),
            h(
              'button',
              {
                className: 'ar-copy',
                title: '复制带出处的摘录',
                'aria-label': '复制带出处的摘录',
                onClick: () => {
                  const stamp = fmtClock(seg.startMs)
                  const text = `[${quoteTitle}，${stamp}] ${seg.text}`
                  if (navigator.clipboard) void navigator.clipboard.writeText(text)
                },
              },
              '⧉',
            ),
          ),
          h(
            'div',
            null,
            showSpeaker && label
              ? h('div', { className: 'ar-speaker', style: { color } }, h('i', { style: { background: color } }), label)
              : null,
            showSource ? h('div', { className: 'ar-src' }, seg.text) : null,
            hasZh ? h('div', { className: 'ar-zh' + (bilingual ? '' : ' only') }, zh) : null,
          ),
        )
      })

      function Reader({ detail, onTranslate, onSeek, audioRef, needTranslation, onKb, onDelete, onSummarize, onRename }) {
        const meta = detail.meta
        const segments = detail.transcript && detail.transcript.segments ? detail.transcript.segments : []
        const zhSegments = detail.translation && detail.translation.segments ? detail.translation.segments : []
        const [bilingual, setBilingual] = useState(true)
        const [busy, setBusy] = useState(false)
        const [kbBusy, setKbBusy] = useState(false)
        const [kbNote, setKbNote] = useState('')

        useEffect(() => {
          setBusy(false)
          setEditNames(false)
          setDraftNames(detail.meta.speakerMap || {})
        }, [detail.meta.id, detail.meta.status && detail.meta.status.translate])

        const speakerIndex = {}
        segments.forEach((seg) => {
          if (seg.speaker && !(seg.speaker in speakerIndex)) speakerIndex[seg.speaker] = Object.keys(speakerIndex).length
        })
        const colorOf = (speaker) => SPEAKER_COLORS[(speakerIndex[speaker] || 0) % SPEAKER_COLORS.length]
        const segmentSpeakers = Object.keys(speakerIndex)
        const [sumBusy, setSumBusy] = useState(false)
        const [editNames, setEditNames] = useState(false)
        const [draftNames, setDraftNames] = useState(meta.speakerMap || {})
        const [savingNames, setSavingNames] = useState(false)

        const audioSrc = /^https?:/i.test(meta.mediaUrl || '') ? meta.mediaUrl : meta.mediaFile ? `${ORIGIN}/media/${meta.id}` : ''

        return h(
          'div',
          { className: 'ar-article' },
          h(
            'div',
            { className: 'ar-eyebrow' },
            meta.sourceName ? h('span', null, meta.sourceName) : null,
            meta.publishedAt ? h('span', null, '·') : null,
            meta.publishedAt ? h('span', null, String(meta.publishedAt).slice(0, 10)) : null,
            meta.durationSec ? h('span', null, '·') : null,
            meta.durationSec ? h('span', null, fmtClock(meta.durationSec * 1000)) : null,
            meta.sourceUrl
              ? h('a', { href: meta.sourceUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '· 原页面')
              : null,
          ),
          h('h1', { className: 'ar-h1' }, meta.title || '未命名'),
          meta.host || (meta.guests && meta.guests.length)
            ? h(
                'div',
                { className: 'ar-eyebrow', style: { marginTop: 8 } },
                meta.host ? `主持：${meta.host}` : '',
                meta.host && meta.guests && meta.guests.length ? ' · ' : '',
                meta.guests && meta.guests.length ? `嘉宾：${meta.guests.join('、')}` : '',
              )
            : meta.speakers && meta.speakers.length
              ? h('div', { className: 'ar-eyebrow', style: { marginTop: 8 } }, meta.speakers.join(' · '))
              : null,
          segmentSpeakers.length
            ? h(
                'div',
                null,
                h(
                  'button',
                  {
                    className: 'ar-btn',
                    style: { marginTop: 12 },
                    onClick: () => {
                      setDraftNames(meta.speakerMap || {})
                      setEditNames((value) => !value)
                    },
                  },
                  editNames ? '收起' : '改人名',
                ),
                editNames
                  ? h(
                      'div',
                      { className: 'ar-names' },
                      segmentSpeakers.map((key) =>
                        h(
                          'div',
                          { key, className: 'ar-name-row' },
                          h('span', { className: 'ar-name-src' }, key),
                          h('input', {
                            className: 'ar-input',
                            placeholder: '真实姓名',
                            'aria-label': '说话人 ' + key + ' 的真实姓名',
                            value: draftNames[key] || '',
                            onChange: (event) => setDraftNames((prev) => ({ ...prev, [key]: event.target.value })),
                          }),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ar-name-actions' },
                        h(
                          'button',
                          {
                            className: 'ar-btn primary',
                            disabled: savingNames,
                            onClick: async () => {
                              setSavingNames(true)
                              await onRename(meta.id, draftNames)
                              setSavingNames(false)
                              setEditNames(false)
                            },
                          },
                          savingNames ? '保存中…' : '保存',
                        ),
                      ),
                    )
                  : null,
              )
            : null,
          kbNote ? h('div', { className: 'ar-hint', style: { marginTop: 8 } }, kbNote) : null,
          meta.progressMs
            ? h(
                'div',
                { className: 'ar-hint', style: { marginTop: 8 } },
                '上次读到 ',
                h('a', { href: 'javascript:void 0', onClick: () => onSeek(meta.progressMs), style: { color: 'inherit' } }, fmtClock(meta.progressMs)),
              )
            : null,
          audioSrc ? h('audio', { className: 'ar-audio', controls: true, src: audioSrc, ref: audioRef, preload: 'metadata' }) : null,
          meta.summary
            ? h(
                'div',
                { className: 'ar-summary' },
                meta.summaryTopic ? h('div', { className: 'ar-summary-topic' }, meta.summaryTopic) : null,
                meta.summaryOneLine ? h('div', { className: 'ar-oneline' }, meta.summaryOneLine) : null,
                h('div', { className: 'ar-summary-body' }, meta.summary),
                Array.isArray(meta.summaryPoints) && meta.summaryPoints.length
                  ? h(
                      'ul',
                      { className: 'ar-points' },
                      meta.summaryPoints.map((point, i) => {
                        const text = String(point)
                        const cut = text.indexOf('：')
                        const by = cut > 0 && cut < 24 ? text.slice(0, cut) : ''
                        const body = cut > 0 && cut < 24 ? text.slice(cut + 1) : text
                        return h('li', { key: i }, by ? h('span', { className: 'ar-point-by' }, `${by}：`) : null, body)
                      }),
                    )
                  : null,
                Array.isArray(meta.summaryHighlights) && meta.summaryHighlights.length
                  ? h('div', { className: 'ar-highlights' }, meta.summaryHighlights.map((line, i) => h('span', { key: i, className: 'ar-highlight' }, line)))
                  : null,
              )
            : null,
          detail.chapters && Array.isArray(detail.chapters.chapters) && detail.chapters.chapters.length
            ? h(
                'div',
                { className: 'ar-chapters' },
                detail.chapters.chapters.map((chapter, index) =>
                  h(
                    'div',
                    { key: index, className: 'ar-chapter' },
                    h(
                      'div',
                      { className: 'ar-chapter-head', role: 'button', tabIndex: 0, onKeyDown: activateWithKeyboard, onClick: () => onSeek(chapter.startMs) },
                      h('span', { className: 'ar-chapter-time' }, fmtClock(chapter.startMs)),
                      h('span', { className: 'ar-chapter-title' }, chapter.title),
                    ),
                    (chapter.moments || []).map((moment, mi) =>
                      h('div', { key: mi, className: 'ar-moment', role: 'button', tabIndex: 0, onKeyDown: activateWithKeyboard, onClick: () => onSeek(moment.startMs) }, `${fmtClock(moment.startMs)}  ${moment.title}`),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ar-toolbar' },
            h('button', { className: 'ar-btn' + (bilingual ? ' primary' : ''), onClick: () => setBilingual(true) }, '中英对照'),
            h('button', { className: 'ar-btn' + (!bilingual ? ' primary' : ''), onClick: () => setBilingual(false) }, '只看中文'),
            needTranslation
              ? h(
                  'button',
                  {
                    className: 'ar-btn',
                    disabled: busy,
                    onClick: async () => {
                      setBusy(true)
                      await onTranslate(meta.id)
                    },
                  },
                  busy ? '翻译中…' : '翻译成中文',
                )
              : null,
            h(
              'button',
              {
                className: 'ar-btn',
                disabled: sumBusy || !segments.length,
                onClick: async () => {
                  setSumBusy(true)
                  await onSummarize(meta.id)
                  setSumBusy(false)
                },
              },
              meta.summary ? '重写摘要' : (sumBusy ? '生成中…' : '生成摘要'),
            ),
            h('button', { className: 'ar-btn', disabled: !segments.length, onClick: () => window.open(`${ORIGIN}/items/${meta.id}/export?format=md`, '_blank') }, '导出 MD'),
            h('button', { className: 'ar-btn', disabled: !segments.length, onClick: () => window.open(`${ORIGIN}/items/${meta.id}/export?format=srt`, '_blank') }, '导出 SRT'),
            h(
              'button',
              {
                className: 'ar-btn',
                disabled: kbBusy || !segments.length,
                onClick: async () => {
                  setKbBusy(true)
                  setKbNote('')
                  const result = await onKb(meta.id)
                  setKbBusy(false)
                  setKbNote(result && result.ok ? '已送入知识库，正在编译' : (result && result.error) || '失败')
                },
              },
              kbBusy ? '提交中…' : '存入知识库',
            ),
            h('span', { className: 'ar-hint', style: { marginLeft: 'auto' } }, `${segments.length} 段`),
          ),
          segments.length
            ? h(
                'div',
                null,
                segments.map((seg, idx) =>
                  h(Segment, {
                    key: seg.i,
                    seg,
                    zh: zhSegments[seg.i],
                    bilingual,
                    onSeek,
                    showSpeaker: idx === 0 || segments[idx - 1].speaker !== seg.speaker,
                    isStart: idx === 0 || segments[idx - 1].speaker !== seg.speaker,
                    color: colorOf(seg.speaker),
                    label: (meta.speakerMap && meta.speakerMap[seg.speaker]) || seg.speaker,
                    quoteTitle: meta.title || '未命名',
                  }),
                ),
              )
            : h('p', { className: 'ar-hint', style: { marginTop: 24 } }, '这条还没有逐字稿。'),
        )
      }

      function EmptyState({ onIngest, busy, error }) {
        const [url, setUrl] = useState('')
        const [title, setTitle] = useState('')
        const [source, setSource] = useState('')
        return h(
          'div',
          { className: 'ar-empty' },
          h('h2', null, '还没有内容'),
          h('p', null, '把一个可公网访问的音频链接放进来（播客 RSS 直链最稳），后台会转写并翻译成中英对照。'),
          h(
            'div',
            { className: 'ar-form' },
            h('input', {
              className: 'ar-input',
              placeholder: '音频直链（https://…）', 'aria-label': '音频直链（https://…）',
              value: url,
              onChange: (e) => setUrl(e.target.value),
            }),
            h(
              'div',
              { className: 'ar-row' },
              h('input', { className: 'ar-input', placeholder: '标题（可留空）', 'aria-label': '标题（可留空）', value: title, onChange: (e) => setTitle(e.target.value) }),
              h('input', { className: 'ar-input', placeholder: '来源', 'aria-label': '来源', value: source, onChange: (e) => setSource(e.target.value), style: { width: 140 } }),
            ),
            h(
              'button',
              {
                className: 'ar-btn primary',
                disabled: busy || !url.trim(),
                onClick: async () => {
                  await onIngest({ url: url.trim(), title: title.trim(), sourceName: source.trim() })
                  setUrl('')
                  setTitle('')
                  setSource('')
                },
              },
              busy ? '提交中…' : '加入档案',
            ),
            error ? h('div', { className: 'ar-err', role: 'alert' }, error) : null,
            h('div', { className: 'ar-hint' }, 'YouTube 链接需要先有可访问的音频地址；短切片、广告先不收。'),
          ),
        )
      }

      function Root() {
        useStyles()
        const [items, setItems] = useState([])
        const [stats, setStats] = useState({ total: 0 })
        const [listCost, setListCost] = useState(null)
        const [autoInfo, setAutoInfo] = useState(null)
        const [autoBusy, setAutoBusy] = useState(false)
        const [jobs, setJobs] = useState([])
        const [activeId, setActiveId] = useState('')
        const [detail, setDetail] = useState(null)
        const [query, setQuery] = useState('')
        const [syncing, setSyncing] = useState(false)
        const [syncNote, setSyncNote] = useState('')
        const [candidates, setCandidates] = useState([])
        const [searchHits, setSearchHits] = useState([])
        const [searching, setSearching] = useState(false)
        const [pendingSeek, setPendingSeek] = useState(0)
        const [kindFilter, setKindFilter] = useState('all')
        const [speakerFilter, setSpeakerFilter] = useState('all')
        const [onlyFav, setOnlyFav] = useState(false)
        const [view, setView] = useState('items')
        const [people, setPeople] = useState([])
        const [topics, setTopics] = useState([])
        const [clusters, setClusters] = useState(null)
        const [sourceFilter, setSourceFilter] = useState('all')
        const [collapsed, setCollapsed] = useState({})
        const [ingestBusy, setIngestBusy] = useState(false)
        const [error, setError] = useState('')
        const audioRef = useRef(null)
        const detailRef = useRef('')
        const peopleRowRef = useRef(null)

        const refreshList = useCallback(async () => {
          const data = await api('/items')
          if (!data || !data.ok) {
            setError((data && data.error) || '列表加载失败')
            return
          }
          setItems(data.items || [])
          setStats(data.stats || { total: 0 })
          setListCost(data.cost || null)
          setAutoInfo(data.auto || null)
          setJobs(data.jobs || [])
          if (!detailRef.current && data.items && data.items.length) setActiveId(data.items[0].id)
        }, [])

        useEffect(() => {
          void refreshList()
        }, [refreshList])

        useEffect(() => {
          const timer = setInterval(() => {
            const busy = jobs.some((job) => job.stage !== 'done' && job.stage !== 'failed')
            if (busy) void refreshList()
          }, POLL_MS)
          return () => clearInterval(timer)
        }, [jobs, refreshList])

        useEffect(() => {
          if (!activeId) {
            detailRef.current = ''
            setDetail(null)
            return
          }
          let cancelled = false
          void (async () => {
            const data = await api(`/items/${activeId}`)
            if (cancelled) return
            if (data && data.ok) {
              detailRef.current = activeId
              setDetail({ meta: data.meta, transcript: data.transcript, translation: data.translation, chapters: data.chapters })
              if (pendingSeek) {
                const target = pendingSeek
                setPendingSeek(0)
                setTimeout(() => onSeek(target), 250)
              }
            }
          })()
          return () => {
            cancelled = true
          }
        }, [activeId, jobs.length])

        const onIngest = useCallback(
          async (payload) => {
            setIngestBusy(true)
            setError('')
            const data = await api('/ingest', { method: 'POST', body: JSON.stringify(payload) })
            setIngestBusy(false)
            if (!data || !data.ok) {
              setError((data && data.error) || '入库失败')
              return
            }
            await refreshList()
            if (data.item && data.item.id) setActiveId(data.item.id)
          },
          [refreshList],
        )

        const onTranslate = useCallback(
          async (id) => {
            await api(`/items/${id}/translate`, { method: 'POST' })
            await refreshList()
          },
          [refreshList],
        )

        const onDelete = useCallback(
          async (item) => {
            const label = item && item.title ? item.title : '这条'
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`删除「${label}」？本地音频和逐字稿会一并删除。`)) return
            const data = await api(`/items/${item.id}`, { method: 'DELETE' })
            if (!data || !data.ok) {
              setError((data && data.error) || '删除失败')
              return
            }
            if (activeId === item.id) {
              setActiveId('')
              setDetail(null)
            }
            await refreshList()
          },
          [activeId, refreshList],
        )

        const onKb = useCallback(async (id) => api(`/items/${id}/kb`, { method: 'POST' }), [])

        const onAutoRun = useCallback(async () => {
          setAutoBusy(true)
          const data = await api('/auto/run', { method: 'POST' })
          setAutoBusy(false)
          if (data && data.auto) setAutoInfo(data.auto)
          await refreshList()
        }, [refreshList])

        const onSync = useCallback(async () => {
          setSyncing(true)
          setSyncNote('')
          const data = await api('/sources/sync', { method: 'POST', body: JSON.stringify({ limit: 5 }) })
          setSyncing(false)
          if (!data || !data.ok) {
            setSyncNote((data && data.error) || '同步失败')
            return
          }
          setCandidates(data.fresh || [])
          setSyncNote(`扫到 ${data.scanned} 条，去重后 ${data.afterDedupe} 条，新增 ${(data.fresh || []).length} 条`)
        }, [])

        const onIngestCandidate = useCallback(
          async (candidate) => {
            setCandidates((prev) => prev.filter((item) => item.mediaUrl !== candidate.mediaUrl))
            await api('/sources/ingest', { method: 'POST', body: JSON.stringify(candidate) })
            await refreshList()
          },
          [refreshList],
        )

        const onRetry = useCallback(
          async (item) => {
            await api(`/items/${item.id}/retry`, { method: 'POST' })
            await refreshList()
          },
          [refreshList],
        )

        const onIgnore = useCallback(async (candidate) => {
          setCandidates((prev) => prev.filter((item) => item.mediaUrl !== candidate.mediaUrl))
          await api('/sources/ignore', { method: 'POST', body: JSON.stringify({ title: candidate.title, mediaUrl: candidate.mediaUrl }) })
        }, [])

        const onToggleFav = useCallback(
          async (item) => {
            await api(`/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !item.favorite }) })
            await refreshList()
          },
          [refreshList],
        )

        const saveProgress = useRef(0)

        const onRename = useCallback(
          async (id, map) => {
            const speakers = Object.values(map).map((name) => String(name || '').trim()).filter(Boolean)
            const data = await api(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ speakerMap: map, speakers }) })
            if (data && data.ok) {
              setDetail((prev) => (prev && prev.meta.id === id ? { ...prev, meta: data.meta } : prev))
              await refreshList()
            }
            return data
          },
          [refreshList],
        )

        const onSummarize = useCallback(
          async (id) => {
            const data = await api(`/items/${id}/summarize`, { method: 'POST' })
            if (data && data.ok) {
              setDetail((prev) => (prev && prev.meta.id === id ? { ...prev, meta: data.meta } : prev))
              await refreshList()
            }
          },
          [refreshList],
        )

        const onSeek = useCallback((ms) => {
          if (activeId) {
            if (saveProgress.current) clearTimeout(saveProgress.current)
            saveProgress.current = setTimeout(() => {
              void api(`/items/${activeId}`, { method: 'PATCH', body: JSON.stringify({ progressMs: ms }) })
            }, 1500)
          }
          const target = document.getElementById(`seg-${ms}`)
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
          const audio = audioRef.current
          if (audio) {
            audio.currentTime = Math.max(0, Number(ms) / 1000)
            void audio.play().catch(() => {})
          }
        }, [activeId])

        const openAt = useCallback((id, ms) => {
          setActiveId(id)
          setPendingSeek(ms || 0)
        }, [])

        const speakers = useMemo(() => {
          const set = new Set()
          for (const item of items) {
            if (kindFilter !== 'all' && item.kind !== kindFilter) continue
            for (const name of item.speakers || []) set.add(name)
          }
          return [...set].slice(0, 12)
        }, [items, kindFilter])

        useEffect(() => {
          const el = peopleRowRef.current
          if (!el) return undefined
          const onWheel = (event) => {
            if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
            if (el.scrollWidth <= el.clientWidth) return
            event.preventDefault()
            el.scrollLeft += event.deltaY
          }
          el.addEventListener('wheel', onWheel, { passive: false })
          return () => el.removeEventListener('wheel', onWheel)
        }, [speakers.length])

        useEffect(() => {
          const el = peopleRowRef.current
          if (!el) return
          const chip = speakerFilter === 'all' ? el.firstElementChild : Array.from(el.children).find((node) => node.textContent === speakerFilter)
          if (chip && typeof chip.scrollIntoView === 'function') chip.scrollIntoView({ inline: 'center', block: 'nearest' })
        }, [speakerFilter])

        useEffect(() => {
          const q = query.trim()
          if (q.length < 2) {
            setSearchHits([])
            setSearching(false)
            return undefined
          }
          setSearching(true)
          const timer = setTimeout(async () => {
            const data = await api(`/search?q=${encodeURIComponent(q)}`)
            setSearchHits((data && data.hits) || [])
            setSearching(false)
          }, 350)
          return () => clearTimeout(timer)
        }, [query])

        const grouped = useMemo(() => {
          const map = new Map()
          for (const item of items) {
            if (kindFilter !== 'all' && item.kind !== kindFilter) continue
            if (speakerFilter !== 'all' && !(item.speakers || []).includes(speakerFilter)) continue
            if (onlyFav && !item.favorite) continue
            if (sourceFilter !== 'all' && (item.sourceName || '未标注来源') !== sourceFilter) continue
            const key = item.sourceName || '未标注来源'
            const bucket = map.get(key) || []
            bucket.push(item)
            map.set(key, bucket)
          }
          return [...map.entries()]
            .map(([name, list]) => ({ name, list: list.sort((a, b) => String(b.publishedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.createdAt || ''))) }))
            .sort((a, b) => String((b.list[0] || {}).publishedAt || '').localeCompare(String((a.list[0] || {}).publishedAt || '')))
        }, [items, kindFilter, speakerFilter, onlyFav, sourceFilter])

        const toggleSection = useCallback((name) => {
          setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }))
        }, [])

        const filtered = useMemo(() => {
          const q = query.trim().toLowerCase()
          return items.filter((item) => {
            if (sourceFilter !== 'all' && (item.sourceName || '未标注来源') !== sourceFilter) return false
            if (onlyFav && !item.favorite) return false
            if (kindFilter !== 'all' && item.kind !== kindFilter) return false
            if (speakerFilter !== 'all' && !(item.speakers || []).includes(speakerFilter)) return false
            if (!q) return true
            return String(item.title || '').toLowerCase().includes(q) || String(item.sourceName || '').toLowerCase().includes(q)
          })
        }, [items, query, kindFilter, speakerFilter, onlyFav, sourceFilter])

        useEffect(() => {
          if (view === 'items') return
          void (async () => {
            if (view === 'people' && !people.length) {
              const data = await api('/people')
              setPeople((data && data.people) || [])
            }
            if (view === 'topics' && !topics.length) {
              const data = await api('/topics')
              setTopics((data && data.topics) || [])
            }
            if (view === 'sources' && !clusters) {
              const data = await api('/clusters')
              setClusters(data || null)
            }
          })()
        }, [view, people.length, topics.length])

        const cost = listCost

        const needTranslation =
          detail && detail.meta ? !(detail.translation && detail.translation.segments && detail.translation.segments.some(Boolean)) : false

        return h(
          'div',
          { className: 'ar-root' },
          h(
            'aside',
            { className: 'ar-list' },
            h(
              'div',
              { className: 'ar-list-head' },
              h('h1', { className: 'ar-title' }, 'AI 访谈档案'),
              h('p', {
                className: 'ar-sub',
                title: `${stats.total || 0} 条 · 转写完成 ${stats.asrDone || 0} · 已翻译 ${stats.translateDone || 0}${cost ? ` · 本月 ¥${cost.spent || 0}/${cost.budget || 300}` : ''}`,
              }, `${stats.total || 0} 条 · 转写 ${stats.asrDone || 0} · 翻译 ${stats.translateDone || 0}${cost ? ` · 本月 ¥${cost.spent || 0}/${cost.budget || 300}` : ''}`),
              h('input', {
                className: 'ar-search',
                placeholder: '搜索标题或正文', 'aria-label': '搜索标题或正文',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              h(
                'div',
                { className: 'ar-chips nowrap ar-views' },
                h('button', { className: 'ar-chip' + (view === 'items' ? ' on' : ''), onClick: () => setView('items') }, '条目'),
                h('button', { className: 'ar-chip' + (view === 'people' ? ' on' : ''), onClick: () => setView('people') }, '人物'),
                h('button', { className: 'ar-chip' + (view === 'topics' ? ' on' : ''), onClick: () => setView('topics') }, '主题'),
                h('button', { className: 'ar-chip' + (view === 'sources' ? ' on' : ''), onClick: () => setView('sources') }, '来源'),
              ),
              view === 'items'
                ? h(
                    'div',
                    { className: 'ar-chips nowrap' },
                    h(
                      'button',
                      { className: 'ar-chip' + (kindFilter === 'all' ? ' on' : ''), onClick: () => { setKindFilter('all'); setSpeakerFilter('all') } },
                      '全部',
                    ),
                    h(
                      'button',
                      {
                        className: 'ar-chip' + (onlyFav ? ' on' : ''),
                        onClick: () => setOnlyFav((value) => !value),
                      },
                      '收藏',
                    ),
                    KINDS.map((kind) =>
                      h(
                        'button',
                        {
                          key: kind.id,
                          className: 'ar-chip' + (kindFilter === kind.id ? ' on' : ''),
                          onClick: () => { setKindFilter(kind.id); setSpeakerFilter('all') },
                        },
                        kind.label,
                      ),
                    ),
                  )
                : null,
              view === 'items' && speakers.length
                ? h(
                    'div',
                    {
                      className: 'ar-chips nowrap ar-people',
                      ref: peopleRowRef,
                      tabIndex: 0,
                      role: 'group',
                      'aria-label': '按人物筛选',
                      onKeyDown: (e) => {
                        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                        e.preventDefault()
                        e.currentTarget.scrollLeft += e.key === 'ArrowRight' ? 140 : -140
                      },
                    },
                    h('button', { className: 'ar-chip' + (speakerFilter === 'all' ? ' on' : ''), onClick: () => setSpeakerFilter('all') }, '所有人物'),
                    speakers.map((name) =>
                      h('button', { key: name, className: 'ar-chip' + (speakerFilter === name ? ' on' : ''), title: name, onClick: () => setSpeakerFilter(name) }, name),
                    ),
                  )
                : null,
              autoInfo
                ? h('div', {
                    className: 'ar-auto',
                    title: autoInfo.enabled
                      ? `每 ${autoInfo.everyMinutes} 分钟自动检查 · 下次 ${String(autoInfo.nextRunAt || '').slice(11, 16)} · 今日 ¥${autoInfo.spentToday || 0}/${autoInfo.dailyBudget || 30}`
                      : '定时任务已关闭',
                  }, autoInfo.enabled
                    ? `自动 ${autoInfo.everyMinutes} 分钟 · 下次 ${String(autoInfo.nextRunAt || '').slice(11, 16)} · 今日 ¥${autoInfo.spentToday || 0}/${autoInfo.dailyBudget || 30}`
                    : '定时任务已关闭')
                : null,
              h(
                'div',
                { className: 'ar-actions' },
                h('button', { className: 'ar-btn sm', disabled: syncing, onClick: onSync }, syncing ? '同步中…' : '同步来源'),
                autoInfo ? h('button', { className: 'ar-btn sm', disabled: autoBusy, onClick: onAutoRun }, autoBusy ? '运行中…' : '立即跑一次') : null,
              ),
              syncNote ? h('div', { className: 'ar-hint', style: { marginTop: 6 } }, syncNote) : null,
              candidates.length
                ? h(
                    'div',
                    { className: 'ar-cands' },
                    candidates.slice(0, 6).map((candidate) =>
                      h(
                        'div',
                        { key: candidate.mediaUrl, className: 'ar-cand' },
                        h('span', { title: candidate.title }, `${candidate.sourceName || ''} · ${candidate.title || ''}`),
                        h('button', { onClick: () => onIngestCandidate(candidate) }, '收录'),
                        h('button', { style: { color: 'var(--dsw-alias-label-secondary)' }, onClick: () => onIgnore(candidate) }, '忽略'),
                      ),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ar-items' },
              view === 'people'
                ? people.map((person) =>
                    h(
                      'div',
                      { key: person.name, className: 'ar-hit', onClick: () => { setView('items'); setKindFilter('all'); setSpeakerFilter(person.name) } },
                      h('div', { className: 'ar-hit-title' }, `${person.name} · ${person.count} 期`),
                      h('div', { className: 'ar-hit-seg' }, (person.items || []).slice(0, 2).map((it) => it.title).join(' / ').slice(0, 70)),
                    ),
                  )
                : view === 'sources'
                ? [
                    h('div', { key: 'types', className: 'ar-group-title' }, `类型 · ${clusters ? clusters.configuredSources : 0} 个配置源`),
                    ...((clusters && clusters.byType) || []).map((group) =>
                      h('div', { key: group.type, className: 'ar-hit' }, h('div', { className: 'ar-hit-title' }, `${group.type} · ${group.items} 条 / ${group.minutes} 分钟`), h('div', { className: 'ar-hit-seg' }, `${group.configured} 个源`)),
                    ),
                    h('div', { key: 'bysrc', className: 'ar-group-title' }, '节目'),
                    ...((clusters && clusters.bySource) || []).map((source) =>
                      h(
                        'div',
                        { key: source.name, className: 'ar-hit', onClick: () => { setView('items'); setSourceFilter(source.name) } },
                        h('div', { className: 'ar-hit-title' }, `${source.name} · ${source.count} 条`),
                        h('div', { className: 'ar-hit-seg' }, `${source.minutes} 分钟 · ¥${source.costCny} · 最近 ${String(source.latest || '').slice(0, 10)}`),
                      ),
                    ),
                  ]
                : view === 'topics'
                ? topics.map((topic) =>
                    h(
                      'div',
                      { key: topic.term, className: 'ar-hit', onClick: () => { setView('items'); setQuery(topic.term) } },
                      h('div', { className: 'ar-hit-title' }, `${topic.term} · ${topic.count}`),
                    ),
                  )
                : searchHits.length
                ? searchHits.slice(0, 12).map((hit) =>
                    h(
                      'div',
                      { key: hit.id, className: 'ar-hit' },
                      h('div', { className: 'ar-hit-title', onClick: () => openAt(hit.id, hit.matched[0] && hit.matched[0].startMs) }, hit.title || '未命名'),
                      (hit.matched || []).slice(0, 3).map((seg) =>
                        h(
                          'div',
                          { key: seg.i, className: 'ar-hit-seg', onClick: () => openAt(hit.id, seg.startMs) },
                          `${fmtClock(seg.startMs)}  ${String(seg.text || seg.zh || '').slice(0, 46)}`,
                        ),
                      ),
                    ),
                  )
                : filtered.length
                ? grouped.map((section) =>
                    h(
                      'div',
                      { key: section.name, className: 'ar-section' },
                      h(
                        'div',
                        { className: 'ar-section-head', role: 'button', tabIndex: 0, onKeyDown: activateWithKeyboard, 'aria-expanded': !collapsed[section.name], onClick: () => toggleSection(section.name) },
                        h('span', { className: 'ar-section-caret' }, collapsed[section.name] ? '▶' : '▼'),
                        h('span', { className: 'ar-section-name' }, section.name),
                        h('span', { className: 'ar-section-count' }, `${section.list.length} 期`),
                      ),
                      collapsed[section.name]
                        ? null
                        : h(
                            'div',
                            { className: 'ar-section-body' },
                            section.list.map((item) => h(ListItem, { key: item.id, item, active: item.id === activeId, onSelect: setActiveId, onDelete, onToggleFav, onRetry })),
                          ),
                    ),
                  )
                : h('p', { className: 'ar-hint', style: { padding: '12px 10px' } }, searching ? '检索中…' : query ? '正文里也没有命中' : '还没有内容'),
            ),
            jobs.filter((job) => job.stage !== 'done' && job.stage !== 'failed').length
              ? h(
                  'div',
                  { className: 'ar-jobs' },
                  h('div', null, `后台任务 · ${jobs[0].stage} ${jobs[0].progress}%`),
                  h('div', { className: 'ar-bar' }, h('span', { style: { width: `${Math.min(100, jobs[0].progress || 0)}%` } })),
                )
              : null,
          ),
          h(
            'main',
            { className: 'ar-main' },
            h(
              'div',
              { className: 'ar-scroll', 'data-seg': '' },
              detail
                ? h(Reader, { detail, onTranslate, onSeek, audioRef, needTranslation, onKb, onDelete, onSummarize, onRename })
                : h(EmptyState, { onIngest, busy: ingestBusy, error }),
            ),
          ),
        )
      }

      function ResponsiveRoot() {
        return h('div', { className: 'ar-frame' }, h(Root));
      }

      function PanelIcon() {
        return h(
          'svg',
          { width: 18, height: 18, viewBox: '0 0 32 32', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
          h('rect', { x: 3, y: 6, width: 26, height: 20, rx: 5.5, stroke: 'currentColor', strokeWidth: 1.8, opacity: 0.55 }),
          h('path', {
            d: 'M8 20.5V15M11.5 22.5V11M15 20V13.5M18.5 23V9.5M22 20V14M25.5 18.5V16',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
          }),
        )
      }

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ai-records: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, ResponsiveRoot))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 26, label: 'AI 访谈档案' },
            PanelIcon,
          ),
        )
      }

      return { name: PANEL_ID, inject: ['slots', 'locale'], apply }
    },
  })
} else {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[dsh-ai-records] __ModuleLoader__ 不可用，client.js 未加载')
  }
}
