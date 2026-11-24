// R6g: the Gemini preset's tool-confirmation request. Gemini 3 (Google docs, "Thought signatures", checked 20-11): "If you omit a `thought_signature` for the
// first `functionCall` part in any step of the current turn, the request will fail with a 400 error"; parallel calls: the signature is on the FIRST call only;
// sequential calls: each carries one and "you must pass all signatures back" in the part where it was received. On the OpenAI-compatible endpoint
// (generativelanguage.googleapis.com/v1beta/openai/, the preset's) the signature rides on each tool call as `extra_content.google.thought_signature`
// (Google's Vertex OpenAI page: Gemini-specific fields live inside `extra_content.google`; developer reports give the path
// choices[0].message.tool_calls[N].extra_content.google.thought_signature, in streamed chunks too, which may carry no `index`).
// This is a REQUEST-SHAPE test built from those documented shapes. It is UNVERIFIED against the live API (no key, no paid call): the first live
// Gemini correction turn (GATE-OPUS-R6F checklist item 1) is the proof.
//   node scripts/check-gemini-tool-shape.mjs     (exit 1 on any failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChatBrain, streamChat } = require('../src/main/chat-brain.js');
const { createKeyStore } = require('../src/main/reflex-jev.js');
const prov = require('../src/main/providers.js');
let pass = 0, fail = 0;
const ok = (c, name, detail = '') => { if (c) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${detail}`); } };
const SIG_A = 'CrICAdHtim827fQ-signature-A';
const SIG_B = 'CvcQAdHN2OekY10ClPFkYA==';

// A Gemini-shaped SSE stream: tool_calls WITHOUT `index`, the signature in extra_content.google on the call that has it.
const sse = (chunks) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(`data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const delta = (d) => ({ id: 'g', model: 'gemini-3.5-flash-lite', choices: [{ index: 0, delta: d, finish_reason: null }] });
const call = (id, name, args, sig) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) }, ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}) });
const geminiStream = (calls) => sse([delta({ role: 'assistant', tool_calls: calls }), { id: 'g', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, '[DONE]']);

// 1. the stream keeps the signature, merges nothing wrongly: two index-less calls stay two calls, the signature stays on the first
{
  const r = await streamChat([{ role: 'user', content: 'hi' }], 'AIza' + 'b'.repeat(35), {
    provider: prov.PROVIDERS.gemini, model: 'gemini-3.5-flash-lite', tools: [{ type: 'function', function: { name: 'memory_update' } }],
    fetchImpl: async () => geminiStream([call('fc-1', 'memory_update', { action: 'forget', old_text: 'durian' }, SIG_A), call('fc-2', 'memory_update', { action: 'forget', old_text: 'mango' })]),
  });
  r.toolCalls = r.toolCalls || [];
  ok(r.ok && r.toolCalls.length === 2 && r.toolCalls[0].id === 'fc-1' && r.toolCalls[1].id === 'fc-2', 'two streamed calls without an index stay two calls (was: joined into one slot and both dropped)', JSON.stringify(r.toolCalls));
  ok(r.toolCalls[0] && r.toolCalls[0].extra && r.toolCalls[0].extra.google && r.toolCalls[0].extra.google.thought_signature === SIG_A && r.toolCalls[1] && !r.toolCalls[1].extra, 'the thought signature is kept on the first call only (parallel-call rule)', JSON.stringify(r.toolCalls));
}

// 2. the confirmation request echoes it: a Gemini turn, tool called, host applies, second request
for (const [label, calls, expectSigs] of [
  ['one call', [call('fc-1', 'memory_update', { action: 'supersede', old_text: 'Ken', text: 'The user is called Kei' }, SIG_A)], [SIG_A]],
  ['two parallel calls (signature on the first)', [call('fc-1', 'memory_update', { action: 'forget', old_text: 'durian' }, SIG_A), call('fc-2', 'memory_update', { action: 'forget', old_text: 'mango' })], [SIG_A, undefined]],
  ['a call with a signature on each (sequential style)', [call('fc-1', 'memory_update', { action: 'forget', old_text: 'durian' }, SIG_A), call('fc-2', 'memory_update', { action: 'forget', old_text: 'mango' }, SIG_B)], [SIG_A, SIG_B]],
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-gemini-shape-'));
  try {
    const p = prov.PROVIDERS.gemini;
    createKeyStore({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8') }, dir, name: p.keyName, shape: p.keyShape }).write('AIza' + 'b'.repeat(35));
    const bodies = [];
    const fetchImpl = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null; bodies.push(body);
      if (body && body.messages.some((m) => m.role === 'tool')) return sse([delta({ role: 'assistant', content: 'Done, noted.' }), { id: 'g', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
      return geminiStream(calls);
    };
    const brain = createChatBrain({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8') }, dir, provider: p, fetchImpl, ownerAdmin: true, log: () => {} });
    const applied = [];
    const r = await brain.turnStream({ message: 'Call me Kei, not Ken', history: [] }, { memoryBlock: 'Notes the user asked you to remember:\n- The user is called Ken', memoryTool: { tool: { type: 'function', function: { name: 'memory_update', description: 'x', parameters: { type: 'object', properties: {} } } }, apply: async (a) => { applied.push(a); return { result: 'Done.' }; } } });
    if (r.live) await r.live.final;
    const second = bodies[1];
    const asst = second && second.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    const tools = second ? second.messages.filter((m) => m.role === 'tool') : [];
    ok(bodies.length === 2 && applied.length === calls.length && asst && asst.tool_calls.length === calls.length, `${label}: the second request carries every call the model made`, JSON.stringify(asst));
    ok(asst && asst.tool_calls.every((c, i) => (c.extra_content && c.extra_content.google ? c.extra_content.google.thought_signature : undefined) === expectSigs[i] && (expectSigs[i] !== undefined || c.extra_content === undefined)), `${label}: each echoed tool_call carries extra_content.google.thought_signature exactly as received (or none)`, JSON.stringify(asst && asst.tool_calls.map((c) => c.extra_content)));
    ok(asst && tools.length === calls.length && tools.every((m, i) => m.tool_call_id === asst.tool_calls[i].id && typeof m.content === 'string') && second.messages.indexOf(tools[0]) === second.messages.indexOf(asst) + 1, `${label}: each function result is a role:"tool" message with the call's id, right after the assistant turn`);
    ok(second && second.tool_choice === 'none' && second.messages[0].role === 'system', `${label}: the request keeps the system turn first and cannot call again`);
    ok(asst && asst.tool_calls.every((c) => c.type === 'function' && typeof c.function.arguments === 'string' && JSON.parse(c.function.arguments)), `${label}: arguments echo as JSON text`);
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

// 3. a provider that sends no extra_content (OpenRouter, Groq, Mistral ...): the echo is exactly the plain OpenAI shape, nothing added
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-gemini-shape-'));
  try {
    const p = prov.PROVIDERS.openrouter;
    const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s, 'utf8'), decryptString: (b) => Buffer.from(b).toString('utf8') };
    createKeyStore({ safeStorage, dir, name: p.keyName, shape: p.keyShape }).write('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789');
    const bodies = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      if (body.messages.some((m) => m.role === 'tool')) return sse([delta({ role: 'assistant', content: 'ok' }), '[DONE]']);
      return geminiStream([{ index: 0, ...call('c0', 'memory_update', { action: 'forget', old_text: 'durian' }) }]);
    };
    const brain = createChatBrain({ safeStorage, dir, provider: p, fetchImpl, ownerAdmin: true, log: () => {} });
    const r = await brain.turnStream({ message: 'forget durian', history: [] }, { memoryBlock: 'Notes the user asked you to remember:\n- Likes durian', memoryTool: { tool: { type: 'function', function: { name: 'memory_update', parameters: { type: 'object', properties: {} } } }, apply: async () => ({ result: 'Done.' }) } });
    if (r.live) await r.live.final;
    const asst = bodies[1] && bodies[1].messages.find((m) => m.tool_calls);
    ok(asst && !('extra_content' in asst.tool_calls[0]) && Object.keys(asst.tool_calls[0]).sort().join() === 'function,id,type', 'a provider with no extra_content gets the plain OpenAI tool_call shape (id, type, function)', JSON.stringify(asst));
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ } }
}

console.log(`\ncheck:gemini-tool-shape ${pass} passed, ${fail} failed (request shape only; UNVERIFIED against the live Gemini API)`);
if (fail) process.exitCode = 1;
