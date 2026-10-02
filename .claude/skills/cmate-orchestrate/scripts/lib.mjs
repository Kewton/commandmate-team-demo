// cmate-orchestrate — helpers shared by the four runners (Node stdlib only, Node >= 22).
//
// The package ships four deterministic runners — orchestrate.mjs (plan),
// dispatch.mjs, merge.mjs and uat.mjs — and they had accumulated copies of the
// same helpers. This module holds the copies that were BYTE-IDENTICAL, so that a
// fix applied to one is a fix applied to all. Nothing here changes behavior: each
// definition below is the text that already stood in the runners that used it.
//
// The rule this module is maintained by, because getting it wrong is how a
// refactor turns into a regression:
//
//   Only a helper whose every copy was byte-identical lives here. A helper that
//   merely SHARES A NAME across runners is left where it is. Same-named helpers
//   with different bodies are not "reconciled" into one — reconciling them picks
//   one runner's behavior and silently imposes it on the others.
//
// resolveLauncher() is the one entry that was never a copy: it was written here
// FIRST, precisely so dispatch and uat cannot drift on how a launcher is read
// (Issue #37). Divergence there is the bug it exists to prevent.
//
// The `scope_companions` section at the bottom is the same kind of entry, arrived
// at from the other direction: it was HOISTED out of orchestrate.mjs when a
// second reader appeared (`profile-init.mjs --check`, Issue #197). A rule
// vocabulary read by two runners is a vocabulary two runners can disagree about,
// and the disagreement would be silent — `--check` reporting a match the planner
// does not make is exactly the "a rule that never matches and never says so"
// failure #197 exists to remove. So the matcher is written once and both callers
// import it; the extraction is provably behaviour-preserving because every
// full-text plan golden is byte-unchanged by it.
//
// Deliberately NOT hoisted, with the difference that keeps each one local:
//
//   parseCli / renderSummary  four different implementations (different flags,
//                             different report shapes). Nothing to share.
//   excerpt                   dispatch returns `null` for an empty excerpt,
//                             merge/uat return `''`. The report schemas differ.
//   bullets                   merge/uat redact each item, dispatch does not.
//   runCli                    dispatch/uat take an `extra` options bag and spread
//                             it into execFileSync; merge takes (bin, args) only.
//   validatePlan              dispatch additionally enforces max_parallel and the
//                             per-wave width bound — the pre-condition that stops
//                             it from dispatching beyond the plan's promise.
//   positiveInt               uat takes a `max` ceiling argument, dispatch does not.
//   preflight / eligibleIssues / halt
//                             merge and uat check different binaries, read
//                             different eligibility fields and halt into different
//                             report shapes.
//   redact (orchestrate.mjs)  the planner keeps its own non-tallying copy; see the
//                             note on REDACTIONS below.
//
// The planner's extraction constants (FILE_EXT, PATH_START, CANDIDATE_*,
// DELIVERABLE_HEADING_RE, CONTEXT_HEADING_RE) are NOT here either, and must not
// move: tests/fixtures/cmate-issue-authoring/run_tests.sh compares those
// declarations byte for byte against cmate-issue-authoring's mirror of them, by
// reading `^const NAME = ...` out of orchestrate.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SKILL_ID = 'cmate-orchestrate';

// The text a profile's `worker_messages.nudge` (or dispatch's --nudge-message)
// appends to the supervision nudge (CommandMate#3009). One reader on each side of
// the plan file — the planner for the profile, dispatch for the plan and the flag
// — so the rule lives here and only the refusal code differs. Returns the reason
// the value is refused, or null.
export const WORKER_MESSAGE_MAX_CHARS = 2000;
export function workerMessageProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  if (value.length > WORKER_MESSAGE_MAX_CHARS) return `must be at most ${WORKER_MESSAGE_MAX_CHARS} characters, got ${value.length}`;
  return null;
}

// The keys a profile's `worker_messages` may carry. `nudge` is dispatch's, `fix_nudge`
// is the uat fix loop's; the planner and dispatch both accept the full set (a
// runner ignores the keys it does not use) so a profile is never refused by the
// runner that has no use for a key.
export const WORKER_MESSAGE_KEYS = ['nudge', 'fix_nudge'];

// Stamped into the `skill_version` field of every report the four runners write,
// which is the field a bug report against this package is triaged by. It must
// equal `version:` in commandmate.skill.yaml, and scripts/validate.py fails the
// package when it does not — 0.15.0 through 0.17.0 shipped with this constant
// left at 0.13.0, and the reports named a version nobody had installed
// (Issue #92, observed in Kewton/CommandMate#1741).
export const SKILL_VERSION = '0.37.0';

// The dispatch report version merge.mjs and uat.mjs consume. It is the dispatch
// report's contract as a CONSUMER sees it, which is why it is stated here rather
// than imported from dispatch.mjs (which declares its own producer-side version).
export const SUPPORTED_DISPATCH_SCHEMA_VERSION = 1;

