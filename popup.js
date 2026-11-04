/**
 * popup.js — settings panel. Binds every [data-key="a.b"] control to the
 * matching settings path, auto-saves (debounced) to chrome.storage.sync.
 * Export/import is plain JSON, sanitized on import.
 */
(async () => {
  'use strict';

  let settings = await MC.load();
  const $ = (s) => document.querySelector(s);
  const get = (o, p) => p.split('.').reduce((a, k) => a && a[k], o);
  const set = (o, p, v) => { const k = p.split('.'); const l = k.pop(); k.reduce((a, x) => a[x], o)[l] = v; };

  // Debounced save: dragging a color picker fires many events, but
  // chrome.storage.sync is rate-limited, so write at most once per pause.
  let timer;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => MC.save(settings), 350); };

  /* ---------- build dynamic controls ---------- */

  const fontSel = $('#font');
  for (const [k, f] of Object.entries(MC.FONTS)) fontSel.append(new Option(f.label, k));

  const tiles = $('#themes');
  for (const [k, t] of Object.entries(MC.THEMES)) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.type = 'button';
    b.dataset.theme = k;
    b.innerHTML = `<div class="mock" style="background:${t.bg}"><i style="background:${t.surface}"></i><i style="background:${t.surface}"></i><i></i></div><span></span>`;
    b.querySelector('span').textContent = t.label;
    // Choosing a theme also switches dark mode on, so the choice is visible immediately.
    b.addEventListener('click', () => { settings.dark.theme = k; settings.dark.enabled = true; settings.accent = ''; render(true); save(); });
    tiles.append(b);
  }

  /* ---------- bind controls ---------- */

  const controls = [...document.querySelectorAll('[data-key]')];
  for (const el of controls) {
    el.addEventListener('input', () => {
      set(settings, el.dataset.key, el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
      save();
      render(false);
    });
  }

  /** Effective accent: the user's custom one, else the current theme's. */
  const accent = () => settings.accent || MC.THEMES[settings.dark.theme].accent;

  /** Push settings into the UI. `syncInputs=false` while typing so we don't fight the user. */
  function render(syncInputs = true) {
    if (syncInputs) {
      for (const el of controls) {
        let v = get(settings, el.dataset.key);
        if (el.dataset.key === 'accent') v = accent(); // color input needs a real #hex
        if (el.type === 'checkbox') el.checked = v; else el.value = v;
      }
    }
    document.documentElement.style.setProperty('--ac', accent());
    $('#schedule').hidden = settings.dark.mode !== 'schedule';
    $('#gradients').style.opacity = settings.dashboard.gradient ? 1 : 0.5;
    for (const b of tiles.children) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.dark.theme));
  }

  /* ---------- export / import / reset ---------- */

  const msg = (t) => { $('#msg').textContent = t; setTimeout(() => ($('#msg').textContent = ''), 3000); };

  $('#export').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'my-canvas-settings.json' });
    a.click();
    URL.revokeObjectURL(url);
    msg('Exported.');
  });

  $('#import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      settings = MC.sanitize(JSON.parse(await f.text()));
      await MC.save(settings);
      render();
      msg('Imported.');
    } catch (_) { msg('That file is not valid settings JSON.'); }
  });

  $('#reset').addEventListener('click', async () => {
    settings = MC.sanitize(null);
    await MC.save(settings);
    render();
    msg('Reset to defaults.');
  });

  render();
})();
