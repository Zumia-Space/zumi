// Forward guard for the public repo: no personal email in a commit's author, committer or trailer from now on.
// A commit whose address is not an allowed one fails with its sha and the field; the address itself is never printed, only a masked form.
//   node scripts/check-commit-emails.mjs                       commits in origin/main..HEAD (a PR, or a branch before you push)
//   node scripts/check-commit-emails.mjs --range <a..b>        any rev-list range (the pre-push hook passes remote..local)
//   node scripts/check-commit-emails.mjs --new-ref <sha>       a ref the remote lacks: every commit not on a remote-tracking ref
//   node scripts/check-commit-emails.mjs --release [--dry]     commits since the previous release tag (release-checks.mjs); --dry also
//                                                              passes in a tree with no git history (the maintainers' export rehearsal)
//   --baseline <sha>                                           override BASELINE (the check's own tests)
// Exit 0 clean, 1 a commit carries a disallowed address, 2 the check could not run (never a pass).
// Not covered: a bare address in a message body (only "<a@b>" counts), tag objects, and the GitHub web UI (use the account setting
// "Block command line pushes that expose my email" as well).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Owner decision 2026-11-27: history is NOT rewritten. Commits up to and including this sha (public main at that date) already carry
// addresses that were published; rewriting would move signed tags and break every clone. They are exempt by design; everything after is checked.
export const BASELINE = 'a8144d485e74c517bf78e3a8a21d39c535cfede1';

// GitHub noreply (with or without the numeric id), GitHub's own, Anthropic's co-author address, and the project's own domain.
const ALLOWED = [/^(\d+\+)?[a-z0-9-]+@users\.noreply\.github\.com$/i, /^noreply@github\.com$/i, /^noreply@anthropic\.com$/i, /^[^@\s]+@zumia\.space$/i];
export const isAllowed = (email) => ALLOWED.some((re) => re.test(email));
export const mask = (email) => { const at = email.lastIndexOf('@'); return `${email.slice(0, 1)}***@${email.slice(at + 1)}`; };

const ANGLE = /<([^<>\s]+@[^<>\s]+)>/g;
const TRAILER = /^[A-Za-z][\w-]*:\s/;

class ToolError extends Error {}
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) throw new ToolError(`git ${args[0]} failed: ${(r.stderr || String(r.error || '')).trim().split('\n')[0]}`);
  return r.stdout;
};
const gitOk = (cwd, args) => spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;

// revs: rev-list arguments. Returns { checked, findings: [{ sha, field, masked }] }.
export function checkRevs(cwd, revs, baseline = BASELINE) {
  const haveBaseline = gitOk(cwd, ['cat-file', '-e', `${baseline}^{commit}`]);
  // The baseline goes first: after a --not (as in --new-ref) a ^x or a second --not would make it a positive tip again.
  const raw = git(cwd, ['log', '--format=%H%x1f%ae%x1f%ce%x1f%B%x1e', ...(haveBaseline ? [`^${baseline}`] : []), ...revs]);
  const findings = [];
  let checked = 0;
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    checked++;
    const [sha, ae, ce, ...msg] = rec.trim().split('\x1f');
    const hit = (field, email) => { if (!isAllowed(email)) findings.push({ sha, field, masked: mask(email) }); };
    hit('author', ae);
    hit('committer', ce);
    for (const line of msg.join('\x1f').split('\n')) for (const m of line.matchAll(ANGLE)) hit(TRAILER.test(line) ? 'trailer' : 'message', m[1]);
  }
  return { checked, findings, haveBaseline };
}

// Which commits to read: a new ref, an explicit range, the release range, or (default) what origin/main lacks.
function pickRange(cwd, arg, release) {
  if (arg('--new-ref')) return { revs: [arg('--new-ref'), '--not', '--remotes'], label: `${arg('--new-ref').slice(0, 7)}, not on a remote-tracking ref` };
  if (arg('--range')) return { revs: [arg('--range')], label: arg('--range') };
  if (release) {
    // The previous release tag is the nearest v* ancestor of HEAD's parent, so a tagged HEAD is compared with the tag before it.
    const d = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^'], { cwd, encoding: 'utf8' });
    const prev = d.status === 0 ? d.stdout.trim() : '';
    return { revs: [prev ? `${prev}..HEAD` : 'HEAD'], label: prev ? `since ${prev}` : 'all reachable commits (no earlier release tag)' };
  }
  if (!gitOk(cwd, ['rev-parse', '--verify', '-q', 'origin/main'])) throw new ToolError('origin/main is not in this clone: fetch it, or pass --range');
  return { revs: ['origin/main..HEAD'], label: 'origin/main..HEAD' };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const cwd = process.cwd(); // the repo being checked: a hook runs at its root, CI and npm at the checkout root
  const baseline = arg('--baseline') || BASELINE;
  const release = args.includes('--release');
  try {
    if (!gitOk(cwd, ['rev-parse', '--git-dir'])) {
      if (release && args.includes('--dry')) { console.log('commit emails: no git history in this tree, nothing to read (rehearsal)'); return 0; }
      throw new ToolError('not a git checkout: the commit history cannot be read');
    }
    // A truncated history hides the release range: describe finds no earlier tag and the range collapses to the tip. Never a pass.
    if (release && git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') throw new ToolError('shallow clone: the release range cannot be read in full; check out with fetch-depth 0 (all history and tags)');
    const { revs, label } = pickRange(cwd, arg, release);
    const { checked, findings, haveBaseline } = checkRevs(cwd, revs, baseline);
    if (!haveBaseline) console.log('note: the baseline commit is not in this clone (shallow or unrelated history), so none of its history was exempted; only the commits in the range were read');
    if (findings.length) {
      for (const f of findings) console.log(`FAIL ${f.sha.slice(0, 7)} ${f.field} ${f.masked}`);
      console.log(`BLOCKED: ${findings.length} email(s) in ${new Set(findings.map((f) => f.sha)).size} commit(s) are not allowed (${label}).`);
      console.log('WHY: the public repo publishes author, committer and trailer emails.');
      console.log('DO: set user.email to your GitHub noreply address, then rewrite the listed commits (git commit --amend --reset-author, or an interactive rebase with --exec) and try again.');
      return 1;
    }
    console.log(`PASS commit emails: ${checked} commit${checked === 1 ? '' : 's'} checked (${label}), all author, committer and trailer addresses allowed`);
    return 0;
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    console.log(`Error: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
