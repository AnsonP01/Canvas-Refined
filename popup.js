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

  // Saving: toggles, dropdowns and theme tiles save at once. Sliders and colour pickers fire
  // many events while dragging and chrome.storage.sync is rate-limited, so those wait for a
  // short pause. Anything still waiting is saved the moment the popup closes: closing it
  // otherwise cancels the wait and the last change would be lost.
  let timer, dirty = false;
  const flush = () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    MC.save(settings).catch(() => msg('Could not save settings. Try again.'));
  };
  const save = (immediately) => { dirty = true; clearTimeout(timer); if (immediately) flush(); else timer = setTimeout(flush, 350); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

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
    b.addEventListener('click', () => { settings.dark.theme = k; settings.dark.enabled = true; settings.accent = ''; render(true); save(true); });
    tiles.append(b);
  }

  /* ---------- bind controls ---------- */

  const controls = [...document.querySelectorAll('[data-key]')];
  for (const el of controls) {
    el.addEventListener('input', () => {
      set(settings, el.dataset.key, el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value);
      save(!['range', 'color', 'time'].includes(el.type));
      render(false);
    });
  }

  // "Follow system" dark mode: restyle the popup if the OS switches while it's open.
  const sysDark = matchMedia('(prefers-color-scheme: dark)');
  sysDark.addEventListener('change', () => render(false));

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
    // Popup follows Canvas's current look: the chosen theme while dark mode is active, light otherwise.
    const html = document.documentElement;
    html.setAttribute('data-mc-theme', settings.dark.theme);
    if (MC.isDarkNow(settings, sysDark.matches)) html.setAttribute('data-mc-dark', '');
    else html.removeAttribute('data-mc-dark');
    html.style.setProperty('--ac', accent());
    $('#schedule').hidden = settings.dark.mode !== 'schedule';
    $('#gradients').style.opacity = settings.dashboard.gradient ? 1 : 0.5;
    for (const b of tiles.children) b.setAttribute('aria-pressed', String(b.dataset.theme === settings.dark.theme));
  }

  /* ---------- export / import / reset ---------- */

  const msg = (t) => { $('#msg').textContent = t; setTimeout(() => ($('#msg').textContent = ''), 3000); };

  // Firefox closes an extension popup the moment a file picker opens, so the chosen file
  // never arrives. There, Import opens this same panel in a tab, where picking a file works.
  const isFirefox = navigator.userAgent.includes('Firefox/');
  const inTab = new URLSearchParams(location.search).has('tab');
  if (inTab) document.documentElement.classList.add('tab');

  $('#export').addEventListener('click', () => {
    // A data: URL (not a blob: URL) so the download still works if the popup closes mid-way.
    const href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(settings, null, 2));
    const a = Object.assign(document.createElement('a'), { href, download: 'my-canvas-settings.json' });
    document.body.append(a); // Firefox only follows clicks on links that are in the page
    a.click();
    a.remove();
    msg('Exported.');
  });

  $('#import').addEventListener('click', () => {
    if (isFirefox && !inTab) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab') });
      window.close();
      return;
    }
    $('#file').click();
  });
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

  /* ---------- site access ---------- */

  // Chrome grants the Canvas host permission at install. Firefox can leave it off (and the
  // user can revoke it in either browser), which silently stops everything, so offer to fix it.
  const CANVAS = { origins: ['*://*.instructure.com/*'] };
  const access = $('#access');
  if (chrome.permissions) {
    chrome.permissions.contains(CANVAS).then((ok) => { access.hidden = ok; }).catch(() => {});
    $('#grant').addEventListener('click', () => {
      // Called straight from the click, with nothing awaited first: Firefox only shows the
      // permission prompt during the click itself.
      chrome.permissions.request(CANVAS).then((ok) => { if (ok) access.hidden = true; }).catch(() => {});
    });
  }

  render();
})();
