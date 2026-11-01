"use strict";

const video = document.getElementById("video");
const listEl = document.getElementById("progList");
const srcChipsEl = document.getElementById("srcChips");
const dateChipsEl = document.getElementById("dateChips");
const itemLabel = document.getElementById("itemLabel");
const nowTitle = document.getElementById("nowTitle");
const nowMeta = document.getElementById("nowMeta");
const nowStatus = document.getElementById("nowStatus");

const SOURCES = [
  { key: "xwlb", label: "📺 新闻联播", desc: "CCTV《新闻联播》每日更新完整视频与当日分条" },
  { key: "bjxw", label: "📡 北京新闻", desc: "BRTV《北京新闻》每日更新完整视频" },
];

let currentSrc = "xwlb";
let dates = [];
let currentDate = "";
let items = [];
let currentItem = null;
let currentHls = null;

function setStatus(t) { nowStatus.textContent = t; }

// ---------- 来源切换 ----------
function renderSrcChips() {
  srcChipsEl.innerHTML = "";
  SOURCES.forEach((s) => {
    const el = document.createElement("button");
    el.className = "nav-btn" + (s.key === currentSrc ? " active" : "");
    el.textContent = s.label;
    el.onclick = () => {
      if (s.key === currentSrc) return;
      currentSrc = s.key;
      currentDate = "";
      renderSrcChips();
      load();
    };
    srcChipsEl.appendChild(el);
  });
}

// ---------- 日期 chips ----------
function renderDateChips() {
  dateChipsEl.innerHTML = "";
  if (!dates.length) {
    dateChipsEl.innerHTML = '<span class="side-hint">该来源按节目聚合，无需选日期</span>';
    return;
  }
  dates.forEach((d) => {
    const el = document.createElement("div");
    el.className = "chip" + (d === currentDate ? " active" : "");
    el.textContent = d.slice(5);            // 10-21
    el.title = d;
    el.onclick = () => {
      if (d === currentDate) return;
      currentDate = d;
      renderDateChips();
      load();
    };
    dateChipsEl.appendChild(el);
  });
}

// ---------- 加载 ----------
let loadToken = 0;
function load(retryLeft) {
  const myToken = ++loadToken;
  if (typeof retryLeft !== "number") retryLeft = 2;
  setStatus(retryLeft === 2 ? "正在加载…" : "正在重试…");
  listEl.innerHTML = '<div class="side-hint">正在加载…</div>';

  let q = "/api/tv/programs?src=" + encodeURIComponent(currentSrc);
  if (currentDate) q += "&date=" + encodeURIComponent(currentDate);

  fetch(q)
    .then((r) => r.json())
    .then((d) => {
      if (myToken !== loadToken) return;
      if (d.ok) {
        items = d.items || [];
        dates = d.dates || [];
        if (d.date) currentDate = d.date;          // 以服务端返回的实际日期为准
        if (!currentDate && dates.length) currentDate = dates[0];
        renderDateChips();
        renderList();
        const meta = d.meta || {};
        itemLabel.textContent = (meta.name || "") + (d.date ? " · " + d.date : "");
        setStatus("共 " + (d.count || items.length) + " 期节目");
        return;
      }
      if (retryLeft > 0) {
        setTimeout(() => { if (myToken === loadToken) load(retryLeft - 1); }, 1200);
        return;
      }
      listEl.innerHTML = '<div class="side-hint">加载失败：' + (d.error || "未知错误") + "</div>";
      setStatus("加载失败");
    })
    .catch((e) => {
      if (myToken !== loadToken) return;
      if (retryLeft > 0) {
        setTimeout(() => { if (myToken === loadToken) load(retryLeft - 1); }, 1200);
        return;
      }
      listEl.innerHTML = '<div class="side-hint">加载失败：' + e + "</div>";
      setStatus("加载失败");
    });
}

// ---------- 节目列表 ----------
function renderList() {
  listEl.innerHTML = "";
  if (!items.length) {
    listEl.innerHTML = '<div class="side-hint">暂无节目</div>';
    return;
  }
  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "side-item" + (currentItem && currentItem.url === it.url ? " active" : "");

    const thumb = document.createElement("div");
    thumb.className = "side-thumb";
    if (it.cover) {
      const img = document.createElement("img");
      img.src = it.cover;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = () => { thumb.textContent = "🎬"; };
      thumb.appendChild(img);
    } else {
      thumb.textContent = "🎬";
    }

    const body = document.createElement("div");
    body.className = "side-body";
    const t = document.createElement("div");
    t.className = "side-title";
    t.textContent = it.title;
    const m = document.createElement("div");
    m.className = "side-meta";
    m.textContent = (it.duration ? it.duration + " · " : "") + (it.tag || it.source || "");
    body.appendChild(t);
    body.appendChild(m);

    el.appendChild(thumb);
    el.appendChild(body);
    el.onclick = () => playItem(it);
    listEl.appendChild(el);
  });
}

// ---------- 播放 ----------
function destroyHls() {
  if (currentHls) {
    try { currentHls.destroy(); } catch (e) {}
    currentHls = null;
  }
}

