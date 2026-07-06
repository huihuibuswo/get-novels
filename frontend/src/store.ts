import { create } from 'zustand';

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
  downloadingUrl: string;
  error: string;
  captchaUrl: string;
  showLogin: boolean;
  result: IndexResult | null;
  downloadResult: DownloadResult | null;
  setUrl: (url: string) => void;
  setUsername: (username: string) => void;
  setPassword: (password: string) => void;
  setSearch: (search: string) => void;
  setActiveCategory: (activeCategory: string) => void;
  setShowLogin: (showLogin: boolean) => void;
  clearCaptcha: () => void;
  indexSite: (credentials?: CrawlCredentials) => Promise<void>;
  downloadNovel: (novel: NovelCandidate) => Promise<void>;
  clearDownload: () => void;
};

export const useCrawlerStore = create<CrawlerStore>((set, get) => ({
  url: '',
  username: '',
  password: '',
  search: '',
  activeCategory: '全部',
  loading: false,
  downloadingUrl: '',
  error: '',
  captchaUrl: '',
  showLogin: false,
  result: null,
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

    set({ loading: true, error: '', downloadResult: null });
    try {
      const response = await fetch('/api/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, credentials }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const result = (await response.json()) as IndexResult;
      set({
        result,
        showLogin: result.requiresLogin,
        loading: false,
        password: result.requiresLogin ? get().password : '',
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '抓取失败',
      });
    }
  },
  downloadNovel: async (novel) => {
    const { username, password, showLogin } = get();
    set({ downloadingUrl: novel.url, error: '', captchaUrl: '', downloadResult: null });
    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: novel.url,
          title: novel.title,
          credentials: showLogin ? { username, password } : undefined,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
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
      set({ downloadResult, downloadingUrl: '' });
    } catch (error) {
      set({
        downloadingUrl: '',
        error: error instanceof Error ? error.message : '生成 TXT 失败',
      });
    }
  },
  clearDownload: () => set({ downloadResult: null }),
}));
