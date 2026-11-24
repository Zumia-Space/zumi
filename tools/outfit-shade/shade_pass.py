# Outfit shading pass on a finished Zumi VRM (T-31-ROOM round 8, owner 16-11: "OK chốt hướng mới").
#   python shade_pass.py <in.vrm> <out.vrm> [--report out.json] [--no-depth] [--no-material]
# Two levers, on the CLOTHES only (face, skin, hair, eyes, halo, glow, drones and ear fins are never touched):
#   material pass : MToon shade colour cooler and deeper, softer toon edge, a fresnel rim, one shared satin matcap
#   painted depth : ambient occlusion baked at rest (occluded = darker, cooler), multiplied into each garment's own base texture
# Paint and parameters only: every mesh, skin, morph and animation bufferView is copied byte for byte (geometry-same proof:
# check_shade.py). Texels that two unrelated surfaces share (colour-swatch UVs) are left as they were: no smudges.
import io, json, re, struct, sys
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter

KEEP = re.compile(r'SKIN|FACE|EYE|HAIR|Brow|Lash|Mouth|Halo|Glow|Tips|Drone|Fin', re.I)
# material pass. Round 8 used the mock's own values (shade tint (0.76, 0.82, 0.97), toony 0.6, shift -0.12) and, on the light cloth of
# the jacket region in the webcam view, read the same as the approved mock (mean Y 192 / 191, blue minus red 34 / 35); CoS 16-11
# judged that too subtle next to round 7 and asked for more: a stronger shade colour, a softer edge, a lower white tone so the jacket
# keeps its folds by night, and depth that shows at webcam distance. Round 9 values:
SHADE_TINT = (0.72, 0.79, 0.96); TOONY = 0.5; SHIFT = -0.12
BASE_TONE = 0.95   # light cloth only: its lit colour comes down, so by night it no longer sits at the top of the tone curve
RIM = (0.34, 0.42, 0.62); RIM_POW = 3.5; RIM_LIFT = 0.0; RIM_MIX = 0.7; RIM_DARK = 0.45
SHEEN = 0.42; SHEEN_DARK = 0.13; DARK_SHADE_LUM = 0.45   # navy cloth (shade colour darker than this) gets a hint of sheen only
MATCAP_NAME = 'Zumia_SatinMatcap'
# painted depth
LO = 0.55; DEPTH_TINT = (0.80, 0.86, 1.0); BLUR_M = 0.016
# (the mock painted mesh curvature: on the real textures that gave a few dark blobs on the collar and at the sleeve badge and nothing
# on the bodysuit. The real pass bakes ambient occlusion at rest instead: under the bust, the waist, inside the collar, at the cuffs.)
# material pass only: small hard parts, and VRoid's skin-tight pieces (N00_..._CLOTH: bodysuit, pants, boots). Those are layers lying
# on each other; an occlusion bake darkens the under-layer and draws their hidden low-poly seam across her chest (tried four ways,
# the task dossier, round 8, variants v1..v8). The painted depth goes on the outer garments: jacket and shorts.
DEPTH_SKIP = re.compile(r'Headset|Headband|Strap|Belt|Metal|Buckle|Flap|Shoes|SuitWaist|^N00_.*CLOTH', re.I)  # round 9: shoes (went
# near black at the stronger bake) and the suit's waist piece (a seam with the bodysuit) too
MIN_MEAN = 0.0           # (was 0.80: skipping one piece of a garment left a step at its seam; the small hard parts go by name, DEPTH_SKIP)
CONFLICT = 0.06          # two surfaces on one texel whose values differ by more than this: the texel is not painted
MAX_CONFLICT_SHARE = 0.25  # a map with more of its painted texels in conflict than this is a colour-swatch map: left alone

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'glTF', 'not a GLB'
    n = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + n])
    o = 20 + n
    m = struct.unpack('<I', b[o:o + 4])[0]
    assert b[o + 4:o + 8] == b'BIN\x00'
    return j, b[o + 8:o + 8 + m]


