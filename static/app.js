"use strict";

const audio = document.getElementById("audio");
const stationListEl = document.getElementById("stationList");
const searchEl = document.getElementById("search");
const countryEl = document.getElementById("country");
const regionChipsEl = document.getElementById("regionChips");
const catChipsEl = document.getElementById("catChips");
const playBtn = document.getElementById("playBtn");
const nowName = document.getElementById("nowName");
const nowStatus = document.getElementById("nowStatus");
const volumeEl = document.getElementById("volume");
const testBtn = document.getElementById("testBtn");
const blockBtn = document.getElementById("blockBtn");
const blockedBtn = document.getElementById("blockedBtn");

let stations = [];        // 当前加载的全部电台
let currentRegion = "全部";
let currentCat = "全部";
let currentStation = null;
let currentHls = null;

// ---------- 屏蔽名单（localStorage 持久化） ----------
// HLS 电台被浏览器 CORS 拦截或源失效是持续性的，屏蔽后不再出现在列表里。
const BLOCK_KEY = "fm_blocked_stations";
let blocked = new Set();
try { blocked = new Set(JSON.parse(localStorage.getItem(BLOCK_KEY) || "[]")); } catch (e) {}
let showBlocked = false;

function saveBlocked() {
  try { localStorage.setItem(BLOCK_KEY, JSON.stringify([...blocked])); } catch (e) {}
  blockedBtn.textContent = "已屏蔽(" + blocked.size + ")";
}
function isBlocked(st) { return blocked.has(st.url); }
function toggleBlock(st) {
  if (!st) return;
  if (blocked.has(st.url)) {
    blocked.delete(st.url);
    setStatus("已恢复「" + (st.name || "") + "」");
  } else {
    blocked.add(st.url);
    setStatus("已屏蔽「" + (st.name || "") + "」，点「已屏蔽」可恢复");
    if (currentStation && currentStation.url === st.url) {
      try { audio.pause(); } catch (e) {}
      destroyHls();
      currentStation = null;
      nowName.textContent = "未选择电台";
    }
  }
  saveBlocked();
  renderStations();
}
function showBlockAction() { blockBtn.style.display = ""; }
function hideBlockAction() { blockBtn.style.display = "none"; }
blockBtn.addEventListener("click", () => toggleBlock(currentStation));
blockedBtn.addEventListener("click", () => {
  showBlocked = !showBlocked;
  blockedBtn.classList.toggle("active", showBlocked);
  renderStations();
});
saveBlocked();

audio.volume = parseFloat(volumeEl.value);
volumeEl.addEventListener("input", () => { audio.volume = parseFloat(volumeEl.value); });

function setStatus(t) { nowStatus.textContent = t; }

// ---------- 加载 ----------
let loadToken = 0;
function load(retryLeft) {
  const country = countryEl.value;
  const myToken = ++loadToken;
  // 允许直接作为事件回调使用（首个参数是 Event），此时按首次加载处理
  if (typeof retryLeft !== "number") retryLeft = 2;   // 失败自动重试 2 次
  setStatus(retryLeft === 2 ? "正在加载…" : "正在重试…");
  let q = "/api/radiobrowser?limit=300";
  if (country) q += "&country=" + encodeURIComponent(country);
  fetch(q)
    .then((r) => r.json())
    .then((d) => {
      if (myToken !== loadToken) return;        // 已有更新的请求，丢弃本次结果
      if (d.ok) {
        stations = d.stations;
        currentRegion = "全部";
        currentCat = "全部";
        renderChips();
        renderStations();
        setStatus("共 " + d.count + " 个电台" + (d.stale ? "（缓存）" : ""));
        if (d.warning) console.warn(d.warning);
        return;
      }
      if (retryLeft > 0) {
        setTimeout(() => { if (myToken === loadToken) load(retryLeft - 1); }, 1200);
        return;
      }
      setStatus("加载失败：" + (d.error || "未知错误"));
    })
    .catch((e) => {
      if (myToken !== loadToken) return;
      if (retryLeft > 0) {
        setTimeout(() => { if (myToken === loadToken) load(retryLeft - 1); }, 1200);
        return;
      }
      setStatus("加载失败：" + e);
    });
}

// ---------- 筛选 chips ----------
function renderChips() {
  // 区域
  const rset = new Set();
  stations.forEach((s) => { if (s.region) rset.add(s.region); });
  const regions = ["全部", ...[...rset].sort()];
  regionChipsEl.innerHTML = "";
  regions.forEach((r) => {
    const c = document.createElement("div");
    c.className = "chip" + (r === currentRegion ? " active" : "");
    c.textContent = r;
    c.onclick = () => { currentRegion = r; renderChips(); renderStations(); };
    regionChipsEl.appendChild(c);
  });
  // 类别
  const cset = new Set();
  stations.forEach((s) => { (s.cats || []).forEach((c) => cset.add(c)); });
  const cats = ["全部", ...[...cset].sort()];
  catChipsEl.innerHTML = "";
  cats.forEach((c) => {
    const el = document.createElement("div");
    el.className = "chip" + (c === currentCat ? " active" : "");
    el.textContent = c;
    el.onclick = () => { currentCat = c; renderChips(); renderStations(); };
    catChipsEl.appendChild(el);
  });
}

