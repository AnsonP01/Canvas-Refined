"""Build dark-mode overrides for Canvas's own stylesheets.

    python tools/build-canvas-dark.py <dir-with-canvas-css> [--cdn-base URL]

<dir> holds Canvas's CSS bundles exactly as served (e.g. common-0b407277f8.css,
grade_summary-1a2b3c4d5e.css, variables-....css) plus optionally the school's own
custom CSS (any other .css file, treated as part of "common").

For every rule that sets a colour (text, background, border, outline, shadow,
fill/stroke - including :hover/:focus/:active/:checked/... states) this writes the
same rule, scoped to html[data-mc-dark], with light/dark colours swapped for the
theme's --mc-* colours. Rules are copied in Canvas's order with Canvas's selectors
(+ the html[data-mc-dark] prefix, which is more specific), so Canvas's cascade is
reproduced exactly in dark mode; colours that already work are copied unchanged so
the order still holds. Nothing is !important unless Canvas's rule was, so inline
colours (course colours etc.) still win, as they do in Canvas.

Output (in styles/canvas/):
  common.css          common bundle + school CSS + brand variable overrides
                      (loaded on every page via the manifest)
  <bundle>.css        one per page bundle; content.js loads it only when the page
                      itself loads Canvas's <bundle>-<hash>.css
  bundles.js          the list of available page bundles, for content.js
  REPORT.txt          what was found and changed
"""
import collections
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canvas_css import (COLOR_TOKEN, contrast, chroma, hex_of, hls, lum, parse, parse_color,
                        split_top, strip_comments)
import colorsys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'styles', 'canvas')
PREFIX = 'html[data-mc-dark]'

# Contrast is checked against the LIGHTEST dark surface of all themes, so a colour
# that passes here passes on every theme.
def theme_surfaces():
    out = []
    for f in os.listdir(os.path.join(ROOT, 'styles', 'themes')):
        s = open(os.path.join(ROOT, 'styles', 'themes', f), encoding='utf-8').read()
        for k in ('--mc-surface', '--mc-surface-2', '--mc-bg'):
            m = re.search(re.escape(k) + r':\s*(#[0-9a-fA-F]{6})', s)
            if m:
                out.append(parse_color(m.group(1)))
    return out
SURFACES = theme_surfaces()
REF = max(SURFACES, key=lum)

TEXT_PROPS = {'color', 'fill', 'stroke', 'caret-color', '-webkit-text-fill-color'}
BG_PROPS = {'background', 'background-color', 'background-image'}
SHADOW_PROPS = {'box-shadow', '-webkit-box-shadow'}
LINE_RE = re.compile(r'^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|'
                     r'outline(-color)?|column-rule(-color)?|text-decoration(-color)?)$')
SKIP_VALUE = re.compile(r'^(inherit|initial|unset|revert)$', re.I)

stats = collections.Counter()
examples = collections.defaultdict(list)


def note(kind, before, after):
    stats[kind] += 1
    if len(examples[kind]) < 6 and (before, after) not in examples[kind]:
        examples[kind].append((before, after))


def neutral(c):
    """Greys, including Canvas's slightly blue greys (#2D3B45, #394B58, #6B7780, #C7CDD1)."""
    return chroma(c) <= 16 or (hls(c)[2] <= 0.3 and chroma(c) <= 50)


def pct(a):
    return f'{round(a * 100)}%'


def tint(c, sat_cap=0.8, light=0.45):
    h, _l, s = hls(c)
    r, g, b = colorsys.hls_to_rgb(h, light, min(s, sat_cap))
    return hex_of((r * 255, g * 255, b * 255))


def lighten_to(c, target):
    """Same hue, lighter, until contrast with REF >= target. None if already fine."""
    if contrast(c, REF) >= target:
        return None
    h, l, s = hls(c)
    while l < 0.97:
        l = min(0.97, l + 0.02)
        r, g, b = colorsys.hls_to_rgb(h, l, min(s, 0.9))
        cand = (r * 255, g * 255, b * 255, c[3])
        if contrast(cand, REF) >= target:
            break
    out = hex_of(cand)
    return out if c[3] >= 1 else f'color-mix(in srgb, {out} {pct(c[3])}, transparent)'


# --- per-category colour maps: return replacement text, or None to keep ---

