import re
import os
import socket
import random
import time
import threading
from ipaddress import ip_address
from collections import deque
from typing import Optional
from urllib.parse import urljoin, urlparse
from urllib import robotparser

from dotenv import load_dotenv
load_dotenv()

from curl_cffi import requests
from curl_cffi.requests import Session, Response
from curl_cffi.requests.errors import RequestsError
from fake_useragent import UserAgent
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, HttpUrl

# Monkey Patch 异常与属性以便完美向下兼容
requests.RequestException = RequestsError
requests.Timeout = RequestsError
requests.ConnectionError = RequestsError

# 补全 curl_cffi 的 Response.is_redirect 与 Response.apparent_encoding
Response.is_redirect = property(lambda self: "location" in self.headers and self.status_code in {301, 302, 303, 307, 308})

def _get_apparent_encoding(self):
    try:
        import charset_normalizer
        res = charset_normalizer.from_bytes(self.content).best()
        if res:
            return res.encoding
    except Exception:
        pass
    return "utf-8"

Response.apparent_encoding = property(_get_apparent_encoding)
Response.encoding = property(Response.encoding.fget, lambda self, val: setattr(self, "_encoding", val))

app = FastAPI(title="Get Novels Crawler")

# 初始化动态 User-Agent 生成器，并准备好兜底机制
try:
    ua_generator = UserAgent(browsers=['chrome', 'edge', 'safari'])
except Exception:
    class FakeUA:
        def __init__(self):
            self.uas = [
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edge/125.0.0.0",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
            ]
        @property
        def random(self):
            return random.choice(self.uas)
    ua_generator = FakeUA()

class ProxyManager:
    def __init__(self):
        self.tunnel = os.getenv("PROXY_TUNNEL", "").strip()
        self.api_url = os.getenv("PROXY_API_URL", "").strip()
        
        # 兼容原有环境变量 OUTBOUND_PROXY
        outbound_proxy = os.getenv("OUTBOUND_PROXY", "").strip()
        if outbound_proxy and not self.tunnel and not self.api_url:
            self.tunnel = outbound_proxy
            
        self.rotation_interval = int(os.getenv("PROXY_ROTATION_INTERVAL", "1"))
        self.request_count = 0
        self.current_proxy = None
        self.last_fetch_time = 0
        self.api_cooldown = 2.0  # 避免频繁调用代理 API
        self.proxies_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxies.txt")
        
    def get_proxy(self, force_rotate: bool = False) -> Optional[dict[str, str]]:
        # 1. 优先读取本地 proxies.txt 中的代理列表并随机选择
        if os.path.exists(self.proxies_file):
            try:
                with open(self.proxies_file, "r", encoding="utf-8") as f:
                    ips = [line.strip() for line in f if line.strip() and not line.strip().startswith("#")]
                if ips:
                    self.request_count += 1
                    should_rotate = force_rotate or (self.current_proxy is None) or (self.rotation_interval > 0 and self.request_count % self.rotation_interval == 0)
                    if should_rotate:
                        selected = random.choice(ips)
                        if not selected.startswith(("http://", "https://")):
                            selected = f"http://{selected}"
                        self.current_proxy = {
                            "http": selected,
                            "https": selected
                        }
                    return self.current_proxy
            except Exception:
                pass

        # 2. 原有的 API/固定代理逻辑
        if not self.tunnel and not self.api_url:
            return None
            
        if self.tunnel:
            return {
                "http": self.tunnel,
                "https": self.tunnel
            }
            
        self.request_count += 1
        should_rotate = force_rotate or (self.current_proxy is None) or (self.rotation_interval > 0 and self.request_count % self.rotation_interval == 0)
        
        if should_rotate:
            new_ip = self._fetch_new_ip()
            if new_ip:
                self.current_proxy = {
                    "http": f"http://{new_ip}",
                    "https": f"http://{new_ip}"
                }
            else:
                if not self.current_proxy:
                    return None
        return self.current_proxy

    def _fetch_new_ip(self) -> Optional[str]:
        now = time.monotonic()
        if now - self.last_fetch_time < self.api_cooldown:
            time.sleep(self.api_cooldown - (now - self.last_fetch_time))
            
        self.last_fetch_time = time.monotonic()
        try:
            import urllib.request
            req = urllib.request.Request(self.api_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            })
            with urllib.request.urlopen(req, timeout=10) as response:
                content = response.read().decode('utf-8').strip()
                first_line = content.split('\n')[0].strip()
                if ":" in first_line:
                    return first_line
        except Exception:
            pass
        return None

proxy_manager = ProxyManager()

