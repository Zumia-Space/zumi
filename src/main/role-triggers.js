'use strict';
// When a turn uses the Plan, Check or Look up role (T-31 zumi-roles, ASTRA-SPEC.md 10-10). Regex + length only, no
// model call to decide (a call to save a call). EN + VI words, matched against what the owner typed (and, for Check,
// the length of Zumi's final reply). Word edges are Unicode-aware: JS `\b` only knows ASCII letters, so "giá" or
// "đúng không" would never match with it.
const L = '[\\p{L}\\p{N}]';
const A = `(?<!${L})`; // a word starts here
const Z = `(?!${L})`; // a word ends here
const re = (src) => new RegExp(src, 'iu');
const words = (list) => re(`${A}(?:${list.join('|')})${Z}`);

const PLAN_MIN_CHARS = 200;
const PLAN_WORDS = words(['plan', 'steps?', 'how (?:do|should) i', 'roadmap', 'kế hoạch', 'các bước', 'từng bước', 'lộ trình']);
const CHECK_MIN_REPLY_CHARS = 400;
const CHECK_WORDS = words(['check', 'verify', 'double-?check', 'kiểm tra', 'chắc không', 'đúng không']);

// Look up (CoS review of b4d6d75, 10-10): casual lines ("Hôm nay em thế nào?", "đánh giá...", "current task", "now")
// fired it, and each false fire costs ~10 s of wait and $0.007 of web search. It now fires only on an ask for a fresh
// or outside fact, one rule per kind below. A bare time word (today, now, current, latest, hôm nay, bây giờ, mới
// nhất) never fires on its own. Tests: scripts/check-role-triggers.mjs (positive + casual negative lists).
const LOOKUP_RULES = [
  // the price of a thing: "gold price", "price of bitcoin", "exchange rate". Not "a good price", "the price of it".
  re(`${A}(?!(?:the|a|an|what|which|this|that|its|my|your|our|their|his|her|good|great|fair|right|low|high|full|best|same|any|no|total|final|asking|nice|cheap|reasonable)${Z})${L}+\\s+prices?${Z}`),
  re(`${A}prices?\\s+(?:of|for|on)\\s+(?!(?:it|this|that|these|those|them)${Z})${L}`),
  re(`${A}exchange\\s+rates?${Z}`),
  // giá + a thing: "giá vàng", "tỷ giá đô". Not "đánh giá" (judge), "giá mà / giá như" (if only), "giá trị" (value),
  // "giá cả" (prices in general), "cái giá / trả giá" (the cost of a choice), "định giá / ra giá" (Zumi's own estimate).
  re(`(?<!${A}(?:đánh|vô|cái|trả|định|ra)\\s)${A}giá\\s+(?!(?:mà|như|trị|cả|sách|đỗ)${Z})${L}`),
  // news. Not "good news, ...", "I have some news for you".
  re(`(?<!${A}(?:good|great|bad|big|some|exciting|sad|happy|fantastic|amazing|wonderful|terrible|awesome|no|fake|have|has|got|my|personal)\\s)${A}news${Z}(?!\\s+for\\s+(?:you|me|us)${Z})`),
  words(['tin tức', 'thời sự', 'bản tin', 'tin mới nhất', 'tin nóng']),
  // weather. Not "under the weather" (unwell).
  re(`(?<!under\\s+the\\s)${A}weather${Z}`),
  words(['thời tiết']),
  // scores and results of a match / draw / vote
  re(`${A}(?:(?:live|final|latest|football|soccer|basketball|tennis|match|game)\\s+scores?|scores?\\s+(?:of|for|from)\\s+(?:the|last|today|tonight|yesterday)|what(?:['’]s|\\s+is)\\s+the\\s+score|who\\s+won\\s+(?:the|last|yesterday|tonight))${Z}`),
  words(['tỷ số', 'tỉ số', 'kết quả\\s+(?:trận|bóng đá|xổ số|bầu cử)', 'xổ số\\s+(?:miền|hôm nay)']),
  // an explicit search verb. Not "tìm hiểu / tìm cách" (learn, find a way), not "kiểm tra / điều tra" (check, probe).
  re(`${A}(?:search|look\\s+(?:it\\s+|this\\s+|that\\s+)?up|google\\s+(?:it|this|that|for))${Z}`),
  re(`${A}(?:tìm kiếm|tra cứu|tìm\\s+(?:giúp|hộ|dùm|giùm|thử|xem|trên)|(?<!(?:kiểm|điều)\\s)tra\\s+(?:giúp|hộ|dùm|giùm|thử|xem|trên|google))${Z}`),
];
const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i;
// A year >= 2024 counts only in a question about an outside fact (who won, what happened, a release, a result, a
// figure), never about the owner's own plans ("Plan my goals for 2026", "Năm 2026 em muốn làm gì?").
const YEAR_RE = /(?<!\d)(20\d\d)(?!\d)/g;
const FACT_CUE = re(`${A}(?:who\\s+(?:won|is|was|are|were)|what\\s+happened|when\\s+(?:is|was|will|did|does)|releas(?:e|ed|es)|launch(?:ed|es)?|announced|winners?|results?|elections?|champions?|revenue|population|gdp|inflation|ai\\s+(?:thắng|vô địch|đoạt|giành)|chuyện gì|xảy ra|diễn ra|ra mắt|phát hành|công bố|kết quả|vô địch|bầu cử|doanh thu|dân số|lạm phát|khi nào)${Z}`);
const OWN = re(`${A}(?:my|our|của\\s+(?:anh|em|mình|tôi|chúng ta))${Z}`);

const wantsPlan = (message) => String(message || '').length >= PLAN_MIN_CHARS || PLAN_WORDS.test(String(message || ''));
const wantsCheck = (message, reply) => String(reply || '').length >= CHECK_MIN_REPLY_CHARS || CHECK_WORDS.test(String(message || ''));
function wantsLookup(message) {
  const m = String(message || '').normalize('NFC'); // a decomposed "giá" (NFD input) must match too
  if (URL_RE.test(m) || LOOKUP_RULES.some((r) => r.test(m))) return true;
  return [...m.matchAll(YEAR_RE)].some((y) => Number(y[1]) >= 2024) && FACT_CUE.test(m) && !OWN.test(m);
}

module.exports = { wantsPlan, wantsCheck, wantsLookup, PLAN_MIN_CHARS, CHECK_MIN_REPLY_CHARS };