def write_glb(path, j, views):
    # views: the bytes of every bufferView, in order. One buffer, each view 4-byte aligned.
    out = bytearray()
    for i, data in enumerate(views):
        while len(out) % 4: out.append(0)
        bv = j['bufferViews'][i]; bv['byteOffset'] = len(out); bv['byteLength'] = len(data); bv['buffer'] = 0
        out += data
    while len(out) % 4: out.append(0)
    j['buffers'] = [{'byteLength': len(out)}]
    js = json.dumps(j, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, 'wb') as f:
        f.write(b'glTF' + struct.pack('<II', 2, total) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(out)) + b'BIN\x00' + bytes(out))
    return total


def accessor(j, bin_, idx):
    a = j['accessors'][idx]; bv = j['bufferViews'][a['bufferView']]
    code, size = CT[a['componentType']]; nc = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride') or size * nc
    if stride == size * nc:
        arr = np.frombuffer(bin_, dtype='<' + code, count=a['count'] * nc, offset=off).reshape(a['count'], nc)
    else:
        arr = np.stack([np.frombuffer(bin_, dtype='<' + code, count=nc, offset=off + i * stride) for i in range(a['count'])])
    arr = arr.astype(np.float64) if code == 'f' or a.get('normalized') else arr.astype(np.int64)
    if a.get('normalized'):
        arr = arr / {'b': 127.0, 'B': 255.0, 'h': 32767.0, 'H': 65535.0}[code]
    return arr


def matcap_png():
    # satin: a broad soft highlight from the upper left, a faint cool kick low right, black elsewhere (matcap is additive in MToon)
    y, x = np.mgrid[0:256, 0:256].astype(np.float64)
    img = np.zeros((256, 256, 3))
    for cx, cy, r, col, a in ((96, 78, 120, (255, 255, 255), 0.55), (88, 66, 46, (255, 255, 255), 0.5), (182, 196, 80, (150, 185, 255), 0.22)):
        t = np.clip(np.hypot(x - cx, y - cy) / r, 0, 1)
        alpha = np.where(t <= 0.45, a + (a * 0.45 - a) * (t / 0.45), a * 0.45 * (1 - (t - 0.45) / 0.55))
        img += alpha[..., None] * np.array(col, dtype=np.float64)
    # glTF samples images top row first (no flip), the matcap lookup has v up: store the picture upside down so the highlight stands
    # upper left on her, as it did in the mock (a canvas texture, which three flips). Round 8 had it lower left.
    buf = io.BytesIO(); Image.fromarray(np.clip(img, 0, 255).round().astype(np.uint8)[::-1], 'RGB').save(buf, 'PNG', optimize=True)
    return buf.getvalue()


OCCLUDER_SKIP = re.compile(r'EYE|HAIR|Brow|Lash|Mouth|Halo|Glow|Tips|Drone|Fin|Headset|Headband', re.I)  # do not cast onto the clothes
AO_CACHE = None; AO_RAW = []   # --ao-cache <dir>: keep the per-vertex bake between runs (tuning only)
AO_NEAR = 0.012   # blockers nearer than this are the garment's own layers lying on each other (the bodysuit's bib under its neckline, a
                  # lining under its shell): they are not folds, and shading them drew the hidden low-poly seam on her chest
SPACE_R = 0.035
AO_DIST = 0.10; AO_RAYS = 32; AO_OFFSET = 0.003; AO_STRENGTH = 0.85; AO_SMOOTH = 6; CELL = 0.05


