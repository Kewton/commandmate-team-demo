#!/usr/bin/env node
// cmate-orchestrate — PR creation, CI confirmation and guarded merge runner
// (Node stdlib only, Node >= 22).
//
// This runner does the *delivery* half of official CommandMate issue
// orchestration. It runs after the dispatch runner (scripts/dispatch.mjs) has
// executed a plan and produced a dispatch report; it takes that report plus the
// approved plan and, for the issues whose worker completed AND whose
// verification passed, performs exactly ONE mutating phase per invocation:
//
//   --create-prs : push each verification-passed branch and open a PR for it.
//   --merge-prs  : discover each PR, confirm its CI, and — only if CI passed —
//                  merge it (a guarded merge).
//
// Two gates are non-negotiable, mirroring the CommandAgent explicit-phase-flag
// design (ADR #1447):
//
//   1. Explicit approval. Without --approve the phase is a no-mutation preview:
//      it reports what it WOULD do (and, for merge, what CI says) but pushes,
//      creates and merges nothing. A PR is never created and a PR is never
//      merged without --approve.
//   2. CI pass. A PR is merged only when its versioned CI checks are all green.
//      A red or still-pending CI blocks the merge; it is never overridden.
//
// A create failure, a red/pending CI, a missing PR, or a merge conflict stops
// the phase and is reported as `partial` with the blocking reason recorded — a
// failure is never rounded up to success. UAT repair (#1456) and issue editing
// are out of scope and are not attempted here.
//
// Every external command is injectable (--gh / --git) so the behavior can be
// exercised against a fake GitHub CLI without a real repository or the network.
// Tokens, secrets, absolute paths and raw terminal output are redacted before
// they reach the report or an artifact.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  extractWorkerDeclarations,
  isFlakyVerdict,
  issueOf,
  loadJson,
  normalizePrTitleTemplate,
  parseConventionalSubject,
  prTitlePlaceholders,
  renderPrTitleTemplate,
  parseCliJson,
  redact,
  redactionsList,
  safeBranch,
  validateDispatch,
  scopeMatches,
} from './lib.mjs';

const MERGE_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];

const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const DEFAULT_MERGE_METHOD = 'squash';

// gh check states, split into the three buckets the CI gate cares about. Any
// state not listed as a pass or a pending is treated as a failure — an unknown
// state must never be read optimistically as green.
const CI_PASS_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CI_PENDING_STATES = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED']);

// =============================================================================
// Unattended — the declaration that nobody is watching this invocation
// (Issue #134 / #142 / references/adr-unattended-mode.md sections 2, 6.5, 8, 9)
// =============================================================================
//
// `--unattended` is an INPUT DECLARATION, not a permission (ADR "裁定 0"). It
// disables no gate, downgrades no blocking reason to a limitation and raises no
// status by one step; what it adds is tightening, and nothing else. In
// particular it does NOT imply `--approve`: a CI that opens PRs with nobody
// watching writes BOTH flags, and `approved: true` keeps meaning "this mutation
// was explicitly approved" rather than "the runner decided it was fine".
//
// Stage B is this runner's `--create-prs` phase only. What it adds over a run
// without the flag is exactly one thing (ADR section 6.5): the
// `change_evidence_unavailable` limitation becomes BLOCKING, because with a
// human reading the report a PR whose body could not show its diff is a
// degradation somebody notices, and with nobody reading it it is a PR created on
// no evidence at all.
//
// `--merge-prs --unattended` is STAGE C (Issue #142). Until stage C it was
// refused with `invalid_input` rather than accepted and ignored, and the refusal
// was not deleted — it was replaced by the stage it named. What stage C adds to
// this phase is the condition ADR section 9 puts on unattended merging: an issue
// the plan cannot show an acceptance-gate block for is not merged with nobody
// watching. Stage A and B reach a PR at the furthest, and a PR is a place a human
// reads; here the furthest point is the base branch, and a misreading of "lint
// and test passed" as "the issue is done" lands there with nobody reading it.
//
// The requirement STOPS the phase rather than shrinking the target set (ADR
// section 9 item 2, same reason as the scope pre-flight in section 3): quietly
// merging the subset that happens to qualify would report success over a run
// that did less than it was asked to. Nothing is merged, including the issues
// that DO qualify — the eligible set is the unit, not the issue.
//
// It applies to `--merge-prs` only. `--create-prs` is stage B, whose one
// tightening is `change_evidence_unavailable`, and adding a second one there
// would change what stage B means after the fact.
//
// No stop was added for `gh`. Issue #115 measured it (ADR section 14.5): `gh pr
// create` / `gh pr merge` decide for themselves that no TTY is present and exit
// non-zero without waiting, which the existing `pr_create_failed` /
// `merge_failed` / `preflight_failed` already receive. What unattended operation
// actually needs there is input hygiene in the JOB definition (`GH_TOKEN` /
// `GIT_TERMINAL_PROMPT=0`, SKILL.md section 3.3) — the runner does not check it,
// for the same reason it does not check the monitor: it cannot guarantee another
// process's environment.
const UNATTENDED_STAGE = 'C（dispatch + merge + uat）';

// =============================================================================
// Integration verification — the wave barrier's missing half (Issue #175)
// =============================================================================
//
// A wave's conflict detection compares `suspected_files`, and its guarded merge
// confirms each PR's own CI. Neither sees the state the merges ADD UP TO. The
// measured case (Kewton/BorderFreeKidsMap #105 x #106, 2026-08-12): one branch
// removed a duplicate from a data file, the other added a test that depended on
// that duplicate existing. File overlap zero, no plan conflict, both PRs' CI
// green — because both CI runs happened on a base that did not yet contain the
// sibling. Eight seconds after the second merge the base branch was red, and
// nobody learned that until the promotion PR's CI ran.
//
// `--integration-verify` is the one stage that closes it: after every merge this
// invocation performed, run the profile baseline ON THE MERGED RESULT. It is
// opt-in and default OFF, so a run without it is byte-identical to a pre-#175
// run (fixture m22).
//
// Three rules the implementation below is shaped by:
//
//   1. WHAT to run comes from the profile, never from this file. No `develop`,
//      no `npm`: the base branch is `plan.profile.base` and the commands are
//      `plan.profile.integration_baseline ?? plan.profile.baseline`
//      (`resolveIntegrationBaseline`, Issue #195 — see the second block below).
//   2. A profile that supplies no command is an ERROR, not a skip, and it is
//      raised BEFORE the first merge (see `resolveIntegrationBaseline`). Opting
//      in and being told "verified" by a stage that never ran is the failure mode
//      this whole issue is about; refusing before anything moves leaves nothing
//      to undo.
//   3. The merged state is measured in a THROWAWAY DETACHED CHECKOUT of the
//      freshly fetched base, never by mutating the invocation's own working
//      tree. `git worktree add --detach` + `git worktree remove --force` is the
//      whole of it — no branch, no CommandMate registration, no baseline-as-
//      acceptance — so this is not the worker-worktree preparation path that
//      adr-worktree-preparation.md routes through `cmate-worktree-setup`.
const INTEGRATION_TREE_DIRNAME = 'integration-tree';

// =============================================================================
// Which verification set this runs — `integration_baseline` (Issue #195)
// =============================================================================
//
// #175 ran `plan.profile.baseline`, and that was one key doing two jobs with
// different purposes, so one of the two was always wrong:
//
//   `baseline`              every worker runs it inside its own worktree, as a
//                           PROPORTIONAL health check of that worker's change.
//                           Making it heavy makes every dispatch run a build.
//   `integration_baseline`  run ONCE after the merges. It is the repository's
//                           definition of "green", so it is the place the heavy
//                           build / unit / e2e set belongs.
//
// The measured consequence (Kewton/BorderFreeKidsMap, the same repository whose
// #105 x #106 produced #175): its `baseline` is `npm ci` / lint / typecheck by a
// documented decision — "a worker's health check should be proportional; leave
// the heavy build to the final verify" — and carries no unit step. So
// `--integration-verify` ran lint and typecheck on the merged base and reported
// `outcome: "pass"`, while `npm run test:unit` — the command that actually goes
// red on #105 x #106 — was in neither list. The feature let the very event it
// was built to remove pass through it green.
//
// The resolution is `integration_baseline ?? baseline`, and the `??` is the
// whole of the compatibility story: a profile that does not declare the field
// runs exactly what #175 ran, so no existing profile changes behaviour.
//
// A DECLARED empty array is NOT the fallback case. `"integration_baseline": []`
// is a repository saying "there is no integration verification here", and
// answering that with `baseline` would re-create the confusion above by another
// route — silently, in the one profile that took the trouble to be explicit. So
// the fallback keys off the key's PRESENCE (`!== undefined`), not on the list
// being empty, and a declared-but-empty list lands on the same fail-closed
// refusal as a profile with no commands at all: `preflight_failed` / exit 1 /
// `integration_verify_unavailable`, before the first merge.
//
// WHICH ONE WAS TAKEN IS RECORDED (`integration_verify.source`). Without it the
// split is a silent second baseline: two runs of the same command can measure
// two different sets and the reports read identically.
const INTEGRATION_BASELINE_FIELD = 'integration_baseline';
const BASELINE_FIELD = 'baseline';

// The red verdict, and the two ways the verification can fail to happen at all.
// `integration_verify_failed` is the one the next wave's dispatch reads
// (references/merge-contract.md section 5.4): the barrier is not satisfied.
const INTEGRATION_VERIFY_FAILED_CODE = 'integration_verify_failed';
const INTEGRATION_VERIFY_UNAVAILABLE_CODE = 'integration_verify_unavailable';
const INTEGRATION_VERIFY_NOT_RUN_CODE = 'integration_verify_not_run';
const INTEGRATION_TREE_LEFT_CODE = 'integration_verify_tree_left';

// =============================================================================
// Redaction (SkillError, the pattern list and redact/redactionsList are shared
// with the dispatch and uat runners in lib.mjs)
// =============================================================================

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a failure. NOT shared
// with dispatch: an empty excerpt is `''` here and `null` there.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || '';
  return `…${text.slice(text.length - limit)}`;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate merge runner (PR creation / CI confirmation / guarded merge)

Usage:
  merge.mjs --plan <path> --dispatch <path> (--create-prs | --merge-prs) [options]

Exactly one mutating phase is enabled per invocation:
  --create-prs           Push each verification-passed branch and open a PR.
                         The title follows the plan profile's pr_title_template
                         when it declares one (type/scope from the branch's
                         commit subjects; undetermined -> that PR is not
                         opened), and the worker's commit-message declarations
                         are transcribed into the body.
  --merge-prs            Confirm each PR's CI and, if green, merge it (guarded).

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --dispatch <path>      dispatch-report.json from the dispatch runner (required);
                         its completed+verified workers are the only eligible issues.
  --approve              Explicit approval to actually mutate. WITHOUT it the phase
                         is a no-mutation preview: nothing is pushed, created or merged.
  --unattended           Declare that NO HUMAN is watching this invocation (CI /
                         cron). It grants nothing: it does NOT imply --approve, it
                         disables no gate and it never turns a blocking reason into
                         a limitation. What it adds is tightening, per phase:
                         --create-prs  the change_evidence_unavailable limitation
                                       becomes blocking, so a PR whose body could
                                       not show what the branch changed is not
                                       opened at all;
                         --merge-prs   every eligible issue must carry an
                                       acceptance-gate block AND acceptance
                                       criteria. One that does not stops the
                                       phase — nothing is merged, and the target
                                       set is never quietly shrunk instead.
  --integration-verify   --merge-prs only, default OFF. After every merge this
                         invocation performed, run the profile's verification set
                         on the MERGED result: fetch the base branch, check it out
                         into a throwaway detached worktree and run
                         plan.profile.integration_baseline ?? .baseline there —
                         the fallback fires for an ABSENT integration_baseline
                         only, and which one ran is recorded in
                         integration_verify.source. A red result is recorded as
                         integration_verify_failed and the run is not a success,
                         so the next wave is not dispatched. Nothing is merged at
                         all when the resolved set has no command (no baseline, or
                         an integration_baseline declared empty) — an opt-in
                         verification that cannot run is refused, not skipped.
  --merge-method <m>     merge | squash | rebase for --merge-prs (default ${DEFAULT_MERGE_METHOD}).
  --out <dir>            Where merge artifacts are written
                         (default: <dispatch-dir>/<phase>).
  --gh <path>            The gh CLI to drive (default "gh").
  --git <path>           The git CLI used for push and the base preflight (default "git").
  --help                 Show this help.