// A skill error carries a machine code so the result envelope, the exit status
// and the audit line all agree on what went wrong. All four runners branch on
// `error instanceof SkillError` in main(), so there must be exactly one class:
// a per-file copy would make an error thrown by a helper here unrecognizable.
export class SkillError extends Error {
  constructor(code, detail, exitCode) {
    super(detail);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

// =============================================================================
// Redaction
// =============================================================================

// Applied to every free-text field lifted out of an issue or a terminal before it
// is stored. A token or an absolute host path must not survive into a plan, a
// report or an audit artifact. Patterns are shapes, never example secrets, so
// this file itself trips no credential scanner.
//
// All four runners share this list, including orchestrate.mjs, which keeps its
// own `redact()`. Drift in the PATTERNS between runners is the failure that
// matters — a token shape added to one runner and missed in another leaks from
// the runner that missed it — so the list is shared even where the function
// around it is not.
export const REDACTIONS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED-TOKEN]'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, '[REDACTED-TOKEN]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED-TOKEN]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED-TOKEN]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED-TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED-TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED-TOKEN]'],
  [/\b[Bb]earer\s+[A-Za-z0-9._-]{10,}/g, 'Bearer [REDACTED-TOKEN]'],
  [/(?:\/Users\/|\/home\/|\/root\/|\/var\/|\/private\/|\/tmp\/)[^\s"'`)\]]*/g, '[REDACTED-PATH]'],
  [/\b[A-Za-z]:\\[^\s"'`)\]]*/g, '[REDACTED-PATH]'],
];

// Tallied by kind so the report can say "we found and removed N of these"
// without ever echoing the value itself.
const REDACTION_KIND = [
  [/\[REDACTED-TOKEN\]/g, 'token'],
  [/Bearer \[REDACTED-TOKEN\]/g, 'bearer_token'],
  [/\[REDACTED-PATH\]/g, 'absolute_path'],
];

const redactionTally = new Map();

// The tallying redaction used by the three mutating runners, whose reports carry
// a `redactions[]` field. orchestrate.mjs has no such field and keeps its own
// copy without the tally; that difference is why this one is not imposed on it.
export function redact(value) {
  let text = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  for (const [pattern, kind] of REDACTION_KIND) {
    const hits = text.match(pattern);
    if (hits) redactionTally.set(kind, (redactionTally.get(kind) ?? 0) + hits.length);
  }
  return text;
}

export function redactionsList() {
  return [...redactionTally.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => ({ kind, count }));
}

// =============================================================================
// Loading and validating the upstream artifacts
// =============================================================================

export function loadJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read ${what} at ${path}: ${redact(error.message)}`, 6);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `${what} at ${path} is not valid JSON: ${redact(error.message)}`, 6);
  }
}

export function validateDispatch(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new SkillError('dispatch_invalid', 'dispatch report must be a JSON object', 3);
  }
  if (report.dispatch_schema_version !== SUPPORTED_DISPATCH_SCHEMA_VERSION) {
    throw new SkillError('dispatch_invalid', `unsupported dispatch_schema_version ${report.dispatch_schema_version}; this runner understands ${SUPPORTED_DISPATCH_SCHEMA_VERSION}`, 3);
  }
  if (report.skill_id !== SKILL_ID) {
    throw new SkillError('dispatch_invalid', `dispatch report skill_id "${report.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (!Array.isArray(report.waves)) {
    throw new SkillError('dispatch_invalid', 'dispatch report has no waves', 3);
  }
  return report;
}

export function issueOf(plan, number) {
  return plan.issues.find((issue) => issue.number === number) ?? { number };
}

// =============================================================================
// The GATE line vocabulary (Issue #224 / CommandMate #1772)
// =============================================================================
//
// `commandmate wait --verify` and cmate-verify's standalone runner both report
// one `GATE <id> <WORD>` line per executed gate, and three runners in this Skill
// read those lines or the verdicts transcribed from them: dispatch parses them,
// merge renders them into the PR body, status renders them into the matrix. (uat
// reads the same report but only `verification.outcome`, which is the exit code
// and not a word from this vocabulary.) The vocabulary lives here so there is one
// definition of what the words mean rather than one per reader — a third word
// added to one reader and not the others is how `FLAKY` would have arrived as
// "unknown" in one place and `fail` in another.
//
// `FLAKY` means the gate failed and then passed on a re-run against the same
// tree. It is a THIRD word, not a decoration on PASS or FAIL: neither of those
// was true of the gate. Whether the run COUNTED it as a pass is decided by the
// gate's own `flakyIsPass`, and that decision is already in the runner's exit
// code — which is the verdict (dispatch-contract.md section 2.6). Nothing here
// re-adjudicates it.
//
// The regex matches the word and stops. Both spellings carry a detail after it
// and they differ — the product CLI parenthesises (`GATE unit FLAKY (exit=1,0,
// 45.0s,44.0s)`) and the standalone runner does not (`GATE unit FLAKY exit=1,0
// duration=45s,44s waited=42s`) — so a reader that parsed the detail would be
// reading one runner's punctuation as a contract. `\b` after the word is what
// keeps `waited=` and a two-valued `exit=` from breaking the match.
export const GATE_LINE_RE = /^GATE\s+(\S+)\s+(PASS|FAIL|FLAKY)\b/;

/** The report's spelling of each GATE word. */
export const GATE_VERDICT_BY_LABEL = new Map([
  ['PASS', 'pass'],
  ['FAIL', 'fail'],
  ['FLAKY', 'flaky'],
]);

/**
 * Verdicts that are not a clean pass.
 *
 * `flaky` is in here for DISPLAY and ordering — a report that has to cut its
 * gate list keeps these first, because they are what the reader opened it for.
 * It is NOT a claim that the run failed: a `flakyIsPass: true` gate is FLAKY and
 * the run passed. The exit code says which, and it always did.
 */
export const NON_PASS_GATE_VERDICTS = new Set(['fail', 'flaky']);

/**
 * The gate id and verdict of one GATE line, or null when the line is not one.
 *
 * @param {string} line one line of a runner's output, already trimmed
 */
export function parseGateLine(line) {
  const match = GATE_LINE_RE.exec(String(line ?? ''));
  if (!match) return null;
  return { id: match[1], verdict: GATE_VERDICT_BY_LABEL.get(match[2]) };
}

/** The report's word for a gate whose two runs disagreed. */
export const FLAKY_GATE_VERDICT = 'flaky';

/**
 * Was this gate FLAKY?
 *
 * Asked by name rather than by a bare string comparison at each call site,
 * because every one of them has to resist the same temptation: the answer is NOT
 * "therefore the run failed" or "therefore it passed". `flakyIsPass` decided
 * that, the runner's exit code carries the decision, and neither is on the gate
 * line this verdict came from.
 */
export function isFlakyVerdict(verdict) {
  return String(verdict ?? '') === FLAKY_GATE_VERDICT;
}

// =============================================================================
// Subprocess output
// =============================================================================

export function parseCliJson(result) {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// =============================================================================
// `send` refused because the session was not ready yet (CommandMate#3006)
// =============================================================================
//
// Written here FIRST, like resolveLauncher: dispatch and uat both open a brand-new
// session with their first `send`, and a rule that only one of them knows is the
// rule the other one fails on.
//
// MEASURED (Kewton/Musunest #201 / #213 / #217 / #233 — every one the FIRST send
// into a session that very send had started): the server refuses a send it could
// not deliver because the agent had not reached its composer yet, and it has typed
// NOTHING when it does. Two spellings reach the CLI, both as exit 99
// (ExitCode.UNEXPECTED_ERROR, `handleApiError`'s 5xx branch), and both are
// transcribed in tests/fixtures/cmate-orchestrate/commandmate-cli-contract.json
// (`send_failures`):
//
//   session_starting   HTTP 503 `SESSION_STARTING` (CommandMate #1637; Command
//                      Code joins Claude there in CommandMate#3006): stderr
//                      "Error: Server error: <tool> did not reach its input prompt
//                      within <n>s (initialization timeout). … Retry the send in a
//                      few seconds …"
//   prompt_not_ready   the pre-send composer wait timing out (Command Code /
//                      Codex / Antigravity): stderr "… prompt not ready: timed out
//                      waiting for the composer before sending"
//
// So the refusal is recognised by BOTH halves, never by one: exit 99 alone is
// every unexpected error the CLI has — a 409 surfaces as "Unexpected HTTP status:
// 409" under the same 99, and a message that "did not arrive intact" is also 99
// and may have been half-typed — and the sentence alone could sit inside some other
// failure's text. PROMPT_WAITING is exit 2 and never matches. Only the pair means
// "unsent, a retry is safe", and the answer does not depend on which agent it is.
export const SEND_NOT_READY_EXIT = 99;
export const SEND_NOT_READY_PATTERNS = [
  { kind: 'session_starting', re: /\bSESSION_STARTING\b|did not reach its input prompt/i },
  { kind: 'prompt_not_ready', re: /prompt not ready/i },
];

// Which not-ready refusal this `send` result is, or null when it is anything else.
export function sendNotReadyKind(result) {
  if (!result || result.ok || result.status !== SEND_NOT_READY_EXIT) return null;
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return SEND_NOT_READY_PATTERNS.find((entry) => entry.re.test(text))?.kind ?? null;
}

// How long to let a new session finish booting before the ONE retry. A constant,
// not a flag: the retry absorbs a start-up race, it is not a knob to tune per run.
// `CMATE_ORCHESTRATE_SEND_PAUSE_MS` overrides every send-side pause for the
// fixture suite only (the same `CMATE_ORCHESTRATE_*` precedent as the unattended
// lock root), so the tests exercise the retry without sleeping; anything that is
// not a non-negative integer falls back to the constant rather than to "no wait".
export const SEND_NOT_READY_RETRY_DELAY_MS = 15000;
export const SEND_PAUSE_ENV = 'CMATE_ORCHESTRATE_SEND_PAUSE_MS';

export function sendPauseMs(fallbackMs, env = process.env) {
  const raw = env[SEND_PAUSE_ENV];
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return fallbackMs;
}

// A synchronous pause, for uat.mjs, which is synchronous end to end. dispatch.mjs
// supervises a wave concurrently and must NOT use this: blocking its event loop
// would stall every other worker's supervision for the delay, so it awaits a timer
// instead.
export function pauseMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// =============================================================================
// Launcher resolution (Issue #37)
// =============================================================================

// Every runner that drives the CommandMate CLI resolves its launcher the same
// way `cmate-orchestrate-monitor/scripts/monitor.sh:108` does, so one operator
// setting covers the whole toolchain instead of one convention per Skill:
//
//   --cli <launcher>   explicit, wins
//   $CM                monitor.sh's variable, same name and same meaning
//   "commandmate"      the default
//
// The value is a LAUNCHER, not merely an executable. It is split on whitespace
// and spawned WITHOUT a shell, which is what makes `npx commandmate@latest`
// usable: before this, execFileSync took the whole string as one program name
// and died with ENOENT on the space. The default stays the bare name so that an
// npx-only operator sets exactly one thing — `CM` — as the acceptance criteria
// ask, and nobody who already has the binary starts paying npx startup per call.
//
// This is RUNTIME resolution only. No runner writes the resolved launcher into
// plan.json: the plan stays a pure function of its inputs.
export const DEFAULT_LAUNCHER = 'commandmate';

// Shell syntax we would never interpret. Nothing here goes through a shell, so a
// pipe, a redirect, a substitution or a quote would be handed to the program as
// a literal argument and silently misbehave — a wrapper script is the answer,
// and the error says so. Whitespace is the separator, so tab and space are fine;
// every other control character is not.
const LAUNCHER_SHELL_CHARS = /[|&;<>()$`\\"']/;
// eslint-disable-next-line no-control-regex
const LAUNCHER_CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;

export const LAUNCHER_ADVICE =
  'a launcher is an executable plus fixed leading arguments, split on whitespace and run WITHOUT a shell ' +
  '(accepted: "commandmate", "/usr/local/bin/commandmate", "npx commandmate@latest", "node /path/to/cli.mjs"). ' +
  'For anything a shell would have to read — a pipe, a redirect, a substitution, a quote — put a wrapper on PATH ' +
  '(~/.local/bin/commandmate containing: exec npx --yes commandmate@latest "$@") and pass its path.';

// Returns the argv prefix: [program, ...fixed args]. Never empty.
export function resolveLauncher(cliFlag, env = process.env) {
  const fromEnv = typeof env.CM === 'string' && env.CM.trim() !== '' ? env.CM : undefined;
  const source = cliFlag !== undefined && cliFlag !== null ? '--cli' : (fromEnv !== undefined ? 'CM' : 'default');
  const raw = cliFlag ?? fromEnv ?? DEFAULT_LAUNCHER;
  const reject = (why) => {
    throw new SkillError('invalid_input', `${source} ${redact(String(raw))}: ${why}; ${LAUNCHER_ADVICE}`, 3);
  };
  if (typeof raw !== 'string') reject('must be a string');
  if (LAUNCHER_CONTROL_CHARS.test(raw)) reject('contains a control character');
  if (LAUNCHER_SHELL_CHARS.test(raw)) reject('contains shell syntax, which nothing here interprets');
  const argv = raw.trim().split(/\s+/).filter((token) => token !== '');
  if (argv.length === 0) reject('is empty');
  if (argv[0].startsWith('-')) reject('starts with "-", so it would be read as a flag rather than a program');
  return argv;
}

// =============================================================================
// Path and ref guards
// =============================================================================

// A branch name headed into `git push` / `gh pr create --head` must be a plain
// ref: no whitespace, no shell metacharacters, no path escape. A profile
// template produces exactly this shape; anything else is refused, not quoted.
export function safeBranch(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || value.startsWith('-')) return null;
  return value;
}

// The worktree path comes from a verified profile template (e.g. "../repo-…"),
// so a single leading "../" to a sibling directory is legitimate. Anything that
// could escape further — an absolute path, a drive path, a backslash, a control
// character, or a "../" that is not the single leading segment — is refused.
export function safeWorktreeTarget(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) return null;
  if (pathValue.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(pathValue)) return null;
  if (pathValue.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(pathValue)) return null;
  let rest = pathValue;
  if (rest.startsWith('../')) rest = rest.slice(3);
  if (rest.split('/').some((segment) => segment === '..')) return null;
  return pathValue;
}

// =============================================================================
// The agent harness — deny-by-default (Issue #177)
// =============================================================================
//
// The paths that make up the AGENT'S OWN HARNESS: the Skill packages the worker
// and its verifier ARE, and the CommandMate configuration that decides what
// "verified" means. A worker allowed to write there can pass its gate by
// rewriting the judge, so the planner keeps them out of `scope.allow` by default
// and a profile may not re-grant them (references/profile-contract.md §9.6). The
// full argument for hardcoding the set — rather than making it declarable — is
// at the planner's use site in orchestrate.mjs.
//
// Here rather than there because the refusal is part of reading a PROFILE, and
// two runners now read one: the planner refuses the declaration, and
// `profile-init.mjs --check` must refuse the same declaration for the same
// reason. A per-runner copy of a permission boundary is a permission boundary
// with a second, quieter door.
export const HARNESS_PATH_PREFIXES = ['.claude/skills/', '.agents/skills/', '.commandmate/'];

// `./`-prefixed forms are stripped first. A repository-relative path filter
// accepts `./.claude/skills/x.sh` (it escapes nothing), and a prefix test alone
// would read it as a non-harness path — a one-character bypass of a permission
// boundary. Every other escape (`..`, absolute, backslash) is already refused
// before a path reaches here, so this is the only normalisation needed.
export function isHarnessPath(path) {
  const normalized = path.replace(/^(?:\.\/)+/, '');
  return HARNESS_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// =============================================================================
// scope_companions — the rule vocabulary and its evaluation (Issues #149 / #181)
// =============================================================================
//
// Layer L2 of references/adr-scope-derivation.md. L1 (the planner's
// testScopeDefaultsFor) derives the CONVENTIONAL test path of every declared
// source file. What it cannot derive is a convention it has never heard of: a
// `spec/` tree mirroring `app/`, a generated `*_pb.ts` beside every `.proto`, a
// locale table regenerated from its source. The planner never opens the target
// repository, and dispatch must not observe the worktree either — a contract that
// depended on worktree state would stop being byte-identical across worktrees,
// which is the property dispatch-contract.md:212 rests on. The one place
// repository knowledge is already allowed to enter is the PROFILE, and the
// profile is part of the plan, so a declaration there keeps both properties
// (ADR §3).
//
// ---- Why this lives in lib.mjs (Issue #197) ---------------------------------
//
// Because a second runner now evaluates the same rules. `profile-init.mjs
// --check` counts, for each declared rule, how many real files in a repository
// tree its `when` matches and how many of the paths its `add` produces exist —
// which is the review question "is this rule doing anything?" that could
// previously only be answered by writing an issue fixture and reading
// `scope_defaults` out of a plan.
//
// A `--check` with its own reading of `{dir}` / `{base}` would make two truths
// out of one, and the divergence would be silent in the worst direction: a rule
// `--check` calls matched while the planner does not is precisely the "rule that
// never matches and never says so" the field's error handling is built around.
// So the vocabulary, the compiler and the matcher are written once, here, and
// both runners import them. The planner keeps only what is PLANNER POLICY —
// deduplication against paths it already has, the harness-template filter that
// depends on where a binding came from, and the `MAX_SCOPE_PATTERNS` bound.
//
// ---- The shape, and why this one -------------------------------------------
//
//   "scope_companions": {
//     "derive": [
//       { "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] }
//     ],
//     "require": [
//       { "when": "scripts/{dir}{base}.mjs", "add": ["scripts/tests/shared-contract.test.mjs"] }
//     ]
//   }
//
// A `derive` rule is a pair of PATH TEMPLATES over one shared vocabulary. `when` matches a
// DECLARED path and binds its placeholders; `add` re-emits those bindings into
// concrete paths. Two placeholders exist, and they are the two pieces a companion
// convention is ever a function of:
//
//   {dir}   zero or more path segments, each with its trailing "/" (so it is ""
//           at the repository root). This is what makes a MIRROR expressible:
//           `app/{dir}{base}.rb` -> `spec/{dir}{base}_spec.rb` moves
//           app/models/user.rb to spec/models/user_spec.rb, prefix stripped.
//   {base}  exactly one path segment. Normally the file's stem, because the
//           extension is written literally in the template — which is also why
//           there is no `{ext}` yet: one rule per extension is more explicit, and
//           adding `{ext}` later is a compatible widening (§15.2 of the ADR).
//
// The three invariants of ADR §2 are structural properties of this shape rather
// than checks bolted onto it:
//
//   1. DERIVED FROM THE DECLARATION. There is no glob syntax at all: `*`, `?` and
//      `[` are refused in both templates, and the only wildcards are placeholders,
//      whose captured text is LITERALLY A SUBSTRING OF A DECLARED PATH. An `add`
//      must carry at least one placeholder bound by its `when`, so no rule can
//      grant a path that does not contain a piece of a path the issue declared.
//      `**/*.test.*` and a bare `docs/module-reference.md` are both rejected at
//      load time. A profile therefore cannot re-open the hole #50 closed, and
//      |closure| <= (total `add` entries) x |declared| holds by construction.
//   2. VISIBLE. The derivation returns a list the caller appends to
//      `scope_defaults` and `suspected_files` in one statement, exactly as L1's
//      does — the two cannot drift apart.
//   3. A PURE FUNCTION OF THE PLAN. The input is the profile, which is part of
//      the plan; nothing is read from disk, nothing is sorted, no Set is walked.
//
// Invariant 3 is about the PLANNER's use of these functions. `--check` reads a
// repository tree by construction — that is what it is for — and it is a separate
// runner precisely so that reading one never happens on the planner's path
// (references/profile-contract.md §9.1 is unchanged).
//
// ---- `require`: the companion no template can name (Issue #181) -------------
//
// ADR §15.2 left the constant companion out of the first cut and named the two
// things that would bring it in: a real case, and a KEY OF ITS OWN, so that the
// key name states that the added path is not derived from the declaration. Both
// arrived.
//
// The case is the AGGREGATE test — one file checking several modules against a
// shared contract, `scripts/tests/shared-contract.test.mjs`. Its name
// corresponds to no source name BY CONSTRUCTION; that is what makes it
// aggregate. L1 cannot reach it (L1 derives the conventional test path OF a
// source file) and neither can `derive` (every `add` there is a function of the
// declared path), so the only channel left was the issue body — which measured,
// on a live repository, as a standing instruction to every author of a
// `scripts/**` issue to write the path out by hand, and a worker losing its run
// to the scope gate whenever somebody forgot.
//
// A `require` rule is the same `{when, add}` pair with the roles of the two
// halves split: `when` still has to match a DECLARED path, so nothing is granted
// unconditionally and the closure is still bounded by what the issue declared,
// while `add` holds LITERAL paths and no placeholders at all.
//
// This does NOT loosen `derive`. A placeholder-free `add` is still a load_error
// there, and each key refuses the other's shape:
//
//   derive[].add    must carry >= 1 placeholder, every one bound by its `when`
//   require[].add   must carry ZERO placeholders, and each entry must be a
//                   repository-relative path outside the agent harness
//
// That pair is what keeps a MISTYPED TEMPLATE from silently becoming a literal —
// the one degradation this key could otherwise introduce. Braces are never
// ambiguous to begin with: parseCompanionTemplate tokenizes every `{...}` in
// both keys and refuses an unknown name or an unbalanced brace, so `{Base}`,
// `{ext}` and `{base` cannot be re-read as text anywhere. What remains is the
// typo that DROPS the braces — `spec/dir/base_spec.rb` written for
// `spec/{dir}{base}_spec.rb` — and that one is caught by the key it sits under:
// refused in `derive`, and legal only after being MOVED to a key whose name says
// the path is fixed. The discrimination is the author's stated intent, not a
// guess about the content.
//
// What none of that catches is the rule that is WELL FORMED AND MATCHES NOTHING,
// which is the gap Issue #197 opened `--check` for. It is not a load error —
// a declaration written ahead of the files it describes is legitimate — so it is
// reported, by a runner a human runs, and never adjudicated.
//
// Invariant 1 is genuinely weaker for `require` than for `derive`: a literal is
// not a function of the declared path, only gated on one. That is precisely why
// it is a separate key and not a widening of `add` — the strong statement holds
// where it was made, and the weaker one is legible at every use site. The bound
// is unchanged: |closure| <= (total `add` entries) x |declared|. Invariants 2
// and 3 hold identically — the literals join the same single list the caller
// appends to `scope_defaults` and `suspected_files`, and nothing is read from
// disk.
//
// Still out, for the reasons in ADR §15.2 and §18: an `{ext}` placeholder,
// per-rule exclusions, and any form that lets `when` match something other than
// a declared path. `require` did not touch that last one, which is what keeps
// "a profile cannot grant a path no issue asked for" true.

// The wildcard vocabulary. Order matters only for the error message; the regex
// fragments are what a `when` template compiles to. `{dir}` is greedy so
// `src/{dir}{base}.ts` reads `src/a/b/c.ts` as dir="a/b/", base="c" — the same
// split a human makes.
const COMPANION_PLACEHOLDERS = {
  dir: '((?:[^/]+/)*)',
  base: '([^/]+)',
};

// Anything brace-shaped is a placeholder attempt. Captured loosely on purpose:
// `{Base}` and `{ext}` must be REFUSED, not silently treated as literal text —
// a typo that becomes a literal is a rule that never matches and never says so.
const COMPANION_TOKEN_RE = /\{([^{}]*)\}/g;

// Glob metacharacters, refused in both templates. This is the check that makes
// "a profile cannot write a bare glob" true rather than merely discouraged.
const COMPANION_GLOB_RE = /[*?[\]]/;

// Every refusal in this section is `load_error` (exit 6), the same code an
// unknown profile field gets, and it names the FIELD rather than a runner: a
// declaration one reader had to repair is a declaration whose author should be
// told, and both readers must say the same thing about it.
export function companionError(detail) {
  return new SkillError('load_error', `profile.scope_companions: ${detail}`, 6);
}

// Splits a template into literal spans and placeholder names. Throws load_error
// on anything that is not a well-formed template, so a malformed declaration is
// refused where the profile is read rather than producing a rule that quietly
// matches nothing.
export function parseCompanionTemplate(text, label) {
  if (typeof text !== 'string' || text.length === 0) {
    throw companionError(`${label} must be a non-empty string`);
  }
  if (COMPANION_GLOB_RE.test(text)) {
    throw companionError(
      `${label} "${text}" contains a glob metacharacter; companions are derived from declared paths, ` +
        'never matched by a pattern of their own (adr-scope-derivation.md §2, invariant 1). ' +
        // A `when` is where an author reaches for a glob, and the two shapes they
        // reach for have exact spellings in this vocabulary. Issue #181 proposed
        // its own rule as `"when": "scripts/**"`, so the message that refuses it
        // has to carry the translation rather than leave the author guessing
        // which of `{dir}` / `{base}` covers a whole subtree.
        'In a "when", write "{dir}{base}" where you would write "**" and "{base}" where you would write "*"',
    );
  }
  if (text.startsWith('/') || text.includes('..') || text.includes('\\')) {
    throw companionError(`${label} "${text}" must be a relative repository path with no ".." segment`);
  }
  const parts = [];
  const names = [];
  let cursor = 0;
  for (const match of text.matchAll(COMPANION_TOKEN_RE)) {
    const name = match[1];
    if (!Object.prototype.hasOwnProperty.call(COMPANION_PLACEHOLDERS, name)) {
      throw companionError(
        `${label} "${text}" uses unknown placeholder "{${name}}"; the placeholders are ` +
          Object.keys(COMPANION_PLACEHOLDERS).map((key) => `{${key}}`).join(' / '),
      );
    }
    if (match.index > cursor) parts.push({ literal: text.slice(cursor, match.index) });
    parts.push({ name });
    names.push(name);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ literal: text.slice(cursor) });
  // A stray brace left in a literal span means the template was not fully
  // tokenized (`{dir` , `dir}`), which is a typo, not a path.
  for (const part of parts) {
    if (part.literal !== undefined && /[{}]/.test(part.literal)) {
      throw companionError(`${label} "${text}" has an unbalanced brace`);
    }
  }
  return { parts, names };
}

// Validates the declaration and returns it in canonical form, or null when the
// profile does not carry the key.
//
// `checkLiteral` is the one refusal this module does not own. It is called for
// every `require[].add` entry, in written order, at the point the per-template
// loop reaches it, and the planner passes the predicate that decides whether a
// literal is repository-relative at all (`users/…`, `C:/…`, `https://…` — a
// vocabulary whose constant, SYSTEM_ROOTS, is byte-mirrored by
// cmate-issue-authoring and therefore has to stay declared in orchestrate.mjs;
// see tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs). A caller that
// passes nothing — `profile-init.mjs --check`, which grants no permissions —
// skips exactly that refusal and reports the literal as a path that does not
// exist in the tree, which is what it is. Everything else, including the harness
// boundary of §9.6, is enforced for every caller.
export function normalizeScopeCompanions(raw, { checkLiteral } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw companionError('must be a JSON object');
  }
  // An OBJECT rather than a bare list, so a later layer of this feature arrives
  // as a sibling KEY instead of overloading the meaning of the list. `require`
  // (Issue #181) is that mechanism used once, exactly as ADR §15.2 said the
  // constant companion would have to arrive. Unknown keys are refused for the
  // reason profile fields are: a newer profile must fail loudly on an older
  // runner, never have half of itself ignored.
  for (const key of Object.keys(raw)) {
    if (key !== 'derive' && key !== 'require') {
      throw companionError(`unknown key "${key}"; the keys are "derive" and "require"`);
    }
  }
  // Both keys are optional and ABSENCE IS PRESERVED — the canonical form carries
  // only what the profile wrote, so a `derive`-only declaration echoes into the
  // plan as the same bytes it did before `require` existed. A key filled in with
  // an empty list would be a byte in `plan.profile` that was never in the
  // profile, which is the compatibility property fixture 45 measures one level
  // up (see the ABSENT-stays-absent note in normalizeProfile).
  if (raw.derive === undefined && raw.require === undefined) {
    throw companionError(
      'must declare "derive" and/or "require"; an empty object states nothing about the repository, ' +
        'where {"derive": []} states that there is no convention to declare',
    );
  }
  const out = {};
  if (raw.derive !== undefined) out.derive = normalizeCompanionRules(raw.derive, 'derive', checkLiteral);
  if (raw.require !== undefined) out.require = normalizeCompanionRules(raw.require, 'require', checkLiteral);
  return out;
}

// One validator for both keys, because everything except the `add` side is the
// same statement: a rule is `{when, add}`, `when` is a template over the shared
// vocabulary, and `add` is a non-empty list. `kind` decides the two rules that
// differ, and both are stated as REFUSALS so that neither key can quietly accept
// what the other's typo produces.
function normalizeCompanionRules(rawRules, kind, checkLiteral) {
  if (!Array.isArray(rawRules)) throw companionError(`"${kind}" must be an array of rules`);
  const rules = [];
  for (const [index, rule] of rawRules.entries()) {
    const at = `${kind}[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw companionError(`${at} must be a JSON object`);
    }
    for (const key of Object.keys(rule)) {
      if (key !== 'when' && key !== 'add') throw companionError(`${at} has an unknown key "${key}"`);
    }
    const when = parseCompanionTemplate(rule.when, `${at}.when`);
    // A `when` that binds nothing is a rule that can only match one fixed path.
    // In `derive` that is a contradiction — there would be no binding to write
    // back, so the `add` could not be a function of the declaration and would be
    // refused below anyway. In `require` it is a COMPLETE rule: "if the issue
    // declares this file, it may also touch that one", still gated on the
    // declaration, and the most precise gate an author can write.
    if (kind === 'derive' && when.names.length === 0) {
      throw companionError(
        `${at}.when "${rule.when}" binds no placeholder, so it can only match one fixed path; ` +
          'a rule that adds nothing derived from the declaration is not a companion rule ' +
          '(a fixed "when" is legal under "require", whose "add" is a literal path)',
      );
    }
    // Refused in both keys. The compiler gives each placeholder its own capture
    // group rather than requiring the two to be equal, so a repeat does not mean
    // what it looks like it means in either key.
    if (new Set(when.names).size !== when.names.length) {
      throw companionError(`${at}.when "${rule.when}" repeats a placeholder; each may appear once`);
    }
    if (!Array.isArray(rule.add) || rule.add.length === 0) {
      throw companionError(`${at}.add must be a non-empty array of path templates`);
    }
    const bound = new Set(when.names);
    for (const template of rule.add) {
      const parsed = parseCompanionTemplate(template, `${at}.add`);
      if (kind === 'derive') {
        if (parsed.names.length === 0) {
          throw companionError(
            `${at}.add "${template}" contains no placeholder, so it would grant a path unrelated to ` +
              'anything the issue declared (adr-scope-derivation.md §2, invariant 1). ' +
              'A companion whose name is genuinely fixed — an aggregate contract test, a required ' +
              'document — is declared under "require", where the path is literal by definition',
          );
        }
        for (const name of parsed.names) {
          if (!bound.has(name)) {
            throw companionError(`${at}.add "${template}" uses {${name}}, which its "when" does not bind`);
          }
        }
      } else {
        // The inverse refusal, and the reason a dropped-braces typo cannot cross
        // between the keys: a template written here is a `derive` rule filed
        // under the wrong key, and emitting it would put the characters
        // "{base}" into a worker's scope.allow.
        if (parsed.names.length > 0) {
          throw companionError(
            `${at}.add "${template}" must be a literal path: a "require" companion is granted as written, ` +
              `so it has no binding to expand {${parsed.names[0]}} from. Move the rule to "derive" if the ` +
              'path is a function of the declared one',
          );
        }
        // A literal is the ONLY companion shape not built out of a path the
        // extraction already vetted, so it is the only one that could name
        // something outside the repository. Without this, a profile is a path
        // traversal: `users/<someone>/…` is repository-relative in form and
        // absolute in effect. `..`, a leading "/" and a backslash are refused by
        // the template parser above; a system root, a drive letter and a URL host
        // are refused only by the caller's predicate.
        if (checkLiteral !== undefined) checkLiteral(template, at);
        // Issue #177's boundary, held on the profile side. The harness deny-list
        // is what protects the judge from the judged, and #177 refused to make it
        // declarable precisely so that a `scope_companions`-style key could not
        // become its second, quieter door. Refused at LOAD because a literal is
        // decidable here, and because a rule silently dropped later is a rule
        // that never says so. The escape hatch is unchanged and stays in the
        // issue body, where a warning is attached to using it.
        if (isHarnessPath(template)) {
          throw companionError(
            `${at}.add "${template}" is part of the agent harness ` +
              `(${HARNESS_PATH_PREFIXES.join(' / ')}) — the Skill packages the worker and its verifier are, ` +
              'and the config that decides what "verified" means. The planner keeps those out of scope.allow ' +
              'by default (Issue #177) and a profile may not re-grant them: the issue that really must edit ' +
              'one names it under a deliverable heading, which is reported as harness_path_in_scope',
          );
        }
      }
    }
    rules.push({ when: String(rule.when), add: rule.add.map(String) });
  }
  return rules;
}

// Turns a validated declaration into matchers. Cannot throw: every template here
// already passed normalizeScopeCompanions.
//
// The two keys compile to ONE ordered list, `derive` first, because a rule is a
// rule once its `add` is a list of template parts: a literal `add` is simply a
// parts list with no placeholder in it, and the emitter below treats it that way
// without a branch. Declaration order is preserved so the derivation stays a
// pure function of (plan, profile).
//
// Each compiled rule also carries where it came from — `key`, `index`, and the
// SOURCE text of `when` and each `add`. The planner ignores all four; they exist
// so `--check` can report per rule, in the author's own words, without keeping a
// parallel copy of the declaration and risking the two falling out of step.
export function compileScopeCompanions(declaration) {
  if (!declaration) return [];
  const rules = [
    ...(declaration.derive ?? []).map((rule, index) => ({ rule, key: 'derive', index })),
    ...(declaration.require ?? []).map((rule, index) => ({ rule, key: 'require', index })),
  ];
  return rules.map(({ rule, key, index }) => {
    const when = parseCompanionTemplate(rule.when, 'when');
    const source = when.parts
      .map((part) => (part.name === undefined
        ? part.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : COMPANION_PLACEHOLDERS[part.name]))
      .join('');
    return {
      key,
      index,
      when: rule.when,
      addTemplates: rule.add.map(String),
      match: new RegExp(`^${source}$`),
      names: when.names,
      add: rule.add.map((template) => parseCompanionTemplate(template, 'add').parts),
    };
  });
}

// THE matcher. Every companion the compiled rules produce for ONE path, rule by
// rule in declaration order and then `add` by `add` in written order, each paired
// with the rule that produced it and the index of the template inside that rule.
//
// Nothing is filtered, deduplicated, sorted or bounded here, and that is the
// whole of the division of labour: what a rule SAYS about a path is this
// function, and what a caller then DOES with the answer is the caller's. The
// planner drops harness expansions and stops at MAX_SCOPE_PATTERNS; `--check`
// counts. Neither policy can change what "matches" means for the other.
export function companionsForPath(rules, path) {
  const out = [];
  for (const rule of rules) {
    const matched = rule.match.exec(path);
    if (matched === null) continue;
    const binding = {};
    rule.names.forEach((name, index) => { binding[name] = matched[index + 1]; });
    for (const [at, parts] of rule.add.entries()) {
      out.push({
        rule,
        at,
        companion: parts
          .map((part) => (part.name === undefined ? part.literal : binding[part.name]))
          .join(''),
      });
    }
  }
  return out;
}

// =============================================================================
// Upstream-fault signatures (Issue #220)
// =============================================================================
//
// The text a CLI leaves on its own screen when the fault is UPSTREAM of it — the
// API refused, is refusing, or is still being retried — as opposed to anything
// the worker itself wrote. dispatch reads these at the `--max-turns` cap to tell
// "the worker ran N turns and produced nothing" from "the worker never got a
// turn", because the recovery for the two is opposite: split the Issue vs. wait
// and `--resume` (MEASURED: Kewton/CommandMate#1834 — `API Error: 529 Overloaded`
// 13 times in a row, reported as "12 turns, no work evidence").
//
// The same four signatures live in two other places and are deliberately COPIED
// rather than shared:
//   - skills/cmate-orchestrate-monitor/scripts/monitor-lib.sh (`ml_has_terminal_api_error`
//     / `ml_has_rate_limit`) — shell, and CommandMate's sync-map pins its sha256
//   - CommandMate's own `UPSTREAM_FAULTS` (canary expectations; since #1839 also
//     `src/lib/detection/upstream-faults.ts`, surfaced as `capture --json`'s
//     `upstreamFault`)
// A shell script and an ES module cannot share a constant, and pinning this
// runner to a CommandMate version that exposes the field would make an OLD CLI
// unreadable rather than merely less informative. So: read `upstreamFault` when
// the CLI offers it, and keep this list for when it does not.
//
// The monitor's BROADER banner list (`usage limit reached` / `rate_limit_error` /
// `429 too many requests` / `1M context credits` / …) is not copied wholesale on
// purpose. monitor.sh uses it to decide whether to SEND a key; this list decides
// how to LABEL a run that already ended, and a wider net here would relabel a
// worker that merely printed the words. `\blimit reached\b` already covers the
// `usage limit reached` / `retry limit reached` wordings.
export const UPSTREAM_FAULT_SIGNATURES = [
  { id: 'overloaded', pattern: /\b5\d{2}\s+Overloaded\b/i },
  { id: 'retrying', pattern: /\bRetrying in \d+s\b[^\n]{0,24}\battempt \d+\/\d+/i },
  { id: 'limit_reached', pattern: /\blimit reached\b/i },
  { id: 'api_error', pattern: /\bAPI Error(?::|\s+\d{3})/i },
];

// The FIRST signature that matches, with the text it matched — the matched text
// is what a report transcribes, so `upstream_signature` quotes the CLI rather
// than naming a regex the reader cannot see. Returns null when nothing matches;
// a non-string is "nothing to read", never a match.
export function matchUpstreamFault(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const { id, pattern } of UPSTREAM_FAULT_SIGNATURES) {
    const found = pattern.exec(text);
    if (found !== null) return { id, matched: found[0] };
  }
  return null;
}

// scope patterns — the glob vocabulary CommandMate's scope gate adjudicates by
// (Issue #219)
// =============================================================================
//
// A third entry that was never a copy, for the same reason `resolveLauncher` and
// the `scope_companions` matcher are here: the answer to "is this changed path
// inside the declared scope?" is given TWICE in this package — merge.mjs prints
// it in the PR body, and the planner uses the same relation to decide which two
// issues may not share a wave — and it is adjudicated a THIRD time, upstream, by
// CommandMate's scope gate. Three implementations of one relation is three
// verdicts that can disagree, and the disagreement is silent in the direction
// that costs the most: merge reporting a change as in-scope that the gate then
// fails, or the planner putting two issues that write the same files into one
// wave because it compared their declarations as literal strings.
//
// So the subset below is a PORT, not an invention. It follows
// CommandMate `src/lib/verification/scope-gate.ts` `globToRegExp` (#1546), whose
// semantics are fixed in that repository's `docs/design/task-contract.md` §2.2:
//
//   * `**` as a whole segment crosses directory boundaries, including zero of
//     them: `a/**` matches `a/b` and `a/b/c`; `**` that is not a whole segment
//     (`a**b`) collapses to a single-segment wildcard.
//   * `*` and `?` never cross `/`.
//   * `{a,b}` is alternation and nests. UNBALANCED braces are literal, as in a
//     shell — `src/{a` is a path with a brace in it, not a syntax error.
//   * `[` and `]` are LITERAL. Next.js routes (`src/app/[...path]/page.tsx`) are
//     the shape that decided it upstream: reading those as character classes
//     makes the pattern that names them match nothing, and a silent no-match is
//     the failure this relation exists to prevent.
//   * A pattern that matches a directory matches everything beneath it, so
//     `src/lib`, `src/lib/` and `src/lib/**` all mean the same thing. Without
//     this, `allow: ["src/lib"]` — how people write a directory — would put
//     every file inside it out of scope.
//
// What is NOT here: expansion. Nothing in this package opens a working tree to
// enumerate what a pattern covers (ADR §2, invariant 3 — the contract is a pure
// function of the plan). Every comparison below is string against string.
const SCOPE_PATTERN_META_RE = /[*?{]/;

// Compiled per call. The lists this package compares are an issue's declared
// scope (bounded by MAX_SCOPE_PATTERNS) against one change set, so caching would
// buy a table to invalidate and nothing else; CommandMate caches because it
// evaluates the same declaration against thousands of paths.
function globToRegExp(rawPattern) {
  // A trailing slash carries no information once the directory rule applies.
  const pattern = rawPattern.replace(/\/+$/, '');
  let depth = 0;
  let balanced = 0;
  for (const char of pattern) {
    if (char === '{') balanced += 1;
    else if (char === '}') { balanced -= 1; if (balanced < 0) break; }
  }
  const bracesBalanced = balanced === 0;

  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      let end = i;
      while (pattern[end] === '*') end += 1;
      const isGlobstar = end - i > 1;
      const atSegmentStart = i === 0 || pattern[i - 1] === '/';
      if (isGlobstar && atSegmentStart && pattern[end] === '/') {
        // The following slash is consumed too: `a/**/b` has to match `a/b`.
        source += '(?:[^/]*/)*';
        i = end + 1;
        continue;
      }
      if (isGlobstar && atSegmentStart && end === pattern.length) {
        source += '.*';
        i = end;
        continue;
      }
      source += '[^/]*';
      i = end;
      continue;
    }
    if (char === '?') { source += '[^/]'; i += 1; continue; }
    if (bracesBalanced && char === '{') { depth += 1; source += '(?:'; i += 1; continue; }
    if (bracesBalanced && char === '}' && depth > 0) { depth -= 1; source += ')'; i += 1; continue; }
    if (bracesBalanced && char === ',' && depth > 0) { source += '|'; i += 1; continue; }
    source += char.replace(/[.*+?^${}()|[\]\\]/, '\\$&');
    i += 1;
  }
  return new RegExp(`^${source}(?:/.*)?$`);
}

// Is `path` inside the single scope entry `pattern`? The entry may be a plain
// path, a directory, or a glob; `path` is a repository-root-relative POSIX path
// as git reports it.
export function scopeMatches(pattern, path) {
  if (pattern === path) return true;
  try {
    return globToRegExp(pattern).test(path);
  } catch {
    // A pattern this port cannot compile is not a pattern that matches
    // everything. Refusing here is the fail-closed direction: the caller reports
    // an out-of-scope change or an absent conflict, both of which a human sees.
    return false;
  }
}

// The literal prefix a pattern can never escape: everything before its first
// metacharacter, cut back to the last `/` so the prefix ends on a segment
// boundary. A metacharacter-free entry is its own prefix plus `/`, because such
// an entry is also a directory (the rule above). `**/x.ts` has no static prefix
// at all and therefore yields `''`, which is a prefix of everything.
function scopeStaticPrefix(pattern) {
  const meta = pattern.search(SCOPE_PATTERN_META_RE);
  if (meta === -1) return `${pattern}/`;
  const cut = pattern.lastIndexOf('/', meta);
  return cut === -1 ? '' : pattern.slice(0, cut + 1);
}

// Can two scope entries name the same file? Used to decide whether two issues
// may share a wave, so the two failure directions are NOT symmetric: a false
// positive costs one wave of parallelism, a false negative sends two workers at
// one file and the damage surfaces at merge (#175). Undecidable pairs therefore
// answer "yes".
//
//   * plain vs plain — equality, or one is a directory containing the other.
//     This is the relation the planner already had, plus the directory case it
//     did not (`src/lib` beside `src/lib/a.ts` used to read as disjoint).
//   * glob vs plain — the glob matches the plain entry, or the plain entry is a
//     directory the glob's static prefix sits under (`src` beside `src/**/*.ts`:
//     the glob matches nothing named `src`, yet every file it covers is inside).
//   * glob vs glob — undecidable in general without a tree, so static prefix
//     containment decides it. `data/geo/**` and `data/geo/landmarks/*.json`
//     conflict; `data/geo/landmarks/*.json` and `data/geo/stations/*.json` do
//     not.
export function scopeEntriesOverlap(left, right) {
  const a = String(left).replace(/\/+$/, '');
  const b = String(right).replace(/\/+$/, '');
  if (a === b) return true;
  const aGlob = SCOPE_PATTERN_META_RE.test(a);
  const bGlob = SCOPE_PATTERN_META_RE.test(b);
  if (!aGlob && !bGlob) return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (aGlob !== bGlob) {
    const glob = aGlob ? a : b;
    const plain = aGlob ? b : a;
    return scopeMatches(glob, plain) || scopeStaticPrefix(glob).startsWith(`${plain}/`);
  }
  const prefixA = scopeStaticPrefix(a);
  const prefixB = scopeStaticPrefix(b);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

// Does this entry grant the whole repository? `**`, `*`, `**/*`, `.` and `./`
// all compile to a regex that matches every path, so a contract carrying one has
// no scope gate at all — the entry is refused rather than sent (`over_broad`).
//
// The rule is deliberately about the WHOLE entry: `src/**` keeps its meaning,
// and `**/*.json` is a real declaration (every JSON file) rather than a blanket
// one. Only an entry whose every segment is `*` or `**` — or which is the
// repository root written as `.` — is refused.
export function isOverBroadScope(pattern) {
  const trimmed = String(pattern).replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '.') return true;
  return trimmed.split('/').every((segment) => segment === '*' || segment === '**');
}

// =============================================================================
// .commandmate/verify.yaml — the gate table both judges read
// =============================================================================
//
// Hoisted out of dispatch.mjs for the reason the scope_companions block above was
// (Issue #218): a SECOND reader appeared. dispatch resolves the ids an issue's
// `require:` names against the worktree; `inspect.mjs --evaluate-gates` has to
// run the COMMAND behind each of those ids against the base before dispatch.
// Two parsers of one YAML subset are two parsers that can disagree about what a
// repository declared, and the disagreement would be silent — inspect reporting
// `gate_id_unresolved` for an id dispatch resolves happily is exactly the
// "we could not look" dressed up as "we looked" that both runners refuse.
//
// The subset is the one cmate-verify's verify-run.sh awk parser accepts —
// 2-space indent, single-line scalars, comments on their own line, no tabs, no
// anchors, no flow collections, no block scalars — so all three readers agree on
// what the file says.
//
// FAIL-CLOSED: anything the subset cannot read returns an error rather than a
// partial gate set. An unreadable config would otherwise make a required gate
// look absent (dispatch refused for the wrong reason) or, worse, make the id set
// look complete when it is not.
//
// Behaviour-preserving by construction: `ids` is pushed in the same places, in
// the same order, and every refusal is the byte the previous reader wrote. What
// is new is `gates[]`, which carries `command` and `timeoutSec` beside the id.
// dispatch does not read it — it resolves names, it does not run them.
export const VERIFY_CONFIG_RELATIVE = '.commandmate/verify.yaml';

// CommandMate's GATE_ID_PATTERN, transcribed. Kept local rather than shared with
// the acceptance-gates notation's copy for the reason this module's header
// gives: only a byte-identical copy is hoisted, and these two are checked
// against different documents.
const VERIFY_GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function readVerifyConfigGates(rootPath) {
  const path = join(rootPath, VERIFY_CONFIG_RELATIVE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: error.code === 'ENOENT'
        ? `${VERIFY_CONFIG_RELATIVE} does not exist in the worktree, so no gate id can be resolved`
        : `${VERIFY_CONFIG_RELATIVE} could not be read (${error.code ?? 'error'})`,
    };
  }
  const bad = (reason) => ({ ok: false, reason: `${VERIFY_CONFIG_RELATIVE}: ${reason}` });
  const ids = [];
  const gates = [];
  let section = '';
  let sawVersion = false;
  let gateOpen = false;
  // One `key: value` of the gate entry that is currently open. Unknown keys
  // (`mutex`, `retryOnFail`, `flakyIsPass`, anything upstream adds later) are
  // carried by neither reader: this one runs the command, and none of them
  // changes what the command IS.
  const field = (key, rawValue) => {
    const entry = gates[gates.length - 1];
    if (entry === undefined) return;
    const value = unquoteYaml(rawValue);
    if (key === 'id') entry.id = value;
    else if (key === 'command') entry.command = value;
    else if (key === 'timeoutSec') entry.timeoutSec = /^[0-9]+$/.test(value) ? Number(value) : null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.includes('\t')) return bad('tab characters are not allowed');
    if (/^[ ]*$/.test(line)) continue;
    if (/^[ ]*#/.test(line)) continue;
    const indent = line.length - line.replace(/^ +/, '').length;
    if (indent % 2 !== 0) return bad('indentation must be a multiple of 2 spaces');
    const body = line.slice(indent);

    if (indent === 0) {
      gateOpen = false;
      const colon = body.indexOf(':');
      if (colon <= 0) return bad(`expected "key: value" at the top level, got "${body.slice(0, 40)}"`);
      const key = body.slice(0, colon).trim();
      const value = body.slice(colon + 1).trim();
      if (key === 'version') {
        sawVersion = true;
        if (unquoteYaml(value) !== '1') return bad(`version must be 1 (got "${value}")`);
        section = '';
      } else if (key === 'gates') {
        if (value !== '') return bad('gates: must be followed by an indented list');
        section = 'gates';
      } else if (key === 'options') {
        if (value !== '') return bad('options: must be followed by indented keys');
        section = 'options';
      } else {
        return bad(`unknown top-level key "${key}"`);
      }
      continue;
    }
    // An indented line with nothing open above it is a shape this reader does not
    // understand, and the sibling awk parser rejects it too. Skipping it would be
    // the one way a gate id could go unseen, which is the failure mode fail-closed
    // exists to prevent.
    if (section === '') return bad('indented line outside of gates: / options:');
    if (section !== 'gates') continue; // options and their nested keys carry no id
    if (indent === 2) {
      if (!body.startsWith('- ')) return bad('gate list items must start with "- "');
      gateOpen = true;
      const first = body.slice(2).trim();
      const colon = first.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      const key = first.slice(0, colon).trim();
      gates.push({ id: null, command: null, timeoutSec: null });
      if (key === 'id') ids.push(unquoteYaml(first.slice(colon + 1).trim()));
      field(key, first.slice(colon + 1).trim());
      continue;
    }
    if (indent === 4) {
      if (!gateOpen) return bad('gate field outside of a list item');
      const colon = body.indexOf(':');
      if (colon <= 0) return bad('expected "key: value" inside a gate');
      const key = body.slice(0, colon).trim();
      if (key === 'id') ids.push(unquoteYaml(body.slice(colon + 1).trim()));
      field(key, body.slice(colon + 1).trim());
      continue;
    }
    return bad(`unexpected indentation (${indent} spaces)`);
  }
  if (!sawVersion) return bad('missing top-level "version: 1"');
  if (ids.length === 0) return bad('no gate is declared');
  for (const id of ids) {
    if (!VERIFY_GATE_ID_RE.test(id)) return bad(`declared gate id "${id}" does not match ${VERIFY_GATE_ID_RE.source}`);
  }
  return { ok: true, ids, gates };
}

// The single- or double-quoted scalar forms the subset allows. A value with no
// quotes is returned unchanged.
export function unquoteYaml(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// ---- end of the verify.yaml reader ------------------------------------------
//
// tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs slices
// the region ABOVE this line out of this file and runs it, function for function
// and over a corpus, against cmate-issue-authoring's mirror of the same parser
// (`validate-plan.mjs`'s `checkoutGateIds`). Anything added above this line has
// to be added to that mirror in the SAME commit
// (references/acceptance-gates-notation.md §10); anything added below it is
// outside the comparison.

// observations — what to measure on the base branch AFTER the merge (Issue #221)
// =============================================================================
//
// The optional profile field `observations` declares measurements that cannot be
// taken inside a worktree: "the CI wall clock of the merged base", "the seconds
// the e2e STEP takes", "the bundle size of the merged tree". `uat.mjs` cannot
// answer any of them — it runs the profile baseline in the issue's own worktree,
// before the merge (uat-contract.md) — so the declaration is read by a separate
// post-merge runner (`observe.mjs`, references/observe-contract.md).
//
// It lives in lib.mjs rather than in the planner for the reason this module is
// maintained by: TWO runners read the vocabulary. The planner validates it and
// freezes it into `plan.profile`, and `observe.mjs --profile <path>` reads a
// profile file directly for the case the plan predates the declaration. A second
// copy of these rules is a second opinion about what a declaration MEANS, and the
// disagreement would be silent — a profile the planner refuses being accepted by
// the observer, or the reverse.
//
// WHAT IS DELIBERATELY NOT HERE: how a kind is COLLECTED. That is observe.mjs's
// alone. This file decides only whether a declaration is well formed, which is
// the half the planner has to decide without ever running `gh`.
export const OBSERVATION_KINDS = new Map([
  // kind          keys that MUST be present, in the order they are echoed
  ['gh_run', ['workflow']],
  ['gh_job_step', ['workflow', 'job', 'step']],
  ['command', ['command']],
]);

// Same shape as a run id (makeRunId) and for the same reason: the value is used
// as a lookup key across documents — the observation's own report, and the
// `--inspect` artifact a "before" value is matched out of — so it has to survive
// a round trip through a filename and a JSON key without being quoted.
const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function observationError(detail) {
  return new SkillError('load_error', detail, 6);
}

// ABSENT stays absent (`undefined` in, `null` out), exactly as `scope_companions`
// / `dispatch_defaults` / `integration_baseline` do: a profile written before this
// field existed must produce the plan bytes it always produced.
//
// A declared `[]` is NOT normalized away either. It states "this repository has
// nothing to observe after a merge", and observe.mjs refuses on it by name rather
// than reporting a run in which zero observations were collected — the same
// distinction `integration_baseline: []` carries.
//
// Every entry is REBUILT field by field in one fixed key order. The plan's bytes
// are the run id's input (canonicalInputSignature), so a hand-written profile
// whose keys are in another order must not fork the run id.
export function normalizeObservations(raw) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw observationError(
      `profile.observations must be an array of declarations, got ${JSON.stringify(raw)}. `
        + 'Omit the key entirely to declare nothing; declare `[]` to state that this repository has no '
        + 'post-merge observation (which observe.mjs then refuses by name rather than reporting an empty run)',
    );
  }
  const out = [];
  const seen = new Set();
  for (const [index, entry] of raw.entries()) {
    const at = `profile.observations[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw observationError(`${at} must be an object, got ${JSON.stringify(entry)}`);
    }
    const id = entry.id;
    if (typeof id !== 'string' || !OBSERVATION_ID_RE.test(id)) {
      throw observationError(
        `${at}.id must be a short token matching ${OBSERVATION_ID_RE.source}, got ${JSON.stringify(id)}`,
      );
    }
    if (seen.has(id)) {
      // Two declarations under one id would make "the value of `ci-wallclock`"
      // ambiguous in the report AND in the `--inspect` lookup, which is exactly
      // the confusion an id exists to remove.
      throw observationError(`${at}.id "${id}" is declared twice; an observation id names one measurement`);
    }
    seen.add(id);
    const kind = entry.kind;
    if (typeof kind !== 'string' || !OBSERVATION_KINDS.has(kind)) {
      throw observationError(
        `${at}.kind ${JSON.stringify(kind)} is not one of ${[...OBSERVATION_KINDS.keys()].join(' / ')}. `
          + 'An unknown kind is refused rather than skipped: a run that silently dropped it would report '
          + 'a complete observation set that is missing the measurement the author asked for',
      );
    }
    const required = OBSERVATION_KINDS.get(kind);
    const normalized = { id, kind };
    for (const key of required) {
      const value = entry[key];
      if (typeof value !== 'string' || value.trim() === '') {
        throw observationError(`${at}.${key} is required for kind "${kind}" and must be a non-empty string`);
      }
      normalized[key] = value;
    }
    const unit = entry.unit;
    if (typeof unit !== 'string' || unit.trim() === '') {
      // The unit is required, not defaulted. A number whose unit the reader has
      // to infer is how "446" and "446000" end up in the same table — and this
      // runner never converts, so the unit is the only thing that says which.
      throw observationError(`${at}.unit is required and must be a non-empty string (e.g. "s", "bytes")`);
    }
    normalized.unit = unit;
    const allowed = new Set(['id', 'kind', 'unit', ...required]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throw observationError(
          `${at} has an unknown field "${key}" for kind "${kind}" (accepted: ${[...allowed].join(', ')})`,
        );
      }
    }
    out.push(normalized);
  }
  return out;
}

