// Visual reflex engine — public surface.
//   Catalog      built-in trigger variants loaded from gestures/*.json (data, not code)
//   ReflexEngine life + gaze + dispatch + pose application
//   attachInput  DOM events -> triggers
//   validateGesture / GestureCommand schema shared with the LLM `gesture:play` path
export { Catalog } from './catalog.js';
export { ReflexEngine } from './engine.js';
export { attachInput } from './input.js';
export { ClipLayer } from './clips.js';
export { validateGesture, EXPRESSIONS, BONE_LIMITS_DEG, LOOK_TARGETS, REACH_TARGETS } from './schema.js';
