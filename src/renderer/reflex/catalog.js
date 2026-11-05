// Built-in reflex catalog. The variants are DATA (gestures/*.json), each one a GestureCommand that
// goes through the same validator + player as an LLM-authored command.
import { validateGesture } from './schema.js';

export class Catalog {
  constructor(random = Math.random) {
    this.random = random;
    this.triggers = new Map(); // name -> { name, labelVi, state, variants: [{id, labelVi, command, selftest}] }
    this.last = new Map();
    this.forced = new Map();
  }

  static async load(baseUrl = 'gestures/', random = Math.random) {
    const cat = new Catalog(random);
    const index = await (await fetch(`${baseUrl}index.json`)).json();
    const errors = [];
    for (const name of index.triggers) {
      const def = await (await fetch(`${baseUrl}${name}.json`)).json();
      if (def.trigger !== name) errors.push(`${name}.json: trigger field is '${def.trigger}'`);
      if (!Array.isArray(def.variants) || def.variants.length < 3) errors.push(`${name}.json: needs >= 3 variants`);
      for (const v of def.variants || []) {
        const res = validateGesture(v.command);
        if (!res.ok) errors.push(`${name}/${v.id}: ${res.errors.join('; ')}`);
        else if (res.warnings.length) errors.push(`${name}/${v.id}: built-in data must not need clamping: ${res.warnings.join('; ')}`);
      }
      cat.triggers.set(name, { name, labelVi: def.labelVi, state: Boolean(def.state), variants: def.variants });
    }
    if (errors.length) throw new Error(`gesture catalog invalid:\n${errors.join('\n')}`);
    return cat;
  }

  get(name) { return this.triggers.get(name) || null; }
  names() { return [...this.triggers.keys()]; }

  forceNext(trigger, variantId) { this.forced.set(trigger, variantId); }

  // Random variant, never the same one twice in a row for a trigger.
  pick(trigger) {
    const t = this.triggers.get(trigger);
    if (!t) return null;
    const forcedId = this.forced.get(trigger);
    let v;
    if (forcedId) {
      this.forced.delete(trigger);
      v = t.variants.find((x) => x.id === forcedId) || null;
    }
    if (!v) {
      const last = this.last.get(trigger);
      const pool = t.variants.length > 1 ? t.variants.filter((x) => x.id !== last) : t.variants;
      v = pool[Math.floor(this.random() * pool.length)];
    }
    this.last.set(trigger, v.id);
    return v;
  }
}
