#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 情报台 v0 —— 三条产线，一套配置。

A 共识覆盖：抓所有 A 线源，按标题/实体聚类，同事件被 N 个源复述 = 共识度 N。
            目标不是"我觉得重要"，而是"全网都在说，我不能缺位"。
B 共识前移：定价页/招聘页/GitHub 的页面 diff、arXiv 关键词命中、榜单增量。
            单个弱信号不值钱，同一实体多个弱信号同时出现才算方向。
C 全面性  ：用 配置/实体表.json 当坐标系，算实体矩阵填充率，列出盲区。

用法：
  python3 collector/collect.py                     # 全量跑一次，生成 数据/报告-*.md
  python3 collector/collect.py --line A     # 只跑 A 线
  python3 collector/collect.py --probe      # 只测源可达性
  python3 collector/collect.py --days 7     # C 线回看窗口（默认 7 天）
  python3 collector/collect.py --source example-rss  # 只更新指定源
"""
import argparse
import gzip
import hashlib
import html as html_mod
import json
import re
import ssl
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
import os
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urldefrag, urljoin, urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

ROOT = Path.cwd()
CONFIG = ROOT / "配置"
DATA = ROOT / "数据"
SNAP = DATA / "页面快照"
LEDGER = DATA / "采集台账.jsonl"
STATE = DATA / "去重状态.json"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ai-intel/0.1"
TZ8 = timezone(timedelta(hours=8))
NOW = datetime.now(TZ8)

ALIASES = {}
OWNERS = {}
CHROME = ("skip to", "cookie", "sign in", "subscribe", "contact sales", "privacy", "terms of",
          "all rights reserved", "menu", "toggle", "log in", "newsletter", "share this")


def load_json(p, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default if default is not None else {}


def save_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


_API_CACHE = {}
_HAS_API_CACHE = False


def _load_api_cache():
    global _API_CACHE, _HAS_API_CACHE
    if not _HAS_API_CACHE:
        _API_CACHE = load_json(DATA / "接口缓存.json", {})
        _HAS_API_CACHE = True
    return _API_CACHE


def save_api_cache():
    if _HAS_API_CACHE:
        save_json(DATA / "接口缓存.json", _API_CACHE)


def fetch_json_cached(url, timeout=20):
    """带 ETag 的 JSON 请求：命中 304 直接复用缓存，不消耗 GitHub 配额。"""
    cache = _load_api_cache()
    entry = cache.get(url) or {}
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    if entry.get("etag"):
        headers["If-None-Match"] = entry["etag"]
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            cache[url] = {"etag": r.headers.get("ETag", ""), "body": body}
            return json.loads(body)
    except HTTPError as e:
        if e.code == 304 and entry.get("body"):
            return json.loads(entry["body"])
        raise


def fetch(url, timeout=20, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            return _fetch_once(url, timeout)
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
    raise last


def _fetch_once(url, timeout=20):
    req = Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
    })
    with urlopen(req, timeout=timeout) as r:
        body = r.read()
        if body.startswith(b"\x1f\x8b"):
            body = gzip.decompress(body)
        return body.decode("utf-8", "replace")


def published_dt(value):
    """解析 RSS / Atom 的发布时间；解析不了返回 None。"""
    if not value:
        return None
    try:
        return parsedate_to_datetime(value)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def too_old(item, max_age_days):
    """按发布时间过滤旧文：爬虫抓到的历史帖子不算「今天的情报」。"""
    if not max_age_days:
        return False
    dt = published_dt(item.get("published"))
    if dt is None:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ8)
    return NOW - dt > timedelta(days=max_age_days)


def parse_qwen_articles(body):
    doc = json.loads(body)
    data = doc.get("data") if isinstance(doc, dict) else None
    articles = data.get("articles") if isinstance(data, dict) else None
    if not isinstance(doc, dict) or doc.get("success") is not True or not isinstance(articles, list):
        raise ValueError("Qwen 官网未返回有效文章列表")
    items = []
    for article in articles:
        if not isinstance(article, dict):
            continue
        extra = article.get("extra") or {}
        published = extra.get("date", "") if isinstance(extra, dict) else ""
        title, path = article.get("title"), article.get("path")
        if not isinstance(title, str) or not title.strip() or not isinstance(path, str) or not path.strip() or published_dt(published) is None:
            continue
        items.append({"title": title.strip(), "url": "https://qwen.ai/blog?id=" + quote(path, safe=""),
                      "published": published, "summary": ""})
    if articles and not items:
        raise ValueError("Qwen 文章缺少有效标题、原文路径或发布时间")
    return sorted(items, key=lambda item: item["published"], reverse=True)


def strip_ns(tag):
    return tag.split("}")[-1]


def parse_feed(text):
    """容错解析 RSS 2.0 / Atom。"""
    items = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return items
    for el in root.iter():
        if strip_ns(el.tag) not in ("item", "entry"):
            continue
        d = {}
        for ch in el:
            t = strip_ns(ch.tag)
            if t == "link":
                if not (ch.text or "").strip() and ch.get("rel", "alternate") != "alternate":
                    continue
                val = (ch.text or "").strip() or ch.get("href", "")
            elif t in ("title", "pubDate", "published", "updated", "description", "summary", "id"):
                val = re.sub(r"<[^>]+>", " ", ch.text or "")
                val = html_mod.unescape(re.sub(r"\s+", " ", val)).strip()
            else:
                continue
            if t not in d:
                d[t] = val
        title = d.get("title", "").strip()
        if not title:
            continue
        items.append({
            "title": title,
            "url": d.get("link") or d.get("id") or "",
            "published": d.get("pubDate") or d.get("published") or d.get("updated") or "",
            "summary": d.get("description") or d.get("summary") or "",
        })
    return items


_X_SEEN_LOCK = threading.Lock()
_X_USERNAME = re.compile(r"[A-Za-z0-9_]{1,15}\Z")
_X_STATUS_PATH = re.compile(r"/([A-Za-z0-9_]{1,15})/status/([0-9]{1,25})/?\Z")
_X_PUBLIC_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}


def fetch_x_feed(url):
    """Retry one interrupted transport, never HTTP denial/rate limits or certificate failures."""
    for attempt in range(2):
        try:
            return fetch(url, timeout=15, retries=0)
        except HTTPError:
            raise
        except URLError as error:
            if attempt or not isinstance(error.reason, (ssl.SSLEOFError, ConnectionResetError, TimeoutError)):
                raise
        except (ConnectionResetError, TimeoutError):
            if attempt:
                raise
        time.sleep(2)


def _http_origin(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            return None
        return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except (TypeError, ValueError):
        return None


def normalize_x_items(src, items):
    """Use only the selected author's verifiable post links; other RSS parsing stays unchanged."""
    username = str(src.get("username", "")).strip()
    feed_origin = _http_origin(src.get("url", ""))
    if not _X_USERNAME.fullmatch(username) or feed_origin is None:
        raise ValueError("X 来源必须指定有效 username 和 HTTP(S) RSS 地址")
    normalized = []
    for item in items:
        original_url = item.get("url") or ""
        try:
            target = urlsplit(urljoin(src["url"], original_url))
            origin = _http_origin(target.geturl())
            official = target.hostname and target.hostname.lower() in _X_PUBLIC_HOSTS and target.port in (None, 443 if target.scheme.lower() == "https" else 80)
            if origin is None or (origin != feed_origin and not official):
                continue
            match = _X_STATUS_PATH.fullmatch(target.path)
            if not match or match.group(1).lower() != username.lower():
                continue
            post_id = str(int(match.group(2)))
            if post_id == "0":
                continue
        except (TypeError, ValueError):
            continue
        published = published_dt(item.get("published"))
        if published is None:
            continue
        if published.tzinfo is None:
            published = published.replace(tzinfo=TZ8)
        # Project choice: tolerate up to five minutes of clock skew, never invent a publication time.
        if published > NOW + timedelta(minutes=5):
            continue
        text = item["title"]
        for _ in range(3):
            clean = re.sub(r"^(?:Pinned:\s*|R to @[A-Za-z0-9_]{1,15}:\s*)", "", text, flags=re.I)
            if clean == text:
                break
            text = clean
        text = text.strip()
        if not text:
            continue
        normalized.append({**item, "title": text if len(text) <= 220 else text[:219] + "…",
                           "url": "https://x.com/%s/status/%s" % (username, post_id),
                           "uid": "x:" + post_id, "snippet": text[:6000], "summary": text[:6000],
                           "_original_url": original_url})
    return normalized