MAX_INDEX_PAGES = 30
MAX_NOVEL_DETAIL_PAGES = 60
TIMEOUT_SECONDS = 15
MAX_REDIRECTS = 5
MIN_REQUEST_INTERVAL_SECONDS = 1.0
MAX_REQUEST_JITTER_SECONDS = 1.2
BACKOFF_STATUS_CODES = {403, 429, 503}
TRANSIENT_RETRY_STATUS_CODES = {500, 502, 504}
REQUEST_RETRY_LIMIT = 2
CHAPTER_WORDS = ("第", "章", "章节", "目录", "chapter", "正文", "最新章节", "上一章", "下一章")
CATEGORY_KEYWORDS = {
    "玄幻": ("玄幻", "修真", "仙侠", "奇幻", "武侠", "异界", "大陆", "魔法"),
    "都市": ("都市", "言情", "职场", "总裁", "校园", "青春", "生活"),
    "历史": ("历史", "架空", "穿越", "三国", "大明", "大唐", "朝堂"),
    "科幻": ("科幻", "末世", "星际", "机甲", "未来", "系统", "无限"),
    "悬疑": ("悬疑", "灵异", "推理", "惊悚", "探案", "恐怖"),
    "游戏": ("游戏", "网游", "电竞", "副本", "玩家"),
}
NOISE_PATTERNS = (
    r"请收藏本站.*",
    r"最新网址.*",
    r"手机用户请浏览.*",
    r"本章未完.*",
    r"喜欢.*请.*收藏.*",
    r"一秒记住.*",
    r"『.*?』",
)
_request_lock = threading.Lock()
_last_request_at_by_host: dict[str, float] = {}
_response_cache: dict[str, tuple[float, str, str, str]] = {}
_robots_cache: dict[str, robotparser.RobotFileParser] = {}
CACHE_TTL_SECONDS = 300


class Credentials(BaseModel):
    username: str
    password: str


class CrawlRequest(BaseModel):
    url: HttpUrl
    credentials: Optional[Credentials] = None


class DownloadRequest(BaseModel):
    url: HttpUrl
    title: Optional[str] = None
    credentials: Optional[Credentials] = None


class NovelCandidate(BaseModel):
    title: str
    url: str
    category: str
    tags: list[str]
    description: str
    score: int
    matchedKeywords: list[str]
    wordCount: int
    textLength: int
    chapterHints: int


class CrawlResponse(BaseModel):
    requiresLogin: bool
    loginUrl: Optional[str] = None
    scannedPages: int
    categories: list[str]
    novels: list[NovelCandidate]


class DownloadResponse(BaseModel):
    title: str
    filename: str
    content: str
    chapterCount: int


@app.post("/index")
def index_site(request: CrawlRequest) -> CrawlResponse:
    start_url = str(request.url)
    session = build_session()
    first_response = fetch(session, start_url, raise_for_status=False)
    login_form = find_login_form(first_response.url, first_response.text)
    if is_auth_blocked(first_response) or (login_form and request.credentials is None):
        return CrawlResponse(requiresLogin=True, loginUrl=login_form or first_response.url, scannedPages=1, categories=[], novels=[])

    if login_form and request.credentials is not None:
        do_login(session, login_form, request.credentials)

    def is_list_url(u: str) -> bool:
        parsed_u = urlparse(u)
        path = parsed_u.path.lower()
        if path in ("", "/", "/index.html", "/index.htm", "/index.php"):
            return True
        blacklist_words = ("list", "lists", "rank", "ranking", "hits", "category", "sort", "original", "tag", "tags", "author", "authors", "update", "all", "other")
        return any(word in path for word in blacklist_words)

    root_host = urlparse(start_url).netloc
    queue = deque([start_url])
    seen_lists: set[str] = set()
    novel_urls: set[str] = set()
    site_categories = extract_main_categories(first_response.url, BeautifulSoup(first_response.text, "html.parser"))

    # 1. 扫描所有的分类、排行、列表页，搜集小说页面 URL 集合
    while queue and len(seen_lists) < MAX_INDEX_PAGES:
        current_url = queue.popleft()
        if current_url in seen_lists or urlparse(current_url).netloc != root_host:
            continue

        if not is_list_url(current_url) and len(seen_lists) > 0:
            if is_probable_book_url(current_url):
                novel_urls.add(current_url)
            continue

        seen_lists.add(current_url)

        try:
            response = fetch(session, current_url)
        except requests.RequestException:
            continue

        if "text/html" not in response.headers.get("content-type", ""):
            continue

        raw_soup = BeautifulSoup(response.text, "html.parser")
        site_categories = unique_labels(site_categories + extract_main_categories(response.url, raw_soup))
        soup = clean_soup(response.text)

        for tag in soup.find_all("a", href=True):
            link = normalize_url(urljoin(response.url, tag["href"]))
            if urlparse(link).netloc != root_host:
                continue
            link_text = " ".join(tag.get_text(" ").split())
            if is_probable_book_link(link, link_text):
                novel_urls.add(link)
            elif is_list_url(link) and link not in seen_lists:
                queue.append(link)

    # 2. 温和提取小说页面信息：串行 + 限量，降低触发目标站风控的概率
    target_novel_urls = list(novel_urls)[:MAX_NOVEL_DETAIL_PAGES]
    novels: list[NovelCandidate] = []

    for n_url in target_novel_urls:
        try:
            res = fetch(session, n_url, raise_for_status=False)
            if res.status_code != 200 or "text/html" not in res.headers.get("content-type", ""):
                continue
            s = clean_soup(res.text)
            candidate = detect_novel_candidate(n_url, s)
            if candidate:
                novels.append(candidate)
            if len(novels) >= 40:
                break
        except HTTPException:
            raise
        except Exception:
            continue

    return CrawlResponse(
        requiresLogin=False,
        loginUrl=None,
        scannedPages=len(seen_lists),
        categories=site_categories,
        novels=sorted(novels, key=lambda item: (item.score, item.chapterHints, item.textLength), reverse=True),
    )


