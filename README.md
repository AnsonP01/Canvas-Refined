# My Canvas

A lightweight Chrome / Brave / Firefox extension (Manifest V3) that improves the Canvas LMS (`*.instructure.com`) with dark mode, dashboard customization, a better to-do list, and grade tools. Vanilla JavaScript, no frameworks, no build step, no tracking.

## Features

**Dark mode**
- On/off toggle; always on, follow the system, or a custom schedule (e.g. 7 PM – 7 AM)
- Themes: Graphite, Obsidian, Sunset Rose, Night (each with its own accent color)
- Optional warm "night tint" (blue-light filter) with adjustable strength

**Dashboard**
- Card colors that follow your theme, or your own two-color gradient
- Condensed cards (more on screen)
- Fonts: Inter, Poppins, JetBrains Mono (bundled, no network requests)
- Remove the institution logo; hide the "Recent Feedback" widget

**Better to-do list** (right sidebar, replaces Canvas's own)
- Upcoming items across all courses, sorted by due date, overdue highlighted
- Progress ring showing completion %
- Circle button to check items off (saved to Canvas); submitted work drops off automatically
- Filter by class and by status (overdue / next 7 days)
- Hover an item to preview its description

**Grades**
- Current grade badge on each class card
- Small GPA readout (4.0 college scale or 5.0 weighted high-school scale)
- Click a badge for a "what grade do I need?" calculator

**Settings popup**
- Toggle every feature, theme picker with live preview, accent color picker
- Export / import settings as JSON

## Download

Every commit to `main` is built automatically ([.github/workflows/release.yml](.github/workflows/release.yml)) and published on the [Releases](https://github.com/AnsonP01/Canvas-Refined/releases) page:

- `my-canvas-chromium-<version>.zip`: Chrome, Edge, Brave, Vivaldi, Opera. Unzip it, then follow the Chrome steps below and pick the unzipped folder.
- `my-canvas-firefox-<version>.zip`: Firefox 128+. Load it with the Firefox steps below (pick the zip), or upload it to addons.mozilla.org for signing.

A commit that changes the version in `manifest.json` becomes release `v<version>`; other commits become pre-releases `v<version>-build.<n>`. Pull requests are built too (zips attached to the workflow run), but not released.

To build the same zips yourself: `python tools/build.py` (`python3` on macOS/Linux) writes `dist/chromium/`, `dist/firefox/` and both zips. `python tools/build.py chromium` or `firefox` builds one.

## Install (unpacked)

### Chrome / Brave / Edge

1. Download or clone this repository.
2. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Open your Canvas site and click the extension icon to adjust settings.

After editing any file, click the reload icon on the extension and refresh Canvas.

### Firefox (128+)

Firefox needs a slightly different manifest (Chrome rejects Firefox's `background.scripts`), so build the Firefox copy first. It needs Python 3.

1. Download or clone this repository.
2. In this folder, run `python tools/build-firefox.py` (`python3` on macOS/Linux). This creates `dist/firefox/`.
3. Open `about:debugging#/runtime/this-firefox`.
4. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`. Don't pick the `manifest.json` at the top of the folder: that one is for Chrome.
5. Open your Canvas site. If the popup shows **Allow on Canvas**, click it, then reload Canvas.

A temporary add-on is removed when Firefox restarts. To keep it installed, upload `dist/my-canvas-firefox-<version>.zip` (made by the same script) to [addons.mozilla.org](https://addons.mozilla.org/developers/) for signing (as an unlisted add-on if you don't want it in the store), then install the signed `.xpi` file. Run the script again after updating, so `dist/firefox/` has the latest files.

In Firefox, **Import JSON** opens the settings in a tab, because Firefox closes the popup when a file picker opens.

### Using a custom Canvas domain

The extension runs on `*.instructure.com`. If your school uses another domain (e.g. `canvas.school.edu`), add it in `manifest.json` in three places: `host_permissions`, `content_scripts[0].matches`, and `web_accessible_resources[0].matches`, and in `background.js` (the `chrome.tabs.query` URL).

## Project structure

```
manifest.json      Manifest V3 config (Chrome; tools/build.py derives the Firefox one)
shared.js          Settings schema, defaults, sanitizing, schedule helpers (used everywhere)
content.js         Style layer (settings -> <html> attributes) + dashboard widgets
background.js      Service worker (Chrome) / event page (Firefox): wakes only when the dark-mode schedule flips
popup.html/.css/.js  Settings panel
styles/
  dark.css         Dark-mode rules driven by --mc-* CSS variables
  themes/*.css     One file per theme (palette + accent)
  dashboard.css    Card gradients, condensed cards, logo/feedback hiding, grade badge
  widgets.css      To-do panel + popovers (rendered in a Shadow DOM)
  fonts.css        @font-face for the bundled fonts
fonts/             Bundled woff2 fonts (see Licenses)
icons/             Extension icons
tools/build.py     Builds dist/chromium, dist/firefox and their zips (build-firefox.py: Firefox only)
.github/workflows/release.yml  Builds both on every commit and publishes a GitHub Release
```

### Adding a theme

1. Copy `styles/themes/obsidian.css`, rename the `data-mc-theme` value and change the palette variables.
2. Add the file to `content_scripts[0].css` in `manifest.json`.
3. Add an entry (with a preview palette and accent) to `THEMES` in `shared.js`.

## Performance

- Almost all visuals are static CSS toggled by attributes on `<html>`, so enabling a feature costs nothing at runtime.
- Dark mode is cached in `localStorage` for a flash-free first paint.
- The dashboard widgets start when the browser is idle, make two API calls, and cache the result for 60 seconds. There is no polling.
- The only observer watches the dashboard for class cards (debounced to once per frame) and exists only while grade badges are enabled.
- The service worker sleeps except at dark-mode schedule boundaries.

## Privacy

- All data stays in your browser. Settings are stored in `chrome.storage.sync`.
- The extension only talks to your own Canvas site (same-origin API requests using your existing login). It makes no third-party requests and has no analytics.
- Permissions: `storage`, `alarms`, and host access to `*.instructure.com`.

## Known limitations

- Canvas markup differs between schools and versions. Dark-mode, logo-hiding and Recent Feedback rules use best-effort selectors; if something looks off, open an issue with a screenshot and the element's `class` (right-click → Inspect).
- GPA treats every course equally and guesses the 5.0 weighting from course names (AP/IB/dual +1, honors +0.5).
- The "what grade do I need?" estimate is points-based; for courses with weighted categories, edit the remaining-weight field by hand.

## Contributing

Issues and pull requests are welcome. Keep it dependency-free vanilla JS, comment non-obvious code, and avoid anything that adds background work.

## Licenses

- Code: [MIT](LICENSE)
- Fonts in `fonts/` are © their authors and used under the [SIL Open Font License 1.1](https://openfontlicense.org): [Inter](https://rsms.me/inter/), [Poppins](https://github.com/itfoundry/poppins), [JetBrains Mono](https://www.jetbrains.com/lp/mono/).

*Not affiliated with or endorsed by Instructure, Inc. Canvas is a trademark of Instructure, Inc.*