def x_events(src, items, state, item_limit):
    events = []
    for item in items:
        if len(events) >= item_limit:
            break
        uid = item["uid"]
        event = {"line": src["line"], "source": src["id"], "kind": "news", "platform": "x",
                 "username": str(src["username"]).strip(), "uid": uid, "snippet": item["snippet"],
                 "entity": detect_entities(item["title"]) or ([src["entity"]] if src.get("entity") else []),
                 "title": item["title"], "url": item["url"], "published": item["published"]}
        key = seen_key(src["id"], item)
        old_urls = {item["_original_url"], urldefrag(item["_original_url"])[0], item["url"]}
        legacy_keys = [seen_key(src["id"], {"url": value}) for value in old_urls]
        # A batch can fetch multiple account/mirror feeds concurrently. Claim post IDs
        # under one lock and persist only emitted posts (or migrate previously emitted legacy seen).
        with _X_SEEN_LOCK:
            permanent = state.setdefault("article_seen", {}).setdefault("x", [])
            if not isinstance(permanent, list):
                raise ValueError("X 永久去重状态格式不正确")
            if uid in permanent:
                continue
            if key in state["seen"] or any(old in state["seen"] for old in legacy_keys):
                permanent.append(uid)
                continue
            events.append(event)
            state["seen"][key] = NOW.date().isoformat()
            permanent.append(uid)
    return events


_VISIBLE_DATE = re.compile(
    r"\d{4}-\d{2}-\d{2}|\d{4}年\d{1,2}月\d{1,2}日|[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}"
)


def _listing_date(value):
    value = re.sub(r"\s+", " ", value).strip()
    if published_dt(value) is not None:
        return value
    for date_format in ("%b %d, %Y", "%B %d, %Y", "%Y年%m月%d日"):
        try:
            return datetime.strptime(value, date_format).date().isoformat()
        except ValueError:
            continue
    return ""


