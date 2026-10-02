#!/usr/bin/env node
// cmate-orchestrate — deterministic plan-core runner (Node stdlib only, Node >= 22).
//
// This runner does the *planning* half of official CommandMate issue
// orchestration: it reads issues, analyses each one, resolves explicit and
// inferred dependencies, refuses unsafe graphs, packs issues into conflict-free
// waves bounded by max_parallel, and writes an inspectable dry-run plan.
//
// It never mutates anything outside its own run directory: no worktree, no
// dispatch, no PR, no merge, no UAT loop. Those phases (#1454-1456) are refused
// here on purpose. The default invocation is a dry run and stays a dry run.
//
// Determinism: the plan is a pure function of its inputs (issue set AND issue
// content — title/body/labels —, base, profile, max_parallel, dependency
// overrides, phase). The default run_id is a hash of those inputs, so the same
// input yields the same plan — the parity a Claude run and a Codex run are
// checked against — and a distinct input yields a distinct run directory that
// never overwrites an existing one. Because issue content is in the hash, the
// normal "fix the issue body, re-plan" loop lands in a new run directory
// instead of being refused (#46 / CommandMate #1678 B-4).

import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REDACTIONS,
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  isHarnessPath,
  companionError,
  normalizeScopeCompanions,
  compileScopeCompanions,
  companionsForPath,
  scopeEntriesOverlap,
  isOverBroadScope,
  normalizeObservations,
  normalizePrTitleTemplate,
  workerMessageProblem,
  WORKER_MESSAGE_KEYS,
} from './lib.mjs';

const PLAN_SCHEMA_VERSION = 2;
const RESULT_SCHEMA_VERSION = 1;

// The permissions the full orchestration would require, mirrored from the
// package manifest. Reported in the plan so a reviewer sees, before any mutating
// phase exists, what consent the eventual execution will ask for.
const DECLARED_PERMISSIONS = [
  'filesystem_read',
  'filesystem_write',
  'process_execution',
  'network_access',
];

const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 3;
const DEFAULT_MAX_PARALLEL = 3;

// Only the planning phase is implemented in this version. Any mutating phase is
// refused rather than silently ignored.
const PHASE_PLAN = 'plan';
const MUTATING_PHASES = new Set(['dispatch', 'pr', 'merge', 'uat']);

const DEFAULT_RUNS_DIR = '.commandmate/orchestrate/runs';

// The two profiles verified in the #1447 ADR. branch/base/worktree/baseline all
// come from here rather than being hardcoded in the planner, so a third
// repository is a data change, not a code change.
const BUILTIN_PROFILES = {
  'node-commandmate': {
    id: 'node-commandmate',
    repository: 'Kewton/CommandMate',
    base: 'origin/develop',
    branch_template: 'feature/issue-{number}-{slug}',
    worktree_template: '../{repo}-issue-{number}-{slug}',
    baseline: ['npm ci', 'npm run build', 'npm test'],
    verified: true,
  },
  'rust-commandagent': {
    id: 'rust-commandagent',
    repository: 'Kewton/CommandAgent',
    base: 'origin/develop',
    branch_template: 'feature/issue-{number}-{slug}',
    worktree_template: '../{repo}-issue-{number}-{slug}',
    baseline: ['cargo fmt --check', 'cargo clippy --all-targets -- -D warnings', 'cargo test'],
    verified: true,
  },
};

// `scope_companions`, `dispatch_defaults` and `integration_baseline` are the
// OPTIONAL entries. No built-in profile declares any of them: both target
// repositories have a test layout L1 already derives, runs that need no flag the
// CLI defaults do not already give, and no integration verification set distinct
// from their baseline — so declaring nothing is both accurate and what keeps
// their plans byte-identical to the ones 0.24.0 produced
// (references/adr-scope-derivation.md §15).
//
// ORDER IS PART OF THE CONTRACT for the optional entries: publicProfile() echoes
// them in this order, and the echo decides the plan's bytes, which every full-text
// golden measures. A new optional field is appended HERE and echoed LAST there.
const PROFILE_FIELDS = [
  'id',
  'repository',
  'base',
  'branch_template',
  'worktree_template',
  'baseline',
  'verified',
  'scope_companions',
  'dispatch_defaults',
  'integration_baseline',
  'observations',
  // CommandMate#3005 — read by merge.mjs --create-prs. Appended last, like every
  // optional field before it, so a profile without it plans the same bytes.
  'pr_title_template',
  'worker_messages',
];

// =============================================================================
// Redaction
// =============================================================================

// Applied to every free-text field lifted out of an issue before it is stored.
// A token or an absolute host path in an issue body must not survive into a
// plan, a result or an audit artifact. The pattern list is shared with the three
// mutating runners (lib.mjs REDACTIONS) because a shape added to one runner and
// missed in another leaks from the one that missed it.
//
// This copy of redact() is deliberately NOT the shared one: the three mutating
// runners tally what they removed so their reports can carry a `redactions[]`
// field, and the plan result envelope has no such field. Hoisting the tallying
// version here would be a behavior change, so the difference stays local.
function redact(value) {
  let text = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate plan-core runner (dry-run only)

Usage:
  orchestrate.mjs <issue>... [options]

Options:
  --issues <n,n,...>     Issue numbers (alternative to positionals).
  --issue-json <path>    Issue fixture JSON for offline, deterministic planning.
  --profile <id>         Built-in profile: node-commandmate | rust-commandagent.
  --profile-json <path>  Custom profile JSON (see references/profile-contract.md).
  --base <ref>           Override the profile's base branch.
  --repo <owner/name>    Override the profile's repository.
  --max-parallel <1-3>   Wave width bound (default 3).
  --phase <plan>         Only "plan" is implemented; mutating phases are refused.
  --depends <a:b>        Override: issue a depends on issue b (repeatable).
  --no-infer             Disable inferred dependencies (explicit/override only).
  --order <n,n,...>      Assert an issue ordering; rejected if it breaks the DAG.
  --run-id <id>          Stable run id (default: a hash of the inputs).
  --runs-dir <path>      Where run directories are written (default ${DEFAULT_RUNS_DIR}).
  --allow-unverified     Permit planning against an unverified profile.
  --help                 Show this help.

The default invocation is a dry run: it writes a plan and mutates nothing else.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        issues: { type: 'string' },
        'issue-json': { type: 'string' },
        profile: { type: 'string' },
        'profile-json': { type: 'string' },
        base: { type: 'string' },
        repo: { type: 'string' },
        'max-parallel': { type: 'string' },
        phase: { type: 'string' },
        depends: { type: 'string', multiple: true },
        'no-infer': { type: 'boolean' },
        order: { type: 'string' },
        'run-id': { type: 'string' },
        'runs-dir': { type: 'string' },
        'allow-unverified': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function parseIssueNumbers(values, name) {
  const numbers = [];
  const seen = new Set();
  for (const raw of values) {
    const token = String(raw).trim().replace(/^#/, '');
    if (!/^\d+$/.test(token)) {
      throw new SkillError('invalid_input', `${name} must be positive integers: got "${raw}"`, 3);
    }
    const number = Number.parseInt(token, 10);
    if (!seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}

function resolveInputs(parsed) {
  const { values, positionals } = parsed;

  const issueTokens = [
    ...positionals,
    ...(values.issues ? values.issues.split(',') : []),
  ].filter((token) => String(token).trim() !== '');
  const issues = parseIssueNumbers(issueTokens, 'issue numbers');
  if (issues.length === 0) {
    throw new SkillError('invalid_input', 'at least one issue number is required', 3);
  }

  const phase = values.phase ?? PHASE_PLAN;
  if (MUTATING_PHASES.has(phase)) {
    throw new SkillError(
      'not_implemented',
      `phase "${phase}" is a mutating phase not implemented in this version; ` +
        'run the default "plan" phase to produce a dry-run plan',
      2,
    );
  }
  if (phase !== PHASE_PLAN) {
    throw new SkillError('invalid_input', `unknown phase "${phase}"; only "plan" is supported`, 3);
  }

  let maxParallel = DEFAULT_MAX_PARALLEL;
  if (values['max-parallel'] !== undefined) {
    if (!/^\d+$/.test(values['max-parallel'])) {
      throw new SkillError('invalid_input', 'max-parallel must be an integer', 3);
    }
    maxParallel = Number.parseInt(values['max-parallel'], 10);
  }
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    throw new SkillError(
      'invalid_input',
      `max-parallel must be between ${MAX_PARALLEL_MIN} and ${MAX_PARALLEL_MAX}`,
      3,
    );
  }

  const order = values.order
    ? parseIssueNumbers(values.order.split(','), 'order')
    : null;

  return {
    issues,
    phase,
    maxParallel,
    order,
    infer: !values['no-infer'],
    dependsRaw: values.depends ?? [],
    issueJson: values['issue-json'] ?? null,
    profileId: values.profile ?? null,
    profileJson: values['profile-json'] ?? null,
    baseOverride: values.base ?? null,
    repoOverride: values.repo ?? null,
    runIdOverride: values['run-id'] ?? null,
    runsDir: values['runs-dir'] ?? DEFAULT_RUNS_DIR,
    allowUnverified: Boolean(values['allow-unverified']),
  };
}

// =============================================================================
// Profile resolution
// =============================================================================

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read ${what} at ${path}: ${error.message}`, 6);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `${what} at ${path} is not valid JSON: ${error.message}`, 6);
  }
}

// The remote URL of the current working directory, normalized to `owner/name`.
// Both git URL forms the CLI writes are accepted:
//
//   git@github.com:Owner/Name.git        ssh://git@github.com/Owner/Name.git
//   https://github.com/Owner/Name.git    https://user@github.com/Owner/Name
//
// Returns null when the cwd is not a git repository, has no `origin`, or the
// URL does not normalize to exactly two path segments. A null is a *skip*, never
// a mismatch: the planner must not invent a discrepancy out of a failed probe.
function cwdOriginRepository() {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  return normalizeRemoteUrl(url);
}

function normalizeRemoteUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let rest = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(rest); // scp-like ssh form
  if (scp) {
    rest = scp[2];
  } else {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/.exec(rest);
    if (!withScheme) return null;
    const afterHost = withScheme[1].replace(/^[^/]*\//, ''); // drop [user@]host[:port]
    if (afterHost === withScheme[1]) return null;
    rest = afterHost;
  }
  rest = rest.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = rest.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(segments[0]) || !/^[A-Za-z0-9._-]+$/.test(segments[1])) return null;
  return `${segments[0]}/${segments[1]}`;
}

function sameRepository(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Resolves the profile and reports what about that resolution the reviewer has
// to know before approving the plan. Returns { profile, warnings }: a warning is
// never fatal, but it does downgrade the run to `partial` so a plan built on a
// shaky premise cannot read as a clean success.
function resolveProfile(inputs) {
  let profile;
  // Whether the profile is the *default* one — nobody named it. That is the case
  // the repository cross-check below exists for: an explicit --profile is a
  // deliberate choice, a default is an assumption the runner made for you.
  const defaultResolved = !inputs.profileJson && !inputs.profileId;
  const warnings = [];

  if (inputs.profileJson) {
    const raw = readJson(inputs.profileJson, 'profile');
    profile = normalizeProfile(raw);
  } else {
    const id = inputs.profileId ?? 'node-commandmate';
    profile = BUILTIN_PROFILES[id];
    if (!profile) {
      const known = Object.keys(BUILTIN_PROFILES).join(', ');
      throw new SkillError(
        'invalid_input',
        `unknown profile "${id}"; built-in profiles are: ${known}. ` +
          'Pass --profile-json for a custom profile.',
        3,
      );
    }
    profile = { ...profile };
  }

  // A repository override moves the profile off the repository its branch/base/
  // worktree/baseline were verified against, so the verification no longer
  // covers it. Downgrade rather than carry a stale `verified: true` forward.
  const repoOverridden = Boolean(inputs.repoOverride) && !sameRepository(inputs.repoOverride, profile.repository);
  if (inputs.repoOverride) profile.repository = inputs.repoOverride;
  if (inputs.baseOverride) profile.base = inputs.baseOverride;

  if (repoOverridden && profile.verified) {
    profile.verified = false;
    profile.verified_downgraded = true;
  }

  if (!profile.verified && !inputs.allowUnverified) {
    const because = profile.verified_downgraded
      ? `profile "${profile.id}" was verified against a different repository and --repo re-pointed it at ` +
        `${profile.repository}, which drops that verification; `
      : `profile "${profile.id}" is not a verified profile; `;
    throw new SkillError(
      'unverified_profile',
      `${because}re-run with --allow-unverified after confirming branch/base/worktree/baseline are correct`,
      3,
    );
  }
  if (profile.verified_downgraded) {
    warnings.push({
      code: 'profile_repository_override',
      detail:
        `--repo re-pointed profile "${profile.id}" at ${profile.repository}; its branch/base/worktree/baseline ` +
        'were verified against a different repository, so this plan runs on an unverified profile',
    });
  }
  delete profile.verified_downgraded;

  // The #36 cross-check: a default profile plans against *its* repository, not
  // the one the operator is standing in. Reading another repository's issues
  // that way produces a plan that looks clean and is about the wrong work.
  if (defaultResolved) {
    const origin = cwdOriginRepository();
    if (origin !== null && !sameRepository(origin, profile.repository)) {
      warnings.push({
        code: 'profile_repository_mismatch',
        detail:
          `the working directory's origin is ${origin} but the default profile "${profile.id}" targets ` +
          `${profile.repository}; the issues in this plan were read from ${profile.repository}. ` +
          'Pass --profile / --profile-json / --repo to plan against this repository.',
      });
    }
  }

  return { profile, warnings };
}

function normalizeProfile(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('load_error', 'profile must be a JSON object', 6);
  }
  for (const key of Object.keys(raw)) {
    if (!PROFILE_FIELDS.includes(key)) {
      throw new SkillError('load_error', `profile has an unknown field "${key}"`, 6);
    }
  }
  const required = ['id', 'repository', 'base', 'branch_template', 'worktree_template', 'baseline'];
  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null) {
      throw new SkillError('load_error', `profile is missing "${key}"`, 6);
    }
  }
  if (!Array.isArray(raw.baseline) || raw.baseline.some((c) => typeof c !== 'string')) {
    throw new SkillError('load_error', 'profile.baseline must be an array of strings', 6);
  }
  const profile = {
    id: String(raw.id),
    repository: String(raw.repository),
    base: String(raw.base),
    branch_template: String(raw.branch_template),
    worktree_template: String(raw.worktree_template),
    baseline: raw.baseline.map(String),
    // A profile is unverified unless it explicitly claims verification.
    verified: raw.verified === true,
  };
  // ABSENT stays absent. Every profile written before Issue #149 lacks this key,
  // and normalizing it to an empty declaration would put a field into
  // `plan.profile` that was never in the profile — a byte those plans did not
  // have. "未指定＝段1 までの挙動" has to be literal, down to the plan bytes.
  const companions = normalizeScopeCompanions(raw.scope_companions, {
    checkLiteral: refuseUnsafeCompanionLiteral,
  });
  if (companions !== null) profile.scope_companions = companions;
  // Same ABSENT-stays-absent rule, same reason, and the same position it is
  // echoed in (publicProfile). A profile that declares neither optional field
  // produces the plan it produced before either existed, byte for byte.
  const dispatchDefaults = normalizeDispatchDefaults(raw.dispatch_defaults);
  if (dispatchDefaults !== null) profile.dispatch_defaults = dispatchDefaults;
  // ABSENT-stays-absent again, and here the distinction it preserves is not only
  // about bytes: the merge runner resolves `integration_baseline ?? baseline`,
  // and the `??` may fire for UNDECLARED alone. A declared `[]` — "this
  // repository has no integration verification" — must therefore arrive as an
  // empty array and not as a missing key, or it would silently become the
  // baseline the whole field exists to stop being reused (Issue #195).
  // `null` is not a synonym for either and is refused (normalizeIntegrationBaseline).
  const integrationBaseline = normalizeIntegrationBaseline(raw.integration_baseline);
  if (integrationBaseline !== null) profile.integration_baseline = integrationBaseline;
  // ABSENT-stays-absent a fourth time (Issue #221). The planner does not USE this
  // field — it validates it and freezes it into `plan.profile` so `observe.mjs`
  // can read the declaration out of the approved plan, the same handoff
  // `dispatch_defaults` (#196) and `integration_baseline` (#195) use. The rules
  // themselves live in lib.mjs because observe.mjs reads them too, under
  // `--profile <path>`, and two copies would be two opinions about what a
  // declaration means (references/profile-contract.md §12).
  const observations = normalizeObservations(raw.observations);
  if (observations !== null) profile.observations = observations;
  // ABSENT-stays-absent a fifth time (CommandMate#3005): the merge runner titles
  // a PR with the issue title exactly as before when the key is missing. The
  // rules live in lib.mjs because merge.mjs re-validates the plan's copy.
  const prTitleTemplate = normalizePrTitleTemplate(raw.pr_title_template, 'profile.pr_title_template', 'load_error', 6);
  if (prTitleTemplate !== null) profile.pr_title_template = prTitleTemplate;
  // ABSENT-stays-absent a fifth time (CommandMate#3009). Lives outside
  // `dispatch_defaults` on purpose: that object is booleans and counts and refuses
  // an unknown key, so a string there would be a second kind of thing in it.
  const workerMessages = normalizeWorkerMessages(raw.worker_messages);
  if (workerMessages !== null) profile.worker_messages = workerMessages;
  return profile;
}

// worker_messages — text the runners append to the messages they send workers
// (CommandMate#3009, references/profile-contract.md §14). Closed like
// dispatch_defaults: an unknown key is refused so a profile written for a newer
// runner is not half-honored. REBUILT rather than passed through, for the
// run-id reason normalizeDispatchDefaults gives.
function normalizeWorkerMessages(raw) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('load_error',
      `profile.worker_messages must be a JSON object of ${WORKER_MESSAGE_KEYS.join(' / ')}, got ${JSON.stringify(raw)}`, 6);
  }
  for (const key of Object.keys(raw)) {
    if (!WORKER_MESSAGE_KEYS.includes(key)) {
      throw new SkillError('load_error',
        `profile.worker_messages has an unknown key "${key}"; this runner understands ${WORKER_MESSAGE_KEYS.join(', ')}`, 6);
    }
  }
  const declared = {};
  for (const key of WORKER_MESSAGE_KEYS) {
    if (!(key in raw)) continue;
    const problem = workerMessageProblem(raw[key]);
    if (problem !== null) {
      throw new SkillError('load_error', `profile.worker_messages.${key} ${problem}`, 6);
    }
    declared[key] = raw[key];
  }
  return declared;
}

// =============================================================================
// scope_companions — layer L2 of references/adr-scope-derivation.md (Issue #149)
// =============================================================================
//
// The rule vocabulary, its load-time refusals, its compiler and THE MATCHER now
// live in lib.mjs, where `profile-init.mjs --check` imports the same four
// (Issue #197). The long argument for the shape — why there is no glob syntax,
// why `require` is a key of its own rather than a widening of `add`, and which of
// ADR §2's three invariants each half carries — travels with them and is not
// repeated here.
//
// What stays in the planner is PLANNER POLICY, and only that: the two path
// filters below, the deduplication against paths this plan already carries, and
// the `MAX_SCOPE_PATTERNS` bound. None of them changes what a rule MATCHES, which
// is why none of them may live where the matcher does — a `--check` that reported
// on the planner's dedup would be reporting on the issue it was run without.
//
// One refusal is passed back INTO the loader for the same reason in reverse.
// `require[].add` literals must be repository-relative, and the vocabulary that
// decides it (`SYSTEM_ROOTS`, consulted by isSafeRepoPath) is byte-mirrored by
// cmate-issue-authoring and has to stay declared in this file — see
// tests/fixtures/cmate-issue-authoring/mirror-conformance.mjs. So the planner
// hands the predicate to normalizeScopeCompanions rather than the constant to
// lib.mjs.

// Called for every `require[].add` entry, in written order, from inside the
// shared loader. A literal is the ONLY companion shape not built out of a path
// the extraction already vetted, so it is the only one that could name something
// outside the repository; without this, a profile is a path traversal.
function refuseUnsafeCompanionLiteral(template, at) {
  if (isSafeRepoPath(template)) return;
  throw companionError(
    `${at}.add "${template}" is not a repository-relative path (it names a system root, a drive ` +
      'letter, a URL host or a control character); a literal companion is granted verbatim, so it ' +
      'must be inside the target repository',
  );
}

// The same contract as testScopeDefaultsFor: `suspected` is the DECLARED file
// list, `added` the defaults already chosen for this issue, neither is mutated,
// and the caller appends the return value to `scope_defaults` and
// `suspected_files` in one place (ADR §2, invariant 2).
//
// Derivation reads the DECLARED paths only — never `added` — because deriving
// from a derived path is what invariant 1 forbids; `added` is read solely so a
// path L1 already produced is not emitted twice. Declared paths are walked in
// order, rules in declaration order, `add` templates in written order, and
// nothing is sorted, so the output is a pure function of (plan, profile) and the
// plan stays byte-identical across runs (invariant 3).
//
// Unlike L1 this does NOT skip a declared path that already looks like a test:
// the profile author is stating a rule about their own repository, and a
// snapshot derived from a test file is a legitimate thing to state.
//
// `rules` holds `derive` and `require` in that order (compileScopeCompanions),
// and the emitter below does not distinguish them: a literal `add` is a parts
// list with no placeholder, so it renders to the same string for every declared
// path that matches its `when` — and `have` therefore grants it exactly once,
// inside the block of the FIRST declared path that pulled it in.
//
// WHAT each rule says about a declared path is companionsForPath (lib.mjs) and is
// shared with `profile-init.mjs --check`; the three filters below are what the
// PLANNER then does with the answer, and are deliberately not shared: a `--check`
// that applied them would be reporting on an issue it was never given.
function profileScopeDefaultsFor(rules, suspected, added) {
  if (rules.length === 0) return [];
  const have = new Set([...suspected, ...added]);
  const out = [];
  for (const path of suspected) {
    const fresh = [];
    for (const { companion } of companionsForPath(rules, path)) {
      // Defence in depth. A declared path is already safe and the templates are
      // validated, so this cannot currently fire; if a future placeholder ever
      // lets one through, it must be dropped rather than granted.
      if (!isSafeRepoPath(companion)) continue;
      // The half of Issue #177's boundary that a load-time check cannot decide.
      // A LITERAL companion inside the harness is refused when the profile is
      // read (normalizeCompanionRules); a TEMPLATE only lands there once a
      // binding is known, and where the binding came from is what decides
      // whether this is the door #177 closed:
      //
      //   from a declaration OUTSIDE the harness — `src/{dir}{base}.ts` ->
      //     `.claude/skills/{dir}{base}.ts` — the PROFILE is doing the
      //     granting, which is the second door #177 refused to open. Dropped.
      //   from a declaration INSIDE it — the issue named a harness path under a
      //     deliverable heading, the one grant #177 honours and reports as
      //     `harness_path_in_scope` — the companion is a function of a path a
      //     human already vetted. Kept, because L1 derives the conventional
      //     test shapes of that same declared path and is not filtered either;
      //     dropping only L2's would be a boundary that depends on which layer
      //     produced the path rather than on where the permission came from.
      if (isHarnessPath(companion) && !isHarnessPath(path)) continue;
      if (have.has(companion) || fresh.includes(companion)) continue;
      fresh.push(companion);
    }
    if (fresh.length === 0) continue;
    // The same boundary L1 stops at, for the same reason: dispatch.mjs SORTS
    // scope.allow before truncating it to MAX_SCOPE_PATTERNS, so a list over the
    // bound loses DECLARED paths to alphabetically earlier derived ones. `have`
    // already carries L1's entries, so the bound is checked against the COMBINED
    // total rather than L2's own.
    if (have.size + fresh.length > MAX_SCOPE_PATTERNS) break;
    for (const companion of fresh) {
      have.add(companion);
      out.push(companion);
    }
  }
  return out;
}

