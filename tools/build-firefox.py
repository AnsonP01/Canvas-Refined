"""Build the Firefox version of the extension (same as `python tools/build.py firefox`).

    python tools/build-firefox.py        (python3 on macOS/Linux)

Writes dist/firefox/ (in about:debugging, "Load Temporary Add-on..." -> dist/firefox/manifest.json)
and dist/my-canvas-firefox-<version>.zip (to upload to addons.mozilla.org for signing).
See tools/build.py.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build import main  # noqa: E402

if __name__ == '__main__':
    main(['firefox'])
