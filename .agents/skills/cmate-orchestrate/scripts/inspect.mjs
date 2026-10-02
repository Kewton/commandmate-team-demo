#!/usr/bin/env node
// cmate-orchestrate — read-only inspection runner (Node stdlib only, Node >= 22).
//
// Issue #217.
//
// The planner's input is the issue's number / title / body / labels and nothing
// else: it never opens the target repository (references/profile-contract.md
// §9.1). That is a design invariant and this runner does not touch it. What it
// closes is the hole the invariant leaves open — nothing on the way to dispatch
// ever checks whether the FACTS THE BODY ASSERTS are still true.
//
// Measured in Kewton/CommandMate#1831 (Kewton/BorderFreeKidsMap): 16 issues of
// one epic dispatched in a day, and 11 of the 16 had a body the tree had moved
// out from under. `repository.ts` was written as 1,070 lines and measured 1,129;
// five `path:line` citations in one body were all off (`:979` → `:1038`); an
// acceptance criterion said "the e2e suite still has 130 tests" when it had 136,
// so satisfying the issue AS WRITTEN meant deleting the six an earlier issue had
// added. The workaround was a human collating sixteen bodies by hand.
//
// So: a separate runner, with `profile-init.mjs --check`'s discipline
// (references/profile-contract.md §9.7) —
//
//   IT WRITES NOTHING into the plan and nothing into the repository. `--out`
//   writes the report where the operator names it, and refuses to clobber.
//
//   IT DOES NOT ADJUDICATE. Every finding is a warning, `status` becomes
//   `partial`, and the exit stays 0. A body that is out of date is not a body
//   that must not be dispatched — a human reads the report and decides.
//
//   IT REFUSES WHAT IT CANNOT READ. A missing `--repo-root`, an unreadable
//   issue fixture and a `--ref` git will not resolve stop the run instead of
//   producing an inspection over a subset nobody chose. "We checked" and "we
//   could not look" must not come back in the same envelope.
//
// It is NOT `profile-init.mjs --check`, on purpose: that mode holds "no
// subprocess, no network" as a property (§9.7), and `--ref` here shells out to
// `git show`. Bolting this onto it would quietly retire that property.
//
// ---- The second mode: --evaluate-gates (Issue #218) -------------------------
//
// `cmate-worker-development` makes the IMPLEMENTATION measure twice — green in
// the fitting state, red in a mutated one (references/work-discipline.md:20-24).
// Nobody did the same to the ACCEPTANCE CONDITION itself. A condition is a gate
// only if it FAILS before the work and PASSES after it, and that property was
// never checked anywhere on the way to dispatch: dispatch resolves a `require:`
// id against the worktree's verify.yaml and stops there (dispatch-contract.md
// §2.9), and the only base-side execution is the non-contract fallback, which
// runs AFTER the worker is done.
//
// Measured in CommandMate#1832 (Kewton/BorderFreeKidsMap): one orchestrator
// wrote three unusable acceptance conditions in a day and none of them was
// stopped. "under 100ms for 2,000 candidates" was already 0.4ms on the O(n²)
// code the issue existed to replace — green whether or not anyone fixed it.
// "the output's sha256 matches the pre-work one" ran over output containing
// `判定時刻 : <ISO8601>`, so it could not agree with itself twice.
// "`wc -l` ≤ 860" was a ceiling nobody measured before naming, and the work
// landed at 993.
//
// EVERY ONE of them is visible from running the gate once at the base — twice
// when the question is determinism. So this mode does exactly that, and sorts
// each gate into four outcomes: `already_satisfied` (the condition is not a
// gate; warning), `failing_at_base` (what a gate is supposed to look like;
// recorded and nothing more), `nondeterministic` (warning), and
// `not_evaluable` — which is a NOTICE and is the reason the fourth exists at
// all: "we could not measure it" must not be rounded to "it passed" or to
// "it failed".
//
// Two rules it does not get to bend:
//
//   ONLY DECLARED GATES RUN. The commands come from the issue's
//   ```acceptance-gates block, read with the planner's own parser. Prose
//   acceptance criteria are NOT turned into commands —
//   references/acceptance-gates-notation.md §5 refuses that on four grounds and
//   this mode does not reopen it. A runner that executed a command it inferred
//   from a sentence would be running something nobody approved.
//
//   NOTHING REACHES THE PLAN. The result lives in this runner's artifact. The
//   plan stays a pure function of the issue body and the profile, and
//   `acceptance_criteria` stays `string[]`.
//
// ---- What it can and cannot decide ------------------------------------------
//
// Only claims a machine can settle: does the file exist, does the line exist,
// is the identifier still on that line, is the line count still that number.
// A body that CONTRADICTS ITSELF in prose — a 決定事項 that the 受入条件 then
// rules out — is not in scope and never will be; that reading is
// cmate-issue-refinement Step 4's, and a runner that pretended to do it would
// be inventing a verdict. The one contradiction reported here is the mechanical
// subset: two different line counts for the same path, or one `path:line`
// bound to two different identifiers.
//
// Spelling variants (`web/src/lib/filter.ts` vs `src/lib/filter.ts`) are the
// planner's `ambiguous_file_candidate` (plan-contract.md §5.4) and are not
// re-detected here. Such a candidate is NOT inspected — at most one of the two
// spellings is the file the author means, and the runner does not get to choose
// — and the count of what it skipped is in the report.

import { parseArgs } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  redact,
  readVerifyConfigGates,
  VERIFY_CONFIG_RELATIVE,
} from './lib.mjs';

// The planner's own reading of a body, imported rather than copied. A citation
// the planner does not turn into a candidate is a citation the plan never
// carried, so checking one would be reporting about a different document than
// the one that was planned (see the export block at the end of orchestrate.mjs).
import {
  extractFileCandidates,
  loadIssuesFromFixture,
  fetchIssueWithGh,
  readIssueAcceptanceGates,
  FILE_EXT,
  PATH_START,
  CANDIDATE_BACKTICK,
  CANDIDATE_KNOWN_ROOT,
  CANDIDATE_WITH_EXT,
} from './orchestrate.mjs';

const INSPECT_SCHEMA_VERSION = 1;

// Two runs, because the failure this mode exists to catch includes a gate whose
// verdict changes between runs, and one run cannot see it. Bounded above because
// each repeat is a full execution of somebody's test suite.
const DEFAULT_GATE_REPEAT = 2;
const MAX_GATE_REPEAT = 10;

// CommandMate's own DEFAULT_TIMEOUT_SEC, which is what a gate that declares no
// `timeoutSec` gets when `commandmate verify` runs it. Transcribed rather than
// invented so a gate that times out here is a gate that would time out there.
const DEFAULT_GATE_TIMEOUT_SEC = 600;

// The ids a contract's `verify.gates` may name without them appearing in
// verify.yaml — the same set dispatch resolves against (dispatch.mjs
// CONTRACT_BUILT_IN_GATE_IDS). They are gates CommandMate itself judges, so
// there is no command here to run: `require: [work-evidence]` is a resolvable id
// and an unmeasurable one, and those are two different sentences.
const BUILT_IN_GATE_IDS = ['work-evidence', 'scope'];

