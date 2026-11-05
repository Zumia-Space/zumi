// Speech-gesture library: LLM-authored GestureCommands shipped as data (reflex/speech/<intent>.json), one file per
// intent. Every variant must pass checkSpeechGesture at load; a broken file stops the app (like the reflex catalog)
// instead of leaving Zumi silently motionless.
import { checkSpeechGesture } from './validate.js';
import { INTENTS, ENERGIES } from './intents.js';

export class SpeechLibrary {
  constructor(random = Math.random) { this.random = random; this.byIntent = new Map(); this.last = new Map(); }

  // fetchJson(path) -> parsed JSON (renderer: fetch over app://; Node checks: fs)
  static async load(fetchJson, random = Math.random) {
    const lib = new SpeechLibrary(random);
    const index = await fetchJson('index.json');
    const errors = [];
    for (const intent of index.intents) {
      if (!INTENTS.includes(intent)) { errors.push(`index.json: unknown intent ${intent}`); continue; }
      const def = await fetchJson(`${intent}.json`);
      if (def.intent !== intent) errors.push(`${intent}.json: intent field is '${def.intent}'`);
      const variants = [];
      for (const v of def.variants || []) {
        const r = checkSpeechGesture(v.command);
        if (!r.ok) { errors.push(`${intent}/${v.id}: ${r.errors.join('; ')}`); continue; }
        if (v.faces && !['screen-left', 'screen-right'].includes(v.faces)) errors.push(`${intent}/${v.id}: faces must be screen-left|screen-right`);
        // energies (optional): the turn energies this variant may be used for (e.g. a stern refusal only for mid/high);
        // absent = every energy
        if (v.energies !== undefined && (!Array.isArray(v.energies) || !v.energies.length || v.energies.some((e) => !ENERGIES.includes(e)))) errors.push(`${intent}/${v.id}: energies must be a non-empty list of ${ENERGIES.join('|')}`);
        variants.push({ id: v.id, faces: v.faces || null, energies: v.energies || null, provenance: v.provenance || null, command: r.command, durationMs: r.durationMs });
      }
      lib.byIntent.set(intent, { intent, labelVi: def.labelVi, variants });
    }
    if (errors.length) throw new Error(`speech library invalid:\n${errors.join('\n')}`);
    return lib;
  }

  count(intent) { return (this.byIntent.get(intent) || { variants: [] }).variants.length; }
  total() { let n = 0; for (const d of this.byIntent.values()) n += d.variants.length; return n; }

  // Random variant that fits the turn's energy (when given), never the same one twice in a row; null when none fits.
  pick(intent, energy = null) {
    const def = this.byIntent.get(intent);
    if (!def) return null;
    const fits = def.variants.filter((v) => !energy || !v.energies || v.energies.includes(energy));
    if (!fits.length) return null;
    const last = this.last.get(intent);
    const pool = fits.length > 1 ? fits.filter((v) => v.id !== last) : fits;
    const v = pool[Math.floor(this.random() * pool.length)];
    this.last.set(intent, v.id);
    return v;
  }
}
