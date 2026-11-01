"use strict";
/* 播放器增强：后台播放（Media Session）+ 全屏横屏 + 画中画
 *
 * 三个问题的成因与对策：
 *
 * 1) 切到其他应用就暂停
 *    - Android Chrome：只要注册 Media Session，浏览器/系统就会把它当成一个媒体会话，
 *      切后台、锁屏后音频继续放，锁屏界面还能出播放控件。
 *    - iOS Safari：网页视频切后台基本必暂停，可靠办法是画中画（PiP）浮窗继续播。
 *      所以这里同时提供 PiP 按钮，两边都能用。
 *
 * 2) 没有「全屏 + 横屏」
 *    - 原生 controls 的全屏不会转横屏。这里自己请求全屏后立刻 screen.orientation.lock("landscape")。
 *      注意：orientation.lock 只在 Chrome/Edge(Android) 的全屏状态下有效，iOS 会抛异常，
 *      已 try/catch 兜底——iOS 上至少能全屏，横屏需用户自己转。
 *
 * 用法：
 *   FMPlayer.setup(video, { mount: 放按钮的容器, fsTarget: 全屏的目标元素, source: "节目页" })
 *   FMPlayer.setMeta({ title, artist, album, cover })
 */
(function () {
  var oriLocked = false;

  function fsRequest(el) {
    return el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  }
  function fsExit() {
    return (
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.msExitFullscreen
    );
  }
  function fsActive() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement
    );
  }
  function orientation() {
    return screen.orientation || screen.msOrientation || screen.mozOrientation;
  }

  function lockLandscape() {
    try {
      var so = orientation();
      if (so && so.lock) {
        return Promise.resolve(so.lock("landscape")).catch(function () {});
      }
    } catch (e) {}
    return Promise.resolve();
  }
  function unlockOri() {
    try {
      var so = orientation();
      if (so && so.unlock) so.unlock();
    } catch (e) {}
  }

  function hint(msg) {
    if (typeof window.__fmPlayerHint === "function") window.__fmPlayerHint(msg);
  }

  // ---------- Media Session：后台播放 / 锁屏控件 ----------
  function applySession(meta, video) {
    if (!("mediaSession" in navigator) || typeof window.MediaMetadata !== "function") {
      return false;
    }
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: meta.title || "正在播放",
        artist: meta.artist || "FM 网络电台",
        album: meta.album || "",
        artwork: meta.cover
          ? [{ src: meta.cover, sizes: "512x512", type: "image/jpeg" }]
          : []
      });
      var bind = function (action, fn) {
        try {
          navigator.mediaSession.setActionHandler(action, fn);
        } catch (e) {}
      };
      bind("play", function () {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      });
      bind("pause", function () {
        video.pause();
      });
      bind("stop", function () {
        video.pause();
        try {
          video.currentTime = 0;
        } catch (e) {}
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function syncPlaybackState(video) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = video.paused ? "paused" : "playing";
    } catch (e) {}
  }

  // ---------- 工具栏 ----------
  function makeBtn(label, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ptool-btn";
    b.textContent = label;
    b.title = title || "";
    b.addEventListener("click", function (e) {
      e.preventDefault();
      onClick(b);
    });
    return b;
  }

  function setup(video, opts) {
    opts = opts || {};
    var mount = opts.mount || video.parentNode;
    var fsTarget = opts.fsTarget || video;
    if (!video || !mount) return null;

    var bar = document.createElement("div");
    bar.className = "player-tools";

    // 后台播放开关（Media Session）
    var bgOn = false;
    var bgBtn = makeBtn("🔔 后台播放", "开启后切到其他应用/锁屏可继续听（Android 有效；iPhone 请用画中画）", function () {
      if (bgOn) {
        bgOn = false;
        bgBtn.classList.remove("on");
        bgBtn.textContent = "🔔 后台播放";
        if ("mediaSession" in navigator) {
          try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
          } catch (e) {}
        }
        hint("已关闭后台播放");
        return;
      }
      bgOn = true;
      bgBtn.classList.add("on");
      bgBtn.textContent = "🔔 后台播放 已开";
      var ok = applySession(
        {
          title: (opts.getMeta && opts.getMeta().title) || "正在播放",
          artist: "FM 网络电台",
          album: opts.source || "",
          cover: (opts.getMeta && opts.getMeta().cover) || ""
        },
        video
      );
      hint(
        ok
          ? "后台播放已开启：可切应用/锁屏继续听（Android）。iPhone 建议点「画中画」"
          : "当前浏览器不支持 Media Session，请用「画中画」"
      );
    });

    // 全屏 + 横屏
    var fsBtn = makeBtn("📺 全屏横屏", "全屏并自动切横屏（部分浏览器需手动转方向）", function () {
      var req = fsRequest(fsTarget);
      if (!req) {
        hint("当前浏览器不支持全屏");
        return;
      }
      Promise.resolve(req.call(fsTarget))
        .then(function () {
          oriLocked = true;
          return lockLandscape();
        })
        .catch(function () {
          hint("全屏请求被拒绝");
        });
    });

    // 画中画（iOS 切后台继续播的可靠方式）
    var pipBtn = makeBtn("🖼 画中画", "小窗播放，切到其他应用也能继续", function () {
      if (!document.pictureInPictureEnabled) {
        hint("当前浏览器不支持画中画");
        return;
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(function () {});
        return;
      }
      var p = video.requestPictureInPicture
        ? video.requestPictureInPicture()
        : null;
      if (p && p.catch) p.catch(function () { hint("画中画启动失败"); });
    });
    if (!document.pictureInPictureEnabled) {
      pipBtn.style.display = "none";
    }

    bar.appendChild(bgBtn);
    bar.appendChild(fsBtn);
    bar.appendChild(pipBtn);

    // TV 页播放器在底部固定栏里，按钮放右上角更合适
    if (opts.layout === "corner") {
      bar.classList.add("corner");
    }

    mount.appendChild(bar);

    // 退出全屏时解除方向锁定
    document.addEventListener("fullscreenchange", function () {
      if (!fsActive()) {
        if (oriLocked) {
          unlockOri();
          oriLocked = false;
        }
      }
    });
    document.addEventListener("webkitfullscreenchange", function () {
      if (!fsActive()) {
        if (oriLocked) {
          unlockOri();
          oriLocked = false;
        }
      }
    });

    // 播放状态同步给系统媒体控件
    video.addEventListener("play", syncPlaybackState.bind(null, video));
    video.addEventListener("pause", syncPlaybackState.bind(null, video));

    return {
      setMeta: function (meta) {
        if (bgOn) applySession(meta, video);
      },
      refreshBg: function () {
        if (bgOn && opts.getMeta) applySession(opts.getMeta(), video);
      },
      isBgOn: function () {
        return bgOn;
      }
    };
  }

  window.FMPlayer = { setup: setup };
})();
