#!/usr/bin/env node
// Look A token gate (T-31 slice 1, gate item 1; CoS decision 27-10: the look is scoped, not written into the shared tokens).
// T-31 alpha.3 R1: three whole themes. <html data-theme="blue|black|white"> (set by the next-UI build and by renderer/theme.js) picks one of
// three blocks in src/next-tokens/tokens-a.css: html.zumi-next[data-theme="blue"] = look A (the default, today's look), and
// ...[data-theme="black"] / ...[data-theme="white"] = only the look-A layer names, read from the shared neutral tokens (black = the board's
// .dark palette, white = the board's light palette). There is no html.dark.zumi-next block any more.
// Before R1 the look A values lived in tokens-a.css under `html.dark.zumi-next`, a class only the next-UI build sets. The
// vendored Laneboard tokens.css (shared with the embedded Board) must stay at its 0.2.11 values, so `npm run update:laneboard`
// can no longer revert the look. Expected values: src/next-tokens/theme-a-tokens.json ("off" = 0.2.11, "on" = look A). Asserts:
//   (i)   tokens.css .dark carries the 0.2.11 values and defines no look A colour;
//   (ii)  in Chromium, with tokens.css + styles.css + tokens-a.css + theme-a.css and <html class="dark zumi-next">, the computed
//         tokens equal the look A values (all of them, --primary --background --foreground --muted-foreground included),
//         and a Board-style data-accent on <html> does not replace --primary;
//   (iii) the same sheets WITHOUT the zumi-next class give the 0.2.11 values (the scoping holds), with or without a data-theme;
//   (iv)  tokens-a.css holds exactly the three [data-theme] blocks, equal to the json mirror (blue = "on" + layers.blue, black/white = layers.*);
//   (vi)  the HUD (src/renderer/hud/hud.css) follows --hud-tint: under black and white every --holo* colour is a neutral grey (no blue cast, |b-r| <= 4/255),
//         under blue it is exactly the tint it had before (derived from --focus), and with no theme at all nothing changes.
//   (v)   black computes to the .dark palette ("off") and white to the light palette ("light") plus their layers, with no look A colour left.
//   node scripts/check-theme-a-tokens.mjs [--tokens <tokens.css>] [--tokens-a <tokens-a.css>] [--no-browser]
// Playwright: $ZUMI_PLAYWRIGHT_DIR (default: the owner values' playwrightDir); Chromium: $ZUMI_CHROMIUM (default: the owner values' chromiumExe).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownerPath } from './lib/owner-paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? path.resolve(process.argv[i + 1]) : d; };
const TOKENS = arg('--tokens', path.join(ROOT, 'vendor', 'laneboard', 'public', 'tokens.css'));
const TOKENS_A = arg('--tokens-a', path.join(ROOT, 'src', 'next-tokens', 'tokens-a.css'));
const STYLES = path.join(ROOT, 'src', 'renderer', 'styles.css');
const THEME = path.join(ROOT, 'src', 'renderer', 'next', 'theme-a.css');
const HUD = path.join(ROOT, 'src', 'renderer', 'hud', 'hud.css');
const { on: LOOK_A, off: V0211, light: LIGHT, layers: LAYERS } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'next-tokens', 'theme-a-tokens.json'), 'utf8'));
const PW = process.env.ZUMI_PLAYWRIGHT_DIR || ownerPath('playwrightDir', 'node_modules/playwright');
const EXE = process.env.ZUMI_CHROMIUM || ownerPath('chromiumExe', 'local/chrome.exe');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

/** Declarations of the plain `.dark { ... }` rule -> { '--name': 'value' } (comments stripped, lower case). */
function darkBlock(css) {
  const m = /(?:^|\})\s*\.dark\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const out = {};
  if (m) for (const d of m[1].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().toLowerCase(); }
  return out;
}

