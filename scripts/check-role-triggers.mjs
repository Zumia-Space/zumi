// T-31 zumi-roles: when Look up joins a chat turn (src/main/role-triggers.js wantsLookup). Every fire runs a web
// search (~10 s before Zumi speaks, $0.007), so casual talk must never fire it (CoS review of b4d6d75, 10-10: "Hôm nay
// em thế nào?", "đánh giá...", "current task" and "now" did). Two lists, VI + EN: real fresh / outside-fact asks
// (price + a thing, news, weather, scores, a link, a search verb, a year >= 2024 in a fact question) must fire;
// casual lines must not. Pure function, no network.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wantsLookup, wantsPlan, wantsCheck } = require('../src/main/role-triggers.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const POSITIVE = [
  'What is the gold price today?',
  'gold price today?',
  'price of bitcoin right now',
  'Giá vàng hôm nay bao nhiêu?',
  'Tỷ giá đô la hôm nay là bao nhiêu?',
  'Latest news on rockets?',
  'news today?',
  'In two short sentences: what is the latest news about the James Webb Space Telescope?',
  'Tin tức công nghệ hôm nay có gì?',
  'Thời tiết Hà Nội ngày mai thế nào?',
  "What's the weather like in Tokyo this weekend?",
  'Tỷ số trận MU tối qua là mấy?',
  'Premier League live scores please',
  "What's the score of the Lakers game?",
  'Kết quả xổ số miền Bắc hôm nay',
  'Đọc giúp anh bài này: https://example.org/article',
  'Search for the best ramen in Hanoi',
  'Can you look up the opening hours of the Louvre?',
  'Tra cứu giúp anh luật thuế thu nhập mới',
  'Tìm giúp anh quán cà phê yên tĩnh gần Hồ Gươm',
  'Who won the 2026 World Cup?',
  'Doanh thu Vinamilk năm 2025 là bao nhiêu?',
];

const NEGATIVE = [
  // the four lines from the review
  'Hôm nay em thế nào?',
  'Em đánh giá giúp anh bài viết này nhé',
  "What's my current task?",
  'What should I do now?',
  // more casual VI / EN talk
  'Hi Zumi, how are you today?',
  'Chào em, hôm nay anh mệt quá',
  'Bây giờ anh nên làm gì trước?',
  "What's the latest on my board?",
  'Good news, I finished the report!',
  'I have some news for you: we signed the client',
  "I'm feeling a bit under the weather today",
  'Giá mà anh có thêm thời gian',
  'Giá trị cốt lõi của công ty mình là gì?',
  'Đừng lo, cái giá phải trả không lớn đâu',
  'Is that a good price?',
  'Kiểm tra giúp anh email này nhé',
  'Em tìm hiểu giúp anh cách viết mở bài hay hơn',
  'Plan my goals for 2026',
  'Năm 2026 em muốn làm gì?',
  'Kết quả công việc tuần này của anh thế nào?',
  'Remind me what we decided yesterday',
  'Tell me a joke about cats',
  'Cảm ơn em, vậy là đủ rồi',
];

ok(POSITIVE.length >= 10, `lists: ${POSITIVE.length} positive lines (>= 10)`);
ok(NEGATIVE.length >= 15, `lists: ${NEGATIVE.length} casual negative lines (>= 15)`);
const missed = POSITIVE.filter((m) => !wantsLookup(m));
const falseFires = NEGATIVE.filter((m) => wantsLookup(m));
for (const m of POSITIVE) ok(wantsLookup(m), `fires: ${m}`);
for (const m of NEGATIVE) ok(!wantsLookup(m), `quiet: ${m}`);
ok(wantsLookup('Giá vàng hôm nay?'.normalize('NFD')), 'fires: a decomposed (NFD) "giá vàng" matches like the composed one');
ok(!wantsLookup('') && !wantsLookup(null) && !wantsLookup(undefined), 'quiet: empty / missing message');
// Plan / Check rules are unchanged by the Look up rewrite
ok(wantsPlan('Plan my week, step by step please') && !wantsPlan('Hi Zumi, how are you?'), 'plan: unchanged (plan words fire, a greeting does not)');
ok(wantsCheck('kiểm tra giúp anh: 2+2=5?', '') && !wantsCheck('Hi', 'short'), 'check: unchanged (kiểm tra fires, a short greeting does not)');

console.log(`role-triggers: ${POSITIVE.length - missed.length}/${POSITIVE.length} positive fire, ${NEGATIVE.length - falseFires.length}/${NEGATIVE.length} casual quiet`);
if (missed.length) console.log(`missed: ${JSON.stringify(missed)}`);
if (falseFires.length) console.log(`false fires: ${JSON.stringify(falseFires)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
