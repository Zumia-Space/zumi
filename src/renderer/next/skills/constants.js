// T-31 slice 2 (Skills page): every number that sets the PACE of level and closeness, in one block.
//
// ============================================================================================================
// PLACEHOLDER until owner item (3) of next-ver-q (tier names and pace). Do not tune these by feel and do not write
// golden tests against them (AC-A1 / AC-L1 / AC-A2..A4 wait for that answer). Shapes come from SPEC-skills.md:
//   xp     = XP_PER_DAY * days + XP_PER_SKILL_LVL * sum(skill lvl)      (days = days with at least one turn)
//   Lv n   needs LEVEL_STEP * n(n+1)/2 cumulative xp; Lv 1 is the floor (xp 0)
//   daily closeness points = min(CLOSE_DAY_CAP, turns + min(CLOSE_TOUCH_CAP, touches * CLOSE_TOUCH_WEIGHT))
//   closeness = sum of daily points, no decay; tiers start at CLOSE_TIERS[i] points
// Tier NAMES are placeholders too: i18n keys skills.tier.1..5 read "Tier 1".."Tier 5" until anh names them.
// ============================================================================================================
// PLACEHOLDER until owner next-ver-q (3)
export const PLACEHOLDER = Object.freeze({
  XP_PER_DAY: 10,
  XP_PER_SKILL_LVL: 30,
  LEVEL_STEP: 100,
  CLOSE_DAY_CAP: 30,
  CLOSE_TOUCH_CAP: 5,
  CLOSE_TOUCH_WEIGHT: 0.5,
  CLOSE_TIERS: Object.freeze([0, 30, 150, 450, 1200]),
});

// Not pace: the store's shape version and write throttle (SPEC-skills.md "Store").
export const PROGRESS_KEY = 'zumi.progress';
export const PROGRESS_VERSION = 1;
export const WRITE_EVERY_MS = 60 * 1000;
// Dates kept one by one before they fold into the running total: the usage summary covers 30 days, so 31 days in
// the map is always enough to max-merge it; the extra headroom covers a clock set back and then forward again.
export const KEEP_DAYS = 62;