// =============================================================================
// dispatch_defaults — repository operating defaults (Issue #180, planner half #196)
// =============================================================================
//
// The planner does not USE this field. It loads it, validates it, and echoes it
// into `plan.profile` so the dispatch runner can read it from the approved plan
// (references/profile-contract.md §10, references/dispatch-contract.md §1.1).
// That is the whole of the planner's part, and it is a part only because a
// profile field the loader refuses is a field nobody can write: before this, a
// profile carrying `dispatch_defaults` stopped at `load_error` before an issue
// was read, so the declaration could only reach dispatch through a plan somebody
// hand-edited.
//
// ---- Why the validation is duplicated rather than shared --------------------
//
// dispatch.mjs validates the same shape and keeps doing so. It is not defensive
// duplication: the two checks are about two different FILES. dispatch reads
// `plan.profile.dispatch_defaults` out of a plan artifact, and a plan can arrive
// there without ever having passed through this loader (§10.6 names the
// hand-written case, and status/resume artifacts are plans this planner did not
// produce), so dispatch cannot delegate its check to the planner. And the two
// checks do not even end the same way: each throws a SkillError naming its own
// file (below), so what could be shared is a table of shapes with the refusal
// passed in — a factoring that saves four `throw` lines and puts the two
// runners' contracts in one place where a change to one silently moves both.
//
// ---- Why load_error / exit 6 here and plan_invalid / exit 3 there -----------
//
// A code names the file the operator has to open. Every other malformed profile
// field leaves this loader as `load_error` (exit 6) — "the profile file is
// wrong" — and a `dispatch_defaults` that exits 3 with `plan_invalid` would send
// the reader of a profile to a plan that does not exist yet. The mirror argument
// is why dispatch keeps `plan_invalid`: there the fact IS about the plan file,
// and the operator who typed the dispatch command is generally not the person
// who wrote the profile (the comment above readDispatchDefaults says so).
// Same rules, same messages, two different subjects.
const DISPATCH_DEFAULT_BOOLEANS = ['no_infer', 'auto_yes'];
const DISPATCH_DEFAULT_COUNTS = ['wait_timeout', 'max_turns'];
const DISPATCH_DEFAULT_KEYS = [...DISPATCH_DEFAULT_BOOLEANS, ...DISPATCH_DEFAULT_COUNTS];

// Returns the canonical declaration, or null when the profile has none.
//
// REBUILT, not passed through, and rebuilt in DISPATCH_DEFAULT_KEYS order. The
// resolved profile goes into the run-id hash WHOLE and unsorted (#157, see
// canonicalInputSignature), so a field that carried a caller-supplied object
// through unrebuilt would fork the run id when an author merely re-ordered the
// keys inside it. Rebuilding is what keeps that cosmetic edit invisible, exactly
// as normalizeScopeCompanions rebuilds every rule as `{when, add}`.
//
// The accepted SET is identical to dispatch's: an explicit `null` is refused
// there, so it is refused here rather than quietly read as "absent" — two copies
// of one rule are only auditable while they accept the same declarations. An
// empty `{}` is accepted by both and states nothing, which is what it means.
function normalizeDispatchDefaults(raw) {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('load_error',
      `profile.dispatch_defaults must be a JSON object of ${DISPATCH_DEFAULT_KEYS.join(' / ')}, got ${JSON.stringify(raw)}`, 6);
  }
  for (const key of Object.keys(raw)) {
    if (!DISPATCH_DEFAULT_KEYS.includes(key)) {
      throw new SkillError('load_error',
        `profile.dispatch_defaults has an unknown key "${key}"; this runner understands ${DISPATCH_DEFAULT_KEYS.join(', ')}. `
          + 'A profile written for a newer runner is refused rather than half-honored, for the reason an unknown profile '
          + 'FIELD is refused (profile-contract.md §9.3): the keys it declares would otherwise be silently dropped, and a '
          + 'run driven by half a declaration is the accident the declaration was written to prevent', 6);
    }
  }
  const declared = {};
  for (const key of DISPATCH_DEFAULT_BOOLEANS) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== 'boolean') {
      throw new SkillError('load_error',
        `profile.dispatch_defaults.${key} must be true or false, got ${JSON.stringify(raw[key])}`, 6);
    }
    declared[key] = raw[key];
  }
  for (const key of DISPATCH_DEFAULT_COUNTS) {
    if (!(key in raw)) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < 1) {
      throw new SkillError('load_error',
        `profile.dispatch_defaults.${key} must be a positive integer, got ${JSON.stringify(raw[key])}`, 6);
    }
    declared[key] = raw[key];
  }
  return declared;
}

// =============================================================================
// integration_baseline — the post-merge verification set (Issue #195)
// =============================================================================
//
// The planner does not USE this field either. It loads it, validates it and
// echoes it into `plan.profile` so the MERGE runner can read it from the
// approved plan (references/profile-contract.md §11, references/merge-contract.md
// §5.4) — the same shape as `dispatch_defaults`, and it is here for the same
// reason: a profile field this loader refuses is a field nobody can write. Before
// this, a profile carrying `integration_baseline` stopped at `load_error` before
// an issue was read, so `merge.mjs --integration-verify` could only have found
// the declaration in a plan somebody hand-edited. #180 landed the reading side
// alone, and profile-contract.md §10.6 had to carry the asymmetry as a written
// caveat until #196 closed it; this Issue lands both halves at once instead of
// repeating that.
//
// ---- Why the same shape rule as `baseline`, and no extra one ----------------
//
// Both fields are "commands to run, in this order", so the accepted set is
// `baseline`'s accepted set: an array of strings. Adding a stricter rule here
// (rejecting an empty string, say) would mean the two verification lists of ONE
// profile disagree about what a command is, and the reader of a refusal could
// not tell which rule they had hit.
//
// The one thing that is NOT shared is what EMPTY means, and it is the point of
// the field. An absent `baseline` is a profile that never filled it in, which
// `--integration-verify` refuses (merge-contract.md §5.4). A declared
// `"integration_baseline": []` is a repository STATING that it has no
// integration verification — so it is refused too, but it must never be quietly
// answered with `baseline`, whose purpose (a worker's proportional health check)
// is the one this field exists to separate from. That distinction lives in the
// key's PRESENCE, so this returns `[]` for a declared empty array and `null`
// only for an absent one.
function normalizeIntegrationBaseline(raw) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some((command) => typeof command !== 'string')) {
    throw new SkillError('load_error',
      `profile.integration_baseline must be an array of strings, got ${JSON.stringify(raw)}. `
        + 'It is the verification set --integration-verify runs on the MERGED base branch, and it is read as '
        + '`integration_baseline ?? baseline` — where the fallback fires for an ABSENT key only. Omit the key to '
        + 'keep running `baseline` after a merge; declare `[]` to state that this repository has no integration '
        + 'verification (which --integration-verify then refuses rather than answering with `baseline`)', 6);
  }
  return raw.map(String);
}

// =============================================================================
// Issue loading
// =============================================================================

function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const labels = [];
  for (const item of raw) {
    if (typeof item === 'string') labels.push(item);
    else if (item && typeof item === 'object' && typeof item.name === 'string') labels.push(item.name);
  }
  return labels;
}

function loadIssues(inputs, profile) {
  if (inputs.issueJson) {
    return loadIssuesFromFixture(inputs.issues, inputs.issueJson);
  }
  return inputs.issues.map((number) => fetchIssueWithGh(number, profile.repository));
}

// The only two spellings of an issue number a fixture entry may use: an integer,
// or a string that is exactly one. `gh issue view --json number` writes `200` and
// a hand-written fixture usually writes `"200"`, so both shapes arrive here and
// both mean 200. Nothing else does. This used to be `Number.parseInt`, which does
// not read the number so much as its PREFIX: `"123abc"` came back as 123 and
// `"12.9"` as 12, so a mistyped number did not fail — it planned a DIFFERENT
// issue (Issue #208). Returns null for anything it will not read; the caller
// turns that into a load_error rather than dropping the entry.
function fixtureIssueNumber(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^-?[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

// What an unusable entry WAS, for the message that names it. Deliberately the
// shape and not the value: an entry can be arbitrarily large, and the author does
// not need it echoed back to find index N of a file they wrote.
function describeFixtureEntry(item) {
  if (item === null) return 'null';
  if (Array.isArray(item)) return 'a list';
  return `a ${typeof item}`;
}

// A fixture is the plan's INPUT, written by hand, and until Issue #208 every way
// of writing one wrong was silent: a non-object entry and an unreadable `number`
// were skipped, and a repeated `number` was overwritten by whichever entry came
// last. That is the failure §5 of plan-contract.md already refuses elsewhere — a
// plan assembled from a quiet subset of what the author wrote finishes GREEN over
// issues nobody measured — and it misattributes on the way out: the only
// observable trace was `fixture does not contain issues: N`, which sends the
// reader to fix the REQUEST when the FILE is what is broken.
//
// So the whole fixture is read before any of it is used, and anything unreadable
// is a load_error that names the entry and the reason. This rejects fixtures that
// used to produce a plan; a fixture that was already well-formed is unaffected,
// down to the byte (the full-text plan goldens are the measurement).
function loadIssuesFromFixture(numbers, path) {
  const raw = readJson(path, 'issue fixture');
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.issues) ? raw.issues : null;
  if (!items) {
    throw new SkillError(
      'load_error',
      '--issue-json must be a list or an object with an "issues" list',
      6,
    );
  }
  const byNumber = new Map();
  for (const [index, item] of items.entries()) {
    const where = `--issue-json entry ${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SkillError('load_error',
        `${where} is not an object (it is ${describeFixtureEntry(item)}). Every entry is shaped like one element of `
          + '`gh issue view --json number,title,body,labels`, of which only `number` is required', 6);
    }
    if (item.number === undefined) {
      throw new SkillError('load_error',
        `${where} has no "number". It is the one field an entry cannot omit `
          + '(`title` and `body` default to "", `labels` to [])', 6);
    }
    const number = fixtureIssueNumber(item.number);
    if (number === null) {
      // The value IS echoed here (unlike the entry above): it is the thing that
      // could not be read, it is short in every realistic case, and quoting it is
      // how "12" and "12.9" are told apart at a glance. Clamped anyway — a
      // `number` written as a whole object is a legal JSON shape.
      const written = JSON.stringify(item.number);
      const quoted = written.length > 60 ? `${written.slice(0, 57)}…` : written;
      throw new SkillError('load_error',
        `${where} has a "number" that is not an integer: ${quoted}. Write it as 200 or "200" — `
          + 'a value with a numeric prefix ("200abc") or a fractional part ("12.9") is refused rather than read as '
          + '200 or 12', 6);
    }
    if (byNumber.has(number)) {
      throw new SkillError('load_error',
        `${where} repeats issue ${number}, already declared by entry ${byNumber.get(number).index}. Remove one: `
          + 'the planner will not choose between two bodies for the same issue, and the body it reads decides both '
          + 'the plan and the run id', 6);
    }
    byNumber.set(number, {
      index,
      issue: {
        number,
        title: String(item.title ?? ''),
        body: String(item.body ?? ''),
        labels: normalizeLabels(item.labels),
      },
    });
  }
  const missing = numbers.filter((n) => !byNumber.has(n));
  if (missing.length > 0) {
    // Reached only once every entry has been read, so "does not contain" now
    // means absent and nothing else. The declared set is echoed because the
    // author's next question is always which numbers the file does hold.
    const declared = [...byNumber.keys()];
    const shown = declared.length === 0
      ? 'no issues at all'
      : declared.length > 20
        ? `${declared.slice(0, 20).join(', ')}, … (${declared.length} entries)`
        : declared.join(', ');
    throw new SkillError('load_error',
      `fixture does not contain issues: ${missing.join(', ')} — it declares ${shown}`, 6);
  }
  return numbers.map((n) => byNumber.get(n).issue);
}

function fetchIssueWithGh(number, repo) {
  let stdout;
  try {
    stdout = execFileSync(
      'gh',
      ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,labels'],
      { encoding: 'utf8' },
    );
  } catch (error) {
    throw new SkillError(
      'load_error',
      `gh could not read issue #${number} from ${repo}; ` +
        'pass --issue-json to plan offline. ' +
        redact(error.message ?? ''),
      6,
    );
  }
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new SkillError('load_error', `gh returned unparseable JSON for #${number}`, 6);
  }
  return {
    number: Number.parseInt(raw.number, 10),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    labels: normalizeLabels(raw.labels),
  };
}

// =============================================================================
// Issue analysis
// =============================================================================

function slugify(value, maxLen = 48) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const compact = normalized.slice(0, maxLen).replace(/^-+|-+$/g, '');
  return compact || 'task';
}