def map_bg(c):
    a, L, ch = c[3], lum(c), chroma(c)
    if a < 0.04 or L < 0.5:
        return None                       # dark/mid backgrounds already work (buttons, nav, badges)
    if neutral(c):
        base = ('var(--mc-surface)' if L >= 0.98 else 'var(--mc-surface-2)' if L >= 0.9
                else 'color-mix(in srgb, var(--mc-surface-2) 55%, var(--mc-border))')
    else:
        base = f'color-mix(in srgb, {tint(c)} 24%, var(--mc-surface))'   # keeps the hue (info/warn/success)
    return base if a >= 1 else f'color-mix(in srgb, {base} {pct(a)}, transparent)'


def map_text(c):
    a, L, ch = c[3], lum(c), chroma(c)
    if a < 0.04:
        return None
    if neutral(c) or (L < 0.02 and a < 1):
        if L < 0.08:
            return 'var(--mc-text)' if a >= 0.7 else 'var(--mc-muted)'
        if L < 0.35:
            return 'var(--mc-muted)'
        return None                       # light text (on buttons etc.)
    return lighten_to(c, 4.5)             # links, alerts, status colours


def map_line(c):
    a, L, ch = c[3], lum(c), chroma(c)
    if a < 0.04:
        return None
    if a < 1 and L < 0.05:                # rgba(0,0,0,x) hairlines vanish on dark
        return 'var(--mc-border)' if a >= 0.08 else None
    if neutral(c):
        if L >= 0.3:
            return 'var(--mc-border)' if a >= 1 else f'color-mix(in srgb, var(--mc-border) {pct(a)}, transparent)'
        if L < 0.08:
            return 'var(--mc-muted)'      # dark rules/borders would disappear
        return None
    if L >= 0.5:
        return f'color-mix(in srgb, {tint(c, light=0.5)} 45%, var(--mc-border))'
    return lighten_to(c, 3)               # focus rings, active tabs, error borders


def map_shadow(c):
    a, L, ch = c[3], lum(c), chroma(c)
    if a < 0.04:
        return None
    if L >= 0.5 and neutral(c):
        return 'transparent' if a < 1 else 'var(--mc-border)'   # white bevels / light rings
    if L >= 0.5:
        return f'color-mix(in srgb, {tint(c, light=0.5)} 45%, var(--mc-border))'
    if L < 0.05:
        return None                       # real drop shadows
    return lighten_to(c, 3)               # focus glows


def map_text_shadow(c):
    return 'transparent' if lum(c) >= 0.5 and c[3] >= 0.04 else None


# --- brand variables (from Canvas's variables-*.css) ---

def load_vars(path):
    v = {}
    if path:
        for m in re.finditer(r'(--[\w-]+)\s*:\s*([^;}]+)', strip_comments(open(path, encoding='utf-8').read())):
            v[m.group(1)] = m.group(2).strip()
    return v


BRAND_OVERRIDES = {
    # links and the brand colour: PSU's navy is unreadable on dark, so use the theme accent
    '--ic-link-color': 'var(--mc-accent)',
    '--ic-link-color-darkened-10': 'color-mix(in srgb, var(--mc-accent) 82%, white)',
    '--ic-link-color-lightened-10': 'color-mix(in srgb, var(--mc-accent) 82%, white)',
    '--ic-brand-primary': 'var(--mc-accent)',
    '--ic-brand-primary-darkened-5': 'color-mix(in srgb, var(--mc-accent) 92%, black)',
    '--ic-brand-primary-darkened-10': 'color-mix(in srgb, var(--mc-accent) 86%, black)',
    '--ic-brand-primary-darkened-15': 'color-mix(in srgb, var(--mc-accent) 80%, black)',
    '--ic-brand-primary-lightened-5': 'color-mix(in srgb, var(--mc-accent) 92%, white)',
    '--ic-brand-primary-lightened-10': 'color-mix(in srgb, var(--mc-accent) 86%, white)',
    '--ic-brand-primary-lightened-15': 'color-mix(in srgb, var(--mc-accent) 80%, white)',
    '--ic-brand-button--primary-bgd': 'var(--mc-accent)',
    '--ic-brand-button--primary-bgd-darkened-5': 'color-mix(in srgb, var(--mc-accent) 92%, black)',
    '--ic-brand-button--primary-bgd-darkened-15': 'color-mix(in srgb, var(--mc-accent) 80%, black)',
    '--ic-brand-button--primary-text': '#ffffff',
    # body text
    '--ic-brand-font-color-dark': 'var(--mc-text)',
    '--ic-brand-font-color-dark-lightened-15': 'var(--mc-muted)',
    '--ic-brand-font-color-dark-lightened-28': 'var(--mc-muted)',
    '--ic-brand-font-color-dark-lightened-30': 'var(--mc-muted)',
    # secondary buttons are dark grey in Canvas; keep them a raised theme surface
    '--ic-brand-button--secondary-bgd': 'var(--mc-surface-2)',
    '--ic-brand-button--secondary-bgd-darkened-5': 'color-mix(in srgb, var(--mc-surface-2) 85%, var(--mc-border))',
    '--ic-brand-button--secondary-bgd-darkened-15': 'var(--mc-border)',
    '--ic-brand-button--secondary-text': 'var(--mc-text)',
}