function getFiltered() {
  const kw = searchEl.value.trim().toLowerCase();
  return stations.filter((s) => {
    // 屏蔽视图只显示被屏蔽的电台；正常视图过滤掉它们
    if (showBlocked !== isBlocked(s)) return false;
    if (currentRegion !== "全部" && s.region !== currentRegion) return false;
    if (currentCat !== "全部" && !(s.cats || []).includes(currentCat)) return false;
    if (kw) {
      const hay = ((s.name || "") + " " + (s.tags || "") + " " + (s.state || "")).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

function renderStations() {
  const list = getFiltered();
  stationListEl.innerHTML = "";
  if (!list.length) {
    stationListEl.innerHTML = showBlocked
      ? '<div class="empty">没有被屏蔽的电台</div>'
      : '<div class="empty">没有匹配的电台</div>';
    return;
  }
  list.forEach((st) => {
    const el = document.createElement("div");
    el.className = "station" + (currentStation && currentStation.url === st.url ? " playing" : "");
    const ic = document.createElement("div");
    ic.className = "play-ic";
    ic.textContent = (currentStation && currentStation.url === st.url && !audio.paused) ? "❚❚" : "▶";
    const meta = document.createElement("div");
    meta.className = "meta";
    const nm = document.createElement("div");
    nm.className = "name";
    nm.textContent = st.name || "(未命名)";
    const sub = document.createElement("div");
    sub.className = "sub";
    const parts = [];
    if (st.region && st.region !== "其他") parts.push(st.region);
    if (st.cats && st.cats.length) parts.push(st.cats.join("/"));
    if (st.bitrate) parts.push(st.bitrate + "k");
    sub.textContent = parts.join(" · ") + (st.type === "hls" ? " · HLS" : "");
    meta.appendChild(nm);
    meta.appendChild(sub);
    el.appendChild(ic);
    el.appendChild(meta);
    // 屏蔽/恢复按钮：正常视图 ✕ 屏蔽，屏蔽视图 ♻ 恢复
    const bx = document.createElement("div");
    bx.className = "block-x";
    bx.title = showBlocked ? "恢复此台" : "屏蔽此台（不再显示）";
    bx.textContent = showBlocked ? "♻" : "✕";
    bx.onclick = (ev) => { ev.stopPropagation(); toggleBlock(st); };
    el.appendChild(bx);
    el.onclick = () => playStation(st);
    stationListEl.appendChild(el);
  });
}

function refreshIcons() {
  document.querySelectorAll(".station").forEach((el) => {
    const nm = el.querySelector(".name").textContent;
    const ic = el.querySelector(".play-ic");
    if (currentStation && currentStation.name === nm) {
      el.classList.add("playing");
      ic.textContent = audio.paused ? "▶" : "❚❚";
    } else {
      el.classList.remove("playing");
      ic.textContent = "▶";
    }
  });
}

// ---------- 播放（直连） ----------
function destroyHls() {
  if (currentHls) {
    try { currentHls.destroy(); } catch (e) {}
    currentHls = null;
  }
}

function playStation(st) {
  currentStation = st;
  nowName.textContent = st.name || "(未命名)";
  setStatus("正在连接…");
  hideBlockAction();
  renderStations();
  destroyHls();

  if (st.type === "hls") {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls();
      currentHls = hls;
      hls.loadSource(st.url);
      hls.attachMedia(audio);
      hls.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (data.fatal) {
          setStatus("HLS 播放失败：可能被浏览器 CORS 拦截或源失效");
          showBlockAction();
        }
      });
    } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
      audio.src = st.url;
      audio.play().catch(() => {});
    } else {
      setStatus("当前浏览器不支持 HLS 播放");
    }
  } else {
    audio.src = st.url;
    audio.play().catch(() => { setStatus("播放失败：源失效或无法直连"); showBlockAction(); });
  }
}

playBtn.addEventListener("click", () => {
  if (!currentStation) {
    const list = getFiltered();
    if (list.length) playStation(list[0]);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});

audio.addEventListener("playing", () => { setStatus("● 播放中"); hideBlockAction(); refreshIcons(); playBtn.textContent = "❚❚"; });
audio.addEventListener("waiting", () => setStatus("缓冲中…"));
audio.addEventListener("pause", () => { setStatus("已暂停"); refreshIcons(); playBtn.textContent = "▶"; });
audio.addEventListener("error", () => { if (currentStation) { setStatus("播放出错：源失效或被拦截"); showBlockAction(); } });

// ---------- 检测源（服务器侧存活） ----------
testBtn.addEventListener("click", () => {
  const st = currentStation || stations[0];
  if (!st) { setStatus("暂无电台"); return; }
  setStatus("正在检测该源…");
  fetch("/api/probe?url=" + encodeURIComponent(st.url))
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) setStatus("该源存活 ✓ (HTTP " + d.status + " · " + (d.content_type || "") + ")");
      else setStatus("该源不可用 ✗ " + (d.status ? ("HTTP " + d.status) : (d.error || "")));
    })
    .catch((e) => setStatus("检测失败：" + e));
});

// ---------- 事件 ----------
countryEl.addEventListener("change", load);
searchEl.addEventListener("input", renderStations);

// ---------- 初始化 ----------
load();