class _ArticleLinkParser(HTMLParser):
    """保留锚点与标题的关系；不把卡片里的日期、摘要和作者拼进标题。"""

    def __init__(self, card_class=None, date_class=None):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.anchor = None
        self.cards = []
        self.card_class = card_class
        self.date_class = date_class
        self.divs = []
        self.date = None
        self.heading_depth = 0
        self.ignored_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.ignored_depth += 1
        if self.ignored_depth:
            return
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "div" and self.card_class:
            is_card = self.card_class in classes
            self.divs.append(is_card)
            if is_card:
                self.cards.append(set())
        if tag == "article":
            self.cards.append(set())
        elif tag == "a":
            self._finish_anchor()
            self.anchor = {
                "href": attrs.get("href", ""),
                "label": (attrs.get("aria-label") or "") if self.card_class and self.cards else "",
                "text": [], "headings": [], "current_heading": None,
                "paragraphs": [], "current_paragraph": None,
                "published": "", "card_dates": self.cards[-1] if self.cards else None, "text_dates": set(),
                "in_heading": self.heading_depth > 0,
            }
        elif tag == "time" or (self.date_class in classes and self.cards):
            self.date = (tag, attrs.get("datetime", ""), [])
        elif re.fullmatch(r"h[1-6]", tag):
            self.heading_depth += 1
            if self.anchor is not None:
                heading = []
                self.anchor["headings"].append(heading)
                self.anchor["current_heading"] = heading
        elif self.anchor is not None and tag == "p":
            paragraph = []
            self.anchor["paragraphs"].append(paragraph)
            self.anchor["current_paragraph"] = paragraph

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.ignored_depth = max(0, self.ignored_depth - 1)
            return
        if self.ignored_depth:
            return
        if tag == "a":
            self._finish_anchor()
        elif tag == "article" and self.cards:
            self.cards.pop()
        elif tag == "div" and self.divs and self.divs.pop():
            self.cards.pop()
        elif self.date is not None and tag == self.date[0]:
            _, value, parts = self.date
            self.date = None
            published = _listing_date(value or "".join(parts))
            if published and self.anchor is not None and not self.anchor["published"]:
                self.anchor["published"] = published
            if published and self.cards:
                self.cards[-1].add(published)
        elif self.anchor is not None and tag == "p":
            self.anchor["current_paragraph"] = None
        elif re.fullmatch(r"h[1-6]", tag):
            self.heading_depth = max(0, self.heading_depth - 1)
            if self.anchor is not None:
                self.anchor["current_heading"] = None

    def handle_data(self, data):
        if self.ignored_depth:
            return
        if self.date is not None:
            self.date[2].append(data)
            return
        if self.anchor is None:
            return
        if not self.heading_depth and _VISIBLE_DATE.fullmatch(data.strip()):
            published = _listing_date(data)
            if published:
                self.anchor["text_dates"].add(published)
                return
        self.anchor["text"].append(data)
        if self.anchor["current_heading"] is not None:
            self.anchor["current_heading"].append(data)
        if self.anchor["current_paragraph"] is not None:
            self.anchor["current_paragraph"].append(data)

    def _finish_anchor(self):
        anchor, self.anchor = self.anchor, None
        if anchor is None:
            return
        headings = [re.sub(r"\s+", " ", "".join(parts)).strip()
                    for parts in anchor["headings"]]
        title = next((text for text in headings if text), "")
        quality = 3 if title or anchor["in_heading"] else 1
        if not title and not anchor["in_heading"]:
            paragraphs = [re.sub(r"\s+", " ", "".join(parts)).strip()
                          for parts in anchor["paragraphs"]]
            title = next((text for text in paragraphs if text and published_dt(text) is None), "")
            if title:
                quality = 2
        if not title:
            title = re.sub(r"\s+", " ", "".join(anchor["text"])).strip()
        if not title and anchor["label"]:
            title, quality = anchor["label"].strip(), 2
        if title:
            published = anchor["published"]
            if not published and len(anchor["text_dates"]) == 1:
                published = next(iter(anchor["text_dates"]))
            self.links.append((anchor["href"], title, quality, published, anchor["card_dates"]))


def parse_article_links(html, base_url, path_pattern, require_title_element=False, *, card_class=None, date_class=None):
    """从文章列表提取同站详情链接；没有原文日期时保持 published 为空。"""
    base = urlsplit(base_url)
    if base.scheme not in ("http", "https") or not base.hostname:
        raise ValueError("html-list requires an HTTP(S) base URL")
    if not isinstance(path_pattern, str) or not path_pattern:
        raise ValueError("html-list requires articlePathPattern")
    pattern = re.compile(path_pattern)
    parser = _ArticleLinkParser(card_class, date_class)
    parser.feed(html)
    parser.close()
    parser._finish_anchor()
    candidates = []
    card_urls = {}
    for href, title, quality, published, card_dates in parser.links:
        if not href:
            continue
        if require_title_element and quality < 2:
            continue
        if (published_dt(title) is not None or re.fullmatch(
                r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}|\d{4}年\d{1,2}月\d{1,2}日", title, re.I)):
            continue
        if re.fullmatch(r"(?:read|learn|view|see)\s+(?:more|all)(?:\s+stories)?\s*[→›»]?|阅读更多|查看更多", title, re.I):
            continue
        try:
            url = urldefrag(urljoin(base_url, href))[0]
            parsed = urlsplit(url)
            if (parsed.scheme not in ("http", "https")
                    or parsed.hostname != base.hostname
                    or parsed.username is not None or parsed.password is not None
                    or not pattern.search(parsed.path)):
                continue
        except ValueError:
            continue
        if card_dates:
            card_urls.setdefault(id(card_dates), set()).add(url)
        candidates.append((url, title, quality, published, card_dates))

    by_url = {}
    for url, title, quality, published, card_dates in candidates:
        # 同卡片仅有一个详情地址时，才将标题旁的日期关联到原文。
        if not published and card_dates and len(card_dates) == 1 and len(card_urls[id(card_dates)]) == 1:
            published = next(iter(card_dates))
        prior = by_url.get(url)
        if prior is None or quality > prior[0]:
            by_url[url] = (quality, {
                "title": title, "url": url,
                "published": published or (prior[1]["published"] if prior else ""), "summary": "",
            })
        elif not prior[1]["published"] and published:
            prior[1]["published"] = published
    return [item for _, item in by_url.values()]


def text_lines(h):
    h = re.sub(r"<script[\s\S]*?</script>", " ", h, flags=re.I)
    h = re.sub(r"<style[\s\S]*?</style>", " ", h, flags=re.I)
    h = re.sub(r"<[^>]+>", "\n", h)
    h = html_mod.unescape(h)
    out = []
    for line in h.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) >= 12:
            out.append(line)
    return out[:6000]