function firstNonEmptyLine(value) {
  for (const line of value.split(/\r?\n/)) {
    const stripped = line.replace(/^[\s\-#>*]+/, '').trim();
    if (stripped) return stripped;
  }
  return '';
}

const ACCEPTANCE_HEADING_RE = /(acceptance|criteria|受入|受け入れ|完了条件|期待結果|受入条件)/i;
const HEADING_RE = /^#{1,6}\s+/;

function extractAcceptanceCriteria(body) {
  const out = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (HEADING_RE.test(stripped)) {
      inSection = ACCEPTANCE_HEADING_RE.test(stripped);
      continue;
    }
    if (!inSection) continue;
    if (/^[-*]\s+/.test(stripped)) {
      out.push(cleanCriterion(stripped.replace(/^[-*]\s+/, '')));
    } else if (/^\d+\.\s+/.test(stripped)) {
      out.push(cleanCriterion(stripped.replace(/^\d+\.\s+/, '')));
    }
  }
  return out.filter(Boolean);
}

// Task-list checkboxes (`- [ ] ...`) are common in acceptance sections; keep the
// text, drop the marker.
function cleanCriterion(text) {
  return text.replace(/^\[[ xX]\]\s*/, '').trim();
}

// A deliberately broad extension set: a path wrongly kept is a candidate a
// reviewer can drop, a path missed is context the plan never had.
// Mirrored verbatim in cmate-issue-authoring scripts/validate-plan.mjs; the
// issue-authoring test suite asserts the two stay identical.
//
// `jsonc` (Issue #56) is here for the same reason `geojson` is (#43), with one
// difference that removes the usual escape hatch: the affected files carry
// FRAMEWORK-FIXED names. `wrangler.jsonc` is what Cloudflare Workers reads and
// `deno.jsonc` is what Deno reads, so "name it .json instead" is not advice an
// issue author can take. Worse than the geojson case, the drop was completely
// silent for a repository-root file: `extractUnrecognizedPaths` only looks at
// backtick paths containing a "/", so `wrangler.jsonc` produced no
// `unrecognized_file_extension` warning either — it simply was not in
// suspected_files, hence not in the contract's scope.allow, and the worker was
// failed by the scope gate the moment it edited the file it was told to edit.
// `json5` is deliberately NOT added: no widely deployed tool requires a file
// literally named `*.json5` (the JSON5 readers all accept another extension or
// are configured by file name), so it would widen every worker's scope.allow for
// a demand nobody has reported. Same for `jsonl`. Add them when an issue shows
// a fixed name that forces them.
const FILE_EXT = 'rs|md|toml|json|jsonc|yaml|yml|py|sh|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|c|h|cpp|css|html|sql|geojson|topojson|geojsonl';
const SYSTEM_ROOTS = new Set(['users', 'home', 'root', 'tmp', 'private', 'var', 'etc', 'proc']);

// A candidate must begin where a path can begin (Issue #49). `\b` does not: it
// also matches between "/" and a word character, so the SAME path matched a
// second time from the middle. Measured on 0.11.0:
// "bash .claude/skills/cmate-verify/scripts/verify-run.sh" yielded
// "scripts/verify-run.sh" and "claude/skills/cmate-verify/scripts/verify-run.sh"
// (neither exists, and the real ".claude/..." path was never produced —
// a leading "." carries no word boundary); "web/src/lib/filter.ts" additionally
// yielded "src/lib/filter.ts"; "https://example.com/a/b.ts" yielded
// "example.com/a/b.ts". suspected_files becomes the worker's scope.allow
// verbatim, so every one of those was write permission granted to an invented
// path. The lookbehind pins each match to a token start — a position no path
// character precedes — which both stops the partials and lets a dotfile root
// ("`.claude/…`", ".github/…") match from its real first character.
//
// PATH_START and the three pattern sources below are mirrored byte for byte in
// cmate-issue-authoring scripts/validate-plan.mjs; the issue-authoring suite
// asserts the two copies stay identical.
const PATH_START = '(?<![A-Za-z0-9_./\\\\-])';
const CANDIDATE_BACKTICK = '`([^`\\s]+\\.(?:' + FILE_EXT + '))`';
const CANDIDATE_KNOWN_ROOT = PATH_START + '((?:src|tests|test|scripts|docs|lib|app|pkg|internal|cmd|\\.github)/[A-Za-z0-9_./-]+)\\b';
const CANDIDATE_WITH_EXT = PATH_START + '([A-Za-z0-9_.-]+/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:' + FILE_EXT + '))\\b';

// The fourth candidate source (Issue #219). The three above cannot express a
// declaration the execution contract has accepted since CommandMate #1546:
// `[A-Za-z0-9_.-]` holds no `*`, `?`, `{`, `}` or `,`, so a plainly written
// `data/geo/landmarks/*.json` — and the directory `data/geo/stations/` — matched
// nothing and was dropped without a word. Backticks were the one way through,
// and only by accident: CANDIDATE_BACKTICK's `[^`\s]+` accepts any byte, so
// `` `data/geo/**/*.json` `` reached scope.allow while the same pattern one line
// below, unquoted, did not. Measured in Kewton/BorderFreeKidsMap #243: 46
// generated files listed BY HAND under `## 対象ファイル`, because the one line
// that says what the issue means could not be written.
//
// A segment is the plain path alphabet plus `*` and `?`, or a brace group. `,`
// is accepted ONLY inside braces: outside them it is prose punctuation, and a
// segment that swallowed it would read "a/b.ts, c/d.ts" as one token.
//
// Unlike the three sources above this one does NOT consult FILE_EXT. The closed
// extension set is what keeps a bare prose token from becoming write permission;
// a pattern reaches here only from under a deliverable heading (see
// extractFileCandidates), which is a declaration rather than a mention, and
// gating it on the extension set would refuse `data/tiles/*.mbtiles` for a
// reason that no longer applies.
//
// Mirrored byte for byte in cmate-issue-authoring scripts/validate-plan.mjs,
// like the three sources above.
const PATTERN_SEGMENT = '(?:[A-Za-z0-9_.*?-]|\\{[A-Za-z0-9_.,*?-]+\\})+';

// Two shapes, and what separates the second from prose is a `/`. A bare-wildcard
// token (`**`, `*`, `**/*`) is matched so that it can be REFUSED as `over_broad`
// with the pattern named rather than ignored; everything else must carry a
// slash, because without that requirement `**bold**` — Markdown emphasis, which
// every issue body has — is a scope pattern.
//
// The trailing lookahead pins the token's end the way PATH_START pins its start,
// and `(?<![*?}])` extends PATH_START over the metacharacters PATH_START does
// not know about. Both are needed for the same one line of prose: in
// `**bold** y`, the CLOSING `**` is preceded by `d` (PATH_START refuses it) but
// its second `*` is preceded by `*`, which PATH_START allows — so without this
// the bare-wildcard shape matched a lone `*` at the end of every bold run.
//
// The trailing lookahead also refuses a NON-ASCII follower, which PATH_START has
// no counterpart for. Without it the directory shape ate the ASCII head of every
// non-ASCII filename: `docs/企画書_都知事杯2026_改訂版.md` — a real deliverable
// in the fixtures — matched `(?:SEGMENT/)+` as `docs/` and an empty last
// segment, so declaring one Japanese-named document silently granted the whole
// of `docs/`. The cost is that a pattern written flush against Japanese prose
// (`data/geo/stations/配下`) is not extracted; write it in backticks, which is
// this vocabulary's convention anyway, and it is.
//
// Known and accepted: `**a**/**b**` — emphasis on both sides of a slash — is a
// syntactically valid glob and IS extracted. It is only ever read under a
// deliverable heading, where "the files I produce" is not a place that sentence
// occurs; refusing it would need the extraction to know Markdown.
const CANDIDATE_PATTERN = PATH_START + '(?<![*?}])(\\*{1,2}(?:/\\*{1,2})*|(?:' + PATTERN_SEGMENT + '/)+(?:' + PATTERN_SEGMENT + ')?)(?![A-Za-z0-9_.*?{/-]|[^\\x00-\\x7f])';

// The fifth candidate source (CommandMate #3003, folding in
// Kewton/commandmate-skills#272): a backtick-quoted FILE NAME under a
// deliverable heading, whatever its extension — or none. FILE_EXT is a closed
// set, and every name outside it was refused even where the issue DECLARED it:
// `packages/appspec-schema/contract/expression.ebnf` under `## 対象ファイル`
// never reached scope.allow (Kewton/Musunest#212; the author renamed the file to
// `.md` to get through), nor did `Cargo.lock` or `requirements/ci.txt`
// (Kewton/CommandAgent#520 — `Cargo.lock`, having no "/", did not even raise
// `unrecognized_file_extension`). The closed set exists to keep a PROSE token
// from becoming write permission; under a deliverable heading there is no prose
// to guard against, the same argument that lets CANDIDATE_PATTERN skip FILE_EXT
// (#219). So this source is DECLARED-ONLY: a match outside every deliverable
// heading is discarded, and the extraction there is exactly what it was.
//
// Backticks are required. Bare text under a heading still goes through the
// closed sources above: "- `src/a.ts` を直す（e.g. node.js 側）" must not grant
// `node.js`. Inside backticks a token is taken as a file name when it is
//   * a path or a dotted name — `Cargo.lock`, `.gitignore`, `a/b.ebnf`,
//     `requirements/ci.txt` — ending in a name character (not `.` or `/`), or
//   * an extensionless name of the two shapes repositories actually use at
//     their root: `Makefile` / `Dockerfile` / `Justfile` (`…file`) and
//     `LICENSE` / `CODEOWNERS` (all capitals).
// A camelCase identifier (`parseFoo`), a flag (`--json`), a number (`0.33.0`)
// and a relative-escape (`./x`, `../x`, `/x`) are not file names here. Known and
// accepted: a dotted identifier such as `console.log` IS taken. It can only be
// written under the issue's own deliverable heading, and the cost is an
// allowance nobody uses — which the scope-derivation ADR already prices at zero.
//
// Mirrored byte for byte in cmate-issue-authoring scripts/validate-plan.mjs.
const CANDIDATE_DECLARED = '`((?!\\.{0,2}/)(?=[A-Za-z0-9_./-]*[A-Za-z])(?:[A-Za-z0-9_.-]*[./][A-Za-z0-9_./-]*[A-Za-z0-9_-]|[A-Z][A-Za-z0-9]*file|[A-Z][A-Z0-9_]*))`';

// Which candidates the deliverable-heading rule governs: a glob metacharacter,
// or the trailing slash that declares a directory. Applied to candidates from
// EVERY source, not only CANDIDATE_PATTERN, because the backtick source has
// always matched patterns too — that is the accident this issue regularises.
const SCOPE_PATTERN_RE = /[*?{]|\/$/;

// Headings under which a path is the issue's PRODUCT rather than its context
// (Issue #50). See classifyFileCandidates for why the extension alone cannot
// decide that. Mirrored in cmate-issue-authoring scripts/validate-plan.mjs.
const DELIVERABLE_HEADING_RE = /(deliverable|成果物|対象ファイル|変更対象|変更ファイル|作成ファイル|編集対象|出力ファイル|生成ファイル|affected files|target files|output files|files to (?:change|edit|create|write|add))/i;

// A heading that NEGATES the vocabulary above (CommandMate #3002).
// DELIVERABLE_HEADING_RE matches a word anywhere in the heading, so
// `## 変更対象外` and `## 対象ファイル外` — the headings an author writes to say
// "do not touch these" — used to be deliverable headings, and the files listed
// under them reached scope.allow. Once prose paths stop reaching the scope, that
// would be the one way left to grant write permission by forbidding it. The
// negation is read only at the END of the heading, where Japanese puts it; a
// trailing colon is tolerated. Mirrored in cmate-issue-authoring
// scripts/validate-plan.mjs.
const NEGATED_HEADING_RE = /(?:外|以外|しない)[\s:：]*$/;

function isDeliverableHeading(line) {
  return DELIVERABLE_HEADING_RE.test(line) && !NEGATED_HEADING_RE.test(line);
}

// The counterpart of DELIVERABLE_HEADING_RE (Issue #54). #50 gave an issue a way
// to say "this path IS what I produce" but no way to say the opposite, and a bug
// report cites the file it reproduces in — as `path:line`, under 根拠 — far more
// often than it lists deliverables. Those citations became suspected_files, i.e.
// the worker's scope.allow, so an issue that wrote "this file is NOT changed"
// handed out write permission on it anyway.
//
// The set is deliberately narrow. Over-excluding is the worse error: it drops a
// real target out of scope.allow and the worker is refused by the scope gate for
// writing what it was told to write — the exact failure #50 removed. Headings
// that a bug report uses for the file it is about (現状 / 調査 / 再現手順) are
// therefore NOT here, even though they are "context" in a loose sense.
// Mirrored in cmate-issue-authoring scripts/validate-plan.mjs.
const CONTEXT_HEADING_RE = /(根拠|出典|参考|参照|背景|関連|references?|context|background|see also|appendix)/i;

// Character offsets covered by the sections whose heading `matches`, so a
// candidate's position in the body decides how it is classified. A section runs
// from the line after its heading to the next heading of any level (or end of
// text) — or, with `nested`, to the next heading of the SAME OR A HIGHER level,
// so its subsections belong to it.
//
// `nested` is what a deliverable heading uses (Kewton/commandmate-skills#273,
// folded into CommandMate #3002). `## 対象ファイル` split into `### 既存ファイル`
// / `### 新規ファイル` ended at the first `###`, so a document listed under a
// subsection was not a deliverable and fell to `reference_files`. While prose
// paths still reached the scope that cost only documents; once they do not, it
// would cost every path under every subsection. Context headings keep the old
// reach: nothing measured asks for more.
function headingSpans(text, matches, nested = false) {
  const spans = [];
  let offset = 0;
  let open = null;
  let openLevel = 0;
  for (const line of text.split('\n')) {
    if (HEADING_RE.test(line.trim())) {
      const level = /^#+/.exec(line.trim())[0].length;
      if (open !== null && (!nested || level <= openLevel)) {
        spans.push([open, offset]);
        open = null;
      }
      if (open === null && matches(line.trim())) {
        open = offset + line.length + 1;
        openLevel = level;
      }
    }
    offset += line.length + 1;
  }
  if (open !== null) spans.push([open, offset]);
  return spans;
}

const deliverableSpans = (text) => headingSpans(text, isDeliverableHeading, true);

// A heading that reads as both ("## 対象ファイル（参考）") is a deliverable
// heading: the statement that something is produced outranks the one that it is
// only context, the same precedence a candidate gets below.
const contextSpans = (text) =>
  headingSpans(text, (line) => !isDeliverableHeading(line) && CONTEXT_HEADING_RE.test(line));

function inSpans(spans, index) {
  return spans.some(([start, end]) => index >= start && index < end);
}

// Returns { paths, deliverable, contextOnly, proseOnly, shadowed,
// droppedPatterns }: the de-duplicated candidates in order of first appearance,
// the subset a deliverable heading covers, the subset that appears ONLY under a
// context heading, the subset an issue WITH a deliverable heading wrote only
// outside it (CommandMate #3002), the pairs where one candidate is a
// path-boundary suffix of another, and the scope patterns no deliverable
// heading claimed.
function extractFileCandidates(text) {
  // The fourth source is PATTERN-ONLY. CANDIDATE_PATTERN also matches plain
  // paths — including shapes the first three deliberately refuse, such as
  // `vendor/n`, which has neither a known root nor a recognised extension — so
  // anything it finds that is not a scope pattern is discarded rather than let
  // in through a side door. The three closed sources stay exactly as strict as
  // they were.
  const sources = [
    { pattern: new RegExp(CANDIDATE_BACKTICK, 'g'), patternsOnly: false },
    { pattern: new RegExp(CANDIDATE_KNOWN_ROOT, 'g'), patternsOnly: false },
    { pattern: new RegExp(CANDIDATE_WITH_EXT, 'g'), patternsOnly: false },
    { pattern: new RegExp(CANDIDATE_PATTERN, 'g'), patternsOnly: true },
    // Declared-only (CommandMate #3003): read under a deliverable heading and
    // nowhere else. Last, so the order of every candidate the four sources
    // above find is what it was.
    { pattern: new RegExp(CANDIDATE_DECLARED, 'g'), declaredOnly: true },
  ];
  const spans = deliverableSpans(text);
  const cSpans = contextSpans(text);
  const seen = new Set();
  const deliverable = new Set();
  const inContext = new Set();
  const outsideContext = new Set();
  const found = [];
  const droppedPatterns = [];
  for (const source of sources) {
    for (const match of text.matchAll(source.pattern)) {
      const candidate = match[1].trim();
      if (!isSafeRepoPath(candidate)) continue;
      const isPattern = SCOPE_PATTERN_RE.test(candidate);
      if (source.patternsOnly && !isPattern) continue;
      if (source.declaredOnly && !inSpans(spans, match.index)) continue;
      // A pattern is permission over files nobody has enumerated, so it is
      // honoured only where the issue DECLARES it as a product — the same "an
      // explicit declaration outranks an incidental mention" rule #177 drew for
      // the harness, and the reason a pattern needs no FILE_EXT check. A pattern
      // cited under 根拠 / 参考, or written in passing prose, is not a target.
      // It is dropped and REPORTED (`scope_pattern_dropped`): a backtick pattern
      // used to reach scope.allow from anywhere in the body, so a silent drop
      // here would narrow somebody's scope without telling them — the failure
      // this extraction has now been fixed for three times (#43, #56, #182).
      if (isPattern && !inSpans(spans, match.index)) {
        if (!droppedPatterns.includes(candidate)) droppedPatterns.push(candidate);
        continue;
      }
      // A path written as context in one place and as a deliverable in another
      // is a deliverable: the stronger statement wins.
      if (inSpans(spans, match.index)) deliverable.add(candidate);
      if (inSpans(cSpans, match.index)) inContext.add(candidate);
      else outsideContext.add(candidate);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
  }
  // Excluded only when EVERY mention sits under a context heading. A path the
  // issue also names in prose ("src/a.ts を直す") is still a target however many
  // times it is cited as evidence further down — the citation does not retract
  // the instruction. This also gives deliverable headings their precedence for
  // free, since a deliverable span is never a context span.
  const contextOnly = new Set([...inContext].filter((candidate) => !outsideContext.has(candidate)));
  // An issue that HAS a deliverable heading has said which files it produces,
  // and a path it wrote anywhere else — prose, 完了条件, the title — is a
  // mention, not a declaration (CommandMate #3002). Measured on Kewton/Musunest:
  // "the diff of <manifest> is zero" (#181) and "stop if `ci.yml` needs a change"
  // (#183) both GRANTED write permission on the file they forbade, so the files
  // an author most wanted untouched were the ones that reached scope.allow. It is
  // the rule #219 drew for patterns, extended to every candidate, and it applies
  // only where the issue gave the planner a declaration to prefer: an issue with
  // no deliverable heading is read exactly as before, because there the prose IS
  // the only statement of what changes. A path written both under the heading
  // and elsewhere is a deliverable — the stronger statement wins, as above.
  const proseOnly = spans.length === 0
    ? new Set()
    : new Set(found.filter((candidate) => !deliverable.has(candidate)));
  return {
    paths: found,
    deliverable,
    contextOnly,
    proseOnly,
    hasDeliverableHeading: spans.length > 0,
    shadowed: shadowedCandidates(found),
    // A pattern the issue declares under `## 対象ファイル` and ALSO cites under
    // `## 根拠` is not a drop: the declaration already won above.
    droppedPatterns: droppedPatterns.filter((candidate) => !seen.has(candidate)),
  };
}

// The other half of Issue #49. Anchoring stops the extraction INVENTING a
// partial path, but an issue can still write "web/src/lib/filter.ts" in one
// place and "src/lib/filter.ts" in another. At most one of the two is the file
// the issue means, and the shorter one is a path-boundary suffix of the longer.
//
// #49 answered that by DROPPING the shorter one. Issue #182 took the answer
// away, because the guess is wrong exactly when it costs the most. Measured on
// 0.27.0 (Kewton/BorderFreeKidsMap): an issue listed `data/demo/facilities.json`
// under `## 対象ファイル` and mentioned the build output
// `web/public/dist/data/demo/facilities.json` in prose. The rule dropped the
// DECLARED path and kept the generated one, so `scope.allow` held the artifact
// the issue says not to touch and not the file it says to write — and the run
// still planned, because the drop was only a warning.
//
// "The longer path wins" was never evidence about which path the issue means:
// it is evidence that the two OVERLAP. Which one is the target is a question
// only the author can answer, so it is asked (`ambiguous_file_candidate`) and
// BOTH candidates stay — a question stops dispatch, where the warning did not.
// Widening the scope by one directory is the cheaper error of the two: an
// unused allowance costs nothing, a missing one costs the worker its run and
// cannot be repaired from inside it (the contract's scope is a send-time
// snapshot). Deciding for the author is what this function no longer does.
//
// Returns the pairs only; nothing is removed. Order follows the candidate list,
// so the plan stays byte-deterministic.
function shadowedCandidates(paths) {
  const shadowed = [];
  for (const candidate of paths) {
    const covering = paths.find((other) => other !== candidate && other.endsWith(`/${candidate}`));
    if (covering !== undefined) shadowed.push({ path: candidate, covered_by: covering });
  }
  return shadowed;
}

// Client-controlled text must never name anything outside the target repository:
// no absolute path, no drive-letter path, no ".." escape, no control character.
function isSafeRepoPath(candidate) {
  if (!candidate || candidate.startsWith('/') || candidate.includes('..')) return false;
  if (candidate.includes('\\')) return false;
  if (/[\x00-\x1f\x7f]/.test(candidate)) return false;
  if (/^[A-Za-z]:/.test(candidate)) return false;
  const head = candidate.split('/', 1)[0].toLowerCase();
  if (SYSTEM_ROOTS.has(head)) return false;
  if (head.endsWith(':')) return false; // e.g. "https:" from a URL
  return true;
}

// =============================================================================
// The agent harness — deny-by-default (Issue #177)
// =============================================================================
//
// The paths that make up the AGENT'S OWN HARNESS: the Skill packages the worker
// and its verifier ARE, and the CommandMate configuration that decides what
// "verified" means. Measured on 0.27.0 (Kewton/BorderFreeKidsMap): an issue whose
// acceptance criterion read
//
//     `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す
//
// put that runner into `suspected_files`, which becomes the worker's
// `scope.allow` verbatim — so the worker could pass the gate by rewriting the
// judge. A gate the judged party may edit is a gate that is not there.
//
// The extraction cannot tell the two readings apart on SHAPE. A path inside a
// criterion is a COMMAND TO RUN at least as often as it is a file to write, and
// both are "a slash-bearing token with an extension" (this one is not even inside
// a single backtick token — `bash … --cwd .` carries spaces, so it is
// CANDIDATE_WITH_EXT in prose that finds it). Until now the only thing keeping
// the runner out of scope was the author remembering not to write its path — a
// convention, enforced by nobody, in the one place where being wrong costs a gate.
//
// So the harness is denied BY DEFAULT, and the issue keeps exactly ONE way to say
// otherwise: name the path under a deliverable heading (`## 対象ファイル`,
// DELIVERABLE_HEADING_RE). That is a declaration rather than an aside — the same
// distinction #50 already drew for Markdown deliverables — and it is reported as
// `harness_path_in_scope`, so the grant is never silent and never merely implied.
//
// A denied path is NOT discarded: it goes to `reference_files` ("read, not in
// scope.allow"), the channel #54 gave a context-only citation. The worker still
// learns the runner it must satisfy; it just may not write to it. This is what
// makes the drop visible without a warning of its own — a warning per denied path
// would drop nearly every real run to `partial`, since citing the verify runner in
// an acceptance criterion is the NORMAL way to write one, and a `partial` that
// fires on correct authoring is a `partial` reviewers learn to skip.
//
// HARDCODED, not declarable in the profile. Three reasons, in order of weight:
//
//   1. The profile is data the target repository supplies, and the deny-list is
//      the boundary that protects the judge from the judged. A boundary a
//      `scope_companions`-style key could relax is a boundary with a second,
//      quieter door — the hole would simply move from the issue body to the
//      profile, where no warning is attached to walking through it.
//   2. These three roots are fixed by the harness, not by the repository:
//      `.claude/skills/` and `.agents/skills/` are where CommandMate installs
//      Skill packages, `.commandmate/` is where it keeps `verify.yaml`. A
//      repository does not get to rename them, so there is nothing per-repository
//      to declare (contrast `scope_companions`, whose whole subject is a layout
//      only the repository knows — ADR §5 "却下: profile 必須にする" argues the
//      converse case for the converse reason).
//   3. The escape hatch already exists and is auditable at the point of use: the
//      issue's own deliverable heading, with a warning naming the path. A
//      repository that genuinely maintains its harness in-repo — this repository
//      does — writes `## 対象ファイル` and gets exactly that.
//
// Widening the set is therefore a code change with a fixture, which is the right
// amount of friction for a permission boundary.
//
// `HARNESS_PATH_PREFIXES` and `isHarnessPath` themselves live in lib.mjs since
// Issue #197, because refusing a harness LITERAL is part of reading a profile and
// two runners now read one (`profile-init.mjs --check` is the second). The
// argument above is the reason the set is what it is, and it is stated here
// because here is where the deny fires against an issue body. A copy of a
// permission boundary per runner is a permission boundary with a second door,
// which is the very thing reason 1 refuses.

// Splits the classified deliverable candidates into {kept, declared, denied}:
// what stays in scope, the harness paths a deliverable heading explicitly claimed
// (a subset of `kept`, and what the warning names), and the harness paths denied
// (which the caller reports as reference files). Order is preserved in all three,
// so the plan stays byte-deterministic.
function partitionHarnessPaths(candidates, deliverable) {
  const kept = [];
  const declared = [];
  const denied = [];
  for (const candidate of candidates) {
    if (!isHarnessPath(candidate)) {
      kept.push(candidate);
    } else if (deliverable.has(candidate)) {
      kept.push(candidate);
      declared.push(candidate);
    } else {
      denied.push(candidate);
    }
  }
  return { kept, declared, denied };
}

// The counterpart of FILE_EXT being a closed set (CommandMate #1678 B-1): a
// backtick path whose extension is outside it used to vanish from the plan
// silently, and because suspected_files becomes the worker's scope.allow, the
// scope gate then refused the very file the issue named — unresolvable from
// inside the worker. Extraction stays conservative; the drop is reported.
const BACKTICK_PATH_RE = /`([^`\s]*\/[^`\s]*\.[A-Za-z][A-Za-z0-9]*)`/g;

//
// With a deliverable heading (CommandMate #3002 / #3003) the extension stops
// being the reason a path is out of scope: under the heading every backtick
// file name is taken, and outside it no path is. So `spans` splits the result:
// `unrecognized` keeps the ones a deliverable heading still could not carry, and
// `prose` the ones written outside every deliverable heading of an issue that
// has one — reported as `prose_path_ignored` with the rest of the prose, not as
// an extension to fix. Without a heading `spans` is empty and everything lands
// in `unrecognized`, exactly as before.
function extractUnrecognizedPaths(text, candidates, spans = []) {
  const extracted = new Set(candidates);
  const seen = new Set();
  const unrecognized = [];
  const prose = [];
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    const candidate = match[1].trim();
    if (extracted.has(candidate) || seen.has(candidate)) continue;
    if (!isSafeRepoPath(candidate)) continue;
    // A scope PATTERN that did not reach `paths` was refused by the
    // deliverable-heading rule, not by FILE_EXT (Issue #219). `.json` is a
    // recognised extension; saying otherwise would send the author to fix a
    // spelling that is already correct. Its own report is
    // `scope_pattern_dropped`.
    if (SCOPE_PATTERN_RE.test(candidate)) continue;
    seen.add(candidate);
    if (spans.length > 0 && !inSpans(spans, match.index)) prose.push(candidate);
    else unrecognized.push(candidate);
  }
  return { unrecognized, prose };
}

function extractionWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    for (const path of analysis._unrecognizedPaths) {
      const ext = path.slice(path.lastIndexOf('.') + 1);
      out.push({
        code: 'unrecognized_file_extension',
        detail: redact(
          `#${analysis.number} writes \`${path}\` in backticks, but ".${ext}" is not a recognised extension, ` +
            "so the path is not in suspected_files and stays outside the worker's scope; " +
            'if the worker must touch it, list it in backticks under a deliverable heading (`## 対象ファイル`), ' +
            'where a file name is taken whatever its extension (CommandMate #3003), or state a path with a recognised extension',
        ),
      });
    }
    // The opposite direction of the one above: not a path that failed to reach
    // `suspected_files`, but one that reached it and had to be argued for
    // (Issue #177). It is raised only where the issue DECLARED the path under a
    // deliverable heading — the deny is the silent-by-design case, because it is
    // the correct default — so this warning always names a decision a human made,
    // and always has an addressee.
    for (const path of analysis._harnessPathsInScope) {
      out.push({
        code: 'harness_path_in_scope',
        detail: redact(
          `#${analysis.number} declares \`${path}\` under a deliverable heading (\`## 対象ファイル\` etc.), ` +
            'and it is part of the agent harness (`.claude/skills/` / `.agents/skills/` / `.commandmate/`) — ' +
            "the Skill packages the worker and its verifier are, and the config that decides what 'verified' means. " +
            'The planner keeps those out of `scope.allow` by default: a worker that may edit the runner judging it ' +
            'can pass by rewriting the judge. The declaration is honoured because it is explicit, and this warning ' +
            'is the record of it. If the issue only needs to RUN the harness, delete the path from the deliverable ' +
            'heading and cite it in prose or under a context heading (`根拠` / `参考`) instead, then re-plan; the ' +
            'worker still reads it, it just cannot write to it.',
        ),
      });
    }
    // One warning per issue, not one per pattern: an issue whose prose is full
    // of `skills/**`-style citations would otherwise bury everything beside it.
    // The tally is part of the finding, the first few patterns say WHICH, and
    // the fix is one sentence long because there is only one (Issue #219).
    if (analysis._droppedPatterns.length > 0) {
      const dropped = analysis._droppedPatterns;
      const samples = dropped.slice(0, 3).map((pattern) => `\`${pattern}\``).join(', ');
      const more = dropped.length > 3 ? `, …and ${dropped.length - 3} more` : '';
      out.push({
        code: 'scope_pattern_dropped',
        detail: redact(
          `#${analysis.number} writes ${dropped.length} scope pattern(s) outside every deliverable heading: ` +
            `${samples}${more}. A glob or a directory is permission over files nobody has enumerated, so the ` +
            'planner honours it only where the issue declares it as a product (`## 対象ファイル` / `## 成果物` / ' +
            '`## Deliverables`, DELIVERABLE_HEADING_RE); cited under `## 根拠` or written in passing prose it is ' +
            'read as a reference and stays out of `suspected_files`, hence out of the contract\'s `scope.allow`. ' +
            'If the worker must WRITE these files, move the pattern under a deliverable heading and re-plan.',
        ),
      });
    }
    // The same finding for plain paths (CommandMate #3002), in the same shape:
    // one entry per issue, a tally, the first few by name, one sentence of fix.
    if (analysis._prosePathsIgnored.length > 0) {
      const ignored = analysis._prosePathsIgnored;
      const samples = ignored.slice(0, 5).map((path) => `\`${path}\``).join(', ');
      const more = ignored.length > 5 ? `, …and ${ignored.length - 5} more` : '';
      out.push({
        code: 'prose_path_ignored',
        detail: redact(
          `#${analysis.number} has a deliverable heading, and writes ${ignored.length} path(s) only outside it: ` +
            `${samples}${more}. An issue that lists its files under \`## 対象ファイル\` / \`## 成果物\` / ` +
            '`## Deliverables` (DELIVERABLE_HEADING_RE) has declared its scope, so a path in the prose, the ' +
            'acceptance criteria or the title is read as a mention — "do not touch X" names X too — and goes to ' +
            '`reference_files` (read, not in `scope.allow`). If the worker must WRITE one of them, add it under the ' +
            'deliverable heading and re-plan.',
        ),
      });
    }
  }
  return out;
}

// The declared paths dispatch's execution contract will NOT carry (#161 / #162).
//
// A MIRROR of dispatch.mjs's `contractScopeReview`, and it has to stay one: the
// two runners are separate entry points and neither imports the other, so the
// predicate is duplicated exactly the way MAX_SCOPE_PATTERNS below already is.
// What pays for the duplication is WHEN this fires — at plan review, where the
// fix is an edit to the issue body, instead of at dispatch, where a worker has
// already been sent against a permission narrower than the plan printed and the
// contract's `scope.allow` is a send-time snapshot it cannot widen.
//
// Most shapes cannot reach here from prose: `isSafeRepoPath` already refuses an
// absolute, drive-letter, backslash, `..`-bearing or control-character candidate
// at extraction. Two can, and both are why this exists rather than being an
// assertion:
//
//   * a body can name more files than the contract's count bound, and
//   * a path can be longer than its per-pattern bound — including a path this
//     planner DERIVED, since every companion shape is longer than the source
//     path it came from (§5.1).
//
// The rest of the mirror is written out anyway. A mirror with holes is precisely
// the drift these two issues are: the derivation side got a bound guard in #147
// and #149, and the reporting side got nothing.
function contractScopeDrops(paths) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const raw of paths) {
    if (typeof raw !== 'string') { dropped.push({ pattern: String(raw), reason: 'not_a_string' }); continue; }
    const pattern = raw.trim();
    if (pattern === '') { dropped.push({ pattern: raw, reason: 'empty' }); continue; }
    if (pattern.length > MAX_SCOPE_PATTERN_LENGTH) { dropped.push({ pattern, reason: 'too_long' }); continue; }
    if (pattern.startsWith('/')) { dropped.push({ pattern, reason: 'absolute' }); continue; }
    if (/^[A-Za-z]:/.test(pattern)) { dropped.push({ pattern, reason: 'drive_letter' }); continue; }
    if (pattern.includes('\\')) { dropped.push({ pattern, reason: 'backslash' }); continue; }
    if (pattern.split('/').includes('..')) { dropped.push({ pattern, reason: 'parent_escape' }); continue; }
    if (pattern.includes('\u0000')) { dropped.push({ pattern, reason: 'nul_byte' }); continue; }
    // #219. A pattern whose every segment is `*` or `**` compiles, upstream, to
    // a regex that matches every path — so a contract carrying it has no scope
    // gate at all. It is the one shape the extraction can now produce that
    // MUST not reach `scope.allow`, and it is dropped rather than narrowed:
    // guessing what the author meant by `**` would be the derivation the ADR's
    // invariant 1 forbids.
    if (isOverBroadScope(pattern)) { dropped.push({ pattern, reason: 'over_broad' }); continue; }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    kept.push(pattern);
  }
  // dispatch SORTS before it truncates, so the entries that fall off are the
  // alphabetical tail — not the tail of the issue body. Reproducing the sort is
  // what makes the warning name the paths that will actually go missing.
  kept.sort();
  for (const pattern of kept.slice(MAX_SCOPE_PATTERNS)) dropped.push({ pattern, reason: 'over_bound' });
  return dropped;
}

// One warning per issue, never one per dropped path: 50 warnings saying the same
// thing is a wall a reviewer skips, and the count is itself part of the finding.
// The detail carries the tally, the first few paths and the two possible fixes —
// they are opposite fixes (declare FEWER files vs. write a path differently), so
// a reader who cannot tell the reasons apart cannot act.
function contractScopeWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    const dropped = contractScopeDrops(analysis.suspected_files);
    if (dropped.length === 0) continue;
    const counts = new Map();
    for (const entry of dropped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    const tally = [...counts.entries()].map(([reason, count]) => `${reason} x${count}`).join(', ');
    const samples = dropped.slice(0, 3)
      .map((entry) => `${entry.reason} \`${entry.pattern.length > 80 ? `${entry.pattern.slice(0, 80)}…` : entry.pattern}\``)
      .join('; ');
    const more = dropped.length > 3 ? `; …and ${dropped.length - 3} more` : '';
    out.push({
      code: 'contract_scope_dropped',
      detail: redact(
        `#${analysis.number}: the dispatch runner's execution contract cannot carry ${dropped.length} of the ` +
          `${analysis.suspected_files.length} path(s) in this issue's suspected_files (${tally}): ${samples}${more}. ` +
          `\`scope.allow\` is a send-time snapshot, so a worker told to edit one of them is failed by the scope gate ` +
          'with no way to widen it. `over_bound` means the issue declares more paths than the contract accepts ' +
          `(${MAX_SCOPE_PATTERNS} is CommandMate's bound, which no flag here raises) — split the issue; ` +
          '`over_broad` means the pattern grants the whole repository (`**`, `*`, `.`), which is a contract with no ' +
          'scope gate — name the directory or the file set it actually means; every other ' +
          `reason is the shape of one path — write it as a repository-relative path or glob of at most ` +
          `${MAX_SCOPE_PATTERN_LENGTH} characters. Under --unattended the dispatch runner refuses the whole plan on this`,
      ),
    });
  }
  return out;
}