const USAGE = `cmate-orchestrate inspection runner (read-only, never adjudicates)

Usage:
  inspect.mjs --check-references [--repo-root <path>] [--ref <rev>] <issue>...
  inspect.mjs --check-references [--repo-root <path>] --issue-json <path>
  inspect.mjs --evaluate-gates [--repo-root <path>] [--repeat <n>] <issue>...

Options:
  --check-references     Check the path:line and "N 行" claims an issue body
                         makes against the tree under --repo-root.
  --evaluate-gates       Run the gates the issue's acceptance-gates block
                         DECLARES against --repo-root, before anyone works on
                         it, and say which ones already pass, which ones are
                         nondeterministic and which ones could not be measured.
                         Nothing is derived from prose. --repo-root must be a
                         clean git checkout: this mode runs commands.
  --repeat <n>           How many times to run each gate (--evaluate-gates
                         only). Default: 2 — one run cannot see a gate whose
                         verdict changes between runs.
  --base <rev>           The revision --repo-root is supposed to be sitting on
                         (--evaluate-gates only). If HEAD is something else,
                         every gate is not_evaluable and none of them runs.
  --repo-root <path>     The checkout to check against. Default: cwd.
  --ref <rev>            Read the files out of this git revision instead of the
                         working tree (--check-references only). Resolved with
                         git rev-parse first.
  --issues <n>[,<n>]     Issue numbers (repeatable). Bare numbers work too.
  --issue-json <path>    Issue fixture, same format as orchestrate.mjs
                         (plan-contract.md §1.1). No GitHub access. Without
                         --issues, every issue in the fixture is inspected.
  --repo <owner/name>    Repository to read issues from when there is no
                         fixture. Default: the origin remote of --repo-root.
  --out <path>           Write the report here as well as to stdout. Refuses an
                         existing path.
  -h, --help             This text.

Findings are warnings: status becomes partial and the exit stays 0 (a
not_evaluable notice does not move the status — it is not a finding about the
gate, it is the absence of one). Input this runner cannot read is refused
(exit 3 / 4 / 6) and nothing is inspected.`;

// =============================================================================
// Input
// =============================================================================

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'check-references': { type: 'boolean' },
        'evaluate-gates': { type: 'boolean' },
        'repo-root': { type: 'string' },
        repeat: { type: 'string' },
        base: { type: 'string' },
        ref: { type: 'string' },
        issues: { type: 'string', multiple: true },
        'issue-json': { type: 'string' },
        repo: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', redact(error.message), 3);
  }
}

// Issue numbers arrive as positionals (`inspect.mjs --check-references 231 234`)
// and as --issues values, which may be repeated or comma-separated. All three
// spellings appear in the Issue that asked for this runner, so all three are
// read; anything that is not an integer is refused rather than coerced, for the
// reason plan-contract.md §1.1 gives — a mistyped number that is READ plans, or
// here inspects, a DIFFERENT issue.
function issueNumbers(parsed) {
  const raw = [...parsed.positionals, ...(parsed.values.issues ?? [])]
    .flatMap((value) => String(value).split(/[\s,]+/))
    .filter((value) => value !== '');
  const numbers = [];
  for (const token of raw) {
    if (!/^[0-9]+$/.test(token)) {
      throw new SkillError('invalid_input', `issue number is not an integer: ${redact(token)}`, 3);
    }
    const number = Number(token);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new SkillError('invalid_input', `issue number is out of range: ${redact(token)}`, 3);
    }
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function resolveInputs(parsed) {
  const values = parsed.values;

  // The mode is required rather than defaulted, and exactly one of them is
  // allowed. A default mode would make "which check did I just run" a function
  // of the version installed; two modes at once would make it a function of
  // argument order, and the two do very different things — one reads files, the
  // other EXECUTES the commands an issue declared.
  const modes = [];
  if (values['check-references'] === true) modes.push('check-references');
  if (values['evaluate-gates'] === true) modes.push('evaluate-gates');
  if (modes.length === 0) {
    throw new SkillError(
      'invalid_input',
      'no inspection was requested. Pass --check-references (the body\'s path:line and "N 行" claims against the tree) '
        + 'or --evaluate-gates (the acceptance gates the body declares, run against the base)',
      3,
    );
  }
  if (modes.length > 1) {
    throw new SkillError(
      'invalid_input',
      'pass one mode, not both. --check-references only reads files; --evaluate-gates runs the commands the issue declared. '
        + 'One report that mixed them could not say which of the two produced a finding',
      3,
    );
  }
  const mode = modes[0];

  const repoRootArg = values['repo-root'] ?? process.cwd();
  if (String(repoRootArg).trim() === '') {
    throw new SkillError('invalid_input', '--repo-root must name a directory', 3);
  }
  const repoRoot = resolve(String(repoRootArg));
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    // Refused, not defaulted to cwd: an inspection run against the wrong tree
    // reports mismatches that say nothing about the issue.
    throw new SkillError('load_error', `no directory at --repo-root ${redact(repoRoot)}`, 6);
  }

  const ref = values.ref === undefined ? null : String(values.ref);
  if (ref !== null && (ref.trim() === '' || ref.startsWith('-'))) {
    throw new SkillError('invalid_input', `--ref is not a revision: ${redact(ref)}`, 3);
  }
  // `--ref` reads blobs out of git; `--evaluate-gates` runs commands in a
  // checkout. There is no honest way to combine them — a gate evaluated at a
  // revision that is not checked out would be running against the files on
  // disk while claiming the revision's name.
  if (ref !== null && mode !== 'check-references') {
    throw new SkillError(
      'invalid_input',
      '--ref belongs to --check-references. A gate runs against the files that are actually in the checkout, '
        + 'so --evaluate-gates reads HEAD of --repo-root; use --base to state which revision that is meant to be',
      3,
    );
  }

  // How many times each gate is run. Two by default, because ONE run cannot
  // distinguish a gate from a coin: the `nondeterministic` outcome does not
  // exist below two. `--repeat 1` is allowed and the report says what it gave
  // up, rather than being silently the same answer as `--repeat 2`.
  let repeat = DEFAULT_GATE_REPEAT;
  if (values.repeat !== undefined) {
    if (mode !== 'evaluate-gates') {
      throw new SkillError('invalid_input', '--repeat belongs to --evaluate-gates; --check-references reads files and reads them once', 3);
    }
    const raw = String(values.repeat).trim();
    if (!/^[0-9]+$/.test(raw)) {
      throw new SkillError('invalid_input', `--repeat is not a positive integer: ${redact(String(values.repeat))}`, 3);
    }
    repeat = Number(raw);
    if (repeat < 1 || repeat > MAX_GATE_REPEAT) {
      throw new SkillError('invalid_input', `--repeat ${repeat} is outside 1..${MAX_GATE_REPEAT}`, 3);
    }
  }

  const base = values.base === undefined ? null : String(values.base);
  if (base !== null) {
    if (mode !== 'evaluate-gates') {
      throw new SkillError('invalid_input', '--base belongs to --evaluate-gates; --check-references states the revision it read with --ref', 3);
    }
    if (base.trim() === '' || base.startsWith('-')) {
      throw new SkillError('invalid_input', `--base is not a revision: ${redact(base)}`, 3);
    }
  }

  const issueJson = values['issue-json'] ?? null;
  if (issueJson !== null && String(issueJson).trim() === '') {
    throw new SkillError('invalid_input', '--issue-json must name a JSON file', 3);
  }

  const out = values.out ?? null;
  if (out !== null) {
    if (String(out).trim() === '') {
      throw new SkillError('invalid_input', '--out must name a file', 3);
    }
    if (existsSync(out)) {
      throw new SkillError('out_exists', `--out ${redact(out)} already exists; this runner does not overwrite`, 4);
    }
  }

  const numbers = issueNumbers(parsed);
  if (numbers.length === 0 && issueJson === null) {
    throw new SkillError(
      'invalid_input',
      'no issue was named. Pass issue numbers, or --issue-json to inspect every issue in a fixture',
      3,
    );
  }

  return {
    mode,
    repoRoot,
    ref,
    repeat,
    base,
    issueJson: issueJson === null ? null : String(issueJson),
    repo: values.repo ?? null,
    out,
    numbers,
  };
}

