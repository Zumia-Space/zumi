# Proof that shade_pass.py changed paint and cloth material values only.
#   python check_shade.py <before.vrm> <after.vrm> [report.json]     exit 0 = every row passes
# Rows: every accessor's bytes (meshes, morph targets, skins, animations) identical; nodes, skins, meshes, accessors, VRM humanoid,
# expressions, spring bones, look-at, first-person and meta identical; every material that is not cloth identical; every image that
# is not a painted cloth map byte-identical (face, eyes, hair, skin among them); cloth materials differ only in the pass's own keys.
import hashlib, json, re, sys
sys.path.insert(0, __file__.replace('\\', '/').rsplit('/', 1)[0])
from shade_pass import read_glb, KEEP, MATCAP_NAME

PASS_KEYS = {'shadeColorFactor', 'shadingToonyFactor', 'shadingShiftFactor', 'parametricRimColorFactor', 'parametricRimFresnelPowerFactor',
             'parametricRimLiftFactor', 'rimLightingMixFactor', 'matcapFactor', 'matcapTexture'}


def view(j, b, i):
    bv = j['bufferViews'][i]; o = bv.get('byteOffset', 0)
    return b[o:o + bv['byteLength']]


def main():
    ja, ba = read_glb(sys.argv[1]); jb, bb = read_glb(sys.argv[2])
    rows = []
    def ok(c, name, detail=None): rows.append((bool(c), name, detail)); print(('PASS ' if c else 'FAIL ') + name + ('' if c or detail is None else '  ' + json.dumps(detail)[:300]))
    # geometry and rig bytes
    same = len(ja['accessors']) == len(jb['accessors'])
    bad = []
    if same:
        for i, (x, y) in enumerate(zip(ja['accessors'], jb['accessors'])):
            kx = {k: v for k, v in x.items() if k != 'bufferView'}; ky = {k: v for k, v in y.items() if k != 'bufferView'}
            if kx != ky or ('bufferView' in x) != ('bufferView' in y) or ('bufferView' in x and view(ja, ba, x['bufferView']) != view(jb, bb, y['bufferView'])): bad.append(i)
    ok(same and not bad, f"geometry and rig bytes: all {len(ja['accessors'])} accessors (meshes, morph targets, skins, animations) identical", bad[:10])
    for key in ('nodes', 'skins', 'meshes', 'scenes', 'animations', 'samplers', 'extensionsUsed'):
        ok(ja.get(key) == jb.get(key), f'glTF {key} identical')
    ea, eb = ja.get('extensions', {}), jb.get('extensions', {})
    ok(ea == eb, 'VRM extensions identical (humanoid, expressions, look-at, first-person, meta, spring bones, node constraints)', sorted(k for k in set(ea) | set(eb) if ea.get(k) != eb.get(k)))
    # materials
    ma, mb = ja['materials'], jb['materials']
    cloth = [i for i, m in enumerate(ma) if 'VRMC_materials_mtoon' in m.get('extensions', {}) and not KEEP.search(m.get('name', ''))]
    ok(len(ma) == len(mb) and all(ma[i] == mb[i] for i in range(len(ma)) if i not in cloth), f'the {len(ma) - len(cloth)} materials that are not cloth (face, skin, hair, eyes, halo, drones, fins) are identical')
    stray = []
    for i in cloth:
        x, y = json.loads(json.dumps(ma[i])), json.loads(json.dumps(mb[i]))
        for k in PASS_KEYS: x['extensions']['VRMC_materials_mtoon'].pop(k, None); y['extensions']['VRMC_materials_mtoon'].pop(k, None)
        x.get('pbrMetallicRoughness', {}).pop('baseColorFactor', None); y.get('pbrMetallicRoughness', {}).pop('baseColorFactor', None)  # the white tone (round 9)
        if x != y: stray.append(ma[i].get('name'))
    ok(not stray, f'the {len(cloth)} cloth materials differ only in the pass\'s own values (shade colour, toon edge, rim, matcap, base tone)', stray)
    # images
    ia, ib = ja['images'], jb['images']
    extra = ib[len(ia):]
    ok(len(extra) <= 1 and all(x.get('name') == MATCAP_NAME for x in extra) and [x.get('name') for x in ia] == [x.get('name') for x in ib[:len(ia)]], 'images: the same list, plus at most the one satin matcap', [x.get('name') for x in extra])
    cloth_imgs = set()
    for i in cloth:
        t = ma[i].get('pbrMetallicRoughness', {}).get('baseColorTexture')
        if t: cloth_imgs.add(ja['textures'][t['index']]['source'])
    changed = [i for i in range(len(ia)) if view(ja, ba, ia[i]['bufferView']) != view(jb, bb, ib[i]['bufferView'])]
    ok(all(i in cloth_imgs for i in changed), f'images changed: {len(changed)}, every one a cloth base map', [ia[i].get('name') for i in changed if i not in cloth_imgs])
    untouched = [ia[i].get('name') for i in range(len(ia)) if i not in changed]
    ok(all(any(re.search(p, n or '') for n in untouched) for p in (r'_04', r'_02', r'_10_vroid_default_body')), 'face, eye and body skin maps are byte-identical')
    fails = [r for r in rows if not r[0]]
    out = {'before': sys.argv[1], 'after': sys.argv[2], 'sha256_after': hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest(), 'bytes_after': len(open(sys.argv[2], 'rb').read()),
           'rows': [{'pass': r[0], 'name': r[1]} for r in rows], 'changed_images': [ia[i].get('name') for i in changed]}
    if len(sys.argv) > 3: json.dump(out, open(sys.argv[3], 'w'), indent=1)
    print(f"check_shade {len(rows) - len(fails)}/{len(rows)} passed; changed images: {out['changed_images']}")
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