// =============================================================================
// pr_title_template — the PR title the merge runner writes (CommandMate#3005)
// =============================================================================
//
// MEASURED (Kewton/Musunest, run plan-01ba9bc589cb, #248). `merge.mjs --create-prs`
// titled every PR with the issue title verbatim. That repository requires a
// Conventional-Commits PR title in CI (semantic-pull-request), and a squash merge
// makes the PR title the commit subject, so every PR this runner opened was one
// the repository could not merge. The workers were therefore told to push and
// open the PRs themselves — the double-PR path cmate-worker-development §4 exists
// to close. The fix is to let the repository say what its titles look like.
//
// The placeholders are a CLOSED set, and an unknown one is refused rather than
// left in the title: a PR titled `{{kind}}: …` is a title nobody meant.
//   {{type}} / {{scope}}  from the branch's own commit subjects (merge.mjs
//                         resolvePrTitle). Never guessed: when the commits do not
//                         determine them, no PR is opened.
//   {{title}}             the issue title (the pre-#3005 PR title).
//   {{number}}            the issue number.
//
// Shared by the planner (load_error / exit 6, about the profile file) and the
// merge runner (plan_invalid / exit 3, about the plan file), for the reason
// profile-contract.md §10.2 gives for dispatch_defaults: the same rule, reported
// against the file the reader has to open.
export const PR_TITLE_PLACEHOLDERS = ['type', 'scope', 'title', 'number'];
const PR_TITLE_TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const MAX_PR_TITLE_TEMPLATE = 200;