// =============================================================================
// The issues
// =============================================================================

// Which issues a fixture declares, so `--issue-json` without `--issues` can
// inspect all of them. Anything unreadable is left for loadIssuesFromFixture to
// refuse — it owns what a fixture IS (plan-contract.md §1.1), and a second
// opinion here would be a second set of messages to keep in step.
function fixtureIssueNumbers(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    loadIssuesFromFixture([], path);
    return [];
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.issues) ? raw.issues : null;
  if (items === null) {
    loadIssuesFromFixture([], path);
    return [];
  }
  const numbers = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item.number;
    if (typeof value === 'number' && Number.isSafeInteger(value)) numbers.push(value);
    else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) numbers.push(Number(value));
  }
  return numbers;
}

const ORIGIN_SLUG_RE = /(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\s*$/;

function originSlug(repoRoot) {
  try {
    const url = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const matched = ORIGIN_SLUG_RE.exec(url);
    return matched === null ? null : matched[1];
  } catch {
    return null;
  }
}

function loadIssues(inputs) {
  if (inputs.issueJson !== null) {
    const numbers = inputs.numbers.length > 0 ? inputs.numbers : fixtureIssueNumbers(inputs.issueJson);
    if (numbers.length === 0) {
      throw new SkillError('load_error', `--issue-json ${redact(inputs.issueJson)} declares no issues`, 6);
    }
    return loadIssuesFromFixture(numbers, inputs.issueJson);
  }
  const repo = inputs.repo ?? originSlug(inputs.repoRoot);
  if (repo === null) {
    throw new SkillError(
      'invalid_input',
      'no repository to read issues from: pass --repo <owner/name>, or --issue-json to run offline',
      3,
    );
  }
  return inputs.numbers.map((number) => fetchIssueWithGh(number, repo));
}

// =============================================================================
// The tree
// =============================================================================

// `git rev-parse` is what decides whether a revision exists, so it is what is
// asked. A `--ref` it cannot resolve is refused: reading the working tree
// instead would report the wrong tree's line numbers under the operator's ref.
function resolveRef(repoRoot, ref) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new SkillError(
      'load_error',
      `--ref ${redact(ref)} does not resolve to a commit in ${redact(repoRoot)}`,
      6,
    );
  }
}

