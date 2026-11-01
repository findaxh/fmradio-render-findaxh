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

// ---------- 清晰度变体 + 分片连播 ----------
// variants: [{key,label,bitrate,playlist:[{url,duration}],total}]，按码率升序。
// 央视各档分片数量不同（418k=7 段 / 1.2M=16 段），切档用全局时间戳对齐，
// 保证切换/升降档后从同一进度继续播放。
const qChipsEl = document.getElementById("qChips");
var variants = [];        // 当前节目的全部清晰度档位
var curVar = 0;           // 当前档位下标
var qMode = "auto";       // "auto" 或手动锁定的档位下标（跨节目记忆）
var upgradePending = false;
var segIndex = 0;         // 当前档内的段下标
var segOffset = 0;        // 段内起始偏移（切档续播用）
var segProxied = false;   // 直连失败后改走服务器代理兜底
var waitingStreak = 0;

function parts() { return (variants[curVar] && variants[curVar].playlist) || []; }
function bufferedAhead() {
  try {
    if (video.buffered.length) return video.buffered.end(video.buffered.length - 1) - video.currentTime;
  } catch (e) {}
  return 0;
}
function fmtQ(b) {
  b = Number(b) || 0;
  if (!b) return "";
  return b >= 1000000 ? (b / 1000000).toFixed(1).replace(/\.0$/, "") + "M" : Math.round(b / 1000) + "K";
}

function renderQChips() {
  qChipsEl.innerHTML = "";
  if (variants.length < 2) { qChipsEl.style.display = "none"; return; }
  qChipsEl.style.display = "";
  var mk = function (txt, title, active, fn) {
    var el = document.createElement("div");
    el.className = "chip" + (active ? " active" : "");
    el.textContent = txt;
    el.title = title;
    el.onclick = fn;
    qChipsEl.appendChild(el);
  };
  var cur = variants[curVar];
  mk("自动 · " + cur.label, "根据缓冲自动升/降档（当前 " + cur.label + "）",
    qMode === "auto", function () { qMode = "auto"; renderQChips(); });
  variants.forEach(function (v, i) {
    mk(v.label + (v.bitrate ? " " + fmtQ(v.bitrate) : ""), "手动锁定 " + v.label,
      qMode === i, function () {
        if (qMode === i) return;
        qMode = i;
        switchQuality(i);
      });
  });
}

function applyQMode() {
  // 节目加载/续播时按 qMode 决定档位；手动档位越界时收敛到最高档
  if (qMode === "auto") curVar = Math.min(1, variants.length - 1);
  else curVar = Math.max(0, Math.min(qMode, variants.length - 1));
}

function switchQuality(idx) {
  if (idx < 0 || idx >= variants.length || idx === curVar) return;
  var T = globalTime();
  curVar = idx;
  segProxied = false;
  renderQChips();
  playAtGlobal(T);
}

function globalTime() {
  var t = 0, ps = parts();
  for (var i = 0; i < segIndex && i < ps.length; i++) t += (ps[i].duration || 0);
  return t + (video.currentTime || 0);
}

function playAtGlobal(T) {
  var ps = parts(), acc = 0, idx = ps.length - 1, off = 0;
  for (var i = 0; i < ps.length; i++) {
    var d = ps[i].duration || 0;
    if (T < acc + d) { idx = i; off = T - acc; break; }
    acc += d;
  }
  if (off < 0) off = 0;
  if (idx === ps.length - 1 && off >= (ps[idx].duration || 0)) {
    setStatus("✓ 已播放完整内容（共 " + ps.length + " 段）");
    return;
  }
  playSegment(idx, off);
}