// ---------- (i) the shared tokens.css still has the 0.2.11 dark values ----------
const dark = darkBlock(fs.readFileSync(TOKENS, 'utf8'));
const drift = Object.entries(V0211).filter(([n, v]) => dark[n] !== v).map(([n, v]) => `${n}: want ${v}, have ${dark[n] ?? '(missing)'}`);
ok(Object.keys(dark).length > 0 && drift.length === 0, `(i) tokens.css .dark carries the 0.2.11 values (${Object.keys(V0211).length})`, drift.slice(0, 4).join(' | '));
const lookALeak = Object.entries(dark).filter(([, v]) => /#5ff2e1|#050b14|#d9fbf6/.test(v)).map(([n]) => n);
ok(!('--primary' in dark) && lookALeak.length === 0, '(i) tokens.css .dark defines no --primary and no look A colour', `--primary=${dark['--primary']} leak=${lookALeak.join(',')}`);

// ---------- (iv) the three [data-theme] blocks in tokens-a.css = the json mirror ----------
/** Every top-level rule of a stylesheet -> { selector: { name: value } } (comments stripped, values as written, lower case). */
function rules(css) {
  const out = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const d of m[2].split(/;(?![^(]*\))/)) { const i = d.indexOf(':'); if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim().toLowerCase(); }
    out[m[1].trim().replace(/\s+/g, ' ')] = decls;
  }
  return out;
}
const tokensARules = rules(fs.readFileSync(TOKENS_A, 'utf8'));
const THEMES = ['blue', 'black', 'white'];
const selectorOf = (theme) => `html.zumi-next[data-theme="${theme}"]`;
ok(THEMES.every((t) => selectorOf(t) in tokensARules) && Object.keys(tokensARules).length === 3, '(iv) tokens-a.css has exactly the three html.zumi-next[data-theme="blue|black|white"] blocks', Object.keys(tokensARules).join(' | '));
ok(!('html.dark.zumi-next' in tokensARules), '(iv) the old html.dark.zumi-next block is gone (the theme is the data-theme attribute, not the dark class)');
const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v).toLowerCase()]));
const sameDecls = (got, want) => Object.entries(want).filter(([n, v]) => got[n] !== v).map(([n, v]) => `${n}: want ${v}, have ${got[n] ?? '(missing)'}`)
  .concat(Object.keys(got).filter((n) => !(n in want)).map((n) => `${n}: not in the json mirror`));
{
  const d = sameDecls(tokensARules[selectorOf('blue')] || {}, lower({ ...LOOK_A, ...LAYERS.blue }));
  ok(d.length === 0, '(iv) the blue block equals the json mirror (look A "on" + layers.blue)', d.slice(0, 4).join(' | '));
  for (const t of ['black', 'white']) {
    const d2 = sameDecls(tokensARules[selectorOf(t)] || {}, lower(LAYERS[t]));
    ok(d2.length === 0, `(iv) the ${t} block equals the json mirror (layers.${t} only: no base token is redefined)`, d2.slice(0, 4).join(' | '));
  }
}