@app.post("/download")
def download_novel(request: DownloadRequest) -> DownloadResponse:
    session = build_session()
    page = fetch(session, str(request.url), raise_for_status=False)
    login_form = find_login_form(page.url, page.text)
    if is_auth_blocked(page) or (login_form and request.credentials is None):
        raise HTTPException(status_code=401, detail="该页面需要登录，请先在扫描阶段输入账号密码")

    if login_form and request.credentials is not None:
        do_login(session, login_form, request.credentials)
        page = fetch(session, str(request.url))

    soup = clean_soup(page.text)
    title = request.title or extract_title(page.url, soup)
    root_host = urlparse(str(request.url)).netloc
    chapters: list[tuple[str, str]] = []
    start_chapter_url = find_start_chapter_url(page.url, soup, root_host)
    
    if not start_chapter_url:
        catalog_url = extract_catalog_url(page.url, soup, root_host)
        if catalog_url:
            try:
                catalog_page = fetch(session, catalog_url)
                catalog_soup = clean_soup(catalog_page.text)
                start_chapter_url = find_start_chapter_url(catalog_page.url, catalog_soup, root_host)
                if not start_chapter_url:
                    links = extract_chapter_links(catalog_page.url, catalog_soup, root_host)
                    if links:
                        start_chapter_url = links[-1] if len(links) > 1 and "第" in links[-1] else links[0]
            except requests.RequestException:
                pass

    if not start_chapter_url:
        links = extract_chapter_links(page.url, soup, root_host)
        if links:
            start_chapter_url = links[-1] if len(links) > 20 else links[0]

    if start_chapter_url:
        current_url = start_chapter_url
        seen_urls = set()
        
        while current_url and current_url not in seen_urls:
            seen_urls.add(current_url)
            try:
                chapter_page = fetch(session, current_url, referer=str(request.url))
            except requests.RequestException:
                break
                
            if is_chapter_blocked(chapter_page):
                raise HTTPException(
                    status_code=403,
                    detail=f"章节阅读页触发了验证码/人工验证，已停止生成错误 TXT。请先在浏览器打开验证页完成验证后重试：{chapter_page.url}",
                )
                
            chapter_soup = clean_soup(chapter_page.text)
            chapter_title = extract_title(chapter_page.url, chapter_soup)
            chapter_text = extract_main_text(chapter_soup)
            
            if is_valid_chapter_text(chapter_title, chapter_text):
                chapters.append((chapter_title, chapter_text))
                
            current_url = find_next_page_url(chapter_page.url, chapter_soup, root_host)
    else:
        page_text = extract_main_text(soup)
        if is_valid_chapter_text(title, page_text):
            chapters.append((title, page_text))

    if not chapters:
        raise HTTPException(status_code=422, detail="未能提取到有效章节正文：当前页面更像目录/详情页，或章节正文被站点验证拦截")

    content = format_txt(title, chapters)
    return DownloadResponse(
        title=title,
        filename=safe_filename(title) + ".txt",
        content=content,
        chapterCount=len(chapters),
    )