def tokens(s):
    s = s.lower()
    lat = re.findall(r"[a-z0-9][a-z0-9\-\.']{2,}", s)
    cjk = re.findall(r"[\u4e00-\u9fff]", s)
    bigrams = ["".join(cjk[i:i + 2]) for i in range(len(cjk) - 1)]
    return set(lat) | set(bigrams)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def detect_entities(title):
    """ASCII 别名必须按词边界匹配：否则 ssi 会命中 "po-ssi-ble"，yc 会命中 "c-yc-lones"。"""
    t = title.lower()
    found = []
    for eid, keys in ALIASES.items():
        for k in keys:
            if re.match(r"^[a-z0-9 .'\-]+$", k):
                if re.search(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])", t):
                    found.append(eid)
                    break
            elif k in t:
                found.append(eid)
                break
    return found


def ping(url, timeout=15):
    t0 = time.time()
    try:
        fetch(url, timeout=timeout)
        return True, round(time.time() - t0, 2), ""
    except HTTPError as e:
        return False, round(time.time() - t0, 2), "HTTP %s" % e.code
    except URLError as e:
        return False, round(time.time() - t0, 2), str(e.reason)[:60]
    except Exception as e:  # noqa: BLE001
        return False, round(time.time() - t0, 2), type(e).__name__


def seen_key(src_id, item):
    raw = (src_id + "|" + (item.get("uid") or item.get("url") or item.get("title", ""))).lower()
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:16]