# --- rewriting ---

URL_RE = re.compile(r'url\(\s*(["\']?)(.*?)\1\s*\)', re.I)


def absolutize(val, base):
    def fix(m):
        u = m.group(2)
        if re.match(r'^(data:|https?:|//|#)', u, re.I) or not base:
            return m.group(0)
        if u.startswith('/'):
            return f'url("{re.match(r"^https?://[^/]+", base).group(0)}{u}")'
        b = base
        while u.startswith('../'):
            b = b.rsplit('/', 1)[0]; u = u[3:]
        return f'url("{b}/{u}")'
    return URL_RE.sub(fix, val)


def rewrite(prop, val):
    """-> (new_val, changed)"""
    if prop in TEXT_PROPS:
        fn, kind = map_text, 'text'
    elif prop in BG_PROPS:
        fn, kind = map_bg, 'background'
    elif prop in SHADOW_PROPS:
        fn, kind = map_shadow, 'shadow'
    elif prop == 'text-shadow':
        fn, kind = map_text_shadow, 'text-shadow'
    else:
        fn, kind = map_line, 'border/outline'
    # Don't touch colours inside url(...) or var(...) (vars are handled by BRAND_OVERRIDES).
    spans = [(m.start(), m.end()) for m in re.finditer(r'url\([^)]*\)|var\((?:[^()]|\([^()]*\))*\)', val, re.I)]
    out, last, changed = [], 0, False
    for m in COLOR_TOKEN.finditer(val):
        if any(a <= m.start() < b for a, b in spans):
            continue
        c = parse_color(m.group(0))
        if c is None:
            continue
        rep = fn(c)
        if rep is None:
            continue
        note(kind, m.group(0), rep)
        out.append(val[last:m.start()]); out.append(rep); last = m.end(); changed = True
    out.append(val[last:])
    return ''.join(out), changed


def is_color_prop(p):
    return p in TEXT_PROPS or p in BG_PROPS or p in SHADOW_PROPS or p == 'text-shadow' or bool(LINE_RE.match(p))


def prefix_selector(sel):
    out = []
    for s in split_top(sel):
        s = s.strip()
        if not s:
            continue
        if s.startswith(':root'):
            out.append(PREFIX + s[5:])
        elif re.match(r'^html(?![-\w])', s, re.I):
            out.append(PREFIX + s[4:])
        elif s.startswith('[dir'):
            out.append(PREFIX + s)                    # [dir=rtl] is on <html>
        else:
            out.append(PREFIX + ' ' + s)
    return ', '.join(out)


def convert(items, base, depth=0):
    lines = []
    for it in items:
        if it[0] == 'at':
            name, prelude, kids = it[1], it[2], it[3]
            if name == 'media' and re.search(r'\bprint\b', prelude) and not re.search(r'\bscreen\b|\ball\b', prelude):
                continue
            inner = convert(kids, base, depth + 1)
            if inner:
                lines.append(f'@{name} {prelude}{{')
                lines.extend(inner)
                lines.append('}')
            continue
        _, sel, decls = it
        if not sel or '@' in sel:
            continue
        normal, important, any_changed = [], [], False
        for p, v, imp in decls:
            if not is_color_prop(p) or SKIP_VALUE.match(v):
                if is_color_prop(p) and SKIP_VALUE.match(v):
                    (important if imp else normal).append(f'{p}:{v}')   # keep resets in the cascade
                continue
            nv, ch = rewrite(p, v)
            any_changed |= ch
            nv = absolutize(nv, base)
            (important if imp else normal).append(f'{p}:{nv}' + (' !important' if imp else ''))
        if not normal and not important:
            continue
        stats['rules copied'] += 1
        if any_changed:
            stats['rules with changed colours'] += 1
        psel = prefix_selector(sel)
        if normal:
            lines.append(f'{psel}{{{";".join(normal)}}}')
        if important:
            # Canvas's own !important rules: one id's worth of extra weight so they still beat
            # the other generated rules, as they beat normal rules in Canvas.
            bsel = ', '.join(s + ':not(#mc-i)' for s in split_top(psel))
            lines.append(f'{bsel}{{{";".join(important)}}}')
    return lines