Two gates always hold: a PR is neither created nor merged without --approve, and a
PR is merged only when its CI is green. Failures stop the phase and are reported as
partial — never rounded up to success.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        dispatch: { type: 'string' },
        'create-prs': { type: 'boolean' },
        'merge-prs': { type: 'boolean' },
        approve: { type: 'boolean' },
        unattended: { type: 'boolean' },
        'integration-verify': { type: 'boolean' },
        'merge-method': { type: 'string' },
        out: { type: 'string' },
        gh: { type: 'string' },
        git: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function resolveInputs(parsed) {
  const { values } = parsed;

  // Exactly one mutating phase — the core of the explicit-phase-flag design.
  // Both or neither is a hard input error, never a silent default.
  const phases = [];
  if (values['create-prs']) phases.push('create_prs');
  if (values['merge-prs']) phases.push('merge_prs');
  if (phases.length !== 1) {
    throw new SkillError(
      'invalid_input',
      'exactly one mutating phase must be enabled: pass either --create-prs or --merge-prs (not both, not neither)',
      3,
    );
  }

  // Stage C accepts `--unattended` for BOTH phases (Issue #142 / ADR section 8).
  // The stage-B refusal of `--merge-prs --unattended` was not removed as a
  // refusal — it was replaced by the stage it named, which is the discipline the
  // refusal existed for: an invocation that declared something this runner cannot
  // honour must not have that declaration silently dropped, because the reader of
  // the report — in unattended operation the next CI job, not a person — cannot
  // tell that it was. What each phase's declaration now implies is enforced
  // below, in `unattendedAcceptanceReasons` and `recordEvidenceFindings`.
  //
  // A relaxing flag of the dispatch runner (`--auto-yes`, `--allow-questions`,
  // `--contract-mode off`) is refused one step earlier, by parseArgs: this runner
  // has no such option, and an unknown option is already `invalid_input`. That is
  // the same exit 3 with the same meaning, so nothing is re-implemented here.

  if (!values.plan) throw new SkillError('invalid_input', '--plan <path> is required', 3);
  if (!values.dispatch) throw new SkillError('invalid_input', '--dispatch <path> is required', 3);

  // `--integration-verify` belongs to the merge phase alone (Issue #175): the
  // thing it measures is the state the merges add up to, and `--create-prs`
  // merges nothing. Refused rather than accepted-and-ignored, for the same
  // reason the stage-B runner refused `--merge-prs --unattended`: an invocation
  // whose declaration this runner cannot honour must not have it silently
  // dropped, because the reader of the report cannot tell that it was.
  if (values['integration-verify'] && phases[0] !== 'merge_prs') {
    throw new SkillError(
      'invalid_input',
      '--integration-verify verifies the state the merges add up to, so it is accepted with --merge-prs only (--create-prs merges nothing)',
      3,
    );
  }

  const method = values['merge-method'] ?? DEFAULT_MERGE_METHOD;
  if (!MERGE_METHODS.has(method)) {
    throw new SkillError('invalid_input', `--merge-method must be one of merge|squash|rebase`, 3);
  }

  return {
    phase: phases[0],
    planPath: values.plan,
    dispatchPath: values.dispatch,
    approve: Boolean(values.approve),
    unattended: Boolean(values.unattended),
    integrationVerify: Boolean(values['integration-verify']),
    mergeMethod: method,
    outDir: values.out ?? null,
    gh: values.gh ?? 'gh',
    git: values.git ?? 'git',
  };
}

// =============================================================================
// Plan / dispatch-report loading (loadJson and validateDispatch are shared with
// the uat runner in lib.mjs)
// =============================================================================

// Only the fields this runner reads are asserted; a wrong or tampered file is
// refused rather than half-executed. NOT shared with dispatch, which additionally
// enforces max_parallel and the per-wave width bound before it dispatches.
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
  // CommandMate#3005. Checked here, before anything is probed, because a plan
  // can reach this runner without having passed the planner's loader
  // (profile-contract.md §13): the same rule, reported against the plan file.
  normalizePrTitleTemplate(profile.pr_title_template, 'plan.profile.pr_title_template', 'plan_invalid', 3);
  return plan;
}

// The eligible set is the whole point of the verification gate reaching this
// runner: an issue is acted on ONLY when its worker completed AND its
// verification passed. Anything less is never turned into a PR or a merge.
function eligibleIssues(plan, dispatch) {
  const passed = new Set();
  for (const wave of dispatch.waves) {
    for (const worker of wave.workers ?? []) {
      if (worker.worker_state === 'completed' && worker.verification && worker.verification.outcome === 'pass') {
        passed.add(worker.issue);
      }
    }
  }
  // Process in the plan's merge order so PRs/merges respect dependency order.
  const order = Array.isArray(plan.merge_order) ? plan.merge_order : [];
  const ordered = order.filter((n) => passed.has(n));
  // Any passed issue not in merge_order (shouldn't happen) is appended stably.
  for (const n of [...passed].sort((a, b) => a - b)) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  return ordered;
}

// =============================================================================
// Safety (issueOf and safeBranch are shared in lib.mjs)
// =============================================================================

// gh pr create --base wants a branch name, while a profile base is a tracking
// ref like "origin/develop". Strip a single leading remote segment.
function baseBranchName(base) {
  return base.replace(/^[A-Za-z0-9._-]+\//, '');
}

// =============================================================================
// CLI invocation
// =============================================================================

// One structured call to an external CLI. Never throws: a non-zero exit or a
// missing binary comes back as { ok: false } so the caller decides what it means.
// `extra` is spread into execFileSync (as in dispatch/uat) so the change-evidence
// probe can run `git diff` INSIDE an issue's worktree; a cwd that no longer
// exists surfaces as { ok: false }, which the caller reports rather than hides.
function runCli(bin, args, extra = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      ...extra,
    });
    // `stderr: ''` on success is execFileSync's API, not a decision: it returns
    // stdout ALONE. Nothing here reads a CLI's stderr on a zero exit — this
    // runner parses stdout JSON and `git` output — so there is nothing to lose.
    // Where it DID matter (dispatch's async twin dropping the `GATE` lines that
    // `wait --verify` prints to stderr) the fix was to keep stderr there, #160.
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

// =============================================================================
// Preflight (read-only; mirrors dispatch's drift re-check, scoped to delivery)
// =============================================================================

function preflight(inputs, plan) {
  const checks = [];
  const add = (code, ok, detail) => checks.push({ code, ok, blocking: true, detail });

  const gh = runCli(inputs.gh, ['--version']);
  add('cli_available', gh.ok, gh.ok ? 'gh CLI is runnable' : 'gh CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves`);

  return checks;
}

// =============================================================================
// Verification evidence (Issue #97)
// =============================================================================
//
// The PR body is the only place most reviewers ever look. Until #97 its
// Verification section was one sentence — "dispatched and verified against the
// profile baseline" — that read identically whatever had actually happened: the
// gates that judged the branch, their verdicts and their exit codes were sitting
// in the dispatch report this runner already loads, and never reached a human.
// Nor did the other half of the question a reviewer asks: the issue declared how
// far it was allowed to reach (`scope.allow`), so what did the branch actually
// touch?
//
// Everything below is TRANSCRIBED, never asserted. Values come from a file this
// runner did not write (the dispatch report) or from a subprocess (`git diff`),
// so each one goes through redact() on the way in — an upstream document is not
// assumed to have been redacted already. When a value cannot be read, the body
// says so; "we could not measure this" is never rendered as a pass.

// gh rejects a pull-request body over 65536 characters. A worker with a long gate
// list must not push `Resolves #n` out of the body — or fail the create outright
// — so every transcribed list is capped. The cap is always STATED in the body:
// a silently shortened evidence list reads as complete evidence, which is exactly
// the failure this whole section exists to remove.
const PR_BODY_LIMIT = 65536;
const MAX_BODY_GATES = 30;
const MAX_BODY_CHECKS = 15;
const MAX_BODY_PATHS = 50;
const MAX_BODY_CELL = 200;

function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${redact(String(item))}`).join('\n');
}

// One markdown table cell: redacted, flattened to a single line, `|` escaped so a
// transcribed value cannot forge a column, and bounded so one long line cannot
// dominate the body.
function cell(value, limit = MAX_BODY_CELL) {
  const text = redact(String(value)).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  if (text === '') return '(empty)';
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

// Split a list into what the body shows and how many it had to drop.
function capped(items, max) {
  const list = Array.isArray(items) ? items : [];
  return { shown: list.slice(0, max), dropped: Math.max(0, list.length - max) };
}

function droppedNote(dropped, what) {
  return `_Not listed here: ${dropped} further ${what}. The list was cut to keep this body under GitHub's ${PR_BODY_LIMIT}-character limit._`;
}

// The worker record the dispatch report holds for this issue. The LAST one wins:
// an issue re-dispatched in a later wave appears more than once, and the newest
// verdict is the one that judged the branch being delivered.
function workerRecordOf(dispatch, number) {
  let found = null;
  for (const wave of dispatch.waves ?? []) {
    for (const worker of wave.workers ?? []) {
      if (worker && worker.issue === number) found = worker;
    }
  }
  return found;
}

// The exit code a recorded line carries — `… → exit 20 (…)`, `gate lint: failed
// (exit 2)`. Null when the line names none, which is rendered as "—" rather than
// filled in with a plausible zero.
function exitCodeOf(text) {
  const match = /\bexit\s+(-?\d+)\b/.exec(String(text));
  return match ? match[1] : null;
}

// The exit code recorded for ONE gate, when a check line is about that gate.
// dispatch writes those lines as `gate <id>: <status> (exit <n>)`.
function gateExitCode(checks, gateId) {
  for (const check of Array.isArray(checks) ? checks : []) {
    const text = String(check);
    if (!text.toLowerCase().startsWith(`gate ${gateId.toLowerCase()}:`)) continue;
    const code = exitCodeOf(text);
    if (code !== null) return code;
  }
  return null;
}

// The verdict half of the evidence: what judged this issue, and how it ruled.
function verificationLines(worker) {
  const lines = [];
  const verification = worker && worker.verification ? worker.verification : null;
  if (verification === null) {
    lines.push(
      'The dispatch report holds **no verification record for this issue**, so this PR carries no evidence that anything judged it. Do not read this as a pass.',
    );
    return lines;
  }

  lines.push('Transcribed from the dispatch report for this issue — the verdict that actually judged this branch, not a statement of intent.');
  lines.push('');
  lines.push(`- Verdict: **${cell(verification.outcome ?? 'unknown')}**`);
  if (verification.ran === false) {
    lines.push(
      '- **The verification did not run** (`ran: false`): no gate and no command was executed for this issue, so the verdict above is not backed by a run. Treat this branch as unverified.',
    );
  }

  const gates = capped(verification.gates, MAX_BODY_GATES);
  if (gates.shown.length === 0) {
    lines.push('- Gates: **none recorded** — the run named no gate, so the checks below are all this verdict can point at.');
  } else {
    lines.push('');
    lines.push('**Gates**');
    lines.push('');
    lines.push('| Gate | Verdict | Exit |');
    lines.push('| --- | --- | --- |');
    for (const gate of gates.shown) {
      const id = cell(gate && gate.id != null ? gate.id : 'unknown');
      const verdict = cell(gate && gate.verdict != null ? gate.verdict : 'unknown');
      lines.push(`| ${id} | ${verdict} | ${gateExitCode(verification.checks, id) ?? '—'} |`);
    }
    if (gates.dropped > 0) {
      lines.push('');
      lines.push(droppedNote(gates.dropped, 'gate(s)'));
    }
    // A FLAKY row is the one line in this table a reviewer must not read as a
    // rounding of PASS or FAIL, so it is explained where it appears (Issue #224).
    // The explanation deliberately does NOT say what the run counted it as: the
    // Verdict line above is the run's exit code and it already answered that.
    // Re-deriving it here from the word would get `flakyIsPass` wrong in both
    // directions, since the declaration that decides it is not in this report.
    if (gates.shown.some((gate) => gate && isFlakyVerdict(gate.verdict))) {
      lines.push('');
      lines.push('_**FLAKY** means the gate failed and then passed on a re-run against the same tree (CommandMate #1772). It is neither a pass nor a failure on its own: whether the run counted it as one is the gate\'s own `flakyIsPass` declaration, and the result is already in the **Verdict** line above._');
    }
  }

  const checks = capped(verification.checks, MAX_BODY_CHECKS);
  lines.push('');
  lines.push('**Checks**');
  lines.push('');
  if (checks.shown.length === 0) {
    lines.push('_The run recorded no check line._');
  } else {
    lines.push('| # | Check (as recorded) | Exit |');
    lines.push('| --- | --- | --- |');
    checks.shown.forEach((check, index) => {
      lines.push(`| ${index + 1} | ${cell(check)} | ${exitCodeOf(check) ?? '—'} |`);
    });
    if (checks.dropped > 0) {
      lines.push('');
      lines.push(droppedNote(checks.dropped, 'check(s)'));
    }
  }
  return lines;
}