def run_source(src, state, verbose=False):
    """返回 (events, health)。A/B 线共用抓取，只是事件语义不同。"""
    sid = src["id"]
    kind = src["type"]
    res = {"id": sid, "line": src["line"], "ok": True, "n": 0, "err": "", "note": ""}
    events = []
    try:
        if kind in ("rss", "arxiv", "qwen-articles"):
            is_x = str(src.get("platform", "")).lower() == "x"
            if is_x and (not _X_USERNAME.fullmatch(str(src.get("username", "")).strip()) or _http_origin(src.get("url", "")) is None):
                raise ValueError("X 来源必须指定有效 username 和 HTTP(S) RSS 地址")
            body = fetch_x_feed(src["url"]) if is_x else fetch(src["url"])
            if kind == "qwen-articles":
                items = parse_qwen_articles(body)
            else:
                try:
                    feed_root = ET.fromstring(body)
                except ET.ParseError as error:
                    raise ValueError("来源未返回有效的 RSS/Atom，而非没有更新") from error
                if strip_ns(feed_root.tag).lower() not in ("rss", "feed", "rdf"):
                    raise ValueError("来源未返回 RSS/Atom，可能为登录或验证页面")
                items = parse_feed(body)
            if is_x:
                raw_count = len(items)
                items = normalize_x_items(src, items)
                if not items:
                    raise ValueError("X RSS 未返回指定作者且有真实发布时间的有效原贴，不能确认源已更新（可能为空、仅转帖或镜像异常）")
                res["note"] = "指定作者原贴 %d / 来源条目 %d" % (len(items), raw_count)
            if src.get("stripFragment"):
                for item in items:
                    item["url"] = urldefrag(item["url"])[0]
            total = len(items)
            # 先过滤（关键词 / 时效 / 排除），再标记已读：
            # 否则被过滤掉的条目也会被记成已读，永远进不来。
            if src.get("keywords"):
                kws = [w.lower() for w in src["keywords"]]
                items = [it for it in items if any(w in (it["title"] + " " + it["summary"]).lower() for w in kws)]
                res["note"] = "总 %d / 关键词命中 %d" % (total, len(items))
            max_age = src.get("maxAgeDays", {"social": 10, "story": 30, "media": 21, "t1": 21, "t2": 21, "t3": 30}.get(src.get("group"), 30))
            if max_age:
                before = len(items)
                items = [it for it in items if not too_old(it, max_age)]
                if before != len(items):
                    res["note"] = (res["note"] + " · " if res["note"] else "") + "过期过滤 %d" % (before - len(items))
            ex = src.get("exclude")
            if ex:
                rx = re.compile(ex, re.I)
                items = [it for it in items if not rx.search(it["title"])]
            item_limit = max(1, min(60, int(src.get("maxItems", 60))))
            if is_x:
                events = x_events(src, items, state, item_limit)
            else:
                fresh = []
                for it in items:
                    if len(fresh) >= item_limit:
                        break
                    k = seen_key(sid, it)
                    if k in state["seen"]:
                        continue
                    state["seen"][k] = NOW.date().isoformat()
                    fresh.append(it)
                for it in fresh:
                    ents = detect_entities(it["title"]) or ([src["entity"]] if src.get("entity") else [])
                    events.append({
                        "line": src["line"], "source": sid, "kind": "paper" if sid.startswith("arxiv") else "news",
                        "entity": ents, "title": it["title"],
                        "url": it["url"], "published": it["published"],
                    })
            res["n"] = len(events)
        elif kind == "html-list":
            items = parse_article_links(fetch(src["url"]), src["url"], src.get("articlePathPattern"),
                                        src.get("articleRequireTitleElement", False),
                                        card_class=src.get("articleCardClass"), date_class=src.get("articleDateClass"))
            total = len(items)
            if not total:
                raise ValueError("文章列表未提取到有效原文链接")
            if src.get("articleRequirePublished"):
                items = [it for it in items if it["published"]]
                if not items:
                    raise ValueError("文章列表未提取到带真实发布时间的原文")
            if src.get("keywords"):
                kws = [word.lower() for word in src["keywords"]]
                items = [it for it in items if any(word in (it["title"] + " " + it["summary"]).lower() for word in kws)]
            max_age = src.get("maxAgeDays", {"social": 10, "story": 30, "media": 21, "t1": 21, "t2": 21, "t3": 30}.get(src.get("group"), 30))
            if max_age:
                items = [it for it in items if not too_old(it, max_age)]
            if src.get("exclude"):
                rx = re.compile(src["exclude"], re.I)
                items = [it for it in items if not rx.search(it["title"])]
            # 文章列表的持久身份不随普通 seen 的 30 天窗口清除。
            # 切换旧页面源时也用它保存已存在的列表基线，避免无日期旧文回灌。
            article_seen = state.setdefault("article_seen", {}).setdefault(sid, [])
            known_articles = set(article_seen)
            for it in items:
                if len(events) >= 60:
                    break
                k = seen_key(sid, it)
                if k in state["seen"] or k in known_articles:
                    continue
                events.append({
                    "line": src["line"], "source": sid, "kind": "news",
                    "entity": detect_entities(it["title"]) or ([src["entity"]] if src.get("entity") else []),
                    "title": it["title"], "url": it["url"],
                    "published": it["published"],
                })
                state["seen"][k] = NOW.date().isoformat()
                article_seen.append(k)
                known_articles.add(k)
            res["n"] = len(events)
            res["note"] = "文章链接 %d / 过滤后 %d / 新增 %d" % (total, len(items), len(events))
        elif kind == "page":
            txt = text_lines(fetch(src["url"]))
            fp = SNAP / (sid + ".json")
            old = load_json(fp, {"lines": []})
            old_lines = old.get("lines", []) if isinstance(old, dict) else []
            new_lines = [l for l in txt if l not in set(old_lines)]
            if not old_lines:
                res["note"] = "建立基线 %d 行（下次跑才有 diff）" % len(txt)
                save_json(fp, {"lines": txt, "updated": NOW.isoformat(timespec="seconds")})
                res["n"] = 0
                return events, res
            new_lines = [l for l in new_lines if not any(c in l.lower() for c in CHROME)]
            dedup, seen_l = [], set()
            for l in new_lines:
                if l not in seen_l:
                    seen_l.add(l); dedup.append(l)
            new_lines = dedup
            res["note"] = "新增 %d 行 / 基线 %d 行" % (len(new_lines), len(old_lines))
            save_json(fp, {"lines": txt, "updated": NOW.isoformat(timespec="seconds")})
            for l in new_lines[:12]:
                events.append({
                    "line": "B", "source": sid, "kind": "diff",
                    "entity": detect_entities(l), "title": l[:180],
                    "url": src["url"], "published": NOW.isoformat(timespec="minutes"),
                })
            res["n"] = len(events)
        elif kind == "arxiv-api":
            # 按公司/模型名去 arXiv 检索（官方技术报告为主）
            query = src.get("query", "")
            limit = int(src.get("maxResults", 12))
            url = (
                "https://export.arxiv.org/api/query?search_query=%s&start=0&max_results=%d"
                "&sortBy=submittedDate&sortOrder=descending" % (quote(query, safe=""), limit)
            )
            items = parse_feed(fetch(url))
            fresh = []
            for it in items:
                k = seen_key(sid, it)
                if k in state["seen"]:
                    continue
                state["seen"][k] = NOW.date().isoformat()
                fresh.append(it)
            max_age = src.get("maxAgeDays", 60)
            fresh = [it for it in fresh if not too_old(it, max_age)]
            for it in fresh[:limit]:
                events.append({
                    "line": "B", "source": sid, "kind": "paper",
                    "entity": [src["entity"]] if src.get("entity") else detect_entities(it["title"]),
                    "title": it["title"], "url": it["url"], "published": it["published"],
                })
            res["n"] = len(events)
            res["note"] = "arXiv %d 条" % len(events)
        elif kind == "openalex":
            # 按机构检索论文（官方论文：作者单位就是这家公司）
            inst = src.get("institutionId", "")
            limit = int(src.get("maxResults", 20))
            days_back = int(src.get("daysBack", 45))
            since = (NOW - timedelta(days=days_back)).strftime("%Y-%m-%d")
            url = (
                "https://api.openalex.org/works?filter=institutions.id:%s,from_publication_date:%s"
                "&per_page=%d&sort=publication_date:desc" % (inst, since, limit)
            )
            payload = json.loads(fetch(url))
            fresh = []
            for work in payload.get("results", []) if isinstance(payload, dict) else []:
                title = (work.get("display_name") or "").strip()
                if not title:
                    continue
                link = ((work.get("primary_location") or {}).get("landing_page_url")
                        or work.get("doi") or work.get("id") or "")
                item = {
                    "uid": "oa:%s" % work.get("id"),
                    "title": title,
                    "url": link,
                    "published": work.get("publication_date", ""),
                }
                k = seen_key(sid, item)
                if k in state["seen"]:
                    continue
                state["seen"][k] = NOW.date().isoformat()
                fresh.append(item)
            for it in fresh[:limit]:
                events.append({
                    "line": "B", "source": sid, "kind": "paper", "official": True,
                    "entity": [src["entity"]] if src.get("entity") else [],
                    "title": it["title"], "url": it["url"], "published": it["published"],
                })
            res["n"] = len(events)
            res["note"] = "OpenAlex %d 条" % len(events)
        elif kind == "github-repos":
            # 官方组织的开源仓库活跃度（发版以外的官方动作：新仓库、重大更新）
            org = src.get("org", "")
            limit = int(src.get("maxResults", 10))
            min_stars = int(src.get("minStars", 300))
            payload = fetch_json_cached("https://api.github.com/orgs/%s/repos?sort=pushed&per_page=30" % org)
            fresh = []
            for repo in payload if isinstance(payload, list) else []:
                if int(repo.get("stargazers_count") or 0) < min_stars:
                    continue
                pushed = repo.get("pushed_at") or ""
                if not pushed:
                    continue
                if too_old({"published": pushed}, src.get("maxAgeDays", 10)):
                    continue
                item = {
                    "uid": "gr:%s:%s" % (repo.get("full_name"), pushed[:10]),
                    "title": "%s 更新（%s★）" % (repo.get("full_name"), repo.get("stargazers_count")),
                    "url": repo.get("html_url", ""),
                    "published": pushed,
                }
                k = seen_key(sid, item)
                if k in state["seen"]:
                    continue
                state["seen"][k] = NOW.date().isoformat()
                fresh.append(item)
            for it in fresh[:limit]:
                events.append({
                    "line": "A", "source": sid, "kind": "news", "official": True,
                    "entity": [src["entity"]] if src.get("entity") else [],
                    "title": it["title"], "url": it["url"], "published": it["published"],
                })
            res["n"] = len(events)
            res["note"] = "GitHub 仓库 %d 条" % len(events)
        elif kind == "github-events":
            # 官方组织在 GitHub 上的活动：发版、新建仓库、开源
            org = src.get("org", "")
            limit = int(src.get("maxResults", 25))
            payload = fetch_json_cached("https://api.github.com/orgs/%s/events?per_page=%d" % (org, limit))
            allowed = src.get("eventTypes") or ["ReleaseEvent", "CreateEvent", "PublicEvent"]
            fresh = []
            for ev in payload if isinstance(payload, list) else []:
                etype = ev.get("type")
                if etype not in allowed:
                    continue
                if etype == "CreateEvent" and (ev.get("payload") or {}).get("ref_type") != "repo":
                    continue
                repo = (ev.get("repo") or {}).get("name", "")
                detail = ""
                link = "https://github.com/%s" % repo if repo else ""
                if etype == "ReleaseEvent":
                    release = (ev.get("payload") or {}).get("release") or {}
                    detail = release.get("tag_name") or release.get("name") or ""
                    link = release.get("html_url") or link
                    title = "%s 发布新版本 %s" % (repo, detail)
                elif etype == "CreateEvent":
                    ref_type = (ev.get("payload") or {}).get("ref_type") or "repo"
                    detail = (ev.get("payload") or {}).get("ref") or ""
                    title = "%s 新建%s %s" % (repo, "仓库" if ref_type == "repo" else "分支/标签", detail)
                else:
                    title = "%s 转为公开" % repo
                item = {
                    "uid": "gh:%s" % ev.get("id"),
                    "title": title,
                    "url": link,
                    "published": ev.get("created_at", ""),
                }
                k = seen_key(sid, item)
                if k in state["seen"]:
                    continue
                state["seen"][k] = NOW.date().isoformat()
                fresh.append(item)
            for it in fresh[:limit]:
                events.append({
                    "line": "A", "source": sid, "kind": "news",
                    "entity": [src["entity"]] if src.get("entity") else [],
                    "title": it["title"], "url": it["url"], "published": it["published"],
                })
            res["n"] = len(events)
            res["note"] = "GitHub 活动 %d 条" % len(events)
        else:
            res["ok"] = False
            res["err"] = "unknown type: " + kind
    except Exception as e:  # noqa: BLE001
        res["ok"] = False
        res["err"] = (str(e) or type(e).__name__)[:70]
    if verbose:
        print("  [%s] %-20s %-4s n=%-3d %s %s" % (
            "ok" if res["ok"] else "!!", sid, src["line"], res["n"], res["note"], res["err"]), file=sys.stderr)
    return events, res


