/**
 * content.js — runs on Canvas pages.
 *
 * Two parts:
 *  1. STYLE LAYER  — translates settings into attributes/CSS variables on <html>.
 *                    All visuals live in static CSS files, so toggling is free.
 *  2. WIDGET LAYER — optional dashboard panel (to-do list + GPA), rendered in a
 *                    Shadow DOM, only on the dashboard, only when idle, with
 *                    a short-lived cache. No polling, no permanent observers.
 */
(() => {
  'use strict';

  const root = document.documentElement;

  /** False once the extension has been reloaded, updated or removed while this tab stayed open.
   *  This old copy of the script keeps running, and any chrome.* call from it throws
   *  "Extension context invalidated". Check this first and quietly do nothing instead. */
  const extAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const mq = matchMedia('(prefers-color-scheme: dark)');
  let settings = MC.sanitize(null);

  /* ------------------------------------------------------------------ */
  /* 1. STYLE LAYER                                                     */
  /* ------------------------------------------------------------------ */

  const flag = (name, on) => (on ? root.setAttribute(name, '') : root.removeAttribute(name));

  let tint = null;

  /** Night warm tint: one fixed, click-through overlay (multiply blend) that
   *  removes blue light. Created only when enabled, removed when not. */
  function applyWarmTint(on) {
    if (!on) { if (tint) { tint.remove(); tint = null; } return; }
    if (!tint) {
      tint = document.createElement('div');
      tint.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483647;background:#ff9a3c;mix-blend-mode:multiply';
    }
    tint.style.opacity = String(settings.dark.warmLevel / 100);
    if (!tint.isConnected) (document.body || root).append(tint);
  }

  function applyStyles() {
    const { dark, dashboard: d } = settings;
    const isDark = MC.isDarkNow(settings, mq.matches);
    flag('data-mc-dark', isDark);
    applyWarmTint(dark.warm && (!dark.enabled || isDark));
    root.setAttribute('data-mc-theme', dark.theme);
    flag('data-mc-gradient', d.gradient);
    flag('data-mc-theme-cards', d.themeCards);
    flag('data-mc-condensed', d.condensed);
    flag('data-mc-hide-logo', d.hideLogo);
    flag('data-mc-hide-feedback', d.hideFeedback);
    // Our to-do panel only lives on the dashboard, so only there does it replace Canvas's
    // right sidebar (see dashboard.css). Elsewhere that sidebar holds real page content,
    // e.g. the grade total and options on a class's Grades page, so it must stay.
    const onDash = location.pathname === '/' || location.pathname === '/dashboard';
    flag('data-mc-todo', settings.todo.enabled && onDash);
    if (d.font === 'default') root.removeAttribute('data-mc-font');
    else root.setAttribute('data-mc-font', d.font);

    const st = root.style;
    // Custom accent overrides the theme's; otherwise the theme CSS supplies --mc-accent.
    if (settings.accent) st.setProperty('--mc-accent', settings.accent);
    else st.removeProperty('--mc-accent');
    st.setProperty('--mc-grad-a', d.gradA);
    st.setProperty('--mc-grad-b', d.gradB);
    whenDomReady(themeFix);
    loadBundleCss();
  }

  /* Canvas page stylesheets. Every Canvas CSS bundle a page loads (grade_summary-<hash>.css,
   * calendar2-<hash>.css, ...) has a generated dark counterpart in styles/canvas/ (see
   * tools/build-canvas-dark.py). In dark mode, load it right after Canvas's own file so the
   * cascade order matches Canvas's. Bundles the page doesn't load are never loaded. */
  const BUNDLE_RE = /\/bundles\/([\w-]+?)-[0-9a-f]{10}\.css(?:$|[?#])/;
  const seenBundles = new Map(); // bundle name -> Canvas's <link>
  let bundleObs = null;
  function noteBundleLink(el) {
    if (el.nodeName !== 'LINK' || el.hasAttribute('data-mc-dark-for')) return;
    const m = BUNDLE_RE.exec(el.getAttribute('href') || '');
    const name = m && m[1];
    if (!name || name === 'common' || seenBundles.has(name)) return; // common is in the manifest
    if (!self.MC_CANVAS_BUNDLES || !self.MC_CANVAS_BUNDLES.has(name)) return;
    seenBundles.set(name, el);
    loadBundleCss();
  }
  function loadBundleCss() {
    if (!root.hasAttribute('data-mc-dark') || !extAlive()) return;
    for (const [name, canvasLink] of seenBundles) {
      if (document.querySelector(`link[data-mc-dark-for="${name}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.setAttribute('blocking', 'render'); // hold first paint for it, like Canvas's own CSS
      l.setAttribute('data-mc-dark-for', name);
      l.href = chrome.runtime.getURL(`styles/canvas/${name}.css`);
      if (canvasLink.isConnected) canvasLink.after(l);
      else (document.head || root).append(l);
    }
  }
  function watchBundles() {
    const scan = (n) => { for (const l of n.querySelectorAll('link[href*="/bundles/"]')) noteBundleLink(l); };
    if (document.head) scan(document.head);
    if (bundleObs) return;
    // Only <html>'s and <head>'s direct children are watched (that's where Canvas puts its CSS).
    bundleObs = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeName === 'LINK') noteBundleLink(n);
        else if (n.nodeName === 'HEAD') { scan(n); bundleObs.observe(n, { childList: true }); }
      }
    });
    bundleObs.observe(root, { childList: true });
    if (document.head) bundleObs.observe(document.head, { childList: true });
  }

  /* Theme fixer. Canvas pages (Inbox, Courses/Groups/Calendar trays, Calendar,
   * React pages) paint plenty of light boxes and dark text from generated styles
   * that stylesheet rules can't target reliably. In dark mode this measures what the
   * page actually paints and marks the misfits so dark.css can recolour them:
   *   data-mc-lightfix="n"  light neutral box (white/grey)  -> theme surface
   *   data-mc-lightfix="t"  light tinted box (highlight)    -> accent-tinted surface
   *   data-mc-textfix       text/icon too dark to read on its background -> theme text
   * Changed parts are re-checked inside the MutationObserver callback, which runs
   * before the browser paints, so nothing flashes. */
  const LF = 'data-mc-lightfix', TF = 'data-mc-textfix', BF = 'data-mc-borderfix';
  const FIX_EVENTS = ['mouseover', 'mouseout', 'click', 'focusin'];
  const SKIP = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'SOURCE', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR']);
  const MAX_FULL_SCAN = 12000; // huge pages (e.g. gradebook): rely on the per-change checks only
  let fixObs = null, fixTimer = 0, accRgb = null;
  const fixActive = () => root.hasAttribute('data-mc-dark');
  const rgbOf = (c) => {
    // Only plain rgb()/rgba(); anything else (e.g. our own color-mix result) counts as unknown.
    const m = /^rgba?\(([^)]+)\)$/.exec(c || '');
    if (!m) return null;
    const v = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return v.length >= 3 ? [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] : null;
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const relLum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrast = (a, b) => { const x = relLum(a), y = relLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function readAccent() {
    const hex = getComputedStyle(root).getPropertyValue('--mc-accent').trim();
    const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    accRgb = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  const isAccent = (c) => accRgb && Math.abs(accRgb[0] - c[0]) + Math.abs(accRgb[1] - c[1]) + Math.abs(accRgb[2] - c[2]) < 12;

  /** 'n' or 't' if the element paints a light background that doesn't belong in dark mode. */
  function lightKind(el, cs) {
    const c = rgbOf(cs.backgroundColor);
    if (!c || c[3] < 0.5 || relLum(c) < 0.45 || isAccent(c)) return '';
    // A coloured background set inline that isn't pale is a course colour (dashboard cards,
    // calendar events, swatches): keep it. Pale inline tints are Canvas UI states, e.g. the
    // Inbox's selected conversation (rgb(229,242,248)), and get themed like any other.
    if (el.style && (el.style.backgroundColor || el.style.background) &&
        Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) > 16 && relLum(c) < 0.7) return '';
    const chroma = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
    if (chroma > 60) return ''; // vivid colours (badges, highlighter) are meant to stand out
    return chroma <= 12 ? 'n' : 't';
  }
  /** True if any visible border side is a light grey/pastel (glows on a dark page). */
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  function lightBorder(cs) {
    for (const side of SIDES) {
      if (!(parseFloat(cs['border' + side + 'Width']) > 0)) continue;
      const st = cs['border' + side + 'Style'];
      if (st === 'none' || st === 'hidden') continue;
      const c = rgbOf(cs['border' + side + 'Color']);
      if (!c || c[3] < 0.5 || relLum(c) < 0.45 || isAccent(c)) continue;
      if (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) <= 60) return true;
    }
    return false;
  }
  /** Colour actually behind el: the nearest ancestor (or el) with an opaque fill. */
  function bgBehind(el, memo) {
    const chain = [];
    let found = null;
    for (let p = el; p; p = p.parentElement) {
      if (memo.has(p)) { found = memo.get(p); break; }
      chain.push(p);
      const cs = getComputedStyle(p);
      if (cs.backgroundImage !== 'none') { found = 'unknown'; break; } // photos/gradients: can't judge
      if (p.hasAttribute(LF)) { found = 'dark'; break; }
      const c = rgbOf(cs.backgroundColor);
      if (c && c[3] >= 0.5) { found = c; break; }
    }
    if (!found) found = 'dark'; // reached the top: the theme background
    for (const p of chain) memo.set(p, found);
    return found;
  }
  const TEXTY = new Set(['I', 'svg', 'INPUT', 'TEXTAREA', 'SELECT']);
  const hasOwnText = (el) => {
    if (TEXTY.has(el.tagName)) return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) return true;
    return false;
  };
  // Measure without our own overrides, so things that stop needing a fix are un-marked.
  // Marked elements whose own class/style haven't changed keep their marks during the
  // page-wide backstop scan (re-measuring them means un-marking, which costs a restyle).
  const markedSig = new WeakMap();
  const sigOf = (el) => (el.getAttribute('class') || '') + '|' + (el.getAttribute('style') || '');
  function checkEl(el, memo, reuse = false) {
    if (SKIP.has(el.tagName) || (el instanceof SVGElement && el.tagName !== 'svg')) return;
    const wasMarked = el.hasAttribute(LF) || el.hasAttribute(TF) || el.hasAttribute(BF);
    if (reuse && wasMarked && markedSig.get(el) === sigOf(el)) return;
    if (el.hasAttribute(LF)) el.removeAttribute(LF);
    if (el.hasAttribute(TF)) el.removeAttribute(TF);
    if (el.hasAttribute(BF)) el.removeAttribute(BF);
    memo.delete(el);
    const cs = getComputedStyle(el);
    const kind = lightKind(el, cs);
    if (kind) { el.setAttribute(LF, kind); markedSig.set(el, sigOf(el)); }
    if (lightBorder(cs)) { el.setAttribute(BF, ''); markedSig.set(el, sigOf(el)); }
    if (!hasOwnText(el)) return;
    const fg = rgbOf(cs.color);
    if (!fg || fg[3] < 0.3) return;
    const bg = bgBehind(el, memo);
    if (bg === 'unknown') return;
    // On a dark (themed) background, text under 3:1 contrast is hard to read: use the theme text.
    const bad = bg === 'dark' ? relLum(fg) < 0.12 : relLum(bg) < 0.2 && contrast(fg, bg) < 3;
    if (bad) { el.setAttribute(TF, ''); markedSig.set(el, sigOf(el)); }
  }
  function checkTree(el, memo = new Map(), reuse = false) {
    checkEl(el, memo, reuse);
    for (const k of el.querySelectorAll('*')) checkEl(k, memo, reuse);
  }
  let fixThorough = false;
  function fullScan() {
    fixTimer = 0;
    if (!fixActive() || !document.body || document.hidden) return; // hidden tab: caught up on return
    if (document.body.getElementsByTagName('*').length > MAX_FULL_SCAN) return;
    const reuse = !fixThorough;
    fixThorough = false;
    readAccent();
    checkTree(document.body, new Map(), reuse);
    if (fixObs) fixObs.takeRecords(); // drop records caused by our own marking
  }
  // The page-wide backstop costs ~50 ms on a big page, so it runs at most every 1.5 s and
  // only when the browser is idle; the per-change checks above handle clicks instantly.
  const queueFullScan = (thorough = false) => {
    if (thorough) fixThorough = true;
    if (fixTimer) return;
    fixTimer = setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fullScan, { timeout: 3000 });
      else fullScan();
    }, 1500);
  };
  const BIG_SUBTREE = 4000; // bigger changes are left to the idle scan instead of blocking
  function onMutations(records) {
    if (!fixActive()) return;
    if (document.hidden) { queueFullScan(true); return; } // nobody's looking: no work now
    const roots = new Set();
    for (const m of records) {
      if (m.type === 'attributes') roots.add(m.target);
      else for (const n of m.addedNodes) if (n instanceof Element) roots.add(n);
    }
    const memo = new Map();
    for (const el of roots) {
      if (!el.isConnected) continue;
      let covered = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (roots.has(p)) { covered = true; break; }
      if (covered) continue;
      if (el.getElementsByTagName('*').length > BIG_SUBTREE) { fixThorough = true; continue; }
      checkTree(el, memo);
    }
    if (fixObs) fixObs.takeRecords();
    queueFullScan(); // backstop for things restyled indirectly (siblings, late stylesheets)
  }
  const onPointer = (e) => {
    if (!fixActive()) return;
    const memo = new Map();
    const path = e.composedPath().filter((n) => n instanceof Element && n !== document.body && n !== root).reverse();
    for (const el of path) checkEl(el, memo); // outermost first, so text is judged on the fixed background
    if (fixObs) fixObs.takeRecords();
  };
  function themeFix() {
    if (!fixActive()) {
      if (fixObs) {
        fixObs.disconnect(); fixObs = null;
        for (const ev of FIX_EVENTS) document.removeEventListener(ev, onPointer, true);
      }
      for (const el of document.querySelectorAll(`[${LF}],[${TF}],[${BF}]`)) { el.removeAttribute(LF); el.removeAttribute(TF); el.removeAttribute(BF); }
      return;
    }
    if (!document.body) return;
    if (!fixObs) {
      fixObs = new MutationObserver(onMutations);
      fixObs.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'aria-selected', 'aria-current', 'aria-checked', 'aria-expanded', 'open'] });
      for (const ev of FIX_EVENTS) document.addEventListener(ev, onPointer, true);
    }
    fullScan();
  }

  /* To-do panel width (set by dragging its left edge; remembered per browser). */
  const TODO_W_KEY = 'mc-todo-width';
  const TODO_W_MIN = 280;
  const todoWidthMax = () => Math.max(TODO_W_MIN, Math.min(900, Math.round(window.innerWidth * 0.7)));
  const clampTodoWidth = (w) => Math.round(Math.min(todoWidthMax(), Math.max(TODO_W_MIN, w)));
  function setTodoWidth(w) { root.style.setProperty('--mc-todo-width', clampTodoWidth(w) + 'px'); }
  function applySavedTodoWidth() {
    let w = NaN;
    try { w = Number(localStorage.getItem(TODO_W_KEY)); } catch (_) { /* storage blocked */ }
    if (w > 0) setTodoWidth(w); else root.style.removeProperty('--mc-todo-width');
  }
  function saveTodoWidth(w) {
    try { w == null ? localStorage.removeItem(TODO_W_KEY) : localStorage.setItem(TODO_W_KEY, String(clampTodoWidth(w))); } catch (_) {}
  }

  /** Drag handle on the panel's left edge. Dragging left widens the panel (it sits on the
   *  right of the page). Arrow keys nudge it; double-click resets to the default width. */
  function makeGrip(hostEl) {
    const grip = h('div', {
      class: 'grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
      'aria-label': 'Resize to-do panel', title: 'Drag to resize · double-click to reset'
    });
    const wrapper = () => hostEl.parentElement || hostEl;
    const current = () => wrapper().getBoundingClientRect().width;
    let startX = 0, startW = 0, dragging = false;

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || root.hasAttribute('data-mc-todo-collapsed')) return;
      e.preventDefault();
      dragging = true; startX = e.clientX; startW = current();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('active');
      root.setAttribute('data-mc-resizing', '');
    });
    grip.addEventListener('pointermove', (e) => {
      if (dragging) setTodoWidth(startW + (startX - e.clientX));
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove('active');
      root.removeAttribute('data-mc-resizing');
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      saveTodoWidth(current());
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => { saveTodoWidth(null); applySavedTodoWidth(); });
    grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 60 : 20;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const w = current() + (e.key === 'ArrowLeft' ? step : -step);
      setTodoWidth(w);
      saveTodoWidth(w);
    });
    return grip;
  }

  // Dark mode follows the OS only while the user picked "system".
  mq.addEventListener('change', () => settings.dark.mode === 'system' && applyStyles());

  // Re-check the schedule when the tab becomes visible (covers sleep/wake).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !extAlive()) return;
    if (settings.dark.mode === 'schedule') applyStyles();
    // Coming back to the tab (e.g. after submitting an assignment elsewhere): if the data
    // is over a minute old, refresh it in the background. The panel stays as it is and is
    // only redrawn if something actually changed.
    if (host && quietRefresh && !dataFresh()) quietRefresh();
    // Catch up on theme fixes skipped while the tab was hidden.
    if (fixObs) queueFullScan(true);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'mc-tick') applyStyles();
  });

  // Instant first paint (avoids a white flash): use the last settings cached
  // in localStorage, then reconcile with chrome.storage once it answers.
  let booted = false;
  try {
    const boot = localStorage.getItem('mc-boot');
    if (boot) { settings = MC.sanitize(JSON.parse(boot)); booted = true; }
  } catch (_) { /* storage may be blocked; ignore */ }
  watchBundles();
  applyStyles();
  applySavedTodoWidth();
  // With cached settings, build the panel as soon as the HTML is ready instead of
  // waiting for chrome.storage; it's rebuilt below only if the real settings differ.
  const widgetSig = () => JSON.stringify([settings.todo, settings.gpa]);
  const bootSig = booted ? widgetSig() : null;
  if (booted) mountWidget();

  chrome.storage.sync.get('settings').then(({ settings: s }) => {
    settings = MC.sanitize(s);
    cacheBoot();
    applyStyles();
    if (widgetSig() !== bootSig) mountWidget();
  }).catch(() => { /* extension reloaded before storage answered: this old copy just stops */ });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const prev = settings;
    settings = MC.sanitize(changes.settings.newValue);
    cacheBoot();
    applyStyles();
    // Only rebuild the widget if something it depends on changed.
    if (JSON.stringify([prev.todo, prev.gpa]) !== JSON.stringify([settings.todo, settings.gpa])) {
      mountWidget();
    }
  });

  function cacheBoot() {
    try { localStorage.setItem('mc-boot', JSON.stringify(settings)); } catch (_) {}
  }

  function whenDomReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  /* ------------------------------------------------------------------ */
  /* 2. WIDGET LAYER                                                    */
  /* ------------------------------------------------------------------ */

  // The panel's data is cached in localStorage, so every Canvas tab (and the next visit)
  // draws it instantly. Once it's over a minute old it is still shown, then refreshed
  // quietly in the background and redrawn only if something changed.
  const CACHE_KEY = 'mc-data-v4';
  const CACHE_MS = 60 * 1000;                // older than this: show, then refresh quietly
  const CACHE_MAX_MS = 12 * 60 * 60 * 1000;  // never show data older than this
  const DAY = 864e5;
  let host = null;

  /** Tiny DOM builder; text is always set via text nodes (no innerHTML => no XSS). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return el;
  }

  /** GET all pages of a Canvas API collection (same-origin, uses the login cookie). */
  async function api(path, maxPages = 5) {
    let url = path;
    const out = [];
    for (let i = 0; i < maxPages && url; i++) {
      // Never send the logged-in session anywhere but this Canvas site (pagination
      // links come from the server response, so verify them).
      if (new URL(url, location.origin).origin !== location.origin) throw new Error('cross-origin URL blocked');
      const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      Array.isArray(j) ? out.push(...j) : out.push(j);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      return c && c.d && Date.now() - c.t < CACHE_MAX_MS ? c : null;
    } catch (_) { return null; }
  }
  function writeCache(t, d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t, d })); } catch (_) {} }
  function clearCache() { try { localStorage.removeItem(CACHE_KEY); } catch (_) {} }
  const dataFresh = () => { const c = readCache(); return !!c && Date.now() - c.t < CACHE_MS; };
  const onDashboard = () => location.pathname === '/' || location.pathname === '/dashboard';

  // Signing out (or reaching a login page) drops the cache, so whoever signs in next on
  // this browser never sees the previous person's classes.
  if (/^\/(login|logout)/.test(location.pathname)) clearCache();
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f && f.getAttribute && /\/logout\b/.test(f.getAttribute('action') || '')) clearCache();
  }, true);
  try { sessionStorage.removeItem('mc-data-v3'); } catch (_) {} // old per-tab cache

  let inflight = null;
  /** Fresh data from Canvas; concurrent callers share one set of requests. */
  function fetchData() {
    if (!inflight) inflight = fetchDataNow().finally(() => { inflight = null; });
    return inflight;
  }

  /** Fetch courses + planner items, keep only the fields we need, and cache them. */
  async function fetchDataNow() {
    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const [courses, items, colorRes, cards] = await Promise.all([
      api('/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=100'),
      api(`/api/v1/planner/items?start_date=${iso(now - 14 * DAY)}&end_date=${iso(now + 45 * DAY)}&per_page=100`),
      // The user's course colours (same ones Canvas uses on dashboard cards). Optional: never fail the load.
      api('/api/v1/users/self/colors', 1).catch(() => []),
      // The cards actually shown on the dashboard (favourited courses, or Canvas's default set).
      api('/api/v1/dashboard/dashboard_cards', 1).catch(() => null)
    ]);

    // Which classes are on the dashboard (not hidden). Fall back to favourites; if neither
    // answers, don't filter at all rather than showing nothing.
    let shown = null;
    if (Array.isArray(cards) && cards.length) shown = new Set(cards.map((c) => String(c.id)));
    else {
      const fav = await api('/api/v1/users/self/favorites/courses?per_page=100', 2).catch(() => null);
      if (Array.isArray(fav) && fav.length) shown = new Set(fav.map((c) => String(c.id)));
    }
    const onDash = (cid) => !shown || shown.has(String(cid));

    // Your role in each class comes from your own enrollments on the course object:
    // type is the base role ("student", "ta", "teacher", ...); role is the role name,
    // which is a custom name (e.g. "Learning Assistant") when the school defines one.
    const STAFF = { ta: 'TA', teacher: 'Instructor' };
    const roleLabel = (e) => (e.role && !/Enrollment$/.test(e.role) ? e.role : STAFF[e.type]);
    const studentIds = new Set(), staffIds = new Set();
    const staff = [];
    for (const c of courses) {
      const ens = c.enrollments || [];
      if (ens.some((e) => e.type === 'student')) studentIds.add(String(c.id));
      const e = ens.find((x) => STAFF[x.type]);
      if (!e) continue;
      staffIds.add(String(c.id));
      if (onDash(c.id)) staff.push({ id: c.id, name: c.name || c.course_code || 'Course', role: roleLabel(e) });
    }

    // "Needs grading" comes only from the classes you teach/assist that are on the dashboard.
    const todoLists = await Promise.all(staff.map((c) =>
      api(`/api/v1/courses/${encodeURIComponent(c.id)}/todo?per_page=100`, 3)
        .then((list) => list.map((t) => ({ t, c })))
        .catch(() => [])));

    // { "course_123": "#hex" } -> { "123": "#hex" }, keeping only well-formed hex colours.
    const colors = {};
    const raw = (colorRes[0] && colorRes[0].custom_colors) || {};
    for (const [k, v] of Object.entries(raw)) {
      const m = /^course_(\d+)$/.exec(k);
      if (m && /^#[0-9a-f]{3,8}$/i.test(v)) colors[m[1]] = v;
    }

    const TYPES = new Set(['assignment', 'quiz', 'discussion_topic']);
    const grading = todoLists.flat()
      .filter(({ t }) => t && t.type === 'grading' && t.needs_grading_count > 0 && t.assignment)
      .map(({ t, c }) => ({
        title: t.assignment.name || 'Untitled',
        course: c.name,
        cid: c.id,
        count: t.needs_grading_count,
        due: t.assignment.due_at || null,
        pts: typeof t.assignment.points_possible === 'number' ? t.assignment.points_possible : null,
        url: t.html_url
      }));

    const data = {
      colors,
      grading,
      staff,
      courses: courses
        .map((c) => {
          const e = (c.enrollments || []).find((x) => x.type === 'student');
          return e && typeof e.computed_current_score === 'number'
            ? { id: c.id, name: c.name || c.course_code || 'Course', score: e.computed_current_score }
            : null;
        })
        .filter(Boolean),
      items: items
        .filter((it) => {
          if (!TYPES.has(it.plannable_type) || (it.planner_override && it.planner_override.dismissed)) return false;
          const cid = it.course_id || (it.plannable && it.plannable.course_id);
          if (cid == null) return true; // not tied to a class
          const id = String(cid);
          // Only classes on the dashboard, and not ones you only teach/assist (nothing to submit there).
          return onDash(id) && !(staffIds.has(id) && !studentIds.has(id));
        })
        .map((it) => {
          const s = it.submissions || {};
          const o = it.planner_override || {};
          return {
            title: (it.plannable && (it.plannable.title || it.plannable.name)) || 'Untitled',
            date: it.plannable_date,
            course: it.context_name || '',
            url: it.html_url,
            type: it.plannable_type,
            cid: it.course_id || (it.plannable && it.plannable.course_id),
            pts: it.plannable && typeof it.plannable.points_possible === 'number' ? it.plannable.points_possible : null,
            pid: it.plannable_id || (it.plannable && it.plannable.id),
            oid: o.id,
            done: !!(o.marked_complete || s.submitted || s.excused || s.graded)
          };
        })
    };
    writeCache(now, data);
    return data;
  }

  // Start the requests while Canvas itself is still loading, instead of after it settles.
  if (onDashboard() && (settings.todo.enabled || settings.gpa.enabled) && !dataFresh()) fetchData().catch(() => {});

  /* ---------- GPA math ---------- */

  /** Percent -> 4.0 points (standard +/- scale). */
  function gradePoints(p) {
    const t = [[93, 4], [90, 3.7], [87, 3.3], [83, 3], [80, 2.7], [77, 2.3], [73, 2], [70, 1.7], [67, 1.3], [63, 1], [60, 0.7]];
    for (const [min, pts] of t) if (p >= min) return pts;
    return 0;
  }

  /** Weighted (5.0) bonus guessed from the course name: AP/IB/dual +1, honors +0.5. */
  function weightBonus(name) {
    if (/\b(AP|IB|DE|dual)\b|advanced placement/i.test(name)) return 1;
    if (/\bhonou?rs?\b/i.test(name)) return 0.5;
    return 0;
  }

  function computeGpa(courses, scale) {
    if (!courses.length) return null;
    const weighted = scale === '5.0';
    const sum = courses.reduce((a, c) => {
      const base = gradePoints(c.score);
      return a + (weighted && base > 0 ? base + weightBonus(c.name) : base);
    }, 0);
    return sum / courses.length;
  }

  /* ---------- UI pieces ---------- */

  function ring(pct) {
    const r = 26, circ = 2 * Math.PI * r;
    const el = h('div', { class: 'ring' });
    // Only numbers are interpolated here, so innerHTML is safe.
    el.innerHTML =
      `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">` +
      `<circle class="bg" cx="32" cy="32" r="${r}"/>` +
      `<circle class="fg" cx="32" cy="32" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct / 100)}"/>` +
      `</svg><span>${Math.round(pct)}%</span>`;
    return el;
  }

  /** Only link to pages on this Canvas site (blocks javascript:/foreign URLs from API data). */
  /** Display name for a class: drops a trailing registrar/SIS code in parentheses, e.g.
   *  "IST 210, Section 002: Org Data (22681--UP---P-IST-----210-------002-)"
   *    -> "IST 210, Section 002: Org Data". Names without such a code are unchanged. */
  function shortCourse(name) {
    const s = String(name || '');
    const m = /^(.*\S)\s*\(([^()]*)\)\s*$/.exec(s);
    return m && /\d/.test(m[2]) && /-/.test(m[2]) ? m[1] : s;
  }

  function safeHref(u) {
    try {
      const url = new URL(u, location.origin);
      return url.origin === location.origin ? url.href : '#';
    } catch (_) { return '#'; }
  }

  function dueLabel(date) {
    const d = new Date(date);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const startToday = new Date().setHours(0, 0, 0, 0);
    const diff = Math.floor((new Date(d).setHours(0, 0, 0, 0) - startToday) / DAY);
    if (diff === 0) return `Today ${time}`;
    if (diff === 1) return `Tomorrow ${time}`;
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + time;
  }

  /* ---------- hover preview ---------- */

  const descCache = new Map();
  let tipHost = null, tipBody = null, tipTimer = 0, tipFor = null;

  /** Fetch an item's description once and reduce it to safe plain text.
   *  DOMParser documents are inert (no scripts run, no images load). */
  async function fetchDescription(item) {
    const key = item.type + item.pid;
    if (descCache.has(key)) return descCache.get(key);
    const path = { assignment: 'assignments', quiz: 'quizzes', discussion_topic: 'discussion_topics' }[item.type];
    let text = '';
    if (path && item.cid && item.pid) {
      const [o] = await api(`/api/v1/courses/${item.cid}/${path}/${item.pid}`, 1);
      const html = (o && (o.description || o.message)) || '';
      text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
    }
    descCache.set(key, text);
    return text;
  }

  function placeTip(li) {
    const r = li.getBoundingClientRect(), w = 300;
    let left = r.left - w - 10;                       // prefer the left (sidebar is on the right)
    if (left < 8) left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const top = Math.max(8, Math.min(r.top, innerHeight - tipHost.offsetHeight - 8));
    tipHost.style.left = left + 'px';
    tipHost.style.top = top + 'px';
  }

  function showTip(item, li) {
    if (!extAlive()) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(async () => {
      // Re-check: the extension may have been reloaded during the 350 ms hover delay.
      if (!extAlive()) return;
      if (!tipHost) {
        tipHost = document.createElement('div');
        tipHost.style.cssText = 'position:fixed;z-index:2147483000;width:300px;pointer-events:none;display:none';
        tipBody = h('div', { class: 'mc pop' });
        tipHost.attachShadow({ mode: 'open' }).append(
          h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('styles/widgets.css') }), tipBody);
        document.body.append(tipHost);
      }
      tipFor = item;
      const meta = [shortCourse(item.course), item.pts != null ? `${item.pts} pts` : null].filter(Boolean).join(' · ');
      tipBody.replaceChildren(h('h3', null, item.title), h('p', { class: 'muted small' }, meta), h('p', { class: 'desc muted' }, 'Loading…'));
      tipHost.style.display = 'block';
      placeTip(li);
      let text = null;
      try { text = await fetchDescription(item); } catch (_) {}
      if (tipFor !== item) return; // pointer moved on
      tipBody.querySelector('.desc').textContent =
        text == null ? 'Preview unavailable.' : text ? (text.length > 450 ? text.slice(0, 450).trimEnd() + '…' : text) : 'No description provided.';
      placeTip(li);
    }, 350);
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipFor = null;
    if (tipHost) tipHost.style.display = 'none';
  }

  /** Mark an item complete in Canvas (same thing its own planner does). */
  async function markComplete(item) {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/) || [])[1] || '');
    const r = await fetch(item.oid ? `/api/v1/planner/overrides/${item.oid}` : '/api/v1/planner/overrides', {
      method: item.oid ? 'PUT' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ plannable_type: item.type, plannable_id: item.pid, marked_complete: true })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    item.oid = (await r.json()).id;
  }

  /** Keep the cache in step with local changes (without extending its life). */
  function patchCache(items) {
    const c = readCache();
    if (c) { c.d.items = items; writeCache(c.t, c.d); }
  }

  /* ---------- Per-class colours ---------- */

  // Well-separated hues used when a class has no Canvas colour, or its Canvas colour is
  // too close to one another class already uses.
  const PALETTE = ['#e0457b', '#3a7bd5', '#2e9b57', '#d9992b', '#8e5cd9', '#1fa3a3',
                   '#e5632e', '#6a8f2a', '#0ea5e9', '#a21caf', '#b45309', '#64748b'];
  const MIN_DIST = 90; // "redmean" RGB distance below which two colours look alike

  const courseKey = (i) => String(i.cid != null ? i.cid : i.course || '');

  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function colorDist(a, b) {
    const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
    const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  function hslToHex(h, s, l) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /** Give every class in the list its own colour: its Canvas colour when that is distinct
   *  from the classes before it, otherwise the next distinct palette/generated colour.
   *  Classes are processed in name order so the result is stable between reloads. */
  function assignCourseColors(items, colors) {
    const byKey = new Map();
    for (const i of items) if (!byKey.has(courseKey(i))) byKey.set(courseKey(i), i);
    const courses = [...byKey.entries()].sort((x, y) => (x[1].course || '').localeCompare(y[1].course || ''));

    const used = [];
    const distinct = (c) => used.every((u) => colorDist(u, c) >= MIN_DIST);
    const out = new Map();
    let gen = 0;
    for (const [key, item] of courses) {
      let c = colors && item.cid != null ? colors[String(item.cid)] : null;
      if (!c || !distinct(c)) c = PALETTE.find((p) => !used.includes(p) && distinct(p));
      // Palette exhausted: walk the hue wheel by the golden angle until a distinct colour turns up.
      for (let tries = 0; !c && tries < 360; tries++) {
        const cand = hslToHex((gen++ * 137.508) % 360, 0.62, 0.5);
        if (distinct(cand) || tries === 359) c = cand;
      }
      used.push(c);
      out.set(key, c);
    }
    return out;
  }

  function buildTodo(items, gpa, colorOf, onCollapse) {
    const LIMIT = 6;
    let expanded = false;
    const card = h('section', { class: 'card' });

    // Filters (remembered per browser): by class and by status.
    const store = (k, v) => { try { v === undefined ? (v = localStorage.getItem(k)) : localStorage.setItem(k, v); } catch (_) {} return v; };
    let fCourse = store('mc-f-course') || '';
    let fStatus = store('mc-f-status') || 'all';
    // Collapsed state (remembered per browser). The <html> attribute lets the page CSS shrink the sidebar.
    let collapsed = store('mc-todo-collapsed') === '1';
    const setCollapsed = (v) => {
      collapsed = v;
      store('mc-todo-collapsed', v ? '1' : '0');
      flag('data-mc-todo-collapsed', v);
      paint();
    };
    flag('data-mc-todo-collapsed', collapsed);
    const courseNames = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
    if (fCourse && !courseNames.includes(fCourse)) fCourse = '';

    const matches = (i) => {
      if (fCourse && i.course !== fCourse) return false;
      const t = new Date(i.date).getTime();
      if (fStatus === 'overdue') return t < Date.now();
      // "Next N days" windows (planner data is fetched 45 days ahead, so 30 is fully covered).
      const ahead = { week: 7, '2weeks': 14, '30days': 30 }[fStatus];
      if (ahead) return t >= Date.now() && t < Date.now() + ahead * DAY;
      return true;
    };

    function filterBar() {
      const sel = (opts, value, onChange, label) => {
        const s = h('select', { 'aria-label': label }, opts.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
        s.addEventListener('change', () => { onChange(s.value); expanded = false; paint(); });
        return s;
      };
      return h('div', { class: 'filters' },
        sel([['', 'All classes'], ...courseNames.map((c) => [c, shortCourse(c)])], fCourse, (v) => { fCourse = v; store('mc-f-course', v); }, 'Filter by class'),
        sel([['all', 'All'], ['overdue', 'Overdue'], ['week', 'Next 7 days'], ['2weeks', 'Next 2 weeks'], ['30days', 'Next 30 days']], fStatus, (v) => { fStatus = v; store('mc-f-status', v); }, 'Filter by status'));
    }

    /** Check-off: fade the row, mark done locally, then tell Canvas (undo on failure). */
    function complete(item, li) {
      li.classList.add('leaving');
      setTimeout(async () => {
        item.done = true;
        patchCache(items);
        paint();
        try { await markComplete(item); }
        catch (_) { item.done = false; patchCache(items); paint(); }
      }, 220);
    }

    function paint() {
      hideTip();
      const now = Date.now();
      // Ring + counts reflect the current filter, so "CYBER 221" shows its own progress.
      const view = items.filter((i) => matches(i) || (i.done && (!fCourse || i.course === fCourse) && fStatus === 'all'));
      const done = view.filter((i) => i.done).length;
      const pct = view.length ? (done / view.length) * 100 : 0;
      const open = view.filter((i) => !i.done && matches(i)).sort((a, b) => new Date(a.date) - new Date(b.date));
      const overdueCount = open.filter((i) => new Date(i.date) < now).length;

      const isToday = (i) => new Date(i.date).toDateString() === new Date(now).toDateString();
      const row = (i) => {
        const overdue = new Date(i.date) < now;
        const li = h('li', {
          class: overdue ? 'overdue' : '',
          style: `--course: ${colorOf.get(courseKey(i))}`,
          onmouseenter: () => showTip(i, li),
          onmouseleave: hideTip
        });
        li.append(
          h('button', {
            class: 'check', type: 'button', title: 'Mark as done',
            'aria-label': `Mark "${i.title}" as done`,
            onclick: () => complete(i, li)
          }),
          h('div', { class: 'body' },
            h('a', { href: safeHref(i.url) }, i.title),
            h('div', { class: 'meta' }, h('span', { class: 'course' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), shortCourse(i.course))),
            h('div', { class: 'due' }, (overdue ? 'Overdue ' : 'Due ') + dueLabel(i.date))));
        return li;
      };

      // Items due today get their own section; everything else stays in the main list.
      const todayItems = open.filter(isToday);
      const rest = open.filter((i) => !isToday(i));
      // Everything else is grouped by the day it's due (items are already in date order).
      // Each day's count covers the whole day, even if "Show more" hides some of its items.
      const dayKey = (i) => new Date(i.date).toDateString();
      const perDay = new Map();
      for (const i of rest) perDay.set(dayKey(i), (perDay.get(dayKey(i)) || 0) + 1);
      const shown = rest.slice(0, expanded ? undefined : LIMIT);
      const days = [];
      for (const i of shown) {
        const last = days[days.length - 1];
        if (last && last.key === dayKey(i)) last.items.push(i);
        else days.push({ key: dayKey(i), date: new Date(i.date), items: [i] });
      }
      const startToday = new Date(now).setHours(0, 0, 0, 0);
      const dayLabel = (d) => {
        const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - startToday) / DAY);
        const name = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        if (diff === 1) return { text: `Tomorrow · ${name}`, past: false };
        if (diff < 0) return { text: `${name} · Overdue`, past: true };
        return { text: name, past: false };
      };
      const list = h('div', { class: 'days' }, days.map((g) => {
        const { text, past } = dayLabel(g.date);
        return h('div', { class: 'day' },
          h('h4', { class: past ? 'day-h past' : 'day-h' }, text, h('span', { class: 'day-n' }, String(perDay.get(g.key)))),
          h('ul', { class: 'todo' }, g.items.map(row)));
      }));
      const todaySection = todayItems.length
        ? h('div', { class: 'today' },
            h('h4', null, 'Due today', h('span', { class: 'chip' }, String(todayItems.length))),
            h('ul', { class: 'todo' }, todayItems.map(row)))
        : null;

      const more = h('button', { class: 'link', hidden: rest.length <= LIMIT, onclick: () => { expanded = !expanded; paint(); } },
        expanded ? 'Show less' : `Show ${rest.length - LIMIT} more`);

      if (onCollapse) onCollapse(collapsed);
      if (collapsed) {
        card.classList.add('collapsed');
        card.replaceChildren(
          h('button', {
            class: 'toggle', type: 'button', title: 'Expand to-do',
            'aria-label': 'Expand to-do panel', 'aria-expanded': 'false',
            onclick: () => setCollapsed(false)
          }, '«'),
          ring(pct),
          h('p', { class: 'muted small' }, `${open.length} left`));
        return;
      }
      card.classList.remove('collapsed');

      // Native replaceChildren() turns null into the text "null", so drop empty sections first.
      card.replaceChildren(...[
        h('div', { class: 'row' },
          ring(pct),
          h('div', { class: 'head' },
            h('h3', null, 'To-Do', gpa != null && h('span', { class: 'chip', title: `${settings.gpa.scale} scale` }, `GPA ${gpa.toFixed(2)}`)),
            h('p', { class: 'muted' }, `${done} of ${view.length} done · ${overdueCount} overdue`)),
          h('button', {
            class: 'toggle', type: 'button', title: 'Collapse to-do',
            'aria-label': 'Collapse to-do panel', 'aria-expanded': 'true',
            onclick: () => setCollapsed(true)
          }, '»')),
        filterBar(),
        todaySection,
        rest.length ? list : todayItems.length ? null : h('p', { class: 'muted' }, fCourse || fStatus !== 'all' ? 'Nothing matches this filter.' : 'Nothing due — nice work!'),
        more].filter(Boolean));
    }

    paint();
    return card;
  }

  /** "Needs grading" card: one section per class you are a TA/LA/instructor for (and that is
   *  on the dashboard), listing assignments with ungraded submissions. Returns null when you
   *  have no such classes. */
  function buildGrading(list, staff, colorOf) {
    if (!staff.length) return null;
    const PER_GROUP = 5;
    const byDue = (a, b) => (a.due ? new Date(a.due) : Infinity) - (b.due ? new Date(b.due) : Infinity);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const groups = staff
      .map((c) => {
        const key = String(c.id);
        const items = list.filter((it) => String(it.cid) === key).sort(byDue);
        return { key, name: c.name, role: c.role, items, total: items.reduce((n, it) => n + it.count, 0) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const total = groups.reduce((n, g) => n + g.total, 0);

    const group = (g) => {
      let showAll = false;
      const color = colorOf.get(g.key);
      const ul = h('ul', { class: 'todo' });
      const more = h('button', { class: 'link', type: 'button' });
      const paint = () => {
        ul.replaceChildren(...g.items.slice(0, showAll ? undefined : PER_GROUP).map((it) =>
          h('li', { style: `--course: ${color}` },
            h('span', { class: 'badge', title: plural(it.count, 'submission needs grading', 'submissions need grading') }, String(it.count)),
            h('div', { class: 'body' },
              h('a', { href: safeHref(it.url), target: '_blank', rel: 'noopener' }, it.title),
              it.pts != null && h('div', { class: 'meta' }, h('span', null, `${it.pts} pts`)),
              h('div', { class: 'due' }, it.due ? 'Due ' + dueLabel(it.due) : 'No due date')))));
        more.hidden = g.items.length <= PER_GROUP;
        more.textContent = more.hidden ? '' : showAll ? 'Show less' : `Show ${g.items.length - PER_GROUP} more`;
      };
      more.addEventListener('click', () => { showAll = !showAll; paint(); });
      paint();
      return h('details', { class: 'group', open: true, style: `--course: ${color}` },
        h('summary', null,
          h('i', { class: 'dot', 'aria-hidden': 'true' }),
          h('span', { class: 'gname' }, shortCourse(g.name)),
          g.role && h('span', { class: 'role', title: `Your role: ${g.role}` }, g.role),
          h('span', { class: 'count', title: plural(g.total, 'submission', 'submissions') + ' to grade' }, String(g.total))),
        g.items.length ? ul : h('p', { class: 'muted small caught-up' }, 'All caught up, nothing to grade.'),
        more);
    };

    const assignments = groups.reduce((n, g) => n + g.items.length, 0);
    return h('section', { class: 'card grading' },
      h('div', { class: 'row' },
        h('div', { class: 'head' },
          h('h3', null, 'Needs grading', h('span', { class: 'chip' }, String(total))),
          h('p', { class: 'muted' },
            total
              ? `${plural(total, 'submission', 'submissions')} · ${plural(assignments, 'assignment', 'assignments')}`
              : 'All caught up'))),
      ...groups.map(group));
  }

  /** "What grade do I need?" form for one course. Fetches its assignments lazily. */
  async function initCalc(box, course) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Loading assignments…'));
    let remaining = 20;
    try {
      const list = await api(`/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`, 5);
      let total = 0, graded = 0;
      for (const a of list) {
        const s = a.submission;
        if (!a.points_possible || a.omit_from_final_grade || (s && s.excused)) continue;
        total += a.points_possible;
        if (s && typeof s.score === 'number') graded += a.points_possible;
      }
      if (total > 0) remaining = Math.round(((total - graded) / total) * 1000) / 10;
    } catch (_) { /* keep the manual default */ }

    const target = h('input', { type: 'number', min: 0, max: 200, step: 0.5, value: 90 });
    const weight = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: remaining });
    const out = h('p', { class: 'result' });
    const calc = () => {
      const t = parseFloat(target.value), w = parseFloat(weight.value) / 100;
      if (isNaN(t) || isNaN(w)) { out.textContent = ''; return; }
      if (w <= 0) { out.textContent = `No work left to count — your grade is ${course.score.toFixed(1)}%.`; return; }
      const need = (t - course.score * (1 - w)) / w;
      out.textContent =
        need <= 0 ? `You're safe — even 0% on the rest keeps you at ${t}%.`
        : need > 100 ? `You'd need ${need.toFixed(1)}% on the rest — above 100%, so only extra credit could do it.`
        : `You need ${need.toFixed(1)}% on the remaining ${(w * 100).toFixed(0)}% of the grade.`;
    };
    target.addEventListener('input', calc);
    weight.addEventListener('input', calc);
    box.replaceChildren(
      h('label', null, 'Target grade %', target),
      h('label', null, 'Remaining weight %', weight),
      out,
      h('p', { class: 'muted small' }, 'Remaining weight is estimated from ungraded points; edit it for weighted categories.'));
    calc();
  }

  /* ---------- grade badges on the class cards ---------- */

  let courseMap = new Map();   // course id -> { id, name, score }
  let dataReady = false;
  let cardObserver = null;
  let popHost = null;

  const gradeColor = (p) => (p >= 90 ? '#2e9b57' : p >= 80 ? '#3a7bd5' : p >= 70 ? '#d9992b' : '#d9534f');

  /** Add a grade badge to every dashboard card that doesn't have one yet. */
  function decorateCards() {
    if (!dataReady || !settings.gpa.enabled) return;
    for (const card of document.querySelectorAll('.ic-DashboardCard:not([data-mc-badged])')) {
      card.setAttribute('data-mc-badged', '1'); // mark even without a grade so we never rescan it
      const a = card.querySelector('a[href*="/courses/"]');
      const m = a && a.getAttribute('href').match(/\/courses\/(\d+)/);
      const course = m && courseMap.get(m[1]);
      if (!course) continue;
      const calc = settings.gpa.calculator;
      const badge = h('button', {
        class: 'mc-grade', type: 'button',
        title: calc ? 'Click: what grade do I need?' : 'Current grade',
        style: `background:${gradeColor(course.score)}`
      }, `${course.score.toFixed(1)}%`);
      if (calc) badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openCalc(badge, course); });
      card.append(badge);
    }
  }

  /** Cards are rendered by React after load and can be re-rendered later, so
   *  watch the dashboard (debounced to one check per frame) and badge new ones. */
  function watchCards() {
    const dash = document.getElementById('dashboard');
    if (!dash || cardObserver) return;
    let queued = false;
    cardObserver = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; decorateCards(); });
    });
    cardObserver.observe(dash, { childList: true, subtree: true });
  }

  /** Small popover with the "what grade do I need?" calculator. */
  function openCalc(anchor, course) {
    if (!extAlive()) return;
    closeCalc();
    const r = anchor.getBoundingClientRect();
    popHost = document.createElement('div');
    popHost.style.cssText =
      `position:fixed;z-index:2147483000;width:280px;` +
      `top:${Math.max(8, Math.min(r.bottom + 6, innerHeight - 320))}px;` +
      `left:${Math.max(8, Math.min(r.left, innerWidth - 296))}px`;
    const sh = popHost.attachShadow({ mode: 'open' });
    const box = h('div', { class: 'calc' });
    sh.append(
      h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('styles/widgets.css') }),
      h('div', { class: 'mc pop' },
        h('h3', null, shortCourse(course.name)),
        h('p', { class: 'muted' }, `Current grade ${course.score.toFixed(1)}%`),
        box));
    document.body.append(popHost);
    initCalc(box, course);
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('scroll', closeCalc, { once: true, passive: true });
    }, 0);
  }
  const onOutside = (e) => { if (popHost && !e.composedPath().includes(popHost)) closeCalc(); };
  const onEsc = (e) => { if (e.key === 'Escape') closeCalc(); };
  function closeCalc() {
    if (popHost) { popHost.remove(); popHost = null; }
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }

  /* ---------- mounting ---------- */

  let gen = 0; // bumped on every (re)mount so stale async work can bail out

  function unmount() {
    gen++;
    quietRefresh = null;
    if (host) { host.remove(); host = null; }
    root.removeAttribute('data-mc-todo-collapsed');
    closeCalc();
    hideTip();
    if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
    dataReady = false;
    document.querySelectorAll('.mc-grade').forEach((b) => b.remove());
    document.querySelectorAll('[data-mc-badged]').forEach((c) => c.removeAttribute('data-mc-badged'));
  }

  let quietRefresh = null; // set by the current mount: fetch fresh data, redraw if changed

  /** (Re)build the panel as soon as the page's HTML is ready. Building it is cheap; the
   *  data comes from the cache or from requests already started at load. */
  function mountWidget() {
    if (!extAlive()) return;
    // Never synchronously: this can be called during startup, before the rest of this
    // script (state it uses further down) has run.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderWidget, { once: true });
    else setTimeout(renderWidget, 0);
  }

  async function renderWidget() {
    if (!extAlive()) return;
    unmount();
    const mine = gen;
    const wantTodo = settings.todo.enabled, wantGrades = settings.gpa.enabled;
    if (!wantTodo && !wantGrades) return;
    if (location.pathname !== '/' && location.pathname !== '/dashboard') return;

    // To-do panel goes at the top of the RIGHT sidebar only.
    let body = null;
    // Mount in the wrapper *around* #right-side: Canvas re-renders the contents
    // of #right-side itself and would wipe our panel.
    const side = document.getElementById('right-side');
    if (wantTodo && side) {
      const me = (host = document.createElement('div'));
      me.id = 'mc-widget-host';
      me.style.visibility = 'hidden'; // revealed once the stylesheet loads (no unstyled flash)
      const shadow = me.attachShadow({ mode: 'open' });
      const link = h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('styles/widgets.css') });
      link.addEventListener('load', () => (me.style.visibility = 'visible'));
      body = h('div', { class: 'mc' }, h('p', { class: 'muted' }, 'Loading…'));
      shadow.append(link, body, makeGrip(me));
      side.before(me);
    }

    let drawn = ''; // JSON of the data currently shown, so unchanged refreshes do nothing
    const draw = (data) => {
      const sig = JSON.stringify(data);
      if (sig === drawn) return;
      const redraw = !!drawn;
      drawn = sig;
      courseMap = new Map(data.courses.map((c) => [String(c.id), c]));
      dataReady = true;
      if (body) {
        const gpa = settings.gpa.showGpa ? computeGpa(data.courses, settings.gpa.scale) : null;
        const grading = data.grading || [], staff = data.staff || [];
        const colorOf = assignCourseColors(
          [...data.items, ...staff.map((c) => ({ cid: c.id, course: c.name }))], data.colors);
        const todoCard = buildTodo(data.items, gpa, colorOf, (c) => { body.classList.toggle('is-collapsed', c); if (host) host.classList.toggle('mc-collapsed', c); });
        hideTip();
        body.replaceChildren(todoCard, buildGrading(grading, staff, colorOf) || '');
      }
      if (wantGrades) {
        if (redraw) { // grades may have changed: rebuild the card badges
          closeCalc();
          document.querySelectorAll('.mc-grade').forEach((b) => b.remove());
          document.querySelectorAll('[data-mc-badged]').forEach((c) => c.removeAttribute('data-mc-badged'));
        }
        decorateCards(); watchCards();
      } else closeCalc();
    };
    const refresh = async () => {
      try {
        const data = await fetchData();
        if (mine === gen) draw(data); // skip if superseded by a newer mount
      } catch (_) {
        if (mine === gen && body && !drawn) body.replaceChildren(h('p', { class: 'muted' }, "My Canvas couldn't load your data. Try refreshing."));
      }
    };
    quietRefresh = refresh;

    const cached = readCache();
    if (cached) { try { draw(cached.d); } catch (_) { drawn = ''; } }
    if (!cached || Date.now() - cached.t >= CACHE_MS) await refresh();
  }
})();