// Recorded, never required: with no --ref the working tree is what was read, and
// the report says which commit it was sitting on so a reader can reproduce it.
// A --repo-root that is not a git repository at all is still inspectable.
function headOf(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// `wc -l` counts newline CHARACTERS, so a file whose last line has no newline
// comes back one short of what an editor shows and one short of what an author
// counts when they write "N 行". The measure here is the number of ADDRESSABLE
// lines: the same as `wc -l` for a newline-terminated file, one more for a file
// without a trailing newline, and 0 for an empty one. Fixed here because a line
// count that is right or wrong by convention is a warning nobody can act on.
function countLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

// Reads one repository-relative path, at the ref if there is one, and caches the
// answer: a body cites the same file five times and the fifth read must not be a
// fifth subprocess.
function makeFileReader(repoRoot, ref) {
  const cache = new Map();
  const root = resolve(repoRoot);
  const read = (path) => {
    if (ref !== null) {
      let kind;
      try {
        kind = execFileSync('git', ['-C', root, 'cat-file', '-t', `${ref}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return { exists: false, text: null, lines: 0 };
      }
      if (kind !== 'blob') return { exists: false, text: null, lines: 0 };
      const text = execFileSync('git', ['-C', root, 'show', `${ref}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { exists: true, text, lines: countLines(text) };
    }
    // The candidate already passed the planner's isSafeRepoPath, which refuses
    // "..", a leading "/" and a drive letter. Re-checked against the resolved
    // path anyway: this is the line that says "nothing outside --repo-root is
    // read", and it should be true because it is enforced, not because an
    // earlier function is believed.
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep)) return { exists: false, text: null, lines: 0 };
    if (!existsSync(full) || !statSync(full).isFile()) return { exists: false, text: null, lines: 0 };
    const text = readFileSync(full, 'utf8');
    return { exists: true, text, lines: countLines(text) };
  };
  return (path) => {
    if (!cache.has(path)) cache.set(path, read(path));
    return cache.get(path);
  };
}

// =============================================================================
// Reading the claims out of a body
// =============================================================================

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Everything the three planner patterns matched, minus what the extraction
// kept. What is left was refused by isSafeRepoPath — a "..", an absolute path,
// a system root, a URL host — and the report names it rather than staying
// silent, because "we did not inspect that citation" is a fact about the run.
// The patterns are the planner's own sources, so this cannot drift into a
// second candidate vocabulary.
const CANDIDATE_PATTERNS = [CANDIDATE_BACKTICK, CANDIDATE_KNOWN_ROOT, CANDIDATE_WITH_EXT];

function droppedCandidates(text, kept) {
  const seen = new Set(kept);
  const dropped = [];
  for (const source of CANDIDATE_PATTERNS) {
    for (const match of text.matchAll(new RegExp(source, 'g'))) {
      const candidate = match[1].trim();
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      dropped.push(candidate);
    }
  }
  return dropped;
}

// A backtick token on the same line as the citation, which is how a body says
// what it expects to find AT that line ("`resolveLauncher` — lib.mjs:309").
// Restricted to identifier shapes, and a token that ends in one of the
// planner's own file extensions is not one: `filter.ts` next to
// `src/lib/filter.ts:42` is the path again, and searching a file for its own
// name would report every citation as moved.
const BACKTICK_SPAN = /`([^`]+)`/g;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const FILE_LIKE_TOKEN_RE = new RegExp(`\\.(?:${FILE_EXT})$`, 'i');

function identifierOn(line) {
  for (const match of line.matchAll(BACKTICK_SPAN)) {
    const token = match[1].trim().replace(/\(\)$/, '');
    if (!IDENTIFIER_RE.test(token)) continue;
    if (FILE_LIKE_TOKEN_RE.test(token)) continue;
    return token;
  }
  return null;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let at = 0; at < index; at += 1) if (text[at] === '\n') line += 1;
  return line;
}

// `<path>:N` and `<path>:N-M`, anchored with the planner's own PATH_START so a
// candidate that is a suffix of another one cannot match from the middle of it.
function citationsOf(body, path) {
  const pattern = new RegExp(`${PATH_START}${escapeForRegExp(path)}:([0-9]+)(?:-([0-9]+))?`, 'g');
  const found = [];
  const lines = body.split('\n');
  for (const match of body.matchAll(pattern)) {
    const at = lineNumberAt(body, match.index);
    found.push({
      path,
      line: Number(match[1]),
      line_end: match[2] === undefined ? null : Number(match[2]),
      body_line: at,
      identifier: identifierOn(lines[at - 1] ?? ''),
    });
  }
  return found;
}

// `<path>（N 行）` / `<path> N 行` / `<path> は N 行`, with the closing backtick
// of a quoted path and a thousands separator both allowed, because that is how
// the bodies this runner exists for are actually written (`repository.ts` は
// 1,070 行). Nothing looser: a number that is not adjacent to the path is a
// number about something else.
const LINE_CLAIM_TAIL = '`?\\s*(?:は|が)?\\s*[（(]?\\s*([0-9][0-9,]*)\\s*行';

function lineClaimsOf(body, path) {
  const pattern = new RegExp(`${PATH_START}${escapeForRegExp(path)}${LINE_CLAIM_TAIL}`, 'g');
  const claims = [];
  for (const match of body.matchAll(pattern)) {
    claims.push({ path, claimed: Number(match[1].replace(/,/g, '')), body_line: lineNumberAt(body, match.index) });
  }
  return claims;
}

// =============================================================================
// The inspection
// =============================================================================

function warn(warnings, code, issue, detail, extra = {}) {
  warnings.push({ code, issue, detail, ...extra });
}

function inspectIssue(issue, readFile, warnings) {
  const body = issue.body ?? '';
  const extraction = extractFileCandidates(body);
  // Both spellings of a shadowed pair are skipped. The planner asks the author
  // which one it is (`ambiguous_file_candidate`); this runner cannot ask, and
  // picking one would produce a finding about a file the issue may not mean.
  const ambiguous = new Set();
  for (const pair of extraction.shadowed) {
    ambiguous.add(pair.path);
    ambiguous.add(pair.covered_by);
  }
  const dropped = droppedCandidates(body, extraction.paths);
  const inspectable = extraction.paths.filter((path) => !ambiguous.has(path));

  const references = [];
  const lineClaims = [];
  // path -> the distinct line counts the body claims for it; `path:line` -> the
  // distinct identifiers it binds. Both are the mechanical half of "the body
  // disagrees with itself" (§3 of the Issue); the semantic half is not here.
  const claimedByPath = new Map();
  const identifiersByCitation = new Map();

  for (const path of inspectable) {
    const file = readFile(path);
    for (const citation of citationsOf(body, path)) {
      const key = `${path}:${citation.line}`;
      if (citation.identifier !== null) {
        if (!identifiersByCitation.has(key)) identifiersByCitation.set(key, new Set());
        identifiersByCitation.get(key).add(citation.identifier);
      }
      references.push({ ...citation, file });
    }
    for (const claim of lineClaimsOf(body, path)) {
      if (!claimedByPath.has(path)) claimedByPath.set(path, []);
      if (!claimedByPath.get(path).includes(claim.claimed)) claimedByPath.get(path).push(claim.claimed);
      lineClaims.push({ ...claim, file });
    }
  }

  const reported = [];
  for (const reference of references) {
    const { path, line, line_end: lineEnd, identifier, body_line: bodyLine, file } = reference;
    const entry = {
      path,
      line,
      line_end: lineEnd,
      identifier,
      body_line: bodyLine,
      measured_lines: file.exists ? file.lines : null,
      found_at: null,
      verdict: 'ok',
    };
    if (!file.exists) {
      entry.verdict = 'file_missing';
      warn(warnings, 'reference_file_missing', issue.number, `${path}:${line} — 本文が引く file が対象 tree に無い`, { path, line });
    } else if (Math.max(line, lineEnd ?? line) > file.lines) {
      entry.verdict = 'line_out_of_range';
      warn(
        warnings,
        'reference_line_out_of_range',
        issue.number,
        `${path}:${lineEnd === null ? line : `${line}-${lineEnd}`} — 実測 ${file.lines} 行しか無い`,
        { path, line, line_end: lineEnd, measured: file.lines },
      );
    } else if (identifier !== null) {
      const lines = file.text.split('\n');
      const from = line - 1;
      const to = (lineEnd ?? line) - 1;
      let onCitedLine = false;
      for (let at = from; at <= to && !onCitedLine; at += 1) {
        if ((lines[at] ?? '').includes(identifier)) onCitedLine = true;
      }
      if (onCitedLine) {
        entry.verdict = 'ok';
      } else {
        const foundAt = lines.findIndex((text) => text.includes(identifier));
        if (foundAt === -1) {
          // The identifier is nowhere in the file, so the premise that it IS an
          // identifier of this file is what failed — not the line number. A
          // "moved" warning here would be a verdict on a word in prose, which
          // is the adjudication this runner does not do. Counted, not warned.
          entry.verdict = 'identifier_absent';
        } else {
          entry.verdict = 'identifier_moved';
          entry.found_at = foundAt + 1;
          warn(
            warnings,
            'reference_identifier_moved',
            issue.number,
            `${path}:${line} — \`${identifier}\` は実測 ${foundAt + 1} 行目にある`,
            { path, line, identifier, found_at: foundAt + 1 },
          );
        }
      }
    } else {
      // A citation with no identifier beside it is a line number and nothing to
      // check it against. The file and the range were checked; the report says
      // so rather than counting it as agreement.
      entry.verdict = 'unchecked';
    }
    reported.push(entry);
  }

  const reportedClaims = [];
  const inconsistentPaths = new Set(
    [...claimedByPath.entries()].filter(([, values]) => values.length > 1).map(([path]) => path),
  );
  const claimWarned = new Set();
  for (const claim of lineClaims) {
    const { path, claimed, body_line: bodyLine, file } = claim;
    const entry = {
      path,
      claimed,
      measured: file.exists ? file.lines : null,
      body_line: bodyLine,
      verdict: 'ok',
    };
    if (inconsistentPaths.has(path)) {
      // Two different counts for one path: which of them the author meant is not
      // decidable here, so the stale-count warning is NOT also raised. The
      // measurement is carried in this warning's detail — it is the same next
      // action either way (reconcile the body against the file).
      entry.verdict = 'inconsistent';
      if (!claimWarned.has(path)) {
        claimWarned.add(path);
        warn(
          warnings,
          'reference_claim_inconsistent',
          issue.number,
          `${path} — 本文が ${claimedByPath.get(path).join(' 行 / ')} 行と2通り主張している` +
            `（実測 ${file.exists ? `${file.lines} 行` : 'file 無し'}）`,
          { path, claimed: claimedByPath.get(path), measured: file.exists ? file.lines : null },
        );
      }
    } else if (!file.exists) {
      entry.verdict = 'file_missing';
      warn(warnings, 'reference_file_missing', issue.number, `${path} — 行数を主張している file が対象 tree に無い`, { path });
    } else if (claimed !== file.lines) {
      entry.verdict = 'stale';
      warn(
        warnings,
        'reference_line_count_stale',
        issue.number,
        `${path} — 本文は ${claimed} 行、実測は ${file.lines} 行`,
        { path, claimed, measured: file.lines },
      );
    }
    reportedClaims.push(entry);
  }

  for (const [key, identifiers] of identifiersByCitation) {
    if (identifiers.size < 2) continue;
    const [path, line] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    warn(
      warnings,
      'reference_claim_inconsistent',
      issue.number,
      `${key} — 本文が同じ行に ${[...identifiers].map((name) => `\`${name}\``).join(' / ')} を結び付けている`,
      { path, line: Number(line), identifiers: [...identifiers] },
    );
  }

  return {
    number: issue.number,
    candidates: extraction.paths.length,
    inspected: inspectable.length,
    ambiguous: extraction.shadowed.map((pair) => ({ path: pair.path, covered_by: pair.covered_by })),
    dropped,
    references: reported,
    line_claims: reportedClaims,
  };
}

// =============================================================================
// Evaluating the gates an issue declared, at the base (Issue #218)
// =============================================================================

// The commands are only ever run against a tree whose contents are known, and
// "known" here means COMMITTED. A dirty checkout makes the measurement
// unattributable in both directions: a gate that passes may be passing on
// somebody's uncommitted edit, and a gate that fails may be failing on it. The
// refusal is `invalid_input` rather than a finding because there is nothing to
// find — the run does not happen at all, and NOT ONE command is executed.
//
// Deviation recorded: Issue #218 asks for exit 2 here. In this package exit 2 is
// `not_implemented` and `invalid_input` is exit 3 everywhere (lib.mjs SkillError
// call sites across the six runners; #217 settled the same point). The
// implemented convention wins over the body's number.
function requireCleanBase(repoRoot) {
  let porcelain;
  try {
    porcelain = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new SkillError(
      'invalid_input',
      `--repo-root ${redact(repoRoot)} is not a git checkout, so "the base is clean" cannot be established. `
        + 'This mode RUNS the commands the issue declared and will not run them against a tree it cannot describe',
      3,
    );
  }
  const dirty = porcelain.split('\n').filter((line) => line.trim() !== '');
  if (dirty.length > 0) {
    throw new SkillError(
      'invalid_input',
      `--repo-root ${redact(repoRoot)} has ${dirty.length} uncommitted change(s), and a gate measured over them says nothing `
        + 'about the base ("already passing" could be the edit passing). Commit or stash them, or point --repo-root at a clean '
        + 'checkout of the base. No gate was run',
      3,
    );
  }
  const head = headOf(repoRoot);
  if (head === null) {
    throw new SkillError(
      'invalid_input',
      `--repo-root ${redact(repoRoot)} has no commit, so there is no base to name in the report. No gate was run`,
      3,
    );
  }
  return head;
}

// One execution of one gate. `sh -c` is what CommandMate's verify runner uses,
// so the shell that reads the command here is the shell that would read it
// there — a gate that is a shell one-liner (`test $(wc -l < path) -le 860`) must
// mean the same thing in both places.
//
// stdout and stderr are DISCARDED. The verdict of a gate is its exit code
// (acceptance-gates-notation.md §4), and capturing output would invite a later
// version to start reading it, which is where "the gate passed" and "the output
// looked right" begin to diverge.
function runGateOnce(command, repoRoot, timeoutSec) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync('sh', ['-c', command], {
    cwd: repoRoot,
    timeout: timeoutSec * 1000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const durationMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  const timedOut = result.error !== undefined && result.error !== null && result.error.code === 'ETIMEDOUT';
  return {
    exit_code: timedOut || typeof result.status !== 'number' ? null : result.status,
    duration_ms: durationMs,
    timed_out: timedOut,
    // The shell itself could not be started, or the child died on a signal that
    // was not our own timeout. Either way there is no exit code to read, and a
    // missing exit code is not a failing one.
    spawn_error: timedOut || result.error === undefined || result.error === null ? null : String(result.error.code ?? 'error'),
  };
}

// The four outcomes, from the runs actually performed.
//
// `already_satisfied` and `nondeterministic` are the two the author has to act
// on, so they are the two that are warnings. `failing_at_base` is what a working
// acceptance condition looks like before the work starts — it is recorded and
// nothing more, not even a notice. `not_evaluable` is the fourth on purpose:
// a gate nobody could measure must not be filed under either verdict.
//
// The one place this is stricter than the Issue's wording: the Issue defines
// `failing_at_base` as "non-zero every time" and `nondeterministic` as "a
// different exit code each time", and those two overlap for a gate that returns
// 1 and then 2. The verdict-flip is checked first (it is the load-bearing case),
// and a stable-fail whose CODES wander is still called nondeterministic — a
// command that is 127 on one run and 1 on the next is not measuring what its
// author thinks it measures.
function classifyGateRuns(runs) {
  if (runs.some((run) => run.timed_out)) return { outcome: 'not_evaluable', reason: 'timeout' };
  if (runs.some((run) => run.spawn_error !== null || run.exit_code === null)) {
    return { outcome: 'not_evaluable', reason: 'not_executable' };
  }
  const passes = runs.filter((run) => run.exit_code === 0).length;
  if (passes > 0 && passes < runs.length) return { outcome: 'nondeterministic', reason: 'verdict_flipped' };
  if (passes === runs.length) return { outcome: 'already_satisfied', reason: null };
  if (new Set(runs.map((run) => run.exit_code)).size > 1) {
    return { outcome: 'nondeterministic', reason: 'exit_code_varied' };
  }
  return { outcome: 'failing_at_base', reason: null };
}

// Why a gate could not be measured, in the author's language. Every one of these
// is a NOTICE: none of them says anything about the acceptance condition itself.
const NOT_EVALUABLE_DETAIL = {
  gate_id_unresolved: (gate) => `\`${gate.gate_id}\` は ${VERIFY_CONFIG_RELATIVE} に無い gate id である（dispatch も同じ集合で解決するので、この Issue は send 前に止まる）`,
  gate_id_builtin: (gate) => `\`${gate.gate_id}\` は CommandMate の built-in gate であり、この tree に走らせるコマンドが無い`,
  verify_config_unreadable: (gate) => `${VERIFY_CONFIG_RELATIVE} が読めないので \`${gate.gate_id}\` を解決できない`,
  block_invalid: () => 'acceptance-gates ブロックが読めない（planner も同じ理由で `acceptance_gate_block_invalid` を出す）',
  repo_root_not_base: (gate, evaluation) => `--repo-root の HEAD が --base（${evaluation.base_ref}）ではないので、ここでの実測は「着手前」の測定にならない`,
  timeout: (gate) => `\`${gate.gate_id}\` は ${gate.timeout_sec} 秒で終わらなかった（timeoutSec を上げるか、gate をその時間で終わる形に書き直す）`,
  not_executable: (gate) => `\`${gate.gate_id}\` のコマンドを起動できなかった（exit code が無い）`,
};

// The gates one issue declares, in the order the body declares them: `require:`
// first, then `gates:`, which is the order acceptance-gates-notation.md §3 fixes
// for the plan and for the contract. A report that reordered them would be
// reporting about a different declaration than the one that was written.
function declaredGatesOf(issue, config) {
  const read = readIssueAcceptanceGates(issue);
  if (read.error !== null) {
    return {
      declared: 'invalid',
      note: redact(read.error.text),
      gates: [{
        issue: issue.number,
        gate_id: null,
        source: null,
        command: null,
        timeout_sec: null,
        runs: [],
        outcome: 'not_evaluable',
        reason: 'block_invalid',
      }],
    };
  }
  if (read.gates === null) {
    // No block at all is the ordinary state, not a fault: acceptance-gates
    // -notation.md §7 keeps "there is no block" and "the block is broken"
    // strictly apart, and this mode does not get to blur them by treating an
    // ungated issue as something it failed to measure.
    return { declared: 'none', note: null, gates: [] };
  }

  const gates = [];
  for (const id of read.gates.require) {
    const base = { issue: issue.number, gate_id: id, source: 'require', command: null, timeout_sec: null, runs: [] };
    if (BUILT_IN_GATE_IDS.includes(id)) {
      gates.push({ ...base, outcome: 'not_evaluable', reason: 'gate_id_builtin' });
      continue;
    }
    if (!config.ok) {
      gates.push({ ...base, outcome: 'not_evaluable', reason: 'verify_config_unreadable' });
      continue;
    }
    const declared = config.gates.find((entry) => entry.id === id);
    if (declared === undefined || declared.command === null) {
      gates.push({ ...base, outcome: 'not_evaluable', reason: 'gate_id_unresolved' });
      continue;
    }
    gates.push({
      ...base,
      command: redact(declared.command),
      raw_command: declared.command,
      timeout_sec: declared.timeoutSec ?? DEFAULT_GATE_TIMEOUT_SEC,
    });
  }
  for (const gate of read.gates.gates ?? []) {
    gates.push({
      issue: issue.number,
      gate_id: gate.id,
      source: 'gates',
      command: redact(gate.command),
      raw_command: gate.command,
      timeout_sec: gate.timeoutSec ?? DEFAULT_GATE_TIMEOUT_SEC,
      runs: [],
    });
  }
  return { declared: 'yes', note: null, gates };
}

// Runs one gate `repeat` times and classifies it. A run that times out or cannot
// start ENDS the repeats: the outcome is already fixed at `not_evaluable`, and
// paying the same wall clock again would buy no new information. Every run that
// DID happen is in `runs[]` with its own exit code and duration — nothing is
// reduced to a median or to the first run, because "it passed once" and "it
// passes" are the confusion this mode exists to remove.
function evaluateGate(gate, repoRoot, repeat) {
  const runs = [];
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const run = runGateOnce(gate.raw_command, repoRoot, gate.timeout_sec);
    runs.push(run);
    if (run.timed_out || run.spawn_error !== null) break;
  }
  return { ...gate, runs };
}