class Occluders:
    """Every triangle of the body and the clothes at rest, in a uniform grid."""
    def __init__(self, j, bin_, mats, views):
        tri = []
        cache = {}; alpha = {}; self.dropped = 0
        for mesh in j['meshes']:
            for p in mesh['primitives']:
                m = mats[p['material']] if 'material' in p else {}
                if OCCLUDER_SKIP.search(m.get('name', '')) or 'indices' not in p: continue
                k = p['attributes']['POSITION']
                if k not in cache: cache[k] = accessor(j, bin_, k)
                idx = accessor(j, bin_, p['indices']).reshape(-1, 3)
                # a triangle whose texels are cut out (alpha) casts nothing: VRoid garments cover hidden layers with empty texels
                t = m.get('pbrMetallicRoughness', {}).get('baseColorTexture')
                if t and m.get('alphaMode', 'OPAQUE') != 'OPAQUE' and 'TEXCOORD_0' in p['attributes']:
                    img = j['textures'][t['index']]['source']
                    if img not in alpha:
                        im = Image.open(io.BytesIO(views[j['images'][img]['bufferView']]))
                        alpha[img] = np.asarray(im.convert('RGBA'))[..., 3] if im.mode in ('RGBA', 'LA', 'P') else None
                    A = alpha[img]
                    if A is not None:
                        uv = accessor(j, bin_, p['attributes']['TEXCOORD_0']); H, W = A.shape
                        def at(u):
                            x = np.clip((u[:, 0] % 1.0 * W).astype(int), 0, W - 1); y = np.clip((u[:, 1] % 1.0 * H).astype(int), 0, H - 1)
                            return A[y, x]
                        c = uv[idx]                                              # (T, 3, 2)
                        seen = np.maximum.reduce([at(c[:, 0]), at(c[:, 1]), at(c[:, 2]), at(c.mean(axis=1)), at((c[:, 0] + c[:, 1]) / 2), at((c[:, 1] + c[:, 2]) / 2), at((c[:, 0] + c[:, 2]) / 2)])
                        self.dropped += int((seen < 128).sum()); idx = idx[seen >= 128]
                tri.append(cache[k][idx])
        self.tri = np.concatenate(tri)                                  # (T, 3, 3)
        self.v0 = self.tri[:, 0]; self.e1 = self.tri[:, 1] - self.v0; self.e2 = self.tri[:, 2] - self.v0
        lo = np.floor(self.tri.min(axis=1) / CELL).astype(np.int64); hi = np.floor(self.tri.max(axis=1) / CELL).astype(np.int64)
        self.grid = {}
        for t in range(len(self.tri)):
            for x in range(lo[t, 0], hi[t, 0] + 1):
                for y in range(lo[t, 1], hi[t, 1] + 1):
                    for z in range(lo[t, 2], hi[t, 2] + 1):
                        self.grid.setdefault((x, y, z), []).append(t)
        # cosine-weighted hemisphere directions round +z (Fibonacci), fixed
        i = np.arange(AO_RAYS) + 0.5; r = np.sqrt(i / AO_RAYS); phi = i * 2.399963229728653
        self.hemi = np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(1 - r * r)], axis=1)

    def near(self, o):
        lo = np.floor((o - AO_DIST - AO_OFFSET) / CELL).astype(int); hi = np.floor((o + AO_DIST + AO_OFFSET) / CELL).astype(int)
        out = set()
        for x in range(lo[0], hi[0] + 1):
            for y in range(lo[1], hi[1] + 1):
                for z in range(lo[2], hi[2] + 1):
                    c = self.grid.get((x, y, z))
                    if c: out.update(c)
        return np.fromiter(out, dtype=np.int64, count=len(out))

    def occlusion(self, p, n):
        """Share of the hemisphere over point p (normal n) that is blocked within AO_DIST, nearer blockers weighing more."""
        idx = self.near(p)
        if not len(idx): return 0.0
        t1 = np.cross(n, [0.0, 1.0, 0.0] if abs(n[1]) < 0.9 else [1.0, 0.0, 0.0]); t1 /= np.linalg.norm(t1); t2 = np.cross(n, t1)
        d = self.hemi[:, 0:1] * t1 + self.hemi[:, 1:2] * t2 + self.hemi[:, 2:3] * n     # (R, 3)
        o = p + n * AO_OFFSET
        v0, e1, e2 = self.v0[idx], self.e1[idx], self.e2[idx]                         # (T, 3)
        pv = np.cross(d[:, None, :], e2[None, :, :])                                  # (R, T, 3)
        det = np.einsum('tk,rtk->rt', e1, pv)
        ok = np.abs(det) > 1e-12; inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
        tv = o - v0                                                                   # (T, 3)
        u = np.einsum('tk,rtk->rt', tv, pv) * inv
        qv = np.cross(tv, e1)                                                         # (T, 3)
        w = np.einsum('rk,tk->rt', d, qv) * inv
        t = np.einsum('tk,tk->t', e2, qv)[None, :] * inv
        hit = ok & (u >= 0) & (w >= 0) & (u + w <= 1) & (t > AO_NEAR) & (t < AO_DIST)
        tmin = np.where(hit, t, np.inf).min(axis=1)
        return float(np.where(np.isfinite(tmin), 1 - (tmin - AO_NEAR) / (AO_DIST - AO_NEAR), 0.0).mean())