// The scope the plan declared for this issue. `suspected_files` is exactly what
// the dispatch runner turns into the execution contract's `scope.allow`, so this
// is the permission the worker was actually given — reported, not re-derived.
function declaredScope(issue) {
  const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
  const cleaned = files
    .filter((file) => typeof file === 'string' && file.trim() !== '')
    .map((file) => redact(file.trim()));
  return [...new Set(cleaned)].sort();
}

// Is a changed path inside one declared scope entry? `scopeMatches` is the port
// of CommandMate's `globToRegExp` (lib.mjs, Issue #219). It replaced a local
// three-line version that honoured `*` and `**` and NOTHING else: a directory
// entry (`src/lib`, how people write a directory), `?`, and `{a,b}` all read as
// literals here while the gate upstream honoured them, so this table called an
// in-scope change a violation — the one thing this comparison must not get
// wrong, since it is the human-readable half of `requireScopeClean`.
function inDeclaredScope(scope, path) {
  return scope.some((pattern) => scopeMatches(pattern, path));
}

// `git diff --numstat` is parsed rather than `--shortstat`: the numeric form is
// machine-readable and locale-independent. A binary file reports `-` for both
// counts and is counted as a file without inventing line numbers for it.
//
// Read with `-z`, like the name list below and for the same reason (Issue #174):
// only the counts are used today, but a `--numstat` read without `-z` carries
// MUNGED pathnames, and the next reader to reach for the third column would
// reintroduce the mismatch this issue was about. `-z` terminates each record with
// NUL instead of a newline; a rename records `<added>\t<deleted>\t` followed by
// the two pathnames as their own NUL-terminated records, which have no counts and
// are therefore skipped by the same `parts.length < 3` guard.
function parseNumstat(stdout) {
  let files = 0;
  let added = 0;
  let deleted = 0;
  let binary = 0;
  for (const line of String(stdout).split('\0')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    if (parts[0] === '-' || parts[1] === '-') {
      binary += 1;
      continue;
    }
    added += Number.parseInt(parts[0], 10) || 0;
    deleted += Number.parseInt(parts[1], 10) || 0;
  }
  return { files, added, deleted, binary };
}

// What the branch ACTUALLY changed, read from the issue's own worktree. Read-only
// and never fatal: a worktree that has already been cleaned up makes the evidence
// unavailable, which is reported as unavailable — never as "nothing changed" and
// never as "the branch stayed in scope".
function changeEvidence(inputs, plan, issue) {
  const branch = safeBranch(issue.branch);
  const worktree = typeof issue.worktree === 'string' && issue.worktree !== '' ? issue.worktree : null;
  const range = branch === null ? null : `${plan.profile.base}...${branch}`;
  if (branch === null || worktree === null) {
    return { ok: false, range, reason: 'the plan names no worktree or no safe branch for this issue', files: [], stat: null };
  }

  // `-z`, NOT the default newline form (Issue #174). git does not print the
  // pathname it holds: it C-quotes anything it deems unsafe — every byte >= 0x80
  // as a three-digit octal escape inside double quotes while `core.quotePath` is
  // true (git's default), and `"`, `\` and control characters whatever that is
  // set to. `scope.allow` holds the path as the issue wrote it, so comparing the
  // two forms made a file that IS in scope read as out of scope, and the body
  // listed the same file twice under two spellings. `-c core.quotePath=false`
  // would only cover the non-ASCII half; `-z` turns the munging off outright and
  // takes the newline out of the record separator, so a path containing one can
  // no longer be split into two paths that do not exist.
  const names = runCli(inputs.git, ['diff', '--name-only', '-z', range], { cwd: worktree });
  if (!names.ok) {
    return {
      ok: false,
      range,
      reason: excerpt(names.stderr || names.stdout || 'git diff --name-only failed', 200) || 'git diff --name-only failed',
      files: [],
      stat: null,
    };
  }
  // The WHOLE change set, not the part the body has room for: the out-of-scope
  // count is computed from this list, and counting only the first page of it
  // would report a clean branch that is not one. Capping happens at render time.
  // Not trimmed: with `-z` the record IS the pathname, and a leading or trailing
  // space in it is part of the name rather than layout to tidy away.
  const files = names.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => redact(path));

  const numstat = runCli(inputs.git, ['diff', '--numstat', '-z', range], { cwd: worktree });
  const stat = numstat.ok ? parseNumstat(numstat.stdout) : null;
  return { ok: true, range, reason: '', files, stat };
}

// The scope half of the evidence: what the issue was allowed to touch, beside what
// the branch touched, so a reviewer can see the out-of-scope count without
// re-running the diff themselves.
function scopeLines(issue, change) {
  const scope = declaredScope(issue);
  const lines = ['**Declared scope vs. actual changes**', ''];

  if (!change.ok) {
    lines.push(
      `The branch's actual change set could NOT be read (\`git diff --name-only -z ${change.range ?? '<range>'}\`: ${cell(change.reason)}), so this section cannot show what changed. **This is not evidence that the branch stayed in scope.**`,
    );
    lines.push('');
    lines.push(`- Declared scope (\`scope.allow\`, ${scope.length} entr${scope.length === 1 ? 'y' : 'ies'}):`);
    const listed = capped(scope, MAX_BODY_PATHS);
    if (listed.shown.length === 0) lines.push('  - (the plan declares no target file for this issue)');
    for (const path of listed.shown) lines.push(`  - \`${cell(path)}\``);
    if (listed.dropped > 0) lines.push('', droppedNote(listed.dropped, 'scope entr(y/ies)'));
    return lines;
  }

  const outOfScope = change.files.filter((path) => !inDeclaredScope(scope, path));
  const stat = change.stat;
  const total = change.files.length;

  // The command is quoted WITH `-z`: this table lists pathnames as they are, and
  // the newline-separated form of the same command prints some of them escaped
  // (Issue #174). A reviewer who reruns what is written here gets what is here.
  lines.push(`Declared scope (\`scope.allow\`, from the plan's target files) against \`git diff --name-only -z ${change.range}\`, run in this issue's worktree.`);
  lines.push('');
  if (outOfScope.length === 0) {
    lines.push(`- Out-of-scope changes: **0** — every one of the ${total} changed file(s) is inside the declared scope.`);
  } else {
    // The COUNT is over the whole change set; only the naming is bounded, and a
    // bounded naming says how many it did not name.
    const named = capped(outOfScope, MAX_BODY_PATHS);
    const suffix = named.dropped > 0 ? ` (+${named.dropped} more not listed here)` : '';
    lines.push(`- Out-of-scope changes: **${outOfScope.length}** — changed but NOT declared: ${named.shown.map((path) => `\`${cell(path)}\``).join(', ')}${suffix}.`);
  }
  lines.push(
    stat === null
      ? `- Diff size: **${total} file(s) changed** (line counts unavailable: \`git diff --numstat -z\` did not answer).`
      : `- Diff size: **${stat.files} file(s) changed, +${stat.added} / -${stat.deleted} line(s)**${stat.binary > 0 ? ` (${stat.binary} binary file(s) counted without line numbers)` : ''}.`,
  );
  lines.push('');

  const rows = capped([...new Set([...scope, ...change.files])].sort(), MAX_BODY_PATHS);
  if (rows.shown.length === 0) {
    lines.push('_The plan declares no target file and the branch changed none._');
    return lines;
  }
  lines.push('| Path | Declared (`scope.allow`) | Changed |');
  lines.push('| --- | --- | --- |');
  for (const path of rows.shown) {
    lines.push(`| \`${cell(path)}\` | ${inDeclaredScope(scope, path) ? 'yes' : '**no**'} | ${change.files.includes(path) ? 'yes' : 'no'} |`);
  }
  if (rows.dropped > 0) {
    lines.push('');
    lines.push(droppedNote(rows.dropped, 'path(s)'));
  }
  return lines;
}

// =============================================================================
// PR body (plan + the run's measured evidence)
// =============================================================================

// Last-resort guard. Every list above is capped, but a plan with a very long
// objective or acceptance-criteria list could still exceed what gh accepts.
// Truncating beats a create that fails — but a truncated body must SAY it was
// truncated, so the marker is part of the truncation, not an optional extra.
function fitPrBody(body) {
  if (body.length <= PR_BODY_LIMIT) return body;
  const marker = `\n\n_This body was truncated to fit GitHub's ${PR_BODY_LIMIT}-character limit; the complete evidence is in the run's merge artifacts._\n`;
  let head = body.slice(0, PR_BODY_LIMIT - marker.length);
  // Never end on half of a surrogate pair: an emoji cut down the middle would be
  // written out as a replacement character.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${marker}`;
}

// =============================================================================
// The branch's commits: PR title and worker declarations (CommandMate#3005)
// =============================================================================
//
// ONE read-only `git log` per issue, run in the issue's worktree beside the
// `git diff` above, answers both halves of #3005:
//
//   - the Conventional-Commits TYPE and SCOPE a `pr_title_template` asks for.
//     They come from the commit subjects because that is where this repository's
//     own convention is already enforced on the worker (its commit rules, its
//     hooks), and because a squash merge REPLACES those commits with the PR
//     title — the title is the commit subject's successor, so it inherits its
//     type and scope. Issue labels were the alternative and were rejected: a
//     label vocabulary (`enhancement`, `bug`) is not the type vocabulary, and a
//     mapping between them would be a second convention this runner invented.
//   - the worker's declarations of what it reinterpreted or decided, which a
//     reviewer must see before merging and which otherwise lived only in the
//     worker's final chat report — a place this runner never reads.
//
// A merge commit is skipped (`--no-merges`): a base merged INTO the branch is
// not the worker's statement about its change.
const MAX_DECLARATIONS = 20;
const MAX_DECLARATION_TEXT = 500;
const DECLARATIONS_UNREAD_CODE = 'worker_declarations_unread';
const DECLARATIONS_TRANSCRIBED_CODE = 'worker_declarations_transcribed';
const PR_TITLE_UNDETERMINED_CODE = 'pr_title_undetermined';

function branchCommits(inputs, plan, issue) {
  const branch = safeBranch(issue.branch);
  const worktree = typeof issue.worktree === 'string' && issue.worktree !== '' ? issue.worktree : null;
  const range = branch === null ? null : `${plan.profile.base}..${branch}`;
  if (branch === null || worktree === null) {
    return { ok: false, range, reason: 'the plan names no worktree or no safe branch for this issue', commits: [] };
  }
  // %x1f / %x1e: a unit and a record separator no commit message contains, so a
  // body holding blank lines or `---` cannot be split into two commits.
  const result = runCli(inputs.git, ['log', '--no-merges', '--format=%s%x1f%b%x1e', range], { cwd: worktree });
  if (!result.ok) {
    return { ok: false, range, reason: excerpt(result.stderr || result.stdout || 'git log failed', 200) || 'git log failed', commits: [] };
  }
  const commits = result.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [subject, body = ''] = record.split('\x1f');
      return { subject: subject.trim(), body };
    })
    // git log prints newest first; a reader of the declarations reads the
    // branch in the order it was written.
    .reverse();
  return { ok: true, range, reason: '', commits };
}

// The declarations as the PR body will carry them, or `{ ok: false }` when the
// log could not be read — which the body states, rather than showing no section
// and letting "nothing declared" and "never read" look alike.
function workerDeclarations(commits) {
  if (!commits.ok) return { ok: false, reason: commits.reason, range: commits.range, entries: [], dropped: 0 };
  const all = commits.commits.flatMap((commit) => extractWorkerDeclarations(commit.body));
  const entries = all.slice(0, MAX_DECLARATIONS).map((entry) => {
    const text = redact(entry.text);
    return { label: entry.label, text: text.length > MAX_DECLARATION_TEXT ? `${text.slice(0, MAX_DECLARATION_TEXT - 1)}…` : text };
  });
  return { ok: true, reason: '', range: commits.range, entries, dropped: all.length - entries.length };
}

// No section at all when the worker declared nothing: the body of a branch
// without declarations is the body this runner wrote before #3005.
function declarationLines(declarations) {
  if (!declarations) return [];
  if (!declarations.ok) {
    return [
      '## ワーカーの申告',
      `The branch's commit messages could NOT be read (\`git log ${declarations.range ?? '<range>'}\`: ${cell(declarations.reason)}), `
        + 'so any reinterpretation or decision the worker declared there is not shown here. **This is not evidence that it declared none.**',
      '',
    ];
  }
  if (declarations.entries.length === 0) return [];
  const lines = [
    '## ワーカーの申告',
    'Transcribed verbatim from the worker\'s commit message body (lines opening with 読み替え / 判断 / 本文に無い指摘). '
      + 'A declaration is the worker\'s own statement, not a measurement: read it before merging.',
    '',
    ...declarations.entries.map((entry) => `- ${entry.label}: ${entry.text.replace(/\s+/g, ' ')}`),
  ];
  if (declarations.dropped > 0) lines.push('', droppedNote(declarations.dropped, 'declaration(s)'));
  lines.push('');
  return lines;
}

