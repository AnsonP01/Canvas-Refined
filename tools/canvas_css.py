"""Minimal CSS parsing + colour maths shared by the dark-mode build tools (stdlib only)."""
import colorsys
import re

# ---------------------------------------------------------------- parsing

def strip_comments(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c in '"\'':
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == '\\' else 1
            out.append(s[i:j + 1]); i = j + 1
        elif s.startswith('/*', i):
            j = s.find('*/', i + 2)
            i = n if j < 0 else j + 2
            out.append(' ')
        else:
            out.append(c); i += 1
    return ''.join(out)


def _scan_until(s, i, stops):
    """Index of the first char in `stops` at nesting depth 0 (outside strings/()/[])."""
    depth, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in '"\'':
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == '\\' else 1
            i = j + 1
            continue
        if c in '([':
            depth += 1
        elif c in ')]':
            depth = max(0, depth - 1)
        elif depth == 0 and c in stops:
            return i
        i += 1
    return n


def _skip_block(s, i):
    """s[i] == '{' -> index just past its matching '}'."""
    depth, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in '"\'':
            j = i + 1
            while j < n and s[j] != c:
                j += 2 if s[j] == '\\' else 1
            i = j + 1
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


GROUPING = {'media', 'supports', 'document', '-moz-document', 'layer', 'container'}


def parse(s, i=0, top=True):
    """-> (items, end). Items: ('rule', selector, [(prop, value, important)])
    or ('at', name, prelude, items). Non-grouping at-rules are dropped."""
    items, n = [], len(s)
    while i < n:
        while i < n and s[i] in ' \t\r\n;':
            i += 1
        if i >= n:
            break
        if s[i] == '}':
            return items, i + 1
        if s[i] == '@':
            m = re.match(r'@([-\w]+)', s[i:])
            name = m.group(1).lower() if m else ''
            j = _scan_until(s, i, '{;}')
            prelude = s[i + len(name) + 1:j].strip()
            if j >= n or s[j] in ';}':
                i = j + 1 if j < n and s[j] == ';' else j
                continue
            if name in GROUPING:
                kids, i = parse(s, j + 1, False)
                items.append(('at', name, prelude, kids))
            else:
                i = _skip_block(s, j)
            continue
        j = _scan_until(s, i, '{}')
        if j >= n or s[j] == '}':
            i = j + 1
            continue
        sel = s[i:j].strip()
        k = _skip_block(s, j)
        items.append(('rule', sel, parse_decls(s[j + 1:k - 1])))
        i = k
    return items, i


def parse_decls(body):
    out, i, n = [], 0, len(body)
    while i < n:
        j = _scan_until(body, i, ';')
        part = body[i:j].strip()
        i = j + 1
        if ':' not in part:
            continue
        prop, val = part.split(':', 1)
        prop = prop.strip().lower()
        val = val.strip()
        imp = False
        m = re.search(r'!\s*important\s*$', val, re.I)
        if m:
            imp, val = True, val[:m.start()].strip()
        if prop and val:
            out.append((prop, val, imp))
    return out


def split_top(s, sep=','):
    parts, i = [], 0
    while True:
        j = _scan_until(s, i, sep)
        parts.append(s[i:j].strip())
        if j >= len(s):
            return [p for p in parts if p]
        i = j + 1

# ---------------------------------------------------------------- colours

NAMED = {  # CSS named colours (full CSS Color 4 list)
    'aliceblue': 'f0f8ff', 'antiquewhite': 'faebd7', 'aqua': '00ffff', 'aquamarine': '7fffd4', 'azure': 'f0ffff',
    'beige': 'f5f5dc', 'bisque': 'ffe4c4', 'black': '000000', 'blanchedalmond': 'ffebcd', 'blue': '0000ff',
    'blueviolet': '8a2be2', 'brown': 'a52a2a', 'burlywood': 'deb887', 'cadetblue': '5f9ea0', 'chartreuse': '7fff00',
    'chocolate': 'd2691e', 'coral': 'ff7f50', 'cornflowerblue': '6495ed', 'cornsilk': 'fff8dc', 'crimson': 'dc143c',
    'cyan': '00ffff', 'darkblue': '00008b', 'darkcyan': '008b8b', 'darkgoldenrod': 'b8860b', 'darkgray': 'a9a9a9',
    'darkgreen': '006400', 'darkgrey': 'a9a9a9', 'darkkhaki': 'bdb76b', 'darkmagenta': '8b008b', 'darkolivegreen': '556b2f',
    'darkorange': 'ff8c00', 'darkorchid': '9932cc', 'darkred': '8b0000', 'darksalmon': 'e9967a', 'darkseagreen': '8fbc8f',
    'darkslateblue': '483d8b', 'darkslategray': '2f4f4f', 'darkslategrey': '2f4f4f', 'darkturquoise': '00ced1',
    'darkviolet': '9400d3', 'deeppink': 'ff1493', 'deepskyblue': '00bfff', 'dimgray': '696969', 'dimgrey': '696969',
    'dodgerblue': '1e90ff', 'firebrick': 'b22222', 'floralwhite': 'fffaf0', 'forestgreen': '228b22', 'fuchsia': 'ff00ff',
    'gainsboro': 'dcdcdc', 'ghostwhite': 'f8f8ff', 'gold': 'ffd700', 'goldenrod': 'daa520', 'gray': '808080',
    'green': '008000', 'greenyellow': 'adff2f', 'grey': '808080', 'honeydew': 'f0fff0', 'hotpink': 'ff69b4',
    'indianred': 'cd5c5c', 'indigo': '4b0082', 'ivory': 'fffff0', 'khaki': 'f0e68c', 'lavender': 'e6e6fa',
    'lavenderblush': 'fff0f5', 'lawngreen': '7cfc00', 'lemonchiffon': 'fffacd', 'lightblue': 'add8e6', 'lightcoral': 'f08080',
    'lightcyan': 'e0ffff', 'lightgoldenrodyellow': 'fafad2', 'lightgray': 'd3d3d3', 'lightgreen': '90ee90', 'lightgrey': 'd3d3d3',
    'lightpink': 'ffb6c1', 'lightsalmon': 'ffa07a', 'lightseagreen': '20b2aa', 'lightskyblue': '87cefa',
    'lightslategray': '778899', 'lightslategrey': '778899', 'lightsteelblue': 'b0c4de', 'lightyellow': 'ffffe0',
    'lime': '00ff00', 'limegreen': '32cd32', 'linen': 'faf0e6', 'magenta': 'ff00ff', 'maroon': '800000',
    'mediumaquamarine': '66cdaa', 'mediumblue': '0000cd', 'mediumorchid': 'ba55d3', 'mediumpurple': '9370db',
    'mediumseagreen': '3cb371', 'mediumslateblue': '7b68ee', 'mediumspringgreen': '00fa9a', 'mediumturquoise': '48d1cc',
    'mediumvioletred': 'c71585', 'midnightblue': '191970', 'mintcream': 'f5fffa', 'mistyrose': 'ffe4e1', 'moccasin': 'ffe4b5',
    'navajowhite': 'ffdead', 'navy': '000080', 'oldlace': 'fdf5e6', 'olive': '808000', 'olivedrab': '6b8e23',
    'orange': 'ffa500', 'orangered': 'ff4500', 'orchid': 'da70d6', 'palegoldenrod': 'eee8aa', 'palegreen': '98fb98',
    'paleturquoise': 'afeeee', 'palevioletred': 'db7093', 'papayawhip': 'ffefd5', 'peachpuff': 'ffdab9', 'peru': 'cd853f',
    'pink': 'ffc0cb', 'plum': 'dda0dd', 'powderblue': 'b0e0e6', 'purple': '800080', 'rebeccapurple': '663399',
    'red': 'ff0000', 'rosybrown': 'bc8f8f', 'royalblue': '4169e1', 'saddlebrown': '8b4513', 'salmon': 'fa8072',
    'sandybrown': 'f4a460', 'seagreen': '2e8b57', 'seashell': 'fff5ee', 'sienna': 'a0522d', 'silver': 'c0c0c0',
    'skyblue': '87ceeb', 'slateblue': '6a5acd', 'slategray': '708090', 'slategrey': '708090', 'snow': 'fffafa',
    'springgreen': '00ff7f', 'steelblue': '4682b4', 'tan': 'd2b48c', 'teal': '008080', 'thistle': 'd8bfd8',
    'tomato': 'ff6347', 'turquoise': '40e0d0', 'violet': 'ee82ee', 'wheat': 'f5deb3', 'white': 'ffffff',
    'whitesmoke': 'f5f5f5', 'yellow': 'ffff00', 'yellowgreen': '9acd32',
}

COLOR_TOKEN = re.compile(r'#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\([^()]*\)|(?<![-\w#.])[a-zA-Z]+(?![-\w(])')


def _num(x, scale=1.0):
    x = x.strip()
    return float(x[:-1]) / 100 * scale if x.endswith('%') else float(x)


def parse_color(tok):
    """-> (r, g, b, a) with r,g,b in 0..255, or None if tok isn't a concrete colour."""
    t = tok.strip().lower()
    if t.startswith('#'):
        h = t[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        if len(h) not in (6, 8) or not re.fullmatch(r'[0-9a-f]+', h):
            return None
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)
    m = re.fullmatch(r'(rgba?|hsla?)\((.*)\)', t)
    if m:
        args = [p for p in re.split(r'[\s,/]+', m.group(2).strip()) if p]
        try:
            if m.group(1).startswith('rgb'):
                r, g, b = (_num(v, 255) for v in args[:3])
            else:
                hh = float(args[0].replace('deg', ''))
                s, l = _num(args[1], 1), _num(args[2], 1)
                if s > 1: s /= 100
                if l > 1: l /= 100
                r, g, b = (v * 255 for v in colorsys.hls_to_rgb(hh / 360 % 1, l, s))
            a = _num(args[3], 1) if len(args) > 3 else 1.0
        except (ValueError, IndexError):
            return None
        return (r, g, b, max(0.0, min(1.0, a)))
    if t in NAMED:
        h = NAMED[t]
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
    return None


def _lin(v):
    v /= 255
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4


def lum(c):
    return 0.2126 * _lin(c[0]) + 0.7152 * _lin(c[1]) + 0.0722 * _lin(c[2])


def contrast(a, b):
    x, y = lum(a), lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def chroma(c):
    return max(c[:3]) - min(c[:3])


def hex_of(c):
    return '#%02x%02x%02x' % tuple(int(round(max(0, min(255, v)))) for v in c[:3])


def hls(c):
    return colorsys.rgb_to_hls(*(v / 255 for v in c[:3]))