def depth_values(pos, nor, tris, occ, group=None):
    # per-vertex darkening factor from ambient occlusion on the welded surface of one primitive (1 = open, LO = deepest)
    used = np.unique(tris)
    key = np.round(pos[used] * 2e4).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1); k = int(inv.max()) + 1
    wid = np.full(len(pos), -1, dtype=np.int64); wid[used] = inv
    P = np.zeros((k, 3)); N = np.zeros((k, 3))
    P[inv] = pos[used]; np.add.at(N, inv, nor[used])
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    ck = None
    if AO_CACHE:
        import hashlib, os
        ck = os.path.join(AO_CACHE, hashlib.sha1(P.tobytes() + N.tobytes() + repr((AO_DIST, AO_RAYS, AO_OFFSET, AO_NEAR, 'alpha-aware', len(occ.tri))).encode()).hexdigest() + '.npy')
    if ck and os.path.exists(ck): ao = np.load(ck)
    else:
        ao = np.array([occ.occlusion(P[i], N[i]) for i in range(k)])
        if ck: np.save(ck, ao)
    AO_RAW.append((P, N, ao.copy()))
    if group is not None:
        # the layers of one garment lie on each other (a VRoid one-piece: the bib under the neckline): give points that are close in
        # space, within one garment, the same shading, or the under-layer comes out darker and the hidden low-poly seam shows
        from scipy.spatial import cKDTree
        g = np.zeros(k, dtype=np.int64); g[inv] = group[used]
        out = ao.copy()
        for gid in np.unique(g):
            sel = np.where(g == gid)[0]
            if len(sel) < 2: continue
            tree = cKDTree(P[sel]); pairs = tree.query_pairs(SPACE_R, output_type='ndarray')
            w = np.exp(-(np.linalg.norm(P[sel][pairs[:, 0]] - P[sel][pairs[:, 1]], axis=1) / (SPACE_R / 2)) ** 2)
            num = ao[sel].copy(); den = np.ones(len(sel))
            np.add.at(num, pairs[:, 0], w * ao[sel][pairs[:, 1]]); np.add.at(num, pairs[:, 1], w * ao[sel][pairs[:, 0]])
            np.add.at(den, pairs[:, 0], w); np.add.at(den, pairs[:, 1], w)
            out[sel] = num / den
        ao = out
    t = wid[tris]
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [0, 2]]]); e = e[e[:, 0] != e[:, 1]]
    e = np.unique(np.concatenate([e, e[:, ::-1]]), axis=0)
    a, b = e[:, 0], e[:, 1]; deg = np.bincount(a, minlength=k).astype(np.float64)
    for _ in range(AO_SMOOTH): ao = (ao + np.bincount(a, weights=ao[b], minlength=k)) / (deg + 1)
    val = np.clip(1 - AO_STRENGTH * ao, LO, 1.0)
    return val[np.maximum(wid, 0)]


