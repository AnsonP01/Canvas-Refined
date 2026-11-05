"""Build the Firefox version of the extension.

    python tools/build-firefox.py        (python3 on macOS/Linux)

Chrome and Firefox need different manifests. Chrome runs background.js as a service worker
(background.service_worker) and flags background.scripts as an error in Manifest V3.
Firefox has no extension service workers, so it needs background.scripts, plus an add-on
ID so chrome.storage.sync works. manifest.json in the repo is the Chrome one; this writes:

  dist/firefox/                          the extension for Firefox: in about:debugging,
                                         "Load Temporary Add-on..." -> dist/firefox/manifest.json
  dist/my-canvas-firefox-<version>.zip   the same, zipped, to upload to addons.mozilla.org
                                         for signing (needed to install it permanently)

The code itself is shared: shared.js maps chrome.* to Firefox's browser.* at runtime.
"""
import glob
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(DIST, 'firefox')

# Everything the extension uses at runtime (development files like tools/ stay out).
FILES = ['background.js', 'content.js', 'shared.js', 'popup.html', 'popup.css', 'popup.js', 'LICENSE']
DIRS = ['icons', 'styles', 'fonts']
SKIP = {'REPORT.txt', '.gitkeep'}

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
    refs = list(man['background']['scripts'])
    refs.append(man['action']['default_popup'])
    refs += man['action'].get('default_icon', {}).values()
    refs += man.get('icons', {}).values()
    for cs in man.get('content_scripts', []):
        refs += cs.get('js', []) + cs.get('css', [])
    return refs, [r for w in man.get('web_accessible_resources', []) for r in w['resources']]


def main():
    man = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
    fx = firefox_manifest(man)

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    for f in FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(OUT, f))
    for d in DIRS:
        shutil.copytree(os.path.join(ROOT, d), os.path.join(OUT, d), ignore=shutil.ignore_patterns(*SKIP))
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(fx, fh, indent=2, ensure_ascii=False)
        fh.write('\n')

    # Fail loudly if the manifest points at anything that didn't make it into the build.
    files, patterns = referenced_paths(fx)
    missing = [p for p in files if not os.path.isfile(os.path.join(OUT, p))]
    missing += [p for p in patterns if '*' not in p and not os.path.isfile(os.path.join(OUT, p))]
    missing += [p for p in patterns if '*' in p and p != 'fonts/*' and not glob.glob(os.path.join(OUT, p))]
    if missing:
        sys.exit('Build incomplete, missing: ' + ', '.join(missing))

    zip_path = os.path.join(DIST, f"my-canvas-firefox-{fx['version']}.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    count = 0
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, names in os.walk(OUT):
            for n in sorted(names):
                full = os.path.join(dirpath, n)
                z.write(full, os.path.relpath(full, OUT).replace(os.sep, '/'))  # files at the zip root
                count += 1
    print(f"Firefox build {fx['version']}: {count} files")
    print('  load in Firefox:  ' + os.path.join(OUT, 'manifest.json'))
    print('  zip for signing:  ' + zip_path)


if __name__ == '__main__':
    main()
