#!/usr/bin/env node
// cmate-orchestrate — UAT assessment and bounded fix-loop runner
// (Node stdlib only, Node >= 22).
//
// This runner does the *acceptance* half of official CommandMate issue
// orchestration. It runs after the merge runner (scripts/merge.mjs) has
// delivered the verification-passed issues of a plan; it takes the approved plan
// plus the dispatch report and, for the issues whose worker completed AND whose
// verification passed, performs exactly ONE phase per invocation, mirroring the
// CommandAgent explicit-phase-flag design (ADR #1447):
//
//   --write-uat                 Run the acceptance (UAT) assessment once over the
//                               eligible issues and write the report. Read-only:
//                               it never creates a worktree or dispatches a fix.
//   --create-uat-fix-worktrees  Run the bounded fix loop. When UAT fails it
//                               creates a fix worktree per failing issue (in the
//                               shape of the cmate-worktree-setup result, #1448),
//                               dispatches a fix worker, re-verifies it, re-merges
//                               it, and re-runs UAT — repeating up to a fixed
//                               attempt cap.
//
// Adjudication is TWO layers (#1616). The machine gate is a profile-baseline run
// INSIDE the worktree, not a `commandmate uat`/`verify` call. `commandmate uat`
// still does not exist; `commandmate verify` DOES since CommandMate 0.17.0
// (#1544), and the dispatch runner now adjudicates with it (#1588). This runner
// deliberately keeps the baseline re-run: a UAT fix worktree is created after that
// issue's contract task has already terminated, so a verification run there has no
// live contract to bind to (#1620). Moving UAT onto `verify` is its own change,
// not a side effect of that one. The semantic gate is a cmate-acceptance-test result document
// (`acceptance-result.v1.json`) produced by the agent BEFORE this runner is
// invoked and handed over via --acceptance-dir; this runner only reads, validates
// and composes it. No LLM judgement happens here — the composition is a pure
// function of the two gates:
//
//   baseline pass + acceptance `go`             -> pass
//   baseline pass + acceptance `conditional_go` -> conditional (human, never pass)
//   baseline pass + acceptance `no_go`          -> fail (findings drive the fix)
//   baseline fail                               -> fail (whatever acceptance said)
//   no result / not schema-conformant / wrong issue
//                                               -> baseline alone, recorded as the
//                                                  `acceptance_not_run` limitation;
//                                                  a fail under --require-acceptance
//
// The commandmate calls are `send <worktree-id> <message>` / `capture` / `wait
// <worktree-id>` for the fix worker; its worktree id is derived from the fix
// branch (a freshly-created worktree is not yet in `ls`). Like a dispatch worker,
// a fix worker idles after every turn, so `wait` returning idle is not "done"
// (Issue #1468): the loop nudges it until it commits its repair — a new commit on
// the fix branch — bounded by --max-turns, before it re-verifies and re-merges.
//
// Two invariants are non-negotiable:
//
//   1. The loop is bounded. It never runs more than --max-attempts fix attempts.
//      Reaching the cap with issues still failing UAT is reported as `blocked`
//      with the unresolved issues named — never rounded up to success.
//   2. Explicit approval. Without --approve the fix loop is a no-mutation preview:
//      it runs the read-only UAT assessment and reports what it WOULD repair, but
//      creates no worktree, dispatches no fix and re-merges nothing. A fix is
//      re-merged only when its re-verification passed (the verification gate is
//      inherited).
//
// The run artifact is append-only: each attempt is written to its own
// attempts/attempt-<n>/ directory and appended to attempts/history.jsonl. A
// prior attempt is never overwritten, and the output directory must not pre-exist.
//
// Every external command is injectable (--cli / --git / --gh) so the behavior can
// be exercised against a fake CLI without a real repository or the network.
// Tokens, secrets, absolute paths and raw terminal output are redacted before
// they reach the report or an artifact.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  issueOf,
  loadJson,
  parseCliJson,
  pauseMs,
  SEND_NOT_READY_EXIT,
  SEND_NOT_READY_RETRY_DELAY_MS,
  sendNotReadyKind,
  sendPauseMs,
  redact,
  redactionsList,
  resolveLauncher,
  safeBranch,
  safeWorktreeTarget,
  validateDispatch,
  workerMessageProblem,
} from './lib.mjs';

const UAT_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];

// The semantic gate's input contract: an acceptance-result.v1 document
// (skills/cmate-acceptance-test/schemas/acceptance-result.v1.json remains the sole
// normative copy of that schema).
//
// TWO Skills produce that document and this runner accepts either as the PRODUCER.
// `cmate-acceptance-test` judges a target it did not have to stand up; `cmate-uat`
// stands the real environment up first and judges from the evidence it collected
// there (#260). Both write the same schema and both are adjudicated by the same
// composition rules below — which producer wrote it changes nothing about how the
// verdict is read, so it is RECORDED (per-issue `acceptance.producer`) rather than
// branched on.
//
// This is an allowlist of known producers, not a relaxation: a `skill.id` outside
// the set is still `invalid`, exactly as before. Nothing is inferred from an
// unknown id.
const ACCEPTANCE_PRODUCER_IDS = ['cmate-acceptance-test', 'cmate-uat'];
const SUPPORTED_ACCEPTANCE_SCHEMA_VERSION = 1;
// How many findings/conditions are lifted out of one acceptance document. The
// report stays bounded; the document itself remains the full record.
//
// The cap is never silent (Issue #163). When it bites, the LAST of the slots holds
// a note naming how many entries were left out and of what kind — a list that was
// quietly shortened reads as a complete one, and `conditions` is the list of what a
// human still has to close. The note takes a slot rather than being appended after
// the cap, so the bound (and the schema's `maxItems`) still holds exactly.
const MAX_ACCEPTANCE_ITEMS = 8;

// A CommandMate worktree id (mirrors the CLI's isValidWorktreeId).
const WORKTREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

// `commandmate wait` reports the worker's state by EXIT CODE: 0 the worker went
// idle (a turn finished — NOT necessarily done, Issue #1468), 10 a prompt is
// awaiting input, 124 the --timeout elapsed.
const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_PROMPT = 10;
const WAIT_EXIT_TIMEOUT = 124;

// The bounded fix loop's cap. The default is small on purpose: repair is
// expensive and an unbounded loop is out of scope (#1456 non-goal). 1..5.
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_CEILING = 5;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_LIMIT = 120;

// A fix worker, like a dispatch worker, idles after every turn. The fix loop drives
// it turn by turn until it commits, bounded by this many turns (initial send +
// nudges); reaching the cap with no commit is a non-completion, not a false pass.
const DEFAULT_MAX_TURNS = 8;

// =============================================================================
// Unattended — the declaration that nobody is watching this invocation
// (Issue #142 / references/adr-unattended-mode.md sections 2, 6.5, 8, 14.3)
// =============================================================================
//
// `--unattended` is an INPUT DECLARATION, not a permission (ADR "裁定 0"). It
// disables no gate, downgrades no blocking reason to a limitation and raises no
// status by one step; in particular it does NOT imply `--approve`, so an
// unattended fix loop that is meant to repair anything writes both flags.
//
// Stage C (Issue #142) is what lets this runner see the flag at all. It implies
// two things and checks a third:
//
//  1. `--require-acceptance` and `--max-attempts` must be stated EXPLICITLY
//     (ADR section 8). Without the semantic gate an unattended UAT run is a
//     re-run of the profile baseline the dispatch runner already passed — it
//     cannot claim "the acceptance conditions were confirmed", only "the same
//     commands exited zero again". That is also why `acceptance_not_run` is
//     NOT promoted to blocking (ADR section 6.5, third row): it is made
//     impossible instead. A degraded acceptance document is a FAILURE under
//     `--require-acceptance`, so the limitation has nothing to record.
//     `--max-attempts` is explicit for the reason `--wall-clock-budget` is in
//     dispatch (section 15.2): a bound nobody typed is a default, and a default
//     is not a decision anyone made about this run.
//
//  2. The invocation cwd is checked BEFORE a single fix worktree is created
//     (ADR section 14.3, measured in Issue #115). The re-merge below is
//     `git merge --no-ff --no-edit <fix-branch>` with NO cwd argument, so the
//     fix lands on whatever branch the invoking process has checked out:
//       - a CI sitting on `main` gets the UAT fix merged into `main` with no PR,
//         no CI and no review — irreversible once that `main` is pushed;
//       - a detached HEAD produces a merge commit no branch can reach, while
//         `merged.ok` is true and this runner reports `outcome: merged` — a
//         silent false success no stop in section 6.4 catches.
//     Both are refused here, in the shape dispatch's `branch_matches` drift check
//     already has, and with the existing `preflight_failed` vocabulary: no new
//     stop_reason value, and `blocking_reasons[].code` names which of the two it
//     was. `--expect-branch` is what the second check compares against; it is
//     required under `--unattended --create-uat-fix-worktrees` because there is
//     nothing else in the plan that names the integration branch (`profile.base`
//     is the BASE, and merging a fix into the base is the very accident this
//     check exists to prevent).
//
// `--write-uat` is read-only — no worktree, no fix, no re-merge — so the cwd
// check does not apply to it. The two implied flags do: they are about what the
// adjudication MEANS, and that is the same question in both phases.
const UNATTENDED_STAGE = 'C（dispatch + merge + uat）';

// =============================================================================
// Redaction (SkillError, the pattern list and redact/redactionsList are shared
// with the dispatch and merge runners in lib.mjs)
// =============================================================================

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a failure. NOT shared
// with dispatch: an empty excerpt is `''` here and `null` there.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || '';
  return `…${text.slice(text.length - limit)}`;
}