// ---------- 时长格式化（秒 -> HH:MM:SS / MM:SS） ----------
function fmtDur(sec) {
  sec = Math.round(Number(sec) || 0);
  if (!sec) return "";
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}

// ---------- 分片连播（央视把长视频切成多个 chapter） ----------
var playlist = [];        // [{url, duration}]
var segIndex = 0;
var segProxied = false;   // 直连失败后改走服务器代理兜底

function playSegment(i) {
  if (i >= playlist.length) {
    setStatus("✓ 已播放完整内容（共 " + playlist.length + " 段）");
    return;
  }
  segIndex = i;
  var seg = playlist[i];
  // 直连优先（https 升级，绕过混合内容且不经服务器，最流畅）；
  // 出错时 error 监听器会把 segProxied 置真并重放本段，改走同源代理兜底。
  var u = seg.url;
  if (segProxied) {
    var raw = (u.indexOf("http") === 0) ? u : location.origin + u;
    u = "/api/tv/media?u=" + encodeURIComponent(raw);
  } else if (location.protocol === "https:" && u.indexOf("http://") === 0) {
    u = "https://" + u.slice(7);
  }
  video.src = u;
  var p = video.play();
  if (p && p.catch) p.catch(function () { setStatus("请点击播放器中的播放按钮"); });
  if (playlist.length > 1) {
    setStatus("● 播放中 · 第 " + (i + 1) + "/" + playlist.length + " 段" +
      (seg.duration ? "（" + fmtDur(seg.duration) + "）" : ""));
  } else {
    setStatus("● 播放中");
  }
}

video.addEventListener("ended", function () {
  if (playlist.length > 1 && segIndex + 1 < playlist.length) {
    playSegment(segIndex + 1);          // 自动接下一段，直到整片播完
  }
});

function playItem(it) {
  currentItem = it;
  nowTitle.textContent = it.title;
  nowMeta.textContent =
    (it.date || "") +
    (it.duration ? " · " + it.duration : "") +
    (it.source ? " · " + it.source : "");
  setStatus("正在解析播放地址…");
  renderList();
  destroyHls();
  playlist = [];
  segIndex = 0;
  segProxied = false;

  var q = "/api/tv/play?url=" + encodeURIComponent(it.url);
  if (it.gid) q += "&gid=" + encodeURIComponent(it.gid);

  fetch(q)
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) {
        setStatus((d.error || "无法解析播放地址") + "，正在打开原页面…");
        window.open(it.url, "_blank", "noopener");
        return;
      }
      // 央视返回分片列表时顺序连播；北京新闻是单个 mp4
      if (d.playlist && d.playlist.length) {
        playlist = d.playlist.filter(function (s) { return s && s.url; });
      }
      if (!playlist.length) playlist = [{ url: d.url, duration: Number(d.duration) || 0 }];

      var meta = {
        title: it.title,
        artist: d.title || it.source || "视频节目",
        album: it.date || "",
        cover: it.cover || ""
      };
      if (player) player.setMeta(meta);

      // 附加信息（总时长/段数/码率）放到标题下方的 meta 行，
      // nowStatus 交给 playSegment 独占，否则「已就绪」会覆盖「播放中·第 x/n 段」。
      var extra = "";
      if (d.duration) extra = fmtDur(d.duration);
      if (playlist.length > 1) extra += (extra ? " · " : "") + "共 " + playlist.length + " 段连播";
      if (d.rate) extra += (extra ? " · " : "") + d.rate + "kbps";
      if (extra) nowMeta.textContent = (it.date || "") + (extra ? " · " + extra : "");

      playSegment(0);
    })
    .catch((e) => setStatus("解析失败：" + e));
}

// ---------- 播放器增强：后台播放 / 全屏横屏 / 画中画 ----------
var player = null;
if (window.FMPlayer) {
  player = FMPlayer.setup(video, {
    mount: document.querySelector(".prog-stage"),
    fsTarget: document.querySelector(".stage-video"),
    source: "视频节目",
    getMeta: function () {
      return {
        title: currentItem ? currentItem.title : "视频节目",
        artist: currentItem ? (currentItem.source || "") : "FM 网络电台",
        album: currentItem ? (currentItem.date || "") : "",
        cover: currentItem ? (currentItem.cover || "") : ""
      };
    }
  });
}

video.addEventListener("playing", () => setStatus("● 播放中"));
video.addEventListener("waiting", () => setStatus("缓冲中…"));
video.addEventListener("pause", () => setStatus("已暂停"));
video.addEventListener("error", () => {
  // 连播中直连失败：自动改走服务器代理重试本段（混合内容/CORS/https 不通都覆盖）
  if (playlist.length && segIndex < playlist.length && !segProxied) {
    segProxied = true;
    setStatus("直连失败，改用服务器代理…");
    playSegment(segIndex);
    return;
  }
  setStatus("播放出错，请重试或换一期");
});

// ---------- 键盘：上下期切换 ----------
document.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (!items.length) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  let i = currentItem ? items.findIndex((x) => x.url === currentItem.url) : -1;
  i = e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
  playItem(items[i]);
});

renderSrcChips();
load();
