// T-31 0.2.3 batch B1: text -> speech cleanup, no model, no network, no Electron.
//   1. stripMarkup(): markdown (asterisks, headings, lists, links, code, strikethrough), a model's <think>...</think>
//      block, and emoji are gone from the spoken text; the chunker's first-clause behaviour is untouched.
//   2. quickSpeechText()/sanitizeSpeech(): the board-ask voice notice speaks the task title + the ask's step label,
//      whitelist-sanitised, never the mangled raw ask text (no urls, paths, markup or emoji).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stripMarkup, createStreamChunker, createSpeechFeed } = require('../src/main/speech-chunker.js');
const { sanitizeSpeech, quickSpeechText, stepLabelOf } = require('../src/main/quick-speech.js');
const { buildHudFeed } = await import('../src/main/hud-feed.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

// ---------- 1. stripMarkup ----------
{
  const cases = [
    ['**Done** and *ready*.', 'Done and ready.'],
    ['# Heading\nnext line', 'Heading next line'],
    ['- one\n- two\n1. three', 'one two 1. three'],
    ['Use `npm test` now', 'Use npm test now'],
    ['see [the docs](https://example.com/x) for more', 'see the docs for more'],
    ['![shot](media/x.png) caption', 'caption'],
    ['Sure! 😀 Let us go 🚀', 'Sure! Let us go'],
    ['<think>secret reasoning</think>the answer', 'the answer'],
    ['the answer <think>unclosed reasoning', 'the answer'],
    ['snake_case_name kept', 'snake_case_name kept'],
    ['__init__ and __name__ kept', '__init__ and __name__ kept'],
    ['an _italic_ word', 'an italic word'],
    ['plain text, no change', 'plain text, no change'],
  ];
  for (const [input, want] of cases) {
    const got = stripMarkup(input);
    ok(got === want, `stripMarkup: ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, `got ${JSON.stringify(got)}`);
  }
  ok(stripMarkup(stripMarkup('**x** 😀 _a_ __b__')) === stripMarkup('**x** 😀 _a_ __b__'), 'stripMarkup: idempotent');
  ok(stripMarkup(null) === '' && stripMarkup(undefined) === '', 'stripMarkup: null/undefined -> empty string');
}

// The chunker itself is unchanged: the first clause is still cut, and stripping a chunk never breaks that.
{
  const c = createStreamChunker();
  const chunks = [...c.push('Sure, I can draft that email for you.'), ...c.end()];
  ok(chunks[0] === 'Sure,' && chunks[0].length <= 24, 'chunker: the first-clause cut is intact (<= 24 chars)', JSON.stringify(chunks));
  ok(chunks.map(stripMarkup).join(' ') === 'Sure, I can draft that email for you.', 'chunker: join(stripMarkup(chunks)) recovers the clause text', JSON.stringify(chunks));
}

// ---------- 2. quick.speech: the board-ask notice speaks title + step, whitelist-sanitised ----------
{
  const cases = [
    ['Plan **now** 😀', 'Plan now'],
    ['see https://evil.example/x?y=1 for it', 'see for it'],
    ['open `C:/data/F-04/sheet.png` please', 'open please'],
    ['a <b>tag</b> and [link](http://x)', 'a tag and link'],
    ['  lots   of\tspace  ', 'lots of space'],
    ['giữ nguyên dấu tiếng Việt «được»', 'giữ nguyên dấu tiếng Việt «được»'],
    ['note: 12:30', 'note 12 30'],
  ];
  for (const [input, want] of cases) {
    const got = sanitizeSpeech(input);
    ok(got === want, `sanitizeSpeech: ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, `got ${JSON.stringify(got)}`);
  }
  // T-31 talk-mode (plan F5/3.3): raw board task codes are never spoken. The strip runs before the whitelist, so it
  // catches the code forms the board uses (T-31, F-04) and the digit-letter form (C52-x), without eating real words.
  const codeCases = [
    ['task T-31 is ready', 'task is ready'],
    ['F-04 needs you', 'needs you'],
    ['C52-x done', 'done'],
    ['T-31 Zumi avatar', 'Zumi avatar'],
    ['A-1 and AB-12', 'and'],
  ];
  for (const [input, want] of codeCases) {
    const got = sanitizeSpeech(input);
    ok(got === want, `sanitizeSpeech (code strip): ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, `got ${JSON.stringify(got)}`);
  }
  ok(sanitizeSpeech('well-known X-ray').includes('well-known') && sanitizeSpeech('well-known X-ray').includes('X-ray'), 'sanitizeSpeech (code strip): hyphenated words are left alone', JSON.stringify(sanitizeSpeech('well-known X-ray')));
  ok(quickSpeechText({ title: 'T-31 Zumi avatar', step: 'HUD' }) === 'Zumi avatar — HUD', 'quickSpeechText: the title\'s task code never reaches the line', JSON.stringify(quickSpeechText({ title: 'T-31 Zumi avatar', step: 'HUD' })));
  ok(sanitizeSpeech('x'.repeat(200)).length <= 90, 'sanitizeSpeech: caps the length (<= 90 chars)');
  ok(sanitizeSpeech('') === '' && sanitizeSpeech(null) === '', 'sanitizeSpeech: empty/null -> empty string');
  ok(!sanitizeSpeech('loopback 127.0.0.1:4320 here').includes(':') && sanitizeSpeech('loopback 127.0.0.1:4320 here') === 'loopback 127.0.0.1 4320 here', 'sanitizeSpeech: a host:port colon never survives', JSON.stringify(sanitizeSpeech('loopback 127.0.0.1:4320 here')));

  ok(quickSpeechText({ title: 'Wardrobe v2', step: 'Round 4' }) === 'Wardrobe v2 — Round 4', 'quickSpeechText: task title then step label', JSON.stringify(quickSpeechText({ title: 'Wardrobe v2', step: 'Round 4' })));
  ok(quickSpeechText({ title: 'Wardrobe v2' }) === 'Wardrobe v2', 'quickSpeechText: title only falls back to the title');
  ok(quickSpeechText({ step: 'Round 4' }) === 'Round 4', 'quickSpeechText: step only falls back to the step');
  ok(quickSpeechText({}) === '', 'quickSpeechText: nothing to say -> empty');

  const task = { steps: [{ id: 's1', label: 'Round 4' }, { id: 'F-04/s2', label: 'Owner PIN' }] };
  ok(stepLabelOf(task, 's1') === 'Round 4', 'stepLabelOf: a bare step id resolves');
  ok(stepLabelOf(task, 'F-04/s2') === 'Owner PIN', 'stepLabelOf: a nested step id resolves');
  ok(stepLabelOf(task, 'F-04/s1') === 'Round 4', 'stepLabelOf: a nested id matches a bare step id too');
  ok(stepLabelOf(task, 'nope') === '' && stepLabelOf(null, 's1') === '', 'stepLabelOf: unknown/missing -> empty');
}

// ---------- 2b. hud-feed attaches the speak line to an ask, never the mangled ask text ----------
{
  const iso = new Date(Date.now() - 60000).toISOString();
  const state = {
    tasks: [{ id: 'F-04', title: 'Wardrobe v2', status: 'active', rev: 2, last_activity_at: iso, current_step: { id: 's1', label: 'Round 4', state: 'waiting' }, steps: [{ id: 's1', label: 'Round 4', state: 'waiting' }] }],
    attention: { waiting: [{ kind: 'ask', id: 'ask-1', task_id: 'F-04', step_id: 's1', text: 'Thêm địa chỉ quay về giữ', rev: 1, since: iso }] },
  };
  const feed = buildHudFeed(state);
  const w = feed.waiting[0];
  ok(w.speak === 'Wardrobe v2 — Round 4', 'hud-feed: the ask item speaks the task title + step label', JSON.stringify(w));
  ok(w.step === 'Round 4' && !JSON.stringify(w.speak).includes('quay về giữ'), 'hud-feed: the mangled raw ask text is never the spoken line', JSON.stringify({ speak: w.speak, text: w.text }));
  // an ask with no step: falls back to the task title
  const feed2 = buildHudFeed({ tasks: state.tasks, attention: { waiting: [{ kind: 'ask', id: 'a2', task_id: 'F-04', text: 'hello', rev: 1, since: iso }] } });
  ok(feed2.waiting[0].speak === 'Wardrobe v2', 'hud-feed: an ask with no step speaks the task title', JSON.stringify(feed2.waiting[0]));
}

// The streaming hold-back: an unclosed opener is held until it closes, so no partial url/think/code is spoken.
{
  // T-31 0.2.3 B1 item 3: a prose aside is released at the next clause boundary, not held until the reply ends
  // growing a link across deltas: the url is never in any stripped snapshot
  const c = createStreamChunker();
  const feed = createSpeechFeed(c);
  const seen = [];
  for (const full of ['See [the ', 'See [the docs](http', 'See [the docs](http://evil.example/x) now']) seen.push(...feed(full, false));
  seen.push(...feed('See [the docs](http://evil.example/x) now', true), ...c.end());
  ok(seen.every((x) => !/http|evil|\[|\]/.test(x)) && seen.join(' ') === 'See the docs now', 'feed: no chunk of a split link ever contains a url or markup', JSON.stringify(seen));
}

console.log(`\ncheck:speech-text ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