function playSegment(i, offset) {
  var ps = parts();
  if (i >= ps.length) {
    setStatus("✓ 已播放完整内容（共 " + ps.length + " 段）");
    return;
  }
  segIndex = i;
  segOffset = offset || 0;
  var seg = ps[i];
  // 直连优先（https 升级，绕过混合内容且不经服务器，最流畅）；
  // 出错时 error 监听器会把 segProxied 置真并重放本段，改走同源代理兜底。
  var u = seg.url;
  if (segProxied) {
    // 兜底代理用服务端解析到的原始地址（seg.purl，海外解析时为 cdn20 国际 CDN，
    // Render 可直接访问）；国内域名 lxdns 交给浏览器直连
    var raw = seg.purl || u;
    raw = (raw.indexOf("http") === 0) ? raw : location.origin + raw;
    u = "/api/tv/media?u=" + encodeURIComponent(raw);
  } else if (location.protocol === "https:" && u.indexOf("http://") === 0) {
    u = "https://" + u.slice(7);
  }
  video.src = u;
  var p = video.play();
  if (p && p.catch) p.catch(function () { setStatus("请点击播放器中的播放按钮"); });
  if (segOffset > 0.5) {
    var seek = function () {
      try { video.currentTime = segOffset; } catch (e) {}
      video.removeEventListener("loadedmetadata", seek);
    };
    video.addEventListener("loadedmetadata", seek);
    try { if (video.readyState >= 1) video.currentTime = segOffset; } catch (e) {}
  }
  var v = variants[curVar];
  var qtxt = v ? (v.label + (v.bitrate ? " " + fmtQ(v.bitrate) + "bps" : "")) : "";
  if (ps.length > 1) {
    setStatus("● 播放中 · 第 " + (i + 1) + "/" + ps.length + " 段 · " + qtxt +
      (seg.duration ? "（" + fmtDur(seg.duration) + "）" : ""));
  } else {
    setStatus("● 播放中 · " + qtxt);
  }
}

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
  segIndex = 0;
  segOffset = 0;
  segProxied = false;
  upgradePending = false;
  waitingStreak = 0;

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
      // 清晰度变体：服务端已按码率升序；老接口无 variants 时兜底单档
      variants = (d.variants && d.variants.length)
        ? d.variants
        : [{ key: "q0", label: "默认", bitrate: Number(d.rate) || 0,
             playlist: (d.playlist && d.playlist.length
               ? d.playlist
               : [{ url: d.url, duration: Number(d.duration) || 0 }]) }];
      applyQMode();
      renderQChips();
      var ps = parts();

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
      if (ps.length > 1) extra += (extra ? " · " : "") + "共 " + ps.length + " 段连播";
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

video.addEventListener("playing", () => {
  waitingStreak = 0;
  setStatus("● 播放中");
});
video.addEventListener("timeupdate", () => {
  if (!autoQReady()) return;
  var ahead = bufferedAhead();
  // 缓冲领先 40s 以上 → 下一段边界升档；掉到 10s 以内取消升档
  if (ahead > 40 && curVar < variants.length - 1) upgradePending = true;
  if (ahead < 10) upgradePending = false;
});
video.addEventListener("waiting", () => {
  setStatus("缓冲中…");
  if (!autoQReady()) return;
  waitingStreak++;
  // 一段内连续卡 2 次且缓冲所剩无几 → 立即降档续播（进度不丢）
  if (waitingStreak >= 2 && curVar > 0 && bufferedAhead() < 6) {
    waitingStreak = 0;
    var downLabel = variants[curVar - 1].label;
    switchQuality(curVar - 1);
    setStatus("网络波动，自动降到 " + downLabel + "，从原进度继续");
  }
});
video.addEventListener("pause", () => setStatus("已暂停"));
video.addEventListener("ended", () => {
  var T = globalTime() + 0.05;      // 下一段起点（换档后段数不同，用全局时间对齐）
  if (autoQReady() && upgradePending && curVar < variants.length - 1) {
    curVar++;
    upgradePending = false;
    segProxied = false;
    renderQChips();
    setStatus("网络良好，自动升到 " + variants[curVar].label);
  } else {
    segProxied = false;
  }
  var ps = parts(), acc = 0, idx = -1, off = 0;
  for (var i = 0; i < ps.length; i++) {
    var d = ps[i].duration || 0;
    if (T < acc + d) { idx = i; off = T - acc; break; }
    acc += d;
  }
  if (idx < 0) {
    setStatus("✓ 已播放完整内容（共 " + ps.length + " 段）");
    return;
  }
  playSegment(idx, off);
});
video.addEventListener("error", () => {
  // 连播中直连失败：自动改走服务器代理重试本段（混合内容/CORS/https 不通都覆盖）
  if (parts().length && segIndex < parts().length && !segProxied) {
    segProxied = true;
    setStatus("直连失败，改用服务器代理…");
    playSegment(segIndex, segOffset);
    return;
  }
  setStatus("播放出错，请重试或换一期");
});

function autoQReady() {
  return qMode === "auto" && variants.length > 1 && !video.paused && video.readyState > 0;
}

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
