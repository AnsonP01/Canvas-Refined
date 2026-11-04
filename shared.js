/**
 * shared.js — settings schema + helpers used by content.js, popup.js and
 * background.js (loaded via <script>, content_scripts and importScripts).
 * Exposes a single global: MC.
 */
(function (root) {
  'use strict';

  // Firefox: `browser.*` is its promise-based version of the same API, so use it for every
  // `chrome.*` call (all calls in this extension use promises, never callbacks).
  // Chrome has no `browser`, so this does nothing there.
  if (typeof root.browser === 'object' && root.browser && root.browser.runtime && root.chrome !== root.browser) {
    try { root.chrome = root.browser; } catch (_) { /* read-only: Firefox's chrome.* then works as-is */ }
  }

  /** Default settings. Also defines the schema used to sanitize imports. */
  const DEFAULTS = {
    dark: {
      enabled: false,
      mode: 'always',        // 'always' | 'system' | 'schedule'
      start: '19:00',        // schedule: dark from…
      end: '07:00',          // …until
      theme: 'graphite',
      warm: false,           // night warm tint (blue-light filter)
      warmLevel: 25          // tint strength, 5–60 (%)
    },
    accent: '',              // '' = use the active theme's own accent; a #hex overrides it
    dashboard: {
      themeCards: true,      // recolor card headers from the dark theme (needs dark mode on)
      gradient: false,
      gradA: '#6c8cff',
      gradB: '#c85aa0',
      condensed: false,
      font: 'default',       // 'default' | 'inter' | 'poppins' | 'jetbrains'
      hideLogo: false,
      hideFeedback: false
    },
    todo: { enabled: true },
    gpa: {
      enabled: true,         // grade badges on class cards
      showGpa: true,         // GPA chip in the to-do panel header
      scale: '4.0',          // '4.0' (college) | '5.0' (weighted high school)
      calculator: true       // "what grade do I need"
    }
  };

  /** Palettes here are for the popup preview only; real styling is in styles/themes/*.css */
  const THEMES = {
    // `accent` is applied when the theme is picked in the popup (user can still override it).
    graphite:      { label: 'Graphite',     bg: '#1b1d21', surface: '#26292f', text: '#e6e8eb', accent: '#6c8cff' },
    obsidian:      { label: 'Obsidian',     bg: '#08080a', surface: '#131316', text: '#e4e4e7', accent: '#a78bfa' },
    'sunset-rose': { label: 'Sunset Rose',  bg: '#1f1418', surface: '#2e1d24', text: '#f6e6ea', accent: '#f4728e' },
    night:         { label: 'Night',        bg: '#15110d', surface: '#211a14', text: '#e9d9c3', accent: '#e8a25c' }
  };

  const FONTS = {
    default:   { label: 'Canvas default', css: '' },
    inter:     { label: 'Inter',          css: "'MC Inter', system-ui, sans-serif" },
    poppins:   { label: 'Poppins',        css: "'MC Poppins', system-ui, sans-serif" },
    jetbrains: { label: 'JetBrains Mono', css: "'MC JetBrains Mono', ui-monospace, monospace" }
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const HEX = /^#[0-9a-f]{6}$/i;
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  /** Copy only known keys with the right types; anything else falls back to defaults. */
  function sanitize(input, def = DEFAULTS) {
    const out = {};
    for (const key of Object.keys(def)) {
      const d = def[key];
      const v = isObj(input) ? input[key] : undefined;
      if (isObj(d)) out[key] = sanitize(v, d);
      else out[key] = typeof v === typeof d ? v : d;
    }
    if (def === DEFAULTS) {
      // '#6c8cff' was the old default; treat it as "no custom accent" so themes can colour themselves.
      if (out.accent === '#6c8cff' || !HEX.test(out.accent)) out.accent = '';
      if (!THEMES[out.dark.theme]) out.dark.theme = DEFAULTS.dark.theme;
      if (!['always', 'system', 'schedule'].includes(out.dark.mode)) out.dark.mode = 'always';
      out.dark.warmLevel = Math.min(60, Math.max(5, Math.round(out.dark.warmLevel) || DEFAULTS.dark.warmLevel));
      if (!TIME.test(out.dark.start)) out.dark.start = DEFAULTS.dark.start;
      if (!TIME.test(out.dark.end)) out.dark.end = DEFAULTS.dark.end;
      if (!HEX.test(out.dashboard.gradA)) out.dashboard.gradA = DEFAULTS.dashboard.gradA;
      if (!HEX.test(out.dashboard.gradB)) out.dashboard.gradB = DEFAULTS.dashboard.gradB;
      if (!FONTS[out.dashboard.font]) out.dashboard.font = 'default';
      if (!['4.0', '5.0'].includes(out.gpa.scale)) out.gpa.scale = '4.0';
    }
    return out;
  }

  async function load() {
    const { settings } = await chrome.storage.sync.get('settings');
    return sanitize(settings);
  }

  function save(settings) {
    return chrome.storage.sync.set({ settings });
  }

  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  /** Should dark mode be active right now? */
  function isDarkNow(s, systemDark, now = new Date()) {
    if (!s.dark.enabled) return false;
    if (s.dark.mode === 'system') return !!systemDark;
    if (s.dark.mode === 'schedule') {
      const cur = now.getHours() * 60 + now.getMinutes();
      const a = toMin(s.dark.start), b = toMin(s.dark.end);
      if (a === b) return true;
      return a < b ? cur >= a && cur < b : cur >= a || cur < b; // handles overnight ranges
    }
    return true;
  }

  /** Next moment the schedule flips (start or end time). */
  function nextBoundary(dark, now = new Date()) {
    const c = [dark.start, dark.end].map((t) => {
      const d = new Date(now);
      d.setHours(...t.split(':').map(Number), 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      return d;
    });
    return c[0] < c[1] ? c[0] : c[1];
  }

  root.MC = { DEFAULTS, THEMES, FONTS, sanitize, load, save, isDarkNow, nextBoundary };
})(globalThis);
