# Get Novels

最小原型：输入网站 URL 后先扫描站内小说详情页，读取网站原生分类和标签，支持分类/标签筛选与模糊搜索；用户点击“爬取并下载”后再抓章节正文，清理冗余内容并生成 TXT 下载。遇到登录表单时前端弹窗输入账号密码。

## 结构

- `frontend`：React + TypeScript + Zustand + Vite + Tailwind
- `crawler-python`：FastAPI 爬虫服务，负责登录尝试、站内扫描、小说候选识别和 TXT 格式化

## 启动

```powershell
# 1. 启动爬虫服务 (默认端口 8001)
cd crawler-python
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\uvicorn main:app --reload --port 8001
```

```powershell
# 2. 启动前端服务 (默认端口 5173，接口会自动代理至爬虫服务 8001 端口)
cd frontend
npm install
npm run dev
```

然后打开 `http://localhost:5173`。

## 当前边界

- 只做同域名、限量页面扫描和限量章节抓取，避免无限爬取。
- 默认拒绝本机、内网和保留地址，避免把服务变成内网探测代理。
- 默认启用温和抓取：串行详情页请求、请求间隔与随机抖动、短时 HTML 缓存；遇到 `403/429/503` 等状态码在代理及重试次数耗尽后会提示稍后重试。
- 代理轮换与指纹伪装：支持在爬取及重试时自动进行代理轮换（通过配置 `proxies.txt` 或 `PROXY_API_URL` 激活），并已内置基于 `curl_cffi` 的 TLS / JA3 / HTTP2 随机浏览器指纹轮换（Chrome/Edge/Safari 随机版本）及动态 User-Agent 随机切换，能够安全温和地应对目标站风控。
- 请求层尊重 `robots.txt`，仅对超时、连接错误和 `500/502/504` 等临时异常做有限重试。
- 如需设置全局出口代理，可配置环境变量 `OUTBOUND_PROXY=http://user:pass@host:port`。
- 通用登录只支持普通 HTML 表单；验证码、短信、复杂 JS 登录需要后续单站点适配。
- 小说识别是启发式：优先识别书籍详情页/目录页，避免把具体章节页当成小说。
- 分类和标签优先来自网站页面的 meta、分类链接、标签链接和“分类/标签”文本；无法识别时显示“未分类”。
- 下载 TXT 会删除常见广告/收藏提示/重复行，但不同站点仍可能需要单站点清洗规则。