const GATE_OUTCOME_LABEL = {
  already_satisfied: '着手前から通っている',
  failing_at_base: '着手前は落ちている（期待どおり）',
  nondeterministic: '実行ごとに結果が変わる',
  not_evaluable: '測れなかった',
};

function gateDetail(gate, evaluation) {
  if (gate.outcome === 'already_satisfied') {
    return `\`${gate.gate_id}\` は base で ${gate.runs.length} 回とも exit 0 だった。`
      + '着手前に落ちない条件はゲートとして働かない（直しても直さなくても緑になる）。';
  }
  if (gate.outcome === 'nondeterministic') {
    const codes = gate.runs.map((run) => run.exit_code).join(' / ');
    return gate.reason === 'verdict_flipped'
      ? `\`${gate.gate_id}\` は base で exit ${codes} と判定が変わった。着手後も安定して通らない。`
      : `\`${gate.gate_id}\` は ${gate.runs.length} 回とも非 0 だが exit code が ${codes} と揺れている。測っている対象が一定でない。`;
  }
  if (gate.outcome === 'not_evaluable') {
    return (NOT_EVALUABLE_DETAIL[gate.reason] ?? (() => gate.reason))(gate, evaluation);
  }
  return `\`${gate.gate_id}\` は base で ${gate.runs.length} 回とも非 0（exit ${gate.runs[0].exit_code}）だった。`;
}

