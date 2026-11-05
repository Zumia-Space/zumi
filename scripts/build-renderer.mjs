// Bundles the renderer (three.js + three-vrm, no CDN at runtime) and copies static files + gesture data.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rigSrcHash } from './rig-version.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'renderer');
// ZUMI_RENDERER_OUT: the third-party licence gate (scripts/check-third-party.mjs) builds into a scratch folder to learn what the
// installer would carry (and which npm packages esbuild inlines, via the metafile); a normal build never sets it.
const inspectOut = process.env.ZUMI_RENDERER_OUT ? path.resolve(process.env.ZUMI_RENDERER_OUT) : null;
const out = inspectOut || path.join(root, 'build', 'renderer');
// ZUMI_NEXT_UI (ADR 2026-10-27-next-version-path-flag): the next-version UI (src/renderer/next/**) is built in only when this
// is on. Default ON since the owner sign-off of 28-10 (evt-10115, see the ADR's 28-10 note); ZUMI_NEXT_UI=0 still builds the old
// UI, ZUMI_NEXT_UI=1|0 overrides the default for one build (dev shots, scripts/check-next-ui-boots-without-next.mjs).
const NEXT_UI_DEFAULT = true;
const nextUi = process.env.ZUMI_NEXT_UI ? process.env.ZUMI_NEXT_UI === '1' : NEXT_UI_DEFAULT;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'gestures'), { recursive: true });
fs.mkdirSync(path.join(out, 'speech'), { recursive: true });
// T-31 slice 3a-3 (GATE-SEC C4): the host reads THIS, never the env var, to decide whether Brain's three board calls exist (Electron main,
// and the Tauri sidecar via stage-bundle). Same value as __ZUMI_NEXT_UI__ below; it sits in `out`, so ZUMI_RENDERER_OUT builds carry it too.
fs.writeFileSync(path.join(out, 'next-ui.json'), `${JSON.stringify({ nextUi })}\n`);


const bundle = await build({
  entryPoints: [path.join(src, 'app.js')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  minify: process.env.ZUMI_DEBUG_BUILD !== '1', // ZUMI_DEBUG_BUILD=1: readable stack traces for diagnosis
  sourcemap: false,
  legalComments: 'none',
  // The gesture cache key carries a hash of everything that decides how a GestureCommand looks on the model, so a rig
  // or schema change makes every cached gesture stale (the loaded model's own hash is added at runtime).
  define: { __RIG_SRC_HASH__: JSON.stringify(rigSrcHash()), __ZUMI_NEXT_UI__: String(nextUi) },
  logLevel: 'warning',
  metafile: Boolean(inspectOut),
});
if (inspectOut) fs.writeFileSync(`${inspectOut}.metafile.json`, JSON.stringify(bundle.metafile));

fs.copyFileSync(path.join(src, 'styles.css'), path.join(out, 'styles.css'));
// index.html carries one marker comment where the next UI's stylesheets go (no flash of the old look). Off: the marker is removed.
// On: it becomes the two links and <html> gets the zumi-next class that scopes the look A tokens (src/next-tokens/tokens-a.css).
const NEXT_LINKS = '<link rel="stylesheet" href="next/tokens-a.css">\n  <link rel="stylesheet" href="next/theme-a.css">';
let indexHtml = fs.readFileSync(path.join(src, 'index.html'), 'utf8').replace('<!-- next-ui:head -->', nextUi ? NEXT_LINKS : '');
if (nextUi) {
  if (!indexHtml.includes('<html lang="en" class="dark">')) throw new Error('index.html: <html lang="en" class="dark"> not found, cannot add zumi-next');
  // data-theme="blue" = the default theme (look A) from the first paint; src/renderer/theme.js swaps it at boot when the owner picked another.
  indexHtml = indexHtml.replace('<html lang="en" class="dark">', '<html lang="en" class="dark zumi-next" data-theme="blue">');
}
fs.writeFileSync(path.join(out, 'index.html'), indexHtml);
fs.copyFileSync(path.join(src, 'hud', 'hud.css'), path.join(out, 'hud.css')); // talk-camera HUD (T-31 hud-react)
// T-31 slice 1 (look A): the Track-2 theme layer is src/renderer/next/*.css plus src/next-tokens/tokens-a.css (served at app://zumi/next/...); the .js in next/ is bundled into app.js.
if (nextUi) {
  const ndir = path.join(src, 'next');
  fs.mkdirSync(path.join(out, 'next'), { recursive: true });
  for (const f of fs.readdirSync(ndir).filter((x) => x.endsWith('.css'))) fs.copyFileSync(path.join(ndir, f), path.join(out, 'next', f));
  fs.copyFileSync(path.join(root, 'src', 'next-tokens', 'tokens-a.css'), path.join(out, 'next', 'tokens-a.css'));
  // T-31 alpha.12: the Pricing hero image, rendered from the bundled avatar (Zumi-only: prep-ui leaves it out of a public frontendDist).
  const heroImg = path.join(root, 'assets', 'pricing', 'pricing-zumi.webp'); // absent in a public source export (Zumi-only)
  if (fs.existsSync(heroImg)) fs.copyFileSync(heroImg, path.join(out, 'next', 'pricing-zumi.webp'));
  // T-31 slice 3: the Brain stylesheet (next/brain/brain.css) is linked by next/brain/brain.js when the card is built.
  fs.mkdirSync(path.join(out, 'next', 'brain'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ndir, 'brain')).filter((x) => x.endsWith('.css'))) fs.copyFileSync(path.join(ndir, 'brain', f), path.join(out, 'next', 'brain', f));
}
const bdir = path.join(src, 'brand');
fs.mkdirSync(path.join(out, 'brand'), { recursive: true });
for (const f of fs.readdirSync(bdir)) fs.copyFileSync(path.join(bdir, f), path.join(out, 'brand', f));
const gdir = path.join(src, 'reflex', 'gestures');
for (const f of fs.readdirSync(gdir).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(gdir, f), path.join(out, 'gestures', f));
const sdir = path.join(src, 'reflex', 'speech');
for (const f of fs.readdirSync(sdir).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(sdir, f), path.join(out, 'speech', f));

const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0);
console.log(`renderer built -> ${path.relative(root, out)} (app.js ${kb('app.js')} KB, next UI ${nextUi ? 'ON' : 'off'})`);
