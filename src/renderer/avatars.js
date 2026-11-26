// The default avatar set (R6 item 7, owner 19-11; v4 approved by the owner the same day, R6c D): the 12 presets of the v4 avatar builder, one
// per bot. They are drawn by the builder's own procedural SVG code (no third-party art, no script inside) and live in src/renderer/avatars/v4/
// (the default look of each preset; the builder keeps the six emotions in its own presets folder, copied
// here when a screen needs them).
//
// A bot's avatar is its built-in preset, or the first free preset for a bot made later (a persona), and the user's own choice
// (`choices[botId]`, a preset name) always wins. Pure: nothing here reads or writes settings; whoever stores the choices passes them in.

/** The twelve builder presets, in the order new bots take the free ones. */
export const PRESETS = Object.freeze(['tro-ly-chung', 'lap-trinh', 'ke-toan', 'nghien-cuu', 'viet-bai', 'cham-soc-khach', 'ban-hang', 'dich-thuat', 'du-lieu', 'nhan-su', 'thiet-ke', 'thu-ky']);

/** Zumi and the four roles of the chat brain (plan / do / check / lookup, src/main/role-models.js): a different preset each, chosen by what the
 *  role does. `cham-soc-khach` (customer care) is left free for the first persona. */
export const BUILT_IN = Object.freeze({ zumi: 'tro-ly-chung', do: 'lap-trinh', check: 'ke-toan', lookup: 'nghien-cuu', plan: 'viet-bai' });

const known = (p) => typeof p === 'string' && PRESETS.includes(p);

/** Small stable hash (FNV-1a) so a persona id always lands on the same preset. */
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** The preset a bot has until the user changes it. A built-in bot: its own. Any other id: the preset no built-in bot has first, then the
 *  whole set in a spread that does not depend on the order personas were made in. An unusable id: the first preset. */
export function defaultPreset(botId) {
  if (typeof botId !== 'string' || !botId) return PRESETS[0];
  if (Object.prototype.hasOwnProperty.call(BUILT_IN, botId)) return BUILT_IN[botId];
  const free = PRESETS.filter((p) => !Object.values(BUILT_IN).includes(p));
  // "persona-1" style ids count up: the first one takes the free preset, the later ones walk the set.
  const n = /(\d+)$/.exec(botId);
  const index = n && Number.isSafeInteger(Number(n[1])) ? Number(n[1]) - 1 : hash(botId);
  const order = [...free, ...PRESETS.filter((p) => !free.includes(p))];
  return order[((index % order.length) + order.length) % order.length];
}

/** The avatar of a bot: the user's choice when it is a preset, else the default. */
export function avatarFor(botId, choices) {
  const mine = choices && typeof choices === 'object' && typeof botId === 'string' && Object.prototype.hasOwnProperty.call(choices, botId) ? choices[botId] : undefined;
  return known(mine) ? mine : defaultPreset(botId);
}

/** The file of a preset, relative to the renderer page. Only a known preset has one (no path ever comes from outside). */
export function avatarUrl(preset) {
  return known(preset) ? `avatars/v4/${preset}.svg` : null;
}
