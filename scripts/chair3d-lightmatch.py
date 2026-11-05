# T-31 chair3d light match: derive each 3D chair's chairs.json look.tint from measured pixels, so the chair reads lit by
# the night-blue plate instead of studio-lit.
#   target    = the painted chair as the plate shows it (assets/rooms-video/chair-talk.png, rows visible in the talk crop)
#   candidate = the 3D chair alone at the talk camera (electron-chair3d.cjs: chair-<id>-only-talk.png, raw WebGL, before the
#               stage's CSS grade), times the talk grade it is shown under (exposure 0.92, tint #6f7fe0 @ 0.15)
# In linear light: tint = luminance ratio ** LUM_K * (per-channel colour ratio / luminance ratio) ** HUE_K, clamped.
# Partial exponents on purpose: the painted chair is a dark navy mesh, and a full match would repaint every chair navy
# (its albedo); the partial match moves the light level and colour cast toward the plate and keeps the material.
#   python scripts/chair3d-lightmatch.py <shots dir> [--write]
import json, sys, os
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
LUM_K, HUE_K = 0.6, 0.7
CLAMP = (0.25, 1.0)
GRADE = {'exposure': 0.92, 'tint': (0x6f, 0x7f, 0xe0), 'strength': 0.15}
TALK_CROP_LAST_ROW = 794  # plate row at the bottom of the chest-up talk crop (ROOM-QC.md: rows 40-794 at 1280x800)

def lin(c): c = c / 255; return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
def srgb(v): v = max(0.0, min(1.0, v)); return round(255 * (12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055))
def mean_lin(img, keep):
    px = [p for i, p in enumerate(img.get_flattened_data() if hasattr(img, 'get_flattened_data') else img.getdata()) if p[3] > 200 and keep(i % img.width, i // img.width)]
    n = len(px)
    return [sum(lin(p[k]) for p in px) / n for k in range(3)], n
def lum(c): return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

shots = sys.argv[1]
rv = json.load(open(os.path.join(ROOT, 'assets', 'rooms-video', 'rooms.json')))
painted = Image.open(os.path.join(ROOT, 'assets', 'rooms-video', rv['chair']['file'])).convert('RGBA')
target, nt = mean_lin(painted, lambda x, y: rv['chair']['y'] + y < TALK_CROP_LAST_ROW)
grade = [GRADE['exposure'] * ((1 - GRADE['strength']) + GRADE['strength'] * lin(c)) for c in GRADE['tint']]
man_path = os.path.join(ROOT, 'assets', 'chair3d', 'chairs.json')
man = json.load(open(man_path))
out = {'target_lin': target, 'target_px': nt}
for ch in man['chairs']:
    f = os.path.join(shots, f"chair-{ch['id']}-only-talk.png")
    if not os.path.exists(f): continue
    raw, n = mean_lin(Image.open(f).convert('RGBA'), lambda x, y: True)
    shown = [raw[k] * grade[k] for k in range(3)]
    L = lum(target) / lum(shown)
    old = ch.get('look', {}).get('tint')  # the render already carries any earlier tint: refine it, never stack it blindly
    old = [lin(int(old[i:i + 2], 16)) for i in (1, 3, 5)] if old else [1, 1, 1]
    # darken/cast only: a chair that already renders darker than the painted one keeps its level (L capped at 1) and
    # only takes the plate's colour cast; the result is normalised so no channel brightens the albedo
    raw_t = [old[k] * min(L, 1.0) ** LUM_K * ((target[k] / shown[k]) / L) ** HUE_K for k in range(3)]
    top = max(raw_t)
    tint = [min(1.0, max(CLAMP[0], t / top if top > 1 else t)) for t in raw_t]
    hexv = '#%02x%02x%02x' % tuple(srgb(t) for t in tint)
    out[ch['id']] = {'shown_lin': shown, 'px': n, 'lumRatio': L, 'tint_lin': tint, 'tint': hexv}
    if '--write' in sys.argv: ch.setdefault('look', {})['tint'] = hexv
    print(ch['id'], 'lum ratio %.2f' % L, 'tint', hexv, [round(t, 3) for t in tint])
if '--write' in sys.argv:
    json.dump(man, open(man_path, 'w'), indent=1)
json.dump(out, open(os.path.join(shots, 'lightmatch.json'), 'w'), indent=1)