const GATE_WARNING_CODE = {
  already_satisfied: 'acceptance_gate_already_satisfied',
  nondeterministic: 'acceptance_gate_nondeterministic',
  not_evaluable: 'acceptance_gate_not_evaluable',
};

function evaluateIssueGates(inputs, issues, warnings) {
  const config = readVerifyConfigGates(inputs.repoRoot);
  const baseSha = requireCleanBase(inputs.repoRoot);
  // `--base` is the operator saying which revision this checkout is supposed to
  // be. When it is something else, the measurement is not of the base — so no
  // gate runs and every one of them is `not_evaluable`. Rounding it to "passed
  // at base" or "failed at base" would be reporting a number nobody took.
  const baseRefSha = inputs.base === null ? null : resolveRef(inputs.repoRoot, inputs.base);
  const offBase = baseRefSha !== null && baseRefSha !== baseSha;

  const evaluation = {
    repo_root: redact(inputs.repoRoot),
    base_sha: baseSha,
    base_ref: inputs.base,
    base_ref_sha: baseRefSha,
    repeat: inputs.repeat,
    verify_config: config.ok ? VERIFY_CONFIG_RELATIVE : null,
    verify_config_error: config.ok ? null : redact(config.reason),
    issues: [],
    gates: [],
  };

  for (const issue of issues) {
    const declared = declaredGatesOf(issue, config);
    const evaluated = [];
    for (const gate of declared.gates) {
      let finished;
      if (gate.outcome === 'not_evaluable') {
        finished = gate;
      } else if (offBase) {
        finished = { ...gate, outcome: 'not_evaluable', reason: 'repo_root_not_base' };
      } else {
        const withRuns = evaluateGate(gate, inputs.repoRoot, inputs.repeat);
        finished = { ...withRuns, ...classifyGateRuns(withRuns.runs) };
      }
      const { raw_command: unusedRawCommand, ...record } = finished;
      record.detail = gateDetail(record, evaluation);
      evaluated.push(record);
      const code = GATE_WARNING_CODE[record.outcome];
      if (code !== undefined) {
        warnings.push({
          code,
          issue: issue.number,
          gate_id: record.gate_id,
          detail: record.detail,
          ...(record.outcome === 'not_evaluable' ? { reason: record.reason, severity: 'notice' } : {}),
        });
      }
    }
    evaluation.issues.push({
      number: issue.number,
      declared: declared.declared,
      note: declared.note,
      gates: evaluated.length,
    });
    evaluation.gates.push(...evaluated);
  }
  return evaluation;
}

// A finding is a warning; a `not_evaluable` is a notice and does not colour the
// run. That split is the planner's (`withSeverity` / `hasBlockingWarning` in
// orchestrate.mjs, Issue #199) and is reused rather than re-invented: `partial`
// means somebody has to change something, and "this gate could not be measured
// here" is a fact about the runner's reach, not a defect in the issue.
function hasGateWarning(warnings) {
  return warnings.some((warning) => warning.severity !== 'notice');
}