// The patterns an issue's declared scope actually carries (Issue #219).
//
// ADR §2 invariant 2 — "everything added is visible" — was written for paths the
// planner DERIVES, and `scope_defaults` discharges it there. A glob discharges
// nothing: `data/geo/**` is four words that grant an unbounded set, and the plan
// cannot list what it covers without opening a working tree (invariant 3 forbids
// that, and §12 of the ADR records why). So what is reported is the DECLARATION
// — every entry of `scope.allow` that is a pattern rather than a path, named
// verbatim — and a reviewer weighs the pattern instead of the expansion.
//
// A notice, not a blocking warning (§5.6): the issue said this on purpose, under
// a deliverable heading, and refusing to plan on it would refuse the very
// declaration this feature exists to accept. `over_broad` is the one shape that
// stops a pattern, and it stops it in `contract_scope_dropped` above.
function scopePatternWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    const patterns = analysis.suspected_files.filter(
      (path) => typeof path === 'string' && SCOPE_PATTERN_RE.test(path),
    );
    if (patterns.length === 0) continue;
    const samples = patterns.slice(0, 5).map((pattern) => `\`${pattern}\``).join(', ');
    const more = patterns.length > 5 ? `, …and ${patterns.length - 5} more` : '';
    out.push({
      code: 'scope_pattern_declared',
      detail: redact(
        `#${analysis.number} declares ${patterns.length} of its ${analysis.suspected_files.length} scope ` +
          `entr${analysis.suspected_files.length === 1 ? 'y' : 'ies'} as a pattern rather than a path: ` +
          `${samples}${more}. The contract carries them verbatim and CommandMate's scope gate adjudicates ` +
          'them (`**` crosses directories, `*` and `?` do not, `{a,b}` alternates, `[` and `]` are literal, ' +
          'and a directory covers everything beneath it). Nothing here expands them, so what a reviewer ' +
          'weighs is the pattern: read each one as the permission it is.',
      ),
    });
  }
  return out;
}

// An open question is a thing the planner could NOT read out of the issue, so it
// belongs in `warnings` — the channel that drops `status` to `partial` — and not
// only in `issues[].questions`, which nothing downstream was obliged to look at
// (Issue #52). Before this, an issue with no acceptance criteria at all planned
// as a clean `success` with exit 0 and flowed straight into dispatch.
function openQuestionWarnings(analyses) {
  const out = [];
  for (const analysis of analyses) {
    for (const question of analysis._openQuestions) {
      out.push({
        code: question.code,
        detail: redact(
          `#${analysis.number}: ${question.text} ` +
            'The dispatch runner refuses an issue with an unanswered question; ' +
            'edit the issue body and re-plan, or accept the risk explicitly with --allow-questions.',
        ),
      });
    }
  }
  return out;
}

// The extension alone cannot decide whether a path is context or product
// (Issue #50). A documentation path is USUALLY context to read — but an issue
// whose deliverable IS a Markdown document (a design note, an ADR, a runbook)
// named every file it had to write and still got an empty suspected_files, so
// the contract declared no scope and the worker was refused by the scope gate
// for writing exactly what it was told to write. A path under a "成果物 /
// 対象ファイル / 変更対象 / Deliverables" heading is the issue stating what it
// produces, and that statement outranks the extension rule. Anywhere else a
// .md/.rst/.txt or docs/ path stays a reference.
//
// The symmetric statement is a path mentioned only under a context heading
// (Issue #54): the issue is citing it, not claiming it. Extension says nothing
// about that case — a cited `src/foo.ts` is code — so the position has to.
//
// The third statement is position again (CommandMate #3002): in an issue that
// has a deliverable heading, a path written only outside it is read, not
// written. It is checked LAST, so `ignored` holds exactly the paths this rule
// moved — the ones that would have reached scope.allow before it existed — and
// a cited path or a document, which were references already, is not reported a
// second time.
function classifyFileCandidates(candidates, deliverable, contextOnly, proseOnly = new Set()) {
  const suspected = [];
  const references = [];
  const ignored = [];
  for (const candidate of candidates) {
    if (contextOnly.has(candidate)) {
      references.push(candidate);
    } else if (!deliverable.has(candidate) && (/^docs\//.test(candidate) || /\.(md|rst|txt)$/i.test(candidate))) {
      references.push(candidate);
    } else if (proseOnly.has(candidate)) {
      references.push(candidate);
      ignored.push(candidate);
    } else {
      suspected.push(candidate);
    }
  }
  return { suspected, references, ignored };
}

// Ecosystem lockfiles that a dependency-manifest edit drags along (CommandMate
// #1678 B-2): `npm install` rewrites the lockfile next to the package.json it
// changed, and a lockfile missing from suspected_files — the worker's future
// scope.allow — fails the scope gate in a way the worker cannot resolve. When an
// issue names a manifest, its same-directory lockfiles are therefore allowed by
// default, and reported in the plan's `scope_defaults` so a reviewer sees which
// entries the planner added on the issue's behalf rather than read in the issue.
const SCOPE_DEFAULT_COMPANIONS = {
  'package.json': ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  'Cargo.toml': ['Cargo.lock'],
  'go.mod': ['go.sum'],
  'pyproject.toml': ['poetry.lock', 'uv.lock'],
  'Gemfile': ['Gemfile.lock'],
};

function scopeDefaultsFor(suspected) {
  const have = new Set(suspected);
  const out = [];
  for (const path of suspected) {
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut + 1);
    for (const name of SCOPE_DEFAULT_COMPANIONS[path.slice(cut + 1)] ?? []) {
      const companion = `${dir}${name}`;
      if (!have.has(companion)) {
        have.add(companion);
        out.push(companion);
      }
    }
  }
  return out;
}

// =============================================================================
// Test companions — layer L1 of references/adr-scope-derivation.md (Issue #147)
// =============================================================================
//
// The same failure as the lockfile case above, and the same fix. An issue that
// names only the implementation file produces a scope.allow with no test path in
// it, so a worker that writes the test its OWN acceptance criteria demand is
// failed by the scope gate — and the contract's scope is a send-time snapshot,
// so the worker cannot resolve it. Measured three times now (#56 = extraction,
// #44 = lockfiles, #145 = tests), each time as a whole worker run lost to a file
// the issue forgot to write down. The planner therefore allows the CONVENTIONAL
// test paths of every source file the issue declared and reports them in
// `scope_defaults`, exactly as it already does for lockfiles.
//
// Two properties keep this from re-opening the hole #50 closed:
//
//   * Every derived path is a function of a DECLARED path. No bare glob
//     (`**/*.test.*`) is ever added, so an issue that declares nothing derives
//     nothing and the blast radius stays proportional to the declaration
//     (ADR section 2, invariant 1).
//   * An allowance nobody uses costs nothing. Test layout is a repository
//     CONVENTION, so this derivation is a guess by construction — but
//     `scope.allow` is a PERMISSION, not an instruction. Allowing
//     `session.test.ts`, `session.spec.ts` and `__tests__/session.ts` when the
//     repo uses one of the three wastes two patterns that never match anything;
//     allowing none of them wastes a worker's run.
//
// Which shapes an extension gets is decided per ecosystem rather than once for
// all, because FILE_EXT already spans `go|py|java|kt|rb` and a JS-only rule would
// leave exactly those issues with the failure this exists to remove. The
// reasoning per family is on each branch of testCompanionShapes below.

// Mirrors dispatch.mjs MAX_SCOPE_PATTERNS. That runner SORTS scope.allow and
// then `.slice(0, 200)`s it, so an over-long list does not merely lose its
// derived tail — it can drop a DECLARED file in favour of an alphabetically
// earlier derived one, which is the very failure this feature removes. The
// derivation therefore stops at a source-file boundary before the issue's
// de-duplicated total can reach the bound. In practice no fixture comes close
// (the widest shape is 4 paths per source file), but the guard is what makes
// "derived paths never displace declared ones" a property rather than a hope.
const MAX_SCOPE_PATTERNS = 200;

// The other half of the same contract bound, mirrored for contractScopeWarnings
// above. A derived companion is always LONGER than the path it was derived from
// (`__tests__/` and `.test.` are both insertions), so this is the one dispatch
// drop the derivation itself can cause.
const MAX_SCOPE_PATTERN_LENGTH = 200;

// Directory names that mean "everything below me is already test material".
// Matched as whole path segments, never as substrings: `src/latest/render.ts`
// is not a test file.
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testdata']);

// File names that are already a test, in the shapes the rules below emit plus
// the ones adjacent to them:
//   `session.test.ts` `session.spec.tsx` `session-test.js`   (JS/TS)
//   `session_test.go` `session_test.py`  `session_spec.rb`   (Go / Python / Ruby)
//   `test_session.py`                                        (Python, pytest)
//   `SessionTest.java` `SessionSpec.kt`  `SessionIT.java`    (JVM)
// Without this, `session.test.ts` in a body would derive `session.test.test.ts`
// — a path that cannot exist, and one more pattern eating the scope budget.
const TEST_FILE_RE = /^test_|[._-](test|spec)\.[A-Za-z0-9]+$|(Test|Tests|Spec|IT)\.(java|kt)$/;

function isTestPath(path) {
  const segments = path.split('/');
  const file = segments.pop();
  if (segments.some((segment) => TEST_DIR_SEGMENTS.has(segment))) return true;
  return TEST_FILE_RE.test(file);
}

// Jest, Vitest and Mocha all resolve a sibling `*.test.*`/`*.spec.*`, and
// `__tests__/` is the layout Jest's default testMatch documents. All three are
// in live use side by side, and the planner cannot open the repository to learn
// which one this repo picked (orchestrate.mjs never does — see the comment above
// the acceptance-gates parser), so all three are allowed.
const JS_TEST_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

// The conventional test paths of one source file, in a fixed order. An extension
// with no entry here yields NOTHING, which is what keeps a `.md` / `.json` /
// `.yaml` / lockfile / `Makefile` issue from deriving anything at all: the
// non-source exclusion is not a deny-list to maintain, it is the absence of a
// rule. `.rs`, `.sh`, `.c`, `.sql`, `.css`, `.html` are deliberately absent too:
// Rust's unit tests live INSIDE the source file (`#[cfg(test)] mod tests`),
// which is already in scope, and its integration tests are named after an
// intent rather than a module, while shell and the C family have no convention
// a path alone can predict (`*.bats`, `test_*.sh`, `*_test.c`, `check_*.c` are
// all common). Guessing there would spend scope budget on paths no repository
// has. Add an ecosystem when an issue shows the shape it actually needs — the
// same rule SCOPE_DEFAULT_COMPANIONS and FILE_EXT are maintained by.
function testCompanionShapes(dir, base, ext) {
  if (JS_TEST_EXTENSIONS.has(ext)) {
    return [
      `${dir}${base}.test.${ext}`,
      `${dir}${base}.spec.${ext}`,
      `${dir}__tests__/${base}.${ext}`,
      `${dir}__tests__/${base}.test.${ext}`,
    ];
  }
  // Go: `go test` only recognises `_test.go` in the SAME package directory, so
  // there is exactly one shape and no guesswork.
  if (ext === 'go') return [`${dir}${base}_test.go`];
  // Python: pytest's default discovery is `test_*.py`, found either beside the
  // module or under a top-level `tests/`. Both are ubiquitous and neither is
  // derivable from the other, so both are allowed (ADR section 5).
  if (ext === 'py') return [`${dir}test_${base}.py`, `tests/test_${base}.py`];
  // Ruby: RSpec's `_spec.rb`.
  if (ext === 'rb') return [`${dir}${base}_spec.rb`];
  // JVM: NOT in the ADR's table, added here because FILE_EXT accepts `java|kt`
  // and leaving them out would reproduce the JS-only asymmetry the ADR rejects.
  // Maven and Gradle both mirror `src/main/<lang>/…/Foo.java` into
  // `src/test/<lang>/…/FooTest.java`, which is as mechanical as Go's rule, so
  // the mirror is emitted whenever the declared path actually carries a
  // `src/main/` segment. The sibling `FooTest.java` is emitted as well for the
  // single-module and Android-style trees that do not use that layout.
  if (ext === 'java' || ext === 'kt') {
    const shapes = [`${dir}${base}Test.${ext}`];
    const mirrored = dir.replace(/(^|\/)src\/main\//, '$1src/test/');
    if (mirrored !== dir) shapes.push(`${mirrored}${base}Test.${ext}`);
    return shapes;
  }
  return [];
}

// `suspected` is the DECLARED file list and `added` the defaults already chosen
// for this issue (the lockfiles). Both are read, neither is mutated: the caller
// appends the return value to `scope_defaults` and to `suspected_files` in one
// place, so "added to the scope" and "reported in the plan" cannot drift apart
// (ADR section 2, invariant 2).
//
// Deterministic by construction — the declared list is walked in order, each
// file's shapes are emitted in the fixed order above, and nothing is sorted or
// read out of a Set — so the same plan input still produces a byte-identical
// plan and hence a byte-identical contract (dispatch-contract.md section on
// determinism, invariant 3).
function testScopeDefaultsFor(suspected, added) {
  const have = new Set([...suspected, ...added]);
  const out = [];
  for (const path of suspected) {
    if (isTestPath(path)) continue;
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut + 1);
    const file = path.slice(cut + 1);
    const dot = file.lastIndexOf('.');
    // `dot <= 0` covers both the extensionless name (`Makefile`) and the dotfile
    // whose leading dot is not an extension separator (`.gitignore`).
    if (dot <= 0) continue;
    const fresh = testCompanionShapes(dir, file.slice(0, dot), file.slice(dot + 1))
      .filter((companion) => !have.has(companion));
    if (fresh.length === 0) continue;
    if (have.size + fresh.length > MAX_SCOPE_PATTERNS) break;
    for (const companion of fresh) {
      have.add(companion);
      out.push(companion);
    }
  }
  return out;
}

// =============================================================================
// Test demand vs. scope — layer L3 of references/adr-scope-derivation.md (#145)
// =============================================================================
//
// The residue L1 above cannot reach. L1 derives the CONVENTIONAL test paths of
// every declared source file, so the measured failure — an issue whose acceptance
// criteria demand a unit test, whose 対象ファイル lists only the implementation,
// and whose worker is then failed by the scope gate for writing exactly that test
// — now disappears with nobody doing anything, FOR A REPOSITORY WHOSE LAYOUT IS
// ONE OF L1's SHAPES. What is left is the repository whose convention the planner
// does not know: a layout L1 does not emit, with no L2 `scope_companions`
// declared yet (#149). There the whole run is still lost, and the loss is total —
// the worker cannot resolve it (the contract's scope is a send-time snapshot) and
// neither can the planner (it never opens the target repository).
//
// So the planner says so, to a human, BEFORE dispatch: one warning and one open
// question. The question is what makes it stop anything. `plan.status` is read by
// nobody downstream, while dispatch refuses an issue carrying an unanswered
// question — and does it in pre-flight, before `--out` exists, so a false
// positive costs nothing but the re-plan the true positive would have cost
// anyway (ADR section 7).
//
// ---- 裁定 A (ADR section 8) -------------------------------------------------
//
//   推論は機械を止めてよいが、機械に指示してはならない。
//   An inference may stop the machine; it must not instruct the machine.
//
// This detector writes ZERO bytes into `acceptance_gates` and ZERO bytes into
// `scope.allow`. Its only output is text a human reads. `questions` does stop
// dispatch, so the influence on the machine is not nil — the exact line is that
// it STOPS the machine and never TELLS IT WHAT TO DO. L1 above is allowed into
// the scope because it applies a RULE to declared paths; L3 reads intent out of
// prose, so it is not.
//
// ---- Why the precision work below is the feature ----------------------------
//
// The two questions this one joins (`no_acceptance_criteria`,
// `no_suspected_files`) are `length === 0` tests: nothing is interpreted, so they
// cannot be wrong about what a body says. This one reads Japanese and English
// prose, and it shares their channel — the flag that waves it through,
// `--allow-questions`, applies to the WHOLE plan. One false positive here teaches
// an operator to reach for that flag by habit, which silences a real
// `no_acceptance_criteria` along with it. Precision is bought three ways:
//
//   1. Only `acceptance_criteria` is scanned, never the whole body. A body that
//      discusses testing somewhere is not a body that demands a test as a
//      condition of done.
//   2. A criterion must name a test AND carry an active demand, or must name a
//      test-shaped path outright. "the unit test is green" is an observation, not
//      a request to write one.
//   3. Four negative shapes veto a criterion outright. Each is a thing a human
//      actually writes, and each would otherwise fire, because "add a backoff
//      cap, no unit test needed" carries both a test noun and the verb 追加.
//      Exclusion is evaluated FIRST and wins: a criterion that says both is a
//      criterion whose author already answered this question.

// A test artifact, named. `spec` on its own is deliberately absent — in an
// acceptance criterion "the spec" is as often the specification as it is an RSpec
// file, and the `*_spec.rb` / `*.spec.ts` shapes are reached by the path rule
// below instead. The runner names are unambiguous and worth having.
const TEST_NOUN_RE = /テスト|\btest(?:s|ing)?\b|\btest\s+cases?\b|\btest\s+suite\b|\brspec\b|\bjest\b|\bvitest\b|\bpytest\b/i;

// An ACTIVE demand: the criterion asks for the test to come into existence, or
// makes the test the thing that DECIDES the criterion ("unit test がそれを判定
// する" — the shape the reported issue used). 緑 / green is pointedly not here: a
// criterion that only observes a test passing is satisfied by a repository that
// already has it, and a scope with no test path in it is then correct.
const TEST_DEMAND_RE =
  /追加|作成|新規|新設|導入|用意|足す|足し|書く|書き|実装|固定|網羅|カバー|判定|証明|示す|\b(?:add(?:s|ed|ing)?|writ(?:e|es|ten|ing)|creat(?:e|es|ed|ing)|new|introduc(?:e|es|ed)|cover(?:s|ed|ing)?|assert(?:s|ed|ing)?|prov(?:e|es|en)|pin(?:s|ned)?|decid(?:e|es)|determin(?:e|es)|extend(?:s|ed)?)\b/i;

// ---- Exclusion 1: a test is explicitly not wanted ---------------------------
// 「テストは不要」/ "no new tests". The author already made this call, and a
// planner that stops the run to ask anyway is overruling a stated decision — the
// single fastest way for this warning to lose a reader's trust.
//
// The English arms allow up to two words between the negation and the noun
// because that is where a real sentence puts them ("no new unit test is needed",
// "without adding a test"). It buys the exclusion a shape it would otherwise
// miss, at the price of vetoing a criterion that says "there is no way the test
// can …" — a sentence an acceptance criterion does not write, and one whose cost
// if it ever appears is a re-plan rather than a lost run.
const TEST_NOT_WANTED_RE =
  /不要|要らない|いらない|不必要|なくてよい|無くてよい|省略|\bno\s+(?:\w+\s+){0,2}tests?\b|\bnot\s+(?:required|needed|necessary)\b|\bwithout\s+(?:\w+\s+){0,2}tests?\b/i;

// ---- Exclusion 2: existing tests merely have to keep passing -----------------
// 「既存の…テストが緑のまま」/ "existing tests still pass". That is a REGRESSION
// condition: it is satisfied by touching no test file at all, so a scope with no
// test path in it is right rather than short. 既存 / existing alone must NOT veto
// — 「既存のテストに1件追加する」 is a real demand — so the veto needs the
// "stays as it is" half within the same clause, which is what the bounded gap
// (never across a 。 / ".") enforces.
const TESTS_STAY_GREEN_RE =
  /(?:既存|現行|従来)[^。]{0,40}?(?:緑|パス|通る|通り|落ちない|壊れない|そのまま|まま)|\b(?:existing|current)\b[^.]{0,50}?\b(?:stay|stays|remain|remains|still|keep|keeps|unchanged|green|pass|passes|passing)\b|\b(?:stay|stays|remain|remains)\s+green\b|\bstill\s+pass(?:es)?\b/i;

// ---- Exclusion 3: the check is manual ---------------------------------------
// 「手動テストで確認」/ "verified by hand". A manual test is not a file, so no
// scope entry could answer the question this would raise. The veto covers the
// whole criterion rather than the clause it sits in: a single bullet demanding
// both an automated and a manual test is rare enough that missing it costs less
// than stopping a run for a question with no answer.
const MANUAL_TEST_RE = /手動|手作業|目視|\bmanual(?:ly)?\b|\bby\s+hand\b/i;

// ---- Exclusion 4: the tests are explicitly out of scope ---------------------
// 「テストは変更しない」/ "the tests are unchanged". The strongest of the four:
// the author is saying the very file this detector would ask for must not be
// touched. Adding it to the scope would be the opposite of what the issue wants.
const TESTS_UNCHANGED_RE =
  /テスト[^。]{0,24}?(?:変更しない|変えない|触らない|触れない|変わらない|いじらない)|\btests?\b[^.]{0,40}?\b(?:unchanged|untouched)\b|\bdo(?:es)?\s+not\s+(?:change|modify|touch|update)\b[^.]{0,30}?\btests?\b|\btests?\b[^.]{0,30}?\bare\s+not\s+(?:changed|modified|touched|updated)\b/i;

// Four separate statements, not one fused regex: each is a line drawn for its own
// reason above, and each has to be removable on its own to be shown — by mutation
// — to be carrying weight rather than shadowed by a neighbour.
function testDemandExcluded(criterion) {
  if (TEST_NOT_WANTED_RE.test(criterion)) return true;
  if (TESTS_STAY_GREEN_RE.test(criterion)) return true;
  if (MANUAL_TEST_RE.test(criterion)) return true;
  if (TESTS_UNCHANGED_RE.test(criterion)) return true;
  return false;
}

// A path candidate as it appears inside ONE criterion. Deliberately looser than
// CANDIDATE_WITH_EXT in one way — no leading directory is required — because that
// is exactly the gap this branch covers: the body extractor reads an
// un-backticked token as a path only when it contains a "/", so `retry.test.ts`
// written bare in prose never becomes a suspected file. The criterion then asks
// for a path the scope does not have and NOTHING ELSE in the plan says so.
// `session_test.go` and `parser_spec.rb` need this branch for a second reason:
// "_test" carries no word boundary, so TEST_NOUN_RE cannot see the test in them.
const CRITERION_PATH_RE = new RegExp(
  PATH_START + '((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:' + FILE_EXT + '))\\b',
  'g',
);

// `isTestPath` is the SAME predicate applied to suspected_files below, so "the
// criterion names a test path" and "the scope holds a test path" cannot disagree
// about what a test path is.
function mentionsTestPath(criterion) {
  for (const match of criterion.matchAll(CRITERION_PATH_RE)) {
    if (isTestPath(match[1])) return true;
  }
  return false;
}

// The first criterion that actively demands a test, VERBATIM, or null. The text
// is returned rather than a boolean because the question quotes it: "why did this
// stop" has to be readable without opening the issue, which is what makes
// confirming a false positive a matter of seconds. It is not truncated — a
// criterion is one bullet line, already normalised by cleanCriterion and
// redacted, and cutting it would hide the demand whenever it sits at the end.
function testCreationDemand(criteria) {
  for (const criterion of criteria) {
    if (testDemandExcluded(criterion)) continue;
    // A named test file is a demand by itself: the author wrote down the path
    // they expect to exist, so no verb has to agree with it.
    if (mentionsTestPath(criterion)) return criterion;
    if (TEST_NOUN_RE.test(criterion) && TEST_DEMAND_RE.test(criterion)) return criterion;
  }
  return null;
}

// Verification commands the issue text names, recognised by the binaries the
// profile's baseline uses plus a small generic set. Nothing is hardcoded to one
// ecosystem: the recognised binaries are derived from the active profile.
const GENERIC_VERIFY_BINARIES = ['make', 'bash', 'sh', 'pytest', 'go', 'node', 'python3', 'python'];

function verifyBinaries(profile) {
  const set = new Set(GENERIC_VERIFY_BINARIES);
  for (const command of profile.baseline) {
    const head = command.trim().split(/\s+/, 1)[0];
    if (head) set.add(head);
  }
  return set;
}

function extractTestExpectations(text, binaries) {
  const out = [];
  const seen = new Set();
  const codeSpans = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) codeSpans.push(match[1]);
  for (const match of text.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    for (const line of match[1].split(/\r?\n/)) codeSpans.push(line);
  }
  for (const span of codeSpans) {
    const command = span.trim();
    const head = command.split(/\s+/, 1)[0];
    if (binaries.has(head) && !seen.has(command)) {
      seen.add(command);
      out.push(command);
    }
  }
  return out;
}

// =============================================================================
// Acceptance gates — the machine-readable acceptance block (Issue #114)
// =============================================================================
//
// The notation's 正本 is references/acceptance-gates-notation.md; this parser and
// that document must be changed in the same commit. Everything here is SYNTAX
// only: the planner never opens the target repository, so it cannot know which
// gate ids exist. Resolving them against `.commandmate/verify.yaml` is dispatch's
// job (ADR §3.4).
//
// The one invariant: ONLY an explicitly marked block reaches the contract.
// Nothing is inferred from prose, bullet lists or tables — see the ADR §2.3 and
// `extractTestExpectations` below, whose output is advisory for exactly this
// reason. A gate nobody wrote down is a gate nobody approved.
const ACCEPTANCE_GATES_INFO = 'acceptance-gates';
const ACCEPTANCE_GATES_VERSION = 1;

