/*
 * Shipyard bridge — injected as the first script of every packaged game.
 * Makes an HTML game behave like a native app, which is what store reviewers check for:
 *   - Sound pauses when the app goes to the background and resumes when it returns.
 *   - The Android back button minimizes the app instead of closing it
 *     (a game can take over by defining window.shipyardBack = () => true).
 *   - No pinch-zoom, text selection, long-press menus, or pull-to-refresh bounce.
 * Games can listen for `shipyard:pause` and `shipyard:resume` window events.
 */
(function () {
  'use strict';

  // ---- Track audio so it can be paused in the background ----
  var contexts = [];
  var pausedByBridge = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (key) {
    var Original = window[key];
    if (typeof Original !== 'function' || typeof Proxy !== 'function') return;
    try {
      window[key] = new Proxy(Original, {
        construct: function (target, args, newTarget) {
          var ctx = Reflect.construct(target, args, newTarget);
          contexts.push(ctx);
          return ctx;
        },
      });
    } catch (e) {
      /* leave the original constructor in place */
    }
  });

  var isPaused = false;
  function setPaused(paused) {
    if (paused === isPaused) return;
    isPaused = paused;
    if (paused) {
      pausedByBridge = [];
      contexts.forEach(function (ctx) {
        if (ctx.state === 'running') {
          pausedByBridge.push(ctx);
          ctx.suspend().catch(function () {});
        }
      });
      document.querySelectorAll('audio, video').forEach(function (el) {
        if (!el.paused) {
          pausedByBridge.push(el);
          el.pause();
        }
      });
    } else {
      pausedByBridge.forEach(function (item) {
        var result = item.resume ? item.resume() : item.play();
        if (result && result.catch) result.catch(function () {});
      });
      pausedByBridge = [];
    }
    window.dispatchEvent(new CustomEvent(paused ? 'shipyard:pause' : 'shipyard:resume'));
  }

  document.addEventListener('visibilitychange', function () {
    setPaused(document.visibilityState === 'hidden');
  });

  // ---- Native app events (Capacitor) ----
  var cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.App) {
    cap.Plugins.App.addListener('appStateChange', function (state) {
      setPaused(!state.isActive);
    });
    cap.Plugins.App.addListener('backButton', function () {
      if (typeof window.shipyardBack === 'function' && window.shipyardBack() === true) return;
      cap.Plugins.App.minimizeApp();
    });
  }

  // ---- Native feel ----
  var css =
    'html,body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;' +
    '-webkit-tap-highlight-color:transparent;overscroll-behavior:none;touch-action:manipulation}' +
    'input,textarea,[contenteditable="true"]{-webkit-user-select:text;user-select:text}';
  function addStyle() {
    var style = document.createElement('style');
    style.setAttribute('data-shipyard', '');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.head) addStyle();
  else document.addEventListener('DOMContentLoaded', addStyle);

  document.addEventListener('contextmenu', function (event) {
    var t = event.target;
    if (!(t && t.closest && t.closest('input, textarea, [contenteditable="true"]'))) event.preventDefault();
  });
  // iOS Safari-engine pinch zoom
  document.addEventListener('gesturestart', function (event) { event.preventDefault(); });
})();