function renderGateSummary({ evaluation, warnings, repeat }) {
  const gates = evaluation.gates;
  const counted = (outcome) => gates.filter((gate) => gate.outcome === outcome).length;
  const lines = [
    '## 目的',
    'Issue が宣言した受入ゲートを、**着手前の base で先行実行**した'
      + `（各 ${repeat} 回・read-only・**裁定しない**・plan には何も書かない）。`,
    '',
    '## 結論',
    `Issue ${evaluation.issues.length} 件が宣言した gate ${gates.length} 件を base（${evaluation.base_sha}）で実行した。`
      + `**着手前から通っている ${counted('already_satisfied')} 件 / 実行ごとに変わる ${counted('nondeterministic')} 件 / `
      + `着手前は落ちている ${counted('failing_at_base')} 件 / 測れなかった ${counted('not_evaluable')} 件。**`
      + (hasGateWarning(warnings)
        ? ' 上2つは warning であり、**受入条件そのものが壊れている**ことを示す。dispatch は止めない。'
        : ' warning は無い。'),
  ];
  if (gates.length > 0) {
    lines.push(
      '',
      '## gate ごとの実測',
      '',
      '| Issue | gate | 由来 | 実行 | 判定 |',
      '|---|---|---|---|---|',
      ...gates.map((gate) => {
        const runs = gate.runs.length === 0
          ? '—'
          : gate.runs.map((run) => `${run.timed_out ? 'timeout' : `exit ${run.exit_code}`} (${run.duration_ms}ms)`).join(' / ');
        return `| #${gate.issue} | \`${gate.gate_id ?? '—'}\` | ${gate.source ?? '—'} | ${runs} | ${GATE_OUTCOME_LABEL[gate.outcome]} |`;
      }),
    );
  }
  const ungated = evaluation.issues.filter((issue) => issue.declared === 'none');
  if (ungated.length > 0) {
    lines.push(
      '',
      '## 宣言が無い Issue',
      `- ${ungated.map((issue) => `#${issue.number}`).join(' / ')} は \`acceptance-gates\` ブロックを持たない。`
        + '**散文の受入条件からコマンドは導出しない**（[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第5節）。'
        + 'ゲートとして測りたい条件は `gates:` に `test $(wc -l < path) -le 860` のような形で書く。',
    );
  }
  lines.push(
    '',
    '## 次の一手',
    '- **着手前から通っている条件はゲートではない。** 何が変われば赤から緑に変わるのかを書き直して re-plan する。',
    '- **実行ごとに変わる条件もゲートではない。** 出力に時刻・乱数・並び順が混ざっていないかを見る。',
    '- **「測れなかった」は「通った」でも「落ちた」でもない。** notice のまま dispatch すると、その条件は誰にも判定されない。',
    ...(repeat < 2
      ? ['- **`--repeat 1` で走っている。** 実行ごとに判定が変わる gate はこの run では検出できない。']
      : []),
    '- **この runner は Issue を承認も却下もしない。** dispatch を止めるのは planner の question と dispatch の blocking reason だけである。',
  );
  return lines.join('\n');
}

function gateCompletionChecks(evaluation, warnings) {
  const checks = [
    { id: 'plan_untouched', passed: true, detail: 'plan.json にも run directory にも書いていない（結果はこの artifact だけにある）' },
    {
      id: 'declared_only',
      passed: evaluation.gates.every((gate) => gate.source === null || gate.source === 'require' || gate.source === 'gates'),
      detail: '実行したのは Issue が宣言した gate だけである（散文からは1件も導出していない）',
    },
    {
      id: 'shared_parse',
      passed: true,
      detail: 'ブロックの読み取りは planner と同じ関数（orchestrate.mjs の readIssueAcceptanceGates）である',
    },
    {
      id: 'clean_base',
      passed: evaluation.base_sha !== null,
      detail: `実行前に base が clean であることを確かめた（${evaluation.base_sha}）`,
    },
    {
      id: 'runs_recorded',
      passed: evaluation.gates.every((gate) => gate.outcome === 'not_evaluable' || gate.runs.length === evaluation.repeat),
      detail: `全 gate の全実行の exit code と所要時間が runs[] に残っている（${evaluation.repeat} 回・中央値や1回目に丸めない）`,
    },
    {
      id: 'no_adjudication',
      passed: warnings.every((warning) => Object.values(GATE_WARNING_CODE).includes(warning.code)),
      detail: `所見 ${warnings.length} 件はすべて warning / notice であり、exit は 0 である`,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

// =============================================================================
// Reporting
// =============================================================================

const CODE_LABELS = {
  reference_file_missing: 'file が無い',
  reference_line_out_of_range: '行番号が範囲外',
  reference_identifier_moved: '識別子が別の行',
  reference_line_count_stale: '行数の主張が古い',
  reference_claim_inconsistent: '本文内で主張が食い違う',
};

function renderSummary({ inspection, warnings }) {
  const issues = inspection.issues;
  const totalReferences = issues.reduce((sum, issue) => sum + issue.references.length, 0);
  const totalClaims = issues.reduce((sum, issue) => sum + issue.line_claims.length, 0);
  const skipped = issues.reduce((sum, issue) => sum + issue.ambiguous.length, 0);
  const droppedCount = issues.reduce((sum, issue) => sum + issue.dropped.length, 0);
  const lines = [
    '## 目的',
    'Issue 本文が主張する事実（`path:line` と「N 行」）を、対象リポジトリの実物に突き合わせた' +
      '（read-only・**裁定しない**・plan には何も書かない）。',
    '',
    '## 結論',
    `Issue ${issues.length} 件 / 参照 ${totalReferences} 件 / 行数主張 ${totalClaims} 件を、` +
      `${inspection.ref === null ? `working tree（HEAD ${inspection.head ?? '不明'}）` : `\`${inspection.ref}\`（${inspection.resolved_ref}）`}に対して点検した。` +
      `**ずれ ${warnings.length} 件。**` +
      (warnings.length === 0 ? ' 本文と実物は一致している。' : ' 下記はすべて warning であり、dispatch を止めない。'),
  ];
  if (skipped > 0 || droppedCount > 0) {
    lines.push(
      '',
      '## 点検対象外',
      ...(skipped > 0
        ? [`- 表記ゆれ（\`ambiguous_file_candidate\` 相当）の候補 ${skipped} 件。どちらの綴りが対象かを決めるのは著者であり、この runner は選ばない。`]
        : []),
      ...(droppedCount > 0
        ? [`- planner と同じ規則で候補になる前に落ちた path ${droppedCount} 件（\`..\` / 絶対 path / system root / URL host）。`]
        : []),
    );
  }
  for (const issue of issues) {
    const mine = warnings.filter((warning) => warning.issue === issue.number);
    lines.push(
      '',
      `## #${issue.number}`,
      `- 候補 ${issue.candidates} 件のうち ${issue.inspected} 件を点検（参照 ${issue.references.length} / 行数主張 ${issue.line_claims.length}）。`,
    );
    if (mine.length === 0) lines.push('- ずれは無い。');
    for (const warning of mine) {
      lines.push(`- ${CODE_LABELS[warning.code] ?? warning.code}: ${warning.detail}`);
    }
  }
  lines.push(
    '',
    '## 次の一手',
    '- ずれた行は **実測を正とする**（`cmate-worker-development` 規律4と同じ）。本文を直して re-plan すると run_id も変わる。',
    '- 「N 行」は末尾改行の無い最終行も1行として数える（`wc -l` より1多くなる場合がある）。',
    '- **本文の意味的な矛盾（決定事項 対 受入条件など）はここでは見ていない。** それは `cmate-issue-refinement` Step 4 の仕事である。',
    '- **この runner は Issue を承認も却下もしない。** dispatch を止めるのは planner の question と dispatch の blocking reason だけである。',
  );
  return lines.join('\n');
}