// The opening fence, counted on its own so "two blocks" is detected even when the
// second one is malformed. `m` makes `^`/`$` line anchors; the info string must be
// the whole word, so ```acceptance-gates-v2 is not this block.
const ACCEPTANCE_GATES_OPEN_RE = /^```acceptance-gates[ \t]*$/gm;
// A complete block. Non-greedy to the first closing fence at a line start.
const ACCEPTANCE_GATES_BLOCK_RE = /^```acceptance-gates[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;

// Mirrors CommandMate's GATE_ID_PATTERN (lib/verification/verify-config) and
// dispatch.mjs GATE_ID_RE. An id this rejects is one `send --contract` would
// reject, so accepting it here would only move the failure later.
const ACCEPTANCE_GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Same bound as the contract's verify.gates list (dispatch.mjs MAX_GATE_IDS).
const MAX_ACCEPTANCE_GATE_IDS = 32;

// The ids CommandMate keeps for its built-in gates (verify-config's
// RESERVED_GATE_IDS: work-evidence, scope, env-clean). `validateGateEntries` —
// the SAME function that reads `.commandmate/verify.yaml` — refuses them for a
// contract's `verify.gateDefinitions`, so a block that redefines one is an
// `exit 2` at send. Refusing it here names the problem while the author is still
// looking at the block (Issue #125 / ADR §3.5).
const ACCEPTANCE_GATE_RESERVED_IDS = ['work-evidence', 'scope', 'env-clean'];
// verify-config's MIN_TIMEOUT_SEC / MAX_TIMEOUT_SEC, applied to a gate this block
// DEFINES. Transcribed rather than derived for the same reason the id pattern is.
const MIN_ACCEPTANCE_GATE_TIMEOUT_SEC = 1;
const MAX_ACCEPTANCE_GATE_TIMEOUT_SEC = 7200;
// The #1771 / #1772 fields a gate entry may also carry (Issues #223 / #224).
// Upstream runs ONE validator over both `.commandmate/verify.yaml` gates and a
// contract's `verify.gateDefinitions` (verify-config.ts `validateGateEntries`),
// so a key accepted there is accepted here, with the same value domains: a
// resource name that is safe as a path segment, a retry ceiling of exactly 1
// because the ceiling is the feature, and a `flakyIsPass` that cannot be
// declared where no retry can ever produce a FLAKY to reclassify.
const ACCEPTANCE_GATE_MUTEX_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_ACCEPTANCE_GATE_MUTEX_LENGTH = 64;
const MAX_ACCEPTANCE_GATE_RETRY_ON_FAIL = 1;

// Removing the block before the prose extractors run is NOT tidiness — it is a
// correctness fix measured on the current regexes (ADR §10 item 3). The fence
// pattern in `extractTestExpectations` is /```[a-zA-Z]*\n([\s\S]*?)```/g, which
// cannot match `acceptance-gates` as an INFO STRING (the hyphen is outside
// [a-zA-Z]) — but it happily matches this block's CLOSING fence as an opening
// one, pairs it with the next block's opening fence, and thereby swallows the
// following ```bash block whole. Measured: a body with one acceptance-gates
// block followed by a bash block dropped 2 of its 3 test_expectations. Stripping
// restores the extraction byte for byte.
//
// The same strip is applied to every prose extractor, not just that one: the
// block is a machine contract, and reading `  - verify-selftest` inside it as an
// acceptance-criteria bullet or a path candidate is the Issue #54 category error
// (position and explicit marking decide intent) pointed the other way.
function stripAcceptanceGateBlocks(text) {
  return String(text).replace(ACCEPTANCE_GATES_BLOCK_RE, '');
}

function countAcceptanceGateBlocks(text) {
  return [...String(text).matchAll(ACCEPTANCE_GATES_OPEN_RE)].length;
}

// The YAML subset the block is written in — the same one `.commandmate/verify.yaml`
// uses: 2-space indent, single-line scalars, comments only at column 0, no
// anchors, no flow collections, no multi-line strings. Deliberately NOT
// best-effort: a block this cannot read becomes an open question, never a guess
// (ADR §2.4). Returns {ok, value} or {ok:false, code, reason}.
function parseAcceptanceGatesBlock(raw) {
  const bad = (code, reason) => ({ ok: false, code, reason });
  const lines = String(raw).split(/\r?\n/);
  const value = { version: ACCEPTANCE_GATES_VERSION, require: [] };
  const defined = [];
  const seenKeys = new Set();
  let sawVersion = false;
  let section = null; // null | 'require' | 'gates'

  for (const line of lines) {
    if (line.includes('\t')) return bad('acceptance_gate_block_invalid', 'a tab character is not allowed; the block is indented with 2 spaces');
    if (line.trim() === '') continue;
    // 行頭 `#` のみコメント: a `#` anywhere else is part of the value, so a
    // trailing "# note" is a syntax error rather than something silently dropped.
    if (line.startsWith('#')) continue;
    if (line === '---' || line === '...') return bad('acceptance_gate_block_invalid', 'YAML document markers are not part of the subset');

    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);

    if (indent === 0) {
      section = null;
      const match = /^([a-zA-Z][a-zA-Z0-9_]*):[ \t]*(.*)$/.exec(content);
      if (match === null) return bad('acceptance_gate_block_invalid', `"${content}" is not a "key: value" line at the top level`);
      const [, key, rest] = match;
      if (seenKeys.has(key)) return bad('acceptance_gate_block_invalid', `duplicate key "${key}"`);
      seenKeys.add(key);
      if (!sawVersion && key !== 'version') {
        return bad('acceptance_gate_block_invalid', '"version: 1" must be the first key of the block');
      }
      if (key === 'version') {
        sawVersion = true;
        if (rest !== String(ACCEPTANCE_GATES_VERSION)) {
          // Not rounded forward: an unknown version means the block was written
          // against a notation this runner does not implement, and reading it as
          // v1 would enforce something other than what the author wrote.
          return bad('acceptance_gate_block_invalid', `version must be exactly ${ACCEPTANCE_GATES_VERSION} (got "${rest}")`);
        }
        continue;
      }
      if (key === 'require') {
        if (rest !== '') return bad('acceptance_gate_block_invalid', '"require:" takes a block sequence on the following lines, not an inline value');
        section = 'require';
        continue;
      }
      if (key === 'gates') {
        // Stage 2, enforced since Issue #125. `gates:` declares a NEW command,
        // and the definition travels in the EXECUTION CONTRACT's
        // `verify.gateDefinitions` (CommandMate #1791) — nothing is ever written
        // into the worktree's `.commandmate/verify.yaml`. That is what unblocked
        // it: the file stays in the work-evidence change set on purpose (so an
        // agent weakening its own judge is still detectable), while the contract
        // is already snapshotted into `tasks.contract_json` and already excluded,
        // so carrying the definition there adds no new tamper surface.
        if (rest !== '') return bad('acceptance_gate_block_invalid', '"gates:" takes a block sequence on the following lines, not an inline value');
        section = 'gates';
        continue;
      }
      return bad('acceptance_gate_block_invalid', `unknown key "${key}" (the v1 block accepts only version, require, gates)`);
    }

    // A `gates:` entry spans two indent levels (`  - id:` and its `    command:`
    // / `    timeoutSec:` fields), so it is read by its own reader rather than by
    // the single-line rule below.
    if (section === 'gates') {
      const problem = readAcceptanceGateDefinition(defined, indent, content);
      if (problem !== null) return bad('acceptance_gate_block_invalid', problem);
      continue;
    }
    if (indent !== 2) return bad('acceptance_gate_block_invalid', `unexpected indentation of ${indent} space(s); list items are indented by exactly 2`);
    if (section !== 'require') return bad('acceptance_gate_block_invalid', `"${content}" is indented but no list is open above it`);
    const item = /^-[ \t]+(.*)$/.exec(content);
    if (item === null) return bad('acceptance_gate_block_invalid', `"${content}" is not a "- <gate-id>" list item`);
    const id = item[1];
    if (!ACCEPTANCE_GATE_ID_RE.test(id)) {
      return bad('acceptance_gate_block_invalid', `"${id}" is not a valid gate id (${ACCEPTANCE_GATE_ID_RE.source}); quoting, inline comments and flow syntax are not part of the subset`);
    }
    if (value.require.includes(id)) return bad('acceptance_gate_block_invalid', `duplicate gate id "${id}"`);
    value.require.push(id);
    if (value.require.length > MAX_ACCEPTANCE_GATE_IDS) {
      return bad('acceptance_gate_block_invalid', `at most ${MAX_ACCEPTANCE_GATE_IDS} gate ids may be required`);
    }
  }

  if (!sawVersion) return bad('acceptance_gate_block_invalid', 'the block declares no "version: 1"');
  // A definition with no command is the one gate shape `validateGateEntries`
  // rejects that cannot be seen line by line: the id line is well formed and the
  // command line is simply absent, so the entry only becomes wrong once the
  // block ends.
  const commandless = defined.find((gate) => gate.command === null);
  if (commandless !== undefined) return bad('acceptance_gate_block_invalid', `gate "${commandless.id}" declares no command; a gate that runs nothing cannot judge anything`);
  // The other rule that cannot be seen line by line (Issue #224): a declaration
  // that can never fire is a config error, not a preference. Without a retry the
  // gate has no FLAKY outcome for `flakyIsPass` to reclassify, so the line reads
  // as "flakes are tolerated here" while changing nothing at all.
  const unfirable = defined.find((gate) => gate.flakyIsPass === true && gate.retryOnFail !== MAX_ACCEPTANCE_GATE_RETRY_ON_FAIL);
  if (unfirable !== undefined) {
    return bad('acceptance_gate_block_invalid', `gate "${unfirable.id}" declares flakyIsPass: true without retryOnFail: ${MAX_ACCEPTANCE_GATE_RETRY_ON_FAIL}; without a retry a gate can never be FLAKY, so the declaration could never take effect`);
  }
  // `require` and `gates[].id` share ONE id space: a definition is selected by
  // the same `verify.gates` list a `require` id goes into, and the upstream
  // parser refuses a duplicate there. Checking both lists together is also what
  // makes "declared twice, once as a selection and once as a definition"
  // impossible to write.
  const declaredIds = new Set();
  for (const id of [...value.require, ...defined.map((gate) => gate.id)]) {
    if (declaredIds.has(id)) return bad('acceptance_gate_block_invalid', `duplicate gate id "${id}"`);
    declaredIds.add(id);
  }
  // NOT truncated to the bound — the discipline dispatch-contract.md §2.4.1 puts
  // on a transcript that does not fit: a block that names 33 gates and is
  // dispatched with 32 is a run that dropped a declared requirement and said
  // nothing. It is refused, and the count is named.
  if (declaredIds.size > MAX_ACCEPTANCE_GATE_IDS) {
    return bad('acceptance_gate_block_invalid', `at most ${MAX_ACCEPTANCE_GATE_IDS} gate ids may be required and defined together, and this block declares ${declaredIds.size}; the list is NOT cut to fit`);
  }
  // An empty block is the same contract error as `verify.gates: []`: it declares
  // a requirement set and then names nothing, which reads as "no requirement"
  // exactly where the author meant to state one.
  if (declaredIds.size === 0) return bad('acceptance_gate_block_invalid', 'the block requires no gate; remove it, or name at least one gate id under "require:" or define one under "gates:"');
  // Absent rather than empty when the block defines nothing, so an issue that
  // only uses `require:` produces the same plan bytes it produced before this
  // key existed (ADR §7's non-regression, read at the plan level).
  if (defined.length > 0) value.gates = defined;
  return { ok: true, value };
}

// One line of a `gates:` entry, appended to `entries`. Returns null when the line
// was read, or the reason it could not be.
//
// The shape is `.commandmate/verify.yaml`'s `gates[]` entry, key for key — that
// is the whole point of the notation (§2: a copy, never a re-encoding), and it is
// also what makes the block checkable against the constraints CommandMate's
// `validateGateEntries` applies to the contract: the id pattern, the reserved
// ids, the integer timeout and its range. An entry this accepts is one
// `send --contract` accepts; an entry it refuses would have been an exit 2 with
// the author no longer looking.
function readAcceptanceGateDefinition(entries, indent, content) {
  if (indent === 2) {
    const opener = /^-[ \t]+id:[ \t]*(.*)$/.exec(content);
    if (opener === null) return `"${content}" is not a "- id: <gate-id>" list item; a gate entry opens with its id`;
    const id = opener[1];
    if (!ACCEPTANCE_GATE_ID_RE.test(id)) {
      return `"${id}" is not a valid gate id (${ACCEPTANCE_GATE_ID_RE.source}); quoting, inline comments and flow syntax are not part of the subset`;
    }
    if (ACCEPTANCE_GATE_RESERVED_IDS.includes(id)) {
      return `"${id}" is reserved for a built-in gate (${ACCEPTANCE_GATE_RESERVED_IDS.join(', ')}); a contract that redefines one is refused at send`;
    }
    entries.push({ id, command: null });
    return null;
  }
  if (indent !== 4) return `unexpected indentation of ${indent} space(s); a gate's fields are indented by exactly 4`;
  if (entries.length === 0) return `"${content}" is a gate field with no "- id:" line above it`;
  const field = /^([a-zA-Z][a-zA-Z0-9_]*):[ \t]*(.*)$/.exec(content);
  if (field === null) return `"${content}" is not a "key: value" line inside a gate`;
  const [, key, rest] = field;
  const entry = entries[entries.length - 1];
  if (key === 'command') {
    if (entry.command !== null) return `gate "${entry.id}" declares "command" twice`;
    // The one place a quoted scalar is part of the subset. verify.yaml quotes its
    // commands (a bare `python3 x.py --json` would otherwise read a `:` as a
    // mapping), so the notation that mirrors verify.yaml has to accept the same
    // spelling. Ids stay unquoted — there the quotes would be the value.
    const command = unquoteAcceptanceGateScalar(rest);
    if (command.trim() === '') return `gate "${entry.id}" declares an empty command`;
    entry.command = command;
    return null;
  }
  if (key === 'timeoutSec') {
    if (entry.timeoutSec !== undefined) return `gate "${entry.id}" declares "timeoutSec" twice`;
    if (!/^[0-9]+$/.test(rest)) return `gate "${entry.id}" declares timeoutSec "${rest}", which is not a plain integer`;
    const seconds = Number(rest);
    if (seconds < MIN_ACCEPTANCE_GATE_TIMEOUT_SEC || seconds > MAX_ACCEPTANCE_GATE_TIMEOUT_SEC) {
      return `gate "${entry.id}" declares timeoutSec ${seconds}, which is outside ${MIN_ACCEPTANCE_GATE_TIMEOUT_SEC}..${MAX_ACCEPTANCE_GATE_TIMEOUT_SEC}`;
    }
    entry.timeoutSec = seconds;
    return null;
  }
  if (key === 'mutex') {
    if (entry.mutex !== undefined) return `gate "${entry.id}" declares "mutex" twice`;
    const name = unquoteAcceptanceGateScalar(rest);
    if (name === '') return `gate "${entry.id}" declares an empty mutex`;
    if (name.length > MAX_ACCEPTANCE_GATE_MUTEX_LENGTH) {
      return `gate "${entry.id}" declares a mutex of ${name.length} characters, and at most ${MAX_ACCEPTANCE_GATE_MUTEX_LENGTH} are allowed`;
    }
    if (!ACCEPTANCE_GATE_MUTEX_RE.test(name)) {
      return `gate "${entry.id}" declares mutex "${name}", which must match ${ACCEPTANCE_GATE_MUTEX_RE.source} — both runners turn the name into a lock path, so it has to be safe as a path segment`;
    }
    entry.mutex = name;
    return null;
  }
  if (key === 'retryOnFail') {
    if (entry.retryOnFail !== undefined) return `gate "${entry.id}" declares "retryOnFail" twice`;
    // Not "at most N": the range IS the contract. Enough re-runs turn any red
    // green, so a gate allowed three attempts has stopped being a gate.
    if (rest !== '0' && rest !== String(MAX_ACCEPTANCE_GATE_RETRY_ON_FAIL)) {
      return `gate "${entry.id}" declares retryOnFail "${rest}", and only 0 or ${MAX_ACCEPTANCE_GATE_RETRY_ON_FAIL} are allowed`;
    }
    entry.retryOnFail = Number(rest);
    return null;
  }
  if (key === 'flakyIsPass') {
    if (entry.flakyIsPass !== undefined) return `gate "${entry.id}" declares "flakyIsPass" twice`;
    if (rest !== 'true' && rest !== 'false') {
      return `gate "${entry.id}" declares flakyIsPass "${rest}", which is not true or false`;
    }
    // The pairing rule it has to satisfy is checked once the whole entry has
    // been read, not here: a mapping has no order, and refusing an entry that
    // wrote flakyIsPass above retryOnFail would refuse a block CommandMate's own
    // parser accepts.
    entry.flakyIsPass = rest === 'true';
    return null;
  }
  return `unknown key "${key}" inside a gate (a gate declares only id, command, timeoutSec, mutex, retryOnFail, flakyIsPass)`;
}