def build_session() -> requests.Session:
    # 随机选择浏览器类型和版本指纹以应对更严格的风控
    impersonate_targets = ["chrome", "edge", "safari", "chrome110", "edge101", "safari15.5"]
    selected_impersonate = random.choice(impersonate_targets)
    session = Session(impersonate=selected_impersonate)
    session.headers.update({
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    
    # 初始代理配置
    proxies = proxy_manager.get_proxy(force_rotate=False)
    if proxies:
        session.proxies.update(proxies)
        
    return session


def fetch(session: requests.Session, url: str, raise_for_status: bool = True, referer: Optional[str] = None) -> requests.Response:
    current_url = url
    response = None
    for _ in range(MAX_REDIRECTS + 1):
        validate_fetch_url(current_url)
        ensure_robots_allowed(session, current_url)
        cached_response = get_cached_response(current_url)
        if cached_response is not None:
            response = cached_response
            break
        wait_for_host_slot(current_url)
        headers = {"Referer": referer} if referer else None
        response = request_with_transient_retries(session, current_url, headers)
        if response.status_code in BACKOFF_STATUS_CODES:
            retry_after = parse_retry_after(response.headers.get("Retry-After"))
            if retry_after:
                time.sleep(min(retry_after, 20))
            raise HTTPException(
                status_code=429,
                detail=f"目标站点返回 {response.status_code}，疑似触发风控。已停止请求，请等待一段时间后再试。",
            )
        if not response.is_redirect:
            response.encoding = response.apparent_encoding or response.encoding
            soft_block_message = extract_soft_block_message(response.text)
            if soft_block_message:
                raise HTTPException(
                    status_code=429,
                    detail=f"目标站点返回风控提示：{soft_block_message}。已停止请求，请等待提示时间后再试。",
                )
            cache_response(current_url, response)
            break
        location = response.headers.get("location")
        if not location:
            break
        current_url = urljoin(response.url, location)
    if response is None:
        raise HTTPException(status_code=502, detail="请求目标站点失败")
    if response.is_redirect:
        raise HTTPException(status_code=400, detail="目标站点重定向次数过多")
    response.encoding = response.apparent_encoding or response.encoding
    if raise_for_status:
        response.raise_for_status()
    return response


def request_with_transient_retries(
    session: requests.Session,
    url: str,
    headers: Optional[dict[str, str]],
) -> requests.Response:
    max_retries = 3
    
    for attempt in range(max_retries + 1):
        # 1. 频率扰动：每次请求前随机等待 1-3 秒
        time.sleep(random.uniform(1.0, 3.0))
        
        # 2. 获取当前可用代理（如果是重试，则强制换 IP）
        proxies = proxy_manager.get_proxy(force_rotate=(attempt > 0))
        
        # 3. 动态 UA 伪装
        req_headers = dict(headers) if headers else {}
        try:
            ua = ua_generator.random
            if ua:
                req_headers["User-Agent"] = ua
        except Exception:
            pass
            
        try:
            # 4. 发起请求
            response = session.get(
                url,
                timeout=TIMEOUT_SECONDS,
                allow_redirects=False,
                headers=req_headers,
                proxies=proxies
            )
            
            # 5. 如果遭遇封禁状态码 (403, 429)，自动换 IP 重试
            if response.status_code in {403, 429}:
                if attempt < max_retries:
                    continue
                else:
                    raise HTTPException(
                        status_code=response.status_code,
                        detail=f"目标站点返回 {response.status_code}，重试 {max_retries} 次仍被风控限制。当前代理：{proxies}"
                    )
            
            # 5.1 检测软风控提示 (从 response.text 提取)
            if "text/html" in response.headers.get("content-type", ""):
                response.encoding = response.apparent_encoding or response.encoding
                soft_block_message = extract_soft_block_message(response.text)
                if soft_block_message:
                    if attempt < max_retries:
                        continue
                    else:
                        raise HTTPException(
                            status_code=429,
                            detail=f"目标站点返回风控提示：{soft_block_message}。已重试 {max_retries} 次仍被风控限制。当前代理：{proxies}"
                        )
            
            # 6. 其他临时错误重试 (500, 502, 504)
            if response.status_code in TRANSIENT_RETRY_STATUS_CODES and attempt < max_retries:
                sleep_for_retry(attempt)
                continue
                
            return response
            
        except HTTPException:
            # 内部抛出的 HTTPException 直接向上透传，不作捕获
            raise
        except Exception as e:
            # 7. 超时、网络波动异常 -> 切换 IP 重试
            if attempt < max_retries:
                continue
            else:
                raise HTTPException(
                    status_code=502,
                    detail=f"请求目标站点失败，已重试 {max_retries} 次: {e}"
                )
                
    raise HTTPException(status_code=502, detail="请求目标站点失败")


def sleep_for_retry(attempt: int) -> None:
    time.sleep(min(8, 1.5 * (attempt + 1)) + random.uniform(0, MAX_REQUEST_JITTER_SECONDS))


def wait_for_host_slot(url: str) -> None:
    host = urlparse(url).netloc
    with _request_lock:
        now = time.monotonic()
        last_request_at = _last_request_at_by_host.get(host, 0)
        wait_seconds = MIN_REQUEST_INTERVAL_SECONDS - (now - last_request_at)
        if wait_seconds > 0:
            time.sleep(wait_seconds + random.uniform(0, MAX_REQUEST_JITTER_SECONDS))
        _last_request_at_by_host[host] = time.monotonic()


def get_cached_response(url: str) -> Optional[requests.Response]:
    cached = _response_cache.get(url)
    if not cached:
        return None
    created_at, final_url, content_type, text = cached
    if time.monotonic() - created_at > CACHE_TTL_SECONDS:
        _response_cache.pop(url, None)
        return None
    response = requests.Response()
    response.status_code = 200
    response.url = final_url
    response.content = text.encode("utf-8")
    response.encoding = "utf-8"
    response.headers["content-type"] = content_type
    return response


def cache_response(url: str, response: requests.Response) -> None:
    if response.status_code != 200 or "text/html" not in response.headers.get("content-type", ""):
        return
    if len(_response_cache) > 300:
        _response_cache.clear()
    _response_cache[url] = (
        time.monotonic(),
        response.url,
        response.headers.get("content-type", "text/html; charset=utf-8"),
        response.text,
    )


def parse_retry_after(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def extract_soft_block_message(html: str) -> Optional[str]:
    patterns = (
        r'let\s+msg\s*=\s*"([^"]*(?:访问异常|稍后再试|验证|验证码)[^"]*)"',
        r"(访问异常[^<\n\r]+)",
        r"(请于\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*后再试)",
    )
    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            return re.sub(r"\s+", " ", match.group(1)).strip()
    return None


def ensure_robots_allowed(session: requests.Session, url: str) -> None:
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    parser = _robots_cache.get(robots_url)
    if parser is None:
        parser = robotparser.RobotFileParser()
        parser.set_url(robots_url)
        try:
            wait_for_host_slot(robots_url)
            response = session.get(robots_url, timeout=TIMEOUT_SECONDS, allow_redirects=True)
            if response.status_code == 200:
                parser.parse(response.text.splitlines())
            else:
                parser.parse([])
        except requests.RequestException:
            parser.parse([])
        _robots_cache[robots_url] = parser
    user_agent = session.headers.get("User-Agent", "*")
    if not parser.can_fetch(user_agent, url):
        raise HTTPException(status_code=403, detail=f"robots.txt 不允许抓取该地址：{url}")


def validate_fetch_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="仅支持公网 HTTP/HTTPS URL")
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(parsed.hostname, None)}
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="无法解析目标域名") from exc
    for address in addresses:
        parsed_address = ip_address(address)
        address_str = str(parsed_address)
        is_fake_ip = address_str.startswith("198.18.") or address_str.startswith("198.19.")
        if not is_fake_ip and (
            parsed_address.is_private
            or parsed_address.is_loopback
            or parsed_address.is_link_local
            or parsed_address.is_multicast
            # or parsed_address.is_reserved
            or parsed_address.is_unspecified
        ):
            raise HTTPException(status_code=400, detail="出于安全考虑，禁止抓取本机、内网或保留地址")


