import { create } from 'zustand';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

type NovelCandidate = {
  title: string;
  url: string;
  category: string;
  tags: string[];
  description: string;
  score: number;
  matchedKeywords: string[];
  wordCount: number;
  textLength: number;
  chapterHints: number;
};

type IndexResult = {
  requiresLogin: boolean;
  loginUrl?: string;
  scannedPages: number;
  categories: string[];
  novels: NovelCandidate[];
};

type DownloadResult = {
  title: string;
  filename: string;
  content: string;
  chapterCount: number;
};

type WebNovelCandidate = {
  title: string;
  description: string;
  matchScore: number;
  sourceCount: number;
};

type DownloadSource = {
  siteName: string;
  url: string;
  description: string;
  chapterHints: number;
};

type NovelSearchResult = { query: string; novels: WebNovelCandidate[] };
type SourceSearchResult = { title: string; sources: DownloadSource[] };

type CrawlCredentials = {
  username: string;
  password: string;
};

type CrawlerStore = {
  url: string;
  username: string;
  password: string;
  search: string;
  activeCategory: string;
  loading: boolean;
  loadingAction: 'site' | 'novels' | 'sources' | '';
  downloadingUrl: string;
  error: string;
  captchaUrl: string;
  showLogin: boolean;
  result: IndexResult | null;
  novelSearchResult: NovelSearchResult | null;
  sourceSearchResult: SourceSearchResult | null;
  downloadResult: DownloadResult | null;
  setUrl: (url: string) => void;
  setUsername: (username: string) => void;
  setPassword: (password: string) => void;
  setSearch: (search: string) => void;
  setActiveCategory: (activeCategory: string) => void;
  setShowLogin: (showLogin: boolean) => void;
  clearCaptcha: () => void;
  indexSite: (credentials?: CrawlCredentials) => Promise<void>;
  searchNovels: () => Promise<void>;
  searchSources: (title: string) => Promise<void>;
  closeSources: () => void;
  downloadNovel: (novel: NovelCandidate) => Promise<void>;
  downloadSource: (source: DownloadSource, title: string) => Promise<void>;
  clearDownload: () => void;
};

export const useCrawlerStore = create<CrawlerStore>((set, get) => ({
  url: '',
  username: '',
  password: '',
  search: '',
  activeCategory: '全部',
  loading: false,
  loadingAction: '',
  downloadingUrl: '',
  error: '',
  captchaUrl: '',
  showLogin: false,
  result: null,
  novelSearchResult: null,
  sourceSearchResult: null,
  downloadResult: null,
  setUrl: (url) => set({ url }),
  setUsername: (username) => set({ username }),
  setPassword: (password) => set({ password }),
  setSearch: (search) => set({ search }),
  setActiveCategory: (activeCategory) => set({ activeCategory }),
  setShowLogin: (showLogin) => set({ showLogin }),
  clearCaptcha: () => set({ captchaUrl: '', error: '' }),
  indexSite: async (credentials) => {
    const { url } = get();
    if (!url.trim()) {
      set({ error: '请输入网址' });
      return;
    }

    set({ loading: true, loadingAction: 'site', error: '', downloadResult: null, novelSearchResult: null, sourceSearchResult: null });
    try {
      const response = await fetch(`${API_BASE_URL || '/api'}/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, credentials }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const result = (await response.json()) as IndexResult;
      set({
        result,
        showLogin: result.requiresLogin,
        loading: false,
        loadingAction: '',
        password: result.requiresLogin ? get().password : '',
      });
    } catch (error) {
      set({
        loading: false,
        loadingAction: '',
        error: error instanceof Error ? error.message : '抓取失败',
      });
    }
  },
  searchNovels: async () => {
    const query = get().url.trim();
    if (!query) {
      set({ error: '请输入小说名称' });
      return;
    }
    set({ loading: true, loadingAction: 'novels', error: '', result: null, novelSearchResult: null, sourceSearchResult: null, downloadResult: null });
    try {
      const response = await fetch(`${API_BASE_URL || '/api'}/search/novels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      set({ novelSearchResult: (await response.json()) as NovelSearchResult, loading: false, loadingAction: '' });
    } catch (error) {
      set({ loading: false, loadingAction: '', error: error instanceof Error ? error.message : '全网搜索失败' });
    }
  },
  searchSources: async (title) => {
    set({ loading: true, loadingAction: 'sources', error: '', sourceSearchResult: null });
    try {
      const response = await fetch(`${API_BASE_URL || '/api'}/search/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      set({ sourceSearchResult: (await response.json()) as SourceSearchResult, loading: false, loadingAction: '' });
    } catch (error) {
      set({ loading: false, loadingAction: '', error: error instanceof Error ? error.message : '下载网站搜索失败' });
    }
  },
  closeSources: () => set({ sourceSearchResult: null }),
  downloadNovel: async (novel) => {
    const { username, password, showLogin } = get();
    set({ downloadingUrl: novel.url, error: '', captchaUrl: '', downloadResult: null });
    try {
      const response = await fetch(`${API_BASE_URL || '/api'}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: novel.url,
          title: novel.title,
          credentials: showLogin ? { username, password } : undefined,
        }),
      });

      if (!response.ok) {
        const text = await readApiError(response);
        const captchaUrl = text.match(/https?:\/\/[^\s"'}]+captcha[^\s"'}]*/i)?.[0] ?? '';
        set({ captchaUrl });
        throw new Error(text);
      }

      const downloadResult = (await response.json()) as DownloadResult;
      const blob = new Blob([downloadResult.content], { type: 'text/plain;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = downloadResult.filename;
      anchor.click();
      URL.revokeObjectURL(href);
      set({ downloadResult, downloadingUrl: '', sourceSearchResult: null });
    } catch (error) {
      set({
        downloadingUrl: '',
        error: error instanceof Error ? error.message : '生成 TXT 失败',
      });
    }
  },
  downloadSource: async (source, title) => {
    const novel: NovelCandidate = {
      title,
      url: source.url,
      category: '全网搜索',
      tags: [],
      description: source.description,
      score: 0,
      matchedKeywords: [],
      wordCount: 0,
      textLength: 0,
      chapterHints: source.chapterHints,
    };
    await get().downloadNovel(novel);
  },
  clearDownload: () => set({ downloadResult: null }),
}));

async function readApiError(response: Response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { detail?: string };
    return parsed.detail || text;
  } catch {
    return text;
  }
}