function recordDeclarationFindings(report, number, declarations) {
  if (!declarations.ok) {
    report.limitations.push({
      code: DECLARATIONS_UNREAD_CODE,
      detail: `#${number}: the branch's commit messages could not be read (${redact(declarations.reason)}); the PR body says the worker's declarations are unread rather than showing none`,
    });
    return;
  }
  if (declarations.entries.length === 0) return;
  const total = declarations.entries.length + declarations.dropped;
  report.limitations.push({
    code: DECLARATIONS_TRANSCRIBED_CODE,
    detail: `#${number}: the worker declared ${total} reinterpretation(s)/decision(s) in its commit message (${[...new Set(declarations.entries.map((entry) => entry.label))].join(', ')}); `
      + 'they are transcribed into the PR body under 「ワーカーの申告」. Transcribed is not reviewed: read them before merging',
  });
}

// The title `gh pr create` receives. Without `pr_title_template` it is the issue
// title, byte for byte what this runner sent before #3005. With one, every
// placeholder it uses must be DETERMINED; a value this runner would have to guess
// is refused, because a guessed type is a PR the repository's title check either
// rejects (visible, but after a push) or — worse — accepts under the wrong type.
function resolvePrTitle(plan, issue, commits) {
  const issueTitle = issue.title ?? `Resolve issue #${issue.number}`;
  const template = plan.profile.pr_title_template;
  if (template === undefined) return { ok: true, templated: false, title: redact(issueTitle), reason: '' };
  const used = new Set(prTitlePlaceholders(template));
  const values = { title: issueTitle, number: String(issue.number) };
  const undetermined = (reason) => ({ ok: false, templated: true, title: null, reason });
  if (used.has('type') || used.has('scope')) {
    if (!commits.ok) return undetermined(`the branch's commits could not be read (${redact(commits.reason)})`);
    if (commits.commits.length === 0) return undetermined(`the branch carries no commit over ${plan.profile.base}`);
    const parsed = commits.commits.map((commit) => ({ subject: commit.subject, cc: parseConventionalSubject(commit.subject) }));
    const loose = parsed.find((entry) => entry.cc === null);
    if (loose) return undetermined(`the commit subject "${cell(loose.subject)}" is not in Conventional-Commits form (\`type(scope): description\`)`);
    if (used.has('type')) {
      const types = [...new Set(parsed.map((entry) => entry.cc.type))];
      if (types.length > 1) return undetermined(`the branch's commits disagree on the type (${types.join(', ')})`);
      values.type = types[0];
    }
    if (used.has('scope')) {
      const unscoped = parsed.find((entry) => entry.cc.scope === null);
      if (unscoped) return undetermined(`the commit subject "${cell(unscoped.subject)}" declares no scope, and the template asks for {{scope}}`);
      const scopes = [...new Set(parsed.map((entry) => entry.cc.scope))];
      if (scopes.length > 1) return undetermined(`the branch's commits disagree on the scope (${scopes.map((scope) => cell(scope)).join(', ')})`);
      values.scope = scopes[0];
    }
  }
  return { ok: true, templated: true, title: redact(renderPrTitleTemplate(template, values)).trim(), reason: '' };
}

function buildPrBody(plan, issue, autoCloseNote, evidence) {
  const lines = [
    `## Summary`,
    redact(issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`),
    '',
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'See the issue.'),
    '',
    '## Verification',
    ...verificationLines(evidence.worker),
    '',
    ...scopeLines(issue, evidence.change),
    '',
    ...declarationLines(evidence.declarations),
    `Resolves #${issue.number}.`,
  ];
  if (autoCloseNote) lines.push('', autoCloseNote);
  return fitPrBody(lines.join('\n'));
}

// =============================================================================
// Issue auto-close reachability (Issue #39)
// =============================================================================

// GitHub only honors a closing keyword (`Resolves #n`) when the PR merges into
// the repository's DEFAULT branch. A profile base is free to be anything —
// `origin/develop` in a feature → develop → stg → main flow — and in that case
// the keyword this runner writes is inert: the PR merges and the issue stays
// open. That is not a defect this runner can fix (auto-closing an issue on the
// operator's behalf is out of scope by product policy), so it is recorded.
const AUTOCLOSE_LIMITATION_CODE = 'issue_autoclose_not_default_branch';

// One read-only `gh repo view` for the repository's default branch. Returns null
// when the query fails or the field is absent — a null skips the comparison
// entirely rather than guessing, so a gh outage never blocks the merge flow.
function defaultBranchOf(inputs, plan) {
  const result = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'defaultBranchRef']);
  const parsed = parseCliJson(result);
  const name = parsed && parsed.defaultBranchRef ? parsed.defaultBranchRef.name : null;
  return typeof name === 'string' && name !== '' ? name : null;
}

// Records the limitation when the PR base is not the default branch, and returns
// the note to append to each PR body (null when nothing is wrong or unknown).
function checkIssueAutoClose(inputs, plan, report) {
  const base = baseBranchName(plan.profile.base);
  const defaultBranch = defaultBranchOf(inputs, plan);
  if (defaultBranch === null) return null; // unknown: skip the comparison
  if (defaultBranch === base) return null; // merging into the default branch: the keyword works

  const detail =
    `PR base is "${base}" but the default branch of ${plan.profile.repository} is "${defaultBranch}"; ` +
    'GitHub only auto-closes on a merge into the default branch, so `Resolves #n` in these PR bodies ' +
    'will not close the issues. Close them manually after the merge.';
  report.limitations.push({ code: AUTOCLOSE_LIMITATION_CODE, detail });
  return (
    `> Note: this PR targets \`${base}\`, which is not the default branch (\`${defaultBranch}\`). ` +
    'GitHub will not auto-close the issue above on merge — close it manually.'
  );
}

// =============================================================================
// CI evaluation
// =============================================================================

// Reduce gh's per-check states to a single verdict. Green requires at least one
// check and every check in the pass bucket; any failure state fails; otherwise
// (a pending check, or no checks at all) it is pending — never green by default.
function evaluateCi(checks) {
  const normalized = (Array.isArray(checks) ? checks : []).map((c) => ({
    name: redact(String(c && c.name != null ? c.name : 'check')),
    state: String(c && c.state != null ? c.state : 'UNKNOWN').toUpperCase(),
  }));
  const failed = normalized.filter((c) => !CI_PASS_STATES.has(c.state) && !CI_PENDING_STATES.has(c.state));
  const pending = normalized.filter((c) => CI_PENDING_STATES.has(c.state));
  const passedCount = normalized.filter((c) => CI_PASS_STATES.has(c.state)).length;

  let verdict;
  if (normalized.length === 0) verdict = 'pending'; // no checks proven → not green
  else if (failed.length > 0) verdict = 'failed';
  else if (pending.length > 0) verdict = 'pending';
  else verdict = 'passed';

  const summary = normalized.length === 0
    ? 'no checks reported'
    : `${passedCount} passed, ${failed.length} failed, ${pending.length} pending`;
  return { verdict, summary, checks: normalized };
}

// =============================================================================
// gh/git operations
// =============================================================================

function pushBranch(inputs, branch) {
  const result = runCli(inputs.git, ['push', '--set-upstream', 'origin', branch]);
  return { ok: result.ok, note: result.ok ? '' : excerpt(result.stderr || result.stdout || 'push failed') };
}

function createPr(inputs, plan, title, branch, bodyFile) {
  const result = runCli(inputs.gh, [
    'pr', 'create',
    '--repo', plan.profile.repository,
    '--base', baseBranchName(plan.profile.base),
    '--head', branch,
    '--title', title,
    '--body-file', bodyFile,
  ]);
  if (!result.ok) {
    return { ok: false, number: null, url: null, note: excerpt(result.stderr || result.stdout || 'pr create failed') };
  }
  const url = (result.stdout.match(/https?:\/\/\S+/) ?? [null])[0];
  const number = url ? Number((url.match(/\/pull\/(\d+)/) ?? [null, null])[1]) || null : null;
  return { ok: true, number, url: url ? redact(url) : null, note: '' };
}

function viewPr(inputs, plan, branch) {
  const result = runCli(inputs.gh, ['pr', 'view', branch, '--repo', plan.profile.repository, '--json', 'number,url,state']);
  const payload = parseCliJson(result);
  if (!payload || typeof payload.number !== 'number') {
    return { found: false, number: null, url: null, state: null, note: excerpt(result.stderr || 'no PR for branch') };
  }
  return {
    found: true,
    number: payload.number,
    url: typeof payload.url === 'string' ? redact(payload.url) : null,
    state: typeof payload.state === 'string' ? payload.state.toUpperCase() : 'UNKNOWN',
    note: '',
  };
}

function prChecks(inputs, plan, number) {
  const result = runCli(inputs.gh, ['pr', 'checks', String(number), '--repo', plan.profile.repository, '--json', 'name,state']);
  const payload = parseCliJson(result);
  if (payload === null) {
    // A non-JSON / failed checks call is treated as "not proven green".
    return { verdict: 'pending', summary: excerpt(result.stderr || 'checks unavailable') || 'checks unavailable', checks: [] };
  }
  return evaluateCi(payload);
}

function mergePr(inputs, plan, number, method) {
  const result = runCli(inputs.gh, ['pr', 'merge', String(number), '--repo', plan.profile.repository, `--${method}`]);
  return { ok: result.ok, note: result.ok ? '' : excerpt(result.stderr || result.stdout || 'merge failed') };
}

// =============================================================================
// Target factory
// =============================================================================

function newTarget(issue, branch, action) {
  return {
    issue,
    branch,
    eligible: true,
    action,
    pr_number: null,
    pr_url: null,
    pushed: false,
    pr_created: false,
    ci_checked: false,
    ci_passed: false,
    ci_summary: 'not checked',
    ci_checks: [],
    merge_attempted: false,
    merged: false,
    outcome: 'skipped',
    note: '',
  };
}

// =============================================================================
// Phases
// =============================================================================

// What the PR body says about the evidence, said again in the report — the two
// must never disagree. Neither of these stops the phase (the verification gate
// already ran upstream and passed); they are the "did not stop it, but you need
// to know" channel, so a reviewer who reads only merge-report.json still sees
// that a body could not show its diff, or showed a change outside the scope the
// plan declared.
const EVIDENCE_UNAVAILABLE_CODE = 'change_evidence_unavailable';
const SCOPE_EXCEEDED_CODE = 'branch_changed_outside_declared_scope';

// =============================================================================
// Stage C: what an unattended `--merge-prs` requires of its issues
// (Issue #142 / references/adr-unattended-mode.md sections 8, 9)
// =============================================================================
//
// ADR section 9's condition 2, taken as a REQUIREMENT rather than a possibility:
// an issue whose plan record carries no acceptance-gate block, or no acceptance
// criteria at all, is not merged with nobody watching. Both readings are of the
// PLAN — the document a human approved — and neither is re-derived here:
//
//   - `acceptance_gates` is the transcription of the issue body's
//     ```acceptance-gates block (Issue #114, #100 stage 1). Null means the body
//     carried no block, or carried one the planner refused to read; the plan
//     tells the two apart with an open question, not with this field, and for
//     this gate they are the same finding — no machine condition was declared.
//     EITHER half counts (Issue #125): `require` names existing gates that must
//     judge the issue, `gates` DEFINES new ones the contract carries. A block
//     that only defines is not a weaker declaration than one that only selects —
//     it is the issue writing a condition that did not exist before.
//   - an empty `acceptance_criteria` is exactly what makes the planner raise
//     `no_acceptance_criteria`, so the code the report carries is that same one:
//     the operator's action is identical (write it in the issue and re-plan) and
//     the status runner's hint for it already says so.
//
// The check is deliberately shallow. Whether the required ids EXIST is the
// dispatch runner's question (it holds the worktree; `acceptance_gate_id_unknown`
// is its answer), and re-asking it here would be a second, worse opinion about a
// worktree that may already be gone.
const ACCEPTANCE_GATES_REQUIRED_CODE = 'acceptance_gates_required';
const NO_ACCEPTANCE_CRITERIA_CODE = 'no_acceptance_criteria';

function hasAcceptanceGateBlock(issue) {
  const declared = issue.acceptance_gates;
  if (declared === null || declared === undefined) return false;
  if (typeof declared !== 'object' || Array.isArray(declared)) return false;
  if (declared.version !== 1) return false;
  const selects = Array.isArray(declared.require) && declared.require.some((id) => typeof id === 'string' && id.trim() !== '');
  const defines = Array.isArray(declared.gates) && declared.gates.some((gate) => gate !== null && typeof gate === 'object' && typeof gate.id === 'string' && gate.id.trim() !== '');
  return selects || defines;
}

function hasAcceptanceCriteria(issue) {
  return Array.isArray(issue.acceptance_criteria)
    && issue.acceptance_criteria.some((line) => typeof line === 'string' && line.trim() !== '');
}