def cluster(items):
    """把 A 线条目按标题相似度 + 实体重叠聚成事件簇。"""
    clusters = []
    for it in items:
        tok = tokens(it["title"])
        placed = False
        for c in clusters:
            j = jaccard(tok, c["tokens"])
            shared = bool(set(it["entity"]) & c["entities"])
            if j >= 0.32 or (shared and j >= 0.18):
                c["items"].append(it)
                c["tokens"] |= tok
                c["entities"] |= set(it["entity"])
                placed = True
                break
        if not placed:
            clusters.append({"items": [it], "tokens": tok, "entities": set(it["entity"])})
    for c in clusters:
        c["sources"] = {i["source"] for i in c["items"]}
        c["owners"] = {OWNERS.get(i["source"], i["source"]) for i in c["items"]}
        c["n_sources"] = len(c["owners"])
    clusters.sort(key=lambda c: (-c["n_sources"], -len(c["items"])))
    return clusters


def load_ledger(days):
    cutoff = (NOW - timedelta(days=days)).isoformat()
    rows = []
    if LEDGER.exists():
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("ts", "") >= cutoff and e.get("hiddenReason") != "page-fragment":
                rows.append(e)
    return rows


def build_report(sources, health, entities, ledger, days):
    ent_meta = {e["id"]: e for e in entities.get("entities", [])}
    out = []
    w = out.append
    w("# AI 情报台 · %s" % NOW.strftime("%Y-%m-%d %H:%M"))
    w("")
    w("源健康：%d/%d 可用 · 台账窗口 %d 天 · 事件 %d 条" % (
        sum(1 for h in health if h["ok"]), len(health), days, len(ledger)))
    bad = [h for h in health if not h["ok"]]
    if bad:
        w("")
        w("**抓取失败**：" + "、".join("%s(%s)" % (h["id"], h["err"][:28]) for h in bad))
    w("")

    # ---------- A 线 ----------
    if True:
        a_events = [e for e in ledger if e["line"] == "A"]
        w("## A · 共识覆盖（掉了就缺位）")
        w("")
        clusters = cluster(a_events)
        consensus = [c for c in clusters if c["n_sources"] >= 2]
        single = [c for c in clusters if c["n_sources"] == 1]
        w("共识事件 **%d** 个（≥2 个独立源复述）· 单源事件 %d 个" % (len(consensus), len(single)))
        w("")
        if consensus:
            w("| 独立主体 | 事件 | 源 |")
            w("|---|---|---|")
            for c in consensus[:12]:
                title = max(c["items"], key=lambda x: len(x["title"]))["title"]
                w("| %d | %s | %s |" % (c["n_sources"], title.replace("|", "／")[:110], "、".join(sorted(c["owners"]))))
        else:
            w("_本次没有多源复述的事件。首轮跑通常如此，第二周才有对比价值。_")
        w("")
        # 实体热度：被多少个「独立发布主体」提到，是共识度的粗代理
        hot = {}
        for e in a_events:
            for eid in e.get("entity", []):
                h = hot.setdefault(eid, {"owners": set(), "n": 0, "ex": e})
                h["owners"].add(OWNERS.get(e["source"], e["source"]))
                h["n"] += 1
        ranked = sorted(hot.items(), key=lambda kv: (-len(kv[1]["owners"]), -kv[1]["n"]))
        w("**实体热度**（被几个独立主体提到 · 共识度的粗代理）")
        w("")
        w("| 实体 | 独立主体 | 条数 | 代表事件 |")
        w("|---|---|---|---|")
        for eid, h in ranked[:10]:
            w("| %s | %d | %d | [%s](%s) |" % (
                eid, len(h["owners"]), h["n"],
                h["ex"]["title"].replace("|", "／")[:70], h["ex"]["url"]))
        w("")
        if single:
            w("<details><summary>单源事件 %d 条（未形成共识，按实体分组）</summary>" % len(single))
            w("")
            by_ent = {}
            for c in single:
                it = c["items"][0]
                key = it["entity"][0] if it["entity"] else "未识别"
                by_ent.setdefault(key, []).append(it)
            for k, v in sorted(by_ent.items(), key=lambda kv: -len(kv[1])):
                w("- **%s**（%d）" % (k, len(v)))
                for it in v[:6]:
                    w("  - [%s](%s) `%s`" % (it["title"][:100], it["url"], it["source"]))
            w("")
            w("</details>")
            w("")

    # ---------- B 线 ----------
    w("## B · 共识前移（抢先的地方）")
    w("")
    b_events = [e for e in ledger if e["line"] == "B"]
    diffs = [e for e in b_events if e["kind"] == "diff"]
    papers = [e for e in b_events if e["kind"] == "paper"]
    news_b = [e for e in b_events if e["kind"] == "news"]
    w("页面变化 **%d** · 论文命中 **%d** · 其他一手更新 **%d**" % (len(diffs), len(papers), len(news_b)))
    w("")
    if diffs:
        w("**页面 diff（领先指标）**")
        w("")
        for e in diffs[:14]:
            w("- `%s` %s  " % (e["source"], (e["title"] or "")[:150]))
            w("  %s" % e["url"])
        w("")
    if papers:
        w("**论文（能力领先 3–6 个月）**")
        w("")
        for e in papers[:12]:
            w("- [%s](%s) · %s" % (e["title"][:110], e["url"], e["published"][:16]))
        w("")
    if news_b:
        w("**一手更新（非媒体）**")
        w("")
        for e in news_b[:12]:
            w("- %s —— `%s`" % (e["title"][:110], e["source"]))
        w("")
    # 弱信号共现
    by_ent = {}
    for e in b_events:
        for eid in e["entity"]:
            by_ent.setdefault(eid, []).append(e)
    converge = {k: v for k, v in by_ent.items() if len({x["source"] for x in v}) >= 2}
    w("**弱信号共现**：%s" % ("同一实体出现 ≥2 个独立信号 = 值得当成方向看。" if converge else "本次无。单信号先记着，别急着下判断。"))
    w("")
    for k, v in sorted(converge.items(), key=lambda kv: -len(kv[1]))[:8]:
        w("- **%s**：%d 条信号来自 %s" % (k, len(v), "、".join(sorted({x["source"] for x in v}))))
    w("")

    # ---------- C 线 ----------
    w("## C · 全面性（实体矩阵）")
    w("")
    ent_ids = [e["id"] for e in entities.get("entities", [])]
    cov = {eid: 0 for eid in ent_ids}
    for e in ledger:
        for eid in e.get("entity", []):
            if eid in cov:
                cov[eid] += 1
    filled = [k for k, v in cov.items() if v > 0]
    blind = [k for k, v in cov.items() if v == 0]
    w("回看 **%d** 天 · 实体 **%d** 个 · 有记录 **%d** 个 · **盲区 %d 个** · 填充率 **%.0f%%**" % (
        days, len(ent_ids), len(filled), len(blind), 100.0 * len(filled) / max(1, len(ent_ids))))
    w("")
    if blind:
        by_tier = {}
        for eid in blind:
            by_tier.setdefault(str(ent_meta.get(eid, {}).get("tier", "?")), []).append(
                ent_meta.get(eid, {}).get("name", eid))
        for tier in sorted(by_tier):
            w("- **T%s 盲区**：%s" % (tier, "、".join(by_tier[tier])))
        w("")
    w("> 全面性不是「源够多」，是「这张矩阵没有空格」。空格不是删掉它，是去补它。")
    w("")
    w("---")
    w("")
    w("## 今天的动作")
    w("")
    w("- [ ] A 线：共识事件里如果有一条你还不知道，说明覆盖面有洞 —— 记下来是哪个源漏了")
    w("- [ ] B 线：共现实体挑一个，问自己「三个月后这件事成了共识，现在最早的证据是什么」")
    w("- [ ] C 线：盲区里挑 2 个，下周补源或补人（不是补信息）")
    return "\n".join(out)