function completionChecks(inspection, warnings) {
  const checks = [
    { id: 'read_only', passed: true, detail: 'plan にもリポジトリにも書いていない' },
    {
      id: 'shared_extraction',
      passed: true,
      detail: '候補抽出は planner と同じ関数（orchestrate.mjs の extractFileCandidates）である',
    },
    {
      id: 'no_adjudication',
      passed: warnings.every((warning) => CODE_LABELS[warning.code] !== undefined),
      detail: `所見 ${warnings.length} 件はすべて warning であり、exit は 0 である`,
    },
    {
      id: 'repo_root_bounded',
      passed: inspection.issues.every((issue) => issue.references.every((reference) => !reference.path.startsWith('/'))),
      detail: `--repo-root の外は読んでいない（候補になる前に落ちた path ${inspection.issues.reduce((sum, issue) => sum + issue.dropped.length, 0)} 件を報告している）`,
    },
    {
      id: 'deterministic',
      passed: true,
      detail: '同じ本文と同じ tree からは同じ報告が出る（clock も乱数も使わない）',
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function buildResult({ mode, status, inspection, evaluation, warnings, errors, completionCheck, summary, artifacts }) {
  return {
    inspect_schema_version: INSPECT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    mode,
    status,
    // `null` whenever the run refused its input, and `null` in the mode that did
    // not produce it. Stated as data so a consumer cannot read "we could not
    // look" as "we looked and found nothing".
    inspection,
    // `--evaluate-gates`'s half of the same envelope: what the issue declared,
    // what was run, and every run's exit code. Deliberately a SIBLING of
    // `inspection` rather than a shape squeezed into it — one reads files and
    // the other executes commands, and a reader must be able to tell which
    // report they are holding without inferring it from the fields present.
    evaluation,
    artifacts,
    errors,
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

// The mode a refused run was asked for, read straight off the command line. It
// is not taken from the resolved inputs because the refusal may BE the argument
// parse — and a failure envelope that named a mode the operator did not type
// would be the runner guessing about the one thing it is refusing to guess
// about. Both flags, or neither, is `null`: ambiguous, and said so.
function modeFromArgv(argv) {
  const wanted = ['--check-references', '--evaluate-gates'].filter((flag) => argv.includes(flag));
  return wanted.length === 1 ? wanted[0].slice(2) : null;
}

function inspectFailure(error, mode) {
  return buildResult({
    mode,
    status: 'failure',
    inspection: null,
    evaluation: null,
    warnings: [],
    errors: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    artifacts: [],
    completionCheck: {
      passed: false,
      checks: [
        { id: 'read_only', passed: true, detail: '何も書いていない' },
        { id: 'shared_extraction', passed: false, detail: '本文を1件も読んでいない' },
        { id: 'no_adjudication', passed: true, detail: '入力を読めなかったのであって、Issue を裁定してはいない' },
        { id: 'repo_root_bounded', passed: true, detail: '1 file も読んでいない' },
        { id: 'deterministic', passed: true, detail: '失敗は入力の純粋関数である' },
      ],
    },
    summary: `## 結論\n点検していない（${error.code}）。${redact(error.detail ?? error.message)}`,
  });
}

// =============================================================================
// Entry point
// =============================================================================

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  if (inputs.mode === 'evaluate-gates') return runEvaluateGates(inputs);

  const resolvedRef = inputs.ref === null ? null : resolveRef(inputs.repoRoot, inputs.ref);
  const issues = loadIssues(inputs);

  const readFile = makeFileReader(inputs.repoRoot, inputs.ref);
  const warnings = [];
  const inspection = {
    repo_root: redact(inputs.repoRoot),
    source: inputs.ref === null ? 'worktree' : 'ref',
    ref: inputs.ref,
    resolved_ref: resolvedRef,
    head: inputs.ref === null ? headOf(inputs.repoRoot) : resolvedRef,
    issues: issues.map((issue) => inspectIssue(issue, readFile, warnings)),
  };

  const status = warnings.length > 0 ? 'partial' : 'success';
  // Declared before the report is serialized, so the bytes written to --out and
  // the bytes on stdout are the same bytes: a report that named itself only in
  // one of the two copies would be a report whose provenance depends on which
  // copy you read.
  const result = buildResult({
    mode: 'check-references',
    status,
    inspection,
    evaluation: null,
    warnings,
    errors: [],
    completionCheck: completionChecks(inspection, warnings),
    summary: renderSummary({ inspection, warnings }),
    artifacts: inputs.out === null ? [] : [redact(inputs.out)],
  });

  const rendered = emit(result, inputs);
  process.stderr.write(
    `inspected ${issues.length} issue(s) against ${inputs.ref === null ? 'the working tree' : inputs.ref}: ` +
      `${warnings.length} mismatch(es). This runner does not adjudicate; exit is 0.\n`,
  );
  return { exitCode: 0, stdout: rendered };
}

// Serializing once and writing the SAME BYTES to `--out` and to stdout, so a
// report's provenance does not depend on which copy you read. Shared by both
// modes for exactly that reason.
function emit(result, inputs) {
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (inputs.out !== null) {
    try {
      writeFileSync(inputs.out, rendered, 'utf8');
    } catch (error) {
      throw new SkillError('write_error', `cannot write --out ${redact(inputs.out)}: ${redact(error.message)}`, 6);
    }
    process.stderr.write(`wrote inspection report to ${inputs.out}\n`);
  }
  return rendered;
}

// `--evaluate-gates`. The refusal comes FIRST and comes from
// `requireCleanBase`, before a single command is spawned: a mode that runs what
// an issue wrote has to be able to say what tree it ran it against.
function runEvaluateGates(inputs) {
  const issues = loadIssues(inputs);
  const warnings = [];
  const evaluation = evaluateIssueGates(inputs, issues, warnings);

  const result = buildResult({
    mode: 'evaluate-gates',
    // `partial` iff a warning was raised. A run whose only findings are notices
    // is `success` WITH notices — the same split the planner makes (#199).
    status: hasGateWarning(warnings) ? 'partial' : 'success',
    inspection: null,
    evaluation,
    warnings,
    errors: [],
    completionCheck: gateCompletionChecks(evaluation, warnings),
    summary: renderGateSummary({ evaluation, warnings, repeat: inputs.repeat }),
    artifacts: inputs.out === null ? [] : [redact(inputs.out)],
  });

  const rendered = emit(result, inputs);
  const blocking = warnings.filter((warning) => warning.severity !== 'notice').length;
  process.stderr.write(
    `evaluated ${evaluation.gates.length} declared gate(s) from ${issues.length} issue(s) at ${evaluation.base_sha}, `
      + `${inputs.repeat} run(s) each: ${blocking} broken acceptance condition(s), `
      + `${warnings.length - blocking} not measurable. This runner does not adjudicate; exit is 0.\n`,
  );
  return { exitCode: 0, stdout: rendered };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      process.stdout.write(`${JSON.stringify(inspectFailure(error, modeFromArgv(argv)), null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
