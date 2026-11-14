/**
 * dsh-ai-intel —— AI 情报台（客户端半侧）
 *
 * 分类按「信号的性质」而不是系统内部产线：
 *   热点趋势 / 社媒讨论 / 大事件 / 公司事件 / AI 创业公司库
 * 设计依据：Apple HIG 原则的 Web 迁移（内容优先、层级靠留白、单一主操作、
 * 状态可见、语义颜色、尊重 Reduce Motion）。字号与间距是本项目取值，
 * 颜色全部走宿主 --dsw-alias-* 语义变量。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-intel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const PANEL_ID = 'ai-intel';
    const NS = 'dsh-ai-intel';
    const ORIGIN = '/dsh-ai-intel';

    // ------------------------------------------------------------------
    // 文案
    // ------------------------------------------------------------------
    const zh = {
      panel: { label: 'AI 情报台', title: '情报台' },
      action: {
        run: '采集一次',
        running: '采集中…',
        refresh: '刷新',
        search: '搜索',
        back: '返回',
        expand: '展开全部',
        more: '显示更多',
        collapse: '收起',
        retry: '重试',
        clear: '清空',
        fill: '补一次',
        filling: '搜索中…',
        runs: '记录',
        read: 'AI 阅读',
        openingReader: '打开中…',
      },
      tab: { wechat: '公众号', companies: '大公司', repos: '官方开源仓库', trends: '热点趋势', social: '社媒讨论', major: '大事件', company: '公司事件', startups: '创业公司库' },
      channel: {
        official: '官方发布',
        officialDesc: '公司自己的博客、新闻、定价页 —— 一手信号',
        papers: '研究论文',
        papersDesc: '和这家公司/模型相关的新论文，含官方技术报告',
        media: '媒体文章',
        mediaDesc: '别人怎么报道它',
        social: '社交媒体讨论',
        socialDesc: '工程师和圈内人在讨论什么',
      },
      section: {
        t1: '大公司',
        t1desc: '平台与实验室的节奏、定价、组织变化',
        t2: '明星公司',
        t2desc: '产品和商业化的节奏',
        t3: '创业与生态',
        t3desc: '名单增量、开源与资本',
        other: '其他',
        otherdesc: '研究、媒体与未归类',
      },
      event: {
        pageChange: '页面变化',
        release: '发布',
        funding: '融资',
        acquisition: '收购',
        ipo: '上市',
        shutdown: '关停',
        regulation: '监管',
        talent: '人事',
        pricing: '定价',
        partnership: '合作',
        news: '动态',
      },
      empty: {
        companies: '还没有这 14 家公司的条目。先跑一轮采集。',
        repos: '近 30 天没有采集到官方开源仓库动态。',
        trends: '还没有足够的数据算趋势。先跑一轮采集。',
        social: '还没有社媒条目。点「采集一次」，更新已配置的社区讨论来源。',
        major: '近 14 天没有识别出大事件。',
        company: '近 14 天没有公司事件。',
        startups: '创业公司库里还没有挂上条目。',
        search: '没有找到匹配的条目，换个词试试。',
        runs: '还没有运行记录。',
      },
      hint: {
        companies: '14 家重点公司 × 四个渠道：官方 / 论文 / 媒体 / 社媒。论文按模型名检索，含官方技术报告和他方分析。点公司名只看它。',
        repos: '近 30 天采集的官方开源仓库动态。点击条目打开 GitHub 仓库。',
        trends: '近 7 天被提到最多的实体；Δ 是与上一个 7 天相比的变化（冷启动阶段上一周为 0）。',
        social: '技术圈的第一轮反应，通常比媒体报道早几天。',
        major: '发布 / 融资 / 收购 / 上市 / 关停 / 监管：会改变竞争格局的事。',
        startups: '按赛道分的创业公司名单，条目会挂到公司上。',
        search: '搜索全部基础库：标题、来源、实体、链接',
      },
      state: {
        originalPending: '原文待补',
        sourcePage: '来源页',
        collected: '采集',
        loading: '加载中…',
        never: '还没跑过，点「采集一次」',
        lastRun: '上次采集',
        added: '本轮新增',
        sources: '源可用',
        network: '连不上宿主接口',
        webOff: '搜索服务不可用，采集仍然可用',
        items: '条',
        found: '找到',
        silent: '7 天无记录',
        all: '全部',
      },
    };

    const en = {
      panel: { label: 'AI Intel', title: 'Intel' },
      action: {
        run: 'Collect now',
        running: 'Collecting…',
        refresh: 'Refresh',
        search: 'Search',
        back: 'Back',
        expand: 'Show all',
        collapse: 'Collapse',
        retry: 'Retry',
        more: 'Show more',
        clear: 'Clear',
        fill: 'Fill in',
        filling: 'Searching…',
        runs: 'Runs',
        read: 'AI reader',
        openingReader: 'Opening…',
      },
      tab: { companies: 'Big tech', repos: 'Official repos', trends: 'Trends', social: 'Social', major: 'Big events', company: 'Companies', startups: 'Startups' },
      channel: {
        official: 'Official',
        officialDesc: 'Their own blog, news and pricing pages',
        papers: 'Papers',
        papersDesc: 'New papers about this company or its models, official tech reports included',
        media: 'Media',
        mediaDesc: 'How others cover them',
        social: 'Social',
        socialDesc: 'What engineers discuss',
      },
      section: {
        t1: 'Big tech',
        t1desc: 'Platform and lab cadence, pricing, org',
        t2: 'Star companies',
        t2desc: 'Product and monetization cadence',
        t3: 'Startups',
        t3desc: 'Roster growth, open source, capital',
        other: 'Other',
        otherdesc: 'Research, media, unclassified',
      },
      event: {
        pageChange: 'Page change',
        release: 'Release',
        funding: 'Funding',
        acquisition: 'Acquisition',
        ipo: 'IPO',
        shutdown: 'Shutdown',
        regulation: 'Regulation',
        talent: 'Talent',
        pricing: 'Pricing',
        partnership: 'Partnership',
        news: 'News',
      },
      empty: {
        companies: 'No items for these 14 companies yet. Run a collection.',
        repos: 'No official open source repository activity collected in the last 30 days.',
        trends: 'Not enough data for trends yet. Run a collection.',
        social: 'No social items yet. Hit “Collect now” to update the configured community feeds.',
        major: 'No major events in the last 14 days.',
        company: 'No company events in the last 14 days.',
        startups: 'No items mapped to startups yet.',
        search: 'No matches. Try another word.',
        runs: 'No runs yet.',
      },
      hint: {
        companies: '14 key companies × four channels: official / papers / media / social. Click a company to focus.',
        repos: 'Official open source repository activity collected in the last 30 days. Select an item to open it on GitHub.',
        trends: 'Most-mentioned entities in 7 days; Δ vs the previous 7 days (zero on a cold start).',
        social: 'The first engineering reaction, usually days before the press.',
        major: 'Release / funding / acquisition / IPO / shutdown / regulation: things that change the board.',
        startups: 'Startup roster by category; collected items attach to each company.',
        search: 'Search the whole library: title, source, entity, URL',
      },
      state: {
        originalPending: 'Article link pending',
        sourcePage: 'Source page',
        collected: 'Collected',
        loading: 'Loading…',
        never: 'Never run — hit “Collect now”',
        lastRun: 'Last run',
        added: 'New',
        sources: 'Sources up',
        network: 'Cannot reach the host API',
        webOff: 'Search is unavailable; collection still works',
        items: 'items',
        found: 'Found',
        silent: 'no record in 7d',
        all: 'All',
      },
    };

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------
    async function api(path, options) {
      const opts = options || {};
      const init = { method: opts.method || 'GET', signal: opts.signal };
      if (opts.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(opts.body);
      }
      let response;
      try {
        response = await fetch(ORIGIN + path, init);
      } catch (error) {
        throw new Error('NETWORK');
      }
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        throw new Error('响应不是合法 JSON');
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      return data;
    }

    function fmtTime(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
      } catch (error) {
        return date.toISOString().slice(11, 16);
      }
    }

    function fmtDay(value, full = false) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(full ? 0 : 5);
      try {
        return date
          .toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
          .replace(/\//g, '-');
      } catch (error) {
        return date.toISOString().slice(full ? 0 : 5, 16).replace('T', ' ');
      }
    }

    function hostOf(url) {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch (error) {
        return '';
      }
    }

    // ------------------------------------------------------------------
    // 图标
    // ------------------------------------------------------------------
    function Icon(props) {
      const name = props.name;
      const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true };
      if (name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
          h('path', { d: 'M13 2.6V5h-2.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        );
      }
      if (name === 'search') {
        return h(
          'svg',
          common,
          h('circle', { cx: 7, cy: 7, r: 4.4, stroke: 'currentColor', strokeWidth: 1.5 }),
          h('path', { d: 'M10.4 10.4 13.5 13.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        );
      }
      if (name === 'plus') {
        return h('svg', common, h('path', { d: 'M8 3.2v9.6M3.2 8h9.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));
      }
      if (name === 'back') {
        return h('svg', common, h('path', { d: 'M9.5 3.5 5 8l4.5 4.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
      }
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: props.up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    // ------------------------------------------------------------------
    // 样式
    // ------------------------------------------------------------------
    const CSS = [
      ':where(.ig-root){--ig-r-card:12px;--ig-r-ctl:9px;--ig-pad:24px;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}',
      '.ig-root *,.ig-root *::before,.ig-root *::after{box-sizing:border-box}',
      '.ig-header{flex:0 0 auto;display:flex;align-items:flex-end;gap:16px;padding:18px var(--ig-pad) 12px}',
      '.ig-headtext{min-width:0;flex:1 1 auto}',
      '.ig-title{margin:0;font-size:20px;line-height:1.2;font-weight:600;letter-spacing:-.022em}',
      '.ig-sub{margin:5px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ig-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.ig-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 13px;border-radius:var(--ig-r-ctl);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .16s ease,border-color .16s ease,opacity .16s ease,transform .06s ease}',
      '.ig-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-layer-1))}',
      '.ig-btn:active:not(:disabled){transform:scale(.985)}',
      '.ig-btn:disabled{opacity:.5;cursor:default}',
      '.ig-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.ig-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600;padding:0 16px}',
      '.ig-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}',
      '.ig-btn-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 10px}',
      '.ig-btn-quiet:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}',
      '.ig-btn-sm{min-height:32px;padding:0 10px;font-size:12.5px;border-radius:7px}',
      '.ig-seg{flex:0 0 auto;display:flex;align-self:flex-start;gap:2px;margin:0 var(--ig-pad);padding:3px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);overflow-x:auto;max-width:calc(100% - 2 * var(--ig-pad))}',
      '.ig-seg-item{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;padding:4px 11px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .16s ease,color .16s ease,box-shadow .16s ease}',
      '.ig-seg-item:hover{color:var(--dsw-alias-label-primary)}',
      '.ig-seg-item[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.06)}',
      '.ig-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.ig-body{flex:1 1 auto;min-height:0;overflow:auto;padding:18px var(--ig-pad) 48px}',
      '.ig-sect{margin:0 0 24px}',
      '.ig-sect-head{display:flex;align-items:baseline;gap:8px;margin:0 2px 6px}',
      '.ig-sect-title{margin:0;font-size:16px;font-weight:600}',
      '.ig-sect-count{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ig-sect-desc{margin:0 0 8px 2px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.ig-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--ig-r-card);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.ig-row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;position:relative}',
      '.ig-row+.ig-row{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.ig-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.ig-row-main{display:block;min-width:0;flex:1 1 auto;text-decoration:none;color:inherit}',
      '.ig-reader-btn{flex:0 0 auto;align-self:center}',
      '.ig-row-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:6px}',
      '.ig-title-line{margin:0;font-size:14px;line-height:1.5;font-weight:400;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      'a.ig-row-main:hover .ig-title-line{color:var(--dsw-alias-brand-primary)}',
      '.ig-source-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}',
      '.ig-source-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.ig-translation{display:block;margin-top:2px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.ig-meta{display:flex;align-items:center;gap:7px;margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.ig-dot-sep{width:2px;height:2px;border-radius:50%;background:currentColor;opacity:.55;flex:0 0 auto}',
      '.ig-tag{flex:0 0 auto;font-size:10.5px;line-height:1.7;padding:0 6px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.ig-tag[data-tone="hot"]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.ig-tag[data-tone="social"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent)}',
      '.ig-tag[data-tone="rise"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
      '.ig-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
      '.ig-search{display:flex;align-items:center;gap:8px;width:100%;max-width:460px;min-height:32px;padding:0 11px;margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--ig-r-ctl);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.ig-search:focus-within{border-color:var(--dsw-static-deepseek-500,#4176e6);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-static-deepseek-500,#4176e6) 18%,transparent)}',
      '.ig-search input{appearance:none;border:0;outline:0;background:transparent;flex:1 1 auto;min-width:0;padding:6px 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ig-search input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}',
      '.ig-search-clear{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:5px}',
      '.ig-search-clear:hover{color:var(--dsw-alias-label-primary)}',
      '.ig-count{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ig-hint{margin:0 0 14px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.ig-heat{display:flex;align-items:baseline;gap:10px;padding:10px 14px}',
      '.ig-heat+.ig-heat{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.ig-heat:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}',
      '.ig-rank{width:18px;flex:0 0 auto;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);text-align:right}',
      '.ig-heat-main{flex:1 1 auto;min-width:0}',
      '.ig-heat-name{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600}',
      '.ig-heat-num{flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums}',
      '.ig-heat-count{font-size:15px;font-weight:600;letter-spacing:-.01em}',
      '.ig-heat-delta{font-size:11.5px;color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}',
      '.ig-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}',
      '.ig-chip{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease}',
      '.ig-chip:hover{color:var(--dsw-alias-label-primary)}',
      '.ig-chip[data-active="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:600}',
      '.ig-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.ig-company{display:flex;align-items:flex-start;gap:12px;width:100%}',
      '.ig-company-name{font-size:13.5px;font-weight:600}',
      '.ig-company-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ig-company-latest{min-width:0;flex:1 1 auto;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.ig-company-latest a{color:inherit;text-decoration:none}',
      '.ig-company-latest a:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.ig-run-row{display:flex;align-items:center;gap:12px;width:100%}',
      '.ig-run-time{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;min-width:96px}',
      '.ig-run-facts{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.ig-run-facts b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}',
      '.ig-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:52px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}',
      '.ig-empty svg{opacity:.45}',
      '.ig-banner{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:9px 12px;border-radius:10px;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 11%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent)}',
      '.ig-banner[data-tone="info"]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.ig-banner[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent)}',
      '.ig-banner-text{flex:1 1 auto;min-width:0}',
      '.ig-skel{height:11px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);margin:9px 0}',
      '.ig-spin{width:13px;height:13px;border-radius:50%;border:1.6px solid rgba(255,255,255,.45);border-top-color:#fff;display:inline-block;animation:ig-spin .75s linear infinite}',
      '.ig-spin[data-tone="plain"]{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 25%,transparent);border-top-color:var(--dsw-alias-label-primary)}',
      '@keyframes ig-spin{to{transform:rotate(360deg)}}',
      '@media (max-width:820px){:where(.ig-root){--ig-pad:16px}.ig-header{padding-top:18px;flex-wrap:wrap;align-items:flex-start}.ig-actions{margin-left:auto}.ig-run-row{flex-direction:column;align-items:flex-start;gap:4px}.ig-run-time{min-width:0}.ig-company{flex-direction:column;gap:2px}}',
      '/* Apple HIG principles for this desktop web panel; dimensions are project choices. */',
      '.ig-frame{height:100%;min-height:0;min-width:0;container-type:inline-size;container-name:igpanel}',
      '.ig-root{min-width:0}.ig-header{align-items:center}.ig-sub{line-height:1.5}',
      '.ig-seg{width:max-content;min-width:0;max-width:calc(100% - var(--ig-pad) * 2);align-self:flex-start;overflow-x:auto;scrollbar-width:thin;overscroll-behavior-inline:contain}',
      '.ig-seg-item{min-height:34px;flex:0 0 auto;font-size:13px}.ig-sect-head{margin-bottom:8px}.ig-sect-desc{font-size:12.5px;line-height:1.6}',
      '.ig-root :where(button,a,input):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.ig-btn-quiet:has(svg):not(:has(span)){min-width:34px}',
      '/* A search field owns one rounded focus ring; keep standalone fields and buttons keyboard-visible. */',
      '.ig-root .ig-search input:focus,.ig-root .ig-search input:focus-visible{outline:0;outline-offset:0;box-shadow:none}',
      '.ig-meta,.ig-run-facts{line-height:1.6}.ig-row-main{overflow-wrap:anywhere}.ig-title-line{font-size:14px;line-height:1.65}.ig-search{min-height:36px}',
      '@container igpanel (max-width:660px){.ig-header{flex-wrap:wrap;padding:16px 16px 12px}.ig-headtext{flex-basis:100%}.ig-sub{white-space:normal;overflow:visible}.ig-actions{width:100%;justify-content:flex-end;flex-wrap:wrap}.ig-root{--ig-pad:16px}.ig-body{padding-top:16px}.ig-row{padding:13px 14px}.ig-company{flex-direction:column;gap:4px}.ig-run-row{flex-direction:column;align-items:flex-start;gap:6px}}',
      '@media (pointer:coarse){.ig-btn,.ig-seg-item,.ig-chip{min-height:44px}}',
      '@media (prefers-reduced-motion:reduce){.ig-root *,.ig-root *::before,.ig-root *::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}',
      '@media (prefers-contrast:more){.ig-card,.ig-btn,.ig-search,.ig-chip{border-color:var(--dsw-alias-border-l2)}}',
      '.ig-wx{min-width:0}.ig-wx-top{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;margin-bottom:16px}.ig-wx-top h2{font-size:19px}.ig-wx-muted{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;margin:4px 0;overflow-wrap:anywhere}.ig-wx-tools,.ig-wx-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.ig-wx-tools{flex-shrink:0}.ig-wx-schedule{display:flex;align-items:center;gap:10px 18px;flex-wrap:wrap;padding:12px 0 18px;font-size:12.5px}.ig-wx-schedule label,.ig-wx-unread{display:flex;align-items:center;gap:5px}.ig-wx input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px}.ig-wx-manage{padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;margin-bottom:20px;background:var(--dsw-alias-bg-layer-1)}.ig-wx-section-title{font-size:14px;font-weight:600;margin:0 0 6px}.ig-wx-add{display:grid;grid-template-columns:minmax(140px,1fr) minmax(180px,1fr) auto;gap:12px;align-items:end;margin:14px 0}.ig-wx-field{display:flex;flex-direction:column;min-width:0;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}.ig-wx-field-wide{grid-column:1/-1}.ig-wx-field input,.ig-wx-field select,.ig-wx-schedule select{min-width:0;max-width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-base);font:inherit;color:var(--dsw-alias-label-primary)}.ig-wx-subscription{display:flex;align-items:center;gap:14px;padding:12px 14px}.ig-wx-subscription+.ig-wx-subscription{border-top:1px solid var(--dsw-alias-border-l1)}.ig-wx-sub-main{flex:1;min-width:0}.ig-wx-sub-main strong{font-size:13px}.ig-wx-sub-error,.ig-wx-row-error{margin:4px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;overflow-wrap:anywhere}.ig-wx-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 14px}.ig-wx-search{margin:0;flex:1;min-width:160px;max-width:none}.ig-wx-unread{font-size:12px;white-space:nowrap}.ig-wx-article{padding:16px}.ig-wx-article+.ig-wx-article{border-top:1px solid var(--dsw-alias-border-l1)}.ig-wx-title{appearance:none;border:0;background:none;text-align:left;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;font-weight:600;line-height:1.65;padding:0;cursor:pointer;overflow-wrap:anywhere}.ig-wx-title:hover{color:var(--dsw-alias-brand-primary)}.ig-wx-article[data-read=true] .ig-wx-title{font-weight:400}.ig-wx-row-actions{margin-top:12px}.ig-wx-row-actions button:disabled{opacity:.75}.ig-wx-article-main{min-width:0}',
      '@container igpanel (max-width:660px){.ig-wx-top{flex-direction:column;gap:10px}.ig-wx-add{grid-template-columns:minmax(0,1fr)}.ig-wx-field-wide{grid-column:auto}.ig-wx-add button{justify-self:start}.ig-wx-manage{padding:13px}.ig-wx-filters{align-items:stretch}.ig-wx-search{flex-basis:100%}.ig-wx-filters>.ig-wx-field{flex:1}.ig-wx-row-actions{gap:6px}.ig-wx-top .ig-wx-tools{width:100%}}',
      '.ig-wx-provider{padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:16px}.ig-wx-provider-head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}.ig-wx-provider-head>div{min-width:0}.ig-wx-provider-head>button{flex-shrink:0}.ig-wx-pending{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}.ig-wx-pending summary{font-size:13px;font-weight:600;cursor:pointer}.ig-wx-pending ul{padding-left:20px;margin:8px 0 14px}.ig-wx-pending li{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:6px 0}.ig-wx-pending-action{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}.ig-wx-auth{display:flex;align-items:center;gap:18px;margin-top:14px}.ig-wx-qr{width:176px;height:176px;object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-base);flex-shrink:0}',
      '@container igpanel (max-width:660px){.ig-wx-provider-head{flex-direction:column;gap:8px}.ig-wx-auth{align-items:flex-start;flex-direction:column}}',
      '.ig-wx-history{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}.ig-wx-history summary{cursor:pointer}.ig-wx-history p{margin:5px 0;overflow-wrap:anywhere}',
      '.ig-btn.ig-wx-delete{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 78%,var(--dsw-alias-label-primary))}',
    ].join('');

    function StyleOnce() {
      return h('style', { 'data-ig-style': '1' }, CSS);
    }
    function Spinner(props) {
      return h('span', { className: 'ig-spin', 'data-tone': props && props.plain ? 'plain' : 'solid', 'aria-hidden': 'true' });
    }
    function Banner(props) {
      return h(
        'div',
        { className: 'ig-banner', 'data-tone': props.tone || 'error', role: props.tone === 'error' ? 'alert' : 'status', 'aria-live': props.tone === 'error' ? 'assertive' : 'polite' },
        h('span', { className: 'ig-banner-text' }, props.text),
        props.onRetry ? h('button', { className: 'ig-btn ig-btn-sm', onClick: props.onRetry }, props.retryLabel || '重试') : null,
      );
    }
    function Empty(props) {
      return h(
        'div',
        { className: 'ig-empty' },
        h(
          'svg',
          { width: 30, height: 30, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.2 }),
          h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor' }),
          h('path', { d: 'M12 12l5-4.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        ),
        h('div', null, props.text),
        props.action ? h('button', { className: 'ig-btn ig-btn-sm', onClick: props.action }, props.actionLabel) : null,
      );
    }
    function Skeleton(props) {
      return h(
        'div',
        { 'aria-busy': 'true', 'aria-label': props.label },
        h('div', { className: 'ig-skel', style: { width: '38%' } }),
        h('div', { className: 'ig-skel', style: { width: '82%' } }),
        h('div', { className: 'ig-skel', style: { width: '66%' } }),
      );
    }

    // ------------------------------------------------------------------
    // 条目行
    // ------------------------------------------------------------------
    function ItemRow(props) {
      const { item, t, sourceNames, onRead, opening } = props;
      const isPaper = item.channel === 'papers' || item.kind === 'paper';
      const unresolved = item.linkKind === 'unresolved';
      const label = unresolved ? t('state.originalPending') : isPaper ? (item.official ? '官方论文' : '相关论文') : t('event.' + (item.eventType || 'news'));
      const tone = isPaper ? (item.official ? 'hot' : '') : item.section === 'social' ? 'social' : '';
      const sourceLabel = sourceNames[item.source] || item.source || hostOf(item.url);
      const displayTitle = item.title || item.titleZh;
      const when = item.published || item.ts;
      return h(
        'div',
        { className: 'ig-row' },
        h(
          unresolved ? 'div' : 'a',
          { className: 'ig-row-main', ...(!unresolved && item.url ? { href: item.url, target: '_blank', rel: 'noreferrer noopener' } : {}), title: item.title },
          h('p', { className: 'ig-title-line' }, displayTitle),
          item.title && item.titleZh && item.titleZh !== item.title ? h('span', { className: 'ig-translation', lang: 'zh-CN' }, item.titleZh) : null,
          h(
            'span',
            { className: 'ig-meta' },
            label ? h('span', { className: 'ig-tag', 'data-tone': tone }, label) : null,
            sourceLabel ? h('span', null, sourceLabel) : null,
            h('span', { className: 'ig-dot-sep', 'aria-hidden': 'true' }),
            h('span', { title: when || '' }, `${item.published ? '' : t('state.collected') + ' '}${fmtDay(when)}`),
            unresolved && item.sourceUrl
              ? h('a', { className: 'ig-source-link', href: item.sourceUrl, target: '_blank', rel: 'noreferrer noopener', 'aria-label': `${sourceLabel} ${t('state.sourcePage')}` }, t('state.sourcePage'))
              : null,
            item.startupName ? [h('span', { key: 's', className: 'ig-dot-sep', 'aria-hidden': 'true' }), h('span', { key: 'n' }, item.startupName)] : null,
            !item.startupName && item.entityNames && item.entityNames.length
              ? [h('span', { key: 'e', className: 'ig-dot-sep', 'aria-hidden': 'true' }), h('span', { key: 'en' }, item.entityNames[0])]
              : null,
          ),
        ),
        !unresolved && /^https?:\/\//i.test(item.url || '') && typeof onRead === 'function'
          ? h('button', {
              type: 'button', className: 'ig-btn ig-btn-quiet ig-btn-sm ig-reader-btn',
              onClick: () => onRead(item), disabled: Boolean(opening),
              'aria-label': `${t('action.read')} · ${displayTitle}`,
              'aria-busy': opening === item.id ? 'true' : undefined,
            }, opening === item.id ? t('action.openingReader') : t('action.read'))
          : null,
      );
    }

    function GroupedSection(props) {
      const { title, desc, count, items, expanded, onToggle, renderItem, t } = props;
      const list = expanded ? items.slice(0, 40) : items.slice(0, 6);
      const hidden = items.length - list.length;
      return h(
        'section',
        { className: 'ig-sect', 'aria-label': title },
        h('div', { className: 'ig-sect-head' }, h('h2', { className: 'ig-sect-title' }, title), h('span', { className: 'ig-sect-count' }, String(count))),
        desc ? h('p', { className: 'ig-sect-desc' }, desc) : null,
        h('div', { className: 'ig-card' }, list.map(renderItem)),
        hidden > 0 || expanded
          ? h(
              'div',
              { style: { marginTop: '8px', marginLeft: '2px', display: 'flex', alignItems: 'center', gap: '10px' } },
              h(
                'button',
                { className: 'ig-btn ig-btn-quiet ig-btn-sm', onClick: onToggle, 'aria-expanded': expanded ? 'true' : 'false' },
                h(Icon, { name: 'chevron', up: expanded }),
                expanded ? t('action.collapse') : `${t('action.expand')} ${items.length}`,
              ),
              expanded && hidden > 0
                ? h('span', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary)' } }, `还有 ${hidden} 条`)
                : null,
            )
          : null,
      );
    }

    // URL identity matches the knowledge base: keep article-identifying query parameters.
    function wechatUrlKey(raw) {
      try {
        const url = new URL(raw); url.hash = '';
        for (const key of Array.from(url.searchParams.keys())) if (/^utm_/i.test(key)) url.searchParams.delete(key);
        if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
        if (url.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/[^/]+)?$/.test(url.pathname)) {
          for (const key of Array.from(url.searchParams.keys())) if (['scene', 'subscene', 'from', 'isappinstalled', 'clicktime', 'enterid'].includes(key.toLowerCase())) url.searchParams.delete(key);
          url.searchParams.sort();
        }
        return url.href;
      } catch { return ''; }
    }
    function isWechatArticle(raw) {
      try { const url = new URL(raw); return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname.toLowerCase().replace(/\.$/, '') === 'mp.weixin.qq.com' && /^\/s(?:\/[^/]+)?\/?$/.test(url.pathname); } catch { return false; }
    }
    async function wechatJson(url, options = {}) {
      const controller = new AbortController();
      let timedOut = false;
      const aborted = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeout || 20000);
      try {
        const response = await fetch(url, { method: options.method || 'GET', signal: controller.signal,
          ...(options.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }) });
        const data = await response.json();
        if (!response.ok || data.ok === false) {
          const error = new Error(data.error?.message || `请求失败（${response.status}）`);
          error.code = data.error?.code || ''; throw error;
        }
        return data;
      } catch (error) {
        if (timedOut) {
          const failure = new Error(options.timeoutMessage || '请求超时，请稍后重试。');
          failure.code = 'REQUEST_TIMEOUT';
          throw failure;
        }
        throw error;
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); }
    }
    const wechatUi = { accountId: '', unread: true, query: '', kb: {}, lastTab: 'companies', checkRequest: null };
    const wechatKbListeners = new Set();
    const wechatKbTasks = new Map();
    function publishWechatKb(key, state) {
      wechatUi.kb = { ...wechatUi.kb, [key]: state };
      for (const listener of wechatKbListeners) listener(wechatUi.kb);
    }
    function waitWechatJob(signal) {
      return new Promise((resolve, reject) => {
        const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 1200);
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('任务状态检查已暂停，知识库会继续处理')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    async function loadWechatCachedContent(article, signal) {
      if (article.hasContent !== true) return null;
      let cached;
      try { cached = await wechatJson(ORIGIN + '/wechat/article?id=' + encodeURIComponent(article.id), { signal }); }
      catch (error) { if (error.code === 'NO_CACHED_CONTENT') return null; throw error; }
      if (cached.article?.url && wechatUrlKey(cached.article.url) !== wechatUrlKey(article.url)) throw new Error('缓存文章与原文链接不一致，请刷新列表后重试');
      const content = cached.content;
      if (!content || !['rss', 'publisher'].includes(content.kind) || typeof content.html !== 'string' || !content.html.trim()) throw new Error('缓存正文不可用，请刷新后重试');
      return content;
    }
    function wechatContentRequest(article, content) {
      const request = { url: article.url, title: article.title || '', html: content.html, publishedAt: content.publishedAt || article.publishedAt || '',
        feedUrl: content.feedUrl || '', accountName: content.accountName || article.accountName || '', contentSource: content.kind === 'publisher' ? 'publisher' : 'rss' };
      if (content.kind === 'publisher') Object.assign(request, { sourceLabel: '官网同步正文', contentUrl: content.contentUrl || '' });
      return request;
    }
    function startWechatKbIngest(article) {
      const key = wechatUrlKey(article.url);
      if (!key || !isWechatArticle(article.url)) return Promise.reject(new Error('这条记录没有有效的公众号原文链接'));
      if (wechatKbTasks.has(key)) return wechatKbTasks.get(key).promise;
      if (wechatUi.kb[key]?.status === 'exists') return Promise.resolve();
      const controller = new AbortController();
      const previous = wechatUi.kb[key];
      publishWechatKb(key, { status: 'running', jobId: previous?.jobId || '', error: '' });
      const promise = Promise.resolve().then(async () => {
        let jobId = previous?.jobId || '';
        try {
          if (!jobId) {
            try {
              const tree = await wechatJson('/dsh-kb/tree', { signal: controller.signal });
              if ((tree.sources || []).some(source => source && source.status !== 'failed' && source.url && wechatUrlKey(source.url) === key)) {
                publishWechatKb(key, { status: 'exists', error: '', jobId: '' }); return;
              }
            } catch (error) { if (controller.signal.aborted) throw error; /* The ingest endpoint also enforces identity. */ }
            const content = await loadWechatCachedContent(article, controller.signal);
            let data;
            if (content) {
              const extracted = await wechatJson('/dsh-ai-reader/article-content', { method: 'POST', body: wechatContentRequest(article, content), signal: controller.signal, timeout: 70000 });
              const text = extracted.article?.text;
              if (typeof text !== 'string' || !text.trim() || !Array.isArray(extracted.article.blocks) || !extracted.article.blocks.length) throw new Error('缓存未提取到可用正文，未存入知识库');
              if (extracted.article.url && wechatUrlKey(extracted.article.url) !== key) throw new Error('提取正文的原文链接不一致，未存入知识库');
              data = await wechatJson('/dsh-kb/ingest-text', { method: 'POST', body: { text, title: extracted.article.title || article.title || '', url: article.url }, signal: controller.signal, timeout: 70000 });
            } else {
              data = await wechatJson('/dsh-kb/ingest-url', { method: 'POST', body: { url: article.url, title: article.title || '' }, signal: controller.signal, timeout: 70000 });
            }
            jobId = data.jobId || data.job?.id || '';
            if (!jobId) {
              if (data.existed || data.source?.status === 'ready') { publishWechatKb(key, { status: 'exists', error: '', jobId: '' }); return; }
              throw new Error('知识库没有返回存入任务，请刷新后确认状态');
            }
            publishWechatKb(key, { status: 'running', error: '', jobId });
          }
          const deadline = Date.now() + 180000;
          while (!controller.signal.aborted) {
            if (Date.now() > deadline) throw new Error('存入仍在后台处理，可继续查看进度');
            await waitWechatJob(controller.signal);
            const data = await wechatJson('/dsh-kb/job?id=' + encodeURIComponent(jobId), { signal: controller.signal });
            if (data.job?.status === 'done') { publishWechatKb(key, { status: 'exists', error: '', jobId: '' }); return; }
            if (data.job?.status === 'failed') {
              jobId = '';
              throw new Error(typeof data.job.error === 'string' ? data.job.error : '知识库存入失败，请重试');
            }
          }
        } catch (error) {
          publishWechatKb(key, { status: jobId ? 'waiting' : 'failed', jobId, error: error.message || '存入失败，请重试' });
        } finally { wechatKbTasks.delete(key); }
      });
      wechatKbTasks.set(key, { promise, controller });
      return promise;
    }
    function stopWechatKbTasks() { for (const task of wechatKbTasks.values()) task.controller.abort(); }

    function wechatRunKey(run) {
      if (!run || typeof run !== 'object') return '';
      return JSON.stringify([run.startedAt || '', run.finishedAt || '', run.checked, run.added, run.errors || []]);
    }
    function wechatSource(subscription) {
      try {
        const url = new URL(subscription.feedUrl);
        const backend = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
        return { origin: url.origin, backend, label: backend ? '公众号后台' : (subscription.sourceKind === 'publisher' ? '官网同步 · ' : '公开 RSS · ') + url.hostname };
      } catch { return { origin: '', backend: false, label: '未连接来源' }; }
    }
    function wechatSourceCooling(snapshot, subscription) {
      if (!(Date.parse(snapshot?.retryAt || '') > Date.now())) return false;
      const source = wechatSource(subscription);
      if (snapshot?.retryOrigin) {
        try { return source.origin === new URL(snapshot.retryOrigin).origin; } catch { /* Legacy state only limited the backend. */ }
      }
      return source.backend;
    }
    function wechatAllSourcesCooling(snapshot, subscriptions) {
      const active = subscriptions.filter(subscription => subscription.enabled !== false && subscription.feedUrl);
      return active.length > 0 && active.every(subscription => wechatSourceCooling(snapshot, subscription));
    }
    function wechatCooldownNotice(snapshot, hasAvailableSources = false) {
      const service = !snapshot?.retryOrigin || wechatSource({ feedUrl: snapshot.retryOrigin }).backend ? '微信' : '订阅服务';
      return service + '限制了文章列表接口，实际恢复时间由' + service + '决定。最早可在 ' + fmtDay(snapshot?.retryAt) + ' 再次检查受限来源。' + (hasAvailableSources ? '其他来源仍可检查。' : '冷却期间不会继续请求受限来源。');
    }
    function wechatCheckFeedback(run, subscriptions) {
      const active = subscriptions.filter(subscription => subscription.enabled !== false && subscription.feedUrl);
      const pending = subscriptions.filter(subscription => subscription.enabled !== false && !subscription.feedUrl);
      const errors = Array.isArray(run.errors) ? run.errors : [];
      const checked = Number.isFinite(run.checked) ? run.checked : active.length;
      const added = Number.isFinite(run.added) ? run.added : 0;
      const skipped = Number.isFinite(run.skipped) ? run.skipped : Array.isArray(run.skipped) ? run.skipped.length : 0;
      if (run.blocked) return { error: '', tone: 'info', notice: '本次未执行检查：' + wechatCooldownNotice(run) };
      if (errors.length) {
        const details = errors.slice(0, 2).map(item => {
          const subscription = subscriptions.find(row => row.id === item.subscriptionId);
          return (subscription?.name ? subscription.name + '：' : '') + (item.message || '检查失败');
        }).join('；');
        return { error: '本次检查 ' + checked + ' 个公众号，' + Math.max(0, checked - errors.length) + ' 个成功、' + errors.length + ' 个失败。' + (details ? ' ' + details : ''),
          tone: 'info', notice: '本次新增 ' + added + ' 篇文章；失败账号的新文状态尚未确认。' };
      }
      if (!checked) return { error: '', tone: 'info', notice: pending.length ? '未执行检查：' + pending.length + ' 个指定账号仍待授权或完成添加。' : '未执行检查：当前没有启用且已连接的公众号。' };
      return { error: '', tone: 'ok', notice: '已成功检查 ' + checked + ' 个公众号，新增 ' + added + ' 篇文章。' + (skipped ? '另有 ' + skipped + ' 个来源受限，未执行检查。' : '') + (pending.length ? '另有 ' + pending.length + ' 个账号仍待授权或完成添加。' : '') };
    }
    function WechatPanel(props) {
      const [snapshot, setSnapshot] = useState(null);
      const [articles, setArticles] = useState([]);
      const [total, setTotal] = useState(0);
      const [accountId, setAccountId] = useState(wechatUi.accountId);
      const [unread, setUnread] = useState(wechatUi.unread);
      const [query, setQuery] = useState(wechatUi.query);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [noticeTone, setNoticeTone] = useState('ok');
      const [kb, setKb] = useState(wechatUi.kb);
      const [kbChecking, setKbChecking] = useState(true);
      const [manage, setManage] = useState(false);
      const [sourceInput, setSourceInput] = useState('');
      const [sourceName, setSourceName] = useState('');
      const [sourceMode, setSourceMode] = useState('from-now');
      const [resolved, setResolved] = useState(null);
      const [provider, setProvider] = useState(null);
      const [authorizing, setAuthorizing] = useState(false);
      const [qrReady, setQrReady] = useState(false);
      const [qrExpired, setQrExpired] = useState(false);
      const qrWasReady = useRef(false);
      const [qrNonce, setQrNonce] = useState(0);
      const [importRunning, setImportRunning] = useState(false);
      const [checkRunning, setCheckRunning] = useState(Boolean(wechatUi.checkRequest));
      const [openingArticle, setOpeningArticle] = useState('');
      const [deleteConfirm, setDeleteConfirm] = useState('');
      const deleteTrigger = useRef(null);
      const manageButton = useRef(null);
      const openRequest = useRef(null);
      const checkRequest = useRef(wechatUi.checkRequest);
      const importObservedRunning = useRef(false);
      const alive = useRef(true);
      const sequence = useRef(0);
      const actionLock = useRef(false);
      const readLocks = useRef(new Set());
      const loadController = useRef(null);
      const subscriptions = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : [];
      const activeSubscriptions = subscriptions.filter(subscription => subscription.enabled !== false && typeof subscription.feedUrl === 'string' && subscription.feedUrl.trim());
      const unconfiguredSubscriptions = subscriptions.filter(subscription => subscription.enabled !== false && !subscription.feedUrl);
      const retryUntil = Date.parse(snapshot?.retryAt || '');
      const coolingDown = Number.isFinite(retryUntil) && retryUntil > Date.now();
      const availableSubscriptions = activeSubscriptions.filter(subscription => !wechatSourceCooling(snapshot, subscription));
      const allSourcesCooling = wechatAllSourcesCooling(snapshot, activeSubscriptions);
      const visibleSubscriptions = accountId ? subscriptions.filter(subscription => subscription.id === accountId) : subscriptions;
      const storedArticles = Number.isFinite(snapshot?.counts?.articles) ? snapshot.counts.articles : subscriptions.reduce((sum, subscription) => sum + (subscription.articleCount || 0), 0);
      const neverCollected = storedArticles === 0 && visibleSubscriptions.length > 0 && !visibleSubscriptions.some(subscription => subscription.lastSuccessAt);
      const load = useCallback(async (initial = false) => {
        const seq = ++sequence.current;
        loadController.current?.abort();
        const controller = new AbortController(); loadController.current = controller;
        if (initial) setLoading(true);
        const suffix = new URLSearchParams({ limit: '200', ...(accountId ? { accountId } : {}), ...(unread ? { unread: 'true' } : {}), ...(query.trim() ? { q: query.trim() } : {}) });
        try {
          const [status, feed, connection] = await Promise.all([wechatJson(ORIGIN + '/wechat/status', { signal: controller.signal }), wechatJson(ORIGIN + '/wechat/articles?' + suffix, { signal: controller.signal }), wechatJson(ORIGIN + '/wechat/provider', { signal: controller.signal }).catch(() => null)]);
          if (!alive.current || seq !== sequence.current) return;
          setSnapshot(status); setProvider(connection); setArticles(feed.items || []); setTotal(feed.total || 0); setLoading(false);
          const checking = checkRequest.current;
          if (checking?.accepted) {
            if (status.running) checking.sawRunning = true;
            else {
              const failure = typeof status.checkError === 'string' ? status.checkError : status.checkError?.message;
              if (failure) {
                checkRequest.current = null; wechatUi.checkRequest = null; setCheckRunning(false);
                setError(failure); setNoticeTone('info'); setNotice('本次检查遇到错误，请查看提示后重试。');
              } else if (status.lastRun && wechatRunKey(status.lastRun) !== checking.previousRun) {
                checkRequest.current = null; wechatUi.checkRequest = null; setCheckRunning(false);
                const result = wechatCheckFeedback(status.lastRun, Array.isArray(status.subscriptions) ? status.subscriptions : []);
                setError(result.error); setNoticeTone(result.tone); setNotice(result.notice);
              } else if (wechatAllSourcesCooling(status, Array.isArray(status.subscriptions) ? status.subscriptions : [])) {
                checkRequest.current = null; wechatUi.checkRequest = null; setCheckRunning(false);
                setNoticeTone('info'); setNotice('本次未执行检查：' + wechatCooldownNotice(status));
              } else if (checking.sawRunning) {
                checkRequest.current = null; wechatUi.checkRequest = null; setCheckRunning(false);
                setError('检查任务已结束，但未收到新的检查结果，请刷新后确认。');
                setNoticeTone('info'); setNotice('本次检查结果尚未确认，未将上次结果当作本次结果。');
              }
            }
          }

          if (connection?.import) {
            const progress = connection.import;
            setImportRunning(Boolean(progress.running));
            if (progress.running) importObservedRunning.current = true;
            else if (importObservedRunning.current) {
              importObservedRunning.current = false;
              setNotice((progress.failed ? '指定账号部分添加完成：新增 ' : '指定账号添加完成：新增 ') + (progress.added || 0) + ' 个，已订阅 ' + (progress.existing || 0) + ' 个' + (progress.failed ? '，' + progress.failed + ' 个未成功，可重试' : ''));
              setNoticeTone(progress.failed ? 'info' : 'ok');
              if (progress.failed) setError(progress.error || '有 ' + progress.failed + ' 个账号未添加成功，请查看下方待添加清单后重试。');
              else if (progress.error) setError(progress.error);
            }
          }
          setKbChecking(true);
          try {
            const tree = await wechatJson('/dsh-kb/tree', { signal: controller.signal });
            if (!alive.current || seq !== sequence.current) return;
            const urls = new Set((tree.sources || []).filter(source => source && source.status !== 'failed' && source.url).map(source => wechatUrlKey(source.url)));
            for (const article of feed.items || []) {
              const key = wechatUrlKey(article.url);
              if (urls.has(key)) publishWechatKb(key, { status: 'exists', error: '', jobId: '' });
              else if (!wechatKbTasks.has(key) && wechatUi.kb[key]?.status === 'exists') publishWechatKb(key, { status: 'idle', error: '', jobId: '' });
            }
          } catch (err) { /* A click can retry the lookup; the backend remains idempotent. */ }
          finally { if (alive.current && seq === sequence.current) setKbChecking(false); }
        } catch (err) {
          if (alive.current && seq === sequence.current && !controller.signal.aborted) setError(err.message || '公众号列表读取失败');
        } finally { if (alive.current && seq === sequence.current) setLoading(false); }
      }, [accountId, unread, query]);
      useEffect(() => {
        alive.current = true; wechatKbListeners.add(setKb);
        return () => { alive.current = false; sequence.current++; loadController.current?.abort(); openRequest.current?.controller.abort(); wechatKbListeners.delete(setKb); };
      }, []);
      useEffect(() => {
        wechatUi.accountId = accountId; wechatUi.unread = unread; wechatUi.query = query;
        const timer = setTimeout(() => { void load(true); }, query.trim() ? 250 : 0);
        return () => clearTimeout(timer);
      }, [load, accountId, unread, query]);
      useEffect(() => { if (props.refreshToken) void load(); }, [props.refreshToken, load]);
      useEffect(() => {
        const timer = setInterval(() => { if (!actionLock.current) void load(); }, 30000);
        return () => clearInterval(timer);
      }, [load]);
      useEffect(() => {
        if (!authorizing) return undefined;
        const controller = new AbortController();
        let pending = false;
        async function checkAuth() {
          if (pending) return; pending = true;
          try {
            const state = await wechatJson(ORIGIN + '/wechat/provider/auth', { signal: controller.signal });
            if (!alive.current || controller.signal.aborted) return;
            const ready = Boolean(state.qrReady);
            setQrReady(ready);
            if (ready) {
              if (!qrWasReady.current) setQrNonce(Date.now());
              qrWasReady.current = true; setQrExpired(false);
            } else if (qrWasReady.current && !state.authorized) {
              setQrExpired(true); setNotice('');
            }
            if (state.authorized) {
              setProvider(previous => ({ ...previous, authorized: true, requiresAuth: false }));
              setAuthorizing(false); setQrExpired(false); qrWasReady.current = false; setError(''); setNoticeTone('ok'); setNotice('公众号后台登录已确认，可以添加指定账号；文章是否可采集仍需检查。');
              void load();
            }
          } catch (err) { if (alive.current && !controller.signal.aborted) setError(err.message || '授权状态检查失败，可重试'); }
          finally { pending = false; }
        }
        void checkAuth();
        const timer = setInterval(checkAuth, 3000);
        return () => { controller.abort(); clearInterval(timer); };
      }, [authorizing, load]);
      async function beginAuthorization() {
        await act('auth', async () => {
          qrWasReady.current = false; setQrExpired(false); setQrReady(false); setAuthorizing(true); setQrNonce(Date.now());
          const result = await wechatJson(ORIGIN + '/wechat/provider/auth', { method: 'POST', body: {}, timeout: 70000 });
          if (!alive.current) return;
          if (result.authorized) { setAuthorizing(false); setProvider(previous => ({ ...previous, authorized: true, requiresAuth: false })); setNotice('公众号后台登录已确认，可以添加指定账号；文章是否可采集仍需检查。'); }
          else { qrWasReady.current = Boolean(result.qrReady); setAuthorizing(true); setQrReady(Boolean(result.qrReady)); setQrNonce(Date.now()); setNoticeTone('info'); setNotice(result.message || '请使用有公众号后台管理权限的微信扫码，并在手机上确认授权。'); }
        });
      }
      async function importPending() {
        if (importRunning || provider?.import?.running) return;
        await act('import', async () => {
          const result = await wechatJson(ORIGIN + '/wechat/provider/import', { method: 'POST', body: { mode: sourceMode }, timeout: 30000 });
          if (!alive.current) return;
          if (result.running) {
            importObservedRunning.current = true; setImportRunning(true);
            setNotice('正在逐个添加指定账号，完成后自动刷新列表。重复账号会跳过。');
          } else {
            setNotice((result.failed ? '指定账号部分添加完成：新增 ' : '已添加 ') + (result.added || 0) + ' 个账号' + (result.existing ? '，已订阅 ' + result.existing + ' 个不重复添加' : '') + (result.failed ? '，' + result.failed + ' 个未成功，可重试' : ''));
            setNoticeTone(result.failed ? 'info' : 'ok');
            if (result.failed) setError('有 ' + result.failed + ' 个账号未添加成功，请查看待添加清单后重试。');
          }
        });
      }
      useEffect(() => {
        if (!importRunning) return undefined;
        const timer = setInterval(() => { if (!actionLock.current) void load(); }, 3000);
        return () => clearInterval(timer);
      }, [importRunning, load]);
      useEffect(() => {
        if (!checkRunning && !snapshot?.running) return undefined;
        const timer = setInterval(() => { if (!actionLock.current) void load(); }, 3000);
        return () => clearInterval(timer);
      }, [checkRunning, snapshot?.running, load]);
      async function act(name, work, refresh = true) {
        if (actionLock.current) return;
        actionLock.current = true; setBusy(name); setError(''); setNotice(''); setNoticeTone('ok');
        try { await work(); if (alive.current && refresh) await load(); }
        catch (err) { if (alive.current) setError(err.message || '操作失败，请重试'); }
        finally { actionLock.current = false; if (alive.current) setBusy(''); }
      }
      async function checkUpdates() {
        if (allSourcesCooling) { setNoticeTone('info'); setNotice(wechatCooldownNotice(snapshot)); return; }
        if (checkRequest.current || snapshot?.running) return;
        await act('check', async () => {
          const request = { previousRun: wechatRunKey(snapshot?.lastRun), accepted: false, sawRunning: false };
          checkRequest.current = request; wechatUi.checkRequest = request; setCheckRunning(true);
          let result;
          try { result = await wechatJson(ORIGIN + '/wechat/check', { method: 'POST', body: { background: true } }); }
          catch (error) {
            if (checkRequest.current === request) { checkRequest.current = null; wechatUi.checkRequest = null; }
            if (alive.current) setCheckRunning(false);
            throw error;
          }
          if (result.running === true) {
            request.accepted = true;
            if (alive.current) { setNoticeTone('info'); setNotice('正在后台检查公众号更新，完成后会自动刷新。'); }
          } else {
            checkRequest.current = null; wechatUi.checkRequest = null;
            if (!alive.current) return;
            setCheckRunning(false);
            const feedback = wechatCheckFeedback(result.run || result, subscriptions);
            setError(feedback.error); setNoticeTone(feedback.tone); setNotice(feedback.notice);
          }
        });
      }
      async function markRead(article, value) {
        if (readLocks.current.has(article.id)) return;
        readLocks.current.add(article.id);
        try {
          await wechatJson(ORIGIN + '/wechat/read', { method: 'POST', body: { id: article.id, read: value } });
          if (alive.current) {
            setArticles(current => current.map(row => row.id === article.id ? { ...row, read: value } : row).filter(row => !unread || !row.read));
          }
        } catch (err) { if (alive.current) setError(err.message); }
        finally { readLocks.current.delete(article.id); }
      }
      async function openArticle(article) {
        if (openRequest.current) return;
        const request = { controller: new AbortController(), id: article.id };
        openRequest.current = request; setOpeningArticle(article.id); setError('');
        try {
          if (!isWechatArticle(article.url) || typeof props.openReader !== 'function') throw new Error('阅读助手未启用，暂时无法打开这篇文章');
          const content = await loadWechatCachedContent(article, request.controller.signal);
          if (!alive.current || request.controller.signal.aborted) return;
          await props.openReader(article, content);
          void markRead(article, true);
        } catch (err) { if (alive.current) setError(err.message || '无法打开阅读助手'); }
        finally { if (openRequest.current === request) openRequest.current = null; if (alive.current) setOpeningArticle(''); }
      }
      async function addSubscription(event) {
        event.preventDefault();
        const value = sourceInput.trim();
        if (!value) { setError('请粘贴公众号文章链接或账号 RSS 地址'); return; }
        await act('add', async () => {
          let account = resolved;
          if (isWechatArticle(value) && !account) {
            const result = await wechatJson(ORIGIN + '/wechat/resolve', {
              method: 'POST', body: { url: value }, timeout: 180000,
              timeoutMessage: '识别公众号超时，文章链接已保留，请重试或换一篇该账号的文章。',
            });
            if (result.requiresAuth) throw new Error('请先连接并授权公众号采集服务，文章链接已保留');
            account = result.account;
            if (!account?.feedUrl) throw new Error('尚未取得这个账号的订阅地址，请先完成采集服务授权');
            if (alive.current) { setResolved(account); if (!sourceName) setSourceName(account.name || ''); }
          }
          const body = { name: sourceName.trim() || account?.name || '', feedUrl: account?.feedUrl || value, mode: sourceMode,
            ...(account?.id ? { accountId: account.id } : {}), ...(account?.seedUrl ? { seedUrl: account.seedUrl } : {}) };
          if (!body.name) throw new Error('请填写公众号名称');
          await wechatJson(ORIGIN + '/wechat/subscriptions', { method: 'POST', body });
          if (alive.current) { setSourceInput(''); setSourceName(''); setResolved(null); setNotice(sourceMode === 'from-now' ? '已添加订阅，首次检查只建立基线，之后的新文才会进入列表' : sourceMode === 'history' ? '已添加订阅，将按原日期收录信源现有的历史文章' : '已添加订阅，将收录近期文章'); }
        });
      }
      async function deleteSubscription(subscription) {
        await act('delete:' + subscription.id, async () => {
          await wechatJson(ORIGIN + '/wechat/subscriptions?id=' + encodeURIComponent(subscription.id), { method: 'DELETE' });
          if (!alive.current) return;
          setDeleteConfirm('');
          setNoticeTone('ok'); setNotice('已删除「' + subscription.name + '」订阅，已采集文章和知识库内容保留');
          if (accountId === subscription.id) setAccountId('');
          manageButton.current?.focus({ preventScroll: true });
        }, accountId !== subscription.id);
      }
      function articleRow(article) {
        const key = wechatUrlKey(article.url);
        const state = kb[key] || {};
        const label = kbChecking && state.status !== 'exists' ? '检查知识库…' : state.status === 'exists' ? '已在知识库' : state.status === 'running' ? '存入中…' : state.status === 'waiting' ? '查看存入进度' : state.status === 'failed' ? '重试存入' : '存入知识库';
        return h('article', { key: article.id, className: 'ig-wx-article', 'data-read': article.read ? 'true' : 'false' },
          h('div', { className: 'ig-wx-article-main' },
            h('button', { type: 'button', className: 'ig-wx-title', disabled: Boolean(openingArticle), onClick: () => { void openArticle(article); }, 'aria-label': '阅读助手打开：' + article.title }, article.title),
            h('div', { className: 'ig-meta' }, !article.read ? h('span', { className: 'ig-tag', 'data-tone': 'hot' }, '未读') : null,
              h('span', null, article.accountName || '公众号'), h('span', null, article.publishedAt ? fmtDay(article.publishedAt, article.collectionReason === 'history-backfill') : '发布时间待确认'),
              article.hasContent === true ? h('span', { title: '阅读和存入知识库优先使用已取得的' + (article.contentSource === 'publisher' ? '官网同步' : ' RSS ') + '正文，公众号原文链接保留' }, article.contentSource === 'publisher' ? '官网同步正文' : 'RSS 正文') : null,
              article.collectionReason === 'initial-backfill' ? h('span', { title: '首次收录的近期文章，不表示公众号后台接口已经恢复' }, '首次回填') : article.collectionReason === 'history-backfill' ? h('span', { title: '按来源提供的原始日期收录的历史文章，不代表近期更新' }, '历史收录') : null)),
          h('div', { className: 'ig-wx-row-actions' },
            h('button', { type: 'button', className: 'ig-btn ig-btn-sm', disabled: Boolean(openingArticle), onClick: () => { void openArticle(article); }, 'aria-label': '阅读助手打开：' + article.title }, openingArticle === article.id ? '正在打开…' : '阅读助手打开'),
            h('button', { type: 'button', className: 'ig-btn ig-btn-sm', disabled: kbChecking || state.status === 'exists' || state.status === 'running',
              onClick: () => { void startWechatKbIngest(article).catch(err => { if (alive.current) setError(err.message); }); }, 'aria-label': label + '：' + article.title, title: state.error || label }, state.status === 'running' ? h(Spinner, { plain: true }) : null, label),
            h('button', { type: 'button', className: 'ig-btn ig-btn-quiet ig-btn-sm', onClick: () => { void markRead(article, !article.read); }, 'aria-label': (article.read ? '标记未读：' : '标记已读：') + article.title }, article.read ? '标记未读' : '标记已读')),
          state.error ? h('p', { className: 'ig-wx-row-error', role: 'status' }, state.error) : null);
      }
      const pendingAccounts = Array.isArray(provider?.pending) ? provider.pending : [];
      const activePendingAccounts = pendingAccounts.filter(item => item.enabled !== false && item.status !== 'paused' && item.status !== 'added' && item.status !== 'existing');
      const providerCard = h('section', { className: 'ig-wx-provider', 'aria-label': '公众号采集服务' },
        h('div', { className: 'ig-wx-provider-head' },
          h('div', null, h('h3', { className: 'ig-wx-section-title' }, '公众号后台服务'), h('p', { className: 'ig-wx-muted', role: 'status' }, provider?.authorized ? '公众号后台登录已确认；文章是否采集成功，以各来源检查结果为准。' : provider?.reachable ? '后台服务已连接，后台通道需要微信扫码登录；公开 RSS 可独立检查。' : provider?.configured ? '暂时连接不上后台服务；已连接的公开 RSS 仍可独立检查。' : '后台通道尚未连接；已有单账号公开 RSS 可直接添加。')),
          h('button', { type: 'button', className: 'ig-btn', disabled: Boolean(busy) || !provider?.configured, onClick: beginAuthorization }, busy === 'auth' ? '正在准备二维码…' : provider?.authorized ? '检查授权' : '微信扫码授权')),
        authorizing ? h('div', { className: 'ig-wx-auth' },
          qrReady && !qrExpired ? h('img', { className: 'ig-wx-qr', src: ORIGIN + '/wechat/provider/qr-image?v=' + qrNonce, alt: '微信扫码授权二维码', onError: () => { setQrReady(false); setError('二维码尚未准备好，请重试授权'); } }) : qrExpired ? h('div', { role: 'alert' }, h('p', { className: 'ig-wx-sub-error' }, '二维码已过期，请重新获取后扫码。'), h('button', { type: 'button', className: 'ig-btn ig-btn-sm', disabled: Boolean(busy), onClick: beginAuthorization }, '重新获取二维码')) : h('p', { role: 'status' }, '正在准备二维码…'),
          h('div', null, h('p', { className: 'ig-wx-muted' }, '请使用有公众号后台管理权限的微信扫码，在手机端确认后会自动更新状态。'), h('button', { type: 'button', className: 'ig-btn ig-btn-sm', onClick: () => { setAuthorizing(false); setQrReady(false); } }, '收起二维码'))) : null,
        pendingAccounts.length ? h('details', { className: 'ig-wx-pending', open: true }, h('summary', null, '待添加的指定账号 · ' + pendingAccounts.length + ' 条文章链接'),
          h('p', { className: 'ig-wx-muted' }, '只识别并订阅这份名单里的公众号；同一账号的多篇文章只添加一次。'),
          h('ul', null, pendingAccounts.map((item, index) => h('li', { key: item.url || index }, h('span', null, item.name || item.url), item.enabled === false || item.status === 'paused' ? h('span', { className: 'ig-wx-muted' }, ' · 已暂停，不参与批量添加') : item.error ? h('span', { className: 'ig-wx-sub-error' }, ' · ' + item.error) : item.status === 'added' || item.status === 'existing' ? h('span', { className: 'ig-wx-muted' }, ' · 已添加') : null))),
          h('div', { className: 'ig-wx-pending-action' }, importRunning ? h('p', { className: 'ig-wx-muted', role: 'status' }, '逐个添加中 · 已新增 ' + (provider?.import?.added || 0) + ' 个 · 已存在 ' + (provider?.import?.existing || 0) + ' 个' + (provider?.import?.failed ? ' · 待重试 ' + provider.import.failed + ' 个' : '')) : null, h('label', { className: 'ig-wx-field' }, h('span', null, '首次收录范围'), h('select', { value: sourceMode, onChange: event => setSourceMode(event.target.value), disabled: Boolean(busy), 'aria-label': '指定账号首次收录范围' }, h('option', { value: 'from-now' }, '从现在开始，只收新文章'), h('option', { value: 'recent' }, '同时收录近 7 天文章'), h('option', { value: 'history' }, '收录信源现有的历史文章'))),
            h('button', { type: 'button', className: 'ig-btn ig-btn-primary', disabled: Boolean(busy) || importRunning || Boolean(provider?.import?.running) || !provider?.authorized || !activePendingAccounts.length, title: activePendingAccounts.length ? '只添加清单中启用的账号' : '没有待添加的启用账号，暂停账号可在订阅管理中恢复', onClick: importPending }, busy === 'import' || importRunning || provider?.import?.running ? '正在添加指定账号…' : '添加指定账号'))) : null);
      function subscriptionStateLabel(subscription) {
        if (subscription.enabled === false) return '已暂停';
        if (!subscription.feedUrl) return provider?.authorized ? '待完成添加' : '待授权连接';
        if (wechatSourceCooling(snapshot, subscription)) return (subscription.lastSuccessAt ? '' : '待首次检查 · ') + '等待文章列表接口恢复';
        if (subscription.lastError) return '检查失败';
        if (subscription.initialized === false) return '待首次成功检查';
        return subscription.sourceKind === 'publisher' ? '部分稿件同步中' : '监控中';
      }
      const subscriptionList = h('div', { className: 'ig-card ig-wx-subscriptions' }, subscriptions.map(subscription => h('div', { key: subscription.id, className: 'ig-wx-subscription' },
        h('div', { className: 'ig-wx-sub-main' }, h('strong', null, subscription.name),
          h('p', { className: 'ig-wx-muted' }, [wechatSource(subscription).label, subscriptionStateLabel(subscription), subscription.lastCheckedAt ? (subscription.lastSuccessAt ? '最近成功检查 ' : '上次尝试 ') + fmtDay(subscription.lastCheckedAt) : '尚未检查', subscription.articleCount ? subscription.articleCount + ' 篇文章' : ''].filter(Boolean).join(' · ')),
          subscription.lastError ? wechatSourceCooling(snapshot, subscription) ? h('details', { className: 'ig-wx-history' }, h('summary', null, '上次检查详情'), h('p', { className: 'ig-wx-muted' }, subscription.lastError)) : h('p', { className: 'ig-wx-sub-error', role: 'status' }, subscription.lastError) : null,
          subscription.lastWarning ? h('p', { className: 'ig-wx-muted', role: 'status' }, subscription.lastWarning) : null,
          deleteConfirm === subscription.id ? h('p', { className: 'ig-wx-muted', role: 'status' }, '删除这项订阅？将停止检查该账号，已采集文章和知识库内容保留。') : null),
        h('div', { className: 'ig-wx-tools' },
          h('button', { type: 'button', className: 'ig-btn ig-btn-sm', disabled: Boolean(busy), onClick: () => act(subscription.id, () => wechatJson(ORIGIN + '/wechat/subscriptions?id=' + encodeURIComponent(subscription.id), { method: 'PATCH', body: { enabled: subscription.enabled === false } })), 'aria-label': (subscription.enabled === false ? '恢复监控：' : '暂停监控：') + subscription.name }, subscription.enabled === false ? '恢复监控' : '暂停监控'),
          h('button', { type: 'button', className: 'ig-btn ig-btn-sm ig-wx-delete', disabled: Boolean(busy),
            'aria-label': (deleteConfirm === subscription.id ? '确认删除订阅：' : '删除订阅：') + subscription.name,
            onClick: event => { if (deleteConfirm === subscription.id) { void deleteSubscription(subscription); return; } deleteTrigger.current = event?.currentTarget || null; setDeleteConfirm(subscription.id); } }, busy === 'delete:' + subscription.id ? '删除中…' : deleteConfirm === subscription.id ? '确认删除' : '删除'),
          deleteConfirm === subscription.id ? h('button', { type: 'button', className: 'ig-btn ig-btn-sm', disabled: Boolean(busy), onClick: () => { setDeleteConfirm(''); deleteTrigger.current?.focus(); } }, '取消') : null))));
      return h('section', { className: 'ig-wx', 'aria-label': '公众号监控' },
        h('div', { className: 'ig-wx-top' }, h('div', null, h('h2', { className: 'ig-sect-title' }, '公众号'), h('p', { className: 'ig-wx-muted' }, '只监控你添加的账号，新文章不会重复采集或入库。')),
          h('div', { className: 'ig-wx-tools' },
            h('button', { type: 'button', className: 'ig-btn', ref: manageButton, 'aria-expanded': manage, onClick: () => { setManage(value => !value); setDeleteConfirm(''); } }, manage ? '收起订阅管理' : '管理订阅'),
            h('button', { type: 'button', className: 'ig-btn ig-btn-primary', disabled: Boolean(busy) || checkRunning || snapshot?.running || allSourcesCooling || !activeSubscriptions.length, title: allSourcesCooling ? '所有启用来源均处于冷却，恢复时间由来源服务决定' : activeSubscriptions.length ? '只检查已连接且未受限的公众号来源' : '请先添加指定账号或单账号 RSS', onClick: checkUpdates }, checkRunning || snapshot?.running || busy === 'check' ? '检查中…' : '检查更新'))),
        error ? h(Banner, { text: error, tone: 'error', onRetry: () => { setError(''); void load(true); } }) : null,
        notice ? h(Banner, { text: notice, tone: noticeTone }) : null,
        coolingDown ? h(Banner, { text: wechatCooldownNotice(snapshot, availableSubscriptions.length > 0), tone: 'info' }) : null,
        unconfiguredSubscriptions.length ? h(Banner, { text: unconfiguredSubscriptions.length + ' 个指定账号' + (provider?.authorized ? '尚未完成添加。完成添加后才会检查更新。' : '等待扫码授权并完成添加，当前不会检查这些账号。'), tone: 'info' }) : null,
        subscriptions.some(subscription => subscription.sourceKind === 'publisher') ? h('p', { className: 'ig-wx-muted' }, '官网同步只收录带明确公众号原文链接的部分稿件，不能保证覆盖所有公众号更新。') : null,
        h('div', { className: 'ig-wx-schedule' },
          h('label', null, h('input', { type: 'checkbox', checked: Boolean(snapshot?.enabled), disabled: !snapshot || Boolean(busy), onChange: event => act('schedule', () => wechatJson(ORIGIN + '/wechat/settings', { method: 'POST', body: { enabled: event.target.checked } })) }), ' 自动检查'),
          h('label', null, '检查间隔 ', h('select', { 'aria-label': '公众号检查间隔', value: String(snapshot?.intervalMinutes || 120), disabled: !snapshot || Boolean(busy), onChange: event => act('schedule', () => wechatJson(ORIGIN + '/wechat/settings', { method: 'POST', body: { intervalMinutes: Number(event.target.value) } })) }, [30, 60, 120, 240, 360, 720].map(value => h('option', { key: value, value: String(value) }, value < 60 ? value + ' 分钟' : value / 60 + ' 小时')))),
          h('span', { className: 'ig-wx-muted', role: 'status' }, snapshot?.lastRun?.finishedAt ? '上次检查 ' + fmtDay(snapshot.lastRun.finishedAt) : '尚未检查', snapshot?.nextRun ? ' · 下次 ' + fmtDay(snapshot.nextRun) : ''),
          h('span', { className: 'ig-wx-muted' }, 'DSH 运行时自动检查；电脑休眠后等待恢复。')),
        manage || !subscriptions.length || provider?.requiresAuth || importRunning || pendingAccounts.some(item => item.status !== 'added' && item.status !== 'existing') ? providerCard : null,
        manage || !subscriptions.length ? h('div', { className: 'ig-wx-manage' },
          h('h3', { className: 'ig-wx-section-title' }, '指定监控账号'),
          h('p', { className: 'ig-wx-muted' }, '粘贴该公众号任意一篇文章链接。已有单账号 RSS 地址也可以直接添加。'),
          h('form', { className: 'ig-wx-add', onSubmit: addSubscription },
            h('label', { className: 'ig-wx-field ig-wx-field-wide' }, h('span', null, '公众号文章链接 / RSS 地址'), h('input', { type: 'url', required: true, value: sourceInput, onChange: event => { setSourceInput(event.target.value); setResolved(null); }, placeholder: 'https://mp.weixin.qq.com/s/…', disabled: busy === 'add' })),
            h('label', { className: 'ig-wx-field' }, h('span', null, '公众号名称'), h('input', { type: 'text', value: sourceName, onChange: event => setSourceName(event.target.value), placeholder: '识别后自动填写，也可手动填写', disabled: busy === 'add' })),
            h('label', { className: 'ig-wx-field' }, h('span', null, '首次收录范围'), h('select', { value: sourceMode, onChange: event => setSourceMode(event.target.value), disabled: busy === 'add' }, h('option', { value: 'from-now' }, '从现在开始，只收新文章'), h('option', { value: 'recent' }, '同时收录近 7 天文章'), h('option', { value: 'history' }, '收录信源现有的历史文章'))),
            h('button', { type: 'submit', className: 'ig-btn ig-btn-primary', disabled: Boolean(busy) }, busy === 'add' ? '添加中…' : '添加订阅')),
          subscriptions.length ? subscriptionList : h('p', { className: 'ig-wx-muted' }, '还没有订阅账号。添加后才会检查更新，不会扫描其他公众号。')) : null,
        h('div', { className: 'ig-wx-filters' },
          h('label', { className: 'ig-wx-field' }, h('span', { className: 'ig-sr' }, '筛选公众号'), h('select', { value: accountId, 'aria-label': '筛选公众号', onChange: event => setAccountId(event.target.value) }, h('option', { value: '' }, '全部指定账号'), subscriptions.map(subscription => h('option', { key: subscription.id, value: subscription.id }, subscription.name)))),
          h('label', { className: 'ig-search ig-wx-search' }, h(Icon, { name: 'search' }), h('input', { type: 'search', value: query, 'aria-label': '搜索公众号文章', placeholder: '搜索文章标题', onChange: event => setQuery(event.target.value) })),
          h('label', { className: 'ig-wx-unread' }, h('input', { type: 'checkbox', checked: unread, onChange: event => setUnread(event.target.checked) }), ' 只看未读')),
        loading ? h(Skeleton, { label: '正在读取公众号文章' }) : articles.length ? h('div', null, h('p', { className: 'ig-count' }, total + ' 篇文章'), articles.some(article => article.collectionReason === 'initial-backfill') ? h('p', { className: 'ig-wx-muted' }, '标为“首次回填”的是近期文章，不表示公众号后台接口已恢复；各账号的采集来源可在订阅管理中查看。') : null, h('div', { className: 'ig-card' }, articles.map(articleRow)), total > articles.length ? h('p', { className: 'ig-wx-muted' }, '当前显示最新 ' + articles.length + ' 篇，可按账号或标题缩小范围。') : null)
          : h(Empty, { text: !subscriptions.length ? '添加指定公众号，开始接收它的新文章。' : neverCollected ? '尚未成功采集到文章，当前不能确认这些账号有没有更新。请查看各来源的检查状态。' : unread ? '当前筛选下暂无未读文章。可关闭“只看未读”查看已读内容。' : '当前筛选下没有文章。已完成的检查与首次收录范围可在订阅管理中查看。' }));
    }

    // ------------------------------------------------------------------
    // 主面板
    // ------------------------------------------------------------------
    function IntelPanel(rawProps) {
      const t = rawProps && typeof rawProps.t === 'function' ? rawProps.t : (key) => key;

      const [status, setStatus] = useState(null);
      const [tab, setTab] = useState(wechatUi.lastTab || 'companies');
      const [companies, setCompanies] = useState(null);
      const [companySel, setCompanySel] = useState('');
      const [companyFeed, setCompanyFeed] = useState(null);
      const [repos, setRepos] = useState(null);
      const [repoLimit, setRepoLimit] = useState(40);
      const [trends, setTrends] = useState(null);
      const [social, setSocial] = useState(null);
      const [major, setMajor] = useState(null);
      const [company, setCompany] = useState(null);
      const [startups, setStartups] = useState(null);
      const [startupCat, setStartupCat] = useState('');
      const [runs, setRuns] = useState(null);
      const [overlay, setOverlay] = useState('');
      const [query, setQuery] = useState('');
      const [library, setLibrary] = useState(null);
      const [running, setRunning] = useState(false);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const [wechatRefresh, setWechatRefresh] = useState(0);
      const [expanded, setExpanded] = useState({});
      const [readerOpening, setReaderOpening] = useState('');
      const [readerError, setReaderError] = useState(null);
      const readerRequest = useRef(null);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          readerRequest.current?.abort();
        };
      }, []);

      const loadStatus = useCallback(async () => {
        try {
          const data = await api('/status');
          if (!alive.current) return;
          setStatus(data);
          setError('');
        } catch (err) {
          if (!alive.current) return;
          setError(err && err.message === 'NETWORK' ? t('state.network') : String(err && err.message ? err.message : err));
        }
      }, [t]);

      const loadCompanies = useCallback(async () => {
        const data = await api('/companies?days=30');
        if (!alive.current) return;
        setCompanies(data.companies || []);
      }, []);
      const loadCompanyFeed = useCallback(async (companyId) => {
        const suffix = companyId ? `&company=${encodeURIComponent(companyId)}` : '';
        const data = await api('/company-feed?days=30' + suffix);
        if (!alive.current) return;
        setCompanyFeed(data.channels || null);
      }, []);
      const loadRepos = useCallback(async () => {
        const data = await api('/feed?section=repos&days=30&limit=500');
        if (!alive.current) return;
        setRepos(data.items || []);
      }, []);
      const loadTrends = useCallback(async () => {
        const data = await api('/trends?days=7');
        if (!alive.current) return;
        setTrends(data.items || []);
      }, []);
      const loadSocial = useCallback(async () => {
        const data = await api('/feed?section=social&days=30&limit=200');
        if (!alive.current) return;
        setSocial(data.items || []);
      }, []);
      const loadMajor = useCallback(async () => {
        const data = await api('/feed?section=major&days=14&limit=200');
        if (!alive.current) return;
        setMajor(data.items || []);
      }, []);
      const loadCompany = useCallback(async () => {
        const data = await api('/feed?section=company&days=14&limit=200');
        if (!alive.current) return;
        setCompany(data.items || []);
      }, []);
      const loadStartups = useCallback(async (cat) => {
        const data = await api('/startups' + (cat ? `?cat=${encodeURIComponent(cat)}` : ''));
        if (!alive.current) return;
        setStartups(data.categories || []);
      }, []);
      const loadRuns = useCallback(async () => {
        const data = await api('/runs?limit=30');
        if (!alive.current) return;
        setRuns(data.items || []);
      }, []);
      const loadLibrary = useCallback(async (q) => {
        const data = await api('/library?q=' + encodeURIComponent(q || '') + '&limit=200');
        if (!alive.current) return;
        setLibrary(data);
      }, []);

      const guarded = useCallback(async (name, promise) => {
        setBusy(name);
        try {
          await promise;
          if (alive.current) setError('');
        } catch (err) {
          if (!alive.current) return;
          setError(String(err && err.message ? err.message : err));
        } finally {
          if (alive.current) setBusy('');
        }
      }, []);

      useEffect(() => {
        (async () => {
          setLoading(true);
          await Promise.all([
            loadStatus(),
            guarded('companies', loadCompanies()),
            guarded('company-feed', loadCompanyFeed('')),
          ]);
          if (alive.current) setLoading(false);
        })();
      }, [loadStatus, loadCompanies, loadCompanyFeed, guarded]);

      useEffect(() => {
        if (tab === 'repos') guarded('repos', loadRepos());
      }, [tab, guarded, loadRepos]);

      const switchTab = useCallback(
        (key) => {
          wechatUi.lastTab = key;
          setTab(key);
          setOverlay('');
          if (key === 'companies' && companies === null) guarded('companies', loadCompanies());
          if (key === 'companies' && companyFeed === null) guarded('company-feed', loadCompanyFeed(companySel));
          if (key === 'trends' && trends === null) guarded('trends', loadTrends());
          if (key === 'social' && social === null) guarded('social', loadSocial());
          if (key === 'major' && major === null) guarded('major', loadMajor());
          if (key === 'company' && company === null) guarded('company', loadCompany());
          if (key === 'startups' && startups === null) guarded('startups', loadStartups(''));
        },
        [trends, social, major, company, startups, companies, companyFeed, companySel, loadTrends, loadSocial, loadMajor, loadCompany, loadStartups, loadCompanies, loadCompanyFeed, guarded],
      );

      useEffect(() => {
        if (overlay !== 'search') return undefined;
        const value = query.trim();
        if (!value) {
          setLibrary(null);
          return undefined;
        }
        const timer = setTimeout(() => guarded('search', loadLibrary(value)), 300);
        return () => clearTimeout(timer);
      }, [query, overlay, loadLibrary, guarded]);

      const runNow = useCallback(async () => {
        if (running) return;
        setRunning(true);
        setError('');
        setNotice('');
        try {
          const data = await api('/run', { method: 'POST', body: {} });
          if (!alive.current) return;
          const run = data.run || {};
          const added = run.added || {};
          setNotice([`新增 ${added.events || 0} 条采集`, `${added.web || 0} 条搜索补充`].join(' · '));
          setTrends(null);
          setSocial(null);
          setMajor(null);
          setCompany(null);
          setStartups(null);
          setRuns(null);
          setLibrary(null);
          setCompanies(null);
          setCompanyFeed(null);
          await Promise.all([loadStatus(), guarded('companies', loadCompanies()), guarded('company-feed', loadCompanyFeed(companySel))]);
          if (tab === 'repos') await guarded('repos', loadRepos());
          else if (tab !== 'trends') switchTab(tab);
        } catch (err) {
          if (!alive.current) return;
          setError(String(err && err.message ? err.message : err));
        } finally {
          if (alive.current) setRunning(false);
        }
      }, [running, loadStatus, guarded, loadTrends, loadRepos, tab, switchTab]);

      const refreshAll = useCallback(async () => {
        if (tab === 'repos') {
          await Promise.all([loadStatus(), guarded('repos', loadRepos())]);
          return;
        }
        setTrends(null);
        setSocial(null);
        setMajor(null);
        setCompany(null);
        setStartups(null);
        setRuns(null);
        setLibrary(null);
        await Promise.all([loadStatus(), guarded('trends', loadTrends())]);
        switchTab(tab);
      }, [loadStatus, guarded, loadTrends, loadRepos, switchTab, tab]);

      const fillOne = useCallback(
        async (name) => {
          if (!name || busy) return;
          setBusy(name);
          setError('');
          setNotice('');
          try {
            const data = await api('/search', { method: 'POST', body: { query: `${name} 最新动态`, maxResults: 5 } });
            if (!alive.current) return;
            setNotice(`「${name}」补到 ${(data.sources || []).length} 条，入库 ${data.added || 0} 条`);
            await loadStatus();
            if (tab === 'startups') await loadStartups(startupCat);
          } catch (err) {
            if (!alive.current) return;
            setError(String(err && err.message ? err.message : err));
          } finally {
            if (alive.current) setBusy('');
          }
        },
        [busy, loadStatus, tab, startupCat, loadStartups],
      );

      const counts = (status && status.counts) || {};
      const lastRun = (status && status.lastRun) || null;
      const sourceNames = (status && status.sourceNames) || {};
      const addedSum = lastRun && lastRun.added ? (lastRun.added.events || 0) + (lastRun.added.web || 0) : 0;
      const subtitle = useMemo(() => {
        if (!status) return t('state.loading');
        if (!lastRun) return t('state.never');
        return [
          `${t('state.lastRun')} ${fmtDay(lastRun.finishedAt)}`,
          `${t('state.added')} ${addedSum}`,
          `${t('state.sources')} ${counts.sourcesOk || 0}/${counts.sourcesTotal || 0}`,
        ].join(' · ');
      }, [status, lastRun, addedSum, counts, t]);

      const toggle = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
      const readArticle = useCallback(async (item) => {
        if (readerRequest.current) return;
        const controller = new AbortController();
        readerRequest.current = controller;
        setReaderOpening(item.id);
        setReaderError(null);
        try {
          if (typeof rawProps.openReader !== 'function') throw new Error('AI 阅读助手暂不可用，请确认已启用后重试。');
          let content = null;
          if (item.kind === 'wechat') {
            try { content = await loadWechatCachedContent({ ...item, hasContent: true }, controller.signal); }
            catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
          }
          if (!alive.current || controller.signal.aborted) return;
          await rawProps.openReader(item, content);
        } catch (error) {
          if (alive.current && !controller.signal.aborted) setReaderError({ item, message: error.message || '无法打开 AI 阅读助手，请重试。' });
        } finally {
          if (readerRequest.current === controller) readerRequest.current = null;
          if (alive.current) setReaderOpening('');
        }
      }, [rawProps.openReader]);
      const renderItem = useCallback((item) => h(ItemRow, { key: item.id, item, t, sourceNames, onRead: readArticle, opening: readerOpening }), [t, sourceNames, readArticle, readerOpening]);

      function viewCompanies() {
        if (!companies || !companyFeed) return h(Skeleton, { label: t('state.loading') });
        const total = companies.reduce((sum, row) => sum + row.total, 0);
        const channels = [
          { key: 'official', title: t('channel.official'), desc: t('channel.officialDesc'), items: companyFeed.official || [] },
          { key: 'papers', title: t('channel.papers'), desc: t('channel.papersDesc'), items: companyFeed.papers || [] },
          { key: 'media', title: t('channel.media'), desc: t('channel.mediaDesc'), items: companyFeed.media || [] },
          { key: 'social', title: t('channel.social'), desc: t('channel.socialDesc'), items: companyFeed.social || [] },
        ];
        const visible = channels.filter((channel) => channel.items.length > 0);
        return h(
          'div',
          null,
          h('p', { className: 'ig-hint' }, t('hint.companies')),
          h(
            'div',
            { className: 'ig-chips', role: 'group', 'aria-label': t('tab.companies') },
            h(
              'button',
              {
                className: 'ig-chip',
                'data-active': companySel === '' ? 'true' : 'false',
                onClick: () => {
                  setCompanySel('');
                  guarded('company-feed', loadCompanyFeed(''));
                },
              },
              `${t('state.all')} · ${total}`,
            ),
            companies.map((row) =>
              h(
                'button',
                {
                  key: row.id,
                  className: 'ig-chip',
                  'data-active': companySel === row.id ? 'true' : 'false',
                  title: `${row.name} · 官方 ${row.counts.official} / 论文 ${row.counts.papers} / 媒体 ${row.counts.media} / 社媒 ${row.counts.social}`,
                  onClick: () => {
                    const next = companySel === row.id ? '' : row.id;
                    setCompanySel(next);
                    guarded('company-feed', loadCompanyFeed(next));
                  },
                },
                `${row.name} · ${row.total}`,
              ),
            ),
          ),
          visible.length
            ? visible.map((channel) =>
                h(GroupedSection, {
                  key: channel.key,
                  title: channel.title,
                  desc: channel.desc,
                  count: channel.items.length,
                  items: channel.items,
                  expanded: Boolean(expanded['ch-' + channel.key]),
                  onToggle: () => toggle('ch-' + channel.key),
                  renderItem,
                  t,
                }),
              )
            : h(Empty, { text: t('empty.companies'), action: runNow, actionLabel: t('action.run') }),
        );
      }

      function viewRepos() {
        if (repos === null) return h(Skeleton, { label: t('state.loading') });
        if (!repos.length) return h(Empty, { text: t('empty.repos') });
        return h(
          'div',
          null,
          h('p', { className: 'ig-hint' }, t('hint.repos')),
          h('div', { className: 'ig-card' }, repos.slice(0, repoLimit).map(renderItem)),
          repoLimit < repos.length
            ? h('button', { className: 'ig-btn ig-btn-quiet', onClick: () => setRepoLimit(limit => limit + 40) }, t('action.more'))
            : null,
        );
      }

      function viewTrends() {
        if (trends === null) return h(Skeleton, { label: t('state.loading') });
        if (!trends.length) return h(Empty, { text: t('empty.trends'), action: runNow, actionLabel: t('action.run') });
        return h(
          'div',
          null,
          h('p', { className: 'ig-hint' }, t('hint.trends')),
          h(
            'div',
            { className: 'ig-card' },
            trends.slice(0, 20).map((row, index) =>
              h(
                'div',
                { key: row.id, className: 'ig-heat' },
                h('span', { className: 'ig-rank' }, String(index + 1)),
                h(
                  'div',
                  { className: 'ig-heat-main' },
                  h('div', { className: 'ig-heat-name' }, h('span', null, row.name), h('span', { className: 'ig-tag' }, `T${row.tier}`)),
                  row.example
                    ? h(
                        'a',
                        {
                          className: 'ig-company-latest',
                          href: row.example.url || undefined,
                          target: '_blank',
                          rel: 'noreferrer noopener',
                          style: { display: 'block', marginTop: '2px' },
                          title: row.example.title,
                        },
                        row.example.title,
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'ig-heat-num' },
                  h('div', { className: 'ig-heat-count' }, String(row.current)),
                  h('div', { className: 'ig-heat-delta' }, row.delta > 0 ? `+${row.delta}` : String(row.delta)),
                ),
              ),
            ),
          ),
        );
      }

      function viewSocial() {
        if (social === null) return h(Skeleton, { label: t('state.loading') });
        if (!social.length) return h(Empty, { text: t('empty.social'), action: runNow, actionLabel: t('action.run') });
        const groups = new Map();
        for (const item of social) {
          if (!groups.has(item.source)) groups.set(item.source, []);
          groups.get(item.source).push(item);
        }
        return h(
          'div',
          null,
          h('p', { className: 'ig-hint' }, t('hint.social')),
          [...groups.entries()].map(([source, items]) =>
            h(GroupedSection, {
              key: source,
              title: sourceNames[source] || source,
              count: items.length,
              items,
              expanded: Boolean(expanded['social-' + source]),
              onToggle: () => toggle('social-' + source),
              renderItem,
              t,
            }),
          ),
        );
      }

      function viewMajor() {
        if (major === null) return h(Skeleton, { label: t('state.loading') });
        if (!major.length) return h(Empty, { text: t('empty.major') });
        return h('div', null, h('p', { className: 'ig-hint' }, t('hint.major')), h('div', { className: 'ig-card' }, major.slice(0, 60).map(renderItem)));
      }

      function viewCompany() {
        if (company === null) return h(Skeleton, { label: t('state.loading') });
        if (!company.length) return h(Empty, { text: t('empty.company') });
        const buckets = { 1: [], 2: [], 3: [], other: [] };
        for (const item of company) {
          if (item.tier === 1) buckets[1].push(item);
          else if (item.tier === 2) buckets[2].push(item);
          else if (item.tier === 3) buckets[3].push(item);
          else buckets.other.push(item);
        }
        const defs = [
          { id: 't1', tier: 1, title: t('section.t1'), desc: t('section.t1desc') },
          { id: 't2', tier: 2, title: t('section.t2'), desc: t('section.t2desc') },
          { id: 't3', tier: 3, title: t('section.t3'), desc: t('section.t3desc') },
          { id: 'other', tier: 'other', title: t('section.other'), desc: t('section.otherdesc') },
        ];
        return defs
          .filter((def) => buckets[def.tier].length > 0)
          .map((def) =>
            h(GroupedSection, {
              key: def.id,
              title: def.title,
              desc: def.desc,
              count: buckets[def.tier].length,
              items: buckets[def.tier],
              expanded: Boolean(expanded[def.id]),
              onToggle: () => toggle(def.id),
              renderItem,
              t,
            }),
          );
      }

      function viewStartups() {
        if (startups === null) return h(Skeleton, { label: t('state.loading') });
        const cats = startups;
        const total = cats.reduce((sum, cat) => sum + cat.startups.length, 0);
        return h(
          'div',
          null,
          h('p', { className: 'ig-hint' }, t('hint.startups')),
          h(
            'div',
            { className: 'ig-chips', role: 'group', 'aria-label': t('tab.startups') },
            h(
              'button',
              {
                className: 'ig-chip',
                'data-active': startupCat === '' ? 'true' : 'false',
                onClick: () => {
                  setStartupCat('');
                  guarded('startups', loadStartups(''));
                },
              },
              `全部 · ${total}`,
            ),
            cats.map((cat) =>
              h(
                'button',
                {
                  key: cat.id,
                  className: 'ig-chip',
                  'data-active': startupCat === cat.id ? 'true' : 'false',
                  onClick: () => {
                    const next = startupCat === cat.id ? '' : cat.id;
                    setStartupCat(next);
                    guarded('startups', loadStartups(next));
                  },
                },
                cat.label,
              ),
            ),
          ),
          cats
            .filter((cat) => cat.startups.length > 0)
            .map((cat) =>
              h(
                'section',
                { key: cat.id, className: 'ig-sect' },
                h('div', { className: 'ig-sect-head' }, h('h2', { className: 'ig-sect-title' }, cat.label), h('span', { className: 'ig-sect-count' }, String(cat.startups.length))),
                h(
                  'div',
                  { className: 'ig-card' },
                  cat.startups.map((startup) =>
                    h(
                      'div',
                      { key: startup.id, className: 'ig-row' },
                      h(
                        'div',
                        { className: 'ig-company' },
                        h(
                          'div',
                          null,
                          h('div', { className: 'ig-company-name' }, startup.name),
                          h(
                            'div',
                            { className: 'ig-company-meta' },
                            [startup.region, startup.stage, startup.count ? `${startup.count} 条` : t('state.silent')].filter(Boolean).join(' · '),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'ig-company-latest' },
                          startup.items && startup.items.length
                            ? h(
                                'a',
                                { href: startup.items[0].url || undefined, target: '_blank', rel: 'noreferrer noopener', title: startup.items[0].title },
                                startup.items[0].title,
                              )
                            : h(
                                'button',
                                {
                                  className: 'ig-btn ig-btn-sm',
                                  onClick: () => fillOne(startup.name),
                                  disabled: Boolean(busy),
                                  'aria-label': `${t('action.fill')} ${startup.name}`,
                                },
                                busy === startup.name ? h(Spinner, { plain: true }) : null,
                                busy === startup.name ? t('action.filling') : t('action.fill'),
                              ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        );
      }

      function viewSearch() {
        return h(
          'div',
          null,
          h(
            'div',
            { style: { marginBottom: '10px' } },
            h('button', { className: 'ig-btn ig-btn-quiet ig-btn-sm', onClick: () => setOverlay('') }, h(Icon, { name: 'back' }), t('action.back')),
          ),
          h(
            'label',
            { className: 'ig-search' },
            h(Icon, { name: 'search' }),
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('hint.search'),
              'aria-label': t('hint.search'),
              autoFocus: true,
              onChange: (event) => setQuery(event.target.value),
            }),
            query ? h('button', { className: 'ig-search-clear', onClick: () => setQuery(''), 'aria-label': t('action.clear') }, '×') : null,
          ),
          !query.trim()
            ? null
            : !library
              ? h(Skeleton, { label: t('state.loading') })
              : h(
                  'div',
                  null,
                  h('p', { className: 'ig-count' }, `${t('state.found')} ${library.total} ${t('state.items')}`),
                  library.items.length ? h('div', { className: 'ig-card' }, library.items.map(renderItem)) : h(Empty, { text: t('empty.search') }),
                ),
        );
      }

      function viewRuns() {
        if (!runs) return h(Skeleton, { label: t('state.loading') });
        return h(
          'div',
          null,
          h(
            'div',
            { style: { marginBottom: '10px' } },
            h('button', { className: 'ig-btn ig-btn-quiet ig-btn-sm', onClick: () => setOverlay('') }, h(Icon, { name: 'back' }), t('action.back')),
          ),
          !runs.length
            ? h(Empty, { text: t('empty.runs') })
            : h(
                'div',
                { className: 'ig-card' },
                runs.map((run) =>
                  h(
                    'div',
                    { key: run.id, className: 'ig-row' },
                    h(
                      'div',
                      { className: 'ig-run-row' },
                      h('span', { className: 'ig-run-time' }, fmtDay(run.finishedAt)),
                      h(
                        'span',
                        { className: 'ig-run-facts' },
                        h('span', null, '采集 ', h('b', null, String((run.added && run.added.events) || 0))),
                        h('span', null, '搜索 ', h('b', null, String((run.added && run.added.web) || 0))),
                        h('span', null, '缺口 ', h('b', null, String((run.blindspots || []).length))),
                        h('span', null, run.report || ''),
                      ),
                    ),
                  ),
                ),
              ),
        );
      }

      const tabs = [
        { key: 'wechat', label: t('tab.wechat') },
        { key: 'companies', label: t('tab.companies') },
        { key: 'repos', label: t('tab.repos') },
        { key: 'trends', label: t('tab.trends') },
        { key: 'social', label: t('tab.social') },
        { key: 'major', label: t('tab.major') },
        { key: 'company', label: t('tab.company') },
        { key: 'startups', label: t('tab.startups') },
      ];

      const content = overlay === 'search' ? viewSearch() : overlay === 'runs' ? viewRuns() : tab === 'wechat' ? h(WechatPanel, { openReader: rawProps.openReader, refreshToken: wechatRefresh }) : tab === 'companies' ? viewCompanies() : tab === 'repos' ? viewRepos() : tab === 'trends' ? viewTrends() : tab === 'social' ? viewSocial() : tab === 'major' ? viewMajor() : tab === 'company' ? viewCompany() : viewStartups();

      return h(
        'div',
        { className: 'ig-root' },
        h(StyleOnce),
        h(
          'header',
          { className: 'ig-header' },
          h('div', { className: 'ig-headtext' }, h('h1', { className: 'ig-title' }, t('panel.title')), h('p', { className: 'ig-sub' }, subtitle)),
          h(
            'div',
            { className: 'ig-actions' },
            h(
              'button',
              {
                className: 'ig-btn ig-btn-quiet',
                onClick: () => {
                  setOverlay(overlay === 'search' ? '' : 'search');
                  setQuery('');
                  setLibrary(null);
                },
                'aria-label': t('action.search'),
                title: t('action.search'),
              },
              h(Icon, { name: 'search' }),
            ),
            h(
              'button',
              {
                className: 'ig-btn ig-btn-quiet',
                onClick: () => {
                  setOverlay('runs');
                  setRuns(null);
                  guarded('runs', loadRuns());
                },
              },
              t('action.runs'),
            ),
            h('button', { className: 'ig-btn ig-btn-quiet', onClick: tab === 'wechat' && !overlay ? () => setWechatRefresh(value => value + 1) : refreshAll, 'aria-label': t('action.refresh'), title: t('action.refresh') }, h(Icon, { name: 'refresh' })),
            tab === 'wechat' && !overlay ? null : h(
              'button',
              { className: 'ig-btn ig-btn-primary', onClick: runNow, disabled: running, 'aria-busy': running ? 'true' : 'false' },
              running ? h(Spinner) : h(Icon, { name: 'plus' }),
              running ? t('action.running') : t('action.run'),
            ),
          ),
        ),
        overlay
          ? null
          : h(
              'div',
              { className: 'ig-seg', role: 'tablist', 'aria-label': t('panel.label') },
              tabs.map((item) =>
                h(
                  'button',
                  {
                    key: item.key,
                    className: 'ig-seg-item',
                    role: 'tab',
                    'data-active': tab === item.key ? 'true' : 'false',
                    'aria-selected': tab === item.key ? 'true' : 'false',
                    tabIndex: tab === item.key ? 0 : -1,
                    id: 'ig-tab-' + item.key,
                    'aria-controls': 'ig-content',
                    onKeyDown: (event) => {
                      const index = tabs.findIndex((entry) => entry.key === item.key);
                      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
                      if (next < 0) return;
                      event.preventDefault();
                      switchTab(tabs[next].key);
                      const target = event.currentTarget.parentElement.querySelector('#ig-tab-' + tabs[next].key);
                      if (target) target.focus();
                    },
                    onClick: () => switchTab(item.key),
                  },
                  item.label,
                ),
              ),
            ),
        h(
          'div',
          { className: 'ig-body', id: 'ig-content', role: overlay ? undefined : 'tabpanel', 'aria-labelledby': overlay ? undefined : 'ig-tab-' + tab },
          error ? h(Banner, { text: error, tone: 'error', onRetry: refreshAll, retryLabel: t('action.retry') }) : null,
          readerError ? h(Banner, { text: readerError.message, tone: 'error', onRetry: () => readArticle(readerError.item), retryLabel: t('action.retry') }) : null,
          notice ? h(Banner, { text: notice, tone: 'ok' }) : null,
          status && status.webSearch === false ? h(Banner, { text: t('state.webOff'), tone: 'info' }) : null,
          loading ? h(Skeleton, { label: t('state.loading') }) : content,
        ),
      );
    }

    // ------------------------------------------------------------------
    // 侧边栏图标
    // ------------------------------------------------------------------
    function IntelIcon(props) {
      const size = (props && props.size) || 20;
      const active = Boolean(props && props.active);
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('circle', { cx: 12, cy: 12, r: 8.4, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.5 }),
        h('circle', { cx: 12, cy: 12, r: 4.6, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.9 }),
        h('path', { d: 'M12 12 L17.6 7.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 12, r: 1.5, fill: 'currentColor' }),
        h('circle', { cx: 17.4, cy: 7.8, r: 1.4, fill: 'currentColor', opacity: 0.85 }),
      );
    }

    function flattenMessages(dictionary, prefix = '', out = {}) {
      Object.entries(dictionary).forEach(([key, value]) => {
        const name = prefix ? prefix + '.' + key : key;
        if (value && typeof value === 'object') flattenMessages(value, name, out);
        else out[name] = value;
      });
      return out;
    }

    function ResponsiveIntel(props) {
      return h('div', { className: 'ig-frame' }, h(IntelPanel, props));
    }

    function apply(ctx) {
      function openReader(article, content) {
        const layout = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : null);
        if (!layout || typeof layout.selectPanel !== 'function') throw new Error('阅读助手暂不可用，请确认已启用该插件');
        if (typeof ctx.slots.entriesOfSlot === 'function' && !ctx.slots.entriesOfSlot('main').some(entry => entry.options.key === 'ai-reader')) throw new Error('AI 阅读助手面板尚未就绪，请确认插件已启用后重试。');
        window.dispatchEvent(new CustomEvent('dsh-ai-reader:open', { detail: { url: article.url, title: article.title || '', from: 'ai-intel', ...(content ? { content } : {}) } }));
        layout.selectPanel('ai-reader');
      }
      ctx.effect(() => () => stopWechatKbTasks(), 'dsh-ai-intel: knowledge tasks');
      const messages = { zh: flattenMessages(zh), en: flattenMessages(en) };
      ctx.effect(() => ctx.locale.register(NS, messages), 'dsh-ai-intel: dictionaries');
      const boundT = ctx.locale.bind(NS);
      const t = (key, ...args) => {
        let value;
        try { value = boundT(key, ...args); } catch {}
        return typeof value === 'string' && value && value !== key && !value.endsWith(':' + key) ? value : messages.zh[key] || key;
      };
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: function () { return { t: t, openReader }; } }, ResponsiveIntel);
      });
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 23,
            locale: NS,
            label: function () {
              return t('panel.label');
            },
          },
          IntelIcon,
        );
      });
    }

    return { name: PANEL_ID, inject: ['slots', 'locale', 'layout'], apply: apply };
  },
});