def main():
    global CONFIG, DATA, SNAP, LEDGER, STATE
    ap = argparse.ArgumentParser()
    ap.add_argument("--library-dir", type=Path, default=Path.cwd())
    ap.add_argument("--line", choices=["A", "B"], default=None)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--source", action="append", default=None, help="只更新指定源 ID，可重复传入")
    args = ap.parse_args()

    root = args.library_dir.resolve()
    CONFIG = root / "配置"
    DATA = root / "数据"
    SNAP = DATA / "页面快照"
    LEDGER = DATA / "采集台账.jsonl"
    STATE = DATA / "去重状态.json"

    cfg = load_json(CONFIG / "信息源.json", {"sources": []})
    entities = load_json(CONFIG / "实体表.json", {"entities": []})
    ALIASES.update({
        entity["id"]: [alias.lower() for alias in (entity.get("aliases") or [entity.get("name")]) if isinstance(alias, str) and alias]
        for entity in entities.get("entities", [])
    })
    OWNERS.update({source["id"]: source["owner"] for source in cfg.get("sources", []) if source.get("owner")})
    requested_ids = set(args.source or [])
    known_ids = {s["id"] for s in cfg["sources"]}
    unknown_ids = requested_ids - known_ids
    if unknown_ids:
        ap.error("未知信息源 ID：" + ", ".join(sorted(unknown_ids)))
    sources = [s for s in cfg["sources"] if s.get("enabled", True)
               if (not args.line or s["line"] == args.line)
               and (not requested_ids or s["id"] in requested_ids)]
    if not sources:
        ap.error("当前筛选没有匹配的信息源")
    DATA.mkdir(parents=True, exist_ok=True)
    SNAP.mkdir(parents=True, exist_ok=True)

    if args.probe:
        print("%-6s %-22s %-5s %-8s %s" % ("结果", "id", "线", "耗时", "备注"))
        with ThreadPoolExecutor(max_workers=10) as ex:
            futs = {ex.submit(ping, s["url"]): s for s in sources}
            for f in as_completed(futs):
                s = futs[f]
                ok, dt, err = f.result()
                print("%-6s %-22s %-5s %-8s %s" % ("OK" if ok else "FAIL", s["id"], s["line"], "%.2fs" % dt, err))
        return

    state = load_json(STATE, {"seen": {}})
    state.setdefault("seen", {})

    print("抓取 %d 个源……" % len(sources), file=sys.stderr)
    events, health = [], []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(run_source, s, state, True): s for s in sources}
        for f in as_completed(futs):
            ev, h = f.result()
            events.extend(ev)
            health.append(h)
    health.sort(key=lambda h: h["id"])
    save_json(DATA / "最近采集结果.json", {"runAt": NOW.isoformat(), "sources": health})

    # 写入台账
    with LEDGER.open("a", encoding="utf-8") as fh:
        for e in events:
            e["ts"] = NOW.isoformat(timespec="seconds")
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")

    # 修剪 seen（30 天）
    cut = (NOW - timedelta(days=30)).date().isoformat()
    state["seen"] = {k: v for k, v in state["seen"].items() if v >= cut}
    save_json(STATE, state)

    save_api_cache()

    ledger = load_ledger(args.days)
    report = build_report(sources, health, entities, ledger, args.days)
    rp = DATA / ("报告-%s.md" % NOW.strftime("%Y%m%d-%H%M"))
    rp.write_text(report, encoding="utf-8")

    print("", file=sys.stderr)
    print("事件 %d 条 · 台账累计 %d 条(近%d天) · 报告 %s" % (len(events), len(ledger), args.days, rp), file=sys.stderr)
    print(report)


if __name__ == "__main__":
    main()