// A redacted, bounded excerpt that keeps the HEAD. `excerpt` above keeps the TAIL
// because a failing command puts its error last; a structured finding is the
// opposite — its criterion id and text come first, so truncating from the end
// would throw away exactly the part that identifies it.
function clip(value, limit = 300) {
  const text = redact(String(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate UAT runner (acceptance assessment / bounded fix loop)

Usage:
  uat.mjs --plan <path> --dispatch <path> (--write-uat | --create-uat-fix-worktrees) [options]

Exactly one phase is enabled per invocation:
  --write-uat                 Run UAT once over the eligible issues and write the
                              report. Read-only: no worktree, no fix, no re-merge.
  --create-uat-fix-worktrees  Run the bounded fix loop: on a UAT failure, create a
                              fix worktree, dispatch a fix, re-verify, re-merge and
                              re-run UAT, up to --max-attempts times.

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --dispatch <path>      dispatch-report.json from the dispatch runner (required);
                         its completed+verified workers are the only eligible issues.
  --approve              Explicit approval to actually mutate in the fix loop.
                         WITHOUT it the loop is a no-mutation preview.
  --max-attempts <1-${MAX_ATTEMPTS_CEILING}>    Fix-attempt cap (default ${DEFAULT_MAX_ATTEMPTS}). The loop never exceeds it;
                         reaching it with failures remaining is reported as blocked.
  --acceptance-dir <dir> Directory holding one acceptance-result.v1 document per
                         issue, named issue-<n>.json, written by cmate-acceptance-test
                         or cmate-uat. Read-only: this runner validates and composes
                         them, it never produces a verdict. Without it the
                         adjudication is the baseline alone.
  --require-acceptance   A missing, non-conformant or wrong-issue acceptance result
                         is a FAILURE instead of a recorded limitation. Needs
                         --acceptance-dir.
  --unattended           Declare that NO HUMAN is watching this invocation (CI /
                         cron). It grants nothing: it does NOT imply --approve and
                         it disables no gate. What it adds is tightening — it
                         requires --require-acceptance and --max-attempts to be
                         stated explicitly, and (with
                         --create-uat-fix-worktrees) it refuses to create a single
                         fix worktree unless HEAD is attached and on
                         --expect-branch, because the re-merge lands on the
                         invocation cwd's current branch.
  --expect-branch <name> Integration branch this run's re-merge must land on.
                         Required with --unattended --create-uat-fix-worktrees.
  --out <dir>            Where UAT artifacts are written (default: <dispatch-dir>/<phase>).
  --cli <launcher>       The CommandMate launcher to drive: an executable plus
                         fixed leading arguments, split on whitespace and run
                         WITHOUT a shell — "commandmate" (default),
                         "/usr/local/bin/commandmate", "npx commandmate@latest".
                         Falls back to $CM (monitor.sh's variable) when omitted.
                         Shell syntax is refused; wrap it in a script instead.
  --git <path>           The git CLI for base/worktree/re-merge (default "git").
  --gh <path>            The gh CLI for the repo-access preflight (default "gh").
  --wait-timeout <sec>   --timeout for the fix worker's commandmate wait (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).
  --max-turns <n>        Max turns to drive a fix worker (initial send + nudges)
                         before giving up with no commit (default ${DEFAULT_MAX_TURNS}).
  --fix-nudge-message <text>
                         Appended after the default fix-worker nudge (which always
                         keeps its commit line). Falls back to the profile's
                         worker_messages.fix_nudge; the flag always wins. Non-blank,
                         at most 2000 characters.
  --poll-limit <n>       Retained for compatibility; wait now blocks (default ${DEFAULT_POLL_LIMIT}).
  --help                 Show this help.

The fix loop is always bounded and never rounds a cap-reached stop up to success;
nothing is mutated without --approve, and a fix is re-merged only after it re-verifies.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        dispatch: { type: 'string' },
        'write-uat': { type: 'boolean' },
        'create-uat-fix-worktrees': { type: 'boolean' },
        approve: { type: 'boolean' },
        'max-attempts': { type: 'string' },
        'acceptance-dir': { type: 'string' },
        'require-acceptance': { type: 'boolean' },
        unattended: { type: 'boolean' },
        'expect-branch': { type: 'string' },
        out: { type: 'string' },
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'wait-timeout': { type: 'string' },
        'max-turns': { type: 'string' },
        'fix-nudge-message': { type: 'string' },
        'poll-limit': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function positiveInt(raw, name, fallback, max) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    throw new SkillError('invalid_input', `${name} must be a positive integer`, 3);
  }
  const value = Number.parseInt(raw, 10);
  if (max !== undefined && value > max) {
    throw new SkillError('invalid_input', `${name} must be at most ${max}`, 3);
  }
  return value;
}

function resolveInputs(parsed) {
  const { values } = parsed;

  // Exactly one phase — the core of the explicit-phase-flag design. Both or
  // neither is a hard input error, never a silent default.
  const phases = [];
  if (values['write-uat']) phases.push('write_uat');
  if (values['create-uat-fix-worktrees']) phases.push('fix_uat');
  if (phases.length !== 1) {
    throw new SkillError(
      'invalid_input',
      'exactly one phase must be enabled: pass either --write-uat or --create-uat-fix-worktrees (not both, not neither)',
      3,
    );
  }

  if (!values.plan) throw new SkillError('invalid_input', '--plan <path> is required', 3);
  if (!values.dispatch) throw new SkillError('invalid_input', '--dispatch <path> is required', 3);

  // Requiring a gate that was never wired up cannot be satisfied by any input, so
  // it is an invocation error rather than a run that fails every issue.
  if (values['require-acceptance'] && !values['acceptance-dir']) {
    throw new SkillError('invalid_input', '--require-acceptance needs --acceptance-dir <dir>: there is nowhere to read an acceptance result from', 3);
  }

  // Stage C's implied flags (Issue #142 / ADR section 8). Refused rather than
  // silently supplied: `--unattended` implying a flag it then fills in for the
  // operator would make the report say a bound was chosen when nobody chose it —
  // the same reasoning dispatch applies to `--wall-clock-budget` (section 15.2).
  if (values.unattended) {
    if (!values['require-acceptance']) {
      throw new SkillError(
        'invalid_input',
        '--unattended requires --require-acceptance (with --acceptance-dir): without the semantic gate an unattended UAT run is a re-run of the '
          + 'profile baseline that dispatch already passed, so it cannot claim the acceptance conditions were confirmed — only that the same commands '
          + 'exited zero again',
        3,
      );
    }
    if (values['max-attempts'] === undefined) {
      throw new SkillError(
        'invalid_input',
        `--unattended requires --max-attempts <1-${MAX_ATTEMPTS_CEILING}>: the fix loop is bounded either way, but a bound nobody typed is a default, `
          + 'and how many times a repair may be attempted with no human present is a decision this run has to state',
        3,
      );
    }
    if (phases[0] === 'fix_uat' && !values['expect-branch']) {
      throw new SkillError(
        'invalid_input',
        '--unattended --create-uat-fix-worktrees requires --expect-branch <name>: the re-merge runs `git merge --no-ff` with no cwd argument, so it '
          + 'lands on whatever branch this process has checked out. Naming the integration branch is what lets the pre-flight refuse a run started on '
          + 'the base branch or on a detached HEAD (references/adr-unattended-mode.md section 14.3)',
        3,
      );
    }
  }

  if (values['fix-nudge-message'] !== undefined) {
    const problem = workerMessageProblem(values['fix-nudge-message']);
    if (problem !== null) throw new SkillError('invalid_input', `--fix-nudge-message ${problem}`, 3);
  }

  // Resolved exactly as dispatch.mjs resolves it — one launcher convention for
  // the whole toolchain, and never a program name with a space in it (Issue #37).
  const cliArgv = resolveLauncher(values.cli);

  return {
    phase: phases[0],
    planPath: values.plan,
    dispatchPath: values.dispatch,
    approve: Boolean(values.approve),
    maxAttempts: positiveInt(values['max-attempts'], 'max-attempts', DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CEILING),
    acceptanceDir: values['acceptance-dir'] ?? null,
    requireAcceptance: Boolean(values['require-acceptance']),
    unattended: Boolean(values.unattended),
    expectBranch: values['expect-branch'] ?? null,
    outDir: values.out ?? null,
    cliArgv,
    cli: cliArgv.join(' '),
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    waitTimeout: positiveInt(values['wait-timeout'], 'wait-timeout', DEFAULT_WAIT_TIMEOUT_SECONDS),
    maxTurns: positiveInt(values['max-turns'], 'max-turns', DEFAULT_MAX_TURNS),
    pollLimit: positiveInt(values['poll-limit'], 'poll-limit', DEFAULT_POLL_LIMIT),
    fixNudgeExtra: values['fix-nudge-message'] ?? null,
    fixNudgeExtraSource: values['fix-nudge-message'] === undefined ? null : '--fix-nudge-message',
  };
}

// =============================================================================
// Plan / dispatch-report loading (loadJson and validateDispatch are shared with
// the merge runner in lib.mjs)
// =============================================================================

// NOT shared with dispatch, which additionally enforces max_parallel and the
// per-wave width bound before it dispatches.
function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(plan.plan_schema_version)) {
    throw new SkillError('plan_invalid', `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(' or ')}`, 3);
  }
  if (plan.skill_id !== SKILL_ID) {
    throw new SkillError('plan_invalid', `plan.skill_id "${plan.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (typeof plan.run_id !== 'string' || plan.run_id.length === 0) {
    throw new SkillError('plan_invalid', 'plan.run_id is missing', 3);
  }
  const profile = plan.profile;
  if (!profile || typeof profile.repository !== 'string' || typeof profile.base !== 'string') {
    throw new SkillError('plan_invalid', 'plan.profile is missing repository/base', 3);
  }
  if (!Array.isArray(plan.issues)) {
    throw new SkillError('plan_invalid', 'plan.issues is missing', 3);
  }
  // Only fix_nudge is this runner's; the other worker_messages keys are dispatch's
  // and are neither read nor refused here.
  const fixNudge = profile.worker_messages?.fix_nudge;
  if (fixNudge !== undefined) {
    const problem = workerMessageProblem(fixNudge);
    if (problem !== null) throw new SkillError('plan_invalid', `plan.profile.worker_messages.fix_nudge ${problem}`, 3);
  }
  return plan;
}

// The eligible set — the same verification gate the merge runner inherits: an
// issue is subjected to UAT (and repaired) ONLY when its worker completed AND its
// verification passed. Processed in the plan's merge order.
function eligibleIssues(plan, dispatch) {
  const passed = new Set();
  for (const wave of dispatch.waves) {
    for (const worker of wave.workers ?? []) {
      if (worker.worker_state === 'completed' && worker.verification && worker.verification.outcome === 'pass') {
        passed.add(worker.issue);
      }
    }
  }
  const order = Array.isArray(plan.merge_order) ? plan.merge_order : [];
  const ordered = order.filter((n) => passed.has(n));
  for (const n of [...passed].sort((a, b) => a - b)) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

// =============================================================================
// CLI invocation (identical to dispatch.mjs; merge.mjs takes no options bag)
// =============================================================================

function runCli(bin, args, extra = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      ...extra,
    });
    return { ok: true, stdout, stderr: '', status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : redact(error.message ?? ''),
      status: error.status ?? null,
    };
  }
}

// One call to the CommandMate CLI, through the resolved launcher. Identical to
// dispatch.mjs's helper: the launcher may carry fixed leading arguments, so the
// subcommand is appended to it instead of being the whole argv (Issue #37).
function runCm(inputs, args, extra = {}) {
  return runCli(inputs.cliArgv[0], [...inputs.cliArgv.slice(1), ...args], extra);
}

// The CommandMate worktree id for a branch, computed the way the CLI does
// (generateWorktreeId): lowercase, non [a-z0-9-] -> '-', collapse/trim hyphens,
// joined as `<repo>-<branch>`. Used for a freshly-created fix worktree, which is
// not yet in `ls`. Returns null when the result is not a valid id.
function deriveWorktreeId(repository, branch) {
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const repo = String(repository).split('/').pop() ?? '';
  const id = `${slug(repo)}-${slug(branch)}`;
  return WORKTREE_ID_RE.test(id) ? id : null;
}

// The acceptance/verification signal in the worktree-based model: run the profile
// baseline INSIDE a worktree (there is no `commandmate uat`; see the module header
// for why the contract verdict is not used here either). Passes only
// when every baseline command exits zero. A missing worktree or any non-zero step
// is a fail. Returns { outcome, checks, note } where checks label the steps run.
function runBaseline(baseline, worktreePath) {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    return { outcome: 'fail', checks: [], note: 'profile has no baseline to run' };
  }
  const checks = [];
  for (const command of baseline) {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) continue;
    checks.push(redact(String(command)));
    const res = runCli(argv[0], argv.slice(1), { cwd: worktreePath });
    if (!res.ok) {
      return { outcome: 'fail', checks, note: excerpt(res.stderr || res.stdout || `baseline step failed: ${command}`) };
    }
  }
  return { outcome: 'pass', checks, note: '' };
}

// =============================================================================
// Acceptance gate (semantic layer, #1616) — read, validate, never judge
// =============================================================================
//
// The acceptance verdict is produced by cmate-acceptance-test BEFORE this runner
// runs, and handed over as one result document per issue at
// `<--acceptance-dir>/issue-<n>.json`. This runner is deterministic Node stdlib:
// it reads the document, checks it against acceptance-result.v1 and confirms it
// targets the issue at hand. It never interprets an acceptance criterion itself.
//
// Every way the document can be unusable is a NAMED state, never a silent pass:
//
//   not_configured  --acceptance-dir was not given; adjudication is baseline-only
//                   and says so. This is the pre-#1616 behavior, unchanged.
//   missing         the directory was given but holds no document for this issue
//   invalid         not JSON, or not conformant to acceptance-result.v1
//   mismatched      conformant, but its target.issue_ref names a different issue
//   loaded          conformant and on target; its verdict enters the composition

const ACCEPTANCE_VERDICTS = new Set(['go', 'conditional_go', 'no_go']);
const ACCEPTANCE_STATUSES = new Set(['success', 'partial', 'failure']);

// The top-level fields acceptance-result.v1 requires. A document missing any of
// them is not the contract, whatever else it contains.
const ACCEPTANCE_REQUIRED_FIELDS = [
  'result_schema_version', 'skill', 'generated_at', 'status', 'verdict', 'verdict_reason',
  'target', 'environment', 'criteria', 'checks', 'confirmations', 'evidence',
  'next_actions', 'blocking_reasons', 'limitations',
];

// Criterion outcomes that are NOT a resolved pass/fail. acceptance-result.v1 keeps
// them distinct on purpose, and so does the report: they are the conditions a
// human has to close, not findings a fix worker can repair.
const UNRESOLVED_CRITERION_OUTCOMES = new Set(['flaky', 'blocked', 'not_run', 'manual_pending', 'not_verifiable']);

function acceptanceFileName(number) {
  return `issue-${number}.json`;
}

// The issue an acceptance document targets. `issue_ref` is free-form by contract
// ("Issue 番号または Issue URL"), so the three shapes the acceptance Skill emits
// are all accepted: an issue URL, `owner/repo#<n>`, and a bare number. Anything
// else is unresolvable — which is a mismatch, never an assumed match.
function issueNumberOfRef(ref) {
  if (typeof ref !== 'string') return null;
  const url = /\/issues\/(\d+)(?:\D|$)/.exec(ref);
  if (url) return Number.parseInt(url[1], 10);
  const hash = /#(\d+)\s*$/.exec(ref);
  if (hash) return Number.parseInt(hash[1], 10);
  const bare = /^\s*(\d+)\s*$/.exec(ref);
  if (bare) return Number.parseInt(bare[1], 10);
  return null;
}

// Conformance against acceptance-result.v1, limited to what the composition
// depends on. Returns null when the document is usable, or the reason it is not.
function acceptanceNonConformance(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object';
  for (const field of ACCEPTANCE_REQUIRED_FIELDS) {
    if (!(field in doc)) return `missing required field "${field}"`;
  }
  if (doc.result_schema_version !== SUPPORTED_ACCEPTANCE_SCHEMA_VERSION) {
    return `unsupported result_schema_version ${JSON.stringify(doc.result_schema_version)}; this runner understands ${SUPPORTED_ACCEPTANCE_SCHEMA_VERSION}`;
  }
  const skill = doc.skill;
  if (!skill || typeof skill !== 'object' || !ACCEPTANCE_PRODUCER_IDS.includes(skill.id)) {
    return `skill.id is not one of ${ACCEPTANCE_PRODUCER_IDS.join('/')}`;
  }
  if (typeof skill.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(skill.version)) {
    return 'skill.version is not a semantic version';
  }
  if (!ACCEPTANCE_VERDICTS.has(doc.verdict)) return `verdict ${JSON.stringify(doc.verdict)} is not one of go/conditional_go/no_go`;
  if (!ACCEPTANCE_STATUSES.has(doc.status)) return `status ${JSON.stringify(doc.status)} is not one of success/partial/failure`;
  if (typeof doc.verdict_reason !== 'string' || doc.verdict_reason.length === 0) return 'verdict_reason is empty';
  const target = doc.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return 'target is not an object';
  if (typeof target.issue_ref !== 'string' || target.issue_ref.length === 0) return 'target.issue_ref is empty';
  for (const field of ['criteria', 'checks', 'next_actions', 'blocking_reasons', 'limitations']) {
    if (!Array.isArray(doc[field])) return `${field} is not an array`;
  }
  return null;
}

function acceptanceState(state, note) {
  return {
    state,
    verdict: null,
    status: null,
    issue_ref: null,
    verdict_reason: '',
    // Which Skill produced the document. Only a `loaded` state can name one: a
    // missing document has no producer, and an invalid one has no producer this
    // runner is willing to vouch for (the id is exactly what failed to conform).
    producer: null,
    findings: [],
    conditions: [],
    note,
  };
}

// Fit per-kind groups of excerpts into `max` slots. Two rules, both lifted from
// merge.mjs's capped()/droppedNote() (Issue #163):
//
//   1. The cap is always STATED. A dropped entry is counted in a trailing note, so
//      a reader can tell "there were 8" from "8 is all this report shows".
//   2. Every kind that has something to say keeps at least one slot. Items are
//      concatenated kind by kind, so without a reservation a long run of failing
//      criteria eats the whole budget and the next_actions and limitations behind
//      it disappear entirely — the very entries a human is supposed to close.
//
// `groups` is [{ label, items }] in the order the report wants them. The result is
// never longer than `max`: when anything is dropped the note SPENDS a slot instead
// of being appended past the cap, so the bound the schema pins is unchanged.
function fitAcceptanceItems(groups, max) {
  const present = groups.filter((group) => group.items.length > 0);
  const total = present.reduce((sum, group) => sum + group.items.length, 0);
  if (total <= max) return present.flatMap((group) => group.items);

  const quota = present.map(() => 0);
  let left = max - 1; // the note itself costs one slot
  for (let i = 0; i < present.length && left > 0; i += 1) {
    quota[i] = 1;
    left -= 1;
  }
  for (let i = 0; i < present.length && left > 0; i += 1) {
    const room = Math.min(left, present[i].items.length - quota[i]);
    quota[i] += room;
    left -= room;
  }

  const shown = present.flatMap((group, i) => group.items.slice(0, quota[i]));
  const dropped = present
    .map((group, i) => ({ label: group.label, count: group.items.length - quota[i] }))
    .filter((entry) => entry.count > 0);
  const count = dropped.reduce((sum, entry) => sum + entry.count, 0);
  const breakdown = dropped.map((entry) => `${entry.count} ${entry.label}`).join(', ');
  shown.push(
    `Not listed here: ${count} further item(s) — ${breakdown}. This list is capped at ${max} entries to keep the report bounded; the acceptance result document holds the full record.`,
  );
  return shown;
}

// What a fix worker has to repair: the criteria that resolved to a failure, plus
// the reasons the acceptance run itself called blocking.
function acceptanceFindings(doc) {
  const failures = [];
  for (const criterion of doc.criteria) {
    if (criterion && criterion.outcome === 'fail') {
      failures.push(clip(`${criterion.id} fail: ${criterion.text}${criterion.notes ? ` — ${criterion.notes}` : ''}`, 300));
    }
  }
  const blocking = doc.blocking_reasons.map((reason) => clip(`blocking: ${String(reason)}`, 300));
  return fitAcceptanceItems([
    { label: 'failing criterion/criteria', items: failures },
    { label: 'blocking reason(s)', items: blocking },
  ], MAX_ACCEPTANCE_ITEMS);
}

// What a human has to close: the criteria that never resolved, and the next
// actions the acceptance run attached to them.
function acceptanceConditions(doc) {
  const unresolved = [];
  for (const criterion of doc.criteria) {
    if (criterion && UNRESOLVED_CRITERION_OUTCOMES.has(criterion.outcome)) {
      unresolved.push(clip(`${criterion.id} ${criterion.outcome}: ${criterion.text}${criterion.notes ? ` — ${criterion.notes}` : ''}`, 300));
    }
  }
  const actions = [];
  for (const action of doc.next_actions) {
    if (action && typeof action === 'object') actions.push(clip(`next: ${String(action.action)}（owner: ${String(action.owner)}）`, 300));
  }
  const limitations = doc.limitations.map((limitation) => clip(`limitation: ${String(limitation)}`, 300));
  return fitAcceptanceItems([
    { label: 'unresolved criterion/criteria', items: unresolved },
    { label: 'next action(s)', items: actions },
    { label: 'limitation(s)', items: limitations },
  ], MAX_ACCEPTANCE_ITEMS);
}

// Load one issue's acceptance result. Only the file NAME is ever recorded, never
// the operator-supplied directory, so no host path reaches the report.
function loadAcceptance(inputs, number) {
  if (!inputs.acceptanceDir) {
    return acceptanceState('not_configured', 'acceptance gate not configured (--acceptance-dir was not given); adjudicated on the baseline alone');
  }
  const name = acceptanceFileName(number);
  let text;
  try {
    text = readFileSync(join(inputs.acceptanceDir, name), 'utf8');
  } catch {
    return acceptanceState('missing', `no acceptance result ${name} under --acceptance-dir`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return acceptanceState('invalid', `${name} is not valid JSON`);
  }
  const nonConformance = acceptanceNonConformance(doc);
  if (nonConformance !== null) {
    return acceptanceState('invalid', `${name} does not conform to acceptance-result.v${SUPPORTED_ACCEPTANCE_SCHEMA_VERSION}: ${nonConformance}`);
  }

  const targeted = issueNumberOfRef(doc.target.issue_ref);
  if (targeted !== number) {
    const mismatched = acceptanceState(
      'mismatched',
      targeted === null
        ? `${name} target.issue_ref does not name an issue number, so it cannot be confirmed to cover #${number}`
        : `${name} targets #${targeted}, not #${number}`,
    );
    mismatched.issue_ref = clip(doc.target.issue_ref, 120);
    return mismatched;
  }

  return {
    state: 'loaded',
    verdict: doc.verdict,
    status: doc.status,
    issue_ref: clip(doc.target.issue_ref, 120),
    verdict_reason: clip(doc.verdict_reason, 300),
    producer: { id: doc.skill.id, version: doc.skill.version },
    findings: acceptanceFindings(doc),
    conditions: acceptanceConditions(doc),
    note: `${name}: ${doc.skill.id} ${doc.skill.version} returned ${doc.verdict} (run status ${doc.status})`,
  };
}

// Compose the machine gate (baseline) with the semantic gate (acceptance) into one
// per-issue verdict. This is the whole point of #1616 and it never rounds up: a
// conditional_go stays conditional, a no_go fails, and an acceptance that could not
// be read degrades LOUDLY — to a recorded limitation, or to a failure when the
// operator declared the gate mandatory.
//
// It reads only the baseline OUTCOME, not how the baseline was measured, so it is
// unaffected by #1588 replacing that measurement with a contract `wait --verify`
// exit code.
function composeVerdict(baselineOutcome, acceptance, requireAcceptance) {
  if (baselineOutcome !== 'pass') return { verdict: 'fail', source: 'baseline' };
  switch (acceptance.state) {
    case 'loaded':
      if (acceptance.verdict === 'go') return { verdict: 'pass', source: 'acceptance_go' };
      if (acceptance.verdict === 'conditional_go') return { verdict: 'conditional', source: 'acceptance_conditional_go' };
      return { verdict: 'fail', source: 'acceptance_no_go' };
    case 'not_configured':
      return { verdict: 'pass', source: 'baseline_only' };
    default:
      // missing / invalid / mismatched.
      return requireAcceptance
        ? { verdict: 'fail', source: 'acceptance_required' }
        : { verdict: 'pass', source: 'baseline_only_degraded' };
  }
}

// The issues whose adjudication silently lost its semantic layer — the ones the
// `acceptance_not_run` limitation has to name.
function acceptanceDegraded(uatResult) {
  return uatResult.verdict_source === 'baseline_only_degraded';
}

// =============================================================================
// Preflight (read-only; mirrors merge's delivery-scoped drift re-check)
// =============================================================================

function preflight(inputs, plan) {
  const checks = [];
  const add = (code, ok, detail) => checks.push({ code, ok, blocking: true, detail });

  const cli = runCm(inputs, ['--version']);
  add('cli_available', cli.ok, cli.ok ? 'commandmate CLI is runnable' : 'commandmate CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves`);

  return checks;
}

// The stage-C cwd pre-flight (Issue #142 / ADR section 14.3, measured in #115).
//
// Reported through `blocking_reasons` rather than as two more `preflight[]`
// rows because that array's `code` is a closed enum in uat-report.v1 and the
// schema version is not being bumped for this (ADR section 11): the stop_reason
// stays `preflight_failed`, and WHICH check failed is named by the reason code.
//
// `git symbolic-ref -q HEAD` is the detached-HEAD probe rather than `rev-parse
// --abbrev-ref HEAD`, which answers the literal string "HEAD" when detached and
// would therefore have to be compared against a magic value. `-q` makes a
// detached HEAD an exit-1-with-no-output instead of an error message, so
// "detached" and "git is broken" are told apart by the presence of output.
//
// Returns [] when the cwd is safe to re-merge into.
function unattendedCwdReasons(inputs) {
  const head = runCli(inputs.git, ['symbolic-ref', '-q', 'HEAD']);
  const ref = head.ok ? head.stdout.trim() : '';
  if (ref === '') {
    return [{
      code: 'unattended_cwd_detached',
      detail: 'the invocation cwd is on a detached HEAD (`git symbolic-ref -q HEAD` named no branch). The fix re-merge is `git merge --no-ff` with no cwd '
        + 'argument, so it would build a merge commit no branch can reach while still exiting 0 — this runner would report `outcome: merged` for work that '
        + 'survives nowhere (measured in Issue #115). No fix worktree was created. Check out the integration branch and re-run',
    }];
  }
  const branch = ref.replace(/^refs\/heads\//, '');
  if (branch !== inputs.expectBranch) {
    return [{
      code: 'unattended_cwd_branch_mismatch',
      detail: `the invocation cwd is on "${redact(branch)}", but --expect-branch names ${redact(String(inputs.expectBranch))}. The fix re-merge is `
        + '`git merge --no-ff` with no cwd argument, so the fix would land on the checked-out branch instead: a CI sitting on the base branch would take a '
        + 'UAT fix into it with no PR, no CI and no review, and that is irreversible once pushed (measured in Issue #115). No fix worktree was created',
    }];
  }
  return [];
}

// The run-wide declaration (mirrors the dispatch and merge runners' entry of the
// same code). One entry in EVERY unattended report, including the ones that
// stopped in the pre-flight, so what the run declared — and what that
// declaration implied — is readable from the report alone.
//
// Deliberately free of absolute paths: `redact()` would replace them with
// `[REDACTED-PATH]` and would tally a redaction a run without the flag does not
// have, so the "an unattended run differs only by this limitation" property
// would stop being true.
const UNATTENDED_MODE_CODE = 'unattended_mode';

function unattendedModeLimitation(inputs) {
  const cwdClause = inputs.phase === 'fix_uat'
    ? `再merge 先の pre-flight: HEAD が detached でないこと・HEAD が ${inputs.expectBranch} であること`
      + '（外れていれば fix worktree を1つも作らずに停止する。`git merge --no-ff` は cwd 指定を持たない）'
    : '再merge 先の pre-flight は不要（--write-uat は read-only で worktree も再merge も作らない）';
  return {
    code: UNATTENDED_MODE_CODE,
    detail: `--unattended（段階 ${UNATTENDED_STAGE}）: この invocation に人間は居ない、という入力の宣言である。`
      + '締め付けだけを含意し、権限は1つも足していない — **`--approve` は含意しない**、'
      + 'ゲートを無効化せず、blocking を limitation に格下げせず、status を1段も上げない。'
      + `含意した締め付け: --require-acceptance と --max-attempts ${inputs.maxAttempts} の明示 / ${cwdClause}。`
      + '意味ゲート必須の帰結として `acceptance_not_run` は起こらない（昇格ではなく、起こさない）。'
      + '`GH_TOKEN` と `GIT_TERMINAL_PROMPT=0` は job 定義側で置くこと（runner は検査しない）。',
  };
}

// =============================================================================
// UAT assessment (read-only)
// =============================================================================

// Adjudicate one issue on both gates. The machine gate executes the profile
// baseline inside the worktree that currently holds its work (its dispatch
// worktree, or — after a fix landed — that fix's worktree); there is no
// `commandmate uat`, so the signal is a real baseline run. The semantic gate reads
// that issue's acceptance result. A missing worktree, a non-zero step, a no_go or
// (under --require-acceptance) an unreadable result is a fail, never an optimistic
// pass; a conditional_go is neither, and is reported as such.
function runUat(inputs, plan, number, worktreePath) {
  const baseline = runBaseline(plan.profile.baseline, worktreePath);
  const acceptance = loadAcceptance(inputs, number);
  const composed = composeVerdict(baseline.outcome, acceptance, inputs.requireAcceptance);
  return {
    issue: number,
    ran: true,
    report_schema_version: null,
    // The legacy tri-state, kept as a projection of the composite verdict: `pass`
    // ONLY for a composite pass. A v1 reader that knows nothing about the
    // acceptance gate therefore can never read a conditional or failing issue as
    // passed — the precise value is in `verdict`.
    outcome: composed.verdict === 'pass' ? 'pass' : 'fail',
    scenarios: baseline.checks,
    note: [baseline.note, acceptance.note].filter(Boolean).join('; '),
    verdict: composed.verdict,
    verdict_source: composed.source,
    baseline: { outcome: baseline.outcome, checks: baseline.checks, note: baseline.note },
    acceptance,
  };
}

// The two ways an assessment falls short, kept apart on purpose: a `fail` is a
// defect the bounded fix loop may try to repair, a `conditional` is a human
// decision the loop must never auto-answer by repairing or by passing.
function failingOf(results) {
  return results.filter((result) => result.verdict === 'fail').map((result) => result.issue);
}

function conditionalOf(results) {
  return results.filter((result) => result.verdict === 'conditional').map((result) => result.issue);
}

// =============================================================================
// Fix worktree (aligned with the cmate-worktree-setup result contract, #1448)
// =============================================================================

// Create one fix worktree for a failing issue: resolve the base ref to a commit
// SHA, then (only under --approve) create the branch and worktree from that SHA.
// An existing worktree is never implicitly overwritten — the per-attempt suffix
// keeps each attempt's target distinct. No absolute path is ever recorded.
function createFixWorktree(inputs, plan, number, attemptNo) {
  const issue = issueOf(plan, number);
  const branch = safeBranch(`${issue.branch ?? `feature/issue-${number}`}-uat-fix-${attemptNo}`);
  const directory = safeWorktreeTarget(`${issue.worktree ?? `../issue-${number}`}-uat-fix-${attemptNo}`);
  const record = {
    issue: number,
    branch: branch ?? String(issue.branch ?? `feature/issue-${number}`),
    directory: directory ?? `../issue-${number}-uat-fix-${attemptNo}`,
    base_sha: null,
    created: false,
    reused: false,
    note: '',
  };

  if (branch === null || directory === null) {
    record.note = 'fix branch or worktree target rejected by the safe-ref/path-escape guard';
    return record;
  }

  // Re-confirm the base as a resolved commit SHA before creating (the setup
  // contract's base_reconfirmed rule): a symbolic ref alone is never enough.
  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  const sha = base.ok ? base.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    record.note = `base ${plan.profile.base} did not resolve to a commit SHA`;
    return record;
  }
  record.base_sha = sha;

  if (!inputs.approve) {
    record.note = `would create ${branch} from ${sha.slice(0, 8)} (preview; --approve to execute)`;
    return record;
  }

  const added = runCli(inputs.git, ['worktree', 'add', directory, '-b', branch, sha]);
  record.created = added.ok;
  record.note = added.ok ? `created fix worktree from ${sha.slice(0, 8)}` : excerpt(added.stderr || added.stdout || 'git worktree add failed');
  return record;
}

// =============================================================================
// Fix dispatch (self-contained fix prompt; send / wait / verify)
// =============================================================================

function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${redact(String(item))}`).join('\n');
}

// How to name the producer in a heading. A `loaded` document says who wrote it; any
// other state has no producer to name, and the honest label is the generic one —
// writing a Skill's name over a verdict that Skill never produced is how the
// hard-coded heading misled the worker before #259.
function acceptanceProducerLabel(acceptance) {
  const id = acceptance && acceptance.producer ? acceptance.producer.id : null;
  return typeof id === 'string' && id.length > 0 ? id : 'semantic gate';
}

// The semantic gate's own words, quoted into the fix prompt. A no_go names WHICH
// criterion failed and why; handing the worker that instead of "UAT failed" is the
// difference between a targeted repair and a guess. When acceptance did not run,
// say so plainly rather than implying a judgement that was never made.
function acceptanceSection(acceptance) {
  if (!acceptance || acceptance.state !== 'loaded') {
    const state = acceptance ? acceptance.state : 'not_configured';
    return [
      `An acceptance verdict was not available for this issue (${state}), so the failure`,
      'above is the repository baseline alone. Do not assume the acceptance criteria pass.',
    ].join('\n');
  }
  return [
    `Verdict: ${acceptance.verdict} — ${acceptance.verdict_reason}`,
    '',
    'Findings to repair:',
    bullets(acceptance.findings, 'The acceptance run recorded no individual finding; reproduce its verdict and fix the cause.'),
    '',
    'Unresolved conditions (do not silently close these):',
    bullets(acceptance.conditions, 'None recorded.'),
  ].join('\n');
}

function buildFixPrompt(plan, issue, failingScenarios, acceptance) {
  return [
    `# UAT fix task — issue #${issue.number}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    '',
    '## What failed',
    'User acceptance testing failed for this issue after it was merged. Repair it so',
    'the acceptance scenarios below pass, without regressing the original objective.',
    '',
    '## Failing acceptance scenarios',
    bullets(failingScenarios, 'The UAT report did not name a scenario; reproduce the acceptance check and fix the failure.'),
    '',
    // Name the producer that actually wrote the verdict. Hard-coding one Skill's
    // name here told the worker the wrong thing as soon as a second producer
    // existed, and "who judged this" is load-bearing when the worker goes to
    // reproduce the failure: cmate-uat's evidence came from a real environment
    // it stood up, cmate-acceptance-test's did not.
    `## Acceptance verdict (${acceptanceProducerLabel(acceptance)})`,
    acceptanceSection(acceptance),
    '',
    '## Objective (unchanged)',
    redact(issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`),
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'See the issue.'),
    '',
    '## Verification to run before reporting done',
    bullets(plan.profile.baseline, 'Run the repository baseline, then the acceptance scenarios above.'),
    '',
    '## Rules',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- Run the verification above and report its real result. Do not report done on a failing check.',
    '- Keep working across turns until the repair is complete; do not stop half-done.',
    '- When the repair is complete, make a SINGLE commit of the fix on this branch.',
    '  That commit is the completion signal — the supervisor treats a new commit as',
    '  "done" and will otherwise nudge you to keep going.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
}

// The HEAD commit of a fix worktree, read INSIDE it. The loop snapshots this before
// dispatch and compares after each idle: a changed HEAD means the fix worker
// committed its repair — the real completion signal (Issue #1468). Null when HEAD
// cannot be read, which counts as "no commit yet", never as done.
function worktreeHeadSha(inputs, worktreePath) {
  if (!worktreePath) return null;
  const result = runCli(inputs.git, ['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

// ONE `commandmate send`, retried once when refused as not ready (CommandMate#3006): a fix
// worktree is created by this run, so its first send is always the one that
// starts a brand-new session — exactly the send that races the agent's start-up.
// The rule is lib.mjs's, shared with dispatch; each retry is recorded in
// `retries` so the fix record's note can say it happened.
function sendRetryingNotReady(inputs, args, retries) {
  const first = runCm(inputs, args);
  const kind = sendNotReadyKind(first);
  if (kind === null) return first;
  const delayMs = sendPauseMs(SEND_NOT_READY_RETRY_DELAY_MS);
  pauseMs(delayMs);
  const second = runCm(inputs, args);
  retries.push(`a send was refused as not ready (${kind === 'session_starting' ? '503 SESSION_STARTING' : 'prompt not ready'}, exit ${SEND_NOT_READY_EXIT}, nothing typed) `
    + `and was re-sent once after ${Math.round(delayMs / 1000)}s: ${second.ok ? 'the retry went through' : 'the retry was refused too'}`);
  return second;
}

// `commandmate send`, then confirm the fix worker actually started (Issue #1468).
// A send can leave the message unsubmitted; if the capture right after shows the
// worker is neither generating nor prompting, re-send once. Best-effort — the
// commit check below is the ground truth.
function sendAndConfirm(inputs, worktreeId, message, retries = []) {
  const first = sendRetryingNotReady(inputs, ['send', worktreeId, message], retries);
  if (!first.ok) {
    return { sent: false, note: excerpt(first.stderr || first.stdout || 'send failed') };
  }
  const capture = parseCliJson(runCm(inputs, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, confirmed: true, note: '' };
  const again = runCm(inputs, ['send', worktreeId, message]);
  if (!again.ok) return { sent: true, confirmed: false, note: 'send may not have submitted and the re-send failed' };
  return { sent: true, confirmed: false, note: 're-sent after an unconfirmed first send' };
}

// The message that nudges an idle-but-uncommitted fix worker to keep going.
const FIX_NUDGE_MESSAGE = [
  '続けて修正を進め、この Issue の受入不合格を解消してください。',
  '指示どおりに書けないと分かったら、進めずに止めて報告してください。',
  'まだ変更が commit されていません。完了したらこのブランチに単一 commit を作成してください（それが完了の合図です）。',
].join('\n');

// The default fix nudge, plus the flag's / profile's text appended AFTER it —
// never instead of it, so the commit line cannot be dropped.
function fixNudgeMessage(inputs) {
  return inputs.fixNudgeExtra === null ? FIX_NUDGE_MESSAGE : `${FIX_NUDGE_MESSAGE}\n${inputs.fixNudgeExtra}`;
}

// Precedence is flag → profile → nothing. Only the length is recorded, never the text.
function fixNudgeLimitation(inputs, plan) {
  const declared = plan.profile?.worker_messages?.fix_nudge;
  if (inputs.fixNudgeExtra === null) {
    if (declared === undefined) return null;
    inputs.fixNudgeExtra = declared;
    inputs.fixNudgeExtraSource = 'profile';
  }
  const profileId = String(plan.profile?.id ?? 'unknown');
  const from = inputs.fixNudgeExtraSource === '--fix-nudge-message'
    ? `--fix-nudge-message${declared === undefined ? '' : ` overrode profile ${profileId}'s worker_messages.fix_nudge`}`
    : `from profile ${profileId}`;
  return {
    code: 'worker_messages_applied',
    detail: `fix_nudge=${inputs.fixNudgeExtra.length} chars (${from}), appended after the default fix nudge; the default's commit line is always sent`,
  };
}

// Supervise a fix worker to a real completion, the same way dispatch does: a fix
// worker idles after every turn, so drive it turn by turn — dispatch, wait; on
// idle-with-no-new-commit nudge and wait again — until it commits (completed),
// raises a prompt (a non-completion the fix loop never auto-answers), times out,
// fails, or the --max-turns cap is reached with no commit. Returns the worker state,
// whether a fix was dispatched at all, and a note.
function superviseFixUntilCommit(inputs, worktreeId, worktreeDir, message) {
  const retries = [];
  const supervised = superviseFixLoop(inputs, worktreeId, worktreeDir, message, retries);
  if (retries.length === 0) return supervised;
  return { ...supervised, note: [supervised.note, ...retries].filter(Boolean).join('; ') };
}

function superviseFixLoop(inputs, worktreeId, worktreeDir, message, retries) {
  const baseSha = worktreeHeadSha(inputs, worktreeDir);
  const sent0 = sendAndConfirm(inputs, worktreeId, message, retries);
  if (!sent0.sent) {
    return { state: 'failed', dispatched: false, note: `fix dispatch failed: ${sent0.note}` };
  }
  let turns = 1;
  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    const waited = runCm(inputs, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
    if (!waited.ok && waited.status === WAIT_EXIT_PROMPT) {
      return { state: 'prompt', dispatched: true, note: 'fix worker raised a prompt; the loop does not auto-answer' };
    }
    if (!waited.ok && waited.status === WAIT_EXIT_TIMEOUT) {
      return { state: 'timeout', dispatched: true, note: `wait timed out after ${inputs.waitTimeout}s` };
    }
    if (!waited.ok) {
      return { state: 'failed', dispatched: true, note: excerpt(waited.stderr || waited.stdout || `wait exited ${waited.status ?? 'with an error'}`) };
    }
    const currentSha = worktreeHeadSha(inputs, worktreeDir);
    if (currentSha !== null && currentSha !== baseSha) {
      const note = turns > 1 ? `fix completed after ${turns - 1} nudge(s); new commit detected` : 'fix completed; new commit detected';
      return { state: 'completed', dispatched: true, note };
    }
    if (turns >= inputs.maxTurns) {
      return { state: 'failed', dispatched: true, note: `fix worker made no new commit after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap` };
    }
    const nudged = sendAndConfirm(inputs, worktreeId, fixNudgeMessage(inputs), retries);
    if (!nudged.sent) {
      return { state: 'failed', dispatched: true, note: `fix nudge failed: ${nudged.note}` };
    }
    turns += 1;
  }
  return { state: 'failed', dispatched: true, note: 'fix supervision exceeded its hard iteration bound' };
}

function dispatchFix(inputs, plan, number, fixBranch, worktreeDir, message) {
  const fix = {
    issue: number,
    task_id: null,
    dispatched: false,
    worker_state: 'not_dispatched',
    verification: { ran: false, report_schema_version: null, outcome: 'not_run', checks: [] },
    note: '',
  };

  // The fix worktree was just created, so it is not yet in `ls`; derive its
  // CommandMate id from the fix branch (the id the CLI would assign it).
  const worktreeId = deriveWorktreeId(plan.profile.repository, fixBranch);
  if (worktreeId === null) {
    fix.worker_state = 'failed';
    fix.note = 'could not derive a valid worktree id for the fix branch';
    return fix;
  }
  fix.task_id = worktreeId;

  // Supervise turn by turn until the fix worker commits its repair (the real
  // completion signal), raises a prompt, times out, fails, or exhausts --max-turns.
  const supervised = superviseFixUntilCommit(inputs, worktreeId, worktreeDir, message);
  fix.dispatched = supervised.dispatched;
  fix.worker_state = supervised.state;
  fix.note = redact(supervised.note);
  if (supervised.state !== 'completed') return fix;

  // Re-verify: worker completion (a new commit) got us here; the profile baseline
  // re-run inside the fix worktree is the separate gate it must clear before it
  // may be re-merged.
  const baseline = runBaseline(plan.profile.baseline, worktreeDir);
  fix.verification = { ran: true, report_schema_version: null, outcome: baseline.outcome, checks: baseline.checks };
  if (baseline.note) fix.note = fix.note ? `${fix.note}; ${redact(baseline.note)}` : redact(baseline.note);
  return fix;
}

// =============================================================================
// Re-merge (guarded: only re-verified fixes are re-merged)
// =============================================================================

function runRemerge(inputs, plan, issues, attemptNo) {
  const remerge = { attempted_issues: issues.slice(), merged_issues: [], outcome: 'skipped', note: '' };
  if (issues.length === 0) {
    remerge.outcome = 'skipped';
    remerge.note = 'no re-verified fix to re-merge';
    return remerge;
  }
  for (const number of issues) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(`${issue.branch ?? `feature/issue-${number}`}-uat-fix-${attemptNo}`);
    if (branch === null) {
      remerge.outcome = 'conflict';
      remerge.note = `#${number}: fix branch rejected by the safe-ref guard`;
      return remerge;
    }
    const merged = runCli(inputs.git, ['merge', '--no-ff', '--no-edit', branch]);
    if (!merged.ok) {
      remerge.outcome = 'conflict';
      remerge.note = redact(`#${number}: re-merge failed (${excerpt(merged.stderr || merged.stdout || 'merge conflict')})`);
      return remerge;
    }
    remerge.merged_issues.push(number);
  }
  remerge.outcome = 'merged';
  remerge.note = `re-merged ${remerge.merged_issues.map((n) => `#${n}`).join(', ')}`;
  return remerge;
}

// =============================================================================
// Report assembly
// =============================================================================

function halt(report, status, stopReason, code, detail) {
  // The first blocking condition wins the status/stop_reason; later ones only
  // add to blocking_reasons.
  if (report.status === 'success') {
    report.status = status;
    report.stop_reason = stopReason;
  }
  report.blocking_reasons.push({ code, detail });
}

function baseReport(inputs, plan, eligible, outDir) {
  return {
    uat_schema_version: UAT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: inputs.phase,
    status: 'success',
    stop_reason: 'completed',
    approved: inputs.approve,
    mutated: false,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    max_attempts: inputs.maxAttempts,
    attempts_used: 0,
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    acceptance: {
      configured: inputs.acceptanceDir !== null,
      required: inputs.requireAcceptance,
      issues_evaluated: 0,
      verdicts: { go: 0, conditional_go: 0, no_go: 0, missing: 0, invalid: 0, mismatched: 0, not_configured: 0 },
    },
    eligible_issues: eligible.slice(),
    preflight: [],
    attempts: [],
    unresolved_issues: [],
    conditional_issues: [],
    blocking_reasons: [],
    limitations: [],
    redactions: [],
    next_actions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

// Append one attempt to the history: push it into the report and append a line
// to attempts/history.jsonl. A prior attempt is never rewritten.
function appendAttempt(report, attempt, historyPath) {
  report.attempts.push(attempt);
  try {
    appendFileSync(historyPath, `${JSON.stringify(attempt)}\n`, 'utf8');
  } catch {
    // A history-logging failure must not change the loop's outcome.
  }
}

// =============================================================================
// Phase: write_uat (read-only assessment, one pass)
// =============================================================================

function runWriteUat(inputs, plan, eligible, outDir, report) {
  const attemptsRoot = join(outDir, 'attempts');
  mkdirSync(attemptsRoot, { recursive: true });
  const historyPath = join(attemptsRoot, 'history.jsonl');

  const uatResults = eligible.map((n) => runUat(inputs, plan, n, issueOf(plan, n).worktree));
  const failing = failingOf(uatResults);
  const conditional = conditionalOf(uatResults);
  const attempt = {
    index: 0,
    kind: 'assess',
    fix_performed: false,
    uat_results: uatResults,
    failing_issues: failing.slice(),
    worktrees: [],
    fixes: [],
    remerge: null,
    advanced: failing.length === 0 && conditional.length === 0,
  };
  appendAttempt(report, attempt, historyPath);

  if (failing.length > 0) {
    report.unresolved_issues = failing.slice();
    halt(report, 'partial', 'uat_failed', 'uat_failed', `UAT failed for ${failing.map((n) => `#${n}`).join(', ')}`);
    report.next_actions.push({
      action: `run --create-uat-fix-worktrees --approve to repair ${failing.map((n) => `#${n}`).join(', ')}`,
      owner: 'operator',
    });
  }
  haltOnConditional(report, uatResults);
}

// A conditional_go is not a defect to repair and not a pass to grant: it is a
// human decision. It never becomes success, it never enters the fix loop, and the
// conditions travel into the report so whoever decides can see them.
function haltOnConditional(report, uatResults) {
  const conditional = [...new Set(conditionalOf(uatResults))];
  if (conditional.length === 0) return;
  const named = conditional.map((n) => `#${n}`).join(', ');
  halt(
    report,
    'partial',
    'acceptance_conditional',
    'acceptance_conditional',
    `acceptance returned conditional_go for ${named}; the conditions are unverified and are not rounded up to pass`,
  );
  report.next_actions.push({
    action: `human decision: review the recorded acceptance conditions for ${named} and accept or reject them`,
    owner: 'human',
  });
}

// =============================================================================
// Phase: fix_uat (bounded fix loop)
// =============================================================================

function runFixLoop(inputs, plan, eligible, outDir, report) {
  const attemptsRoot = join(outDir, 'attempts');
  mkdirSync(attemptsRoot, { recursive: true });
  const historyPath = join(attemptsRoot, 'history.jsonl');

  let target = eligible.slice();
  let fixCount = 0;
  let iteration = 0;
  // Issues held for a human by a conditional_go. They leave `target` at the
  // assessment that found them — the loop must not repair a decision — and are
  // reported once the loop stops, whichever way it stopped.
  const conditionalResults = [];

  // Each issue is assessed in the worktree that currently holds its work: its
  // dispatch worktree initially, and — once a fix re-verifies and re-merges — that
  // fix's worktree, so the next assessment reflects the repair.
  const worktreeOf = new Map(eligible.map((n) => [n, issueOf(plan, n).worktree]));

  while (true) {
    const attemptDir = join(attemptsRoot, `attempt-${iteration}`);
    mkdirSync(attemptDir, { recursive: true });

    // 1. Assess: re-run the profile baseline (the acceptance signal) in each
    //    target's current worktree. Read-only, so it runs in a preview too — the
    //    difference is that a preview never fixes.
    const uatResults = target.map((n) => runUat(inputs, plan, n, worktreeOf.get(n)));
    const failing = failingOf(uatResults);
    const conditional = conditionalOf(uatResults);
    for (const result of uatResults) {
      if (result.verdict === 'conditional') conditionalResults.push(result);
    }

    const attempt = {
      index: iteration,
      kind: 'assess',
      fix_performed: false,
      uat_results: uatResults,
      failing_issues: failing.slice(),
      worktrees: [],
      fixes: [],
      remerge: null,
      advanced: failing.length === 0 && conditional.length === 0,
    };

    // 2. UAT passed for every target → success.
    if (failing.length === 0) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = [];
      break;
    }

    // 3. Preview (no approve): the assessment found failures; report the repair
    //    scope and stop. No worktree, no fix, no re-merge — nothing is mutated.
    if (!inputs.approve) {
      attempt.remerge = { attempted_issues: [], merged_issues: [], outcome: 'not_attempted', note: 'preview: --approve to run the fix loop' };
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'uat_failed', 'uat_failed_preview', `UAT failed for ${failing.map((n) => `#${n}`).join(', ')}; would run the fix loop (preview; --approve to execute)`);
      report.next_actions.push({ action: 're-run with --approve to create fix worktrees and repair', owner: 'operator' });
      break;
    }

    // 4. Cap reached with failures remaining → blocked. The loop never exceeds
    //    max_attempts, and a cap-reached stop is never rounded up to success.
    if (fixCount >= inputs.maxAttempts) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      report.status = 'blocked';
      report.stop_reason = 'max_attempts_reached';
      report.blocking_reasons.push({
        code: 'max_attempts_reached',
        detail: `UAT still failing for ${failing.map((n) => `#${n}`).join(', ')} after ${inputs.maxAttempts} fix attempt(s); stopping as blocked`,
      });
      report.next_actions.push({
        action: `manual triage: the bounded fix loop could not make ${failing.map((n) => `#${n}`).join(', ')} pass UAT within ${inputs.maxAttempts} attempt(s)`,
        owner: 'human',
      });
      break;
    }

    // 5. Perform a fix attempt (mutation, gated above by --approve).
    fixCount += 1;
    attempt.kind = 'fix';
    attempt.fix_performed = true;
    report.mutated = true;

    // 5a. Create a fix worktree per failing issue.
    let hardStop = false;
    for (const number of failing) {
      const wt = createFixWorktree(inputs, plan, number, fixCount);
      attempt.worktrees.push(wt);
      if (!wt.created) {
        halt(report, 'partial', 'worktree_failed', 'worktree_failed', `#${number}: fix worktree could not be created (${wt.note})`);
        hardStop = true;
      }
    }
    if (hardStop) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      break;
    }

    // 5b. Dispatch a fix worker per failing issue, then re-verify (baseline in
    //     the fix worktree). A fix worker that never COMPLETES is a hard stop
    //     (it broke mid-flight); a worker that completes but whose baseline still
    //     fails is a failed attempt that the loop retries until the cap.
    for (const number of failing) {
      const wt = attempt.worktrees.find((w) => w.issue === number);
      const issue = issueOf(plan, number);
      const assessed = attempt.uat_results.find((u) => u.issue === number);
      const failingScenarios = assessed?.scenarios ?? [];
      const promptFile = join(attemptDir, `fix-issue-${number}.md`);
      const message = buildFixPrompt(plan, issue, failingScenarios, assessed?.acceptance ?? null);
      writeFileSync(promptFile, `${message}\n`, 'utf8');
      const fix = dispatchFix(inputs, plan, number, wt.branch, wt.directory, message);
      attempt.fixes.push(fix);
    }
    const brokenWorker = attempt.fixes.find((f) => f.worker_state !== 'completed');
    if (brokenWorker) {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'fix_failed', 'fix_failed', `#${brokenWorker.issue}: fix worker did not complete; stopping before re-merge`);
      report.next_actions.push({ action: `diagnose the fix worktree for #${brokenWorker.issue} and repair manually`, owner: 'operator' });
      break;
    }

    // 5c. Re-merge only the fixes whose baseline re-verified. A fix whose baseline
    //     still fails did not land: it is not merged, and its issue stays failing.
    const reverified = attempt.fixes.filter((f) => f.verification.outcome === 'pass').map((f) => f.issue);
    const remerge = runRemerge(inputs, plan, reverified, fixCount);
    attempt.remerge = remerge;
    if (remerge.outcome === 'conflict') {
      appendAttempt(report, attempt, historyPath);
      report.unresolved_issues = failing.slice();
      halt(report, 'partial', 'remerge_failed', 'remerge_failed', `re-merge failed: ${remerge.note}`);
      report.next_actions.push({ action: 'resolve the re-merge conflict and re-run', owner: 'operator' });
      break;
    }

    // 5d. A re-verified+re-merged issue is now assessed against its fix worktree,
    //     so the next assessment reflects the repair; the rest retry from theirs.
    for (const number of reverified) {
      worktreeOf.set(number, attempt.worktrees.find((w) => w.issue === number).directory);
    }
    appendAttempt(report, attempt, historyPath);
    target = failing.slice();
    iteration += 1;
  }

  report.attempts_used = fixCount;
  // Whichever way the loop stopped, a conditional_go that was found along the way
  // still blocks an unqualified success.
  haltOnConditional(report, conditionalResults);
}

// =============================================================================
// Completion check
// =============================================================================

function buildCompletionCheck(report, inputs) {
  const eligibleSet = new Set(report.eligible_issues);
  const uatTargetsEligible = report.attempts.every((a) => a.uat_results.every((u) => eligibleSet.has(u.issue)));
  const remergeGated = report.attempts.every((a) =>
    (a.remerge?.merged_issues ?? []).every((n) => a.fixes.find((f) => f.issue === n)?.verification.outcome === 'pass'),
  );
  const hasUnresolved = report.unresolved_issues.length > 0;

  // The #1616 honesty invariant, checked rather than asserted: an acceptance
  // verdict that was not `go` never becomes a passing issue, and a run that is
  // still holding a conditional_go for a human is never an unqualified success.
  const allResults = report.attempts.flatMap((a) => a.uat_results);
  const noRoundedAcceptance = allResults.every((result) => !(
    result.verdict === 'pass' && result.acceptance && result.acceptance.state === 'loaded' && result.acceptance.verdict !== 'go'
  ));
  const conditionalHeld = (report.conditional_issues ?? []).length === 0 || report.status !== 'success';

  const checks = [
    {
      id: 'single_phase',
      passed: report.phase === 'write_uat' || report.phase === 'fix_uat',
      detail: `exactly one phase was enabled (${report.phase})`,
    },
    {
      id: 'approval_enforced',
      passed: !report.mutated || report.approved,
      detail: report.mutated ? 'a mutation ran and it was explicitly approved' : 'no mutation ran without --approve',
    },
    {
      id: 'attempts_bounded',
      passed: report.attempts_used <= report.max_attempts,
      detail: `${report.attempts_used} fix attempt(s) used of a ${report.max_attempts} cap`,
    },
    {
      id: 'blocked_reported',
      passed: report.status === 'blocked'
        ? (hasUnresolved && report.stop_reason === 'max_attempts_reached')
        : report.stop_reason !== 'max_attempts_reached',
      detail: report.status === 'blocked'
        ? 'the cap was reached with failures remaining and the status is blocked (not rounded up)'
        : 'the run did not reach the attempt cap',
    },
    {
      id: 'verification_gated',
      passed: uatTargetsEligible && remergeGated,
      detail: 'every UAT target was a verification-passed issue, and every re-merged fix had re-verified',
    },
    {
      id: 'acceptance_not_rounded',
      passed: noRoundedAcceptance && conditionalHeld,
      detail: noRoundedAcceptance && conditionalHeld
        ? 'no issue with a non-go acceptance verdict was reported as passed, and no conditional_go was rounded up to success'
        : 'an acceptance verdict that was not go reached a passing outcome — the composition is wrong',
    },
  ];
  const passed = checks.every((c) => c.passed) && report.status !== 'failure';
  return { passed, checks };
}

// =============================================================================
// Summary
// =============================================================================

function renderSummary(report) {
  const lines = [];
  const phaseLabel = report.phase === 'write_uat' ? 'UAT 実行（assess）' : 'UAT 修正ループ';
  const verb = report.status === 'success' ? '完了'
    : report.status === 'partial' ? '途中停止'
    : report.status === 'blocked' ? '上限到達で停止（blocked）'
    : '未実行';
  lines.push('## 対象と結論');
  lines.push(`${phaseLabel}（${report.approved ? '承認あり' : 'preview'}）を ${report.profile.repository} で実行: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  if (report.status === 'blocked') lines.push(`fix 上限 ${report.max_attempts} 回に到達しても UAT が通らなかったため blocked とした（成功に丸めない）。`);
  if (!report.approved && report.phase === 'fix_uat') lines.push('明示承認（--approve）が無いため mutation はしていない（preview）。');
  lines.push('');
  lines.push('## eligible（verification pass 済み）');
  lines.push(report.eligible_issues.length ? `- ${report.eligible_issues.map((n) => `#${n}`).join(', ')}` : '- なし（verification pass した Issue が無い）。');
  lines.push('');
  lines.push('## 受入判定（機械ゲート + 意味ゲート）');
  if (!report.acceptance.configured) {
    lines.push('- `--acceptance-dir` 無し。baseline（機械ゲート）のみで裁定した。受入条件の意味判定は行っていない。');
  } else {
    const v = report.acceptance.verdicts;
    lines.push(`- acceptance result を ${report.acceptance.issues_evaluated} 件の Issue について読み込んだ（required=${report.acceptance.required}）。`);
    lines.push(`- verdict 内訳: go=${v.go}, conditional_go=${v.conditional_go}, no_go=${v.no_go}, 欠落=${v.missing}, schema 不適合=${v.invalid}, Issue 不一致=${v.mismatched}`);
  }
  if (report.conditional_issues.length > 0) {
    lines.push(`- **conditional_go（human 判断待ち。pass に丸めない）**: ${report.conditional_issues.map((n) => `#${n}`).join(', ')}`);
    for (const result of lastAssessments(report)) {
      if (result.verdict !== 'conditional') continue;
      lines.push(`  - #${result.issue}: ${result.acceptance.verdict_reason}`);
      for (const condition of result.acceptance.conditions) lines.push(`    - 条件: ${condition}`);
    }
  }
  lines.push('');
  lines.push('## attempt 履歴');
  if (report.attempts.length === 0) {
    lines.push('- attempt なし。');
  } else {
    for (const a of report.attempts) {
      const uat = a.uat_results.map((u) => `#${u.issue}=${u.verdict}（baseline ${u.baseline.outcome} / acceptance ${u.acceptance.state === 'loaded' ? u.acceptance.verdict : u.acceptance.state}）`).join(', ') || 'なし';
      const fix = a.fix_performed ? ` / fix=${a.fixes.map((f) => `#${f.issue}:${f.worker_state}/${f.verification.outcome}`).join(', ')}` : '';
      const rem = a.remerge && a.remerge.outcome !== 'not_attempted' ? ` / re-merge=${a.remerge.outcome}` : '';
      lines.push(`- attempt ${a.index} (${a.kind}): UAT ${uat}${fix}${rem}`);
    }
  }
  lines.push('');
  lines.push('## preflight');
  for (const c of report.preflight) lines.push(`- ${c.code}: ${c.ok ? 'ok' : 'NG'}`);
  lines.push('');
  // The unattended section (Issue #142). Printed only when the operator opted in,
  // so a run without `--unattended` reads exactly as it did before the flag
  // existed.
  const unattendedDeclared = report.limitations.find((entry) => entry.code === UNATTENDED_MODE_CODE);
  if (unattendedDeclared) {
    lines.push('## 無人運転（unattended）');
    lines.push(`- 宣言: ${unattendedDeclared.detail}`);
    lines.push('- **`--unattended` は mutation の許可ではない。** 無人で修正ループを回す CI は `--approve` を別に書く。');
    lines.push('- **再merge は cwd の branch に入る。** `git merge --no-ff` は cwd 指定を持たないので、invocation cwd を integration branch に置くこと（pre-flight で検査している）。');
    lines.push('');
  }
  lines.push('## 未解決と next action');
  // A limitation alone is enough to break the "nothing to report" case: a run that
  // lost its acceptance gate must not read as a clean pass in the human summary.
  if (report.unresolved_issues.length === 0 && report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push('- なし。全 eligible が UAT を通過した。');
  } else {
    if (report.unresolved_issues.length > 0) lines.push(`- 未解決（UAT 未通過）: ${report.unresolved_issues.map((n) => `#${n}`).join(', ')}`);
    for (const r of report.blocking_reasons) lines.push(`- blocking: ${r.code} — ${r.detail}`);
    for (const l of report.limitations) lines.push(`- limitation: ${l.code} — ${l.detail}`);
    for (const n of report.next_actions) lines.push(`- next: ${n.action}（owner: ${n.owner}）`);
  }
  return lines.join('\n');
}

// =============================================================================
// Orchestration
// =============================================================================

function runUatPhase(inputs, plan, dispatch, outDir) {
  const eligible = eligibleIssues(plan, dispatch);
  const report = baseReport(inputs, plan, eligible, outDir);
  // Recorded before anything else so it survives every early return below: a run
  // that stopped in the pre-flight still says what it had declared.
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs));
  if (inputs.phase === 'fix_uat') {
    const applied = fixNudgeLimitation(inputs, plan);
    if (applied !== null) report.limitations.push(applied);
  }

  // Read-only preflight before any mutation.
  report.preflight = preflight(inputs, plan);
  const blocked = report.preflight.find((c) => c.blocking && !c.ok);
  if (blocked) {
    halt(report, 'failure', 'preflight_failed', `preflight_${blocked.code}`, blocked.detail);
    report.next_actions.push({ action: 'restore commandmate availability, repo access and base resolution, then re-run', owner: 'operator' });
    finalize(report, inputs);
    return report;
  }

  // Stage C (Issue #142 / ADR section 14.3). Placed here — after the CLI/repo/base
  // probes and before EVERYTHING else — because it is the last read-only question
  // and the first one whose answer decides whether a mutation may be prepared at
  // all. A `fix_uat` run that stops here has created no fix worktree, sent no fix
  // worker and re-merged nothing.
  if (inputs.unattended && inputs.phase === 'fix_uat') {
    const cwdReasons = unattendedCwdReasons(inputs);
    if (cwdReasons.length > 0) {
      for (const reason of cwdReasons) halt(report, 'failure', 'preflight_failed', reason.code, reason.detail);
      report.next_actions.push({
        action: `check out ${inputs.expectBranch} in the directory this runner is invoked from (an attached HEAD on the integration branch), then re-run`,
        owner: 'operator',
      });
      finalize(report, inputs);
      return report;
    }
  }

  if (eligible.length === 0) {
    report.limitations.push({ code: 'no_eligible_issues', detail: 'the dispatch report has no completed-and-verified issue; nothing to UAT' });
    finalize(report, inputs);
    return report;
  }

  if (inputs.phase === 'write_uat') {
    runWriteUat(inputs, plan, eligible, outDir, report);
  } else {
    runFixLoop(inputs, plan, eligible, outDir, report);
  }

  finalize(report, inputs);
  return report;
}