// Every reason the whole eligible set fails the stage-C condition — every one,
// not the first: the operator has to edit the issues and re-plan, and a list
// that stops at the first one turns that into as many round trips as there are
// issues. Empty means the phase may proceed.
function unattendedAcceptanceReasons(plan, eligible) {
  const reasons = [];
  for (const number of eligible) {
    const issue = issueOf(plan, number) ?? {};
    if (!hasAcceptanceGateBlock(issue)) {
      reasons.push({
        code: ACCEPTANCE_GATES_REQUIRED_CODE,
        detail: `#${number}: the plan records no acceptance-gate block for this issue, so no machine-checkable acceptance condition was ever declared for it. `
          + 'Under --unattended --merge-prs the base branch moves with nobody reading the result, and "lint and test passed" is not "the issue is done": '
          + 'add an ```acceptance-gates block naming the gate id(s) that must judge it and re-plan. '
          + 'The issue is NOT excluded from the target set — nothing was merged, including the issues that do carry one',
      });
    }
    if (!hasAcceptanceCriteria(issue)) {
      reasons.push({
        code: NO_ACCEPTANCE_CRITERIA_CODE,
        detail: `#${number}: the plan read no acceptance criteria out of this issue (the planner's no_acceptance_criteria finding), so the issue never stated what "done" means. `
          + 'Under --unattended --merge-prs that is refused rather than merged: write 1-3 concrete completion checks in the issue body and re-plan',
      });
    }
  }
  return reasons;
}

// Returns the blocking detail when the phase must stop here, null otherwise.
//
// Under `--unattended` the FIRST finding stops the phase (ADR section 6.5, stage
// B of section 8): "the change set could not be read" is a degradation a human
// reading the report can absorb — they open the branch and look — and with
// nobody reading it, it is a PR opened on no evidence at all. Promoting it is
// the whole of what stage B adds, and it is a promotion, never a relaxation.
//
// The SECOND finding is NOT promoted, deliberately. The contract gate
// `requireScopeClean` has already judged the same question upstream, and
// `--unattended` makes the contract path mandatory on the dispatch side, so a
// branch that reaches this runner with changes outside its declared scope has
// already been ruled on by a machine; this limitation is the human-readable copy
// of that ruling (ADR section 6.5, last paragraph).
function recordEvidenceFindings(inputs, report, number, issue, evidence) {
  if (!evidence.change.ok) {
    if (inputs.unattended) {
      return `#${number}: the branch's actual change set could not be read (${redact(evidence.change.reason)}); `
        + 'under --unattended no PR is opened for it, because the body would have to say it cannot show what changed and '
        + 'nobody is here to read that sentence';
    }
    report.limitations.push({
      code: EVIDENCE_UNAVAILABLE_CODE,
      detail: `#${number}: the branch's actual change set could not be read (${redact(evidence.change.reason)}); the PR body reports it as unread rather than claiming the change stayed in scope`,
    });
    return null;
  }
  const scope = declaredScope(issue);
  const outOfScope = evidence.change.files.filter((path) => !inDeclaredScope(scope, path));
  if (outOfScope.length > 0) {
    report.limitations.push({
      code: SCOPE_EXCEEDED_CODE,
      detail: `#${number}: ${outOfScope.length} changed file(s) are outside the scope the plan declared for this issue (${outOfScope.slice(0, 10).map((path) => redact(path)).join(', ')}); the PR body names them`,
    });
  }
  return null;
}

