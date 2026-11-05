// Minimal JSON Schema (draft 2020-12 subset) validator, dependency-free.
// Supported keywords: $ref (same file "#/$defs/x" or "<file>.json#/$defs/x"), type, enum, const,
// properties, required, additionalProperties, items, minItems, maxItems, minLength, maxLength,
// pattern, minimum, maximum, anyOf. Keywords starting with "x-" are server metadata and ignored.
// Unsupported keywords throw at load time, so a schema can never silently validate less than it says.
import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED = new Set(['$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description', 'examples', 'default',
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'anyOf', 'format']);

function checkKeywords(schema, where) {
  if (!schema || typeof schema !== 'object') return;
  for (const k of Object.keys(schema)) {
    if (k.startsWith('x-')) continue;
    if (!SUPPORTED.has(k)) throw new Error(`unsupported schema keyword "${k}" in ${where}`);
  }
  for (const sub of Object.values(schema.properties || {})) checkKeywords(sub, where);
  for (const sub of Object.values(schema.$defs || {})) checkKeywords(sub, where);
  if (schema.items) checkKeywords(schema.items, where);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') checkKeywords(schema.additionalProperties, where);
  for (const sub of schema.anyOf || []) checkKeywords(sub, where);
}

/** Loads every *.json schema under dir (recursively) keyed by path relative to dir, e.g. "task.json", "ops/step.update.json". */
export function loadSchemas(dir) {
  const registry = new Map();
  const walk = rel => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r);
      else if (name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(path.join(dir, r), 'utf8'));
        if (!schema.$schema) continue; // discovery files such as index.json are not schemas
        checkKeywords(schema, r);
        registry.set(r, schema);
      }
    }
  };
  walk('');
  return registry;
}

const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function resolveRef(registry, file, ref) {
  const [f, frag = ''] = ref.split('#');
  const target = f ? path.posix.normalize(path.posix.join(path.posix.dirname(file), f)) : file;
  let node = registry.get(target);
  if (!node) throw new Error(`unresolved $ref ${ref} from ${file}`);
  for (const part of frag.split('/').filter(Boolean)) node = node[part];
  if (!node) throw new Error(`unresolved $ref ${ref} from ${file}`);
  return { schema: node, file: target };
}

/** Returns an array of {path, message}; empty means valid. */
export function validate(registry, file, value, schema = registry.get(file), at = '$') {
  if (!schema) throw new Error(`unknown schema ${file}`);
  const errors = [];
  const err = message => errors.push({ path: at, message });
  if (schema.$ref) {
    const r = resolveRef(registry, file, schema.$ref);
    errors.push(...validate(registry, r.file, value, r.schema, at));
  }
  if (schema.type) {
    const types = [].concat(schema.type), t = typeOf(value);
    if (!types.some(x => x === t || (x === 'number' && t === 'integer'))) { err(`expected ${types.join('|')}, got ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.some(e => e === value)) err(`must be one of ${schema.enum.join(', ')}`);
  if ('const' in schema && schema.const !== value) err(`must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && [...value].length < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (schema.maxLength != null && [...value].length > schema.maxLength) err(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) err(`does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) err(`less than ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) err(`greater than ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) err(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(registry, file, v, schema.items, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errors.push({ path: `${at}.${k}`, message: 'is required' });
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errors.push(...validate(registry, file, v, props[k], `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push({ path: `${at}.${k}`, message: 'is not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(registry, file, v, schema.additionalProperties, `${at}.${k}`));
    }
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map(s => validate(registry, file, value, s, at));
    if (!results.some(r => r.length === 0)) err('does not match any allowed shape');
  }
  return errors;
}
