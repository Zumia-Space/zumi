// node scripts/check-commit-emails.test.mjs : the commit-email guard bites on a non-noreply author, committer and trailer, passes the
// allowed addresses, exempts the baseline history, and never prints a full address. Throw-away repos, FAKE addresses (example.com) only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowed, mask } from './check-commit-emails.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-commit-emails.mjs');
const NOREPLY = '1+tester@users.noreply.github.com';
const PROJECT = 'hello@zumia.space';
const BAD = 'someone@example.com';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-commit-emails-'));
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
const commit = (author, committer, msg) => {
  const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: committer } });
  assert.equal(r.status, 0, r.stderr);
  return git('rev-parse', 'HEAD').stdout.trim();
};
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;

git('init', '-q', '-b', 'main');
// An old commit by a bad address: the baseline sits on it, so it is exempt by design.
const OLD = commit(BAD, BAD, 'old history');
const BASE = ['--baseline', OLD];

test('mask keeps the first letter and the domain, nothing else', () => {
  assert.equal(mask('someone@example.com'), 's***@example.com');
  assert.ok(!mask('someone@example.com').includes('someone'));
});

test('allow rule: GitHub noreply, project domain, anthropic noreply pass; others do not', () => {
  for (const ok of [NOREPLY, 'tester@users.noreply.github.com', 'noreply@github.com', 'noreply@anthropic.com', PROJECT, 'Hello@Zumia.Space']) assert.ok(isAllowed(ok), ok);
  for (const bad of [BAD, 'a@zumia.space.example.com', 'a@evilzumia.space', 'x@users.noreply.github.com.example.com', 'noreply@github.com.example.com']) assert.ok(!isAllowed(bad), bad);
});

test('noreply and project-domain commits pass', () => {
  const first = commit(NOREPLY, 'noreply@github.com', 'clean one');
  commit(PROJECT, NOREPLY, `clean two\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
  const r = run('--range', `${OLD}..HEAD`, ...BASE);
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /2 commits checked/);
  assert.ok(first);
});

test('baseline commits are ignored even when the range covers them', () => {
  const r = run('--range', 'HEAD', ...BASE);
  assert.equal(r.status, 0, out(r));
  assert.match(out(r), /2 commits checked/);
});

for (const [name, author, committer, msg, field] of [
  ['bad author', BAD, NOREPLY, 'bad author', 'author'],
  ['bad committer', NOREPLY, BAD, 'bad committer', 'committer'],
  ['bad trailer', NOREPLY, NOREPLY, `bad trailer\n\nCo-Authored-By: X <${BAD}>`, 'trailer'],
  ['bad address in the message body', NOREPLY, NOREPLY, `body\n\nsee <${BAD}> for more`, 'message'],
]) {
  test(`${name} fails, names sha and field, never prints the address`, () => {
    const sha = commit(author, committer, msg);
    const r = run('--range', `HEAD~1..HEAD`, ...BASE);
    assert.equal(r.status, 1, out(r));
    assert.ok(out(r).includes(`${sha.slice(0, 7)} ${field}`), out(r));
    assert.ok(out(r).includes('s***@example.com'), out(r));
    assert.ok(!out(r).includes('someone'), 'the full address leaked');
    git('reset', '-q', '--hard', 'HEAD~1');
  });
}

test('default range is origin/main..HEAD; a missing origin/main is an error, not a pass', () => {
  const r = run(...BASE);
  assert.equal(r.status, 2, out(r));
});

test('--new-ref checks every commit not on a remote-tracking ref', () => {
  commit(BAD, NOREPLY, 'new ref bad');
  const r = run('--new-ref', 'HEAD', ...BASE);
  assert.equal(r.status, 1, out(r));
  assert.ok(!out(r).includes('someone'));
  git('reset', '-q', '--hard', 'HEAD~1');
});

test('release mode: range starts at the previous release tag, the tagged commit itself is checked', () => {
  git('tag', 'v0.0.1');
  commit(BAD, NOREPLY, 'bad after the tag');
  git('tag', 'v0.0.2');
  const bad = run('--release', ...BASE);
  assert.equal(bad.status, 1, out(bad));
  assert.match(out(bad), /since v0\.0\.1/);
  git('tag', '-d', 'v0.0.2');
  git('reset', '-q', '--hard', 'v0.0.1');
  commit(NOREPLY, NOREPLY, 'good after the tag');
  git('tag', 'v0.0.2');
  const good = run('--release', ...BASE);
  assert.equal(good.status, 0, out(good));
});

test('release mode with an old bad commit before the previous tag still passes (not in range)', () => {
  const r = run('--release');
  // no --baseline: the real baseline is absent in this repo, so nothing is exempted; the old bad commit is before v0.0.1 and out of range
  assert.equal(r.status, 0, out(r));
});

test('outside a git checkout: fails, except in --dry (the maintainers\' export rehearsal)', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-commit-emails-nogit-'));
  const at = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: bare, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(bare) } });
  assert.equal(at('--release').status, 2);
  assert.equal(at('--release', '--dry').status, 0);
  fs.rmSync(bare, { recursive: true, force: true });
});

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));