export function prTitlePlaceholders(template) {
  return [...template.matchAll(PR_TITLE_TOKEN_RE)].map((match) => match[1]);
}

export function normalizePrTitleTemplate(raw, where, code, exitCode) {
  if (raw === undefined) return null;
  const fail = (why) => new SkillError(code, `${where} ${why}`, exitCode);
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw fail(`must be a non-empty string such as "{{type}}({{scope}}): {{title}} (#{{number}})", got ${JSON.stringify(raw)}. `
      + 'Omit the key to keep the issue title as the PR title');
  }
  if (raw.length > MAX_PR_TITLE_TEMPLATE || /[\r\n]/.test(raw)) {
    throw fail(`must be a single line of at most ${MAX_PR_TITLE_TEMPLATE} characters`);
  }
  for (const name of prTitlePlaceholders(raw)) {
    if (!PR_TITLE_PLACEHOLDERS.includes(name)) {
      throw fail(`uses the unknown placeholder "{{${name}}}"; this runner understands ${PR_TITLE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}. `
        + 'An unknown placeholder is refused rather than left in the title: a PR titled with a literal placeholder is a title nobody meant');
    }
  }
  return raw;
}

// A Conventional-Commits subject: `type(scope)!: description`. The type is
// lower-case, as the spec's own tooling (commitlint's type-case) and
// semantic-pull-request's default type list expect. A subject that does not
// match is NOT read as "type unknown, carry on": it is the commit that makes the
// type undetermined.
const CONVENTIONAL_SUBJECT_RE = /^([a-z][a-z0-9-]*)(?:\(([^()\s][^()]*)\))?!?: \S/;