// The last assessment of each issue, in the order the issues were adjudicated.
// The fix loop re-assesses an issue several times; only its final verdict is the
// run's verdict for it.
function lastAssessments(report) {
  const latest = new Map();
  for (const attempt of report.attempts) {
    for (const result of attempt.uat_results) latest.set(result.issue, result);
  }
  return [...latest.values()];
}

// Roll the per-issue acceptance states up into the report, and record the
// degradation as a limitation when the semantic gate was asked for but could not
// be applied. Silence here would read as "acceptance passed", so this is the
// difference between a degraded run and a dishonest one.
function summarizeAcceptance(report) {
  const results = lastAssessments(report);
  report.conditional_issues = results.filter((r) => r.verdict === 'conditional').map((r) => r.issue);
  report.acceptance.issues_evaluated = results.length;
  for (const result of results) {
    const acceptance = result.acceptance;
    const key = acceptance.state === 'loaded' ? acceptance.verdict : acceptance.state;
    if (key in report.acceptance.verdicts) report.acceptance.verdicts[key] += 1;
  }

  const degraded = results.filter(acceptanceDegraded);
  if (degraded.length > 0) {
    report.limitations.push({
      code: 'acceptance_not_run',
      detail: `the acceptance gate did not contribute a verdict for ${degraded.map((r) => `#${r.issue} (${r.acceptance.state})`).join(', ')}; those issues were adjudicated on the baseline alone. Re-run with a conformant acceptance result, or with --require-acceptance to make this a failure.`,
    });
  }
}

