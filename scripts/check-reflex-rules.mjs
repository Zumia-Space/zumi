// T-31 QC-cuoi fix b (09-10): when Jev has no answer within its 0.9 s budget, a LOCAL rule-based reflex decides
// instead of every line ending 'neutral', and each Enter logs which decider chose: jev / rules / none.
// Red on 17382db: a Jev timeout with no vendored embedding model returned source 'neutral' for every line.
// Uses the QC card's own test sentences (section 3 of the owner's QC card). No network, no real key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReflexJev, createKeyStore, TIMEOUT_MS } = require('../src/main/reflex-jev.js');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const FAKE_KEY = 'sk-or-TESTFAKEKEY1234567890ABCDEFGHIJ';
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${s}`, 'utf8'), decryptString: (b) => b.toString('utf8').slice(4) };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-rules-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
fs.writeFileSync(path.join(dir, 'jev-key.import'), FAKE_KEY);
createKeyStore({ safeStorage, dir }).importIfPresent();

// A Jev that never answers in time: waits on the request's own abort signal (the 900 ms AbortSignal.timeout).
// (AbortSignal.timeout's timer is unref'd; a real socket keeps the loop alive in the app, this ref'd timer does here.)
const slowJev = (url, opts) => new Promise((resolve, reject) => {
  const hold = setTimeout(() => reject(new Error('fake jev: abort never came')), 5000);
  opts.signal.addEventListener('abort', () => { clearTimeout(hold); reject(opts.signal.reason || Object.assign(new Error('timeout'), { name: 'TimeoutError' })); });
});
const logs = [];
const rj = createReflexJev({ egressAllowed: true, safeStorage, dir, fetchImpl: slowJev, loadLocal: async () => { throw new Error('not vendored'); }, log: (m) => logs.push(m) });

ok(TIMEOUT_MS === 900, 'jev budget is still 0.9 s');
const QC = [
  ['Good morning Zumi, thanks for yesterday!', 'happy'],
  ['Can you write a short email to the client for me?', 'listen'],
  ['Yes, that sounds good, go ahead.', 'nod'],
  ['Wow, we got ten thousand new users overnight!', 'surprise'],
  ['Which is cheaper for us, renting a server or buying one?', 'think'],
  ["I'm so tired, the server crashed again today.", 'concern'],
  ["I don't know, you choose.", 'shrug'],
];
for (const [text, want] of QC) {
  const t0 = Date.now();
  const r = await rj.classify(text);
  const ms = Date.now() - t0;
  ok(r.reaction === want && r.source === 'rules' && r.decider === 'rules', `jev timeout -> rules: "${text}" -> ${want}`, JSON.stringify(r));
  ok(ms >= 850 && ms < 1300, `jev timeout -> rules answers right after the 0.9 s budget, not later (${ms} ms)`);
}
{
  const r = await rj.classify('ok');
  ok(r.reaction === 'neutral' && r.decider === 'none', 'a filler line no rule matches stays neutral, decider none', JSON.stringify(r));
}
ok(logs.filter((l) => /^decider=rules reaction=\w+ ms=\d+$/.test(l)).length === QC.length, 'each rules decision is logged as decider=rules', JSON.stringify(logs.slice(-3)));
ok(logs.some((l) => /^decider=none reaction=neutral/.test(l)), 'the no-match line is logged as decider=none');
ok(logs.every((l) => !l.includes('Good morning') && !l.includes(FAKE_KEY)), 'decider log lines carry no message text and no key');

// Jev answering in time still wins, and is logged as decider=jev.
{
  const fastJev = async () => ({ ok: true, status: 200, json: async () => ({ answers: { reaction: { choice: 'surprise', confidence: 0.93 } }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) });
  const jlogs = [];
  const rj2 = createReflexJev({ egressAllowed: true, safeStorage, dir, fetchImpl: fastJev, log: (m) => jlogs.push(m) });
  const r = await rj2.classify("I'm so tired"); // rules would say concern: Jev's answer must win
  ok(r.reaction === 'surprise' && r.source === 'jev' && r.decider === 'jev', 'jev in time: Jev decides, not the rules', JSON.stringify(r));
  ok(jlogs.some((l) => /^decider=jev reaction=surprise/.test(l)), 'jev in time: logged as decider=jev');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
