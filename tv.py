#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视频节目聚合（纯标准库 + requests）。

数据源：
- 央视《新闻联播》(tv.cctv.com/lm/xwlb)：近 30 天往期 + 当日分条，多码率变体
- BTV《北京新闻》(btime.com)：多路码率流

与 app.py 的网络策略保持一致：默认纯直连，不使用任何系统/环境代理。
"""
import os
import re
import threading
import time

import requests

UA_BROWSER = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

TV_TIMEOUT = float(os.environ.get("TV_TIMEOUT", "15"))
TV_CACHE_TTL = float(os.environ.get("TV_CACHE_TTL", "1800"))

XWLB_URL = "https://tv.cctv.com/lm/xwlb/index.shtml"
XWLB_DAY_URL = "https://tv.cctv.com/lm/xwlb/day/{}.shtml"
# 注意：vdn.apps.cntv.cn 的 TLS 仍是「不安全的旧版重新协商」，OpenSSL 3.x 默认禁用，
# 直接走 https 会报 SSL: UNSAFE_LEGACY_RENEGOTIATION_DISABLED（实测降安全级别、
# 关证书校验都无法救）。该接口的 http 端口稳定可用，所以主用 http，https 仅作兜底。
XWLB_VIDEO_API = "http://vdn.apps.cntv.cn/api/getHttpVideoInfo.do"
XWLB_VIDEO_API_TLS = "https://vdn.apps.cntv.cn/api/getHttpVideoInfo.do"
BJXW_URL = "https://www.btime.com/btv/btvxw_bjxm"
BJXW_INFOFLOW = "https://pc.api.btime.com/btimeweb/infoFlow"
BJXW_TRANS = "https://app.api.btime.com/trans"
BJXW_PLAY = "https://app.api.btime.com/video/play"
XWLB_DAYS = int(os.environ.get("XWLB_DAYS", "30"))   # 侧栏展示的往期天数

# ---- 缓存 ----
_CACHE = {}
_LOCK = threading.Lock()


def _cache_get(key, ttl):
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        return None


def _cache_put(key, val):
    with _LOCK:
        _CACHE[key] = (time.time(), val)


# ---- 网络（默认纯直连，忽略系统/环境代理） ----
# 复用一个 Session：requests.Session 内部的 urllib3 连接池是线程安全的。
_SHARED_SESSION = None
_SHARED_LOCK = threading.Lock()


def _session():
    global _SHARED_SESSION
    s = _SHARED_SESSION
    if s is None:
        with _SHARED_LOCK:
            if _SHARED_SESSION is None:
                s = requests.Session()
                s.trust_env = False          # 忽略环境变量与 Windows 系统代理
                _SHARED_SESSION = s
            else:
                s = _SHARED_SESSION
    return s


def _detect_encoding(resp):
    """优先用响应头 charset，其次 HTML meta，最后 utf-8。

    requests 对没有 charset 头的 text/* 会默认按 ISO-8859-1 解码，
    央视/部分站点正是这种情况，直接 r.text 会得到乱码。
    """
    ctype = resp.headers.get("Content-Type") or ""
    m = re.search(r"charset=([\w\-]+)", ctype, re.I)
    if m:
        return m.group(1)
    try:
        head = resp.content[:4096].decode("ascii", "ignore")
    except Exception:
        head = ""
    m = re.search(r'charset=["\']?([\w\-]+)', head, re.I)
    if m:
        return m.group(1)
    return "utf-8"


def _to_http(url):
    """把 https:// 降级成 http://，对方 TLS 不兼容时的兜底。"""
    if url.startswith("https://"):
        return "http://" + url[len("https://"):]
    return ""


def http_get(url, timeout=None, referer=None, as_json=False, retries=2):
    """GET 一个 URL；返回 (resp, None) 或 (None, 错误串)。直连，不走任何代理。

    retries：公开接口偶发断连/限流，默认重试 1 次。
    """
    headers = {"User-Agent": UA_BROWSER, "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    r = None
    last = None
    for attempt in range(max(1, retries)):
        try:
            r = _session().get(url, headers=headers, timeout=timeout or TV_TIMEOUT)
            break
        except requests.exceptions.SSLError as e:
            # OpenSSL 3.x 默认禁用「不安全的旧版重新协商」，部分老站（如
            # vdn.apps.cntv.cn）握手直接失败，报 UNSAFE_LEGACY_RENEGOTIATION_DISABLED。
            # 这类站的 http 端口一般是通的，降级重试一次。
            last = f"{type(e).__name__}: {e}"
            r = None
            alt = _to_http(url)
            if alt:
                try:
                    r = _session().get(alt, headers=headers, timeout=timeout or TV_TIMEOUT)
                    break
                except Exception as e2:
                    last = f"{type(e2).__name__}: {e2}"
                    r = None
            if attempt + 1 < retries:
                time.sleep(0.8)
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            r = None
            if attempt + 1 < retries:
                time.sleep(0.8)
    if r is None:
        return None, last or "request failed"
    if r.status_code != 200:
        return None, f"HTTP {r.status_code}"
    # 强制按真实编码解码，避免无 charset 的页面出现乱码
    try:
        r.encoding = _detect_encoding(r)
    except Exception:
        r.encoding = "utf-8"
    if as_json:
        try:
            return r.json(), None
        except Exception as e:
            return None, f"bad json: {e}"
    return r, None


# ---------------------------------------------------------------------------
# 同源媒体代理（配合 app.py 的 /api/tv/media）
# HTTPS 部署页面上，http 的媒体会被浏览器当混合内容拦截、HLS 还会被 CORS 拦。
# 播放地址直连优先（https 升级），代理作为前端播放失败时的兜底
# （TV_PROXY_MEDIA=0 可完全关闭 /api/tv/media 兜底）。
# ---------------------------------------------------------------------------
TV_PROXY_MEDIA = os.environ.get("TV_PROXY_MEDIA", "1").lower() not in ("0", "false", "no")


def wrap_media_url(u):
    """把原始流地址包装成 /api/tv/media 代理路径；已是相对路径则原样返回。"""
    if not TV_PROXY_MEDIA or not u or u.startswith("/"):
        return u
    from urllib.parse import quote as _q
    return "/api/tv/media?u=" + _q(u, safe="")


def unwrap_media_url(u):
    """还原代理路径里的原始地址（/api/probe 等需要原始地址的场景）。"""
    if u and u.startswith("/api/tv/media?u="):
        from urllib.parse import unquote as _uq
        return _uq(u.split("u=", 1)[1])
    return u


# ---------------------------------------------------------------------------
# 《新闻联播》 tv.cctv.com/lm/xwlb
# ---------------------------------------------------------------------------
def _parse_xwlb(html, date_hint=""):
    """解析《新闻联播》某一天的节目列表（首页当日 + day/YYYYMMDD 往期通用）。"""
    items = []
    m = re.search(r'rilititle"><p>([\d\-]+)</p>', html)
    page_date = m.group(1) if m else date_hint
    block = html
    b = re.search(r'id="content"[^>]*>(.*?)</ul>', html, re.S)
    if b:
        block = b.group(1)
    for li in re.findall(r"<li>(.*?)</li>", block, re.S):
        um = re.search(r'href="(https://tv\.cctv\.com/[^"]+)"', li)
        im = re.search(r'<img src="(//[^"]+)"', li)
        tm = re.search(r'<i class="sql\d+">([^<]*)</i>([^<]+)</a>', li)
        dm = re.search(r"<span>(\d{1,2}:\d{2}:\d{2})</span>", li)
        if not um:
            continue
        title = (tm.group(2).strip() if tm else "") or um.group(1)
        cover = ("https:" + im.group(1)) if im else ""
        date = page_date
        d2 = re.search(r"/(\d{4})/(\d{2})/(\d{2})/", um.group(1))
        if d2:
            date = f"{d2.group(1)}-{d2.group(2)}-{d2.group(3)}"
        items.append(
            {
                "title": title,
                "cover": cover,
                "url": um.group(1),
                "tag": (tm.group(1).strip() if tm else ""),
                "date": date,
                "duration": dm.group(1) if dm else "",
                "source": "新闻联播",
                "playable": True,
            }
        )
    return items


def _recent_dates(n):
    """最近 n 天（含今天）的日期串，倒序。"""
    import datetime as _dt

    today = _dt.date.today()
    return [(today - _dt.timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n)]


def get_xwlb(force=False, date=None):
    """《新闻联播》：date=YYYY-MM-DD 取往期，默认最新一期。"""
    if date:
        return _get_xwlb_for(date, force)
    key = "tv:prog:xwlb:latest"
    if not force:
        hit = _cache_get(key, TV_CACHE_TTL)
        if hit is not None:
            return hit
    resp, err = http_get(XWLB_URL, referer=XWLB_URL)
    if err:
        return {"ok": False, "error": f"新闻联播页面获取失败：{err}"}
    items = _parse_xwlb(resp.text)
    if not items:
        return {"ok": False, "error": "未解析到新闻联播节目（页面结构可能变化）"}
    # 首页不返回时长，若缺失则用当日往期页补齐
    if not items[0].get("duration"):
        day = items[0].get("date")
        if day:
            dresp, derr = http_get(XWLB_DAY_URL.format(day.replace("-", "")), referer=XWLB_URL)
            if not derr:
                dur = {it["url"]: it.get("duration", "") for it in _parse_xwlb(dresp.text)}
                for it in items:
                    if dur.get(it["url"]):
                        it["duration"] = dur[it["url"]]
    payload = {
        "ok": True,
        "source": "新闻联播",
        "page": XWLB_URL,
        "date": items[0].get("date"),
        "count": len(items),
        "items": items,
        "dates": _recent_dates(XWLB_DAYS),
    }
    _cache_put(key, payload)
    return payload


def _get_xwlb_for(date, force=False):
    key = "tv:prog:xwlb:" + date
    if not force:
        hit = _cache_get(key, TV_CACHE_TTL)
        if hit is not None:
            return hit
    url = XWLB_DAY_URL.format(date.replace("-", ""))
    resp, err = http_get(url, referer=XWLB_URL)
    if err:
        return {"ok": False, "error": f"{date} 页面获取失败：{err}", "date": date}
    items = _parse_xwlb(resp.text, date_hint=date)
    if not items:
        return {
            "ok": False,
            "error": f"{date} 未解析到节目（可能当日无节目或页面结构变化）",
            "date": date,
        }
    payload = {
        "ok": True,
        "source": "新闻联播",
        "page": XWLB_URL,
        "date": items[0].get("date") or date,
        "count": len(items),
        "items": items,
        "dates": _recent_dates(XWLB_DAYS),
    }
    _cache_put(key, payload)
    return payload


def get_xwlb_dates():
    """侧栏用的往期日期列表。"""
    return {"ok": True, "dates": _recent_dates(XWLB_DAYS)}


# ---------------------------------------------------------------------------
# 《北京新闻》 btime.com
# ---------------------------------------------------------------------------
_LISTID_RE = re.compile(r'"listId":"(btv_[0-9a-f]+_s0_(\d{4})_(\d{2}))"')


def _parse_bjxw_listid(html):
    best = None
    for m in _LISTID_RE.finditer(html):
        lid, y, mo = m.group(1), int(m.group(2)), int(m.group(3))
        if best is None or (y, mo) > best[0]:
            best = ((y, mo), lid)
    return best[1] if best else None


def _parse_bjxw(data):
    items = []
    for it in (data or {}).get("data", {}).get("list", []):
        d = it.get("data") or {}
        title = (d.get("title") or "").strip()
        url = it.get("url") or it.get("open_url") or ""
        gid = it.get("gid") or ""
        if not title or not url:
            continue
        covers = d.get("covers") or []
        items.append(
            {
                "title": title,
                "cover": covers[0] if covers else "",
                "url": url,
                "gid": gid,
                "tag": "完整版",
                "date": d.get("pdate_ymd", ""),
                "duration": d.get("duration", ""),
                "source": "北京新闻",
                "playable": True,
            }
        )
    return items


def get_bjxw(force=False):
    key = "tv:prog:bjxw"
    if not force:
        hit = _cache_get(key, TV_CACHE_TTL)
        if hit is not None:
            return hit
    resp, err = http_get(BJXW_URL, referer="https://www.btime.com/")
    if err:
        return {"ok": False, "error": f"北京新闻页面获取失败：{err}"}
    list_id = _parse_bjxw_listid(resp.text)
    if not list_id:
        return {"ok": False, "error": "未找到北京新闻节目列表 ID（页面结构可能变化）"}
    data, err = http_get(
        f"{BJXW_INFOFLOW}?list_id={list_id}&refresh=1&count=20&expands=pageinfo",
        referer=BJXW_URL,
        as_json=True,
    )
    if err:
        return {"ok": False, "error": f"北京新闻列表获取失败：{err}"}
    items = _parse_bjxw(data)
    if not items:
        return {"ok": False, "error": "未解析到北京新闻节目"}
    dates = sorted({it["date"] for it in items if it["date"]}, reverse=True)
    payload = {
        "ok": True,
        "source": "北京新闻",
        "page": BJXW_URL,
        "count": len(items),
        "dates": dates,
        "items": items,
    }
    _cache_put(key, payload)
    return payload


PROGRAMS = {
    "xwlb": {
        "name": "新闻联播",
        "desc": "CCTV《新闻联播》每日更新完整视频与当日分条",
        "getter": get_xwlb,
        "page": XWLB_URL,
    },
    "bjxw": {
        "name": "北京新闻",
        "desc": "BRTV《北京新闻》每日更新完整视频",
        "getter": get_bjxw,
        "page": BJXW_URL,
    },
}


# ---------------------------------------------------------------------------
# 播放地址解析
# ---------------------------------------------------------------------------
def _cctv_video(page_url):
    """从央视视频页取 guid，再取 mp4 地址。

    央视把长视频切成多个 chapter（分片）。以《新闻联播》完整版为例：30 分钟的节目
    在接口里是多个切片。返回完整 playlist（各码率档），由前端顺序连播 + 清晰度切换，
    时长也用真实总长。

    解析结果按页面 URL 缓存（TV_CACHE_TTL，默认 30 分钟）：央视接口对海外服务器
    响应较慢，重复点击同一期节目时直接命中缓存，秒出播放地址。
    """
    key = "tv:resolve:" + page_url
    hit = _cache_get(key, TV_CACHE_TTL)
    if hit is not None:
        return hit
    result = _cctv_video_uncached(page_url)
    if result.get("ok"):
        _cache_put(key, result)
    return result


def _cctv_video_uncached(page_url):
    """从央视视频页取 guid，再取 mp4 地址（无缓存版）。"""
    resp, err = http_get(page_url, referer=page_url)
    if err:
        return {"ok": False, "error": f"页面获取失败：{err}"}
    m = re.search(r'guid\s*=\s*"([0-9a-fA-F]{32})"', resp.text)
    if not m:
        return {"ok": False, "error": "未找到视频 ID"}
    pid = m.group(1)
    # http 优先（vdn.apps.cntv.cn 的 TLS 在 OpenSSL 3.x 下握手失败），https 仅兜底
    info = None
    last_err = None
    for base in (XWLB_VIDEO_API, XWLB_VIDEO_API_TLS):
        got, err = http_get(f"{base}?pid={pid}", referer=page_url, as_json=True)
        if not err and isinstance(got, dict) and got.get("ack") == "yes":
            info = got
            break
        last_err = err or "视频信息接口返回异常"
    if info is None:
        return {"ok": False, "error": f"视频信息获取失败：{last_err}"}
    video = info.get("video") or {}
    # 央视每个节目有 4 档码率变体（chapters=418k / 2=818k / 3=1.2M / 4=2M），
    # 全部解析出来交给前端做清晰度切换与自动升档
    rank_labels = ["流畅", "标清", "高清", "超清", "蓝光"]
    variants = []
    for chs in (video.get("chapters"), video.get("chapters2"),
                video.get("chapters3"), video.get("chapters4")):
        parts = []
        for c in chs or []:
            u = (c.get("url") or "").strip()
            if not u:
                continue
            # HTTPS 页面无法播放 http 媒体（混合内容拦截）。实测 vod.cntv.lxdns.com
            # 的 https 端口正常，统一升级；播放失败时前端自动改走同源代理兜底。
            if u.startswith("http://"):
                u = "https://" + u[len("http://"):]
            # 央视按请求者 IP 返回 CDN：海外解析拿到 vod.cntv.cdn20.com（国际 CDN），
            # 该域名对国内 IP 返回 403，浏览器直连必失败、只能走代理导致卡顿。
            # 同路径在 vod.cntv.lxdns.com（国内 CDN）可直接访问——统一换成国内域名，
            # purl 保留原始地址供代理兜底（Render 所在网络可访问 cdn20）。
            purl = u
            m_host = re.match(r"(https?://)([^/]+)(/.*)", u)
            if m_host and m_host.group(2).lower() == "vod.cntv.cdn20.com":
                u = m_host.group(1) + "vod.cntv.lxdns.com" + m_host.group(3)
            try:
                dur = float(c.get("duration") or 0)
            except (TypeError, ValueError):
                dur = 0.0
            parts.append({"url": u, "duration": dur, "purl": purl})
        if not parts:
            continue
        m = re.search(r"h264(\d+)", parts[0]["url"])
        try:
            bitrate = int(m.group(1)) if m else 0
        except ValueError:
            bitrate = 0
        variants.append({"bitrate": bitrate, "playlist": parts})
    variants.sort(key=lambda v: v["bitrate"] or 0)
    for i, v in enumerate(variants):
        v["key"] = "q%d" % i
        v["label"] = rank_labels[i] if i < len(rank_labels) else "档位%d" % (i + 1)
        v["total"] = sum(p["duration"] for p in v["playlist"])
    if not variants:
        return {"ok": False, "error": "未找到可播放地址"}
    # 默认取最高档「超清 2M」；网络不佳时由前端自动降档兜底
    default = variants[-1]
    parts = default["playlist"]
    # 直连优先：分片已是 https（上面升级），浏览器直连 cntv CDN 最流畅；
    # 播放失败时由前端自动改走 /api/tv/media 代理兜底（见 programs.js）。
    # 时长合计（用接口给的 totalLength 兜底，缺失时用分片之和）
    total = 0.0
    for p in parts:
        total += p["duration"]
    try:
        total_len = float(video.get("totalLength") or 0)
    except (TypeError, ValueError):
        total_len = 0.0
    if total_len > 0 and abs(total_len - total) > 1:
        total = total_len
    return {
        "ok": True,
        "url": parts[0]["url"],          # 第一片（兼容旧字段）
        "type": "mp4",
        "title": info.get("title", ""),
        "duration": total,               # 真实总时长（秒）
        "playlist": parts,               # 默认档分片（兼容旧字段）
        "segments": len(parts),
        "variants": variants,            # 全部清晰度档位（前端切换/自动升档）
        "quality": default["key"],
    }


def _btime_video(page_url, gid=""):
    """北京新闻：app.api.btime.com/video/play 直接返回签名 mp4 地址。"""
    if not gid:
        m = re.search(r"item\.btime\.com/([0-9a-z]+)", page_url or "")
        if not m:
            return {"ok": False, "error": "无法识别的链接", "page": page_url}
        gid = m.group(1)
    data, err = http_get(
        f"{BJXW_PLAY}?from=pc&id={gid}&type_id=3",
        referer=page_url or "https://www.btime.com/",
        as_json=True,
    )
    if err or not isinstance(data, dict) or data.get("errno") != 0:
        return {
            "ok": False,
            "error": "解析失败：" + (err or (data or {}).get("errmsg") or "未知"),
            "page": page_url,
        }
    streams = ((data.get("data") or {}).get("video_stream")) or []
    if not streams:
        return {"ok": False, "error": "未找到可播放地址", "page": page_url}
    # 多路码率 → 清晰度变体（前端切换/自动升档）
    try:
        dur = float((data.get("data") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        dur = 0.0
    variants = []
    for s in streams:
        u = (s.get("stream_url") or "").strip()
        if not u:
            continue
        try:
            rate = float(s.get("stream_rate") or 0)
        except (TypeError, ValueError):
            rate = 0.0
        variants.append({"bitrate": rate, "playlist": [{"url": u, "duration": dur}]})
    variants.sort(key=lambda v: v["bitrate"] or 0)
    rank_labels = ["流畅", "标清", "高清", "超清", "蓝光"]
    for i, v in enumerate(variants):
        v["key"] = "q%d" % i
        v["label"] = rank_labels[i] if i < len(rank_labels) else "档位%d" % (i + 1)
        v["total"] = dur
    if not variants:
        return {"ok": False, "error": "未找到可播放地址", "page": page_url}
    best = variants[-1]              # 默认最高码率（与旧行为一致）
    return {
        "ok": True,
        "url": best["playlist"][0]["url"],
        "type": "mp4",
        "title": "",
        "duration": dur,
        "rate": best["bitrate"],
        "variants": variants,
        "quality": best["key"],
    }


def resolve_video(page_url, gid=""):
    if "tv.cctv.com" in page_url:
        return _cctv_video(page_url)
    if "btime.com" in page_url:
        return _btime_video(page_url, gid=gid)
    return {"ok": False, "error": "不支持的来源", "page": page_url}