function runCreatePrs(inputs, plan, dispatch, eligible, outDir, report) {
  const bodyDir = join(outDir, 'pr-bodies');
  mkdirSync(bodyDir, { recursive: true });

  // Read-only, once per invocation — not once per issue.
  const autoCloseNote = checkIssueAutoClose(inputs, plan, report);

  let stopped = false;
  for (const number of eligible) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(issue.branch);
    const target = newTarget(number, branch ?? String(issue.branch ?? ''), 'create_pr');

    if (stopped) {
      target.note = 'not reached: a prior PR creation failed and stopped the phase';
      report.targets.push(target);
      continue;
    }
    if (branch === null) {
      target.outcome = 'pr_failed';
      target.note = 'branch name rejected by the safe-ref guard';
      report.limitations.push({ code: 'unsafe_branch', detail: `#${number}: branch rejected by safe-ref guard` });
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'unsafe_branch', `#${number}: unsafe branch name`);
      stopped = true;
      continue;
    }

    // The measured half of the PR body (Issue #97). Both probes are read-only and
    // neither can stop the phase: what they cannot read is reported as unread.
    const evidence = { worker: workerRecordOf(dispatch, number), change: changeEvidence(inputs, plan, issue) };
    const evidenceBlocked = recordEvidenceFindings(inputs, report, number, issue, evidence);
    if (evidenceBlocked !== null) {
      // Before the body is written and before anything is pushed: an unattended
      // run that cannot show the diff does not open the PR, so it does not leave
      // a body for a PR it refused to open either.
      target.outcome = 'pr_failed';
      target.note = 'unattended: the branch change set could not be read, so no PR was opened (its body would carry no evidence)';
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', EVIDENCE_UNAVAILABLE_CODE, evidenceBlocked);
      stopped = true;
      continue;
    }

    // CommandMate#3005: the title and the declarations, from one read of the
    // branch's commits. The title is decided BEFORE the body is written and
    // before anything is pushed, preview included — a preview that shows a PR
    // this runner would then refuse to open is a preview of nothing.
    const commits = branchCommits(inputs, plan, issue);
    const titled = resolvePrTitle(plan, issue, commits);
    if (!titled.ok) {
      const detail = `#${number}: profile pr_title_template ${JSON.stringify(plan.profile.pr_title_template)} cannot be filled — ${titled.reason}. `
        + 'No branch was pushed and no PR was opened: a guessed type or scope is a title the repository\'s check rejects, or accepts under the wrong type. '
        + 'Reword the commit subject(s) on the branch to `type(scope): description` and re-run --create-prs';
      target.outcome = 'pr_failed';
      target.note = redact(`PR title undetermined: ${titled.reason}`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', PR_TITLE_UNDETERMINED_CODE, redact(detail));
      stopped = true;
      continue;
    }
    evidence.declarations = workerDeclarations(commits);
    recordDeclarationFindings(report, number, evidence.declarations);

    const bodyFile = join(bodyDir, `issue-${number}.md`);
    writeFileSync(bodyFile, `${buildPrBody(plan, issue, autoCloseNote, evidence)}\n`, 'utf8');
    // Named in the note only when a template produced it, so the note of a run
    // without the field is the note it always was.
    const titledAs = titled.templated ? ` titled "${titled.title}"` : '';

    if (!inputs.approve) {
      target.outcome = 'previewed';
      target.note = `would push ${branch} and open a PR${titledAs} onto ${baseBranchName(plan.profile.base)} (preview; --approve to execute)`;
      report.targets.push(target);
      continue;
    }

    // Approved: push then open the PR. Either mutation counts as `mutated`.
    report.mutated = true;
    const pushed = pushBranch(inputs, branch);
    target.pushed = pushed.ok;
    if (!pushed.ok) {
      target.outcome = 'pr_failed';
      target.note = redact(`branch push failed: ${pushed.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'push_failed', `#${number}: branch push failed`);
      stopped = true;
      continue;
    }

    const created = createPr(inputs, plan, titled.title, branch, bodyFile);
    if (!created.ok) {
      target.outcome = 'pr_failed';
      target.note = redact(`pr create failed: ${created.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_create_failed', 'pr_create_failed', `#${number}: gh pr create failed`);
      stopped = true;
      continue;
    }
    target.pr_created = true;
    target.pr_number = created.number;
    target.pr_url = created.url;
    target.outcome = 'pr_created';
    target.note = `${created.number ? `opened PR #${created.number}` : 'opened PR (number not parsed)'}${titledAs}`;
    report.targets.push(target);
  }
}

function runMergePrs(inputs, plan, eligible, report) {
  let stopped = false;
  for (const number of eligible) {
    const issue = issueOf(plan, number);
    const branch = safeBranch(issue.branch);
    const target = newTarget(number, branch ?? String(issue.branch ?? ''), 'merge_pr');

    if (stopped) {
      target.note = 'not reached: a prior target blocked the phase';
      report.targets.push(target);
      continue;
    }
    if (branch === null) {
      target.outcome = 'pr_missing';
      target.note = 'branch name rejected by the safe-ref guard';
      report.limitations.push({ code: 'unsafe_branch', detail: `#${number}: branch rejected by safe-ref guard` });
      report.targets.push(target);
      halt(report, 'partial', 'pr_missing', 'unsafe_branch', `#${number}: unsafe branch name`);
      stopped = true;
      continue;
    }

    // 1. Discover the PR (read-only).
    const pr = viewPr(inputs, plan, branch);
    if (!pr.found) {
      target.outcome = 'pr_missing';
      target.note = redact(`no open PR for ${branch}; run --create-prs first (${pr.note})`);
      report.targets.push(target);
      halt(report, 'partial', 'pr_missing', 'pr_missing', `#${number}: no PR to merge`);
      stopped = true;
      continue;
    }
    target.pr_number = pr.number;
    target.pr_url = pr.url;

    if (pr.state === 'MERGED') {
      target.merged = true;
      target.outcome = 'already_merged';
      target.note = `PR #${pr.number} is already merged`;
      report.targets.push(target);
      continue;
    }
    if (pr.state !== 'OPEN') {
      target.outcome = 'pr_closed';
      target.note = `PR #${pr.number} is ${pr.state}, not open; refusing to act`;
      report.targets.push(target);
      halt(report, 'partial', 'pr_closed', 'pr_closed', `#${number}: PR #${pr.number} is ${pr.state}`);
      stopped = true;
      continue;
    }

    // 2. Confirm CI (read-only). This is the second, independent gate.
    const ci = prChecks(inputs, plan, pr.number);
    target.ci_checked = true;
    target.ci_summary = ci.summary || 'no checks reported';
    target.ci_checks = ci.checks;
    target.ci_passed = ci.verdict === 'passed';

    if (ci.verdict !== 'passed') {
      target.outcome = ci.verdict === 'failed' ? 'ci_failed' : 'ci_pending';
      target.note = `CI is ${ci.verdict} (${ci.summary}); merge refused`;
      report.targets.push(target);
      halt(report, 'partial', ci.verdict === 'failed' ? 'ci_failed' : 'ci_pending', target.outcome, `#${number}: CI ${ci.verdict}, not merging`);
      stopped = true;
      continue;
    }

    // 3. Merge only with both gates satisfied: CI green AND explicit approval.
    if (!inputs.approve) {
      target.outcome = 'previewed';
      target.note = `CI green; would merge PR #${pr.number} via ${inputs.mergeMethod} (preview; --approve to execute)`;
      report.targets.push(target);
      continue;
    }

    report.mutated = true;
    target.merge_attempted = true;
    const merged = mergePr(inputs, plan, pr.number, inputs.mergeMethod);
    if (!merged.ok) {
      target.outcome = 'merge_failed';
      target.note = redact(`merge failed (conflict or protection): ${merged.note}`);
      report.targets.push(target);
      halt(report, 'partial', 'merge_failed', 'merge_failed', `#${number}: PR #${pr.number} merge failed`);
      stopped = true;
      continue;
    }
    target.merged = true;
    target.outcome = 'merged';
    target.note = `merged PR #${pr.number} via ${inputs.mergeMethod}`;
    report.targets.push(target);
  }
}

// =============================================================================
// Integration verification (Issue #175; which set it runs, Issue #195)
// =============================================================================

// WHICH profile field supplies the post-merge verification, and the commands it
// declares — cleaned and in the profile's order.
//
// `integration_baseline` when the profile DECLARES it (Issue #195), `baseline`
// otherwise. Presence decides, so a declared `[]` selects `integration_baseline`
// with no commands, which is the fail-closed refusal and never a fallback; see
// the block above `INTEGRATION_BASELINE_FIELD`. `null` is not accepted by the
// planner (orchestrate.mjs normalizeIntegrationBaseline), and a hand-written plan
// that carries one is read here as a declaration with nothing runnable in it —
// the same fail-closed side.
//
// An empty result means no command can be run, which under `--integration-verify`
// is refused before the first merge rather than skipped (rule 2 at the top of
// this file, and the same reading the dispatch runner's fallback verification
// takes: "profile has no baseline to verify against" is a fail there too).
function resolveIntegrationBaseline(plan) {
  const profile = plan.profile ?? {};
  const declared = profile[INTEGRATION_BASELINE_FIELD] !== undefined;
  const source = declared ? INTEGRATION_BASELINE_FIELD : BASELINE_FIELD;
  const raw = declared ? profile[INTEGRATION_BASELINE_FIELD] : profile[BASELINE_FIELD];
  const commands = (Array.isArray(raw) ? raw : [])
    .filter((command) => typeof command === 'string' && command.trim() !== '')
    .map((command) => command.trim());
  return { source, commands };
}

// The prose name of the set, for the report's own sentences: a run that cannot
// say WHICH list it measured is the "silent second baseline" this Issue is about.
function integrationSetLabel(source) {
  return `profile ${source}`;
}

function newIntegrationVerify(plan) {
  const resolved = resolveIntegrationBaseline(plan);
  return {
    requested: true,
    ran: false,
    outcome: 'not_run',
    base: plan.profile.base,
    base_sha: null,
    merged_issues: [],
    // The field the commands below came from (Issue #195). Recorded even on the
    // paths that never run anything: "which set would have been measured" is
    // what tells a refusal for a declared-empty `integration_baseline` apart
    // from a refusal for a profile with no `baseline` at all, and the two have
    // opposite next actions.
    source: resolved.source,
    // Transcribed through redact() like every other value this report carries
    // from a document the runner did not write.
    commands: resolved.commands.map((command) => redact(command)),
    failed_command: null,
    exit_code: null,
    detail: 'not run: the invocation had not reached the merge phase',
  };
}

// The verification could not be performed at all. It is NOT a pass: the merges
// already landed, so a run that cannot measure the result must not report one.
function integrationUnavailable(report, detail) {
  report.integration_verify.outcome = 'not_run';
  report.integration_verify.detail = detail;
  halt(report, 'partial', 'merge_failed', INTEGRATION_VERIFY_UNAVAILABLE_CODE, detail);
}

// Run after the merge loop, over whatever this invocation actually merged.
//
// The base branch is re-read from the remote (`git fetch origin <branch>`) and
// materialised as `FETCH_HEAD` rather than as the profile's base ref: FETCH_HEAD
// is exactly what origin holds for that branch right now — after the merges this
// invocation just made — whereas a local `develop` or a stale `origin/develop`
// is the state whose green-ness every PR's own CI already claimed.
function runIntegrationVerify(inputs, plan, outDir, report) {
  const iv = report.integration_verify;
  const merged = report.targets.filter((target) => target.merge_attempted && target.merged).map((target) => target.issue);
  iv.merged_issues = merged;

  if (merged.length === 0) {
    // A preview, an already-merged set, or a phase that stopped before its first
    // merge: the base branch did not move, so there is no merged state to judge.
    // Recorded as a limitation because nothing about this run is unsafe — but
    // recorded, because `outcome: not_run` must never be read as green.
    iv.detail = 'not run: this invocation merged no PR, so the base branch did not move and there is no merged state to judge';
    report.limitations.push({
      code: INTEGRATION_VERIFY_NOT_RUN_CODE,
      detail: '--integration-verify was requested but this invocation merged no PR (preview, nothing eligible, or the phase stopped before the first merge), '
        + 'so the integration branch was not verified. This is "not measured", not "green"',
    });
    return;
  }

  const baseBranch = baseBranchName(plan.profile.base);
  const fetched = runCli(inputs.git, ['fetch', 'origin', baseBranch]);
  if (!fetched.ok) {
    integrationUnavailable(
      report,
      `the merged state of ${baseBranch} could not be fetched (${excerpt(fetched.stderr || fetched.stdout || 'git fetch failed', 200) || 'git fetch failed'}), `
        + `so PR(s) for ${merged.map((n) => `#${n}`).join(', ')} were merged and the result was NOT verified`,
    );
    return;
  }

  const head = runCli(inputs.git, ['rev-parse', '--verify', 'FETCH_HEAD']);
  if (!head.ok) {
    integrationUnavailable(
      report,
      `the fetched tip of ${baseBranch} could not be resolved (${excerpt(head.stderr || 'git rev-parse --verify FETCH_HEAD failed', 200) || 'git rev-parse --verify FETCH_HEAD failed'}), `
        + 'so the merged state was NOT verified',
    );
    return;
  }
  iv.base_sha = head.stdout.trim().slice(0, 7) || null;

  // A throwaway detached checkout, inside the run's own output directory. The
  // invocation's working tree is never touched: whatever branch the operator (or
  // the CI job) has checked out is theirs, and a verification that moved it
  // would be a mutation nobody approved.
  const treeDir = join(outDir, INTEGRATION_TREE_DIRNAME);
  const added = runCli(inputs.git, ['worktree', 'add', '--detach', treeDir, 'FETCH_HEAD']);
  if (!added.ok) {
    integrationUnavailable(
      report,
      `the merged ${baseBranch} could not be checked out for verification (${excerpt(added.stderr || added.stdout || 'git worktree add failed', 200) || 'git worktree add failed'}), `
        + 'so the merged state was NOT verified',
    );
    return;
  }

  iv.ran = true;
  // Re-resolved rather than read back from `iv.commands`: what runs must be the
  // profile's own text, and the record is a redacted transcription of it.
  const { source, commands } = resolveIntegrationBaseline(plan);
  let failure = null;
  for (const command of commands) {
    const argv = command.split(/\s+/).filter(Boolean);
    if (argv.length === 0) continue;
    const result = runCli(argv[0], argv.slice(1), { cwd: treeDir });
    if (!result.ok) {
      failure = { command, status: result.status, note: excerpt(result.stderr || result.stdout || 'baseline step failed', 200) };
      break;
    }
  }

  // Removal is best effort and never changes the verdict, but a checkout left
  // behind is said out loud: a git worktree nobody knows about is a surprise the
  // next `git worktree add` reports instead of this run.
  const removed = runCli(inputs.git, ['worktree', 'remove', '--force', treeDir]);
  // Recorded in BOTH directions (Issue #222). Until now only the failure spoke —
  // `integration_verify_tree_left` — and a successful cleanup was silent, so
  // "the checkout was removed" and "this runner is too old to say" were the same
  // report. The key exists exactly when `ran` is true, i.e. exactly when there
  // was a throwaway checkout to remove.
  iv.tree_removed = removed.ok;
  if (!removed.ok) {
    report.limitations.push({
      code: INTEGRATION_TREE_LEFT_CODE,
      detail: `the throwaway checkout used for the integration verification could not be removed (${excerpt(removed.stderr || removed.stdout || 'git worktree remove failed', 200) || 'git worktree remove failed'}); `
        + `it is the ${INTEGRATION_TREE_DIRNAME} directory under this run's merge output — remove it with \`git worktree remove --force\``,
    });
  }

  const where = `${baseBranch}${iv.base_sha === null ? '' : ` at ${iv.base_sha}`}`;
  const set = integrationSetLabel(source);
  if (failure === null) {
    iv.outcome = 'pass';
    iv.detail = `every one of the ${commands.length} ${set} command(s) exited 0 on the merged ${where} `
      + `(the state after merging ${merged.map((n) => `#${n}`).join(', ')})`;
    return;
  }

  iv.outcome = 'fail';
  iv.failed_command = redact(failure.command);
  iv.exit_code = Number.isInteger(failure.status) ? failure.status : null;
  iv.detail = `the ${set} is RED on the merged ${where}: \`${redact(failure.command)}\` exited `
    + `${iv.exit_code === null ? 'non-zero' : iv.exit_code} (${failure.note})`;
  halt(
    report,
    'partial',
    'merge_failed',
    INTEGRATION_VERIFY_FAILED_CODE,
    `${iv.detail}. The PR(s) for ${merged.map((n) => `#${n}`).join(', ')} are already merged and each one's own CI was green on a base that did not yet contain the others, `
      + 'so this is the semantic conflict their file sets could not show. Do not dispatch the next wave on this base',
  );
}

// =============================================================================
// The caller's index.lock — named, never removed (Issue #222)
// =============================================================================
//
// Measured twice in one day (CommandMate#1836, in Kewton/BorderFreeKidsMap): a
// `--merge-prs --approve --integration-verify` run finished `status: success` /
// `integration_verify.outcome: pass`, and the operator's next `git pull
// --ff-only` in the INVOCATION's own worktree died on
//
//     error: Unable to create '.../.git/worktrees/<name>/index.lock': File exists.
//
// The dangerous part is not the stale lock — it is 0 bytes, it had been sitting
// there for ~40 and ~52 minutes, `pgrep -fl 'git '` matched nothing, and deleting
// it by hand recovered both times. The dangerous part is that it READS AS "the
// merge broke". The merges had landed and the merged base had been verified
// green, so an operator who rolls back at that point breaks the repository a
// SECOND time, on top of a run that did everything right.
//
// The upstream report guessed that the integration verification's throwaway
// checkout was holding the caller's index and proposed switching it to `git
// worktree add --detach`. That is already what runs (see the block above
// INTEGRATION_TREE_DIRNAME, and `runIntegrationVerify`), and the git verbs this
// whole file invokes are `fetch` / `rev-parse` / `worktree add|remove` / `diff` /
// `push`: no `checkout`, `merge`, `reset`, `read-tree`, `stash`, `pull` or
// `update-index` anywhere, so no path here writes the caller's index. `runCli`
// passes neither `timeout` nor `killSignal` to execFileSync, so it cannot SIGKILL
// a git either — and a git that is merely SIGTERM'd removes its own lock. The
// cause is therefore NOT in this runner, and the honest thing to add is not a fix
// but a MEASUREMENT.
//
// So this probes, and names what it saw:
//
//   * in the invocation's own cwd, before anything else runs and again
//     immediately before the report is written;
//   * `caller_index_lock_pre_existing` when a lock was already there. It is a
//     limitation and never a stop: this runner does not use the caller's index,
//     so a lock somebody else holds is no reason to refuse to merge;
//   * `caller_index_lock_appeared` when there was none at the start and there is
//     one at the end. Also only a limitation, for the reason at the top: the
//     merges landed and the verification ran, and turning that into a failure is
//     exactly the misreading this block exists to prevent.
//
// **Nothing here deletes anything.** A lock file is how git says "an index is
// being written right now"; removing another process's lock corrupts the index it
// was protecting. The recovery — read `integration_verify.outcome` and `merged`
// FIRST, then check `pgrep -fl 'git '`, then delete by hand only if the size is 0
// and nothing is running — belongs to a human and is written down in
// references/codes-and-recovery.md.
const CALLER_INDEX_LOCK_PRE_EXISTING_CODE = 'caller_index_lock_pre_existing';
const CALLER_INDEX_LOCK_APPEARED_CODE = 'caller_index_lock_appeared';

// WHERE the caller's index.lock would be. Asked of git rather than assembled
// here, because `.git` is a FILE in a linked worktree and the real lock lives in
// `<main>/.git/worktrees/<name>/index.lock` — which is precisely the path the
// measured failure printed. A git that cannot answer (not a repository, git
// missing) yields null, and then both probes record null: "we could not look" is
// never rendered as "there was no lock", it is rendered as nothing at all.
function resolveCallerIndexLock(inputs) {
  const probe = runCli(inputs.git, ['rev-parse', '--git-path', 'index.lock']);
  if (!probe.ok) return null;
  const printed = probe.stdout.split('\n')[0].trim();
  if (printed === '') return null;
  return resolve(process.cwd(), printed);
}

// One `stat`, rendered for the report; null means "not there", which is the
// ordinary case. Which of the two codes it earns is decided by the caller — this
// function knows nothing about before and after.
//
// The path is recorded RELATIVE to the invocation cwd, because contract section 7
// says no absolute path reaches a report or an artifact. That costs the reader
// nothing: the recovery is run from that same cwd, so `.git/index.lock` — or
// `../<repo>/.git/worktrees/<name>/index.lock` for a linked worktree — is
// directly usable, and it carries no user name. redact() still runs over the
// result as a backstop, so a path that somehow cannot be relativised degrades to
// `[REDACTED-PATH]` rather than leaking.
function statCallerIndexLock(path) {
  if (path === null) return null;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  const rel = relative(process.cwd(), path);
  return {
    path: redact(rel === '' || isAbsolute(rel) ? path : rel),
    size: stats.size,
    mtime: new Date(stats.mtimeMs).toISOString(),
  };
}

// The opening probe. Returns the resolved path so the closing probe stats the
// SAME file rather than asking git a second time: the answer cannot have changed,
// and re-asking would make "appeared" depend on two separate resolutions.
function probeCallerIndexLockBefore(inputs, report) {
  const path = resolveCallerIndexLock(inputs);
  const before = statCallerIndexLock(path);
  report.caller_worktree.index_lock_before = before;
  if (before !== null) {
    report.limitations.push({
      code: CALLER_INDEX_LOCK_PRE_EXISTING_CODE,
      detail: `呼び出し元 worktree に \`${before.path}\`（${before.size} bytes, mtime ${before.mtime}）が`
        + 'この run の**開始前から**在った。この runner は呼び出し元の index を読み書きしないので、'
        + '**停止する理由が無い（処理は続行する）**。runner はこの lock を消さない —— '
        + '他人が保持中の lock を消すと、それが守っていた index が壊れる。'
        + '後続の `git pull` / `git status` がこの lock で落ちるなら、それは**この run より前から在ったもの**である',
    });
  }
  return path;
}

// The closing probe, run immediately before the report is written so it covers
// everything the invocation did — including the artifacts written after it.
function probeCallerIndexLockAfter(report, probe) {
  const before = report.caller_worktree.index_lock_before;
  const after = statCallerIndexLock(probe.lockPath);
  report.caller_worktree.index_lock_after = after;
  // Only the transition none -> one is `appeared`. A lock that was already there
  // is `pre_existing` and was reported at the start, and re-reporting it here
  // would tell the operator that this run produced something it merely outlived.
  if (after === null || before !== null) return;
  report.limitations.push({
    code: CALLER_INDEX_LOCK_APPEARED_CODE,
    detail: `呼び出し元 worktree の \`${after.path}\`（${after.size} bytes, mtime ${after.mtime}）が`
      + `この run の**実行中に出現した**（run 開始 ${probe.startedAt} / 終了 ${new Date().toISOString()}）。`
      + '**この runner が作ったとは言っていない** —— merge runner が呼ぶ git は fetch / rev-parse / '
      + 'worktree add|remove / diff / push だけで、呼び出し元の index を書く経路が無い（#222）。'
      + '**merge と統合検証の裁定は変わらない。まず `integration_verify.outcome` と各 target の `merged` を読むこと。** '
      + 'runner はこの lock を消さない。size 0 かつ mtime がこの run の期間内で、'
      + "`pgrep -fl 'git '` に該当が無ければ stale なので、人間が手で消す",
  });
}

// =============================================================================
// Report assembly
// =============================================================================

// The run-wide declaration (mirrors the dispatch runner's entry of the same
// code). One entry, in EVERY unattended report including the ones that stopped,
// so what the run declared — and what that declaration implied — is readable
// from the report alone.
//
// Deliberately free of absolute paths: `redact()` would replace them with
// `[REDACTED-PATH]` and, worse, would tally a redaction a run without the flag
// does not have, so the "an unattended run differs only by this limitation"
// property would stop being true.
const UNATTENDED_MODE_CODE = 'unattended_mode';

// Phase-aware because the two phases imply DIFFERENT tightenings (ADR section 8's
// stage table gives one to each). A single sentence covering both would tell the
// reader of a `--merge-prs` report about a promotion that phase never applies.
function unattendedModeLimitation(phase) {
  const implied = phase === 'merge_prs'
    ? '全 eligible Issue が受入ゲートブロック（```acceptance-gates）と受入条件を持つことを要求する'
      + '（1件でも欠ければ **1つも merge せずに停止**する。対象集合を黙って縮めない。段階 C）'
    : `${EVIDENCE_UNAVAILABLE_CODE} を limitation ではなく blocking として扱う（実変更を示せない PR は開かない。段階 B）`;
  return {
    code: UNATTENDED_MODE_CODE,
    detail: `--unattended（段階 ${UNATTENDED_STAGE}）: この invocation に人間は居ない、という入力の宣言である。`
      + '締め付けだけを含意し、権限は1つも足していない — **`--approve` は含意しない**、'
      + 'ゲートを無効化せず、blocking を limitation に格下げせず、status を1段も上げない。'
      + `含意した締め付け: ${implied}。`
      + '拒否する入力: dispatch の緩和フラグ（--auto-yes / --allow-questions / --contract-mode。invalid_input, exit 3）。'
      + '`gh` 由来の停止は足していない（実測どおり gh は TTY 非依存で完結する）ので、'
      + '`GH_TOKEN` と `GIT_TERMINAL_PROMPT=0` は job 定義側で置くこと（runner は検査しない）。',
  };
}

function halt(report, status, stopReason, code, detail) {
  // The first blocking condition wins; later ones only add to blocking_reasons.
  if (report.status === 'success') {
    report.status = status;
    report.stop_reason = stopReason;
  }
  report.blocking_reasons.push({ code, detail });
}

function baseReport(inputs, plan, eligible, outDir) {
  return {
    merge_schema_version: MERGE_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: inputs.phase,
    status: 'success',
    stop_reason: 'completed',
    approved: inputs.approve,
    mutated: false,
    merge_method: inputs.mergeMethod,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    eligible_issues: eligible.slice(),
    preflight: [],
    targets: [],
    // The invocation's OWN worktree, measured before and after the run (Issue
    // #222). Both null is the ordinary case and is what every run wrote before
    // this field existed, so the field's presence — not its content — is the only
    // difference in a report from a lock-free run.
    //
    // Present in BOTH phases. `--create-prs` runs `git push` and `git diff` from
    // this same cwd, and a report that could answer "was the caller's index
    // locked?" for one phase and not the other would be read as "the other phase
    // does not touch it", which is a claim nothing here measured.
    caller_worktree: { index_lock_before: null, index_lock_after: null },
    // Present ONLY when `--integration-verify` was passed (Issue #175). A report
    // written without the flag keeps the exact key set — and therefore the exact
    // bytes — it had before this field existed, which is what makes the opt-in
    // an opt-in rather than a change of output for everybody (fixture m22).
    // Absent means "this run did not verify the merged state", never "green".
    ...(inputs.integrationVerify ? { integration_verify: newIntegrationVerify(plan) } : {}),
    blocking_reasons: [],
    limitations: [],
    redactions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

function buildCompletionCheck(report, phase) {
  const merges = report.targets.filter((t) => t.merged && t.merge_attempted);
  const failureOutcomes = new Set(['pr_failed', 'pr_missing', 'pr_closed', 'ci_failed', 'ci_pending', 'merge_failed']);
  const anyFailure = report.targets.some((t) => failureOutcomes.has(t.outcome));

  const checks = [
    {
      id: 'single_phase',
      passed: phase === 'create_prs' || phase === 'merge_prs',
      detail: `exactly one mutating phase was enabled (${phase})`,
    },
    {
      id: 'approval_enforced',
      passed: !report.mutated || report.approved,
      detail: report.mutated
        ? 'a mutation ran and it was explicitly approved'
        : 'no mutation ran without --approve',
    },
    {
      id: 'verification_gated',
      passed: report.targets.every((t) => t.eligible === true),
      detail: 'every target was a completed-and-verification-passed issue',
    },
    {
      id: 'ci_gated',
      passed: merges.every((t) => t.ci_passed === true),
      detail: merges.length === 0
        ? 'no PR was merged'
        : 'every merged PR had green CI before the merge',
    },
    {
      id: 'failures_not_rounded',
      passed: !anyFailure || report.status !== 'success',
      detail: anyFailure
        ? 'a failure was recorded and the status is not success'
        : 'no blocking failure was recorded',
    },
  ];
  const passed = checks.every((c) => c.passed) && report.status !== 'failure';
  return { passed, checks };
}

function renderSummary(report) {
  const lines = [];
  const phaseLabel = report.phase === 'create_prs' ? 'PR 作成' : 'guarded merge';
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push('## 対象と結論');
  lines.push(`${phaseLabel}（${report.approved ? '承認あり' : 'preview'}）を ${report.profile.repository} で実行: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  if (!report.approved) lines.push('明示承認（--approve）が無いため mutation はしていない（preview）。');
  lines.push('');
  lines.push('## eligible（verification pass 済み）');
  lines.push(report.eligible_issues.length ? `- ${report.eligible_issues.map((n) => `#${n}`).join(', ')}` : '- なし（verification pass した Issue が無い）。');
  lines.push('');
  lines.push('## target');
  if (report.targets.length === 0) {
    lines.push('- target なし。');
  } else {
    for (const t of report.targets) {
      const ci = t.ci_checked ? ` / CI=${t.ci_passed ? 'green' : t.ci_summary}` : '';
      const pr = t.pr_number ? ` / PR#${t.pr_number}` : '';
      lines.push(`- #${t.issue}: ${t.outcome}${pr}${ci}`);
    }
  }
  lines.push('');
  lines.push('## preflight');
  for (const c of report.preflight) lines.push(`- ${c.code}: ${c.ok ? 'ok' : 'NG'}`);
  lines.push('');
  // The unattended section (Issue #134). Printed only when the operator opted in,
  // so a run without `--unattended` reads exactly as it did before the flag
  // existed.
  const unattendedDeclared = report.limitations.find((entry) => entry.code === UNATTENDED_MODE_CODE);
  if (unattendedDeclared) {
    lines.push('## 無人運転（unattended）');
    lines.push(`- 宣言: ${unattendedDeclared.detail}`);
    lines.push(report.phase === 'merge_prs'
      ? '- **`--unattended` は mutation の許可ではない。** 無人で merge する CI は `--approve` を別に書く。'
      : '- **`--unattended` は mutation の許可ではない。** 無人で PR を作る CI は `--approve` を別に書く。');
    lines.push('- job 定義側で `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）と `GIT_TERMINAL_PROMPT=0` を置くこと。**`git push` の資格情報プロンプトだけは「止まる」ではなく無言で待つに化ける**（SKILL.md 第3.3節）。');
    lines.push('');
  }
  // The integration verification section (Issue #175). Printed only when the
  // operator opted in, so a run without `--integration-verify` reads exactly as
  // it did before the flag existed.
  const integration = report.integration_verify;
  if (integration) {
    const verdict = integration.outcome === 'pass' ? 'green' : integration.outcome === 'fail' ? '**RED**' : '未実行';
    // WHICH set was measured, said out loud (Issue #195). A report that only
    // says "green" cannot be told from one that measured the wrong list — which
    // is the whole failure this field separates.
    const source = integration.source === INTEGRATION_BASELINE_FIELD
      ? `profile の \`integration_baseline\`（宣言あり。\`baseline\` は使っていない）`
      : `profile の \`baseline\`（\`integration_baseline\` 未宣言のためフォールバック）`;
    lines.push('## 統合検証（--integration-verify）');
    lines.push(`- 合流後の ${integration.base}${integration.base_sha === null ? '' : `（${integration.base_sha}）`}で ${source} を実行: ${verdict}。`);
    lines.push(`- 対象（この invocation が merge した PR の Issue）: ${integration.merged_issues.length === 0 ? 'なし' : integration.merged_issues.map((n) => `#${n}`).join(', ')}`);
    lines.push(`- 詳細: ${integration.detail}`);
    // The cleanup, said in both directions (Issue #222). `tree_removed` exists
    // exactly when a throwaway checkout was created, so its absence here is "no
    // checkout was made", never "we did not look".
    if (integration.tree_removed !== undefined) {
      lines.push(integration.tree_removed
        ? `- 後片付け: 使い捨ての detached checkout（\`${INTEGRATION_TREE_DIRNAME}\`）は削除済み。`
        : `- 後片付け: 使い捨ての detached checkout（\`${INTEGRATION_TREE_DIRNAME}\`）を**畳めていない**（${INTEGRATION_TREE_LEFT_CODE}）。\`git worktree remove --force\` で消す。`);
    }
    lines.push('- **wave barrier は「全 worker completed + verification pass」だけでは満たされない。** 合流後の統合ブランチが green であることまでが barrier である。');
    lines.push('');
  }
  // The caller's index.lock (Issue #222). Printed ONLY when a lock was seen, so a
  // report from the ordinary run reads exactly as it did before this probe
  // existed. The section leads with the adjudication rather than with the lock:
  // the measured failure mode is a human reading "index.lock" as "the merge
  // broke" and rolling back a merge that had already landed and been verified.
  const lockBefore = report.caller_worktree?.index_lock_before ?? null;
  const lockAfter = report.caller_worktree?.index_lock_after ?? null;
  if (lockBefore !== null || lockAfter !== null) {
    const seen = lockBefore !== null ? lockBefore : lockAfter;
    const when = lockBefore !== null ? 'run の開始前から在った' : 'run の実行中に出現した';
    lines.push('## 呼び出し元 worktree の index.lock');
    lines.push(`- \`${seen.path}\`（${seen.size} bytes, mtime ${seen.mtime}）が${when}。run 終了時点: ${lockAfter === null ? '**消えている**' : '**残っている**'}。`);
    lines.push('- **これは merge の失敗ではない。** 裁定は上の「対象と結論」と `merged` / `integration_verify.outcome` が正である。**merge 済みのものを、この lock を理由に巻き戻さない。**');
    lines.push("- **runner はこの lock を消さない**（他人が保持中の lock を消すと index が壊れる）。`pgrep -fl 'git '` に該当が無く size 0 なら stale なので、人間が手で消す。");
    lines.push('');
  }
  lines.push('## 未解決と next action');
  const evidenceBlocked = report.blocking_reasons.some((r) => r.code === EVIDENCE_UNAVAILABLE_CODE);
  const acceptanceBlocked = report.blocking_reasons.some(
    (r) => r.code === ACCEPTANCE_GATES_REQUIRED_CODE || r.code === NO_ACCEPTANCE_CRITERIA_CODE,
  );
  // The integration stop (Issue #175) shares `merge_failed` with the conflict /
  // branch-protection stop, but nothing about a `gh pr merge` failed there: the
  // merges succeeded and their SUM is red, so the generic next action ("resolve
  // the conflict and re-run") would send the operator after a conflict that does
  // not exist — and re-running the merge phase cannot undo a landed merge.
  const integrationFailed = report.blocking_reasons.some((r) => r.code === INTEGRATION_VERIFY_FAILED_CODE);
  const integrationUnavailableStop = report.blocking_reasons.some((r) => r.code === INTEGRATION_VERIFY_UNAVAILABLE_CODE);
  // The unavailable stops need opposite instructions, and they are told apart by
  // WHAT was missing rather than by the stop_reason they landed on: a profile
  // with no command to run is refused before the first merge, everything else is
  // a probe that failed after the merges had landed. Since #195 the first case
  // splits again by `source` — an EMPTY `integration_baseline` is a declaration,
  // and telling its author to write a `baseline` would be telling them to undo it.
  const integrationNoCommands = integrationUnavailableStop && (report.integration_verify?.commands.length ?? 0) === 0;
  const integrationUndeclared = integrationNoCommands && report.integration_verify?.source !== INTEGRATION_BASELINE_FIELD;
  const integrationDeclaredEmpty = integrationNoCommands && report.integration_verify?.source === INTEGRATION_BASELINE_FIELD;
  if (report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push(report.approved ? '- なし。全 eligible を処理した。' : '- なし。preview のみ（mutation なし）。');
  } else {
    for (const r of report.blocking_reasons) lines.push(`- blocking: ${r.code} — ${r.detail}`);
    for (const l of report.limitations) lines.push(`- limitation: ${l.code} — ${l.detail}`);
    if (report.stop_reason === 'ci_failed' || report.stop_reason === 'ci_pending') lines.push('- next: CI を green にしてから再実行する（owner: operator）。無条件 merge はしない。');
    if (report.stop_reason === 'merge_failed' && !integrationFailed && !integrationUnavailableStop) lines.push('- next: conflict/branch protection を解消し、再実行する（owner: operator）。');
    if (integrationFailed) {
      lines.push('- next: **合流後の統合ブランチが赤い。既に merge 済みなので、この phase の再実行では戻らない。** 統合ブランチを green にする（前進修正、または revert）まで **次の wave を dispatch しない**（owner: operator/human）。');
      lines.push(`- next: ${INTEGRATION_VERIFY_FAILED_CODE} は「file 重なりに出ない意味的衝突」の徴候である。同 wave の Issue 同士が同じデータ・同じ前提を別方向へ動かしていないかを読む（owner: human）。`);
    }
    if (integrationUndeclared) {
      lines.push('- next: **profile に `baseline` を宣言してから再実行する（owner: operator）。1件も merge していないので、直して同じコマンドを回せばよい。** 合流後を別の集合で判定するなら `integration_baseline` に書く（#195）。統合検証をしない運転に戻すなら `--integration-verify` を外す（#175 以前の挙動）。');
    }
    if (integrationDeclaredEmpty) {
      lines.push('- next: **profile の `integration_baseline` が空である（＝「統合検証の定義は無い」という宣言）。`baseline` へは落とさない（owner: operator）。1件も merge していないので、直して同じコマンドを回せばよい。** 合流後の「合格の定義」を `integration_baseline` に書く（例: 検証 gate を1本にまとめた command）。`baseline` を流用してよいなら key ごと消す。統合検証をしない運転に戻すなら `--integration-verify` を外す（#195）。');
    }
    if (integrationUnavailableStop && !integrationNoCommands) {
      const set = report.integration_verify?.source === INTEGRATION_BASELINE_FIELD ? '`integration_baseline`' : '`baseline`';
      lines.push(`- next: **merge は済んでいるのに、その結果を測れていない。** \`git fetch\` / base の解決 / 検証用 checkout の失敗要因を直し、統合ブランチで profile の ${set} を手で1回通してから次の wave へ進む（owner: operator）。`);
    }
    // The evidence stop shares `pr_create_failed`, but nothing about push or gh
    // failed there, so it gets its own next action instead of the generic one.
    if (evidenceBlocked) lines.push('- next: 対象 Issue の worktree を復旧してから再実行する（`git diff <base>...<branch>` が答える状態にする）。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する（owner: operator）。');
    if (report.stop_reason === 'pr_create_failed' && !evidenceBlocked) lines.push('- next: push/PR 作成の失敗要因を解消し、再実行する（owner: operator）。');
    if (report.stop_reason === 'pr_missing') lines.push('- next: 先に --create-prs で PR を作成する（owner: operator）。');
    // The stage-C stop shares `preflight_failed` with the gh/git probes, but
    // nothing about gh or git failed there: the action is on the ISSUE bodies.
    if (acceptanceBlocked) {
      lines.push('- next: 無人 merge の対象 Issue に受入ゲートブロック（```acceptance-gates）／受入条件が無い。**Issue 本文に書いて re-plan する。** 該当 Issue を除外して回す道は用意していない（対象集合を黙って縮めないため）。人間が読む運転に戻すなら `--unattended` を外す（owner: human）。');
    }
    // `integrationNoCommands`, not `integrationUndeclared`: the declared-empty
    // stop lands on `preflight_failed` too, and nothing about gh or git failed
    // there either — the action is on the profile (Issue #195).
    if (report.stop_reason === 'preflight_failed' && !acceptanceBlocked && !integrationNoCommands) lines.push('- next: gh 認証・repo 到達性・base 解決を復旧し、再実行する（owner: operator）。');
  }
  return lines.join('\n');
}

// =============================================================================
// Orchestration
// =============================================================================

function runMerge(inputs, plan, dispatch, outDir) {
  const eligible = eligibleIssues(plan, dispatch);
  const report = baseReport(inputs, plan, eligible, outDir);
  // Recorded before anything else so it survives every early return below: a run
  // that stopped in the preflight still says what it had declared.
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs.phase));

  // Issue #222, and BEFORE the preflight: the question the closing probe answers
  // is "did this appear WHILE the run was going", so the opening reading has to be
  // older than every git this invocation runs — the preflight's `git rev-parse
  // --verify <base>` included. Every early return below carries the probe into
  // finalize(), so a run that stopped in the preflight still reports both sides.
  const probe = { lockPath: null, startedAt: new Date().toISOString() };
  probe.lockPath = probeCallerIndexLockBefore(inputs, report);

  // Read-only preflight before any mutation.
  report.preflight = preflight(inputs, plan);
  const blocked = report.preflight.find((c) => c.blocking && !c.ok);
  if (blocked) {
    halt(report, 'failure', 'preflight_failed', `preflight_${blocked.code}`, blocked.detail);
    finalize(report, probe);
    return report;
  }

  if (eligible.length === 0) {
    report.limitations.push({ code: 'no_eligible_issues', detail: 'the dispatch report has no completed-and-verified issue; nothing to do' });
    if (inputs.integrationVerify) {
      report.integration_verify.detail = 'not run: no issue was eligible, so nothing was merged and the base branch did not move';
      report.limitations.push({
        code: INTEGRATION_VERIFY_NOT_RUN_CODE,
        detail: '--integration-verify was requested but nothing was eligible to merge, so the integration branch was not verified. This is "not measured", not "green"',
      });
    }
    finalize(report, probe);
    return report;
  }

  // Stage C (Issue #142 / ADR sections 8, 9). Read-only, over the WHOLE eligible
  // set, and before the phase touches a single PR: an unattended merge either
  // runs on issues that all declared what "done" means, or it does not run.
  if (inputs.unattended && inputs.phase === 'merge_prs') {
    const reasons = unattendedAcceptanceReasons(plan, eligible);
    if (reasons.length > 0) {
      // `preflight_failed` receives it: the enum is a schema-versioned closed set
      // (ADR section 11), and what actually happened is named by the codes in
      // `blocking_reasons` — the shape section 15.2 used for
      // `wall_clock_budget_exhausted` and section 16 for the stage-B promotion.
      for (const reason of reasons) halt(report, 'failure', 'preflight_failed', reason.code, reason.detail);
      finalize(report, probe);
      return report;
    }
  }

  // Issue #175, and BEFORE the first merge: an opt-in verification the profile
  // cannot supply the commands for is refused, not skipped. Skipping would let a
  // report say the phase completed while the one stage that would have caught a
  // semantic conflict never ran — the exact shape of the failure this flag
  // exists for. Refusing here leaves the world untouched, so the operator fixes
  // the profile and re-runs with nothing to undo. WHICH field they have to fix
  // is `integrationSet.source`, and since #195 it decides the message too.
  const integrationSet = inputs.integrationVerify ? resolveIntegrationBaseline(plan) : null;
  if (integrationSet !== null && integrationSet.commands.length === 0) {
    const profileId = String(plan.profile.id ?? 'unknown');
    // Two different facts, and their next actions are opposite (Issue #195), so
    // they are never rounded into one sentence. A declared-empty
    // `integration_baseline` is a repository STATEMENT, and telling its author to
    // "declare a baseline" would be advice to undo the declaration they made on
    // purpose — the fallback this Issue removed, offered back as prose.
    const detail = integrationSet.source === INTEGRATION_BASELINE_FIELD
      ? `--integration-verify was requested, but profile "${profileId}" declares \`integration_baseline\` with no runnable command, `
        + 'which is this repository stating that it has no integration verification. It is NOT answered with `baseline`: that list is each '
        + "worker's proportional health check, and running it here is what let a merged state be called green without being measured (Issue #195). "
        + 'Nothing was merged: an opt-in verification that cannot run is refused rather than skipped. '
        + 'Declare the commands that define "green" for the merged branch in `integration_baseline` and re-run, remove the key to fall back to '
        + '`baseline`, or drop --integration-verify'
      : `--integration-verify was requested, but profile "${profileId}" declares no baseline command, `
        + 'so there is nothing to run on the merged branch. Nothing was merged: an opt-in verification that cannot run is refused rather than skipped '
        + '(a skipped verification would report a completed merge phase whose result nobody measured). '
        + 'Declare `baseline` in the profile — or `integration_baseline`, if the merged branch should be judged by a different set (Issue #195) — '
        + 'and re-run, or drop --integration-verify to accept the pre-#175 behaviour';
    report.integration_verify.detail = detail;
    halt(report, 'failure', 'preflight_failed', INTEGRATION_VERIFY_UNAVAILABLE_CODE, detail);
    finalize(report, probe);
    return report;
  }

  if (inputs.phase === 'create_prs') {
    runCreatePrs(inputs, plan, dispatch, eligible, outDir, report);
  } else {
    runMergePrs(inputs, plan, eligible, report);
  }

  // The wave barrier's second half (Issue #175): every merge this invocation
  // performed has landed, so the state they add up to is measured now — after
  // the loop, once per invocation, never per PR.
  if (inputs.integrationVerify) runIntegrationVerify(inputs, plan, outDir, report);

  finalize(report, probe);
  return report;
}

function finalize(report, probe) {
  // Issue #222, and as late as the runner can make it: the closing reading of the
  // caller's index.lock is taken before the summary is rendered, so the summary
  // can say what was found, and after everything the phase does.
  probeCallerIndexLockAfter(report, probe);
  report.completion_check = buildCompletionCheck(report, report.phase);
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report);
}

