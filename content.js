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
    flag('data-mc-todo', settings.todo.enabled); // hides Canvas's own To Do (see dashboard.css)
    if (d.font === 'default') root.removeAttribute('data-mc-font');
    else root.setAttribute('data-mc-font', d.font);

    const st = root.style;
    // Custom accent overrides the theme's; otherwise the theme CSS supplies --mc-accent.
    if (settings.accent) st.setProperty('--mc-accent', settings.accent);
    else st.removeProperty('--mc-accent');
    st.setProperty('--mc-grad-a', d.gradA);
    st.setProperty('--mc-grad-b', d.gradB);
  }

  // Dark mode follows the OS only while the user picked "system".
  mq.addEventListener('change', () => settings.dark.mode === 'system' && applyStyles());

  // Re-check the schedule when the tab becomes visible (covers sleep/wake).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (settings.dark.mode === 'schedule') applyStyles();
    // Coming back to the tab (e.g. after submitting an assignment elsewhere):
    // if the cached data is stale, rebuild so finished items drop off the list.
    if (host && !dataFresh()) mountWidget();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'mc-tick') applyStyles();
  });

  // Instant first paint (avoids a white flash): use the last settings cached
  // in localStorage, then reconcile with chrome.storage once it answers.
  try {
    const boot = localStorage.getItem('mc-boot');
    if (boot) settings = MC.sanitize(JSON.parse(boot));
  } catch (_) { /* storage may be blocked; ignore */ }
  applyStyles();

  chrome.storage.sync.get('settings').then(({ settings: s }) => {
    settings = MC.sanitize(s);
    cacheBoot();
    applyStyles();
    whenDomReady(mountWidget);
  });

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

  const CACHE_KEY = 'mc-data-v1';
  const CACHE_MS = 60 * 1000; // short, so submitted work disappears quickly
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

  function dataFresh() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      return !!c && Date.now() - c.t < CACHE_MS;
    } catch (_) { return false; }
  }

  /** Fetch courses + planner items once, keep only the fields we need, cache 5 min. */
  async function loadData() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (c && Date.now() - c.t < CACHE_MS) return c.d;
    } catch (_) {}

    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const [courses, items] = await Promise.all([
      api('/api/v1/courses?enrollment_state=active&include[]=total_scores&per_page=100'),
      api(`/api/v1/planner/items?start_date=${iso(now - 14 * DAY)}&end_date=${iso(now + 45 * DAY)}&per_page=100`)
    ]);

    const TYPES = new Set(['assignment', 'quiz', 'discussion_topic']);
    const data = {
      courses: courses
        .map((c) => {
          const e = (c.enrollments || []).find((x) => x.type === 'student');
          return e && typeof e.computed_current_score === 'number'
            ? { id: c.id, name: c.name || c.course_code || 'Course', score: e.computed_current_score }
            : null;
        })
        .filter(Boolean),
      items: items
        .filter((it) => TYPES.has(it.plannable_type) && !(it.planner_override && it.planner_override.dismissed))
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
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: now, d: data })); } catch (_) {}
    return data;
  }

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
    clearTimeout(tipTimer);
    tipTimer = setTimeout(async () => {
      if (!tipHost) {
        tipHost = document.createElement('div');
        tipHost.style.cssText = 'position:fixed;z-index:2147483000;width:300px;pointer-events:none;display:none';
        tipBody = h('div', { class: 'mc pop' });
        tipHost.attachShadow({ mode: 'open' }).append(
          h('link', { rel: 'stylesheet', href: chrome.runtime.getURL('styles/widgets.css') }), tipBody);
        document.body.append(tipHost);
      }
      tipFor = item;
      const meta = [item.course, item.pts != null ? `${item.pts} pts` : null].filter(Boolean).join(' · ');
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

  /** Keep the 1-minute cache in step with local changes (without extending its life). */
  function patchCache(items) {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (c) { c.d.items = items; sessionStorage.setItem(CACHE_KEY, JSON.stringify(c)); }
    } catch (_) {}
  }

  function buildTodo(items, gpa) {
    const LIMIT = 6;
    let expanded = false;
    const card = h('section', { class: 'card' });

    // Filters (remembered per browser): by class and by status.
    const store = (k, v) => { try { v === undefined ? (v = localStorage.getItem(k)) : localStorage.setItem(k, v); } catch (_) {} return v; };
    let fCourse = store('mc-f-course') || '';
    let fStatus = store('mc-f-status') || 'all';
    const courseNames = [...new Set(items.map((i) => i.course).filter(Boolean))].sort();
    if (fCourse && !courseNames.includes(fCourse)) fCourse = '';

    const matches = (i) => {
      if (fCourse && i.course !== fCourse) return false;
      const t = new Date(i.date).getTime();
      if (fStatus === 'overdue') return t < Date.now();
      if (fStatus === 'week') return t >= Date.now() && t < Date.now() + 7 * DAY;
      return true;
    };

    function filterBar() {
      const sel = (opts, value, onChange, label) => {
        const s = h('select', { 'aria-label': label }, opts.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
        s.addEventListener('change', () => { onChange(s.value); expanded = false; paint(); });
        return s;
      };
      return h('div', { class: 'filters' },
        sel([['', 'All classes'], ...courseNames.map((c) => [c, c])], fCourse, (v) => { fCourse = v; store('mc-f-course', v); }, 'Filter by class'),
        sel([['all', 'All'], ['overdue', 'Overdue'], ['week', 'Next 7 days']], fStatus, (v) => { fStatus = v; store('mc-f-status', v); }, 'Filter by status'));
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

      const list = h('ul', { class: 'todo' },
        open.slice(0, expanded ? undefined : LIMIT).map((i) => {
          const overdue = new Date(i.date) < now;
          const li = h('li', {
            class: overdue ? 'overdue' : '',
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
              h('div', { class: 'meta' }, h('span', null, i.course), h('b', null, (overdue ? 'Overdue · ' : '') + dueLabel(i.date)))));
          return li;
        }));

      const more = h('button', { class: 'link', hidden: open.length <= LIMIT, onclick: () => { expanded = !expanded; paint(); } },
        expanded ? 'Show less' : `Show ${open.length - LIMIT} more`);

      card.replaceChildren(
        h('div', { class: 'row' },
          ring(pct),
          h('div', null,
            h('h3', null, 'To-Do', gpa != null && h('span', { class: 'chip', title: `${settings.gpa.scale} scale` }, `GPA ${gpa.toFixed(2)}`)),
            h('p', { class: 'muted' }, `${done} of ${view.length} done · ${overdueCount} overdue`))),
        filterBar(),
        open.length ? list : h('p', { class: 'muted' }, fCourse || fStatus !== 'all' ? 'Nothing matches this filter.' : 'Nothing due — nice work!'),
        more);
    }

    paint();
    return card;
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
        h('h3', null, course.name),
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
    if (host) { host.remove(); host = null; }
    closeCalc();
    hideTip();
    if (cardObserver) { cardObserver.disconnect(); cardObserver = null; }
    dataReady = false;
    document.querySelectorAll('.mc-grade').forEach((b) => b.remove());
    document.querySelectorAll('[data-mc-badged]').forEach((c) => c.removeAttribute('data-mc-badged'));
  }

  /** Schedule a (re)build for when the browser is idle so page load is never delayed. */
  function mountWidget() {
    if (window.requestIdleCallback) requestIdleCallback(renderWidget, { timeout: 2000 });
    else setTimeout(renderWidget, 200);
  }

  async function renderWidget() {
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
      shadow.append(link, body);
      side.before(me);
    }

    try {
      const data = await loadData();
      if (mine !== gen) return; // superseded by a newer mount
      courseMap = new Map(data.courses.map((c) => [String(c.id), c]));
      dataReady = true;
      if (body) {
        const gpa = wantGrades ? computeGpa(data.courses, settings.gpa.scale) : null;
        body.replaceChildren(buildTodo(data.items, gpa));
        if (!wantGrades) closeCalc();
      }
      if (wantGrades) { decorateCards(); watchCards(); }
    } catch (_) {
      if (mine === gen && body) body.replaceChildren(h('p', { class: 'muted' }, "My Canvas couldn't load your data. Try refreshing."));
    }
  }
})();
