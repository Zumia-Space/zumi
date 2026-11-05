'use strict';
// Local rule-based reflex fallback (T-31 QC-cuoi fix b, 09-10). Used by reflex-jev.js when Jev has no answer in
// its 900 ms budget (timeout, offline, http error, no key) and the embedding classifier is not vendored. Before
// this, every such Enter fell straight to 'neutral' -- the main-PC log of 02-10 already shows a Jev timeout.
// Plain keyword rules, EN + VI (with and without diacritics), no model, no network, sub-millisecond. It only has to
// get the obvious lines right; a line no rule matches stays neutral (decider 'none'), never a guess.
// Order matters: first match wins (e.g. "I don't know, you choose" is a shrug before it is anything else).
const RULES = [
  ['shrug', /\b(i (don'?t|do not) know|dunno|not sure|you (choose|decide|pick)|up to you|whatever|either (one|way)|no idea)\b|không biết|khong biet|tùy em|tuy em|em chọn|em chon/i],
  ['concern', /\b(tired|exhausted|crash(ed|es)?|broke(n)?|fail(ed|ing|s)?|error|bug|sick|sad|stress(ed)?|worried|down again|bad news|problem|lost)\b|mệt|met qua|lỗi|loi roi|hỏng|buồn|lo quá/i],
  ['surprise', /\b(wow|whoa|woah|omg|no way|unbelievable|incredible|can'?t believe)\b|trời ơi|troi oi|không thể tin|thật á/i],
  ['happy', /\b(good (morning|afternoon|evening)|hello|hi|hey|thanks?|thank you|great job|well done|love (it|you)|congrat\w*|haha+|lol)\b|chào|chao em|cảm ơn|cam on|tuyệt/i],
  ['nod', /^\s*(yes|yeah|yep|sure|agreed|deal|exactly|correct|right)\b|\b(sounds good|go ahead|that works|let'?s do it)\b|đồng ý|dong y|được đó|ok làm đi/i],
  ['listen', /\b(can you|could you|would you|please|write|draft|make|create|help me|explain|tell me|let me tell you|so here'?s)\b|giúp|giup anh|viết|viet|làm giúp|kể/i],
  ['think', /\?\s*$|\b(which|why|how|should (we|i)|compare|cheaper|better|or)\b.*\?|tại sao|nên chọn|cái nào/i],
];

// text -> { label, conf } | null (null = no rule matched: the caller shows neutral and logs decider 'none').
function classifyRules(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const [label, re] of RULES) if (re.test(s)) return { label, conf: 0.8 };
  return null;
}

module.exports = { classifyRules, RULE_LABELS: RULES.map(([l]) => l) };
