// node scripts/check-commit-emails.test.mjs : the commit-email guard bites on a non-noreply author, committer and trailer, passes the
// allowed addresses, exempts the baseline history, and never prints a full address. Throw-away repos, FAKE addresses (example.com) only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowed, mask } from './check-commit-emails.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-commit-emails.mjs');
const NOREPLY = '1+tester@users.noreply.github.com';
const PROJECT = 'hello@zumia.space';
const BAD = 'someone@example.com';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-commit-emails-'));
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
const commit = (author, committer, msg, dir = repo) => {
  const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', msg], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: committer } });
  assert.equal(r.status, 0, r.stderr);
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
};
const run = (...args) => runIn(repo, ...args);
function runIn(dir, ...args) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' }); }
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

// ---------- review round 2: B1 (a truncated range is never a pass) and B2 (--new-ref keeps the baseline excluded) ----------
const fresh = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zumi-commit-emails-${name}-`));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
};
const gitIn = (dir, ...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });

test('B1: a depth-1 clone at the release tag exits 2 with a reason, with and without --dry; a full clone with a bad commit in range exits 1', () => {
  const src = fresh('rel');
  commit(NOREPLY, NOREPLY, 'base', src); gitIn(src, 'tag', 'v1.0.0');
  commit(BAD, NOREPLY, 'bad inside the release range', src);
  commit(NOREPLY, NOREPLY, 'clean tip', src); gitIn(src, 'tag', 'v1.0.1');
  const url = pathToFileURL(src).href;
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-commit-emails-shallow-'));
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'zumi-commit-emails-full-'));
  assert.equal(spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', 'v1.0.1', url, shallow]).status, 0);
  assert.equal(spawnSync('git', ['clone', '-q', '--branch', 'v1.0.1', url, full]).status, 0);
  for (const extra of [[], ['--dry']]) {
    const r = runIn(shallow, '--release', ...extra);
    assert.equal(r.status, 2, out(r));
    assert.match(out(r), /Error: .*shallow/);
    assert.ok(!/PASS/.test(out(r)), out(r));
  }
  const f = runIn(full, '--release');
  assert.equal(f.status, 1, out(f));
  assert.match(out(f), /since v1.0.0/);
  assert.ok(!out(f).includes('someone'));
  for (const d of [src, shallow, full]) fs.rmSync(d, { recursive: true, force: true });
});

test('B2: --new-ref with no remote-tracking refs excludes the baseline: exempt history passes, one bad new commit fails', () => {
  const dir = fresh('newref');
  const old = commit(BAD, BAD, 'exempt history', dir);
  commit(NOREPLY, NOREPLY, 'clean new commit', dir);
  const ok = runIn(dir, '--new-ref', 'HEAD', '--baseline', old);
  assert.equal(ok.status, 0, out(ok));
  assert.match(out(ok), /1 commit checked/);
  const bad = commit(BAD, NOREPLY, 'bad new commit', dir);
  const r = runIn(dir, '--new-ref', 'HEAD', '--baseline', old);
  assert.equal(r.status, 1, out(r));
  assert.ok(out(r).includes(`${bad.slice(0, 7)} author`), out(r));
  assert.ok(!out(r).includes(old.slice(0, 7)), 'the exempt commit was reported');
  // with a remote-tracking ref in place the answer is the same
  gitIn(dir, 'update-ref', 'refs/remotes/origin/main', old);
  assert.equal(runIn(dir, '--new-ref', 'HEAD', '--baseline', old).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allow rule: the end anchor and the start anchor both hold', () => {
  for (const bad of ['evil@example.com@zumia.space', 'x@zumia.space' + String.fromCharCode(10), ' x@zumia.space', 'x@evil.example' + String.fromCharCode(10) + 'noreply@github.com']) assert.ok(!isAllowed(bad), JSON.stringify(bad));
});

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));
