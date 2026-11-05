"""Build the extension for Chromium browsers and Firefox.

    python tools/build.py                 both (python3 on macOS/Linux)
    python tools/build.py chromium        Chrome / Edge / Brave / Vivaldi / Opera only
    python tools/build.py firefox         Firefox only

Writes, for each target:

  dist/<target>/                          the unpacked extension
                                            Chromium: chrome://extensions -> "Load unpacked"
                                            Firefox:  about:debugging -> "Load Temporary Add-on..."
                                                      -> dist/firefox/manifest.json
  dist/my-canvas-<target>-<version>.zip   the same, zipped (files at the zip root): for the
                                          Chrome Web Store / addons.mozilla.org (signing)

Chrome and Firefox need different manifests. Chrome runs background.js as a service worker
(background.service_worker) and flags background.scripts as an error in Manifest V3.
Firefox has no extension service workers, so it needs background.scripts, plus an add-on
ID so chrome.storage.sync works. manifest.json in the repo is the Chrome one; the Firefox
one is derived from it here. The code itself is shared: shared.js maps chrome.* to
Firefox's browser.* at runtime.
"""
import glob
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')

# Everything the extension uses at runtime (development files like tools/ stay out).
FILES = ['background.js', 'content.js', 'shared.js', 'popup.html', 'popup.css', 'popup.js', 'LICENSE']
DIRS = ['icons', 'styles', 'fonts']
SKIP = {'REPORT.txt', '.gitkeep'}
TARGETS = ('chromium', 'firefox')

GECKO = {
    'id': 'my-canvas@ansonp01',
    'strict_min_version': '128.0',             # host permissions granted at install, :has(), color-mix()
    'data_collection_permissions': {'required': ['none']},
}


def firefox_manifest(man):
    man = dict(man)
    man.pop('minimum_chrome_version', None)
    bg = man.get('background') or {}
    if bg.get('service_worker') != 'background.js':
        sys.exit('manifest.json: expected background.service_worker = "background.js"')
    # Chrome's worker loads shared.js with importScripts(); Firefox's event page gets it here.
    man['background'] = {'scripts': ['shared.js', 'background.js']}
    man['browser_specific_settings'] = {'gecko': GECKO}
    return man


def referenced_paths(man):
    """Every file the manifest points at (globs expanded), relative to the extension root."""
    bg = man.get('background') or {}
    refs = list(bg.get('scripts', [])) + ([bg['service_worker']] if 'service_worker' in bg else [])
    refs.append(man['action']['default_popup'])
    refs += man['action'].get('default_icon', {}).values()
    refs += man.get('icons', {}).values()
    for cs in man.get('content_scripts', []):
        refs += cs.get('js', []) + cs.get('css', [])
    return refs, [r for w in man.get('web_accessible_resources', []) for r in w['resources']]


def build(target, man):
    out = os.path.join(DIST, target)
    tm = firefox_manifest(man) if target == 'firefox' else dict(man)

    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for f in FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(out, f))
    for d in DIRS:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(out, d), ignore=shutil.ignore_patterns(*SKIP))
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(tm, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    # Fail loudly if the manifest points at anything that didn't make it into the build.
    files, patterns = referenced_paths(tm)
    missing = [p for p in files if not os.path.isfile(os.path.join(out, p))]
    missing += [p for p in patterns if '*' not in p and not os.path.isfile(os.path.join(out, p))]
    missing += [p for p in patterns if '*' in p and p != 'fonts/*' and not glob.glob(os.path.join(out, p))]
    if missing:
        sys.exit(f'{target} build incomplete, missing: ' + ', '.join(missing))

    zip_path = os.path.join(DIST, f"my-canvas-{target}-{tm['version']}.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    count = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, dirs, names in os.walk(out):
            dirs.sort()
            for n in sorted(names):
                full = os.path.join(dirpath, n)
                z.write(full, os.path.relpath(full, out).replace(os.sep, '/'))  # files at the zip root
                count += 1
    print(f"{target} build {tm['version']}: {count} files")
    print('  unpacked:  ' + (os.path.join(out, 'manifest.json') if target == 'firefox' else out))
    print('  zip:       ' + zip_path)
    return zip_path


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    targets = args or list(TARGETS)
    bad = [t for t in targets if t not in TARGETS]
    if bad:
        sys.exit(f"unknown target {', '.join(bad)} (use: {' / '.join(TARGETS)})")
    man = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
    for t in targets:
        build(t, man)


if __name__ == '__main__':
    main()
