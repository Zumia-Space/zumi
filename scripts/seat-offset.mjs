// Pure function: how far to translate the avatar's scene root (world Y) so the pelvis (hips bone) lands
// at a given seat height, from the model's own measured STANDING hip height. Test-only harness for T-31
// sit-prep (SIT-FEASIBILITY.md path a) -- NOT wired into the app, the room, or ClipLayer.
//
// Seating is done by moving the scene root, never by touching GestureCommand's root.pos: schema.js's
// ROOT_LIMITS caps that at 0.3 hip heights (too small for a full sit), and clips.js:84 strips position
// tracks out of clips on purpose (coordinator decision -- the quaternion-only filter stays as-is). This
// function is the one place that math lives, so the eventual wiring step has a single tested call to
// make, instead of re-deriving "pelvis height = standing hip height - drop" inline wherever it's needed.
//
// dropM > 0 means "move the scene root DOWN by this many metres". A seat taller than the model's own
// standing hip height yields a negative drop (lift the root up) -- this function does not judge whether
// that is a sane seat for this model; it only does the subtraction. Callers decide.
export function computeRootDrop(standingHipHeightM, seatHeightM) {
  if (!Number.isFinite(standingHipHeightM) || standingHipHeightM <= 0) {
    throw new Error(`standingHipHeightM must be a positive finite number, got ${standingHipHeightM}`);
  }
  if (!Number.isFinite(seatHeightM) || seatHeightM < 0) {
    throw new Error(`seatHeightM must be a non-negative finite number, got ${seatHeightM}`);
  }
  return standingHipHeightM - seatHeightM;
}
