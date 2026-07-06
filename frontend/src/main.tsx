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

function CrawlProgress({ active, mode }: { active: boolean; mode: 'scan' | 'download' }) {
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
        const ceiling = mode === 'scan' ? 92 : 88;
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
    ? mode === 'scan'
      ? progress < 35
        ? '正在连接站点...'
        : progress < 72
          ? '正在提取主分类与标签...'
          : '正在清洗小说候选数据...'
      : progress < 45
        ? '正在定位章节目录...'
        : '正在格式化 TXT 文件...'
    : '处理完成';

  return (
    <div className="fixed left-0 right-0 top-0 z-50 border-b border-cyan-300/10 bg-[#07090f]/80 px-4 py-3 shadow-[0_0_30px_rgba(34,211,238,0.18)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-slate-300">
          <span className="tracking-[0.28em] text-cyan-200">{status}</span>
          <span className="font-mono text-cyan-100">{Math.round(progress)}%</span>
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
    downloadingUrl,
    error,
    captchaUrl,
    result,
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
    downloadNovel,
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
  const progressMode = downloadingUrl ? 'download' : 'scan';

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b0b0c] text-slate-100">
      <ShootingStars />
      <CrawlProgress active={isBusy} mode={progressMode} />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_20%_10%,rgba(168,85,247,0.20),transparent_26%),radial-gradient(circle_at_85%_20%,rgba(6,182,212,0.16),transparent_24%),linear-gradient(135deg,#0b0b0c_0%,#0f172a_55%,#120812_100%)]" />
      <div className="pointer-events-none absolute inset-0 z-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40" />
      <section className="relative z-10 mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-14 md:py-20">
        <div className="mb-8 max-w-4xl">
          <div className="mb-4 inline-flex items-center gap-3 rounded-full border border-cyan-300/20 bg-cyan-300/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.35em] text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.12)]">
            <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_16px_#67e8f9]" />
            Get Novels
          </div>
          <h1 className="max-w-3xl text-4xl font-black tracking-tight text-white md:text-6xl">
            暗夜书库扫描器
            <span className="block bg-gradient-to-r from-cyan-200 via-violet-200 to-rose-200 bg-clip-text text-transparent">
              先发现，再精准爬取
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-300">
            自动读取原站主分类与详情页标签，搜索命中后再抓章节正文并清洗成适合阅读的 TXT。
          </p>
        </div>

        <form
          className="glass-panel p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void indexSite();
          }}
        >
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-[#080b12]/90 px-5 py-4 text-base text-slate-100 outline-none ring-cyan-400/30 transition placeholder:text-slate-500 focus:border-cyan-300/40 focus:ring-4"
              placeholder="https://example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button
              className="rounded-2xl bg-gradient-to-r from-cyan-400 via-violet-400 to-rose-500 px-7 py-4 font-bold text-slate-950 shadow-[0_0_28px_rgba(34,211,238,0.28)] transition hover:scale-[1.01] hover:shadow-[0_0_36px_rgba(168,85,247,0.35)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={loading}
            >
              {loading ? '扫描中…' : '扫描小说'}
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        </form>

        {result && (
          <section className="glass-panel mt-8 p-6">
            <div className="mb-5 flex flex-col justify-between gap-4 md:flex-row md:items-center">
              <div>
                <h2 className="text-2xl font-bold text-white">发现结果</h2>
                <p className="mt-1 text-sm text-slate-400">主分类来自原网站导航，网站标签只展示详情页短标签。</p>
              </div>
              <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-sm text-cyan-100">
                扫描 {result.scannedPages} 页
              </span>
            </div>
            
            <div className="mb-5 flex flex-col gap-4">
              <input
                className="w-full rounded-2xl border border-white/10 bg-[#080b12]/90 px-4 py-3 text-slate-100 outline-none ring-violet-400/20 transition placeholder:text-slate-500 focus:border-violet-300/40 focus:ring-4"
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
                        className="shrink-0 rounded-2xl border border-emerald-300/30 bg-emerald-300/90 px-5 py-3 font-bold text-slate-950 shadow-[0_0_22px_rgba(52,211,153,0.24)] transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                        type="button"
                        disabled={Boolean(downloadingUrl)}
                        onClick={() => void downloadNovel(novel)}
                      >
                        {downloadingUrl === novel.url ? '生成中…' : '爬取并下载'}
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500 font-mono">{novel.url}</p>
                    
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
                已生成《{downloadResult.title}》，共 {downloadResult.chapterCount} 个章节片段，浏览器已开始下载。
              </p>
              <button className="rounded-xl bg-white/10 px-4 py-2 text-sm text-slate-200" type="button" onClick={clearDownload}>
                知道了
              </button>
            </div>
          </section>
        )}
      </section>

      {showLogin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <form
            className="glass-panel w-full max-w-md p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void indexSite({ username, password });
            }}
          >
            <h2 className="text-2xl font-bold">网站需要登录</h2>
            <p className="mt-2 text-sm text-slate-300">请输入该网站账号密码，仅用于本次抓取请求。</p>
            <input
              className="mt-5 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 outline-none"
              placeholder="账号"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 outline-none"
              placeholder="密码"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div className="mt-5 flex justify-end gap-3">
              <button className="rounded-xl px-4 py-2 text-slate-300" type="button" onClick={() => setShowLogin(false)}>
                取消
              </button>
              <button className="rounded-xl bg-cyan-400 px-5 py-2 font-bold text-slate-950" disabled={loading}>
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