def is_auth_blocked(response: requests.Response) -> bool:
    return response.status_code in (401, 403)


def find_login_form(page_url: str, html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")
    for form in soup.find_all("form"):
        has_password = form.find("input", {"type": "password"}) is not None
        if has_password:
            return urljoin(page_url, form.get("action") or page_url)
    return None


def do_login(session: requests.Session, login_url: str, credentials: Credentials) -> None:
    page = fetch(session, login_url)
    soup = BeautifulSoup(page.text, "html.parser")
    form = soup.find("form")
    if not form:
        raise HTTPException(status_code=400, detail="未找到登录表单")

    payload: dict[str, str] = {}
    username_field = None
    password_field = None
    for input_tag in form.find_all("input"):
        name = input_tag.get("name")
        if not name:
            continue
        input_type = (input_tag.get("type") or "text").lower()
        payload[name] = input_tag.get("value") or ""
        if input_type in ("text", "email", "tel") and username_field is None:
            username_field = name
        if input_type == "password":
            password_field = name

    if password_field is None:
        raise HTTPException(status_code=400, detail="未找到密码字段")

    payload[username_field or "username"] = credentials.username
    payload[password_field] = credentials.password
    action = urljoin(page.url, form.get("action") or page.url)
    method = (form.get("method") or "post").lower()
    if method == "get":
        session.get(action, params=payload, timeout=TIMEOUT_SECONDS)
    else:
        session.post(action, data=payload, timeout=TIMEOUT_SECONDS)


def clean_soup(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]):
        tag.decompose()
    return soup


def extract_internal_links(page_url: str, soup: BeautifulSoup, root_host: str) -> list[str]:
    links: list[str] = []
    for tag in soup.find_all("a", href=True):
        target = normalize_url(urljoin(page_url, tag["href"]))
        parsed = urlparse(target)
        if parsed.scheme in ("http", "https") and parsed.netloc == root_host:
            links.append(target)
    return list(dict.fromkeys(links))