function finalize(report, inputs) {
  summarizeAcceptance(report);
  report.completion_check = buildCompletionCheck(report, inputs);
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }
  // A non-success outcome always carries at least one next action, even on a
  // path that did not add a specific one.
  if (report.status !== 'success' && report.next_actions.length === 0) {
    report.next_actions.push({ action: `resolve "${report.stop_reason}" and re-run`, owner: 'operator' });
  }
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report);
}

// =============================================================================
// Failure envelope
// =============================================================================

function uatFailure(error, phase) {
  const report = {
    uat_schema_version: UAT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: phase ?? 'write_uat',
    status: 'failure',
    stop_reason: 'runner_error',
    approved: false,
    mutated: false,
    plan_run_id: 'unknown',
    out_dir: null,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    attempts_used: 0,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    acceptance: {
      configured: false,
      required: false,
      issues_evaluated: 0,
      verdicts: { go: 0, conditional_go: 0, no_go: 0, missing: 0, invalid: 0, mismatched: 0, not_configured: 0 },
    },
    eligible_issues: [],
    preflight: [],
    attempts: [],
    unresolved_issues: [],
    conditional_issues: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    next_actions: [{ action: 'fix the invocation or inputs and re-run', owner: 'operator' }],
    completion_check: { passed: false, checks: [] },
    summary_markdown: `## 対象と結論\nUAT runner 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
  report.completion_check = buildCompletionCheck(report, { phase: report.phase });
  return report;
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
  const plan = validatePlan(loadJson(inputs.planPath, 'plan'));
  const dispatch = validateDispatch(loadJson(inputs.dispatchPath, 'dispatch report'));

  const defaultOut = join(dirname(inputs.dispatchPath), inputs.phase === 'write_uat' ? 'write-uat' : 'uat-fix');
  const outDir = inputs.outDir ?? defaultOut;
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `UAT directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const report = runUatPhase(inputs, plan, dispatch, outDir);
  writeFileSync(join(outDir, 'uat-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'uat-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote UAT artifacts to ${outDir}\n`);
  const exitCode = report.status === 'success' ? 0
    : report.status === 'partial' ? 7
    : report.status === 'blocked' ? 8
    : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  // Recover the phase for the failure envelope even when arg parsing failed.
  const phaseGuess = argv.includes('--create-uat-fix-worktrees') && !argv.includes('--write-uat') ? 'fix_uat' : 'write_uat';
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = uatFailure(error, phaseGuess);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