// =============================================================================
// Failure envelope
// =============================================================================

function mergeFailure(error, phase) {
  const report = {
    merge_schema_version: MERGE_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    phase: phase ?? 'create_prs',
    status: 'failure',
    stop_reason: 'runner_error',
    approved: false,
    mutated: false,
    merge_method: DEFAULT_MERGE_METHOD,
    plan_run_id: 'unknown',
    out_dir: null,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    eligible_issues: [],
    preflight: [],
    targets: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    completion_check: { passed: false, checks: [] },
    summary_markdown: `## 対象と結論\nmerge runner 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
  report.completion_check = buildCompletionCheck(report, report.phase);
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

  const defaultOut = join(dirname(inputs.dispatchPath), inputs.phase === 'create_prs' ? 'create-prs' : 'merge-prs');
  const outDir = inputs.outDir ?? defaultOut;
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `merge directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const report = runMerge(inputs, plan, dispatch, outDir);
  writeFileSync(join(outDir, 'merge-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'merge-summary.md'), `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(`wrote merge artifacts to ${outDir}\n`);
  const exitCode = report.status === 'success' ? 0 : report.status === 'partial' ? 7 : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

function main() {
  const argv = process.argv.slice(2);
  // Recover the phase for the failure envelope even when arg parsing failed.
  const phaseGuess = argv.includes('--merge-prs') && !argv.includes('--create-prs') ? 'merge_prs' : 'create_prs';
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = mergeFailure(error, phaseGuess);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