def unique_urls(urls: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        normalized = normalize_url(url)
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def find_start_chapter_url(page_url: str, soup: BeautifulSoup, root_host: str) -> Optional[str]:
    for tag in soup.find_all("a", href=True):
        text = tag.get_text(" ").strip()
        if any(w in text for w in ("开始阅读", "免费阅读", "点击阅读", "立即阅读")):
            href = normalize_url(urljoin(page_url, tag["href"]))
            if urlparse(href).netloc == root_host:
                return href
    for tag in soup.find_all("a", href=True):
        text = tag.get_text(" ").strip()
        if "最新" in text or "倒序" in text:
            continue
        if any(w in text for w in ("第一章", "第1章", "楔子", "序章")):
            href = normalize_url(urljoin(page_url, tag["href"]))
            if urlparse(href).netloc == root_host:
                return href
    return None


def find_next_page_url(page_url: str, soup: BeautifulSoup, root_host: str) -> Optional[str]:
    for tag in soup.find_all("a", href=True):
        text = tag.get_text(" ").strip()
        if any(w in text for w in ("下一章", "下一页", "下一回")):
            if "目录" in text or "书签" in text or "末页" in text:
                continue
            href = normalize_url(urljoin(page_url, tag["href"]))
            parsed = urlparse(href)
            if parsed.scheme in ("http", "https") and parsed.netloc == root_host:
                if not is_catalog_link(text, href):
                    return href
    return None


def extract_catalog_url(page_url: str, soup: BeautifulSoup, root_host: str) -> Optional[str]:
    for tag in soup.find_all("a", href=True):
        text = " ".join(tag.get_text(" ").split())
        href = normalize_url(urljoin(page_url, tag["href"]))
        parsed = urlparse(href)
        if parsed.scheme not in ("http", "https") or parsed.netloc != root_host:
            continue
        if "查看所有章节" in text or "章节目录" in text or "/other/chapters/" in parsed.path:
            return href
    return None


def extract_chapter_links(page_url: str, soup: BeautifulSoup, root_host: str) -> list[str]:
    scored: list[tuple[int, str]] = []
    scoped_tags = []
    for selector in (
        ".mulu_list a[href]",
        ".book_newchap a[href]",
        ".chapter-list a[href]",
        ".chapters a[href]",
        ".catalog a[href]",
        "a.btn_yuedu[href]",
    ):
        scoped_tags.extend(soup.select(selector))
    tags = scoped_tags or soup.find_all("a", href=True)

    for index, tag in enumerate(tags):
        text = " ".join(tag.get_text(" ").split())
        href = normalize_url(urljoin(page_url, tag["href"]))
        parsed = urlparse(href)
        if parsed.scheme not in ("http", "https") or parsed.netloc != root_host:
            continue
        if is_catalog_link(text, href):
            continue
        score = score_chapter_anchor(text, href)
        if score > 0:
            scored.append((score * 10000 - index, href))
    scored.sort(key=lambda item: item[0], reverse=True)
    return unique_urls([url for _, url in scored])


def is_catalog_link(text: str, href: str) -> bool:
    lower = href.lower()
    return (
        "/other/chapters/" in lower
        or "章节目录" in text
        or "查看所有章节" in text
        or "返回书页" in text
        or "直达底部" in text
    )


def score_chapter_anchor(text: str, href: str) -> int:
    lower = (text + " " + href).lower()
    score = 0
    if re.search(r"/book/\d+/[a-z0-9]+\.html?$", lower):
        score += 8
    if "开始阅读" in text:
        score += 5
    if re.search(r"第\s*[0-9一二三四五六七八九十百千万]+\s*[章节回卷]", text):
        score += 5
    if any(word.lower() in lower for word in CHAPTER_WORDS):
        score += 2
    if re.search(r"/\d+(\.html?)?$", href) and "/lists/" not in lower and "/novel/" not in lower:
        score += 1
    if len(text) > 80 or any(word in lower for word in ("login", "register", "评论", "排行", "lists", "novel")):
        score -= 8
    return score


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(fragment="", query="").geturl().rstrip("/")


def is_probable_book_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    if is_probable_chapter_url(url):
        return False
    return any(word in path for word in ("book", "novel", "info", "detail", "b/")) or bool(
        re.search(r"/(?:book|novel|info|detail)[/_-]?\d+", path)
    )


def is_probable_book_link(url: str, text: str) -> bool:
    if not text or len(text) > 80 or is_probable_chapter_title(text) or is_probable_chapter_url(url):
        return False
    path = urlparse(url).path.lower()
    if any(word in path for word in ("chapter", "read", "content", "txt", "down", "download")):
        return False
    if any(word in path for word in ("book", "novel", "info", "detail")):
        return True
    return bool(re.search(r"/(?:\d{2,}|[a-z0-9_-]*book[a-z0-9_-]*)/?$", path)) and not any(
        word in text for word in ("上一章", "下一章", "目录", "阅读", "最新章节")
    )


def is_probable_chapter_url(url: str) -> bool:
    path = urlparse(url).path.lower()
    if any(word in path for word in ("chapter", "read", "content")):
        return True
    return bool(re.search(r"/\d+/\d+(\.html?)?$", path) or re.search(r"/(?:chapter|read)[_-]?\d+", path))


def is_probable_chapter_title(title: str) -> bool:
    return bool(re.search(r"第\s*[0-9一二三四五六七八九十百千万]+\s*[章节回卷]", title))


def is_non_novel_url(url: str, title: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower()
    
    # 1. 根路径或空路径直接过滤（比如主页）
    if path in ("", "/", "/index.html", "/index.htm", "/index.php"):
        return True
        
    # 2. 检查 path 中的特定聚合/分类/排行关键字
    blacklist_words = ("list", "lists", "rank", "ranking", "hits", "category", "sort", "original", "tag", "tags", "author", "authors", "update", "all", "other")
    path_segments = [seg for seg in path.split("/") if seg]
    for segment in path_segments:
        if any(word in segment for word in blacklist_words):
            return True
            
    # 3. 检查 Title，过滤掉以分类词、网站导航词为主的标题
    title_lower = title.lower()
    blacklist_titles = ("首页", "书屋", "排行榜", "小说分类", "分类列表", "最新更新", "原创专区", "经典小说", "穿越小说", "系统小说", "言情小说", "科幻小说", "玄幻小说", "乡村小说", "明星小说", "萝莉小说", "乱伦小说", "熟女小说", "伪娘小说", "都市小说", "其他小说", "正太小说", "ntr小说", "校园小说", "反差小说", "百合小说", "武侠小说", "纯爱小说", "调教小说", "同人小说", "堕落小说", "奇幻小说", "凌辱小说", "媚黑小说", "搜索结果")
    if any(title_lower == t or title_lower == t + "小说" for t in blacklist_titles):
        return True
    if any(word in title_lower for word in ("排行榜", "小说分类", "书屋首页", "最新发布", "全部小说")):
        return True
        
    return False


def extract_main_categories(page_url: str, soup: BeautifulSoup) -> list[str]:
    candidates: list[str] = []
    category_links = []
    for selector in ("ul.fenlei-item a[href]", ".fenlei-item a[href]", ".foot-list a[href]"):
        category_links.extend(soup.select(selector))

    if not category_links:
        for a in soup.find_all("a", href=True):
            href = normalize_url(urljoin(page_url, a.get("href") or ""))
            text = clean_category_label(a.get_text(" ", strip=True))
            if text and re.search(r"/lists/\d+\.html$", urlparse(href).path):
                category_links.append(a)

    for link in category_links:
        label = clean_category_label(link.get_text(" ", strip=True))
        href = link.get("href") or ""
        if label and not re.search(r"/lists/\d{4,}\.html$", href):
            candidates.append(label)
    return unique_labels(candidates)


def clean_category_label(value: str) -> str:
    label = normalize_label(value.lstrip("#"))
    if is_clean_short_label(label, max_len=5):
        return label
    return ""


def extract_native_category(soup: BeautifulSoup) -> Optional[str]:
    category_from_meta = extract_meta_value(soup, ("book:category", "novel:category", "category"))
    if category_from_meta:
        label = clean_category_label(category_from_meta)
        if label:
            return label

    full_text = soup.get_text("\n")
    patterns = [
        r"分类[：:]\s*([^\s<>/|\-_#\n\r]+)",
        r"类别[：:]\s*([^\s<>/|\-_#\n\r]+)",
        r"类型[：:]\s*([^\s<>/|\-_#\n\r]+)",
        r"题材[：:]\s*([^\s<>/|\-_#\n\r]+)"
    ]
    for pattern in patterns:
        match = re.search(pattern, full_text)
        if match:
            label = clean_category_label(match.group(1))
            if label:
                return label

    scoped_selectors = (
        ".book-info a[href*='/lists/']",
        ".novel-info a[href*='/lists/']",
        ".detail a[href*='/lists/']",
        ".info a[href*='/lists/']",
        ".crumb a[href*='/lists/']",
        ".breadcrumb a[href*='/lists/']",
        "li.home ~ li a[href*='/lists/']",
        "p a[href*='/lists/']",
    )
    for selector in scoped_selectors:
        for a in soup.select(selector):
            label = clean_category_label(a.get_text(" ", strip=True))
            if label:
                return label

    for a in soup.find_all("a"):
        href = a.get("href", "")
        if not re.search(r"/lists/\d+\.html", href):
            continue
        parent_classes = " ".join(a.parent.get("class", []) if a.parent else [])
        if any(noisy in parent_classes for noisy in ("fenlei-item", "foot-list")):
            continue
        label = clean_category_label(a.get_text(" ", strip=True))
        if label:
            return label

    breadcrumbs = soup.find_all(string=re.compile(r">"))
    for bc in breadcrumbs:
        parts = [p.strip() for p in bc.split(">") if p.strip()]
        if len(parts) >= 2:
            cat = parts[-2]
            label = clean_category_label(cat)
            if label:
                return label

    return None


def extract_native_tags(soup: BeautifulSoup, category: str) -> list[str]:
    tags: list[str] = []
    for selector in (
        ".tags_list a[href*='f=tag']",
        ".tags_list a.red",
        ".tag-list a[href*='tag']",
        ".tags a[href*='tag']",
        ".book-tags a[href*='tag']",
        ".novel-tags a[href*='tag']",
        "a[href*='f=tag']",
    ):
        for a in soup.select(selector):
            tags.append(clean_tag_label(a.get_text(" ", strip=True)))

    full_text = soup.get_text("\n")
    for pattern in (r"标签[：:]\s*([^\n\r]+)", r"Tag[s]?[：:]\s*([^\n\r]+)", r"关键词[：:]\s*([^\n\r]+)"):
        match = re.search(pattern, full_text, flags=re.IGNORECASE)
        if match:
            tags.extend(clean_tag_label(part) for part in split_labels(match.group(1)))

    return unique_labels([
        tag for tag in tags
        if tag and tag != category and is_clean_short_label(tag, max_len=5)
    ])[:12]


def clean_tag_label(value: str) -> str:
    label = normalize_label(value.lstrip("#"))
    if is_clean_short_label(label, max_len=5):
        return label
    return ""


def is_clean_short_label(label: str, max_len: int) -> bool:
    if not label or len(label) > max_len:
        return False
    # 过滤纯数字
    if re.fullmatch(r"\d+", label):
        return False
    blocked = ("首页", "小说", "目录", "章节", "最新", "登录", "注册", "更多", "More", "默认", "作者", "标签",
               "下一页", "上一页", "末页", "尾页", "返回", "全部", "排行", "最近更新", "本站",
               "网站", "搜索", "收藏", "书签", "设置", "帮助")
    if label in blocked or any(mark in label for mark in ("第", "章", "最新章节", "下一", "上一")):
        return False
    if re.search(r"[，。！？、,.!?/\\|:：；;（）()《》\u201c\u201d\"' ]", label):
        return False
    return True


def extract_meta_value(soup: BeautifulSoup, names: tuple[str, ...]) -> Optional[str]:
    lowered = {name.lower() for name in names}
    for meta in soup.find_all("meta"):
        key = (meta.get("name") or meta.get("property") or "").lower()
        if key in lowered:
            content = meta.get("content")
            if content:
                return content.strip()
    return None


def split_labels(value: str) -> list[str]:
    return [normalize_label(part) for part in re.split(r"[,，、/|;；\s]+", value) if normalize_label(part)]


def normalize_label(value: str) -> str:
    label = re.sub(r"\s+", "", value).strip("：:｜|-_#[]【】()（）")
    label = label.replace("小说", "")
    if 1 < len(label) <= 12:
        return label
    return ""


def unique_labels(labels: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for label in labels:
        if label and label not in seen:
            result.append(label)
            seen.add(label)
    return result


def detect_novel_candidate(url: str, soup: BeautifulSoup) -> Optional[NovelCandidate]:
    title = extract_title(url, soup)
    if is_non_novel_url(url, title) or is_probable_chapter_title(title) or is_probable_chapter_url(url):
        return None

    text = " ".join(soup.get_text("\n").split())
    chapter_links = extract_chapter_links(url, soup, urlparse(url).netloc)
    chapter_hints = sum(text.lower().count(word.lower()) for word in CHAPTER_WORDS)
    text_length = len(text)
    
    category = extract_native_category(soup)
    if not category:
        category = "未分类"
    tags = extract_native_tags(soup, category)
    word_count = extract_native_word_count(text) or estimate_word_count(text)
    metadata_score = score_book_metadata(text, category, tags)
    score = len(chapter_links) * 4 + metadata_score + min(word_count // 10000, 20)

    if len(chapter_links) >= 3 or metadata_score >= 3:
        return NovelCandidate(
            title=title,
            url=url,
            category=category,
            tags=tags,
            description=build_description(text),
            score=score,
            matchedKeywords=tags,
            wordCount=word_count,
            textLength=text_length,
            chapterHints=chapter_hints,
        )
    return None


def score_book_metadata(text: str, category: str, tags: list[str]) -> int:
    signals = ("作者", "分类", "类别", "类型", "状态", "连载", "完结", "字数", "简介", "书籍", "作品")
    score = sum(1 for signal in signals if signal in text)
    if category != "未分类":
        score += 2
    if tags:
        score += 2
    return score


def extract_native_word_count(text: str) -> Optional[int]:
    patterns = (
        r"(?:字数|全文字数|总字数)[：:\s]*([0-9]+(?:\.[0-9]+)?)\s*(万|千|k|K)?",
        r"([0-9]+(?:\.[0-9]+)?)\s*(万|千|k|K)\s*字",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        number = float(match.group(1))
        unit = match.group(2) if len(match.groups()) >= 2 else None
        if unit == "万":
            number *= 10000
        elif unit in ("千", "k", "K"):
            number *= 1000
        return int(number)
    return None


def estimate_word_count(text: str) -> int:
    chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    english_words = len(re.findall(r"[A-Za-z0-9]+", text))
    return chinese_chars + english_words


def extract_title(url: str, soup: BeautifulSoup) -> str:
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    else:
        heading = soup.find(["h1", "h2"])
        title = heading.get_text(" ", strip=True) if heading else url
    return re.sub(r"[_\-|].*$", "", title).strip() or url


def build_description(text: str) -> str:
    compact = re.sub(r"\s+", " ", clean_text(text)).strip()
    return compact[:140] + ("…" if len(compact) > 140 else "")


def is_chapter_blocked(response: requests.Response) -> bool:
    text = response.text[:3000]
    title_match = re.search(r"<title>(.*?)</title>", text, flags=re.IGNORECASE | re.DOTALL)
    title = title_match.group(1).strip() if title_match else ""
    return (
        "captcha_page" in response.url
        or "访问验证" in title
        or "验证码" in text
        or "人机验证" in text
    )


def extract_main_text(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]):
        tag.decompose()

    selectors = (
        "#content",
        "#chaptercontent",
        "#chapter_content",
        "#BookText",
        ".content",
        ".chapter-content",
        ".chapter_content",
        ".read-content",
        ".article-content",
        ".book-content",
        ".yd_text",
        ".txt",
        ".text",
        ".read",
        ".cont",
        "article",
        "main",
    )
    for selector in selectors:
        for node in soup.select(selector):
            text = clean_text(node.get_text("\n"))
            if is_valid_chapter_text("", text):
                return text

    best = ""
    best_score = -999
    for node in soup.find_all(["article", "main", "section", "div"]):
        classes = " ".join(node.get("class", [])).lower()
        node_id = (node.get("id") or "").lower()
        if any(noisy in f"{classes} {node_id}" for noisy in ("nav", "menu", "footer", "comment", "recommend", "book_newchap", "mulu", "catalog", "tags", "option", "bread")):
            continue
        text = clean_text(node.get_text("\n"))
        if not text:
            continue
        score = len(text) - chapter_catalog_score(text) * 80
        if score > best_score:
            best = text
            best_score = score
    return best if is_valid_chapter_text("", best) else ""


def is_valid_chapter_text(title: str, text: str) -> bool:
    if len(text) < 300:
        return False
    if is_probable_chapter_title(title) and len(text) >= 300:
        return True
    catalog_score = chapter_catalog_score(text)
    content_punctuation = len(re.findall(r"[，。！？；：“”]", text))
    lines = [line for line in text.splitlines() if line.strip()]
    chapter_line_count = sum(1 for line in lines if is_probable_chapter_title(line.strip()))
    if catalog_score >= 8 and chapter_line_count >= max(6, len(lines) // 3):
        return False
    if "章节列表" in text[:300] or "章节目录" in text[:300]:
        return False
    return content_punctuation >= 8


def chapter_catalog_score(text: str) -> int:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return sum(1 for line in lines if is_probable_chapter_title(line))


def clean_text(text: str) -> str:
    lines = []
    seen = set()
    for raw_line in text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line or len(line) <= 1:
            continue
        for pattern in NOISE_PATTERNS:
            line = re.sub(pattern, "", line, flags=re.IGNORECASE)
        if not line or line in seen:
            continue
        seen.add(line)
        lines.append(line)
    return "\n".join(lines)


def format_txt(title: str, chapters: list[tuple[str, str]]) -> str:
    parts = [title.strip(), ""]
    for chapter_title, chapter_text in chapters:
        parts.extend([chapter_title.strip(), "", chapter_text.strip(), ""])
    return "\n".join(parts).replace("\r\n", "\n")


def safe_filename(title: str) -> str:
    filename = re.sub(r'[\\/:*?"<>|]+', "_", title).strip(" .")
    return filename[:80] or "novel"