def main():
    src = sys.argv[1]
    cdn = 'https://du11hjcvx0uqb.cloudfront.net/dist/brandable_css/new_styles_normal_contrast/bundles'
    if '--cdn-base' in sys.argv:
        cdn = sys.argv[sys.argv.index('--cdn-base') + 1]
    files = sorted(f for f in os.listdir(src) if f.endswith('.css'))
    var_file = next((os.path.join(src, f) for f in files if f.startswith('variables-')), None)
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith('.css'):
            os.remove(os.path.join(OUT, f))

    bundles, common_parts, sizes = [], [], {}
    for f in files:
        if f.startswith('variables-'):
            continue
        m = re.match(r'^(.+)-([0-9a-f]{10})\.css$', f)
        name = m.group(1) if m else None
        text = strip_comments(open(os.path.join(src, f), encoding='utf-8', errors='replace').read())
        items, _ = parse(text)
        lines = convert(items, cdn if m else '')
        if not lines:
            continue
        if name is None or name == 'common':
            common_parts.append((f, lines))
        else:
            if name in [b for b, _ in bundles]:
                continue
            bundles.append((name, lines))

    header = '/* GENERATED by tools/build-canvas-dark.py from Canvas\'s CSS - do not edit. */\n'
    vars_block = PREFIX + '{' + ';'.join(f'{k}:{v}' for k, v in BRAND_OVERRIDES.items()) + '}\n'
    # Canvas's common bundle first, then the school's CSS (it loads after Canvas's in the page).
    common_parts.sort(key=lambda x: (not re.match(r'^common-', x[0]), x[0]))
    body = header + vars_block + ''.join('/* from ' + re.sub(r'-[0-9a-f]{10}\.css$', '', f) + ' */\n' + '\n'.join(l) + '\n'
                                         for f, l in common_parts)
    open(os.path.join(OUT, 'common.css'), 'w', encoding='utf-8', newline='\n').write(body)
    sizes['common'] = len(body)
    for name, lines in bundles:
        t = header + '\n'.join(lines) + '\n'
        open(os.path.join(OUT, name + '.css'), 'w', encoding='utf-8', newline='\n').write(t)
        sizes[name] = len(t)
    names = sorted(n for n, _ in bundles)
    open(os.path.join(OUT, 'bundles.js'), 'w', encoding='utf-8', newline='\n').write(
        '// GENERATED by tools/build-canvas-dark.py - Canvas page bundles that have dark overrides.\n'
        'self.MC_CANVAS_BUNDLES = new Set(' + repr(names).replace("'", '"') + ');\n')

    rep = [f'Canvas dark-mode build: {len(files)} source files, {len(names)} page bundles + common',
           f'Contrast reference (lightest theme surface): {hex_of(REF)}', '']
    for k, v in stats.most_common():
        rep.append(f'{v:6d}  {k}')
    rep.append('\nExamples (before -> after):')
    for k, ex in examples.items():
        rep.append(f'  {k}:')
        for b, a in ex:
            rep.append(f'      {b}  ->  {a}')
    rep.append('\nOutput sizes (bytes):')
    for k, v in sorted(sizes.items(), key=lambda x: -x[1]):
        rep.append(f'{v:8d}  {k}.css')
    open(os.path.join(OUT, 'REPORT.txt'), 'w', encoding='utf-8', newline='\n').write('\n'.join(rep) + '\n')
    print('\n'.join(rep[:40]))
    print('total bytes', sum(sizes.values()), 'common', sizes['common'])


if __name__ == '__main__':
    main()
