import React from 'react';
import { createRoot } from 'react-dom/client';
import { useCrawlerStore } from './store';
import './styles.css';

function formatWordCount(count: number) {
  if (!Number.isFinite(count) || count <= 0) {
    return '未知';
  }
  if (count >= 10000) {
    return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)} 万字`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)} 千字`;
  }
  return `${count} 字`;
}

function isCleanTag(tag: string) {
  return tag.length > 1 && tag.length <= 5 && !/[，。！？、,.!?/\\|:：；;（）()《》“”"' ]/.test(tag);
}

function ShootingStars() {
  return (
    <div className="shooting-stars" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, index) => (
        <span key={index} className="shooting-star" />
      ))}
    </div>
  );
}

type ProgressMode = 'site' | 'novels' | 'sources' | 'chapters' | 'download';

function CrawlProgress({ active, mode }: { active: boolean; mode: ProgressMode }) {
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setProgress(100);
      const timeout = window.setTimeout(() => setProgress(0), 450);
      return () => window.clearTimeout(timeout);
    }

    setProgress(8);
    const interval = window.setInterval(() => {
      setProgress((current) => {
        const ceiling = mode === 'download' ? 88 : 92;
        if (current >= ceiling) {
          return current;
        }
        const step = current < 35 ? 6 : current < 70 ? 3 : 1.2;
        return Math.min(ceiling, current + step);
      });
    }, 420);

    return () => window.clearInterval(interval);
  }, [active, mode]);

  if (!active && progress === 0) {
    return null;
  }

  const status = active
    ? mode === 'site'
      ? progress < 35
        ? '正在连接站点...'
        : progress < 72
          ? '正在提取主分类与标签...'
          : '正在清洗小说候选数据...'
      : mode === 'novels'
        ? '正在全网模糊匹配小说...'
        : mode === 'sources'
          ? '正在验证可下载网站...'
          : mode === 'chapters'
            ? '正在扫描章节目录...'
          : progress < 45
            ? '正在定位章节目录...'
            : '正在格式化 TXT 文件...'
    : '处理完成';

  return (
    <div className="pointer-events-none fixed left-0 right-0 top-0 z-[9999] border-b border-cyan-300/10 bg-[#07090f]/80 px-4 py-3 shadow-[0_0_30px_rgba(34,211,238,0.18)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-slate-300">
          <span className="tracking-[0.28em] text-cyan-200">{status}</span>
          <span className="font-code text-cyan-100">{Math.round(progress)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-950 ring-1 ring-white/10">
          <div
            className="progress-glow h-full rounded-full bg-gradient-to-r from-cyan-400 via-violet-400 to-rose-500 transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function StatPill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-slate-400">{children}</span>;
}

function App() {
  const {
    url,
    username,
    password,
    search,
    activeCategory,
    loading,
    loadingAction,
    downloadingUrl,
    error,
    captchaUrl,
    result,
    novelSearchResult,
    sourceSearchResult,
    chapterListResult,
    chapterSource,
    downloadResult,
    showLogin,
    setUrl,
    setUsername,
    setPassword,
    setSearch,
    setActiveCategory,
    setShowLogin,
    clearCaptcha,
    indexSite,
    searchNovels,
    searchSources,
    closeSources,
    scanChapters,
    closeChapterPicker,
    downloadChapters,
    clearDownload,
  } = useCrawlerStore();

  const novels = result?.novels ?? [];
  const getNovelTags = (novel: (typeof novels)[number]) =>
    (novel.tags?.length ? novel.tags : novel.matchedKeywords).filter(isCleanTag);
  
  // 1. 主分类来自原网站导航/分类下拉，而不是小说结果反推
  const sourceCategories = result?.categories?.length ? result.categories : novels.map((novel) => novel.category);
  const mainCategories = ['全部', ...Array.from(new Set(sourceCategories.filter(Boolean)))];
  
  // 2. 提取站点原生标签，避开大分类重复
  const keywordTags = Array.from(
    new Set(novels.flatMap((novel) => getNovelTags(novel)))
  ).filter((tag) => tag && !mainCategories.includes(tag)).slice(0, 80);

  const normalizedSearch = search.trim().toLowerCase();
  
  // 3. 增强的过滤逻辑（支持大类过滤与细分类词/关键字过滤）
  const filteredNovels = novels.filter((novel) => {
    const inCategory =
      activeCategory === '全部' ||
      novel.category === activeCategory ||
      getNovelTags(novel).includes(activeCategory);
    
    const haystack = [
      novel.title,
      novel.category,
      novel.description,
      novel.url,
      ...getNovelTags(novel),
    ].join(' ').toLowerCase();
    
    return inCategory && (!normalizedSearch || haystack.includes(normalizedSearch));
  });

  // 4. 无限滚动分段渲染控制
  const [visibleCount, setVisibleCount] = React.useState(10);
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const [chapterMode, setChapterMode] = React.useState<'all' | 'partial'>('all');
  const [selectedChapterUrls, setSelectedChapterUrls] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    setChapterMode('all');
    setSelectedChapterUrls(new Set(chapterListResult?.chapters.map((chapter) => chapter.url) ?? []));
  }, [chapterListResult]);

  // 切换筛选、搜索、抓取结果时重置可见数量
  React.useEffect(() => {
    setVisibleCount(10);
  }, [activeCategory, search, result]);

  // 使用 IntersectionObserver 监听滚动到底部
  React.useEffect(() => {
    if (!result || filteredNovels.length <= visibleCount) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + 10, filteredNovels.length));
        }
      },
      { threshold: 0.1 }
    );

    const currentSentinel = sentinelRef.current;
    if (currentSentinel) {
      observer.observe(currentSentinel);
    }

    return () => {
      if (currentSentinel) {
        observer.unobserve(currentSentinel);
      }
    };
  }, [result, filteredNovels.length, visibleCount]);

  // 当前切片渲染的数据
  const displayedNovels = filteredNovels.slice(0, visibleCount);
  const isBusy = loading || Boolean(downloadingUrl);
  const progressMode: ProgressMode = downloadingUrl ? 'download' : loadingAction || 'site';

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05060a] text-slate-100">
      <div className="aurora" aria-hidden="true">
        <div className="aurora__blob aurora__blob--cyan" />
        <div className="aurora__blob aurora__blob--violet" />
        <div className="aurora__blob aurora__blob--rose" />
      </div>
      <div className="tech-grid" aria-hidden="true" />
      <div className="scan-overlay" aria-hidden="true" />
      <ShootingStars />
      <CrawlProgress active={isBusy} mode={progressMode} />
      <section className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-14 md:py-20">
        <div className="mb-8 max-w-4xl reveal">
          <div className="mb-5 inline-flex items-center gap-3 rounded-full border border-cyan-300/25 bg-cyan-300/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.4em] text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.14)]">
            <span className="pulse-dot h-2 w-2 rounded-full bg-cyan-300" />
            <span className="font-tech">GET · NOVELS</span>
            <span className="font-code text-[10px] tracking-[0.2em] text-cyan-300/60">v2.0</span>
          </div>
          <h1 className="font-display max-w-3xl text-4xl font-bold tracking-tight text-white md:text-6xl">
            暗夜书库扫描器
            <span className="title-glow block">先发现，再精准爬取</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300/90">
            可扫描指定网站，也可按小说名全网模糊搜索；选定小说后验证可下载网站，再抓取并清洗为 TXT。
          </p>
          <div className="mt-6 flex flex-wrap gap-2 font-code text-[11px] tracking-wider text-slate-400">
            <span className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1">全网模糊搜索</span>
            <span className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1">章节精准定位</span>
            <span className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1">TXT 自动清洗</span>
          </div>
        </div>

        <form
          className="glass-panel hud p-4 reveal"
          onSubmit={(event) => {
            event.preventDefault();
            if (/^https?:\/\//i.test(url.trim())) {
              void indexSite();
            } else {
              void searchNovels();
            }
          }}
        >
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              className="input-tech min-w-0 flex-1 px-5 py-4 text-base"
              placeholder="输入网站网址，或输入小说名称"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button
              type="button"
              className="btn-neon px-7 py-4"
              disabled={loading}
              onClick={() => void indexSite()}
            >
              {loading && loadingAction === 'site' ? '扫描中…' : '扫描网站'}
            </button>
            <button
              type="button"
              className="btn-ghost px-7 py-4"
              disabled={loading}
              onClick={() => void searchNovels()}
            >
              {loading && loadingAction === 'novels' ? '搜索中…' : '扫描小说'}
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        </form>

        {novelSearchResult && (
          <section className="glass-panel reveal mt-8 p-6">
            <div className="mb-5">
              <h2 className="font-display text-2xl font-bold text-white">“{novelSearchResult.query}”的模糊匹配</h2>
              <p className="mt-1 text-sm text-slate-400">点击下载后会继续全网检索，并只展示已识别到章节入口的网站。</p>
            </div>
            {novelSearchResult.novels.length === 0 ? (
              <p className="text-slate-300">没有找到匹配的小说，请尝试更完整或更短的书名。</p>
            ) : (
              <div className="grid gap-4">
                {novelSearchResult.novels.map((novel) => (
                  <article key={novel.title} className="novel-card p-5">
                    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                      <div>
                        <h3 className="text-lg font-semibold text-cyan-200">{novel.title}</h3>
                        <p className="mt-2 text-sm text-slate-400">{novel.description || '搜索结果未提供简介'}</p>
                        <div className="mt-3 flex gap-2 text-xs">
                          <StatPill>匹配 {novel.matchScore}%</StatPill>
                          <StatPill>搜索线索 {novel.sourceCount}</StatPill>
                        </div>
                      </div>
                      <button
                        className="btn-emerald shrink-0 px-5 py-3"
                        type="button"
                        disabled={loading || Boolean(downloadingUrl)}
                        onClick={() => void searchSources(novel.title)}
                      >
                        搜索下载网站
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {result && (
          <section className="glass-panel reveal mt-8 p-6">
            <div className="mb-5 flex flex-col justify-between gap-4 md:flex-row md:items-center">
              <div>
                <h2 className="font-display text-2xl font-bold text-white">发现结果</h2>
                <p className="mt-1 text-sm text-slate-400">主分类来自原网站导航，网站标签只展示详情页短标签。</p>
              </div>
              <span className="font-code rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-sm text-cyan-100">
                扫描 {result.scannedPages} 页
              </span>
            </div>

            <div className="mb-5 flex flex-col gap-4">
              <input
                className="input-tech w-full px-4 py-3"
                placeholder="按小说名、网站分类、网站标签模糊搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              
              {/* 大分类筛选器 */}
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-2">主分类：</span>
                {mainCategories.map((category) => (
                  <button
                    key={category}
                    className={`rounded-2xl px-4 py-1.5 text-sm transition ${
                      activeCategory === category
                        ? 'bg-cyan-300 font-bold text-slate-950 shadow-[0_0_18px_rgba(103,232,249,0.35)]'
                        : 'border border-white/10 bg-white/[0.04] text-slate-300 hover:border-cyan-300/30 hover:bg-cyan-300/10 hover:text-cyan-100'
                    }`}
                    type="button"
                    onClick={() => setActiveCategory(category)}
                  >
                    {category}
                  </button>
                ))}
              </div>

              {/* 细分分类词标签筛选器 */}
              {keywordTags.length > 0 && (
                <div className="flex flex-wrap gap-2 items-center border-t border-white/5 pt-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-2">网站标签：</span>
                  {keywordTags.map((tag) => (
                    <button
                      key={tag}
                      className={`rounded-xl px-3 py-1 text-xs transition ${
                        activeCategory === tag
                          ? 'border border-violet-300/50 bg-violet-400/25 font-semibold text-violet-100 shadow-[0_0_16px_rgba(167,139,250,0.22)]'
                          : 'border border-white/10 bg-white/[0.035] text-slate-400 hover:border-violet-300/30 hover:bg-violet-400/10 hover:text-slate-200'
                      }`}
                      type="button"
                      onClick={() => setActiveCategory(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {novels.length === 0 ? (
              <p className="text-slate-300">暂未识别到小说候选页。</p>
            ) : filteredNovels.length === 0 ? (
              <p className="text-slate-300">没有匹配搜索条件的小说。</p>
            ) : (
              <div className="grid gap-4">
                {displayedNovels.map((novel) => (
                  <article key={novel.url} className="novel-card p-5">
                    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                      <div>
                        <a className="text-lg font-semibold text-cyan-200 hover:text-white" href={novel.url} target="_blank">
                          {novel.title || novel.url}
                        </a>
                        <p className="mt-2 text-sm text-slate-400">{novel.description}</p>
                      </div>
                      <button
                        className="btn-emerald shrink-0 px-5 py-3"
                        type="button"
                        disabled={loading || Boolean(downloadingUrl)}
                        onClick={() => void scanChapters({
                          siteName: new URL(novel.url).hostname,
                          url: novel.url,
                          description: novel.description,
                          chapterHints: novel.chapterHints,
                        }, novel.title)}
                      >
                        {loading && chapterSource?.url === novel.url ? '扫描章节中…' : '扫描章节并下载'}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500 font-code">{novel.url}</p>
                    
                    {/* 可点击交互的分类与标签 */}
                    <div className="mt-3 flex flex-wrap gap-2 text-xs items-center">
                      <button
                        className={`rounded-full px-3 py-1 transition ${
                          activeCategory === novel.category
                            ? 'bg-cyan-400 text-slate-950 font-bold'
                            : 'bg-cyan-400/15 text-cyan-200 hover:bg-cyan-400/25'
                        }`}
                        onClick={() => setActiveCategory(novel.category)}
                      >
                        {novel.category}
                      </button>
                      
                      {getNovelTags(novel).map((tag) => (
                        <button
                          key={tag}
                          className={`rounded-full px-3 py-1 transition ${
                            activeCategory === tag
                              ? 'bg-cyan-400 text-slate-950 font-bold'
                              : 'bg-white/10 text-slate-300 hover:bg-white/15'
                          }`}
                          onClick={() => setActiveCategory(tag)}
                        >
                          {tag}
                        </button>
                      ))}
                      
                      <span className="rounded-full bg-white/5 px-3 py-1 text-slate-400 border border-white/5">
                        字数 {formatWordCount(novel.wordCount || novel.textLength)}
                      </span>
                      <StatPill>章节线索 {novel.chapterHints}</StatPill>
                      <StatPill>匹配 {novel.score}</StatPill>
                    </div>
                  </article>
                ))}

                {/* 滚动监听哨兵与提示栏 */}
                <div ref={sentinelRef} className="mt-4 py-4 text-center text-sm text-slate-500">
                  {filteredNovels.length > visibleCount ? (
                    <div className="flex items-center justify-center gap-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                      <span>正在加载更多小说候选...</span>
                    </div>
                  ) : (
                    <span>已加载全部匹配小说候选 (共 {filteredNovels.length} 本)</span>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {downloadResult && (
          <section className="mt-6 rounded-3xl border border-emerald-300/20 bg-emerald-400/10 p-5 shadow-[0_0_28px_rgba(52,211,153,0.14)] backdrop-blur">
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
              <p className="text-emerald-100">
                已生成《{downloadResult.title}》，共 {downloadResult.chapterCount} 章，浏览器已开始下载。
              </p>
              <button className="rounded-xl bg-white/10 px-4 py-2 text-sm text-slate-200" type="button" onClick={clearDownload}>
                知道了
              </button>
            </div>
          </section>
        )}
      </section>

      {sourceSearchResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <section className="glass-panel max-h-[85vh] w-full max-w-3xl overflow-y-auto p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">选择《{sourceSearchResult.title}》的下载网站</h2>
                <p className="mt-2 text-sm text-slate-300">已过滤未发现章节入口的网站；最终可下载性仍取决于目标站实时状态。</p>
              </div>
              <button className="rounded-xl bg-white/10 px-4 py-2 text-slate-300" type="button" onClick={closeSources}>关闭</button>
            </div>
            {sourceSearchResult.sources.length === 0 ? (
              <p className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-amber-100">
                暂未找到可识别章节入口的网站，可以更换小说名称后重试。
              </p>
            ) : (
              <div className="mt-6 grid gap-3">
                {sourceSearchResult.sources.map((source) => (
                  <article key={source.url} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-cyan-200">{source.siteName}</h3>
                        <p className="mt-1 line-clamp-2 text-sm text-slate-400">{source.description || source.url}</p>
                        <p className="mt-2 truncate font-code text-xs text-slate-500">{source.url}</p>
                      </div>
                      <button
                        className="btn-emerald shrink-0 px-5 py-2.5"
                        type="button"
                        disabled={loading || Boolean(downloadingUrl)}
                        onClick={() => void scanChapters(source, sourceSearchResult.title)}
                      >
                        {loading && chapterSource?.url === source.url ? '扫描章节中…' : '扫描章节并下载'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
          </section>
        </div>
      )}

      {chapterListResult && chapterSource && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm">
          <section className="glass-panel flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">选择《{chapterListResult.title}》下载范围</h2>
                <p className="mt-2 text-sm text-slate-300">
                  {chapterSource.siteName} · 已扫描到 {chapterListResult.chapters.length} 章
                </p>
              </div>
              <button className="rounded-xl bg-white/10 px-4 py-2 text-slate-300" type="button" onClick={closeChapterPicker}>
                关闭
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 rounded-2xl bg-slate-950/60 p-2">
              <button
                className={`rounded-xl px-4 py-3 font-semibold transition ${chapterMode === 'all' ? 'bg-cyan-300 text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}
                type="button"
                onClick={() => setChapterMode('all')}
              >
                全本下载
              </button>
              <button
                className={`rounded-xl px-4 py-3 font-semibold transition ${chapterMode === 'partial' ? 'bg-violet-300 text-slate-950' : 'text-slate-300 hover:bg-white/10'}`}
                type="button"
                onClick={() => setChapterMode('partial')}
              >
                部分下载
              </button>
            </div>

            {chapterMode === 'all' ? (
              <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-5 text-cyan-100">
                将按目录顺序下载全部 {chapterListResult.chapters.length} 章。
              </div>
            ) : (
              <div className="mt-5 flex min-h-0 flex-1 flex-col">
                <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">已选择 {selectedChapterUrls.size} / {chapterListResult.chapters.length} 章</span>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg bg-white/10 px-3 py-1.5 text-slate-200"
                      type="button"
                      onClick={() => setSelectedChapterUrls(new Set(chapterListResult.chapters.map((chapter) => chapter.url)))}
                    >
                      全选
                    </button>
                    <button className="rounded-lg bg-white/10 px-3 py-1.5 text-slate-200" type="button" onClick={() => setSelectedChapterUrls(new Set())}>
                      清空
                    </button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/60 p-2">
                  {chapterListResult.chapters.map((chapter, index) => (
                    <label key={chapter.url} className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[0.06]">
                      <input
                        className="h-4 w-4 accent-violet-400"
                        type="checkbox"
                        checked={selectedChapterUrls.has(chapter.url)}
                        onChange={(event) => {
                          setSelectedChapterUrls((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(chapter.url);
                            else next.delete(chapter.url);
                            return next;
                          });
                        }}
                      />
                      <span className="w-12 shrink-0 text-right font-code text-xs text-slate-500">{index + 1}</span>
                      <span>{chapter.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
            <div className="mt-5 flex justify-end">
              <button
                className="btn-emerald px-6 py-3"
                type="button"
                disabled={Boolean(downloadingUrl) || (chapterMode === 'partial' && selectedChapterUrls.size === 0)}
                onClick={() => {
                  const chapters = chapterMode === 'all'
                    ? chapterListResult.chapters
                    : chapterListResult.chapters.filter((chapter) => selectedChapterUrls.has(chapter.url));
                  void downloadChapters(chapterSource, chapterListResult.title, chapters);
                }}
              >
                {downloadingUrl ? '正在生成 TXT…' : chapterMode === 'all' ? '下载全本' : `下载所选 ${selectedChapterUrls.size} 章`}
              </button>
            </div>
          </section>
        </div>
      )}

      {showLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <form
            className="glass-panel hud reveal w-full max-w-md p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void indexSite({ username, password });
            }}
          >
            <h2 className="font-display text-2xl font-bold">网站需要登录</h2>
            <p className="mt-2 text-sm text-slate-300">请输入该网站账号密码，仅用于本次抓取请求。</p>
            <input
              className="input-tech mt-5 w-full px-4 py-3"
              placeholder="账号"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              className="input-tech mt-3 w-full px-4 py-3"
              placeholder="密码"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="mt-5 flex justify-end gap-3">
              <button className="rounded-xl px-4 py-2 text-slate-300 transition hover:text-white" type="button" onClick={() => setShowLogin(false)}>
                取消
              </button>
              <button className="btn-neon px-5 py-2" disabled={loading}>
                登录并抓取
              </button>
            </div>
          </form>
        </div>
      )}

      {captchaUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <div className="glass-panel w-full max-w-lg p-6">
            <h2 className="text-2xl font-bold text-white">需要人工验证码</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              目标站点要求在浏览器中完成人工验证。系统已停止生成错误 TXT；请打开验证页完成后，再回到这里重新点击“爬取并下载”。
            </p>
            <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/70 p-3 text-xs text-slate-400 break-all">
              {captchaUrl}
            </div>
            <div className="mt-5 flex flex-col justify-end gap-3 sm:flex-row">
              <button className="rounded-xl px-4 py-2 text-slate-300" type="button" onClick={clearCaptcha}>
                关闭
              </button>
              <button
                className="rounded-xl border border-cyan-300/30 bg-cyan-300/15 px-5 py-2 font-bold text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.18)]"
                type="button"
                onClick={() => window.open(captchaUrl, '_blank', 'noopener,noreferrer')}
              >
                打开验证页
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