def main():
    args = sys.argv[1:]
    src, dst = args[0], args[1]
    report_path = args[args.index('--report') + 1] if '--report' in args else None
    do_depth, do_mat = '--no-depth' not in args, '--no-material' not in args
    debug_dir = args[args.index('--debug-dir') + 1] if '--debug-dir' in args else None
    global AO_CACHE
    if '--ao-cache' in args: AO_CACHE = args[args.index('--ao-cache') + 1]
    j, bin_ = read_glb(src)
    views = [bytes(bin_[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]) for bv in j['bufferViews']]
    mats = j['materials']
    cloth = [i for i, m in enumerate(mats) if 'VRMC_materials_mtoon' in m.get('extensions', {}) and not KEEP.search(m.get('name', ''))]
    rep = {'in': src, 'in_bytes': len(open(src, 'rb').read()), 'cloth_materials': [mats[i].get('name') for i in cloth], 'material_pass': [], 'maps': []}

    if do_mat:
        j['images'].append({'name': MATCAP_NAME, 'mimeType': 'image/png', 'bufferView': len(j['bufferViews'])})
        j['bufferViews'].append({'buffer': 0, 'byteOffset': 0, 'byteLength': 0}); views.append(matcap_png())
        tex = {'source': len(j['images']) - 1}
        if j.get('samplers'): tex['sampler'] = j['textures'][0].get('sampler', 0)
        j['textures'].append(tex); mc_tex = len(j['textures']) - 1
        for i in cloth:
            e = mats[i]['extensions']['VRMC_materials_mtoon']
            sh = e.get('shadeColorFactor', [1, 1, 1])
            dark = 0.2126 * sh[0] + 0.7152 * sh[1] + 0.0722 * sh[2] < DARK_SHADE_LUM
            if not dark:
                pb = mats[i].setdefault('pbrMetallicRoughness', {}); bc = pb.get('baseColorFactor', [1, 1, 1, 1])
                pb['baseColorFactor'] = [bc[0] * BASE_TONE, bc[1] * BASE_TONE, bc[2] * BASE_TONE, bc[3]]
                sh = [v * BASE_TONE for v in sh]
            e['shadeColorFactor'] = [sh[k] * SHADE_TINT[k] for k in range(3)]
            e['shadingToonyFactor'] = TOONY; e['shadingShiftFactor'] = SHIFT
            rk = RIM_DARK if dark else 1.0
            e['parametricRimColorFactor'] = [RIM[k] * rk for k in range(3)]
            e['parametricRimFresnelPowerFactor'] = RIM_POW; e['parametricRimLiftFactor'] = RIM_LIFT; e['rimLightingMixFactor'] = RIM_MIX
            s = SHEEN_DARK if dark else SHEEN
            e['matcapFactor'] = [s, s, s]; e['matcapTexture'] = {'index': mc_tex}
            rep['material_pass'].append({'name': mats[i].get('name'), 'dark': bool(dark), 'shade': [round(v, 4) for v in e['shadeColorFactor']], 'sheen': s})

    if do_depth:
        # garments by base image: every primitive whose (cloth) material uses that image
        by_img = {}
        for mesh in j['meshes']:
            for p in mesh['primitives']:
                mi = p.get('material')
                if mi not in cloth or DEPTH_SKIP.search(mats[mi].get('name', '')) or 'TEXCOORD_0' not in p['attributes'] or 'NORMAL' not in p['attributes'] or 'indices' not in p: continue
                t = mats[mi].get('pbrMetallicRoughness', {}).get('baseColorTexture')
                if not t or t.get('texCoord', 0) != 0: continue
                by_img.setdefault(j['textures'][t['index']]['source'], []).append(p)
        cache = {}; occ = Occluders(j, bin_, mats, views); rep['occluder_triangles'] = int(len(occ.tri)); rep['occluder_triangles_cut_out'] = occ.dropped
        # ONE bake over every painted primitive, welded by position: the pieces of a garment (a VRoid one-piece is three primitives, each
        # with its own vertex buffer) meet at seams, and the shading and its smoothing must run through them or the seam shows as a step
        keys = []
        for prims in by_img.values():
            for p in prims:
                ka = (p['attributes']['POSITION'], p['attributes']['NORMAL'])
                if ka not in cache: cache[ka] = (accessor(j, bin_, ka[0]), accessor(j, bin_, ka[1])); keys.append(ka)
        off = {}; n = 0
        for ka in keys: off[ka] = n; n += len(cache[ka][0])
        # garment = the VRoid garment name in the material ("Onepiece", "Shoes": its pieces can sit in separate meshes), else the glTF mesh
        grp = np.zeros(n, dtype=np.int64); names = {}
        for gi, mesh in enumerate(j['meshes']):
            for p in mesh['primitives']:
                ka = (p['attributes'].get('POSITION'), p['attributes'].get('NORMAL'))
                if ka not in off: continue
                m = re.match(r'N00_\d+_\d+_([A-Za-z]+)_\d+_CLOTH', mats[p.get('material', 0)].get('name', ''))
                key = m.group(1) if m else ('mesh', gi)
                grp[off[ka]:off[ka] + len(cache[ka][0])] = names.setdefault(key, len(names))
        rep['garments'] = [str(k) for k in names]
        all_tris = np.concatenate([accessor(j, bin_, p['indices']).reshape(-1, 3) + off[(p['attributes']['POSITION'], p['attributes']['NORMAL'])] for prims in by_img.values() for p in prims])
        all_val = depth_values(np.concatenate([cache[ka][0] for ka in keys]), np.concatenate([cache[ka][1] for ka in keys]), all_tris, occ, grp)
        vals = {ka: all_val[off[ka]:off[ka] + len(cache[ka][0])] for ka in keys}
        for img_i, prims in sorted(by_img.items()):
            im = j['images'][img_i]; base = Image.open(io.BytesIO(views[im['bufferView']])); base.load()
            mode = base.mode; rgba = np.asarray(base.convert('RGBA')).astype(np.float64)
            H, W = rgba.shape[:2]
            hi = np.full((H, W), -1.0); lo = np.full((H, W), 9.0); ntri = 0; uv_area = 0.0; m_area = 0.0
            for p in prims:
                ka = (p['attributes']['POSITION'], p['attributes']['NORMAL'])
                if ka not in cache: cache[ka] = (accessor(j, bin_, ka[0]), accessor(j, bin_, ka[1]))
                pos, nor = cache[ka]; uv = accessor(j, bin_, p['attributes']['TEXCOORD_0'])
                tris = accessor(j, bin_, p['indices']).reshape(-1, 3)
                val = vals[ka]
                px = uv[:, 0] * W; py = uv[:, 1] * H
                for t in tris:                                              # smooth (per-vertex) fill, one triangle at a time
                    x, y, v = px[t], py[t], val[t]
                    den = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
                    if abs(den) < 1e-9: continue
                    ntri += 1; uv_area += abs(den) / 2
                    m_area += np.linalg.norm(np.cross(pos[t[1]] - pos[t[0]], pos[t[2]] - pos[t[0]])) / 2
                    x0 = max(0, int(np.floor(x.min() - 1))); x1 = min(W, int(np.ceil(x.max() + 1)) + 1); y0 = max(0, int(np.floor(y.min() - 1))); y1 = min(H, int(np.ceil(y.max() + 1)) + 1)
                    if x1 <= x0 or y1 <= y0: continue
                    gy, gx = np.mgrid[y0:y1, x0:x1]; gx = gx + 0.5; gy = gy + 0.5
                    w0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / den
                    w1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / den
                    w2 = 1 - w0 - w1
                    e = 0.75 / max(1.0, np.sqrt(abs(den)))                   # about three quarters of a texel past each edge: no seams
                    inside = (w0 >= -e) & (w1 >= -e) & (w2 >= -e)
                    if not inside.any(): continue
                    f = np.clip(w0, 0, 1) * v[0] + np.clip(w1, 0, 1) * v[1] + np.clip(w2, 0, 1) * v[2]
                    f = f / np.maximum(np.clip(w0, 0, 1) + np.clip(w1, 0, 1) + np.clip(w2, 0, 1), 1e-9)
                    hs = hi[y0:y1, x0:x1]; ls = lo[y0:y1, x0:x1]
                    hs[inside] = np.maximum(hs[inside], f[inside]); ls[inside] = np.minimum(ls[inside], f[inside])
            polys = range(ntri)
            lo = np.where(hi >= 0, lo, -1.0)
            cover = hi >= 0
            conflict = cover & ((hi - lo) > CONFLICT)
            share = float(conflict.sum()) / max(1, int(cover.sum()))
            entry = {'image': im.get('name'), 'size': [W, H], 'triangles': len(polys), 'covered': round(float(cover.mean()), 4), 'conflict_share': round(share, 4), 'bytes_before': len(views[im['bufferView']])}
            if share > MAX_CONFLICT_SHARE or not cover.any():
                entry['painted'] = False; rep['maps'].append(entry); continue
            ok = cover & ~conflict
            v = np.where(ok, (hi + lo) / 2, 1.0)
            # soften by about BLUR_M on the garment itself, whatever its share of the map (texels per metre from the triangles)
            sig = float(np.clip(BLUR_M * np.sqrt(uv_area / max(m_area, 1e-9)), 2.0, 24.0)); entry['blur_sigma_px'] = round(sig, 1)
            wgt = gaussian_filter(ok.astype(np.float64), sig)
            v = np.where(wgt > 0.05, gaussian_filter(np.where(ok, v, 0.0), sig) / np.maximum(wgt, 1e-6), 1.0)
            v = np.where(gaussian_filter(conflict.astype(np.float64), sig) > 0.02, 1.0 - (1.0 - v) * np.clip(1 - gaussian_filter(conflict.astype(np.float64), sig * 2) * 4, 0, 1), v)  # fade to nothing near shared texels
            v = np.clip(v, LO, 1.0); dd = (1 - v) / (1 - LO)
            entry.update({'darkest': round(float(v.min()), 3), 'mean': round(float(v[cover].mean()), 4)})
            if v.min() > 0.995 or v[cover].mean() < MIN_MEAN:
                entry['painted'] = False; rep['maps'].append(entry); continue
            if debug_dir: Image.fromarray((np.clip((v - LO) / (1 - LO), 0, 1) * 255).astype(np.uint8), 'L').save(f"{debug_dir}/{im.get('name')}-depth.png")
            for c in range(3): rgba[..., c] *= v * (1 + (DEPTH_TINT[c] - 1) * dd)
            out = Image.fromarray(np.clip(rgba, 0, 255).round().astype(np.uint8), 'RGBA')
            if mode in ('RGB', 'P', 'L') and 'transparency' not in base.info: out = out.convert('RGB')
            buf = io.BytesIO(); out.save(buf, 'PNG', optimize=True)
            views[im['bufferView']] = buf.getvalue(); im['mimeType'] = 'image/png'
            entry.update({'painted': True, 'bytes_after': len(buf.getvalue())})
            rep['maps'].append(entry)

    rep['out_bytes'] = write_glb(dst, j, views); rep['out'] = dst
    if report_path: json.dump(rep, open(report_path, 'w'), indent=1)
    print(json.dumps({k: rep[k] for k in ('in_bytes', 'out_bytes')}), 'maps painted', sum(1 for m in rep['maps'] if m.get('painted')), 'of', len(rep['maps']))
    for m in rep['maps']: print('  ', m)


if __name__ == '__main__':
    main()