// ---------- (ii) + (iii) + (v) + (vi) computed values in Chromium ----------
if (process.argv.includes('--no-browser')) console.log('(browser part skipped: --no-browser)');
else {
  if (!fs.existsSync(path.join(PW, 'package.json')) || !fs.existsSync(EXE)) { console.error(`ENV: need playwright at ${PW} and Chromium at ${EXE} (set ZUMI_PLAYWRIGHT_DIR / ZUMI_CHROMIUM)`); process.exit(2); }
  const { chromium } = createRequire(import.meta.url)(PW);
  const sheets = [TOKENS, STYLES, TOKENS_A, THEME, HUD].map((f) => `<style>${fs.readFileSync(f, 'utf8')}</style>`).join('\n');
  const browser = await chromium.launch({ executablePath: EXE, headless: true, timeout: 60000 });
  try {
    const page = await browser.newPage();
    const computed = async (htmlAttrs) => {
      await page.setContent(`<!doctype html><html ${htmlAttrs}><head>${sheets}</head><body></body></html>`);
      return page.evaluate((names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase()])), [...new Set([...Object.keys(LOOK_A), '--radius', ...Object.keys(V0211), ...Object.keys(LIGHT), ...Object.keys(LAYERS.blue), ...Object.keys(LAYERS.black).filter((n) => n.startsWith('--')), '--line'])]);
    };
    const diff = (got, want) => Object.entries(want).filter(([n, v]) => got[n] !== v.toLowerCase()).map(([n, v]) => `${n}: want ${v}, got ${got[n]}`);
    const BLUE = 'class="dark zumi-next" data-theme="blue"';
    const withClass = await computed(BLUE);
    const dOn = diff(withClass, { ...LOOK_A, ...LAYERS.blue });
    ok(dOn.length === 0, `(ii) with html.zumi-next[data-theme=blue] the computed tokens are the look A values (${Object.keys(LOOK_A).length}: --primary --background --foreground --muted-foreground ... + the layer names)`, dOn.slice(0, 4).join(' | '));
    ok(withClass['--radius'] === '2px', '(ii) with the class --radius is 2px (beats styles.css 10px)', withClass['--radius']);
    const accent = await computed(`${BLUE} data-accent="rose"`);
    ok(accent['--primary'] === LOOK_A['--primary'].toLowerCase() && accent['--primary-foreground'] === LOOK_A['--primary-foreground'].toLowerCase(), '(ii) a data-accent on <html> does not replace the look A --primary', `--primary=${accent['--primary']}`);
    const without = await computed('class="dark"');
    const dOff = diff(without, V0211);
    ok(dOff.length === 0 && without['--primary'] === V0211['--foreground'] && without['--radius'] === '10px', '(iii) without the zumi-next class every token is the 0.2.11 value (theme sheets loaded, scoping holds)', dOff.slice(0, 4).join(' | ') || `--primary=${without['--primary']} --radius=${without['--radius']}`);
    for (const t of THEMES) {
      const bare = await computed(`class="dark" data-theme="${t}"`);
      ok(diff(bare, V0211).length === 0 && bare['--radius'] === '10px' && bare['--line'] === '', `(iii) data-theme="${t}" without the zumi-next class changes nothing (next-UI off = 0.2.11)`, `--radius=${bare['--radius']} --line=${bare['--line']}`);
    }
    // (v) black = the board's .dark palette, white = the board's light palette; only the layer names differ; no look A colour survives.
    const resolve = (v, palette) => String(v).replace(/var\((--[a-z-]+)\)/g, (_, n) => palette[n] ?? `?${n}`).toLowerCase();
    for (const [t, html, palette] of [['black', 'class="dark zumi-next" data-theme="black"', V0211], ['white', 'class="zumi-next" data-theme="white"', LIGHT]]) {
      const got = await computed(html);
      const want = { ...palette, ...Object.fromEntries(Object.entries(LAYERS[t]).filter(([n]) => n !== 'color-scheme').map(([n, v]) => [n, resolve(v, palette)])) };
      const d = diff(got, want);
      ok(d.length === 0, `(v) ${t}: base palette + layer names compute to the ${t === 'black' ? '.dark ("off")' : 'light'} values (${Object.keys(want).length})`, d.slice(0, 4).join(' | '));
      ok(got['--primary'] === palette['--foreground'].toLowerCase(), `(v) ${t}: --primary is the neutral foreground, not the look A cyan`, got['--primary']);
      const leak = Object.entries(got).filter(([, v]) => /5ff2e1|050b14|d9fbf6|071628|040c16/.test(v)).map(([n]) => n);
      ok(leak.length === 0, `(v) ${t}: no look A colour in any computed token`, leak.join(','));
      const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      ok(scheme === LAYERS[t]['color-scheme'], `(v) ${t}: color-scheme is ${LAYERS[t]['color-scheme']} (form controls and scrollbars follow the theme)`, scheme);
    }
    // (vi) the HUD tint. Probe elements inside .hud read each --holo* name as a colour; 'chroma' = max(r,g,b) - min(r,g,b) on 0..255.
    const HOLO = ['--holo', '--holo-dim', '--holo-line', '--holo-glow', '--holo-bg', '--holo-scan'];
    const hudColours = async (htmlAttrs) => {
      await page.setContent(`<!doctype html><html ${htmlAttrs}><head>${sheets}</head><body><div class="hud"><div class="hud-panel"></div>${HOLO.map((n) => `<i data-n="${n}" style="color:var(${n})"></i>`).join('')}<b data-n="focus-ref" style="color:color-mix(in srgb, var(--focus) 72%, var(--foreground))"></b></div></body></html>`);
      return page.evaluate(() => {
        const rgb = (str) => { const m = /(?:rgba?|color)\(\s*(?:srgb\s+)?([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(str); if (!m) return null; const k = str.startsWith('color(') ? 255 : 1; return [m[1], m[2], m[3]].map((x) => Number(x) * k); };
        const out = Object.fromEntries([...document.querySelectorAll('.hud [data-n]')].map((e) => [e.dataset.n, rgb(getComputedStyle(e).color)]));
        out.panelBorder = rgb(getComputedStyle(document.querySelector('.hud-panel')).borderTopColor);
        out.tint = getComputedStyle(document.documentElement).getPropertyValue('--hud-tint').trim();
        return out;
      });
    };
    const chroma = (c) => (c ? Math.max(...c) - Math.min(...c) : NaN);
    for (const [t, attrs] of [['black', 'class="dark zumi-next" data-theme="black"'], ['white', 'class="zumi-next" data-theme="white"']]) {
      const h = await hudColours(attrs);
      const names = [...HOLO, 'panelBorder'];
      const tinted = names.filter((n) => !(chroma(h[n]) <= 4)).map((n) => `${n} rgb(${(h[n] || []).map(Math.round)})`);
      ok(tinted.length === 0, `(vi) ${t}: every HUD --holo* colour and the panel border are neutral grey (no blue cast, |b-r| <= 4)`, tinted.slice(0, 3).join(' | '));
      ok(h.tint !== '', `(vi) ${t}: --hud-tint is set (the HUD tints from it, not from --focus)`, 'unset');
    }
    const hb = await hudColours(BLUE);
    ok(hb.tint === '' && HOLO.every((n) => hb[n] && hb[n].length === 3) && Math.abs(hb['--holo'][0] - hb['focus-ref'][0]) < 0.6 && Math.abs(hb['--holo'][1] - hb['focus-ref'][1]) < 0.6 && Math.abs(hb['--holo'][2] - hb['focus-ref'][2]) < 0.6, '(vi) blue: --hud-tint unset and the HUD --holo is still 72% --focus / 28% --foreground (unchanged)', JSON.stringify(hb['--holo']));
    ok(chroma(hb['--holo']) > 40, '(vi) blue: the HUD keeps its cyan tint (control: the chroma test above can see a tint)', String(chroma(hb['--holo'])));
    const bare = await hudColours('class="dark"');
    ok(bare.tint === '' && Math.abs(bare['--holo'][2] - bare['--holo'][0]) > 40, '(vi) no theme (next-UI off): the HUD is tinted from --focus exactly as in 0.2.11', JSON.stringify(bare['--holo']));
  } finally { await browser.close(); }
}
console.log(`\ncheck:theme-a-tokens ${fail ? 'FAIL' : 'PASS'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