export function parseConventionalSubject(subject) {
  const match = CONVENTIONAL_SUBJECT_RE.exec(String(subject));
  if (match === null) return null;
  return { type: match[1], scope: match[2] === undefined ? null : match[2].trim() };
}

// =============================================================================
// Worker declarations (CommandMate#3005) — the convention both Skills share
// =============================================================================
//
// A worker that reinterpreted the issue or made a call the issue did not make
// says so in its COMMIT MESSAGE BODY, one declaration per line, each line opening
// with one of the labels below and a colon (ASCII or full-width). Indented lines
// directly under a declaration continue it. The commit message is the carrier
// because it is the one place a worker already writes, that travels with the
// branch, and that nobody else writes into (a file under `.commandmate/` is the
// operator's, and a worker's final chat report never reaches a merge runner).
// cmate-worker-development's references/evidence-vocabulary.md states the same
// convention for the worker side.
export const WORKER_DECLARATION_LABELS = ['読み替え', '判断', '本文に無い指摘'];
const WORKER_DECLARATION_RE = new RegExp(`^(${WORKER_DECLARATION_LABELS.join('|')})\\s*[:：]\\s*(\\S.*)$`);

export function extractWorkerDeclarations(body) {
  const out = [];
  let current = null;
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const match = WORKER_DECLARATION_RE.exec(line);
    if (match !== null) {
      current = { label: match[1], text: match[2].trim() };
      out.push(current);
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) {
      current.text = `${current.text} ${line.trim()}`;
      continue;
    }
    current = null;
  }
  return out;
}

// Fills a template normalizePrTitleTemplate accepted. `values` holds a string
// for every placeholder the template uses; the caller decides what "cannot be
// determined" means before it gets here.
export function renderPrTitleTemplate(template, values) {
  return template.replace(PR_TITLE_TOKEN_RE, (_, name) => String(values[name]));
}