// The single- or double-quoted scalar forms the subset allows, mirroring
// dispatch.mjs `unquoteYaml` — the two readers of the same YAML subset must agree
// on what a quoted command means.
function unquoteAcceptanceGateScalar(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// The whole block reading for one issue body. Returns
// {gates, error} — `gates` is the plan field (null when there is no block),
// `error` is the open question (null when there is nothing to say). The two are
// never both set: "no block" and "broken block" are different states and the
// second must never be rounded to the first (ADR §2.4).
function readAcceptanceGates(body) {
  const text = String(body ?? '');
  const opens = countAcceptanceGateBlocks(text);
  if (opens === 0) return { gates: null, error: null };
  const invalid = (code, reason) => ({
    gates: null,
    error: {
      code,
      text: `The \`${ACCEPTANCE_GATES_INFO}\` block could not be read: ${reason}. `
        + 'It is NOT treated as absent: fix the block or remove it, then re-plan. '
        + 'The planner never guesses acceptance gates from prose.',
    },
  });
  if (opens > 1) {
    return invalid('acceptance_gate_block_invalid', `the body carries ${opens} blocks and exactly one is allowed (they are not merged, and the first does not win)`);
  }
  const blocks = [...text.matchAll(ACCEPTANCE_GATES_BLOCK_RE)];
  if (blocks.length !== 1) return invalid('acceptance_gate_block_invalid', 'the block is never closed by a ``` fence at the start of a line');
  const parsed = parseAcceptanceGatesBlock(blocks[0][1]);
  if (!parsed.ok) return invalid(parsed.code, parsed.reason);
  return { gates: parsed.value, error: null };
}

// How a gate id this issue DEFINES is derived: `issue-<number>-<what>` (Issue
// #125). The runner checks the shape; it never rewrites the author's id, because
// the contract is a copy of the block and a re-encoding is exactly where "what
// the issue asked for" and "what actually ran" start to differ (§2).
//
// The prefix does three things at once, and it is a rule rather than a
// convention for the first of them:
//
//   1. It makes the collision the upstream parser refuses (a definition whose id
//      is already a gate in `.commandmate/verify.yaml`, or one of the reserved
//      built-in ids) impossible to write by accident — a repository's common
//      gates are named after what they check (`lint`, `selftest`), never after
//      an issue number.
//   2. It makes the gate readable in the verdict. `GATE issue-125-repro FAIL`
//      names its own provenance, which the CLI's own gate line does not carry
//      (ADR §11.4) and which #97's PR evidence has to reconstruct otherwise.
//   3. It keeps the id honest about its lifetime. A contract gate exists for one
//      delegation of one issue; an id that could pass for a repository gate
//      invites someone to "just add it to verify.yaml", which is the accumulation
//      ADR §3.5 (1) refused.
//
// Checked here rather than inside the block parser because it is the one rule
// that needs the issue's identity: the parser reads a body, and the same body
// under a different number would be a different answer.
function misscopedAcceptanceGateId(gates, issueNumber) {
  const prefix = `issue-${issueNumber}-`;
  for (const gate of gates.gates ?? []) {
    if (!gate.id.startsWith(prefix) || gate.id.length === prefix.length) {
      return `the gate "${gate.id}" this issue defines must be named "${prefix}<what-it-measures>". `
        + 'A gate the contract carries exists for this issue alone, and the prefix is what keeps it from '
        + 'colliding with a gate .commandmate/verify.yaml already declares (a collision is refused at send, '
        + 'after the block has left the author\'s screen)';
    }
  }
  return null;
}

// `readAcceptanceGates` plus the one check that needs to know which issue the
// body belongs to. Same {gates, error} shape and the same wrapper sentence, so a
// mis-scoped id reads like every other unreadable block: NOT absent, never
// guessed at.
function readIssueAcceptanceGates(issue) {
  const read = readAcceptanceGates(issue.body);
  if (read.gates === null) return read;
  const problem = misscopedAcceptanceGateId(read.gates, issue.number);
  if (problem === null) return read;
  return {
    gates: null,
    error: {
      code: 'acceptance_gate_block_invalid',
      text: `The \`${ACCEPTANCE_GATES_INFO}\` block could not be read: ${problem}. `
        + 'It is NOT treated as absent: fix the block or remove it, then re-plan. '
        + 'The planner never guesses acceptance gates from prose.',
    },
  };
}

// =============================================================================
// Author-declared open questions (Issue #178)
// =============================================================================
//
// The notation's 正本 is references/open-questions-notation.md, which defers to
// references/acceptance-gates-notation.md §3 for the YAML subset: this is the
// SAME block shape with a different info string, deliberately, so that an author
// who has written one has written both.
//
// What this reads is the strongest stop signal an issue can carry. Every other
// question the planner raises is the planner saying "I could not read X out of
// this body" — an inference about an absence, and therefore wrong sometimes.
// This one is the author saying "I have not decided X yet", which is a statement
// of fact by the only person able to make it. Until Issue #178 it reached the
// plan as `questions: []` and dispatch did not stop; the worker then guessed from
// the other sections or decided for itself, and which of the two it did was not
// knowable without reading the diff. Measured 2026-08-10 on
// Kewton/BorderFreeKidsMap#63: three undecidables left in the body planned clean,
// and rewriting them as decisions made the worker implement them — with reasons —
// on the next re-plan.
//
// The notation is a fenced block and NOT a heading convention (未決 / undecided /
// open questions), even though a heading would also have found that body. A
// heading is prose, and reading a stop out of prose is the category error
// acceptance-gates-notation.md §5 refuses for gates: the same word appears in
// bodies that are merely describing what USED TO BE undecided, and a false stop
// teaches operators to reach for --allow-questions by habit. The block also gives
// cmate-issue-authoring / cmate-issue-refinement something to WRITE and something
// to DELETE, which a heading does not: refinement emits an open question, the
// author leaves it in the body as a block, and deleting the block is what records
// that it was decided.
const OPEN_QUESTIONS_INFO = 'open-questions';
const OPEN_QUESTIONS_VERSION = 1;

// Counted on its own so "two blocks" is detected even when the second one is
// malformed; `m` makes `^`/`$` line anchors and the info string must be the whole
// word, so ```open-questions-v2 is not this block. Same shape as
// ACCEPTANCE_GATES_OPEN_RE / ACCEPTANCE_GATES_BLOCK_RE above, on purpose.
const OPEN_QUESTIONS_OPEN_RE = /^```open-questions[ \t]*$/gm;
const OPEN_QUESTIONS_BLOCK_RE = /^```open-questions[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;

// Same bound as the acceptance block's id list. An issue that cannot state what
// it is doing in 32 undecidables is not an issue, it is a design phase.
const MAX_OPEN_QUESTIONS = 32;

// A question's value is free text, so the id regex that rejects YAML's reserved
// leading characters for gate ids cannot do it here. These are the shapes
// acceptance-gates-notation.md §3 forbids outright (anchor / alias / flow
// collection / block scalar) and they are refused for the same reason: read as
// plain text they would silently mean something other than what a YAML reader
// would make of them.
const OPEN_QUESTION_RESERVED_RE = /^[&*[{|>]/;

// Stripped from the prose extractors' input for the same two measured reasons the
// acceptance block is (see stripAcceptanceGateBlocks): the fence pattern in
// `extractTestExpectations` cannot match `open-questions` as an INFO STRING (the
// hyphen is outside [a-zA-Z]) but does match this block's CLOSING fence as an
// opening one, swallowing the following ```bash block whole — measured on fixture
// 59-open-questions-declared, where 3 test_expectations drop to 1 — and a
// `  - …` line inside the block is shaped like a bullet, so an unstripped body
// reads the author's questions as acceptance criteria and any path inside one as
// a file to WRITE. The second half is not hypothetical either: the same fixture's
// `src/legacy/topo.ts`, named inside a question, reaches scope.allow with its
// four derived test companions behind it.
function stripOpenQuestionBlocks(text) {
  return String(text).replace(OPEN_QUESTIONS_BLOCK_RE, '');
}

function countOpenQuestionBlocks(text) {
  return [...String(text).matchAll(OPEN_QUESTIONS_OPEN_RE)].length;
}

// The same YAML subset `parseAcceptanceGatesBlock` reads, with `questions:` in
// place of `require:`. Kept as a separate function rather than parameterising the
// gates parser: the two notations are allowed to diverge (they are separate
// documents with separate versions), and a shared parser would make a change to
// one silently a change to the other. Returns {ok, value} or {ok:false, reason}.
function parseOpenQuestionsBlock(raw) {
  const bad = (reason) => ({ ok: false, reason });
  const lines = String(raw).split(/\r?\n/);
  const value = { version: OPEN_QUESTIONS_VERSION, questions: [] };
  const seenKeys = new Set();
  let sawVersion = false;
  let section = null; // null | 'questions'

  for (const line of lines) {
    if (line.includes('\t')) return bad('a tab character is not allowed; the block is indented with 2 spaces');
    if (line.trim() === '') continue;
    // 行頭 `#` のみコメント: a `#` anywhere else is part of the value. Here that
    // rule earns its keep twice over — a question ending in "…, or #63?" keeps
    // its issue reference instead of losing half the sentence.
    if (line.startsWith('#')) continue;
    if (line === '---' || line === '...') return bad('YAML document markers are not part of the subset');

    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);

    if (indent === 0) {
      section = null;
      const match = /^([a-zA-Z][a-zA-Z0-9_]*):[ \t]*(.*)$/.exec(content);
      if (match === null) return bad(`"${content}" is not a "key: value" line at the top level`);
      const [, key, rest] = match;
      if (seenKeys.has(key)) return bad(`duplicate key "${key}"`);
      seenKeys.add(key);
      if (!sawVersion && key !== 'version') {
        return bad('"version: 1" must be the first key of the block');
      }
      if (key === 'version') {
        sawVersion = true;
        if (rest !== String(OPEN_QUESTIONS_VERSION)) {
          // Not rounded forward, for the reason the gates parser gives: an
          // unknown version means the block was written against a notation this
          // runner does not implement.
          return bad(`version must be exactly ${OPEN_QUESTIONS_VERSION} (got "${rest}")`);
        }
        continue;
      }
      if (key === 'questions') {
        if (rest !== '') return bad('"questions:" takes a block sequence on the following lines, not an inline value');
        section = 'questions';
        continue;
      }
      return bad(`unknown key "${key}" (the v1 block accepts only version, questions)`);
    }

    if (indent !== 2) return bad(`unexpected indentation of ${indent} space(s); list items are indented by exactly 2`);
    if (section !== 'questions') return bad(`"${content}" is indented but no list is open above it`);
    const item = /^-[ \t]+(.*)$/.exec(content);
    if (item === null) return bad(`"${content}" is not a "- <question>" list item`);
    const question = item[1];
    if (question === '') return bad('an empty question; write the undecided thing, or delete the item');
    if (OPEN_QUESTION_RESERVED_RE.test(question)) {
      return bad(`"${question}" starts with a character YAML reserves (${OPEN_QUESTION_RESERVED_RE.source}); anchors, flow collections and block scalars are not part of the subset`);
    }
    if (value.questions.includes(question)) return bad(`duplicate question "${question}"`);
    value.questions.push(question);
    if (value.questions.length > MAX_OPEN_QUESTIONS) {
      return bad(`at most ${MAX_OPEN_QUESTIONS} open questions may be declared`);
    }
  }

  if (!sawVersion) return bad('the block declares no "version: 1"');
  // The empty block is the same contract error `require: []` is: it announces
  // that something is undecided and then names nothing, exactly where the author
  // meant to state it.
  if (value.questions.length === 0) return bad('the block asks nothing; remove it, or write at least one question under "questions:"');
  return { ok: true, value };
}

// The whole block reading for one issue body. Returns {questions, error} —
// `questions` is the author's list in the author's order (empty when there is no
// block), `error` is the open question describing an unreadable block (null when
// there is nothing to say). The two are never both set: "no block" and "broken
// block" are different states and the second must never be rounded to the first
// (acceptance-gates-notation.md §7, applied unchanged).
function readOpenQuestions(body) {
  const text = String(body ?? '');
  const opens = countOpenQuestionBlocks(text);
  if (opens === 0) return { questions: [], error: null };
  const invalid = (reason) => ({
    questions: [],
    error: {
      code: 'open_question_block_invalid',
      text: `The \`${OPEN_QUESTIONS_INFO}\` block could not be read: ${reason}. `
        + 'It is NOT treated as absent: fix the block or remove it, then re-plan. '
        + 'The planner never reads an open question out of prose.',
    },
  });
  if (opens > 1) {
    return invalid(`the body carries ${opens} blocks and exactly one is allowed (they are not merged, and the first does not win)`);
  }
  const blocks = [...text.matchAll(OPEN_QUESTIONS_BLOCK_RE)];
  if (blocks.length !== 1) return invalid('the block is never closed by a ``` fence at the start of a line');
  const parsed = parseOpenQuestionsBlock(blocks[0][1]);
  if (!parsed.ok) return invalid(parsed.reason);
  return { questions: parsed.value.questions, error: null };
}

// Topic tokens power the inferred-dependency heuristic. Short and stopword-like
// tokens carry no domain signal, so they are dropped.
const STOPWORDS = new Set([
  'feat', 'fix', 'chore', 'add', 'the', 'and', 'for', 'with', 'into', 'from',
  'core', 'skill', 'issue', 'support', 'implement', 'update', 'refactor', 'test',
  'tests', 'plan', 'phase', 'part',
]);

function topicTokens(text) {
  const tokens = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[a-z][a-z0-9]{3,}/g)) {
    const token = match[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

const PRODUCER_RE = /(schema|contract|interface|protocol|type\s*def|定義|スキーマ|契約|インターフェース|プロトコル|型定義)/i;
const CONSUMER_RE = /(implement|integrat|consume|connect|wire|apply|利用|連携|接続|適用|参照|使用)/i;

function analyzeIssue(issue, profile, binaries, companionRules) {
  // The machine-readable blocks are read from the RAW body, and every prose
  // extractor below reads the body with those blocks removed. Both halves matter:
  // reading a block from the stripped text would find nothing, and running the
  // prose extractors over the raw text mis-pairs the fences (see
  // stripAcceptanceGateBlocks) and reads gate ids as acceptance-criteria bullets.
  // With neither block in the body, `body`/`text` are the raw strings unchanged,
  // so a plan for such an issue is byte-identical to the one this runner produced
  // before acceptance gates (ADR §7) and before declared open questions
  // (Issue #178) existed — pinned by fixture 61-open-questions-heading-not-read,
  // whose golden was generated by the runner as it stood before this change.
  const acceptanceGates = readIssueAcceptanceGates(issue);
  const declaredQuestions = readOpenQuestions(issue.body);
  const body = stripOpenQuestionBlocks(stripAcceptanceGateBlocks(issue.body));
  const text = `${issue.title}\n\n${body}`;
  const objective = redact(firstNonEmptyLine(body) || issue.title);
  const acceptance = extractAcceptanceCriteria(body).map(redact);
  const extraction = extractFileCandidates(text);
  const classified = classifyFileCandidates(
    extraction.paths,
    extraction.deliverable,
    extraction.contextOnly,
    extraction.proseOnly,
  );
  // Deny-by-default for the agent harness (Issue #177), applied HERE — after the
  // context/product split, before any default is derived. Both halves of that
  // position matter: after, because a harness path a context heading already
  // demoted needs no second opinion and must not be re-reported as a grant;
  // before, because a path that may not be in scope must not seed companions
  // into scope either (a cited `.commandmate/package.json` would otherwise drag
  // `.commandmate/package-lock.json` in behind it, and a cited
  // `.claude/skills/x/scripts/run.ts` its four conventional test companions).
  //
  // The denied paths join `reference_files` rather than vanishing: the plan says
  // "read, not in scope.allow", which is a statement a reviewer can check.
  //
  // The derived list below is not filtered HERE, but it is not exempt either
  // (Issue #181 revisited this): a profile's `scope_companions` is a reviewed
  // declaration rather than client-controlled prose, yet it is still data the
  // TARGET repository supplies, so #177's own rationale — a `scope_companions`-
  // style key must not become a second, quieter door — applies to it. The
  // boundary is enforced at the two points where the companion is known: a
  // literal is refused when the profile is read, and a template that expands
  // into the harness off a NON-harness declaration is dropped where it is
  // produced. See profileScopeDefaultsFor and references/adr-scope-derivation.md
  // §17 / §18.
  const harness = partitionHarnessPaths(classified.suspected, extraction.deliverable);
  const suspected = harness.kept;
  // A backtick path no source could read. Outside the deliverable heading of an
  // issue that has one, it is prose like any other (CommandMate #3003): read,
  // not written, and named in `prose_path_ignored` rather than sent to fix an
  // extension that is not why it is out of scope.
  const unreadable = extractUnrecognizedPaths(
    text,
    extraction.paths,
    extraction.hasDeliverableHeading ? deliverableSpans(text) : [],
  );
  const references = [...classified.references, ...harness.denied, ...unreadable.prose];
  // The shadow pairs the plan cannot tell apart: BOTH spellings reached the
  // scope (Issue #182). Read here, before the derived paths below join the list,
  // because a spelling is something the issue WROTE.
  //
  // A pair where the other spelling is a reference — cited under `## 根拠`, or a
  // doc path, or a denied harness path — is not raised. The author already drew
  // the distinction the question would ask about, and the shorter path is in
  // scope either way now that nothing is dropped. Asking anyway would fire the
  // question on a body that did everything right, and a question that does that
  // teaches operators to reach for --allow-questions by habit.
  const inScope = new Set(suspected);
  const shadowedInScope = extraction.shadowed.filter(
    (pair) => inScope.has(pair.path) && inScope.has(pair.covered_by),
  );
  // All THREE default sources feed ONE list, which is then appended to
  // suspected_files and reported as `scope_defaults` — the plan can never grant
  // a path it does not also declare it granted. Every source derives from the
  // DECLARED files only (`suspected` before the push below): the lockfiles just
  // chosen are themselves derived, and deriving from derived paths is what
  // invariant 1 forbids. The growing `scopeDefaults` is passed along so a path
  // two sources agree on is emitted once.
  //
  // L2 runs LAST, after L1's universal rules — the profile EXTENDS the built-in
  // derivation rather than replacing it, the same relation `verifyBinaries` has
  // to GENERIC_VERIFY_BINARIES (ADR §5, "却下: profile 必須にする"). With no
  // `scope_companions` in the profile, `companionRules` is empty and this line
  // appends nothing, which is what makes an existing profile's plan identical to
  // the one 段1 produced.
  const scopeDefaults = scopeDefaultsFor(suspected);
  scopeDefaults.push(...testScopeDefaultsFor(suspected, scopeDefaults));
  scopeDefaults.push(...profileScopeDefaultsFor(companionRules, suspected, scopeDefaults));
  suspected.push(...scopeDefaults);
  const tests = extractTestExpectations(text, binaries).map(redact);

  // Open questions are built with their warning code attached, so the question a
  // reviewer reads and the warning that drops the run to `partial` can never
  // disagree about what is missing (Issue #52). `questions` stays a string list —
  // that is the plan schema — and the codes stay private to the planner.
  const openQuestions = [];
  // Raised FIRST of all (Issue #178). Every question below this point is the
  // planner reporting something it could NOT read out of the body — an inference
  // about an absence. These two are the author reporting something they have not
  // DECIDED, which outranks every inference: it cannot be a false positive, and
  // no answer the planner could compute would settle it. A reviewer meets it
  // before the findings that might be wrong.
  if (declaredQuestions.error !== null) openQuestions.push(declaredQuestions.error);
  for (const question of declaredQuestions.questions) {
    openQuestions.push({
      code: 'open_question_declared',
      // The author's sentence goes LAST and VERBATIM, for the two reasons the
      // other body-quoting questions give: dispatch prints a blocking question
      // through an `excerpt(…, 200)` that keeps the TAIL, so what identifies the
      // finding must not sit where a truncation would take it; and a transcribed
      // question is answerable without opening the issue, which is the whole
      // point in an unattended run. Redacted like every other quoted body text —
      // this is issue prose, and the plan is an artifact somebody else reads.
      text:
        'The issue body declares this undecided, so no worker may decide it. ' +
        'Answer it in the body, delete the `open-questions` block and re-plan. ' +
        `Question: "${redact(question)}"`,
    });
  }
  // Raised next: a body whose acceptance block is broken is a body whose author
  // did write acceptance conditions, so this question is the one to read before
  // `no_acceptance_criteria`.
  if (acceptanceGates.error !== null) openQuestions.push(acceptanceGates.error);
  if (acceptance.length === 0) {
    openQuestions.push({
      code: 'no_acceptance_criteria',
      text: 'Acceptance criteria are unclear; add 1-3 concrete completion checks.',
    });
  }
  if (suspected.length === 0) {
    openQuestions.push({
      code: 'no_suspected_files',
      text: 'Affected files are unclear; add likely modules or paths.',
    });
  }
  // Which of two overlapping paths the issue means (Issue #182). Raised here,
  // next to the question about the same list, because both are about what
  // `suspected_files` is: this one says the list holds two spellings of one file
  // and the planner will not pick for you. See shadowedCandidates for why
  // picking — dropping the shorter path — was the wrong default. The question is
  // what stops dispatch; the candidates themselves both stay in scope.
  for (const { path, covered_by: coveredBy } of shadowedInScope) {
    openQuestions.push({
      code: 'ambiguous_file_candidate',
      text:
        'Two spellings of one file are in scope and at most one is meant. ' +
        'Delete the one that is not a target from the body, or say both are, and re-plan. ' +
        `Paths: \`${path}\` and \`${coveredBy}\``,
    });
  }
  // L3 of the scope-derivation ADR (Issue #145), raised LAST: the two questions
  // above are structural, this one is read out of prose, so a reviewer meets the
  // findings that cannot be wrong before the one that can.
  //
  // `suspected` here already carries `scopeDefaults`, which is what keeps this
  // from firing on top of L1: an issue whose declared source files DID derive a
  // conventional test path has a test path in scope and is silent. What reaches
  // the detector is the repository whose layout L1 does not know — the residue
  // this layer exists for. Reading `suspected` before the push above would fire
  // on every issue L1 just fixed.
  if (!suspected.some(isTestPath)) {
    const demand = testCreationDemand(acceptance);
    if (demand !== null) {
      // The quoted criterion goes LAST on purpose. The dispatch runner prints a
      // blocking question through its `excerpt(…, 200)`, which keeps the TAIL of
      // an over-long string, so a question that opened with the quote would lose
      // exactly the part that lets a reader confirm the stop — and it would lose
      // it in the unattended run, where nobody can go read the issue instead. The
      // prose ahead of it is kept short for the same reason: 140 characters leaves
      // a criterion room to survive whole.
      openQuestions.push({
        code: 'acceptance_requires_tests_but_scope_has_none',
        text:
          'Acceptance asks for a test but no test path is among the affected files; ' +
          `name it in the issue body, or say no new test is needed. Criterion: "${demand}"`,
      });
    }
  }
  const questions = openQuestions.map((question) => question.text);

  const slug = slugify(issue.title);
  const repoName = profile.repository.split('/').pop() || 'repo';
  const branch = profile.branch_template
    .replaceAll('{number}', String(issue.number))
    .replaceAll('{slug}', slug)
    .replaceAll('{repo}', repoName);
  const worktree = profile.worktree_template
    .replaceAll('{number}', String(issue.number))
    .replaceAll('{slug}', slug)
    .replaceAll('{repo}', repoName);

  return {
    number: issue.number,
    title: redact(issue.title),
    objective,
    acceptance_criteria: acceptance,
    // Null when the issue declares no block AND when it declares a broken one:
    // the difference is carried by the open question above, never by pretending
    // a requirement was read. `require` is transcribed in the author's order —
    // the contract is a COPY of what the issue wrote, not a re-encoding of it.
    acceptance_gates: acceptanceGates.gates,
    suspected_files: suspected,
    scope_defaults: scopeDefaults,
    reference_files: references,
    test_expectations: tests,
    labels: issue.labels,
    branch,
    worktree,
    // worktree_id is resolved at DISPATCH time from `commandmate ls --json` by
    // branch — `ls` is the source of truth for the id, and the planner is a dry
    // run that creates nothing, so it reports the id as missing rather than
    // guessing a slug. `commandmate sync` (CommandMate 0.21.0+) re-scans the
    // server's worktree registry but creates no worktree; the dispatch runner
    // calls it when `ls` resolves nothing, which is what registers a worktree
    // made after the server last scanned.
    worktree_id: null,
    questions,
    _openQuestions: openQuestions,
    // Producer/consumer signals feed the inferred-dependency rule below.
    _producer: PRODUCER_RE.test(text),
    _consumer: CONSUMER_RE.test(text),
    _topics: topicTokens(`${issue.title} ${body}`),
    _rawBody: body,
    _unrecognizedPaths: unreadable.unrecognized,
    // Scope patterns the body wrote outside every deliverable heading (#219).
    _droppedPatterns: extraction.droppedPatterns,
    // Harness paths a deliverable heading claimed, hence granted (Issue #177).
    // The denied ones need no private field: they are in `reference_files`.
    _harnessPathsInScope: harness.declared,
    // Paths an issue with a deliverable heading wrote only outside it
    // (CommandMate #3002). They are in `reference_files`; this is what names
    // them in `prose_path_ignored`. A harness path is left out: outside a
    // deliverable heading it is denied by #177 anyway, silently by design, and
    // naming it here would re-raise the noise that design avoids.
    _prosePathsIgnored: [...classified.ignored, ...unreadable.prose].filter((path) => !isHarnessPath(path)),
  };
}

// =============================================================================
// Dependencies
// =============================================================================

const EXPLICIT_HEADING_RE = /(depend|dependenc|prerequisite|requires|依存|前提)/i;
// Forward: the issue that WRITES the line comes after the issue it references.
const EXPLICIT_FORWARD_RE = /(depends?\s+on|blocked\s+by|requires?|needs?|prerequisite|依存|前提)/i;
// Reverse: the issue that WRITES the line comes BEFORE the one it references.
// `\bblocks\b` / `\bblocking\b` deliberately do not match "blocked by", which is
// forward — the word boundary is what keeps the two readings apart.
const EXPLICIT_REVERSE_RE = /(\bblocks\b|\bblocking\b|ブロックする)/i;

const MAX_REASON_LINE = 100;

// The body line an edge was read from, redacted and bounded, so a reviewer can
// re-derive the edge from `dependency-plan.md` without opening the issue.
function quoteBodyLine(line) {
  const text = redact(line);
  return `"${text.length > MAX_REASON_LINE ? `${text.slice(0, MAX_REASON_LINE - 1)}…` : text}"`;
}

// A dependency reference carries a DIRECTION, and the direction is a property of
// the line, not of the section the line sits in. "## 依存" says the section is
// about dependencies; it does not say which way "- blocks #29" points. Reading a
// whole section as "everything here is a prerequisite" silently inverted every
// reverse statement (Issue #51), so the section now only supplies the DEFAULT for
// a line that names no direction of its own.
//
// Returns an ordered list of {ref, direction, cue, ambiguous, line}; `direction`
// is 'depends_on' (this issue is after `ref`) or 'blocks' (this issue is before
// it). Deduplication is per (ref, direction): a body that states both directions
// about the same issue contradicts itself, and the contradiction must surface as
// a cycle rather than be resolved by whichever line came first.
//
// A reference cited ONLY under a context heading is not a dependency, by exactly
// the rule #54 gave paths (Issue #182). The two halves of a body were being read
// with different rules: `## 根拠` demoted a path written under it to a citation,
// but an issue NUMBER under the same heading still became an edge. So the line
//
//     旧本文の depends on #31 は成立しない
//
// — written to DENY a dependency — created it (measured 2026-08-07, #33/#34).
// Nothing in the body could take it back: editing the number moved the phantom
// edge to a different issue, and the only fix was deleting the sentence, i.e.
// deleting the record of why the dependency does not hold. A planner that reads
// a denial as an assertion is worse than one that reads nothing there.
//
// Same rule as paths, in both directions. `outsideContext` is collected per
// MENTION, so a reference the body states once as a dependency and cites again
// under `## 根拠` survives — the citation does not retract the statement, which
// is the over-exclusion #54 was careful to avoid (its 26-… fixture) and the one
// that would cost more here: a dropped real edge dispatches two issues into the
// same wave in the wrong order. A dependency heading also outranks a context
// heading, the precedence a deliverable heading already has over one.
function extractExplicitRefs(body) {
  const cSpans = contextSpans(body);
  const refs = [];
  const seen = new Set();
  const outsideContext = new Set();
  let inSection = false;
  // Offsets are counted the way headingSpans counts them (split on '\n', one
  // character per line break), so a span and a line agree about where they are.
  let offset = 0;
  for (const line of body.split('\n')) {
    const stripped = line.trim();
    if (HEADING_RE.test(stripped)) {
      inSection = EXPLICIT_HEADING_RE.test(stripped);
      offset += line.length + 1;
      continue;
    }
    const contextual = !inSection && inSpans(cSpans, offset);
    offset += line.length + 1;
    const forward = EXPLICIT_FORWARD_RE.exec(stripped);
    const reverse = EXPLICIT_REVERSE_RE.exec(stripped);
    if (!forward && !reverse && !inSection) continue;
    // Both readings on one line is a statement this planner cannot resolve. It
    // keeps the forward (section-default) reading and says so in a warning,
    // rather than picking one of the two in silence.
    const ambiguous = Boolean(forward && reverse);
    const direction = reverse && !forward ? 'blocks' : 'depends_on';
    const cue = ambiguous ? null : (reverse ?? forward)?.[0] ?? null;
    for (const match of stripped.matchAll(/#(\d+)/g)) {
      const ref = Number.parseInt(match[1], 10);
      // Recorded per mention, before the (ref, direction) de-duplication: what
      // decides the exclusion is whether EVERY mention of the number is a
      // citation, not whether the first one this loop reached was.
      if (!contextual) outsideContext.add(ref);
      const key = `${ref}:${direction}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ ref, direction, cue, ambiguous, line: stripped });
    }
  }
  return refs.filter((ref) => outsideContext.has(ref.ref));
}

// How the direction was decided — the evidence half of an explicit edge's reason.
function directionEvidence(ref) {
  if (ref.ambiguous) {
    return `both a forward and a reverse direction word in ${quoteBodyLine(ref.line)}, read as forward`;
  }
  if (ref.cue) return `direction word "${ref.cue}" in ${quoteBodyLine(ref.line)}`;
  return `no direction word in ${quoteBodyLine(ref.line)}, dependency-section default`;
}

function explicitReason(issueNumber, ref) {
  const evidence = directionEvidence(ref);
  if (ref.direction === 'blocks') {
    return `#${ref.ref} depends on #${issueNumber}: #${issueNumber} states it blocks #${ref.ref} (${evidence})`;
  }
  return `#${issueNumber} states a dependency on #${ref.ref} (${evidence})`;
}

// The suspected files two issues both name, in `a`'s order. The list rather
// than a boolean because it is EVIDENCE (Issue #182): an inferred edge that a
// shared file grounds says which file in its `reason`.
function sharedFiles(a, b) {
  // Not a set intersection any more (Issue #219). `suspected_files` becomes
  // `scope.allow` verbatim and the entries there are PATTERNS as often as they
  // are paths, so comparing them as literal strings answered "no overlap" for
  // `data/geo/**` beside `data/geo/landmarks/13101.json` — two issues writing
  // the same files, placed in one wave. The relation is the same one
  // CommandMate's scope gate uses; where it cannot decide, it says they overlap
  // (a false positive costs one wave of parallelism, a false negative costs the
  // integration — #175).
  return a.suspected_files.filter((path) =>
    b.suspected_files.some((other) => scopeEntriesOverlap(path, other)));
}

function hasFileOverlap(a, b) {
  return sharedFiles(a, b).length > 0;
}

// Builds the dependency edge set from three sources, in precedence order:
// override > explicit > inferred. Returns edges plus any validation errors and
// warnings, and the inferences that were NOT made into edges. Each edge is
// {issue, depends_on, kind, basis, reason}: `issue` depends on `depends_on`.
function buildDependencies(analyses, inputs) {
  const inSet = new Set(analyses.map((a) => a.number));
  const errors = [];
  const warnings = [];

  // consumer -> Map(dependency -> edge), so a stronger source overrides a weaker.
  const edges = new Map();
  const put = (issue, dependsOn, kind, basis, reason, precedence) => {
    if (!edges.has(issue)) edges.set(issue, new Map());
    const existing = edges.get(issue).get(dependsOn);
    if (!existing || precedence > existing._precedence) {
      edges.get(issue).set(dependsOn, { issue, depends_on: dependsOn, kind, basis, reason, _precedence: precedence });
    }
  };

  // 1. Explicit — parsed from issue bodies. A reference outside the input set is
  //    a warning, not a failure: the prerequisite may already be merged. Both
  //    directions are honored (Issue #51): "blocks #N" places THIS issue first.
  for (const analysis of analyses) {
    for (const ref of extractExplicitRefs(analysis._rawBody)) {
      if (ref.ref === analysis.number) continue;
      if (ref.ambiguous) {
        warnings.push({
          code: 'ambiguous_dependency_direction',
          detail: redact(
            `#${analysis.number} states both a forward and a reverse direction about #${ref.ref} on one line ` +
              `(${quoteBodyLine(ref.line)}); the planner read it as "#${analysis.number} depends on #${ref.ref}". ` +
              'Split the line so one direction word governs each reference, or state the edge with --depends.',
          ),
        });
      }
      // 'blocks' means the referenced issue is the consumer: it depends on this one.
      const [issue, dependsOn] = ref.direction === 'blocks'
        ? [ref.ref, analysis.number]
        : [analysis.number, ref.ref];
      if (inSet.has(ref.ref)) {
        put(issue, dependsOn, 'explicit', 'declared', redact(explicitReason(analysis.number, ref)), 2);
      } else {
        warnings.push({
          code: 'external_dependency',
          detail: ref.direction === 'blocks'
            ? `#${analysis.number} blocks #${ref.ref}, which is not in this plan (#${ref.ref} would depend on #${analysis.number})`
            : `#${analysis.number} depends on #${ref.ref}, which is not in this plan`,
        });
      }
    }
  }

  // 2. Inferred — a consumer of a shared contract depends on its producer.
  //
  //    Two things ground such a link and they are NOT the same strength, which
  //    is what Issue #182 is about. A shared topic token is a LEXICAL
  //    coincidence: measured 2026-08-11 on #104/#105/#106 (Kewton/BorderFreeKidsMap),
  //    three issues with zero cross-reference were serialised into three waves by
  //    `shared: data, page, cmate` — `cmate` read out of the prose "cmate-verify
  //    の全ゲート" in an acceptance criterion, `data` and `page` out of path
  //    fragments each issue cited under `## 参考` about the OTHER one. One real
  //    file conflict existed. The other two thirds of the wall-clock were spent
  //    waiting on vocabulary.
  //
  //    A shared FILE is different in kind: the two issues would edit the same
  //    bytes, which is a fact about the plan rather than about word choice. Such
  //    a pair cannot share a wave anyway (rule 2 of wave packing), so ordering it
  //    producer-first costs nothing and is what the heuristic is for.
  //
  //    So the edge carries its `basis` and only a file-grounded one is an edge.
  //    A lexical-only inference becomes a QUESTION on the consumer instead
  //    (`unconfirmed_lexical_dependency`, recorded below by
  //    recordSuppressedInferences): the planner still says what it noticed, a
  //    human decides, and the answer — `--depends 106:104`, or a line in the body
  //    — is an edge with a real basis. `--no-infer` still turns the whole
  //    heuristic off, including these questions; it is the switch for "do not
  //    guess at all", and it never disabled the conflict rule that keeps two
  //    file-overlapping issues out of one wave (`waves_conflict_free`).
  const suppressed = [];
  if (inputs.infer) {
    for (const consumer of analyses) {
      if (!consumer._consumer) continue;
      for (const producer of analyses) {
        if (producer.number === consumer.number || !producer._producer) continue;
        const shared = [...consumer._topics].filter((t) => producer._topics.has(t));
        if (shared.length === 0) continue;
        const files = sharedFiles(consumer, producer);
        if (files.length === 0) {
          suppressed.push({ consumer: consumer.number, producer: producer.number, shared });
          continue;
        }
        put(
          consumer.number,
          producer.number,
          'inferred',
          'file_conflict',
          `#${consumer.number} consumes the contract from #${producer.number} ` +
            `(shared: ${shared.slice(0, 3).join(', ')}; shared file: ${files.slice(0, 3).join(', ')})`,
          1,
        );
      }
    }
  }

  // 3. Override — authoritative. Malformed or dangling overrides are rejected.
  for (const raw of inputs.dependsRaw) {
    const match = /^#?(\d+)\s*[:>]\s*#?(\d+)$/.exec(String(raw).trim());
    if (!match) {
      errors.push({ code: 'override_incomplete', detail: `dependency override "${raw}" is malformed; use <issue>:<dependency>` });
      continue;
    }
    const issue = Number.parseInt(match[1], 10);
    const dependsOn = Number.parseInt(match[2], 10);
    if (!inSet.has(issue) || !inSet.has(dependsOn)) {
      errors.push({
        code: 'override_incomplete',
        detail: `dependency override "${raw}" references an issue not in this plan`,
      });
      continue;
    }
    if (issue === dependsOn) {
      errors.push({ code: 'override_incomplete', detail: `dependency override "${raw}" makes an issue depend on itself` });
      continue;
    }
    put(issue, dependsOn, 'override', 'declared', `override: #${issue} depends on #${dependsOn}`, 3);
  }

  // Flatten to a sorted, deterministic list.
  const list = [];
  for (const perIssue of edges.values()) {
    for (const edge of perIssue.values()) {
      list.push({
        issue: edge.issue,
        depends_on: edge.depends_on,
        kind: edge.kind,
        basis: edge.basis,
        reason: edge.reason,
      });
    }
  }
  list.sort((a, b) => a.issue - b.issue || a.depends_on - b.depends_on);

  // Cycle detection over the resolved graph.
  const cycle = findCycle(analyses, list);
  if (cycle) {
    errors.push({
      code: 'cycle_detected',
      detail: `dependency cycle: ${cycle.map((n) => `#${n}`).join(' -> ')}`,
    });
  }

  // A caller-asserted order must be a permutation of the set that respects the
  // DAG; otherwise the plan it implies cannot be honored.
  if (inputs.order && !cycle) {
    validateOrder(inputs.order, analyses, list, errors);
  }

  return { edges: list, errors, warnings, suppressed };
}

// The lexical-only inferences above, as one open question each on the CONSUMER
// (Issue #182). A question rather than a warning alone for the reason #145 gives
// in the L3 comment: `plan.status` stops nobody, while dispatch refuses an issue
// carrying an unanswered question — and it is a question in the ordinary sense,
// answerable only by the person who wrote the two bodies.
//
// It rides `--allow-questions` like every other question, which is the "explicit
// approval" half of the arbitration: an operator who reads the pair and decides
// they are independent proceeds with the flag, and that decision is in the run's
// command line rather than in nobody's head.
//
// Attached after the graph is resolved rather than inside analyzeIssue because
// it is the only finding here that is not a property of ONE issue: it takes the
// pair. `_openQuestions` and `questions` are appended in step so the warning a
// reviewer reads and the question dispatch refuses on stay the same list.
function recordSuppressedInferences(analyses, suppressed) {
  const byNumber = new Map(analyses.map((analysis) => [analysis.number, analysis]));
  for (const { consumer, producer, shared } of suppressed) {
    const analysis = byNumber.get(consumer);
    if (analysis === undefined) continue;
    const question = {
      code: 'unconfirmed_lexical_dependency',
      // The pair goes LAST for the same reason the L3 question quotes its
      // criterion last: dispatch prints a blocking question through an
      // excerpt() that keeps the TAIL, so what identifies the finding must not
      // sit where a truncation would take it.
      text:
        'Only vocabulary is shared with another issue, no file, so the planner did NOT order the two. ' +
        'Confirm they are independent, or state the dependency in the body and re-plan ' +
        `(or pass --depends ${consumer}:${producer}). Shared: ${shared.slice(0, 3).join(', ')} with #${producer}`,
    };
    analysis._openQuestions.push(question);
    analysis.questions.push(question.text);
  }
}

function adjacency(analyses, edges) {
  // deps.get(x) = issues x depends on.
  const deps = new Map(analyses.map((a) => [a.number, new Set()]));
  for (const edge of edges) {
    if (deps.has(edge.issue)) deps.get(edge.issue).add(edge.depends_on);
  }
  return deps;
}

function findCycle(analyses, edges) {
  const deps = adjacency(analyses, edges);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(analyses.map((a) => [a.number, WHITE]));
  const stack = [];

  const visit = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of [...deps.get(node)].sort((a, b) => a - b)) {
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (color.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of analyses.map((a) => a.number)) {
    if (color.get(node) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

function validateOrder(order, analyses, edges, errors) {
  const inSet = new Set(analyses.map((a) => a.number));
  const orderSet = new Set(order);
  if (order.length !== inSet.size || [...inSet].some((n) => !orderSet.has(n))) {
    errors.push({
      code: 'dependency_order_violation',
      detail: '--order must be a permutation of the planned issues',
    });
    return;
  }
  const position = new Map(order.map((n, index) => [n, index]));
  for (const edge of edges) {
    if (position.get(edge.depends_on) > position.get(edge.issue)) {
      errors.push({
        code: 'dependency_order_violation',
        detail: `--order places #${edge.issue} before its dependency #${edge.depends_on}`,
      });
      return;
    }
  }
}

// =============================================================================
// Wave planning
// =============================================================================

// Packs issues into waves: dependencies satisfied by an earlier wave, no two
// file-overlapping issues in one wave, and each wave bounded by max_parallel.
function planWaves(analyses, edges, maxParallel, order) {
  const deps = adjacency(analyses, edges);
  const byNumber = new Map(analyses.map((a) => [a.number, a]));

  // Deterministic candidate order: caller-asserted order if given, else input.
  const sequence = order
    ? order.slice()
    : analyses.map((a) => a.number);

  const completed = new Set();
  let remaining = sequence.slice();
  const waves = [];

  while (remaining.length > 0) {
    let ready = remaining.filter((n) => [...deps.get(n)].every((d) => completed.has(d)));
    // A stalled graph (only possible if a cycle slipped through) still makes
    // progress one issue at a time rather than looping forever.
    if (ready.length === 0) ready = [remaining[0]];

    const wave = [];
    for (const number of ready) {
      if (wave.length >= maxParallel) break;
      const candidate = byNumber.get(number);
      if (wave.some((n) => hasFileOverlap(candidate, byNumber.get(n)))) continue;
      wave.push(number);
    }
    if (wave.length === 0) wave.push(ready[0]);

    waves.push(wave);
    for (const number of wave) completed.add(number);
    const used = new Set(wave);
    remaining = remaining.filter((n) => !used.has(n));
  }
  return waves;
}

// =============================================================================
// human-only issues (Issue #286)
// =============================================================================
//
// cmate-issue-authoring 0.10.0 (CommandMate#3013) lets a plan hold an issue only
// a person does — a demo on a phone, a document written by hand — marked by the
// label `human-only`, and its validator names such an issue `dispatch_excluded`.
// Nothing here read the mark, so the consumer (Kewton/Musunest) took those
// numbers out of every plan by hand, and a human-only issue that did reach the
// planner drew "Affected files are unclear" and a worker.
//
// The issue STAYS in `issues` and its edges stay in `dependencies`: the plan's
// reader keeps seeing the human work and what waits on it. What changes is that
// it is in no wave (so not in merge_order), it carries `dispatch_excluded:
// 'human_only'`, and its questions are not raised — they ask what a WORKER would
// need, and no worker takes it. An edge from a dispatched issue to it is not
// waited for: the dispatcher has no way to see a person finish, so it is treated
// like an edge to an issue outside the plan (`external_dependency`) and named as
// a blocking `human_only_dependency`, whose owed decision is "has the person
// finished #N?".
//
// The name is fixed and matched exactly, the same constant the validator uses
// (the mirror-conformance test compares the two lines): `human only` or
// `Human-Only` is not the mark. A plan with no such label is byte-identical to
// the one written before this existed.
const HUMAN_ONLY_LABEL = 'human-only';

function humanOnlyNumbers(analyses) {
  return new Set(analyses.filter((analysis) => analysis.labels.includes(HUMAN_ONLY_LABEL)).map((analysis) => analysis.number));
}

// Clears the questions of every human-only issue and returns how many each had,
// for the notice below. Called after recordSuppressedInferences, so a lexical
// question that landed on one is cleared too.
function dropHumanOnlyQuestions(analyses, humanOnly) {
  const dropped = new Map();
  for (const analysis of analyses) {
    if (!humanOnly.has(analysis.number)) continue;
    dropped.set(analysis.number, analysis.questions.length);
    analysis._openQuestions = [];
    analysis.questions = [];
  }
  return dropped;
}

function humanOnlyWarnings(edges, humanOnly, dropped) {
  const out = [];
  for (const number of [...humanOnly].sort((a, b) => a - b)) {
    const count = dropped.get(number) ?? 0;
    out.push({
      code: 'human_only_excluded',
      detail:
        `#${number} is labelled ${HUMAN_ONLY_LABEL}: a person does it, so it is in no wave and not in merge_order, ` +
        'and the dispatch runner records it as not_dispatched without sending a worker' +
        (count > 0 ? ` (its ${count} planner question(s) were not raised: they ask what a worker would need)` : ''),
    });
  }
  for (const edge of edges) {
    if (humanOnly.has(edge.issue) || !humanOnly.has(edge.depends_on)) continue;
    out.push({
      code: 'human_only_dependency',
      detail:
        `#${edge.issue} depends on #${edge.depends_on}, which is labelled ${HUMAN_ONLY_LABEL}: no wave waits for it and ` +
        `the dispatch runner does not either — confirm a person has finished #${edge.depends_on} before dispatching #${edge.issue}`,
    });
  }
  return out;
}

// =============================================================================
// Risk / commands
// =============================================================================

const SEVERITY_ORDER = { low: 0, moderate: 1, high: 2 };

function assessRisk(analyses, edges, profile) {
  const factors = [];
  if (!profile.verified) {
    factors.push({ code: 'unverified_profile', severity: 'high', detail: `profile "${profile.id}" is not verified` });
  }
  const conflicts = countConflicts(analyses);
  if (conflicts > 0) {
    factors.push({ code: 'file_conflict', severity: 'moderate', detail: `${conflicts} issue pair(s) touch shared files` });
  }
  if (edges.length > 0) {
    factors.push({ code: 'cross_issue_dependency', severity: 'moderate', detail: `${edges.length} dependency edge(s) constrain ordering` });
  }
  const open = analyses.reduce((sum, a) => sum + a.questions.length, 0);
  if (open > 0) {
    factors.push({ code: 'open_questions', severity: 'moderate', detail: `${open} blocking question(s) across issues` });
  }
  if (analyses.length > MAX_PARALLEL_MAX) {
    factors.push({ code: 'batch_size', severity: 'low', detail: `${analyses.length} issues exceed a single wave` });
  }
  let level = 'low';
  for (const factor of factors) {
    if (SEVERITY_ORDER[factor.severity] > SEVERITY_ORDER[level]) level = factor.severity;
  }
  return { level, factors };
}

function countConflicts(analyses) {
  let count = 0;
  for (let i = 0; i < analyses.length; i += 1) {
    for (let j = i + 1; j < analyses.length; j += 1) {
      if (hasFileOverlap(analyses[i], analyses[j])) count += 1;
    }
  }
  return count;
}

// The commands the plan is grounded in and the verification a worker would run.
// Every entry is executed:false — this is a dry run. Mutating phases (worktree
// creation, dispatch, PR, merge) are deferred to #1454-1456 and are not emitted.
function planCommands(analyses, profile) {
  const commands = [];
  for (const analysis of analyses) {
    commands.push({
      phase: 'analyze',
      command: `gh issue view ${analysis.number} --repo ${profile.repository} --json number,title,body,labels`,
      mutating: false,
      executed: false,
    });
  }
  commands.push({ phase: 'analyze', command: `git rev-parse ${profile.base}`, mutating: false, executed: false });
  for (const command of profile.baseline) {
    commands.push({ phase: 'verify', command, mutating: false, executed: false });
  }
  return commands;
}

// =============================================================================
// Plan / result assembly
// =============================================================================

function canonicalInputSignature(inputs, profile, issues) {
  // Everything that determines the plan, and nothing that does not (not the
  // runs directory, not the wall clock). Same signature => same plan. Issue
  // content is included (#46 / CommandMate #1678 B-4): fixing an issue body and
  // re-planning is the normal answer to a blocking question, and it must derive
  // a NEW run id — while a byte-identical re-run still derives the same id and
  // is still refused, so the no-overwrite intent stands. Labels are sorted:
  // their order carries no meaning and must not shift the id.
  //
  // The RESOLVED PROFILE goes in WHOLE (Issue #157, option A of three). It used
  // to contribute three hand-picked fields — `base` / `id` / `repository` — while
  // five more of its fields decide plan content: `baseline` feeds verifyBinaries
  // and therefore `issues[].test_expectations`, `branch_template` and
  // `worktree_template` expand into `issues[].branch` / `.worktree`, `verified`
  // decides the `unverified_profile` warning and a high-severity risk factor, and
  // `scope_companions` (#149, ADR layer L2) derives `suspected_files` /
  // `scope_defaults`. Two plans with different content could therefore claim the
  // same default run id. The enumeration was not merely incomplete — `baseline`
  // was already outside it before #149 added a fifth field.
  //
  // Whole-profile is chosen over re-listing the five (option B) precisely
  // because the listing is what failed: a list has to be re-audited by a human
  // every time a profile field is added, and nothing detects it when they forget.
  // Hashing the resolved object is correct by construction and follows PROFILE_FIELDS
  // for free. The cost is accepted, not overlooked: editing ANY profile field —
  // including one that turns out not to reach the plan — derives a new default
  // run id. That is the safe direction (a new id writes a new directory; a stale
  // shared id is what silently misrepresents two different plans as one run), and
  // `--resume` is unaffected because it names a dispatch directory, not a run id.
  //
  // It is the RESOLVED profile, after --repo / --base overrides and after the
  // verification downgrade they can trigger, because that is the profile the plan
  // is actually built from.
  //
  // Serialized as-is, with no key-order canonicalization, because the profile
  // reaching here is already canonically ordered: normalizeProfile REBUILDS the
  // object field by field (and normalizeScopeCompanions rebuilds every rule as
  // `{when, add}`), so a hand-written --profile-json whose keys are in any order
  // arrives here in one fixed order, and the built-ins are object literals. A
  // sorting pass was written first and then removed: no input this loader accepts
  // could tell the two versions apart, and an unobservable defense is the same
  // shape of claim-beyond-the-code this Issue is about. The property it was there
  // for — re-ordering a profile's keys must not fork the run id — is pinned by a
  // fixture against the layer that actually provides it. If a profile field is
  // ever added that passes a caller-supplied object through UNREBUILT, that
  // fixture is what will catch it, and canonicalization belongs in the loader.
  return JSON.stringify({
    issues: inputs.issues,
    issue_content: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels].sort(),
    })),
    profile,
    max_parallel: inputs.maxParallel,
    phase: inputs.phase,
    infer: inputs.infer,
    depends: [...inputs.dependsRaw].sort(),
    order: inputs.order,
  });
}

function makeRunId(inputs, profile, issues) {
  if (inputs.runIdOverride) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(inputs.runIdOverride)) {
      throw new SkillError('invalid_input', 'run-id must be a short filesystem-safe token', 3);
    }
    return inputs.runIdOverride;
  }
  const digest = createHash('sha256').update(canonicalInputSignature(inputs, profile, issues)).digest('hex');
  return `plan-${digest.slice(0, 12)}`;
}

function publicProfile(profile) {
  const out = {
    id: profile.id,
    repository: profile.repository,
    base: profile.base,
    branch_template: profile.branch_template,
    worktree_template: profile.worktree_template,
    baseline: profile.baseline,
    verified: profile.verified,
  };
  // The optional fields are echoed ONLY when the profile declared them, and
  // after the required seven, so a plan built on a profile without them is
  // byte-for-byte the plan 0.24.0 produced. THE ORDER OF THESE LINES IS THE
  // PLAN'S BYTE ORDER — it is fixed by PROFILE_FIELDS and measured by every
  // full-text golden — so a new optional field is appended below, never spliced
  // in between.
  //
  // `scope_companions` is here so a reviewer can trace a `scope_defaults` entry
  // that no L1 rule explains back to the declaration that produced it.
  // `dispatch_defaults` is here because the plan is how it reaches the runner
  // that consumes it: dispatch reads `plan.profile.dispatch_defaults` and never
  // opens the profile (profile-contract.md §10, Issue #196).
  // `integration_baseline` is here for the same reason with a different reader:
  // merge reads `plan.profile.integration_baseline` under `--integration-verify`
  // (profile-contract.md §11, Issue #195). The `!== undefined` test is the whole
  // of the "declared vs absent" distinction that field rests on — a declared `[]`
  // is echoed AS an empty array, because merge's fallback to `baseline` fires for
  // an absent key alone.
  if (profile.scope_companions !== undefined) out.scope_companions = profile.scope_companions;
  if (profile.dispatch_defaults !== undefined) out.dispatch_defaults = profile.dispatch_defaults;
  if (profile.integration_baseline !== undefined) out.integration_baseline = profile.integration_baseline;
  // `observations` is here for the same reason with a third reader: observe.mjs
  // reads `plan.profile.observations` after the merge (Issue #221,
  // profile-contract.md §12). Appended LAST, so a profile that does not declare
  // it produces the plan bytes it produced before the field existed.
  if (profile.observations !== undefined) out.observations = profile.observations;
  // `pr_title_template` is here for merge.mjs --create-prs (CommandMate#3005,
  // profile-contract.md §13), and last for the same byte-order reason.
  if (profile.pr_title_template !== undefined) out.pr_title_template = profile.pr_title_template;
  // `worker_messages` is here because dispatch reads `plan.profile.worker_messages`
  // and never opens the profile. Appended LAST, like every optional field.
  if (profile.worker_messages !== undefined) out.worker_messages = profile.worker_messages;
  return out;
}

function issueForPlan(analysis, analyses, edges) {
  return {
    number: analysis.number,
    title: analysis.title,
    objective: analysis.objective,
    acceptance_criteria: analysis.acceptance_criteria,
    acceptance_gates: analysis.acceptance_gates,
    suspected_files: analysis.suspected_files,
    scope_defaults: analysis.scope_defaults,
    reference_files: analysis.reference_files,
    test_expectations: analysis.test_expectations,
    labels: analysis.labels,
    branch: analysis.branch,
    worktree: analysis.worktree,
    worktree_id: analysis.worktree_id,
    questions: analysis.questions,
    classification: classifyIssue(analysis, analyses, edges),
  };
}

function classifyIssue(analysis, analyses, edges) {
  if (edges.some((e) => e.issue === analysis.number)) return 'dependent';
  if (analyses.some((o) => o.number !== analysis.number && hasFileOverlap(analysis, o))) return 'conflicting';
  return 'independent';
}

function buildPlan({ runId, profile, inputs, analyses, edges, waves, dispatchable, dispatchEdges, humanOnly }) {
  const risk = assessRisk(dispatchable, dispatchEdges, profile);
  const commands = planCommands(analyses, profile);
  return {
    plan_schema_version: PLAN_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    run_id: runId,
    generated_mode: 'dry-run',
    profile: publicProfile(profile),
    inputs: {
      issues: inputs.issues,
      base: profile.base,
      profile_id: profile.id,
      max_parallel: inputs.maxParallel,
      phase: inputs.phase,
      infer: inputs.infer,
      dependency_overrides: inputs.dependsRaw.map(String),
      order: inputs.order,
    },
    issues: analyses.map((a) => ({
      ...issueForPlan(a, analyses, edges),
      ...(humanOnly.has(a.number) ? { dispatch_excluded: 'human_only' } : {}),
    })),
    dependencies: edges,
    waves,
    merge_order: waves.flat(),
    max_parallel: inputs.maxParallel,
    risk,
    permissions: DECLARED_PERMISSIONS,
    commands,
    warnings: [],
    notes: [
      'Dry run: no worktree was created, no worker dispatched, no PR opened or merged.',
      'This plan is executed by the dispatch runner (scripts/dispatch.mjs) once approved; PR, merge and UAT are deferred to CommandMate issues #1455-1456.',
      'worktree_id is null in the plan: the dispatch runner resolves it from `commandmate ls --json` by branch. A worktree created after the CommandMate server last scanned is not registered yet, so it has no id — register it with `commandmate sync` (CommandMate 0.21.0+, a re-scan that creates no worktree; the dispatch runner also attempts it once).',
      'Issue input is number, title, body and labels only: comments are never read, so a decision recorded only in an issue comment is invisible to this plan and to the execution contract — fold it into the issue body and re-plan.',
    ],
  };
}

function completionChecks(plan, dependencyErrors, ranOverwriteGuard) {
  const conflictFree = plan.waves.every((wave) => {
    const inWave = wave.map((n) => plan.issues.find((i) => i.number === n));
    for (let i = 0; i < inWave.length; i += 1) {
      for (let j = i + 1; j < inWave.length; j += 1) {
        const left = inWave[i].suspected_files;
        // The same relation sharedFiles uses, for the same reason: a check that
        // compared literal strings would pass a wave the planner built with the
        // pattern-aware rule and call it conflict-free (Issue #219).
        if (inWave[j].suspected_files.some((p) => left.some((q) => scopeEntriesOverlap(p, q)))) return false;
      }
    }
    return true;
  });

  const checks = [
    { id: 'dry_run_only', passed: plan.generated_mode === 'dry-run', detail: 'no mutating phase was executed' },
    { id: 'dependencies_validated', passed: dependencyErrors.length === 0, detail: dependencyErrors.length === 0 ? 'no cycle, incomplete override, or order violation' : dependencyErrors.map((e) => e.code).join(', ') },
    { id: 'waves_conflict_free', passed: conflictFree, detail: conflictFree ? 'no shared-file pair shares a wave' : 'a wave contains a file-overlapping pair' },
    { id: 'run_isolated', passed: ranOverwriteGuard, detail: ranOverwriteGuard ? 'run directory is unique and was not overwritten' : 'run directory already existed' },
    { id: 'deterministic', passed: true, detail: 'plan is a pure function of its inputs' },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

// =============================================================================
// Warning severity — which warnings paint the run (Issue #199)
// =============================================================================
//
// `plan.status` is a COLOUR A HUMAN READS. What stops a run is `issues[].questions`
// — the schema says so in as many words ("this array — not plan.status — is what
// stops a run") and the dispatch runner reads that field and never this one. So
// widening `success` here cannot make an automated run go further than it did.
//
// Until #199 every warning dropped the status to `partial`, which made `partial`
// carry two different states in the same colour:
//
//   * the author has NOT DECIDED something yet (`open_question_declared`,
//     `ambiguous_file_candidate`, `no_acceptance_criteria`, …), and
//   * the author HAS decided, declared it in the issue body, and the planner is
//     recording that it honoured the declaration (`harness_path_in_scope`).
//
// The second kind fires on CORRECT authoring. A repository that maintains its
// agent harness in-repo — this one does, and so does Kewton/BorderFreeKidsMap,
// where #199 measured it — adds a verify gate by writing `.commandmate/verify.yaml`
// under `## 対象ファイル`, which is the one sanctioned way to say it (§5.3). Every
// such run came back `partial`, so `partial` started to mean "またこれか". That is
// precisely the failure #177 refused to create on the DENIED side ("正しい書き方に
// 対して partial を出す warning は、読み手に読み飛ばし方を教える"); the declaring
// side had it anyway.
//
// The split is FAIL-CLOSED, in two parts:
//
//   1. `blocking` is the DEFAULT. A code absent from the set below drops the
//      status exactly as it did before, so a warning code added by a later change
//      is blocking until someone argues otherwise. The failure mode of forgetting
//      to classify is "still partial", never "silently no longer partial".
//   2. Each member of the set is an independent judgement about ONE code, argued
//      in its own issue and written down per code in
//      references/codes-and-recovery.md §2. There is no bulk move.
//
// Issue #210 is the inventory #199 deferred: every code that can reach
// `plan.warnings` is classified there, one row per code, INCLUDING the ones that
// stay blocking — so "considered and decided blocking" and "never considered" no
// longer look alike. Sixteen codes were audited against the runner; fifteen are
// blocking and are recorded as such. One moved:
//
//   * `profile_repository_override` (#210). It cannot be raised without TWO
//     explicit operator flags: `--repo <other>` re-points the profile (which is
//     what sets `verified_downgraded`), and the run then throws `unverified_profile`
//     unless `--allow-unverified` is also passed — whose own refusal text asks the
//     operator to confirm branch/base/worktree/baseline FIRST. So the warning
//     reports a decision that is already made and already recorded in the run's
//     command line, which is the notice side of the split.
//
//     Two measurements settled it rather than the principle alone. (a) The very
//     same acceptance — an unverified profile taken knowingly — is `success` with
//     no warning at all when it arrives as `--profile-json <unverified>
//     --allow-unverified` (fixture case 08), so `partial` here coloured one of two
//     identical operator decisions and not the other, on the spelling. (b) The
//     documented recovery for `profile_repository_mismatch` (SKILL.md §4: pass
//     `--profile` / `--profile-json` / `--repo`) turns a `partial` into a
//     `partial` — the operator does exactly what the table says and the colour
//     does not move. That is the "teaches the reader to skip it" failure #177
//     named, reached from the operator side instead of the author side.
//
//     Nothing about the risk is dropped: `plan.risk` still carries the
//     `unverified_profile` factor at `high` and `profile.verified` is still
//     `false` in the plan. Only the colour moved.
//
// CommandMate #3002 added `prose_path_ignored`, on the side and for the reason
// `scope_pattern_dropped` is there: an issue that HAS a deliverable heading has
// declared its scope, and the warning reports that a path written only outside
// it was not read as a declaration — a fact about where the author wrote it,
// raised on correctly written issues too ("the diff of X is zero").
//
// Issue #286 added `human_only_excluded`: the `human-only` label IS the
// decision (a person does this issue), made by whoever labelled it, and the
// warning reports that the planner honoured it. Its sibling
// `human_only_dependency` stays blocking — "has the person finished it?" is
// still owed, exactly as it is for `external_dependency`.
//
// `harness_path_in_scope` is unchanged in every other respect: it still fires, it
// still names the path, it still sits in `plan.warnings` and in the recovery
// table. Only the colour moved.
const NOTICE_WARNING_CODES = new Set(['harness_path_in_scope', 'profile_repository_override', 'scope_pattern_declared', 'scope_pattern_dropped', 'prose_path_ignored', 'human_only_excluded']);

// `severity` is written on NOTICE entries only. `blocking` stays implicit, which
// buys two things at once:
//
//   * Byte stability. A plan that raises no notice is byte-identical to the plan
//     the pre-#199 runner wrote, so every checked-in full-text golden — and every
//     `plan.json` already on disk from an earlier run — survives untouched.
//   * The absent field reads as the fail-closed default rather than as a gap a
//     reader has to interpret: no `severity` means blocking, in a plan from this
//     runner and in a plan from any runner that predates the field.
//
// So `blocking` is a value the SCHEMA admits (a future emitter may state it) and
// this planner never writes.
function withSeverity(warnings) {
  return warnings.map((warning) =>
    NOTICE_WARNING_CODES.has(warning.code) ? { ...warning, severity: 'notice' } : warning,
  );
}

function hasBlockingWarning(warnings) {
  return warnings.some((warning) => !NOTICE_WARNING_CODES.has(warning.code));
}

function buildResult({ status, runId, runDir, artifacts, plan, errors, warnings, completionCheck, summary }) {
  return {
    result_schema_version: RESULT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status,
    run_id: runId,
    run_dir: runDir,
    artifacts,
    plan,
    errors,
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

// =============================================================================
// Markdown artifacts
// =============================================================================

function listItems(items) {
  return items.length === 0 ? ['- none'] : items.map((item) => `- ${item}`);
}

// One line naming the human-only issues (Issue #286), or nothing, so a plan
// without one renders exactly as before.
function humanOnlyLine(plan, label) {
  const numbers = plan.issues.filter((issue) => issue.dispatch_excluded === 'human_only').map((issue) => `#${issue.number}`);
  return numbers.length === 0 ? [] : [`- ${label}: ${numbers.join(', ')}`];
}

function renderManifest(plan) {
  const lines = [
    '# cmate-orchestrate dry-run manifest',
    '',
    `- Run id: \`${plan.run_id}\``,
    `- Profile: \`${plan.profile.id}\`${plan.profile.verified ? '' : ' (unverified)'}`,
    `- Repository: \`${plan.profile.repository}\``,
    `- Base: \`${plan.profile.base}\``,
    `- Mode: ${plan.generated_mode}`,
    `- Issues: ${plan.inputs.issues.map((n) => `#${n}`).join(', ')}`,
    `- Max parallel: ${plan.max_parallel}`,
    `- Merge order: ${plan.merge_order.map((n) => `#${n}`).join(', ')}`,
    `- Risk: ${plan.risk.level}`,
    ...humanOnlyLine(plan, 'Human-only (in no wave, not dispatched)'),
    '',
    '## Waves',
    '',
  ];
  plan.waves.forEach((wave, index) => {
    lines.push(`- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`);
  });
  lines.push('', '## Planned worktrees', '');
  // A human-only issue gets no worktree from dispatch (Issue #286).
  for (const issue of plan.issues.filter((candidate) => candidate.dispatch_excluded === undefined)) {
    lines.push(`- #${issue.number}: \`${issue.branch}\` at \`${issue.worktree}\``);
  }
  lines.push('', '## Safety', '', ...plan.notes.map((n) => `- ${n}`), '');
  return lines.join('\n');
}

function renderIssueAnalysis(plan) {
  const lines = ['# Issue analysis', ''];
  for (const issue of plan.issues) {
    lines.push(
      `## #${issue.number} ${issue.title}`,
      '',
      `- Objective: ${issue.objective}`,
      `- Classification: ${issue.classification}`,
      `- Branch: \`${issue.branch}\``,
      `- Worktree: \`${issue.worktree}\``,
      `- Labels: ${issue.labels.length ? issue.labels.join(', ') : 'none'}`,
      ...(issue.dispatch_excluded === 'human_only' ? ['- Dispatch: excluded (human-only: a person does it; no worker is sent)'] : []),
      '',
      'Acceptance criteria:',
      ...listItems(issue.acceptance_criteria),
      '',
      // The two counts, apart (CommandMate #3004). The derived half is a
      // permission, most of whose paths never exist, and a reviewer who reads
      // only the length of the list below judges "can this be dispatched" on
      // an inflated number.
      `Scope: ${scopeCounts(issue).declared} declared by the issue + ${scopeCounts(issue).derived} derived by the planner = ` +
        `${issue.suspected_files.length} in scope.allow`,
      '',
      'Suspected files:',
      ...listItems(issue.suspected_files),
      '',
      'Scope defaults (planner-derived lockfiles and test paths, included above):',
      ...listItems(issue.scope_defaults),
      '',
      // The paths the planner read and deliberately kept OUT of scope.allow. It
      // is the only place a reviewer can see that decision before dispatch; a
      // path missing from "Suspected files" is otherwise indistinguishable from
      // one the planner never noticed (Issue #54).
      'Reference files (read, not in scope.allow):',
      ...listItems(issue.reference_files),
      '',
      'Test expectations:',
      ...listItems(issue.test_expectations),
      '',
      'Open questions:',
      ...listItems(issue.questions),
      '',
    );
  }
  return lines.join('\n');
}

function renderDependencyPlan(plan) {
  const lines = ['# Dependency plan', '', '## Edges', ''];
  if (plan.dependencies.length === 0) {
    lines.push('- none');
  } else {
    for (const edge of plan.dependencies) {
      // `basis` is on the line because it is what says whether the edge is a
      // statement someone made or a fact about the files (Issue #182). An edge a
      // reviewer cannot tell those apart for is an edge they cannot judge.
      lines.push(`- #${edge.issue} depends on #${edge.depends_on} (${edge.kind}, basis: ${edge.basis}): ${edge.reason}`);
    }
  }
  lines.push('', '## Waves', '');
  plan.waves.forEach((wave, index) => {
    lines.push(`- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`);
  });
  lines.push('', '## Merge order', '');
  plan.merge_order.forEach((number, index) => {
    lines.push(`${index + 1}. #${number}`);
  });
  if (plan.warnings.length) {
    // The severity is on the line for the same reason an edge's `basis` is: it is
    // what tells a reviewer whether this warning is why the run says `partial`.
    // Only a notice is labelled — blocking is the unmarked default (#199) — so a
    // report with no notice reads exactly as it did before.
    lines.push(
      '',
      '## Warnings',
      '',
      ...plan.warnings.map((w) => `- ${w.code}${w.severity === 'notice' ? ' (notice)' : ''}: ${w.detail}`),
    );
  }
  lines.push('');
  return lines.join('\n');
}

// How many of an issue's scope entries it DECLARED and how many the planner
// DERIVED from them (CommandMate #3004). `scope_defaults` is the derived list and
// a subset of `suspected_files`, so the plan JSON already carries both numbers;
// what was missing is a place a human reads them apart. Measured on
// Kewton/Musunest: 55 / 61 / 60 listed against 20 / 22 / 22 real files, and the
// operator had to write "judge by the files that exist" into every request.
function scopeCounts(issue) {
  const derived = issue.scope_defaults.length;
  return { declared: issue.suspected_files.length - derived, derived };
}

function renderSummary(plan) {
  const conflicts = plan.issues.filter((i) => i.classification === 'conflicting').length;
  return [
    '## 目的',
    `${plan.inputs.issues.map((n) => `#${n}`).join(', ')} を ${plan.profile.repository} に対して並列実行するための dry-run plan。`,
    '',
    '## 結論',
    `${plan.waves.length} wave / merge order ${plan.merge_order.map((n) => `#${n}`).join(' → ')}。risk=${plan.risk.level}。mutation なし。`,
    '',
    '## Wave',
    ...plan.waves.map((wave, index) => `- Wave ${index + 1}: ${wave.map((n) => `#${n}`).join(', ')}`),
    ...humanOnlyLine(plan, 'human-only（人がやる。どの wave にも入れず dispatch しない）'),
    '',
    '## 依存とconflict',
    `- 依存 edge: ${plan.dependencies.length} 件`,
    `- file conflict のある issue: ${conflicts} 件（同一 wave に置かない）`,
    '',
    '## risk と権限',
    `- risk: ${plan.risk.level}（${plan.risk.factors.map((f) => f.code).join(', ') || 'none'}）`,
    `- 要求権限: ${plan.permissions.join(', ')}`,
    '',
    // Declared and derived apart (CommandMate #3004): the derived half is a
    // permission, not work, and most of its paths do not exist.
    '## scope の本数（宣言 + 導出）',
    ...plan.issues.map((issue) => {
      const { declared, derived } = scopeCounts(issue);
      return `- #${issue.number}: 宣言 ${declared} 本 + 導出 ${derived} 本（scope_defaults。使われなくても害の無い許可）`;
    }),
    '',
    '## 次の一手',
    '- この plan を確認し、後続 phase（#1454-1456）で dispatch/PR/merge を実行する。',
  ].join('\n');
}

// =============================================================================
// Entry point
// =============================================================================

function planFailure(error, runId) {
  const status = 'failure';
  const errors = [{ code: error.code, detail: redact(error.detail ?? error.message) }];
  const completionCheck = {
    passed: false,
    checks: [
      { id: 'dry_run_only', passed: true, detail: 'no mutating phase was executed' },
      { id: 'dependencies_validated', passed: error.code !== 'cycle_detected' && error.code !== 'override_incomplete' && error.code !== 'dependency_order_violation', detail: error.code },
      { id: 'waves_conflict_free', passed: false, detail: 'no plan was produced' },
      { id: 'run_isolated', passed: true, detail: 'no run directory was written' },
      { id: 'deterministic', passed: true, detail: 'failure is a pure function of inputs' },
    ],
  };
  return buildResult({
    status,
    runId: runId ?? null,
    runDir: null,
    artifacts: [],
    plan: null,
    errors,
    warnings: [],
    completionCheck,
    summary: `## 結論\n失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  });
}

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  const { profile, warnings: profileWarnings } = resolveProfile(inputs);

  // Issues are loaded before the run id exists: their content is part of the id.
  const rawIssues = loadIssues(inputs, profile);
  const runId = makeRunId(inputs, profile, rawIssues);
  const binaries = verifyBinaries(profile);
  // Compiled once for the whole plan, not per issue: the rules are a property of
  // the profile, and every issue must be judged by the identical matchers.
  const companionRules = compileScopeCompanions(profile.scope_companions ?? null);
  const analyses = rawIssues.map((issue) => analyzeIssue(issue, profile, binaries, companionRules));

  const {
    edges,
    errors: depErrors,
    warnings: dependencyWarnings,
    suppressed,
  } = buildDependencies(analyses, inputs);
  // Before the warnings are assembled: a suppressed inference becomes an open
  // question on its consumer, and openQuestionWarnings below is what carries
  // every question into `warnings` (Issue #52).
  const humanOnly = humanOnlyNumbers(analyses);
  // A lexical pair with a human-only side is not a question: nothing is ever
  // scheduled against that side (Issue #286).
  recordSuppressedInferences(analyses, suppressed.filter((pair) => !humanOnly.has(pair.consumer) && !humanOnly.has(pair.producer)));
  const droppedQuestions = dropHumanOnlyQuestions(analyses, humanOnly);
  // Profile warnings first: a plan built against the wrong repository is the
  // premise a reviewer has to settle before reading anything downstream of it.
  // Then per-issue extraction warnings — first the candidates that never reached
  // `suspected_files`, then the declared paths that will not reach the CONTRACT
  // (#161 / #162), which is the same finding one step further downstream — the
  // unanswered questions those issues still carry, then cross-issue dependency
  // warnings.
  const warnings = [
    ...profileWarnings,
    ...extractionWarnings(analyses),
    ...contractScopeWarnings(analyses),
    ...scopePatternWarnings(analyses),
    ...openQuestionWarnings(analyses),
    ...dependencyWarnings,
    ...humanOnlyWarnings(edges, humanOnly, droppedQuestions),
  ];
  if (depErrors.length > 0) {
    const first = depErrors[0];
    throw new SkillError(first.code, first.detail, 5);
  }

  // Waves and risk are about what dispatch runs, so a human-only issue and every
  // edge touching one are left out of both (Issue #286). With no such issue these
  // are the full lists, and the plan is the one written before.
  const dispatchable = analyses.filter((analysis) => !humanOnly.has(analysis.number));
  const dispatchEdges = edges.filter((edge) => !humanOnly.has(edge.issue) && !humanOnly.has(edge.depends_on));
  const order = inputs.order ? inputs.order.filter((number) => !humanOnly.has(number)) : inputs.order;
  const waves = planWaves(dispatchable, dispatchEdges, inputs.maxParallel, order);
  const plan = buildPlan({ runId, profile, inputs, analyses, edges, waves, dispatchable, dispatchEdges, humanOnly });
  // The PLAN carries the severity annotation (execution-plan.v2's `note_entry`
  // grew an optional `severity` in #199); the result ENVELOPE below carries the
  // same code/detail pairs without it. orchestrate-result.v1 is a closed v1
  // schema whose `entry` definition is shared with `errors`, and putting a new
  // field through it is a v1 contract change of its own — #199 asks for the field
  // on the plan's note_entry, which is where a reader of a run artifact looks.
  // Nothing is lost in the envelope: the codes and details are identical, and the
  // only aggregate the envelope needs — "was anything blocking?" — IS `status`.
  plan.warnings = withSeverity(warnings);

  const runDir = join(inputs.runsDir, runId);
  if (existsSync(runDir)) {
    // What this message may and may not claim (Issue #157). It hashes the issue
    // set with each title/body/labels, the whole resolved profile, and the CLI
    // inputs — so an earlier run reaching this id is CONSISTENT with nothing
    // having changed, and an edited issue body or an edited profile field derives
    // a new id by itself. It is not proof: the cwd origin the default-profile
    // cross-check reads is not in the hash, and it can put a
    // `profile_repository_mismatch` warning into one plan and not the other.
    // Saying "so this means nothing changed" was an assertion the runner cannot
    // make; point at the existing plan.json instead and let the operator settle
    // it. The directory is named once and not re-interpolated: redact() rewrites
    // an absolute path to [REDACTED-PATH], so a second copy would only add noise.
    throw new SkillError(
      'run_exists',
      `run directory ${runDir} already exists; refusing to overwrite. ` +
        'The default run id hashes the planner inputs — the issue set INCLUDING each title/body/labels, the ' +
        'resolved profile (every field, so editing baseline/branch_template/worktree_template/verified/' +
        'scope_companions/dispatch_defaults/integration_baseline/observations derives a new id), and the CLI options — so an ' +
        'earlier run hashed to this ' +
        'same id. ' +
        'Read the plan.json already in that directory to see whether it is the plan you meant to produce. ' +
        'To re-plan anyway: pass --run-id <new-id> (e.g. --run-id plan-retry-1) or --runs-dir <dir> to write elsewhere.',
      4,
    );
  }
  mkdirSync(runDir, { recursive: true });

  const artifacts = [
    { path: 'plan.json', kind: 'plan' },
    { path: 'result.json', kind: 'result' },
    { path: 'manifest.md', kind: 'report' },
    { path: 'issue-analysis.md', kind: 'report' },
    { path: 'dependency-plan.md', kind: 'report' },
  ];

  const completionCheck = completionChecks(plan, depErrors, true);
  // `partial` iff a BLOCKING warning was raised (#199). A run whose only warnings
  // are notices is `success` WITH warnings: the concerns are all in the artifact,
  // named and addressed to someone, and none of them is a decision still owed.
  const status = hasBlockingWarning(warnings) ? 'partial' : 'success';
  const result = buildResult({
    status,
    runId,
    runDir,
    artifacts,
    plan,
    errors: [],
    warnings,
    completionCheck,
    summary: renderSummary(plan),
  });

  writeFileSync(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(join(runDir, 'manifest.md'), renderManifest(plan), 'utf8');
  writeFileSync(join(runDir, 'issue-analysis.md'), renderIssueAnalysis(plan), 'utf8');
  writeFileSync(join(runDir, 'dependency-plan.md'), renderDependencyPlan(plan), 'utf8');

  process.stderr.write(`wrote dry-run artifacts to ${runDir}\n`);
  return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const result = planFailure(error);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    // An unexpected error is a bug in the planner, not a plan outcome.
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

// =============================================================================
// The planner as a module (Issue #217)
// =============================================================================
//
// scripts/inspect.mjs checks the `path:line` and "N 行" claims an issue body
// makes against a real checkout, and it has to read that body WITH THE PLANNER'S
// OWN EYES: a citation the planner never turns into a candidate is a citation
// the plan never carried, and reporting it would be reporting about a different
// document than the one that was planned. So the extraction is imported from
// here rather than copied — the third copy is the one nobody would keep in step,
// and the two that exist (this file and cmate-issue-authoring's mirror) already
// need a conformance test to stay identical.
//
// Nothing above MOVED. The mirrored region
// (`firstNonEmptyLine` … `isSafeRepoPath`, plus `classifyFileCandidates`) is
// byte-unchanged and stays where tests/fixtures/cmate-issue-authoring/
// mirror-conformance.mjs reads it from, which is also why these are re-exported
// in a block instead of by prefixing each declaration with `export`: that test
// matches `^const NAME = ...;` and a prefixed constant would read as a constant
// that had disappeared.
//
// The pattern SOURCES are exported alongside the function because inspect.mjs
// reports which citations were DROPPED before becoming candidates (a `..` escape,
// an absolute path, a URL host), and the only honest way to name those is to run
// the same three patterns and subtract what the extraction kept.
//
// `readIssueAcceptanceGates` is exported on the same principle, for the mode that
// EVALUATES those gates at the base (Issue #218): the set of gates a run is
// allowed to execute must be exactly the set the plan would carry — same subset,
// same 32-id bound, same refusal of a block that does not parse. A second parser
// there would be a runner executing commands the plan never declared, which is
// the fail-closed rule of acceptance-gates-notation.md §5 broken from the inside.
export {
  extractFileCandidates,
  classifyFileCandidates,
  loadIssuesFromFixture,
  fetchIssueWithGh,
  isSafeRepoPath,
  readIssueAcceptanceGates,
  FILE_EXT,
  PATH_START,
  CANDIDATE_BACKTICK,
  CANDIDATE_KNOWN_ROOT,
  CANDIDATE_WITH_EXT,
};

// The planner PLANS when it is the program, and only then. An `import` of this
// module must not write a run directory, so the entry point is guarded rather
// than unconditional.
//
// Compared through realpathSync on both sides because Node resolves the main
// entry through symlinks (`process.argv[1]` may be the link, `import.meta.url`
// the target) and a mismatch here would silently turn `orchestrate.mjs` into a
// program that plans nothing. It cannot be silent for long — every plan fixture
// would fail on the empty stdout — but comparing real paths is what keeps it
// from happening at all.
function invokedAsProgram() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsProgram()) main();
