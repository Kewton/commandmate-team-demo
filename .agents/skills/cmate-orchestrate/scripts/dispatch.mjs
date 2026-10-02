#!/usr/bin/env node
// cmate-orchestrate — dispatch and supervision runner (Node stdlib only, Node >= 22).
//
// This runner does the *execution* half of official CommandMate issue
// orchestration. It takes an already-approved plan produced by the plan-core
// runner (scripts/orchestrate.mjs) and drives it, wave by wave, against the
// public `commandmate` CLI:
//
//   - it resolves each issue's CommandMate worktree id AND real path from a single
//     `commandmate ls --json` row matched on the plan's branch (Issue #1473).
//     Because `send`/`wait`/`capture` (id) and the git operations below (path)
//     both come from that one row, they can never diverge onto different
//     worktrees; the plan's template path is only a fallback when `ls` omits a
//     path;
//   - it dispatches each issue under an EXECUTION CONTRACT when the CommandMate in
//     front of it supports one (Issue #1588): it generates
//     `.commandmate/tasks/cmate-orchestrate-issue-<n>.yaml` deterministically from
//     the approved plan, places it in the worktree, and sends it with `commandmate
//     send <worktree-id> --contract <path>`, which records a task row and prints
//     the TASK ID on stdout. (`send` also still takes a plain positional message —
//     that is the fallback path below.) The verdict then comes from CommandMate
//     itself instead of from a re-implementation here;
//   - it supervises each worker as a loop, not a single wait (Issue #1468): a real
//     worker idles after every turn, so `commandmate wait` returning exit 0 means
//     "idle", not "done". Completion is a NEW COMMIT on the worktree branch (read
//     with `git rev-parse HEAD` inside the ls-resolved path). While the worker
//     idles without a new commit the runner nudges it to keep going, bounded by
//     --max-turns; a prompt (exit 10) STOPS and is presented (via `commandmate
//     capture --json`) to a human — it never auto-answers unless --auto-yes;
//     hitting the turn cap with no commit is an honest `failed`, never a false
//     completion. Within a wave every worker's supervision loop runs CONCURRENTLY
//     (Issue #1474): `wait` blocks until its worker idles, so the wave takes the
//     slowest single worker instead of the sum, with runtime parallelism bounded
//     by the wave width (already <= max_parallel);
//   - it enforces a wave barrier: the next wave dispatches only when every worker
//     of the previous wave completed (committed) AND its verification passed.
//     `--schedule dag` (opt-in, Issue #183) replaces that barrier with a
//     per-dependency one: an issue is admitted as soon as ITS OWN dependencies are
//     completed + verified, so an issue that only shares a wave with the slowest
//     worker no longer waits for it. The default is unchanged and byte-identical.
//     Under a contract the verdict is `commandmate wait --verify`'s EXIT CODE
//     (0 pass / 20 judged-and-failed / 21 no work evidence / 99 NO VERDICT AT ALL);
//     without one it falls back to re-running the profile baseline inside the
//     worktree. Worker completion and verification success are kept strictly
//     separate, and a 99 is never folded into 20 — "we could not judge" must not
//     be re-instructed as "we judged it and it failed";
//   - it version-gates that choice out loud: `send --help` / `wait --help` are
//     probed once at start-up and the mode it settled on is stated in the report,
//     so the run never degrades silently to the weaker check;
//   - it honors max_parallel (1-3): a wave is never wider than the bound;
//   - before every mutating wave it re-checks post-plan drift
//     (branch / HEAD / worktree / permission) and refuses to dispatch on drift.
//
// The CLI surface it shells out to is documented in
// references/dispatch-contract.md. Every external command is injectable
// (--cli / --git / --gh) so the behavior can be exercised against a fake CLI
// without touching a real repository. Tokens, secrets, absolute paths and raw
// terminal output are redacted before they reach the report or an artifact.

import { parseArgs, promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync, statSync, rmSync, readdirSync, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { hostname, tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NON_PASS_GATE_VERDICTS,
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  issueOf,
  matchUpstreamFault,
  parseCliJson,
  SEND_NOT_READY_EXIT,
  SEND_NOT_READY_RETRY_DELAY_MS,
  sendNotReadyKind,
  sendPauseMs,
  parseGateLine,
  redact,
  redactionsList,
  resolveLauncher,
  safeWorktreeTarget,
  isOverBroadScope,
  readVerifyConfigGates,
  VERIFY_CONFIG_RELATIVE,
  workerMessageProblem,
  WORKER_MESSAGE_KEYS,
} from './lib.mjs';

const DISPATCH_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];

const MAX_PARALLEL_MAX = 3;

// A CommandMate worktree id (mirrors the CLI's isValidWorktreeId): an
// alphanumeric-led token of [A-Za-z0-9_-], at most 200 chars. The runner refuses
// to hand anything else to `commandmate send/wait/capture`.
const WORKTREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

// `commandmate wait` reports the worker's terminal state by EXIT CODE, not by a
// JSON field: 0 the worker went idle (a turn finished), 10 a prompt is awaiting
// input (prompt JSON on stdout), 124 the --timeout elapsed. Any other non-zero
// exit is an infrastructure failure. IMPORTANT (Issue #1468): a real Claude worker
// idles after every TURN, so exit 0 means "idle", not "task done". Completion is
// detected separately, from a new commit on the worktree branch.
const WAIT_EXIT_IDLE = 0;
const WAIT_EXIT_PROMPT = 10;
const WAIT_EXIT_TIMEOUT = 124;

// `commandmate wait --verify` and `commandmate verify` report the VERDICT by exit
// code (CommandMate 0.17.0 / Issue #1544):
//
//   0    passed          — every gate ran and passed
//   20   VERIFY_FAILED   — a gate failed, timed out or errored: judged, and failed
//   21   NOT_STARTED     — the work-evidence gate found no commit and no change
//   99   UNEXPECTED_ERROR— the run ended `error`/`cancelled`: NO VERDICT WAS REACHED
//   124  TIMEOUT
//   1/2  infrastructure (dependency / configuration)
//
// 99 is the one that must never be folded into 20. CommandMate's own source says
// why: "`error` and `cancelled` mean no verdict was reached, so they take the
// generic UNEXPECTED_ERROR code rather than VERIFY_FAILED — a caller branching on
// 20 must be able to trust that gates actually ran and judged the work." A 99 is
// therefore escalated to a human, not fed to the re-instruction loop: asking a
// worker to repair something nobody ever judged is asking it to guess.
const VERIFY_EXIT_PASS = 0;
const VERIFY_EXIT_FAILED = 20;
const VERIFY_EXIT_NOT_STARTED = 21;
const VERIFY_EXIT_NO_VERDICT = 99;

// Gate statuses that mean the gate did not pass (mirrors FAILED_GATE_STATUSES in
// CommandMate's verify command). `skipped` is not a failure.
//
// `flaky` is deliberately NOT here, and cannot be (Issue #224): FLAKY is a LABEL
// laid over the stored status, not a status of its own — CommandMate #1772 added
// no migration, so `verification_gate_results.status` still holds `passed` or
// `failed` and the gate's `flakyIsPass` decided which. Adding `flaky` to this set
// would make a tolerated flake — stored `passed`, run green — read as a failing
// gate, which is re-adjudicating a verdict from a display word. The word is
// carried into the report by `gateFlakyOutcome` below and changes nothing about
// who failed.
const FAILED_GATE_STATUSES = new Set(['failed', 'timeout', 'error']);

// Did this gate's two runs disagree? `commandmate verify --json` structures the
// runner's `[flaky]` log marker as `gates[].flaky` (verification-config.md
// section 10.4), so the fact is read from a field rather than re-parsed out of a
// log body. A gate that was never retried has no field and no marker.
function gateFlakyOutcome(gate) {
  const flaky = gate && typeof gate === 'object' ? gate.flaky : null;
  if (!flaky || typeof flaky !== 'object') return null;
  const outcome = String(flaky.outcome ?? '');
  return outcome === 'flaky' || outcome === 'fail' ? outcome : null;
}

// How the run decides whether to dispatch under an execution contract.
//   auto    probe the CLI; use a contract when it has one, fall back (loudly) otherwise
//   require probe the CLI; refuse to dispatch at all when it has none
//   off     do not probe; use the legacy profile-baseline verification
const CONTRACT_MODES = ['auto', 'require', 'off'];
const DEFAULT_CONTRACT_MODE = 'auto';

// =============================================================================
// Scheduling — how the runner decides WHEN an issue may be dispatched
// (Issue #183 / references/dispatch-contract.md section 3.2)
// =============================================================================
//
//   wave  the plan's waves, with a barrier between them: the next wave starts
//         only once EVERY worker of the previous one completed and passed. The
//         default, and unchanged down to the bytes of the report.
//   dag   dependency-satisfaction scheduling: an issue is admitted the moment
//         its own effective dependencies are completed + verified and a slot is
//         free. `plan.waves` is then reference information only.
//
// The measurement that produced this (Issue #183, Kewton/BorderFreeKidsMap): a
// worker turn ranges from a few minutes to ~40, so a wave's wall clock is its
// SLOWEST worker and the run's is the sum of those. An issue that depends on
// nothing in its wave pays that difference for nothing. Under `dag` the lower
// bound becomes the critical path instead of "wave depth × slowest".
//
// It is opt-in, and it stays opt-in until the resource contention the barrier
// was incidentally suppressing is solved upstream (Kewton/CommandMate#1771 —
// still OPEN: verification gates that bind a port, or read one shared env, false-
// fail when two of them run at once). Nothing here fixes that; what this runner
// owes an operator is to say so, which `schedule_dag` does in every report.
const SCHEDULE_MODES = ['wave', 'dag'];
const DEFAULT_SCHEDULE = 'wave';

// Where the contract is placed inside the worktree. CommandMate resolves
// `--contract` relative to the worktree root, and `.commandmate/tasks/**` is
// excluded from both the work-evidence count and the scope gate (#1580), so
// dropping the file in needs neither a commit nor a base merge.
const CONTRACT_DIR = '.commandmate/tasks';
const CONTRACT_FILE_PREFIX = 'cmate-orchestrate-issue-';

// Bounds from CommandMate's contract parser (docs/design/task-contract.md v1).
// Enforced here so a contract this runner writes is rejected locally rather than
// by the server after a task row already exists.
const MAX_CONTRACT_TITLE = 200;
const MAX_CONTRACT_GOAL = 8000;
const MAX_SCOPE_PATTERNS = 200;
const MAX_SCOPE_PATTERN_LENGTH = 200;
const MAX_GATE_IDS = 32;
const GATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// `verify.gateDefinitions` — the gates a contract carries itself (CommandMate
// #1791 / task-contract.md §2.3.1). MAX_GATE_DEFINITIONS matches MAX_GATE_IDS
// upstream ("a contract cannot select more gates than it may define"), and the
// per-entry rules are verify-config's own `validateGateEntries`, so the timeout
// range and the reserved ids below are the SAME constraints a gate declared in
// `.commandmate/verify.yaml` is held to.
const MAX_GATE_DEFINITIONS = 32;
const RESERVED_GATE_IDS = ['work-evidence', 'scope', 'env-clean'];
const MIN_GATE_TIMEOUT_SEC = 1;
const MAX_GATE_TIMEOUT_SEC = 7200;
// The value domains of the #1771 / #1772 gate fields, transcribed from
// verify-config.ts (GATE_MUTEX_PATTERN / MAX_GATE_MUTEX_LENGTH /
// MAX_RETRY_ON_FAIL) for the same reason the four constants above are: a plan
// this runner accepts must be one `send --contract` accepts.
const GATE_MUTEX_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_GATE_MUTEX_LENGTH = 64;
const MAX_RETRY_ON_FAIL = 1;

// Bounds on the issue-body text the goal transcribes verbatim (Issue #176).
// Both are this runner's, not CommandMate's, and they exist for one reason: the
// transcript must never be what pushes a goal into the 8000-char truncation,
// because the truncation cuts from the END and would take `## Rules` with it.
//
// MEASURED against the checked-in contract goldens: an ordinary goal's fixed
// part (header, objective, criteria, files, rules) is ~1,700 chars, and
// `## Files you may change` is the only part that grows without a bound of its
// own (the scope bound alone allows 200 patterns). 1200 keeps the transcript
// BELOW that fixed part — the goal stays a brief with the prohibitions quoted
// into it rather than becoming a body dump — and leaves the file list the room it
// had. An issue that states more prohibition text than this is one where reading
// the body IS the better instruction, and saying so is what the pointer line does.
//
// The COUNT bound is the pair scope already uses (MAX_SCOPE_PATTERNS beside
// MAX_SCOPE_PATTERN_LENGTH): a goal carrying thirty transcribed fragments is not
// a goal anybody reads, however short each fragment is.
const MAX_CONSTRAINT_TRANSCRIPT = 1200;
const MAX_CONSTRAINT_BLOCKS = 8;

// The id `send --contract` prints on stdout. Kept deliberately permissive (the
// real one is a UUID) but bounded, so a stray log line never becomes a task id.
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The per-worker `commandmate wait` timeout. `wait` blocks internally until the
// worker idles, raises a prompt, or this timeout elapses. --poll-limit is retained
// for input compatibility but no longer drives a polling loop (there is none).
const DEFAULT_WAIT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_LIMIT = 120;

// The supervision loop drives each worker turn by turn. Because a worker idles
// after every turn without necessarily being done, the runner nudges it to keep
// going until it commits — bounded by this many turns (initial send + nudges).
// Reaching the cap with no commit is an honest `failed`, never a false completion.
const DEFAULT_MAX_TURNS = 8;

// The artifacts a dispatch attempt writes, and where a resume appends the next
// attempt's copies (Issue #98). Attempt 1 keeps the run directory's root, so
// every existing reader — merge, uat, the status matrix — finds exactly what it
// found before; attempt N writes the SAME file names one directory down, under
// `resume-attempt-<N>/`, and never touches an earlier attempt's bytes.
const DISPATCH_REPORT_FILE = 'dispatch-report.json';
const DISPATCH_SUMMARY_FILE = 'dispatch-summary.md';
const RESUME_ATTEMPT_PREFIX = 'resume-attempt-';
// The append-only ledger of attempts, at the run directory's root. It is the
// machine-readable half of the attempt history: which report each attempt wrote,
// which report it resumed from, what it carried over and what it re-dispatched.
const ATTEMPT_HISTORY_FILE = 'attempt-history.jsonl';
// A bound on the attempt search, so a directory somebody filled with
// `resume-attempt-*` names cannot turn a resume into an unbounded scan.
const MAX_ATTEMPTS = 99;

// =============================================================================
// Unattended — the declaration that nobody is watching this invocation
// (Issue #122 / #142 / references/adr-unattended-mode.md sections 2, 3, 6.5,
// 8, 14.1, 14.2)
// =============================================================================
//
// `--unattended` is an INPUT DECLARATION, not a permission (ADR "裁定 0"). It
// disables no gate, downgrades no blocking reason to a limitation and raises no
// status by one step; what it adds is tightening, and nothing else. In
// particular it does NOT imply `--approve` (a flag this runner does not even
// have) and it does not answer prompts: a run that says "there is no human here"
// cannot also say "answer every prompt with yes".
//
// Stage C (Issue #142) reaches every runner: dispatch, `merge.mjs` (both
// phases) and `uat.mjs`. What it adds HERE over stage A is exactly one thing
// (ADR section 6.5): `verification_gates_unrecorded` becomes BLOCKING. A pass
// whose gates the report cannot name is an unattributed pass — readable, and
// correctable, by a human who opens the run, and with nobody reading it it is
// the whole basis on which an unattended `--merge-prs` would move a base branch.
// The promotion is tied to `--unattended`, not to any downstream flag, for the
// reason section 16.1 gives: an invocation's declaration must not mean different
// things depending on what some other job does later.
//
// `change_evidence_unavailable` is NOT promoted here — it is a merge-side
// limitation and stage B already promoted it (ADR section 6.5's correction note;
// section 16). Nothing about it is re-decided in this runner.
const UNATTENDED_STAGE = 'C（dispatch + merge + uat）';

// The exclusivity lock (ADR section 14.1). Issue #115 measured the window
// between process start and the creation of `--out`: two runs started 700 ms
// apart both passed the pre-flight, both invoked the `--prepare-worktrees`
// provider, and both then drove the SAME worktrees, interleaving their `send`s.
// `out_exists` is not a mutex there — the directory does not exist yet — and it
// is not one at all when `--out` varies per run (a timestamped cron output path)
// or when `--resume` appends into an existing directory.
//
// Ownership is the RUNNER's (candidate A of that section's table). The
// granularity is one lock per WORKTREE, because the harm is "two supervisors in
// one worktree", not "one plan run twice": two different plans can name the same
// worktree. The lock is NOT `--out` — Issue #90 decided that a run stopped in
// the pre-flight does not consume `--out`, and re-using it as a mutex would undo
// that decision.
//
// It is taken only under `--unattended`. A run without the flag is byte-for-byte
// what it was before this feature existed (ADR section 11), which is the
// property the whole fixture suite is pinned on; the residual gap — a human's
// ad-hoc run does not take the lock, so it can still collide with a cron run —
// is stated in the contract rather than papered over.
const LOCK_ROOT_ENV = 'CMATE_ORCHESTRATE_LOCK_DIR';
const LOCK_DIR_NAME = 'cmate-orchestrate-locks';
const LOCK_OWNER_FILE = 'owner.json';
// A lock whose owner record cannot be read is only reclaimed once it is older
// than this: the gap between `mkdirSync` and the `owner.json` write is
// microseconds, so an unreadable record in a fresh lock means "a run is starting
// right now", while an old one means "a run died between the two".
const LOCK_STALE_GRACE_MS = 60_000;
// Long enough for any branch a profile template produces, short enough that the
// key is a legal directory name everywhere. A truncation collision can only
// produce a spurious refusal, never a missed one.
const LOCK_KEY_MAX = 200;

// =============================================================================
// Worker method — the opt-in reference to a worker-side development Skill
// (Issue #128 / references/adr-worker-development-skill.md sections 3 and 9)
// =============================================================================
//
// What `--worker-method` adds is METHOD, never PERMISSION (ADR section 2). It
// relaxes no gate, widens no `scope.allow`, and grants no push/PR right; the
// contract still decides, and the task text says so in as many words.
//
// BOTH roots are required, and that is a measured decision rather than a
// cautious one. CommandMate deploys a Skill byte-identically into
// `.agents/skills/<id>/` (Codex) and `.claude/skills/<id>/` (Claude), and this
// runner does not know which Agent will pick the task up: it never passes
// `send --agent`, and the `ls --json` rows it resolves worktrees from carry
// id/branch/path and no agent at all. Accepting one side would therefore mean
// writing "read the skill in this worktree" into a contract whose worker may be
// structurally unable to see it — asserting something this runner cannot
// measure (ADR section 3.5). Requiring both is the only condition that holds
// whichever Agent runs, and the measurement says it costs nothing real: of the
// 45 `cmate-*` installs found across the worktrees on the development machine,
// 45 were two-sided (the one-sided packages there were all hand-authored,
// non-catalog ones). The runbook tells hand-placers to use both roots too, and
// the cost of being wrong is one `commandmate skill install` plus a re-run of
// the same command — `--out` is never consumed by this refusal.
const WORKER_METHOD_ROOTS = ['.claude/skills', '.agents/skills'];
// The file whose presence IS the install. A directory alone can be an empty
// leftover of an uninstall; the Skill's entry point existing is what makes
// "read it before you start" a true sentence.
const WORKER_METHOD_ENTRY = 'SKILL.md';
// A Skill id, mirroring the catalog's own id shape. It is interpolated into a
// path, so the pattern is also the path-escape guard: no separator, no dot, no
// leading dash can survive it.
const WORKER_METHOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// =============================================================================
// Redaction (SkillError, the pattern list and redact/redactionsList are shared
// with the merge and uat runners in lib.mjs)
// =============================================================================

// A short, redacted excerpt of terminal-ish output. The raw stream is never
// stored: a bounded tail is enough for a human to act on a prompt or a failure.
// NOT shared with merge/uat: an empty excerpt is `null` here and `''` there,
// because the dispatch report schema makes this field nullable.
function excerpt(value, limit = 280) {
  const text = redact(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || null;
  return `…${text.slice(text.length - limit)}`;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate dispatch runner (executes an approved plan)

Usage:
  dispatch.mjs --plan <path> [options]

Options:
  --plan <path>          Approved plan.json from the plan-core runner (required).
  --out <dir>            Where dispatch artifacts are written
                         (default: <plan-dir>/dispatch). Mutually exclusive with
                         --resume, which appends into the prior run's directory.
  --resume <dir>         Resume a partially failed dispatch: <dir> is the --out
                         directory of the run being resumed. The newest report in
                         it is read, every issue whose worker completed AND whose
                         verification passed is carried over instead of being
                         re-dispatched (its verdict is transcribed, not re-run),
                         and only the rest is dispatched. The wave barrier is
                         recomputed, so an issue whose dependency already passed
                         is dispatched without waiting. Artifacts are appended
                         under <dir>/${RESUME_ATTEMPT_PREFIX}<n>/; nothing is
                         overwritten. Refused when the report was produced for a
                         different plan.
  --reverify <dir>       Re-judge a prior dispatch WITHOUT sending anything:
                         <dir> is the --out directory of the run being re-judged.
                         The same carry-over rule as --resume applies (worker
                         completed AND verification passed is transcribed, never
                         re-judged); of the rest, every issue whose worktree
                         still HOLDS WORK — a commit on the work branch or an
                         uncommitted change, the two facts the work-evidence gate
                         counts — is put through the verification gate again as
                         it stands. Nothing is sent, no contract is written and
                         no worker turn is consumed, so an issue whose worker
                         finished after its report was frozen can rejoin the
                         delivery path without being asked to work again. An
                         issue with no work evidence is NOT re-judged: its prior
                         record is transcribed unchanged. Artifacts append under
                         <dir>/${RESUME_ATTEMPT_PREFIX}<n>/ exactly as a resume's
                         do. Mutually exclusive with --out and --resume.
  --only <issues>        Dispatch only these issues of the plan (comma-separated
                         issue numbers, e.g. --only 12,14,15) without re-planning.
                         Refused, with nothing dispatched and --out unconsumed,
                         (invalid_input) when a number is not in the plan, or a
                         selected issue depends (plan.dependencies, not a
                         lexical-only edge) on an unselected issue that no
                         prior attempt passed (--resume carries that pass). The
                         report keeps the whole plan and the chosen subset
                         (plan_scope); unselected issues are recorded as
                         not_dispatched, not as a failure. With
                         --resume / --reverify and no --only, the subset the
                         prior report recorded is kept.
  --cli <launcher>       The CommandMate launcher to drive: an executable plus
                         fixed leading arguments, split on whitespace and run
                         WITHOUT a shell — "commandmate" (default),
                         "/usr/local/bin/commandmate", "npx commandmate@latest".
                         Falls back to $CM (monitor.sh's variable) when omitted.
                         Shell syntax is refused; wrap it in a script instead.
  --git <path>           The git CLI used for drift checks (default "git").
  --gh <path>            The gh CLI used for the repo-access check (default "gh").
  --auto-yes             Answer worker prompts automatically. OFF by default; a
                         prompt otherwise halts the loop for a human. The plan's
                         profile may declare this default instead
                         (dispatch_defaults.auto_yes); the flag always wins.
  --no-auto-yes          State the OFF side explicitly, so a profile that
                         declares dispatch_defaults.auto_yes can be declined for
                         one run. Without it there is no way to type "not this
                         time": an absent boolean flag and an off one are the
                         same argv.
  --allow-questions      Dispatch a plan whose issues still carry unanswered
                         open questions. OFF by default: an issue the planner
                         could not read acceptance criteria or affected files
                         out of halts the run before anything is dispatched.
                         Setting this records that an operator took the risk.
  --prepare-worktrees    Prepare the worktrees the pre-flight could not resolve,
                         by invoking the cmate-worktree-setup provider named by
                         --worktree-setup, re-scanning the registry and resolving
                         again before the first wave. OFF by default: without it
                         an unresolved worktree stops the run exactly as before.
  --worktree-setup <launcher>
                         The cmate-worktree-setup provider --prepare-worktrees
                         invokes: an executable plus fixed leading arguments,
                         split on whitespace and run WITHOUT a shell. It is called
                         as "<launcher> --issues <n,n> --profile <id> --base <ref>"
                         and must print a worktree-setup.result.v1 document on
                         stdout. Passing --profile/--base/--issues yourself is
                         refused: all three come from the approved plan.
  --worker-method <id>   Name a worker-side development Skill (e.g.
                         cmate-worker-development) whose method every dispatched
                         worker must follow. OFF by default, and the default is
                         not "on when it happens to be installed": without this
                         flag the run is byte-for-byte what it was before the
                         flag existed. With it, dispatch verifies the Skill is
                         installed in EVERY worktree it is about to dispatch into
                         (both ${WORKER_METHOD_ROOTS.join(' and ')}) and refuses the
                         run if it is not, then writes a "## Method" section
                         naming it into the task text. It adds METHOD only: no
                         gate is relaxed and no permission is widened.
  --unattended           Declare that NO HUMAN is watching this invocation (CI /
                         cron). It grants nothing: it does not imply --approve,
                         it answers no prompt, it disables no gate and it never
                         turns a blocking reason into a limitation. What it adds
                         is tightening — it implies --contract-mode require,
                         checks BEFORE creating --out that every issue in the
                         plan declares a scope (all-or-nothing), takes a
                         per-worktree exclusivity lock so a second run cannot
                         drive the same worktrees, requires --wall-clock-budget,
                         and records the pre-dispatch HEAD of every worktree it
                         drives so the run can be undone. Combining it with a
                         relaxing flag (--auto-yes, --allow-questions,
                         --contract-mode off|auto) is refused with invalid_input
                         rather than silently overridden.
  --wall-clock-budget <sec>
                         Stop the run once it has been running this long. The
                         remaining budget is also the timeout of every child
                         process the run spawns, which is the only bound on the
                         profile baseline and the acceptance commands (they have
                         none of their own). Reaching it is a partial run with
                         stop_reason "timeout" — never a success. OFF by default;
                         required with --unattended.
  --schedule <mode>      wave (default) | dag. wave keeps the plan's waves and
                         the barrier between them: the next wave starts only once
                         EVERY worker of the previous one completed and passed.
                         dag admits each issue as soon as ITS OWN dependencies are
                         completed + verified and a slot is free, so an issue that
                         merely shares a wave with the slowest worker does not
                         wait for it; plan.waves becomes reference information and
                         --max-parallel is read as the concurrency cap it already
                         was. dag RAISES the achieved parallelism, so on a
                         repository whose verification gates share a resource (a
                         port, one shared env) it can turn contention into false
                         reds until Kewton/CommandMate#1771 lands — keep
                         --max-parallel conservative there. A failure then stops
                         only its DOWNSTREAM (blocked_by_upstream_failure);
                         --unattended keeps the safe side and stops the whole run.
  --contract-mode <m>    auto (default) | require | off. auto dispatches under an
                         execution contract when the CLI supports one and falls
                         back to the profile baseline with an explicit limitation
                         otherwise; require refuses to fall back; off never
                         probes and always uses the profile baseline.
  --verify-gates <ids>   Comma-separated verify.yaml gate ids to name in the
                         contract's verify.gates. Omitted means every gate the
                         repository declares (this runner never invents an id).
  --expect-branch <name> Integration branch the plan was approved from; a
                         mismatch at dispatch time is treated as drift.
  --wait-timeout <sec>   --timeout passed to commandmate wait (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).
                         The plan's profile may declare this default instead
                         (dispatch_defaults.wait_timeout); the flag always wins.
  --max-turns <n>        Max turns to drive each worker (initial send + nudges)
                         before giving up with no commit (default ${DEFAULT_MAX_TURNS}).
                         The plan's profile may declare this default instead
                         (dispatch_defaults.max_turns); the flag always wins.
  --nudge-message <text> Appended after the default supervision nudge (which always
                         keeps its "single commit is the completion signal" line).
                         The plan's profile may declare this instead
                         (worker_messages.nudge); the flag always wins. Non-blank,
                         at most 2000 characters.
  --verify-concurrency <n>
                         With --reverify only: re-judge at most <n> issues at a
                         time (a positive integer; default: all at once). For
                         gates heavy enough that two runs side by side fail on
                         load, not on the change (1 = one at a time). Not a plan
                         value and not part of the run id: the report's order and
                         verdicts do not depend on it. Refused without --reverify.
  --poll-limit <n>       Retained for compatibility; wait now blocks (default ${DEFAULT_POLL_LIMIT}).
  --interrupt-stale-prompt
                         Before a worker's first send, dispatch reads the
                         session (capture --json). A question or selection screen
                         left by an earlier turn stops that issue with
                         stale_prompt_on_session (the default). With this flag it
                         runs "commandmate interrupt" instead, re-reads the
                         session, and sends only once the composer is back. The
                         question is never answered.
  --help                 Show this help.

The dispatch runner mutates: it sends work to real workers, nudging each until it
commits its work (a worker idles after every turn, so idle is not "done"). It
refuses to dispatch on post-plan drift and never answers a worker prompt on its own.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        plan: { type: 'string' },
        out: { type: 'string' },
        resume: { type: 'string' },
        reverify: { type: 'string' },
        only: { type: 'string' },
        cli: { type: 'string' },
        git: { type: 'string' },
        gh: { type: 'string' },
        'auto-yes': { type: 'boolean' },
        // The OFF side, spelled out (Issue #180). `parseArgs` refuses
        // `--auto-yes=false` outright ("does not take an argument"), and an
        // absent boolean and an off one are the same argv, so a profile-declared
        // default could not otherwise be declined for a single run.
        'no-auto-yes': { type: 'boolean' },
        'allow-questions': { type: 'boolean' },
        unattended: { type: 'boolean' },
        'wall-clock-budget': { type: 'string' },
        'prepare-worktrees': { type: 'boolean' },
        'worktree-setup': { type: 'string' },
        'worker-method': { type: 'string' },
        schedule: { type: 'string' },
        'contract-mode': { type: 'string' },
        'verify-gates': { type: 'string' },
        'expect-branch': { type: 'string' },
        'wait-timeout': { type: 'string' },
        'max-turns': { type: 'string' },
        'poll-limit': { type: 'string' },
        'verify-concurrency': { type: 'string' },
        'interrupt-stale-prompt': { type: 'boolean' },
        'nudge-message': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

function positiveInt(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    throw new SkillError('invalid_input', `${name} must be a positive integer`, 3);
  }
  return Number.parseInt(raw, 10);
}

// Runs `fn` over `items` with at most `limit` in flight, starting them in order.
// A null limit is the unbounded form (every item starts at once), which is what a
// caller that never stated a width gets.
async function forEachLimited(items, limit, fn) {
  if (limit === null) {
    await Promise.all(items.map(fn));
    return;
  }
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// `--contract-mode` is validated here rather than defaulted silently: a typo'd
// mode that fell back to `auto` would look like the operator chose the fallback.
function resolveContractMode(raw) {
  if (raw === undefined) return DEFAULT_CONTRACT_MODE;
  if (!CONTRACT_MODES.includes(raw)) {
    throw new SkillError('invalid_input', `--contract-mode must be one of ${CONTRACT_MODES.join(', ')}`, 3);
  }
  return raw;
}

// `--schedule` is validated here rather than defaulted silently, for the same
// reason `--contract-mode` is: a typo'd mode that fell back to `wave` would look
// like the operator chose the barrier.
function resolveSchedule(raw) {
  if (raw === undefined) return DEFAULT_SCHEDULE;
  if (!SCHEDULE_MODES.includes(raw)) {
    throw new SkillError('invalid_input', `--schedule must be one of ${SCHEDULE_MODES.join(', ')}`, 3);
  }
  return raw;
}

// Gate ids for the contract's `verify.gates`. They are checked against
// CommandMate's own GATE_ID_PATTERN and bounds so an unusable list fails here,
// where the message is about the flag, instead of at `send --contract` (exit 2)
// where it is about a file this runner wrote.
function resolveVerifyGates(raw) {
  if (raw === undefined) return [];
  const ids = String(raw).split(',').map((value) => value.trim()).filter((value) => value !== '');
  if (ids.length === 0) {
    throw new SkillError('invalid_input', '--verify-gates must name at least one gate id', 3);
  }
  if (ids.length > MAX_GATE_IDS) {
    throw new SkillError('invalid_input', `--verify-gates accepts at most ${MAX_GATE_IDS} gate ids`, 3);
  }
  const seen = new Set();
  for (const id of ids) {
    if (!GATE_ID_RE.test(id)) {
      throw new SkillError('invalid_input', `--verify-gates: "${id}" is not a valid gate id (${GATE_ID_RE.source})`, 3);
    }
    if (seen.has(id)) {
      throw new SkillError('invalid_input', `--verify-gates: duplicate gate id "${id}"`, 3);
    }
    seen.add(id);
  }
  return ids;
}

// The worker-method Skill id, validated here rather than at the probe. The id is
// interpolated into a path this runner reads inside somebody's worktree, so an id
// that is not an id is an input error, not a missing install: reporting
// `worker_method_unavailable` for `../../etc` would send the operator off to
// install something that was never nameable in the first place.
function resolveWorkerMethod(raw) {
  if (raw === undefined) return null;
  const id = String(raw).trim();
  if (!WORKER_METHOD_ID_RE.test(id)) {
    throw new SkillError('invalid_input',
      `--worker-method must be a skill id matching ${WORKER_METHOD_ID_RE.source} (e.g. cmate-worker-development); ` +
        'it names a directory this runner reads inside each worktree, so nothing else is accepted', 3);
  }
  return id;
}

// The unattended declaration and the tightening it implies (Issue #122 / ADR
// sections 2, 3, 4, 5). Returns the contract mode and the wall-clock budget
// because both are DECIDED here: under `--unattended` the mode is forced to
// `require` and the budget stops being optional.
//
// The three refusals are refusals rather than overrides on purpose (ADR
// section 2, invariant 2). A run that declared two contradictory things must not
// have one of them silently win: the reader of the report — which in unattended
// operation is the next CI job, not a person — cannot tell which one did. The
// same shape as #93's refusal of a double-specified `--worktree-setup`.
function resolveUnattended(values) {
  const contractMode = resolveContractMode(values['contract-mode']);
  const budget = positiveInt(values['wall-clock-budget'], 'wall-clock-budget', null);
  if (!values.unattended) return { unattended: false, contractMode, wallClockBudget: budget };

  if (values['auto-yes']) {
    throw new SkillError('invalid_input',
      '--unattended and --auto-yes cannot both hold: --auto-yes consumes the prompt stop (exit 10) with an unconditional '
        + '"yes", which makes the one halt that exists FOR the absent human structurally unreachable. Drop one of the two', 3);
  }
  if (values['allow-questions']) {
    throw new SkillError('invalid_input',
      '--unattended and --allow-questions cannot both hold: --allow-questions declares that somebody TAKES ON an unanswered '
        + 'planner question, and --unattended declares that nobody is here to take it on. Answer the questions in the issue '
        + 'body and re-plan', 3);
  }
  if (values['contract-mode'] !== undefined && contractMode !== 'require') {
    throw new SkillError('invalid_input',
      `--unattended implies --contract-mode require, so --contract-mode ${contractMode} is refused rather than overridden: `
        + 'the fallback path has no scope gate at all (an issue with no declared scope is dispatched there), and "no execution '
        + 'contract" is precisely the silent degradation nobody is present to read', 3);
  }
  if (budget === null) {
    throw new SkillError('invalid_input',
      '--unattended requires --wall-clock-budget <sec>: the turn caps bound the number of turns, not the clock, and the '
        + 'profile baseline and the acceptance commands have no timeout of their own. With a human present, the person who '
        + 'starts the run is the budget; with nobody present, the job definition is the only place the limit can be chosen', 3);
  }
  return { unattended: true, contractMode: 'require', wallClockBudget: budget };
}

// Flags the worktree-setup provider must not be handed a second time (Issue #93).
// The profile, the base and the issue set come from the APPROVED PLAN; a provider
// invoked with a second, operator-supplied profile resolves a different
// `branch_template` and creates branches the plan does not name. The symptom of
// that is "no registered worktree matches branch …" — a message about the
// registry, for a cause that is a disagreement between two profiles. Refusing the
// double specification here is what keeps the two sides on one profile.
const SETUP_RESERVED_FLAGS = ['--profile', '--profile-json', '--base', '--repo', '--issues', '--issue-numbers'];

// The provider launcher. It shares `--cli`'s guards (no shell syntax, no control
// characters, program first) but NOT its fallbacks: `$CM` names the CommandMate
// CLI, which is not a worktree-setup provider, and there is no sensible default
// binary to guess — an unset provider is the "not installed" case (ADR section 5),
// not something to fill in.
function resolveSetupLauncher(raw, prepareWorktrees) {
  if (raw === undefined) return null;
  if (!prepareWorktrees) {
    throw new SkillError('invalid_input',
      '--worktree-setup needs --prepare-worktrees: a provider that is never invoked is a silent no-op', 3);
  }
  let argv;
  try {
    argv = resolveLauncher(raw, {});
  } catch (error) {
    // resolveLauncher names the flag it was written for; this is the same guard
    // reached through a different flag, so the advice must name that one.
    throw new SkillError('invalid_input', String(error.detail ?? error.message).replace(/^--cli /, '--worktree-setup '), 3);
  }
  for (const token of argv.slice(1)) {
    const flag = String(token).split('=')[0];
    if (SETUP_RESERVED_FLAGS.includes(flag)) {
      throw new SkillError('invalid_input',
        `--worktree-setup must not carry ${flag}: the profile, the base and the issue set come from the approved plan, ` +
          'and a second value for them is how the two sides end up creating different branches', 3);
    }
  }
  return argv;
}

function resolveInputs(parsed) {
  const { values } = parsed;
  if (!values.plan) {
    throw new SkillError('invalid_input', '--plan <path> is required', 3);
  }
  // The launcher is argv, not a program name: `npx commandmate@latest` is two
  // tokens and execFileSync takes no shell (Issue #37). `cli` keeps the resolved
  // string for messages; every spawn goes through cliArgv.
  const cliArgv = resolveLauncher(values.cli);
  const prepareWorktrees = Boolean(values['prepare-worktrees']);
  // `--out` claims a NEW directory (and refuses an existing one); `--resume`
  // appends into an EXISTING one. Accepting both would mean guessing which of the
  // two the operator meant, and the wrong guess either overwrites the prior
  // attempt or writes this attempt somewhere nobody will look for it (Issue #98).
  if (values.resume !== undefined && values.out !== undefined) {
    throw new SkillError('invalid_input',
      '--out and --resume are mutually exclusive: a resume appends into the directory it resumes ' +
        `(<resume-dir>/${RESUME_ATTEMPT_PREFIX}<n>/), so there is no second output path to choose`, 3);
  }
  // The same reasoning for `--reverify` (Issue #121): it appends into the
  // directory it re-judges, so `--out` has nothing to choose either.
  if (values.reverify !== undefined && values.out !== undefined) {
    throw new SkillError('invalid_input',
      '--out and --reverify are mutually exclusive: a reverify appends into the directory it re-judges ' +
        `(<reverify-dir>/${RESUME_ATTEMPT_PREFIX}<n>/), so there is no second output path to choose`, 3);
  }
  // `--resume` and `--reverify` are opposite answers to the same question. A
  // resume decides "this issue is not finished, send it back to its worker"; a
  // reverify decides "the work is already there, judge it again as it stands and
  // send nothing". Accepting both would make the runner pick one of the two for
  // every non-carried issue, and the wrong pick either consumes a worker turn
  // nobody asked for or leaves unfinished work unfinished.
  if (values.reverify !== undefined && values.resume !== undefined) {
    throw new SkillError('invalid_input',
      '--resume and --reverify cannot both hold: a resume RE-DISPATCHES what did not finish, a reverify RE-JUDGES what is '
        + 'already in the worktree and sends nothing. Choose the one that matches why the prior attempt stopped', 3);
  }
  const schedule = resolveSchedule(values.schedule);
  // `--schedule dag` and `--reverify` are refused together (Issue #183), and the
  // refusal is not caution — it is the one combination where the scheduler would
  // suppress the very work the flag exists to do. A reverify SENDS NOTHING: it
  // re-judges worktrees that already hold work, which is how an issue whose
  // worker finished after its report was frozen rejoins the delivery path. The
  // DAG ready gate would refuse to re-judge every issue downstream of one that is
  // not green — and "an upstream is not green" is precisely the state a reverify
  // is run to repair. Scheduling also buys nothing here: nothing is dispatched,
  // so there is no wall clock to shorten. Refused rather than ignored, because a
  // flag that is accepted and has no effect is a run nobody can reconstruct.
  if (schedule === 'dag' && values.reverify !== undefined) {
    throw new SkillError('invalid_input',
      '--schedule dag and --reverify cannot both hold: a reverify sends nothing, so there is no dispatch order to improve, and the DAG '
        + 'ready gate ("every dependency completed AND verified") would refuse to re-judge exactly the issues downstream of the failure the '
        + 'reverify is being run to clear. Re-judge with --reverify alone, then dispatch what is left with --schedule dag', 3);
  }
  // A run argument, never a plan value (Issue #274): it is not hashed into the
  // run id and a --reverify does not match it against the prior report. Only a
  // reverify judges in a fan-out that could be narrowed, so it is refused elsewhere
  // rather than accepted and ignored.
  const verifyConcurrency = positiveInt(values['verify-concurrency'], 'verify-concurrency', null);
  if (verifyConcurrency !== null && values.reverify === undefined) {
    throw new SkillError('invalid_input',
      '--verify-concurrency is only meaningful with --reverify: it bounds how many re-judgements run at once, and no other mode re-judges', 3);
  }
  const unattended = resolveUnattended(values);
  // The three-state reading of every flag a profile may also declare (Issue
  // #180). `stated` is the answer to "did the operator type this?", which is a
  // different question from "what is its value?" — and for a boolean flag the
  // two answers are the same bit unless they are kept apart here.
  const stated = {
    autoYes: statedBoolean(values, 'auto-yes'),
    waitTimeout: values['wait-timeout'] === undefined ? null : positiveInt(values['wait-timeout'], 'wait-timeout', null),
    maxTurns: values['max-turns'] === undefined ? null : positiveInt(values['max-turns'], 'max-turns', null),
  };
  if (values['nudge-message'] !== undefined) {
    const problem = workerMessageProblem(values['nudge-message']);
    if (problem !== null) throw new SkillError('invalid_input', `--nudge-message ${problem}`, 3);
  }
  return {
    planPath: values.plan,
    outDir: values.out ?? null,
    resumeDir: values.resume ?? null,
    reverifyDir: values.reverify ?? null,
    verifyConcurrency,
    only: resolveOnly(values.only),
    cliArgv,
    cli: cliArgv.join(' '),
    git: values.git ?? 'git',
    gh: values.gh ?? 'gh',
    // Resolved from the flags alone. `applyDispatchDefaults` re-resolves the
    // three below once the plan (and with it the profile) has been read; a run
    // whose profile declares nothing keeps exactly these values.
    autoYes: stated.autoYes === true,
    allowQuestions: Boolean(values['allow-questions']),
    unattended: unattended.unattended,
    wallClockBudget: unattended.wallClockBudget,
    prepareWorktrees,
    worktreeSetupArgv: resolveSetupLauncher(values['worktree-setup'], prepareWorktrees),
    workerMethod: resolveWorkerMethod(values['worker-method']),
    schedule,
    contractMode: unattended.contractMode,
    verifyGates: resolveVerifyGates(values['verify-gates']),
    expectBranch: values['expect-branch'] ?? null,
    waitTimeout: stated.waitTimeout ?? DEFAULT_WAIT_TIMEOUT_SECONDS,
    maxTurns: stated.maxTurns ?? DEFAULT_MAX_TURNS,
    pollLimit: positiveInt(values['poll-limit'], 'poll-limit', DEFAULT_POLL_LIMIT),
    interruptStalePrompt: Boolean(values['interrupt-stale-prompt']),
    stated,
    // Filled in by applyDispatchDefaults, and read by emptyReport. Empty on a run
    // whose profile declares nothing, which is what keeps such a run's report
    // byte-for-byte the one it was before this field existed.
    dispatchDefaultNotes: [],
    // CLI flag → profile (applyWorkerMessages) → nothing. Appended to NUDGE_MESSAGE.
    nudgeExtra: values['nudge-message'] ?? null,
    nudgeExtraSource: values['nudge-message'] === undefined ? null : '--nudge-message',
    // Filled in by run() when `--only` (or a resumed subset) narrowed the plan;
    // null otherwise, so emptyReport writes nothing for an ordinary run.
    onlyScope: null,
    onlyCarried: new Map(),
    // Filled in by run() from the plan's `dispatch_excluded: 'human_only'` marks
    // (Issue #286); empty on a plan without one, which writes nothing.
    humanOnly: { issues: [], dependencies: [] },
  };
}

// =============================================================================
// human-only issues: in the plan, never dispatched (Issue #286)
// =============================================================================
//
// The planner marks an issue whose labels hold `human-only` with
// `dispatch_excluded: 'human_only'`, keeps it (and its edges) in the plan so a
// reader sees the human work, and leaves it out of every wave. This runner reads
// the MARK, never the labels: the plan is the approved artifact, and a plan from
// a planner that predates the mark is dispatched as it was written.
//
// It is done the way `--only` is done, and before it: the plan the runner works
// on loses the marked issues and every edge touching one, once, so the barrier,
// the dag scheduler, the pre-flight, the locks, `--only` and the report all see
// the same smaller plan. The marked issues come back as `not_dispatched` records
// in the trailing waves[] entry, and an edge from a dispatched issue to one of
// them is NOT waited for — this runner cannot see a person finish, the same
// reason an edge to an issue outside the plan waits for nothing — but it is
// named in the `human_only_dependency` limitation, so the reader who merges the
// dependent knows what to confirm first.

function excludeHumanOnly(plan) {
  const marked = new Set(plan.issues
    .filter((issue) => issue?.dispatch_excluded === 'human_only')
    .map((issue) => issue.number));
  if (marked.size === 0) return { plan, issues: [], dependencies: [] };
  const dependencies = (plan.dependencies ?? [])
    .filter((edge) => !marked.has(edge.issue) && marked.has(edge.depends_on))
    .map((edge) => ({ issue: edge.issue, depends_on: edge.depends_on }));
  return {
    plan: {
      ...plan,
      issues: plan.issues.filter((issue) => !marked.has(issue.number)),
      dependencies: (plan.dependencies ?? []).filter((edge) => !marked.has(edge.issue) && !marked.has(edge.depends_on)),
      waves: plan.waves.map((wave) => wave.filter((number) => !marked.has(number))).filter((wave) => wave.length > 0),
    },
    issues: [...marked].sort((a, b) => a - b),
    dependencies,
  };
}

function humanOnlyWorkers(inputs) {
  return inputs.humanOnly.issues.map((number) => ({
    issue: number,
    task_id: null,
    worker_state: 'not_dispatched',
    verification: { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] },
    prompt: { detected: false, excerpt: null },
    note: 'human-only: the plan marks this issue dispatch_excluded (labelled human-only, a person does it), so no worker was sent and it was not judged (not a failure)',
  }));
}

// The limitations a plan with human-only issues adds, or none. The dependency
// line names only the dependents THIS run dispatches (an `--only` subset may
// have left one out, and a line about an issue the run never touched is noise).
function humanOnlyLimitations(inputs, plan) {
  const { issues, dependencies } = inputs.humanOnly;
  if (issues.length === 0) return [];
  const list = (numbers) => numbers.map((n) => `#${n}`).join(', ');
  const out = [{
    code: 'human_only_excluded',
    detail: `the plan marks ${list(issues)} human-only (dispatch_excluded): a person does ${issues.length === 1 ? 'it' : 'them'}, so this run sent no worker and judged nothing there. `
      + 'They are recorded in a trailing waves[] entry as `not_dispatched` ("human-only"); it is not a failure and not a blocking reason',
  }];
  const inRun = new Set(plan.issues.map((issue) => issue.number));
  const edges = dependencies.filter((edge) => inRun.has(edge.issue));
  if (edges.length > 0) {
    out.push({
      code: 'human_only_dependency',
      detail: `${edges.map((edge) => `#${edge.issue} depends on human-only #${edge.depends_on}`).join('; ')}. `
        + 'This run did not wait for the human-only side (it cannot see a person finish, the same as a dependency outside the plan): '
        + 'confirm that work is done before merging the dependent',
    });
  }
  return out;
}

// =============================================================================
// --only: dispatch a subset of the plan (CommandMate#3008)
// =============================================================================
//
// A plan is approved as a whole, but the set of issues that are READY is not: a
// declaration outside the scope or an unmet condition can hold back two of five,
// and the only way forward used to be re-planning the other three. `--only`
// restricts THIS run to the named issues and leaves the plan file untouched.
//
// It is done by narrowing the plan the runner works on (issues, waves,
// dependencies) once, before anything else reads it, so the barrier, the
// pre-flight, the locks and the report all see the same smaller plan and no
// second code path exists to drift from the first.
//
// A refusal is WHOLE, never partial: a selected issue whose dependency is not
// selected is not silently dropped from the run, because a run that quietly
// dispatches two of the three the operator typed is a run nobody can reconstruct
// from the argv. Both refusals happen before `--out` is created, so the same
// command can be corrected and re-run.

function resolveOnly(raw) {
  if (raw === undefined) return null;
  const tokens = raw.split(',').map((token) => token.trim());
  if (tokens.some((token) => !/^\d+$/.test(token) || Number.parseInt(token, 10) < 1)) {
    throw new SkillError('invalid_input',
      '--only must be a comma-separated list of issue numbers (e.g. --only 12,14,15)', 3);
  }
  return [...new Set(tokens.map((token) => Number.parseInt(token, 10)))].sort((a, b) => a - b);
}

// The prior report `--resume` / `--reverify` continues, or null on a first
// attempt. Read here (and again by buildResume) because the subset a resume runs
// is decided BEFORE the plan is narrowed, and the narrowed plan is what
// buildResume reads.
function priorForOnly(inputs, plan) {
  const reverifying = inputs.reverifyDir !== null;
  const dir = reverifying ? inputs.reverifyDir : inputs.resumeDir;
  if (dir === null) return null;
  const op = reverifying ? REVERIFY_OP : RESUME_OP;
  const found = priorReport(dir, op);
  const doc = loadResumeReport(found.path, plan, op);
  return { attempt: found.attempt, doc, records: priorWorkerRecords(doc) };
}

// Returns { plan, scope, carried }. `scope` is null when no subset applies, which
// is what keeps a run without the flag byte-for-byte the run it was before it
// existed. `carried` maps a DESELECTED issue to the pass record a prior attempt
// left for it: that record is what satisfies a selected issue's dependency on it,
// and it is transcribed into this report so a later reader that takes the last
// record of an issue never finds "excluded" written over a pass.
function restrictToOnly(inputs, plan) {
  const prior = priorForOnly(inputs, plan);
  let selected = inputs.only;
  let inherited = false;
  if (selected === null && prior !== null) {
    const recorded = prior.doc.plan_scope?.selected;
    if (Array.isArray(recorded) && recorded.length > 0 && recorded.every(Number.isInteger)) {
      selected = [...recorded].sort((a, b) => a - b);
      inherited = true;
    }
  }
  if (selected === null) return { plan, scope: null, carried: new Map() };

  const humanOnly = selected.filter((number) => inputs.humanOnly.issues.includes(number));
  if (humanOnly.length > 0) {
    throw new SkillError('invalid_input',
      `--only names ${humanOnly.map((n) => `#${n}`).join(', ')}, which the plan marks human-only (dispatch_excluded): a person does `
        + `${humanOnly.length === 1 ? 'it' : 'them'} and no run dispatches ${humanOnly.length === 1 ? 'it' : 'them'}. Nothing was dispatched: drop ${humanOnly.length === 1 ? 'it' : 'them'} from --only`, 3);
  }
  const planIssues = plan.issues.map((issue) => issue.number).sort((a, b) => a - b);
  const known = new Set(planIssues);
  const unknown = selected.filter((number) => !known.has(number));
  if (unknown.length > 0) {
    throw new SkillError('invalid_input',
      `--only names ${unknown.map((n) => `#${n}`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in the plan `
        + `(the plan holds ${planIssues.map((n) => `#${n}`).join(', ')})`, 3);
  }
  const chosen = new Set(selected);
  const carried = new Map();
  if (prior !== null) {
    for (const number of planIssues) {
      const record = prior.records.get(number);
      if (!chosen.has(number) && record !== undefined && isCarryable(record)) carried.set(number, carriedWorkerRecord(record, prior.attempt));
    }
  }
  const missing = [];
  for (const edge of plan.dependencies ?? []) {
    // Only the edges the scheduler honours: a lexical-only edge is advisory, and
    // an edge naming an issue outside the plan waits for nothing. A dependency a
    // prior attempt already passed is satisfied, not missing.
    if (edge.basis === 'lexical' || !chosen.has(edge.issue) || chosen.has(edge.depends_on) || !known.has(edge.depends_on)) continue;
    if (carried.has(edge.depends_on)) continue;
    missing.push(`#${edge.issue} depends on #${edge.depends_on}`);
  }
  if (missing.length > 0) {
    throw new SkillError('invalid_input',
      `--only selects ${selected.map((n) => `#${n}`).join(', ')}, but ${[...new Set(missing)].join('; ')}, which is not selected `
        + 'and has no passed record from a prior attempt to --resume. Nothing was dispatched: add the dependency to --only, or drop the dependent issue from it', 3);
  }
  const waves = plan.waves.map((wave) => wave.filter((number) => chosen.has(number))).filter((wave) => wave.length > 0);
  if (selected.some((number) => !waves.flat().includes(number))) {
    throw new SkillError('plan_invalid', '--only names an issue that no wave of the plan schedules', 3);
  }
  const narrowed = {
    ...plan,
    issues: plan.issues.filter((issue) => chosen.has(issue.number)),
    dependencies: (plan.dependencies ?? []).filter((edge) => chosen.has(edge.issue) && chosen.has(edge.depends_on)),
    waves,
  };
  return {
    plan: narrowed,
    scope: {
      plan_issues: planIssues,
      selected,
      deselected: planIssues.filter((number) => !chosen.has(number)),
      inherited,
    },
    carried,
  };
}

// The trailing wave entry that accounts for every deselected issue: a pass a
// prior attempt left is transcribed, everything else is `not_dispatched` with a
// note saying WHY. Not a blocking reason: the operator asked for the subset.
function onlyExcludedWorkers(inputs) {
  return inputs.onlyScope.deselected.map((number) => inputs.onlyCarried.get(number) ?? {
    issue: number,
    task_id: null,
    worker_state: 'not_dispatched',
    verification: { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] },
    prompt: { detected: false, excerpt: null },
    note: 'excluded by --only: this issue was not selected for this run, so it was neither dispatched nor judged (not a failure)',
  });
}

function onlyLimitation(scope) {
  const list = (numbers) => (numbers.length === 0 ? 'なし' : numbers.map((n) => `#${n}`).join(', '));
  return {
    code: 'only_subset',
    detail: `${scope.inherited ? 'the subset recorded by the prior attempt (--only was not typed again)' : '--only'}: this run dispatches ${list(scope.selected)} `
      + `of the plan's ${list(scope.plan_issues)}; NOT dispatched, and not judged here: ${list(scope.deselected)}. `
      + 'They are recorded in a trailing waves[] entry as `not_dispatched` ("excluded by --only") or, when a prior attempt already passed them, as that carried record; '
      + 'either way it is not a failure and not a blocking reason',
  };
}

// =============================================================================
// Profile-declared operating defaults (Issue #180)
// =============================================================================
//
// Three of this runner's knobs encode REPOSITORY knowledge rather than run
// knowledge: `--no-infer` (a repository whose issues share vocabulary gets
// phantom dependencies without it), `--auto-yes` (a repository whose workers ask
// before they write stalls without it) and `--wait-timeout` (a repository whose
// baseline builds and runs e2e cannot finish a turn inside the 300 s default).
// Their only home was a human's memory and a CLAUDE.md paragraph, and a
// forgotten flag there is not a slower run — it is a phantom edge, a worker
// waiting on a prompt nobody will answer, or a `wait_window_exhausted` the report
// then has to explain (§2.11 / Issue #179).
//
// The planner already refuses to hardcode `develop` / `npm`: repository
// knowledge enters through the PROFILE and nowhere else
// (references/profile-contract.md). Operating defaults are the same kind of
// knowledge, so they enter the same way — `profile.dispatch_defaults`, carried
// in the approved plan and read here. Two rules make them safe to declare:
//
//   EXPLICIT WINS, and explicit includes explicit OFF. `Boolean(values['auto-yes'])`
//   cannot tell "the operator passed nothing" from "the operator meant off", so
//   the flag layer keeps a three-state reading (`inputs.stated`: true / false /
//   not stated) and `--no-auto-yes` is how the false is typed. A default that
//   could not be declined for one run is not a default, it is a setting.
//
//   EVERY EXISTING CHECK RUNS ON THE RESOLVED VALUE. `--unattended` refuses
//   `--auto-yes` because the one halt that exists FOR the absent human must stay
//   reachable (adr-unattended-mode.md §2). A profile-declared auto-yes arms the
//   same worktree through the same `send`, so it is refused too: the exclusion is
//   a property of the value, and a check that only reads argv is one the profile
//   walks around.
//
// `no_infer` is accepted here but consumed by nobody: it is the PLANNER's flag,
// and dispatch cannot un-infer an approved plan. It is declared in one place
// because a profile is one declaration and not one per runner — and rather than
// ignore it, this runner compares it with the plan it was handed and records the
// disagreement (`dispatch_defaults_no_infer_not_applied`).

// The keys a profile may declare. Closed, and closed LOUDLY: an unknown key is
// refused rather than skipped, for the reason the profile loader refuses an
// unknown profile field (profile-contract.md §9.3) — a profile written for a
// newer runner must fail on an older one instead of being half-honored by it.
const DISPATCH_DEFAULT_BOOLEANS = ['no_infer', 'auto_yes'];
const DISPATCH_DEFAULT_COUNTS = ['wait_timeout', 'max_turns'];
const DISPATCH_DEFAULT_KEYS = [...DISPATCH_DEFAULT_BOOLEANS, ...DISPATCH_DEFAULT_COUNTS];

// true / false / null, where null means "the operator said nothing". The
// negation is a separate option rather than a parsed `--flag=false` because
// `parseArgs` rejects a value on a boolean option before this code runs.
function statedBoolean(values, name) {
  const on = values[name] === true;
  const off = values[`no-${name}`] === true;
  if (on && off) {
    throw new SkillError('invalid_input',
      `--${name} and --no-${name} cannot both hold: one invocation cannot state both sides of the same switch, and picking `
        + 'one of them here would make the report claim a choice nobody made', 3);
  }
  return on ? true : (off ? false : null);
}

// The declaration as the plan carries it, or null when the profile has none.
// ABSENT STAYS ABSENT: a plan without the key resolves exactly the values it
// resolved before this feature existed, down to the report's bytes.
//
// A malformed declaration is `plan_invalid` rather than `invalid_input` because
// it is a fact about the plan file, not about the argv: the operator who typed
// the command is not the person who wrote the profile, and the message has to
// send them to the right file.
function readDispatchDefaults(plan) {
  const raw = plan.profile?.dispatch_defaults;
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('plan_invalid',
      `plan.profile.dispatch_defaults must be a JSON object of ${DISPATCH_DEFAULT_KEYS.join(' / ')}, got ${JSON.stringify(raw)}`, 3);
  }
  for (const key of Object.keys(raw)) {
    if (!DISPATCH_DEFAULT_KEYS.includes(key)) {
      throw new SkillError('plan_invalid',
        `plan.profile.dispatch_defaults has an unknown key "${key}"; this runner understands ${DISPATCH_DEFAULT_KEYS.join(', ')}. `
          + 'A profile written for a newer runner is refused rather than half-applied: the keys it declares would otherwise be '
          + 'silently dropped, and a run driven by half a declaration is the accident the declaration was written to prevent', 3);
    }
  }
  const declared = {};
  for (const key of DISPATCH_DEFAULT_BOOLEANS) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== 'boolean') {
      throw new SkillError('plan_invalid',
        `plan.profile.dispatch_defaults.${key} must be true or false, got ${JSON.stringify(raw[key])}`, 3);
    }
    declared[key] = raw[key];
  }
  for (const key of DISPATCH_DEFAULT_COUNTS) {
    if (!(key in raw)) continue;
    if (!Number.isInteger(raw[key]) || raw[key] < 1) {
      throw new SkillError('plan_invalid',
        `plan.profile.dispatch_defaults.${key} must be a positive integer, got ${JSON.stringify(raw[key])}`, 3);
    }
    declared[key] = raw[key];
  }
  return declared;
}

// Resolves the declared defaults against the flags actually typed, IN PLACE, and
// records what it decided. Called once, after the plan is loaded and before
// anything is locked, created, probed or sent: a refusal here must leave `--out`
// unconsumed and the CLI untouched, exactly like the argv-only refusals above.
function applyDispatchDefaults(inputs, plan) {
  const declared = readDispatchDefaults(plan);
  if (declared === null) return;
  const stated = inputs.stated;
  const profileId = String(plan.profile?.id ?? 'unknown');
  const resolutions = [];

  if (declared.auto_yes !== undefined) {
    const flag = stated.autoYes === null ? null : (stated.autoYes ? '--auto-yes' : '--no-auto-yes');
    if (flag === null) inputs.autoYes = declared.auto_yes;
    resolutions.push(resolutionNote('auto_yes', declared.auto_yes, flag, inputs.autoYes));
  }
  if (declared.wait_timeout !== undefined) {
    const flag = stated.waitTimeout === null ? null : '--wait-timeout';
    if (flag === null) inputs.waitTimeout = declared.wait_timeout;
    resolutions.push(resolutionNote('wait_timeout', declared.wait_timeout, flag, inputs.waitTimeout));
  }
  if (declared.max_turns !== undefined) {
    const flag = stated.maxTurns === null ? null : '--max-turns';
    if (flag === null) inputs.maxTurns = declared.max_turns;
    resolutions.push(resolutionNote('max_turns', declared.max_turns, flag, inputs.maxTurns));
  }
  // Declared, and consumed by the planner rather than here. Nothing is recorded
  // when the plan already agrees (`inputs.infer` false): the plan says so itself,
  // and a limitation for the agreeing case would be noise on every run.
  if (declared.no_infer === true && plan.inputs?.infer === true) {
    inputs.dispatchDefaultNotes.push({
      code: 'dispatch_defaults_no_infer_not_applied',
      detail: `profile ${profileId} declares dispatch_defaults.no_infer, but plan ${plan.run_id} was built WITH dependency `
        + 'inference (inputs.infer true). Dispatch cannot un-infer an approved plan: the waves below are the ones the planner '
        + 'produced. If a wave was serialized by a lexical edge, re-plan with --no-infer and dispatch that plan instead',
    });
  }

  if (resolutions.length > 0) {
    inputs.dispatchDefaultNotes.push({
      code: 'dispatch_defaults_applied',
      detail: `profile ${profileId} declares dispatch_defaults; this run resolved ${resolutions.join(', ')}. `
        + 'A flag always wins over the profile, and --no-auto-yes is how the off side is stated explicitly',
    });
  }

  // The resolved-value half of the unattended exclusions (ADR §2, invariant 2).
  // The argv-only check in resolveUnattended still fires first for the flag —
  // it needs no plan, and its advice ("drop one of the two") is about two things
  // the operator typed. This one is about a value the operator did not type, so
  // it names the profile and the flag that declines it.
  if (inputs.unattended && inputs.autoYes) {
    throw new SkillError('invalid_input',
      `--unattended and profile ${profileId}'s dispatch_defaults.auto_yes cannot both hold: the profile arms the worktree `
        + 'auto-yes for every worker this run sends, which makes the one halt that exists FOR the absent human (exit 10) '
        + 'structurally unreachable — the same reason --auto-yes itself is refused. Pass --no-auto-yes to decline the profile '
        + 'default for this run, or drop auto_yes from the profile', 3);
  }
}

// worker_messages (CommandMate#3009): text appended to the supervision nudge.
// Precedence is flag → profile → nothing, and the flag is already in `inputs`.
// A malformed declaration is `plan_invalid` for the reason readDispatchDefaults
// gives. Only the length is recorded, never the text.
function applyWorkerMessages(inputs, plan) {
  const raw = plan.profile?.worker_messages;
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SkillError('plan_invalid',
        `plan.profile.worker_messages must be a JSON object of ${WORKER_MESSAGE_KEYS.join(' / ')}, got ${JSON.stringify(raw)}`, 3);
    }
    for (const key of Object.keys(raw)) {
      if (!WORKER_MESSAGE_KEYS.includes(key)) {
        throw new SkillError('plan_invalid',
          `plan.profile.worker_messages has an unknown key "${key}"; this runner understands ${WORKER_MESSAGE_KEYS.join(', ')} (fix_nudge is the uat runner's and is not used here)`, 3);
      }
    }
    for (const key of WORKER_MESSAGE_KEYS) {
      if (!(key in raw)) continue;
      const problem = workerMessageProblem(raw[key]);
      if (problem !== null) throw new SkillError('plan_invalid', `plan.profile.worker_messages.${key} ${problem}`, 3);
    }
  }
  const declared = raw?.nudge;
  if (declared === undefined && inputs.nudgeExtra === null) return;
  const profileId = String(plan.profile?.id ?? 'unknown');
  if (inputs.nudgeExtra === null) {
    inputs.nudgeExtra = declared;
    inputs.nudgeExtraSource = 'profile';
  }
  const detail = inputs.nudgeExtraSource === '--nudge-message'
    ? `nudge=${inputs.nudgeExtra.length} chars (--nudge-message${declared === undefined ? '' : ` overrode profile ${profileId}'s worker_messages.nudge`})`
    : `nudge=${inputs.nudgeExtra.length} chars (from profile ${profileId})`;
  inputs.dispatchDefaultNotes.push({
    code: 'worker_messages_applied',
    detail: `${detail}, appended after the default supervision nudge; the default's single-commit completion line is always sent`,
  });
}

// `auto_yes=true (from the profile)` / `max_turns=10 overridden by --max-turns (8)`.
// The declared value is named even when it lost, because the operator reading
// this is deciding whether their flag was the one that mattered.
function resolutionNote(key, declaredValue, flag, resolvedValue) {
  return flag === null
    ? `${key}=${JSON.stringify(resolvedValue)} (from the profile)`
    : `${key}=${JSON.stringify(resolvedValue)} (${flag} overrode the profile's ${JSON.stringify(declaredValue)})`;
}

// =============================================================================
// Plan loading and validation
// =============================================================================

function loadPlan(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read plan at ${path}: ${redact(error.message)}`, 6);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SkillError('load_error', `plan at ${path} is not valid JSON: ${redact(error.message)}`, 6);
  }
  return raw;
}

// The plan is trusted (it is this Skill's own approved artifact), but a wrong or
// tampered file must be refused rather than half-executed. Only the fields the
// loop needs are asserted, and any wave wider than max_parallel is a hard stop.
function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(plan.plan_schema_version)) {
    throw new SkillError(
      'plan_invalid',
      `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(' or ')}`,
      3,
    );
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
  const maxParallel = plan.max_parallel;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL_MAX) {
    throw new SkillError('plan_invalid', 'plan.max_parallel is out of the 1-3 range', 3);
  }
  if (!Array.isArray(plan.waves) || plan.waves.length === 0) {
    // A plan whose every issue is human-only has no wave by construction (Issue #286).
    const allHumanOnly = Array.isArray(plan.issues) && plan.issues.length > 0
      && plan.issues.every((issue) => issue?.dispatch_excluded === 'human_only');
    throw new SkillError('plan_invalid', allHumanOnly
      ? 'plan.waves is empty: every issue of the plan is marked human-only (dispatch_excluded), so there is nothing to dispatch'
      : 'plan.waves is empty', 3);
  }
  for (const wave of plan.waves) {
    if (!Array.isArray(wave) || wave.length === 0) {
      throw new SkillError('plan_invalid', 'a wave is empty or malformed', 3);
    }
    // The single most important pre-condition of the whole runner: the plan
    // already promised waves no wider than the bound. If that promise is
    // broken we refuse rather than dispatch beyond max_parallel.
    if (wave.length > maxParallel) {
      throw new SkillError(
        'plan_invalid',
        `wave ${JSON.stringify(wave)} exceeds max_parallel ${maxParallel}`,
        3,
      );
    }
  }
  if (!Array.isArray(plan.issues)) {
    throw new SkillError('plan_invalid', 'plan.issues is missing', 3);
  }
  return plan;
}

// =============================================================================
// Resume — re-run only what did not finish (Issue #98)
// =============================================================================
//
// A partial failure inside a wave is the normal case in parallel development:
// one issue of three fails while the other two are finished AND judged. Before
// this the only way forward was to re-plan and dispatch all three again, which
// re-runs a worker over a deliverable a gate already passed and throws away the
// verdict that passed it — the exact opposite of what the verification gate is
// for. `--resume <prior-out-dir>` splits the plan in two instead:
//
//   carried      `worker_state: completed` AND `verification.outcome: pass`.
//                NOT re-dispatched. Its verification record is TRANSCRIBED into
//                the new report, because merge and uat read exactly those two
//                fields and nothing else — a carried issue therefore stays
//                eligible for delivery without anything being re-judged here.
//   re-dispatch  everything else: failed, timed out, prompted, never dispatched,
//                a verdict that was not a pass, or no record at all.
//
// The wave barrier is RECOMPUTED, not replayed. A wave whose issues were all
// carried dispatches nothing and advances immediately, so an issue whose
// dependency already passed is dispatched at once instead of behind a worker
// that has nothing left to do. Everything else is the ordinary dispatch path,
// unchanged and deliberately so: the drift re-check before every mutating wave,
// the verification gate, the stop conditions, the exit codes, and Auto-Yes
// staying off. A resume is not a weaker run — it is the same run over a smaller
// issue set.
//
// Artifacts are APPENDED, never overwritten — the shape the UAT fix loop already
// uses for its attempt history. references/dispatch-contract.md section 8 defines
// the layout and states which report merge/uat/status must read.

// =============================================================================
// Reverify — re-judge what is already there, without sending (Issue #121)
// =============================================================================
//
// `--resume` gave the recovery path Issue #89 was missing, but it recovers by
// RE-DISPATCHING. In #89's situation that is the wrong instrument: the worker
// timed out, then finished and committed anyway, and the only thing that is
// stale is the VERDICT frozen into the report. Re-dispatching there spends a
// worker turn on work that is done and hands the contract back to a worker that
// has no reason to touch anything — room for a diff nobody asked for.
//
// `--reverify <prior-out-dir>` splits the plan the same way `--resume` does and
// then does the opposite thing with the second half:
//
//   carried    `worker_state: completed` AND `verification.outcome: pass`.
//              Transcribed, exactly as on a resume, and NOT re-judged. Identical
//              code (`isCarryable` / `carriedWorkerRecord`) on purpose: the two
//              flags must not disagree about who is already finished.
//   re-judged  the rest, RESTRICTED to the issues whose worktree still holds
//              work. Put through the verification gate as they stand.
//   left       the rest of the rest — no work evidence. The prior record is
//              transcribed unchanged and a limitation says why.
//
// `send` is never called. That is the whole reason the flag exists, and it is
// what the fixtures pin (`sent: []`).
//
// WHAT COUNTS AS "THERE IS WORK HERE" (the one thing this must not guess).
// It is the work-evidence gate's own criterion, and nothing else: A COMMIT ON
// THE WORK BRANCH, OR AN UNCOMMITTED CHANGE IN THE WORKTREE. CommandMate's
// work-evidence gate counts exactly those two facts, `wait --verify`'s exit 21
// is that gate finding neither, and this repository's own work-evidence check
// asks the same question. Three reasons it is measured HERE, with git, rather
// than inferred or delegated:
//
//   1. The prior report cannot answer it. A `timeout` worker's record says
//      `verification.outcome: not_run` — the gate never ran, so the report holds
//      no measurement at all. Reading "timed out" as "probably has work" is the
//      guess the Issue forbids.
//   2. Delegating it to `commandmate verify` would make the answer arrive as a
//      VERDICT (exit 21 = fail). Recording that would DOWNGRADE the record of an
//      issue nobody ever worked on, on the strength of a run this flag exists to
//      avoid making. The adjudication rules are fixed (exit 21 means what it has
//      always meant), so the only way to keep them fixed is not to ask.
//   3. It must hold on the fallback path too. Without an execution contract the
//      judge is the profile baseline, which measures the deliverable and knows
//      nothing about work evidence; a criterion that only existed under a
//      contract would make `--reverify` mean two different things.
//
// The measurement is fail-closed: a worktree whose commits AND whose status
// cannot be read is NOT re-judged (`reverify_evidence_unreadable`). "We could not
// look" is not "there is something there".
//
// THE VERDICT is taken from the same judge the ordinary path uses, in the same
// mode: `commandmate verify <worktree-id> --json` under a contract (whose exit
// code IS the verdict, 0/20/21/99 with the meanings section 2.1 already fixes),
// and the profile-baseline re-run without one. No new CLI surface is asked for.
//
// COMPLETION stays what it has always been: a commit on the work branch. A
// re-judged issue is `completed` when the branch carries one — which is what
// makes it eligible for merge again — and keeps its prior state when the work in
// the tree is uncommitted, because nothing downstream can deliver an uncommitted
// change and this flag cannot ask for the commit (it does not send).
//
// THE EXCLUSIVITY LOCK IS TAKEN, on the same terms as any other unattended run
// (ADR section 14.1). Adjudicated rather than assumed: the flag sends nothing,
// so no second SUPERVISOR appears — but `commandmate verify` RUNS THE
// REPOSITORY'S GATES INSIDE THE WORKTREE, and the verdict it produces is written
// into a report that merge reads as eligibility. Judging a tree another run's
// worker is actively writing to yields a verdict about a state that never
// existed as a deliverable, and then delivers it. The lock's granularity is
// already "one supervisor per worktree" for that reason; a reader-that-judges is
// inside it. Carried issues are excluded from the lock set exactly as on a
// resume — their worktree is never touched and may legitimately be gone.
//
// Everything else is deliberately unchanged: the attempt layout
// (`resume-attempt-<n>/`, append-only, one ledger line), the consistency guards
// (a report from another plan or one that cannot be read is refused before
// anything is probed), the exit codes, and `dispatch_schema_version` staying 1.

// The two operations that read a prior dispatch report back in. They are the
// same refusals reached through different flags, so the wording is parameterised
// instead of duplicated — a second copy is a second thing to keep true.
const RESUME_OP = {
  flag: '--resume',
  verb: 'resume',
  verbed: 'resumed',
  because: 'A resume carries verification verdicts forward as fact',
};
const REVERIFY_OP = {
  flag: '--reverify',
  verb: 'reverify',
  verbed: 're-judged',
  because: 'A reverify carries the passing verdicts forward as fact and re-judges the rest against the same report',
};

function resumeAttemptDir(outDir, attempt) {
  return join(outDir, `${RESUME_ATTEMPT_PREFIX}${attempt}`);
}

// This attempt's report, as a path relative to the run directory. Relative on
// purpose: it goes into a report field a human reads, and an absolute host path
// there is redacted to `[REDACTED-PATH]`, which names nothing.
function attemptReportRelative(attempt) {
  return attempt === 1 ? DISPATCH_REPORT_FILE : `${RESUME_ATTEMPT_PREFIX}${attempt}/${DISPATCH_REPORT_FILE}`;
}

function attemptSummaryRelative(attempt) {
  return attempt === 1 ? DISPATCH_SUMMARY_FILE : `${RESUME_ATTEMPT_PREFIX}${attempt}/${DISPATCH_SUMMARY_FILE}`;
}

// The attempt this resume becomes: the first number whose directory does not
// exist yet. Derived from the DIRECTORY rather than from the history ledger, so a
// missing, truncated or hand-edited ledger can never make a run overwrite an
// artifact — the one thing the append-only rule exists to prevent.
function nextAttemptNumber(outDir) {
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (!existsSync(resumeAttemptDir(outDir, attempt))) return attempt;
  }
  // `out_exists` rather than a resume-specific code: the finding is the one that
  // code already names — every output location this run could claim is taken.
  throw new SkillError('out_exists',
    `${outDir} already holds ${MAX_ATTEMPTS - 1} resume attempts; refusing to append another`, 4);
}

// The report a resume reads: the NEWEST attempt in the directory. Each attempt
// re-states what it carried over, so the newest report alone is the whole
// picture — which is the same rule merge, uat and the status matrix follow.
function priorReport(outDir, op = RESUME_OP) {
  if (!existsSync(outDir)) {
    throw new SkillError('load_error',
      `${op.flag} ${outDir} does not exist; it must be the --out directory of the dispatch being ${op.verbed}`, 6);
  }
  let newest = { path: join(outDir, DISPATCH_REPORT_FILE), attempt: 1 };
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const candidate = join(resumeAttemptDir(outDir, attempt), DISPATCH_REPORT_FILE);
    if (!existsSync(candidate)) break;
    newest = { path: candidate, attempt };
  }
  if (!existsSync(newest.path)) {
    throw new SkillError('load_error',
      `${op.flag} ${outDir} holds no ${DISPATCH_REPORT_FILE}; there is no dispatch run there to ${op.verb}`, 6);
  }
  return newest;
}

// Conformance of the report being resumed, limited to what the carry-over
// depends on. The dispatch report is this runner's OWN artifact, but on the way
// back in it is an INPUT — possibly hand-edited, possibly from another
// producer — and a resume turns it into claims about what is finished. So it is
// checked rather than trusted, and a shape that cannot be checked is refused
// rather than half-read. Returns null when usable, or the reason it is not.
function resumeNonConformance(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'it is not a JSON object';
  if (doc.dispatch_schema_version !== DISPATCH_SCHEMA_VERSION) {
    return `its dispatch_schema_version is ${JSON.stringify(doc.dispatch_schema_version)}; this runner understands ${DISPATCH_SCHEMA_VERSION}`;
  }
  if (doc.skill_id !== SKILL_ID) return `its skill_id is ${JSON.stringify(doc.skill_id)}, not ${SKILL_ID}`;
  if (typeof doc.plan_run_id !== 'string' || doc.plan_run_id.length === 0) return 'it carries no plan_run_id';
  if (doc.profile === null || typeof doc.profile !== 'object' || Array.isArray(doc.profile)) return 'it carries no profile object';
  if (typeof doc.profile.repository !== 'string' || typeof doc.profile.base !== 'string') {
    return 'its profile names no repository/base, so it cannot be checked against the plan';
  }
  if (!Array.isArray(doc.waves)) return 'its waves is not an array';
  for (const wave of doc.waves) {
    if (wave === null || typeof wave !== 'object' || !Array.isArray(wave.workers)) return 'a wave carries no workers array';
    for (const worker of wave.workers) {
      if (worker === null || typeof worker !== 'object' || Array.isArray(worker)) return 'a worker record is not an object';
      if (!Number.isInteger(worker.issue)) return 'a worker record carries no integer issue number';
      if (typeof worker.worker_state !== 'string') return `#${worker.issue} carries no worker_state`;
      const verification = worker.verification;
      if (verification === null || typeof verification !== 'object' || Array.isArray(verification) || typeof verification.outcome !== 'string') {
        return `#${worker.issue} carries no verification.outcome`;
      }
    }
  }
  return null;
}

function loadResumeReport(path, plan, op = RESUME_OP) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SkillError('load_error', `cannot read the dispatch report at ${path}: ${redact(error.message)}`, 6);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new SkillError('resume_invalid',
      `the report at ${path} cannot be ${op.verbed}: it is not valid JSON (${redact(error.message)}). ` +
        `${op.because}, so a report this runner cannot read is refused rather than partly believed`, 3);
  }
  const nonConformance = resumeNonConformance(doc);
  if (nonConformance !== null) {
    throw new SkillError('resume_invalid',
      `the report at ${path} is not a dispatch report v${DISPATCH_SCHEMA_VERSION} this runner can ${op.verb}: ${nonConformance}. ` +
        `${op.because}, so a report whose shape cannot be checked is refused rather than partly believed`, 3);
  }
  // The plan guard (Issue #98 item 2). run_id is the plan's identity; repository
  // and base are the two profile fields the report copies out of it, so a report
  // that agrees on all three was produced FOR THIS PLAN. Refusing the rest is not
  // pedantry: carrying a foreign report's records over would state that issues of
  // THIS plan are completed and verified on the strength of work planned
  // elsewhere, and merge would then open PRs for them.
  if (doc.plan_run_id !== plan.run_id
    || doc.profile.repository !== plan.profile.repository
    || doc.profile.base !== plan.profile.base) {
    throw new SkillError('resume_plan_mismatch',
      `the report at ${path} was produced for plan run_id "${redact(String(doc.plan_run_id))}" ` +
        `(${redact(String(doc.profile.repository))} / ${redact(String(doc.profile.base))}), but --plan is run_id "${plan.run_id}" ` +
        `(${plan.profile.repository} / ${plan.profile.base}). Refusing to ${op.verb} a different plan's run: the carried-over records would ` +
        'claim that issues of THIS plan are completed and verified on the strength of work that was planned somewhere else. ' +
        `Point ${op.flag} at that plan's own dispatch directory, or start a fresh dispatch with --out`, 3);
  }
  return doc;
}

// The record each issue carries in the prior report, newest wins — the same
// "last record wins" rule merge.mjs reads a re-dispatched issue by.
function priorWorkerRecords(doc) {
  const latest = new Map();
  for (const wave of doc.waves) {
    for (const worker of wave.workers) latest.set(worker.issue, worker);
  }
  return latest;
}

// The one condition that means "do not run this again": the worker finished AND
// a gate judged it and passed. Exactly the pair merge/uat read, so an issue this
// returns true for is an issue already on the delivery path.
function isCarryable(worker) {
  return worker.worker_state === 'completed'
    && worker.verification !== null
    && typeof worker.verification === 'object'
    && worker.verification.outcome === 'pass';
}

// Re-cap a prior record's `gates` / `checks` on the way into a new report, and
// say what THIS cut ate (Issue #171). A bare `.slice(0, MAX_REPORTED_GATES)` on
// `checks` is not the harmless no-op it looks like: since #165 the line that says
// a gate list was cut is APPENDED TO THE TAIL of `checks`, so re-slicing at the
// same bound drops the truncation note first and a transcribed record that lost
// entries reads as one that never lost any — the exact reading #165 closed.
//
// MEASURED, against the issue's wording: the loss needs `checks.length` to EXCEED
// the bound, not merely reach it (at exactly 50 the slice is a no-op). It is a
// live path all the same — `describeFailingGates` writes one check line per
// failing gate and is not itself capped, so a run with 50+ failing gates records
// 51+ checks with #165's note last, and a later `--reverify` transcribes it.
//
// Both counts say "cut HERE" on purpose: `gates` was very likely already capped
// upstream by `capGates`, whose own note is one of the check lines being copied,
// and this number must not be read as the run's total loss. One window slot is
// reserved per note, so the transcribed list still fits the bound it explains.
function transcribeCapped(gates, checks) {
  const notes = [];
  const gatesDropped = Math.max(0, gates.length - MAX_REPORTED_GATES);
  if (gatesDropped > 0) {
    notes.push(`the transcribed gate list was cut to ${MAX_REPORTED_GATES} entries HERE; `
      + `${gatesDropped} further gate(s) recorded by the prior report are not carried forward`);
  }
  const room = MAX_REPORTED_GATES - notes.length;
  const checksDropped = checks.length > room ? checks.length - (room - 1) : 0;
  const kept = checksDropped > 0 ? checks.slice(0, room - 1) : checks;
  if (checksDropped > 0) {
    notes.push(`the transcribed check list was cut to ${MAX_REPORTED_GATES} entries HERE; `
      + `${checksDropped} further check line(s) recorded by the prior report are not carried forward `
      + '(anything that report noted about ITS OWN cut may be among them)');
  }
  return { gates: gates.slice(0, MAX_REPORTED_GATES), checks: [...kept, ...notes] };
}

// A carried worker record for the new report. The verification is TRANSCRIBED,
// never re-judged: this attempt ran no gate against this issue, so it may only
// repeat what the attempt that did ran, and it says so in the note. Every field
// is re-validated on the way through because the source is an input — a
// hand-edited report must not be able to write a record the dispatch schema
// rejects, which would make the whole new report unreadable.
function carriedWorkerRecord(prior, priorAttempt) {
  const verification = prior.verification;
  const { gates, checks } = transcribeCapped(
    (Array.isArray(verification.gates) ? verification.gates : [])
      .filter((gate) => gate !== null && typeof gate === 'object'
        && typeof gate.id === 'string' && gate.id.length > 0
        && (gate.verdict === 'pass' || gate.verdict === 'fail'))
      .map((gate) => (gate.origin === 'repo' || gate.origin === 'issue'
        // Carried, never invented: a report written before origin existed has none,
        // and filling one in here would turn "nobody recorded this" into a claim
        // about where the gate came from (ADR §8.2).
        ? { id: redact(gate.id), verdict: gate.verdict, origin: gate.origin }
        : { id: redact(gate.id), verdict: gate.verdict })),
    (Array.isArray(verification.checks) ? verification.checks : [])
      .filter((check) => typeof check === 'string' && check.length > 0)
      .map((check) => redact(check)),
  );
  const worker = {
    issue: prior.issue,
    task_id: typeof prior.task_id === 'string' && prior.task_id.length > 0 ? redact(prior.task_id) : null,
    worker_state: 'completed',
    verification: {
      ran: verification.ran === true,
      report_schema_version: Number.isInteger(verification.report_schema_version) ? verification.report_schema_version : null,
      outcome: 'pass',
      gates,
      checks,
    },
    // A carried issue raised no prompt in THIS attempt; a prompt from an earlier
    // one was either answered or is not what carried it (a prompted worker is
    // never `completed`). Carrying the flag forward would halt a run for a human
    // who has nothing left to look at.
    prompt: { detected: false, excerpt: null },
    note: redact(typeof prior.note === 'string' ? prior.note : ''),
  };
  worker.note = appendNote(worker.note,
    `carried over from attempt ${priorAttempt}: this attempt did NOT re-dispatch #${prior.issue} — its worker completed and its ` +
      'verification passed there, and that verdict is transcribed here rather than re-run');
  return worker;
}

// The worker_state values the report schema allows. Needed only where a prior
// report's value is copied forward: the conformance check asserts the field is a
// string, and a hand-edited one that is a string but not a state must not be
// able to make THIS report unreadable.
const WORKER_STATE_VALUES = ['completed', 'failed', 'timeout', 'prompt', 'not_dispatched'];

// A prior worker's verification, re-validated on the way through. Same reasoning
// as `carriedWorkerRecord`'s — the report is an INPUT here — but unlike that one
// this transcribes the verdict AS IT STANDS. A reverify repeats what the prior
// attempt found for the issues it does not re-judge; it never promotes them.
function transcribedVerification(verification) {
  const source = (verification !== null && typeof verification === 'object' && !Array.isArray(verification)) ? verification : {};
  // Same bound, and the same reason it may not be applied silently (Issue #171).
  const { gates, checks } = transcribeCapped(
    (Array.isArray(source.gates) ? source.gates : [])
      .filter((gate) => gate !== null && typeof gate === 'object'
        && typeof gate.id === 'string' && gate.id.length > 0
        && (gate.verdict === 'pass' || gate.verdict === 'fail'))
      .map((gate) => (gate.origin === 'repo' || gate.origin === 'issue'
        ? { id: redact(gate.id), verdict: gate.verdict, origin: gate.origin }
        : { id: redact(gate.id), verdict: gate.verdict })),
    (Array.isArray(source.checks) ? source.checks : [])
      .filter((check) => typeof check === 'string' && check.length > 0)
      .map((check) => redact(check)),
  );
  return {
    ran: source.ran === true,
    report_schema_version: Number.isInteger(source.report_schema_version) ? source.report_schema_version : null,
    // Anything that is not one of the two verdicts is `not_run`, which is what
    // the schema already means by it: nothing judged this.
    outcome: (source.outcome === 'pass' || source.outcome === 'fail') ? source.outcome : 'not_run',
    gates,
    checks,
  };
}

// A prior worker's prompt, re-validated the same way. Transcribed rather than
// cleared (which is what a CARRIED record does): a prompt the prior attempt
// stopped on is still pending in that worktree, and a reverify did not answer
// it — it does not send.
function transcribedPrompt(prompt) {
  const source = (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt)) ? prompt : {};
  const text = typeof source.excerpt === 'string' && source.excerpt.length > 0 ? redact(source.excerpt) : null;
  return { detected: source.detected === true, excerpt: text };
}

// The whole resume (or reverify) decision, computed once before anything is
// probed or written. `mode` selects which of the two this attempt is; the SPLIT
// is identical in both — same carry-over rule, same "everything else" set — and
// only what the second half is then subjected to differs (Issue #121).
function buildResume(inputs, plan, mode = 'resume') {
  const reverifying = mode === 'reverify';
  const dir = reverifying ? inputs.reverifyDir : inputs.resumeDir;
  const op = reverifying ? REVERIFY_OP : RESUME_OP;
  const prior = priorReport(dir, op);
  const doc = loadResumeReport(prior.path, plan, op);
  const latest = priorWorkerRecords(doc);

  const carried = new Map();
  // Per plan wave, the issues this attempt still has to dispatch. Not truncated
  // here: the wave loop applies the max_parallel bound itself, and doing it in
  // one place is what keeps the bound the same rule on both paths.
  const waveDispatch = [];
  for (const wave of plan.waves) {
    const pending = [];
    for (const number of wave) {
      const record = latest.get(number);
      if (record !== undefined && isCarryable(record)) carried.set(number, carriedWorkerRecord(record, prior.attempt));
      else pending.push(number);
    }
    waveDispatch.push(pending);
  }

  const attempt = nextAttemptNumber(dir);
  return {
    mode,
    reverifying,
    dir,
    attempt,
    attemptDir: resumeAttemptDir(dir, attempt),
    priorAttempt: prior.attempt,
    priorRelative: attemptReportRelative(prior.attempt),
    carried,
    carriedIssues: [...carried.keys()].sort((a, b) => a - b),
    // The prior record of every issue, carried and not. A reverify needs the
    // not-carried ones too: an issue it does not re-judge is transcribed as it
    // stood rather than blanked, so the report keeps saying what the attempt
    // that DID dispatch it found.
    priorRecords: latest,
    waveDispatch,
    redispatchIssues: waveDispatch.flat(),
    firstActiveWave: waveDispatch.findIndex((entries) => entries.length > 0),
  };
}

// The `resumed_from` + attempt-number record the Issue asks the report to carry.
// It lives in `limitations` rather than in a new top-level field on purpose: the
// dispatch report is a CLOSED schema whose reader set (merge, uat, status) is
// versioned on it, and the same adjudication was already made for the execution
// contract (#1588) — a run-specific fact goes into limitations / blocking_reasons
// / note / summary_markdown, and `dispatch_schema_version` stays 1. The full
// machine-readable record is the attempt-history ledger beside the report.
function resumeLimitation(plan, resume) {
  const list = (numbers) => (numbers.length === 0 ? 'なし' : numbers.map((n) => `#${n}`).join(', '));
  // The reverify twin (Issue #121). Its own code, because the two attempts are
  // not the same event and a reader that grepped `resume_attempt` must not find
  // an attempt that dispatched nobody. The carry-over half is worded identically
  // because it IS identical.
  if (resume.reverifying) {
    return {
      code: 'reverify_attempt',
      detail: `--reverify: attempt ${resume.attempt} of plan ${plan.run_id}; resumed_from=${resume.priorRelative} (attempt ${resume.priorAttempt}). `
        + `NOTHING WAS SENT: this attempt called no \`commandmate send\`, wrote no execution contract and consumed no worker turn. `
        + `Carried over without re-judging (worker completed and verification passed there): ${list(resume.carriedIssues)}. `
        + `Re-judged here from the worktree as it stands, if it holds work evidence (a commit on the work branch or an uncommitted change): ${list(resume.redispatchIssues)}. `
        + `The carried verification records are transcribed from that report and were NOT re-judged; `
        + `this attempt's artifacts are under ${RESUME_ATTEMPT_PREFIX}${resume.attempt}/ and no earlier attempt was overwritten`,
    };
  }
  return {
    code: 'resume_attempt',
    detail: `--resume: attempt ${resume.attempt} of plan ${plan.run_id}; resumed_from=${resume.priorRelative} (attempt ${resume.priorAttempt}). `
      + `Carried over without re-dispatching (worker completed and verification passed there): ${list(resume.carriedIssues)}. `
      + `Re-dispatched here: ${list(resume.redispatchIssues)}. The carried verification records are transcribed from that report and were NOT re-judged; `
      + `this attempt's artifacts are under ${RESUME_ATTEMPT_PREFIX}${resume.attempt}/ and no earlier attempt was overwritten`,
  };
}

// One line per attempt, appended at the run directory's root. Best effort: the
// ledger is evidence about the run, never part of deciding it, so a filesystem
// that will not take the line must not fail a dispatch that already happened.
function appendAttemptHistory(outDir, entry) {
  try {
    appendFileSync(join(outDir, ATTEMPT_HISTORY_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // ignored on purpose; see above
  }
}

// =============================================================================
// CLI invocation
// =============================================================================

// The wall-clock deadline of this invocation, or null when no budget was set
// (Issue #122 / ADR section 14.2). Module state rather than a field on `inputs`
// because the two functions that have to honour it — `runCli` and its async twin
// — are module-level and are called from places that hold no `inputs`.
//
// Issue #115 measured why the budget cannot live in the supervision loop alone:
// `runCli` passes no `timeout` to `execFileSync`, so a profile baseline of
// `sleep 6` runs for six seconds with `--wait-timeout 1`. A budget checked only
// between turns would never be reached by a run wedged inside such a child. The
// order the spike prescribed ("first the child timeout, then the budget") is
// implemented as ONE rule: the remaining budget IS every child's timeout.
let wallClockDeadline = null;

function startWallClockBudget(seconds) {
  wallClockDeadline = typeof seconds === 'number' ? Date.now() + (seconds * 1000) : null;
}

function wallClockExhausted() {
  return wallClockDeadline !== null && Date.now() >= wallClockDeadline;
}

// A caller's own `timeout` always wins: this bounds children that have no bound,
// it does not lengthen one that was chosen deliberately.
function budgetedExtra(extra) {
  if (wallClockDeadline === null || extra.timeout !== undefined) return extra;
  return { ...extra, timeout: Math.max(1, wallClockDeadline - Date.now()) };
}

// One structured call to an external CLI. Never throws: a non-zero exit or a
// missing binary comes back as { ok: false }, so the caller decides whether that
// is drift, a worker failure, or fatal.
function runCli(bin, args, extra = {}) {
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      ...budgetedExtra(extra),
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

const execFileAsync = promisify(execFile);

// The async twin of runCli, used only by the per-worker supervision path so that a
// whole wave's `commandmate wait` calls — each of which blocks until its worker
// idles — run CONCURRENTLY instead of one worker at a time (Issue #1474). It keeps
// runCli's non-throwing contract and the same { ok, stdout, stderr, status } shape,
// so the supervision code reads identically to the sync version. The sync runCli
// still backs the preflight drift checks and the post-barrier verification, which
// stay synchronous. NOTE: promisified execFile surfaces a non-zero exit as
// error.code (a number) where execFileSync used error.status; a spawn failure keeps
// a string code (e.g. "ENOENT"). Normalizing to a numeric `status` lets the wait
// exit-code checks (prompt 10 / timeout 124) read exactly as the sync path does.
//
// The SUCCESS branch keeps stderr (#160). A CLI that exits 0 still says things on
// stderr — `commandmate wait --verify` prints its whole `GATE <id> PASS|FAIL`
// report there — and dropping it as `''` made every contract-path pass record an
// empty `verification.gates`. The sync runCli above cannot do the same: execFileSync
// returns stdout ALONE on success, so its `stderr: ''` is an API limit, not a
// choice. Nothing reads GATE lines off the sync path, which is why it stays as is.
async function runCliAsync(bin, args, extra = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      ...budgetedExtra(extra),
    });
    return { ok: true, stdout, stderr, status: 0 };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: error.stderr ? error.stderr.toString() : redact(error.message ?? ''),
      status: typeof error.code === 'number' ? error.code : (error.status ?? null),
    };
  }
}

// One call to the CommandMate CLI. The launcher may carry fixed leading
// arguments (`npx commandmate@latest` is program "npx" plus one argument), so
// the subcommand is appended to it rather than passed as the whole argv. Every
// commandmate spawn in this runner goes through these two — a direct
// runCli(inputs.cli, …) would pass the launcher string as a program name and
// reintroduce the ENOENT this replaced (Issue #37).
function runCm(inputs, args, extra = {}) {
  return runCli(inputs.cliArgv[0], [...inputs.cliArgv.slice(1), ...args], extra);
}

function runCmAsync(inputs, args, extra = {}) {
  return runCliAsync(inputs.cliArgv[0], [...inputs.cliArgv.slice(1), ...args], extra);
}

// =============================================================================
// Drift re-check (branch / HEAD / worktree / permission)
// =============================================================================

// Re-run before every wave. `blocking` checks that fail stop the dispatch;
// non-blocking failures are recorded as limitations so the operator sees them
// without the run stalling on something a just-in-time setup step will fix.
// `resolutions` is the wave's up-front worktree resolution (id + real path from
// `commandmate ls`), so `worktrees_present` can judge reachability the same way
// the supervisor does — by a live branch match — instead of string-matching the
// plan's template path against `git worktree list` (Issue #1473).
//
// Returns the checks AND the resolutions that did not resolve, because the two
// are one finding: `worktrees_present` counts them, and the caller names each of
// them in a `worktree_unresolved` blocking reason (Issue #90).
function driftChecks(inputs, plan, waveIndex, resolutions) {
  const checks = [];
  const add = (code, ok, blocking, detail) =>
    checks.push({ wave_index: waveIndex, code, ok, blocking, detail });

  const cli = runCm(inputs, ['--version']);
  add('cli_available', cli.ok, true, cli.ok ? 'commandmate CLI is runnable' : 'commandmate CLI is not runnable (permission or install)');

  const repo = runCli(inputs.gh, ['repo', 'view', plan.profile.repository, '--json', 'nameWithOwner']);
  add('repo_access', repo.ok, true, repo.ok ? `repo ${plan.profile.repository} is reachable` : `cannot reach repo ${plan.profile.repository} (permission)`);

  const base = runCli(inputs.git, ['rev-parse', '--verify', plan.profile.base]);
  add('base_resolvable', base.ok, true, base.ok ? `base ${plan.profile.base} resolves` : `base ${plan.profile.base} no longer resolves (drift)`);

  if (inputs.expectBranch) {
    const head = runCli(inputs.git, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = head.ok ? head.stdout.trim() : '';
    const matches = head.ok && current === inputs.expectBranch;
    add('branch_matches', matches, true, matches ? `HEAD is on ${inputs.expectBranch}` : `HEAD is "${current || 'unknown'}", expected ${inputs.expectBranch} (drift)`);
  }

  const dirty = runCli(inputs.git, ['status', '--porcelain']);
  const clean = dirty.ok && dirty.stdout.trim() === '';
  add('integration_clean', clean, false, clean ? 'integration worktree is clean' : 'integration worktree has uncommitted changes');

  const listed = runCli(inputs.git, ['worktree', 'list', '--porcelain']);
  const registered = listed.ok ? listed.stdout : '';
  // A planned worktree is "present" if `commandmate ls` resolved its branch to a
  // registered worktree id (the same reachability the supervisor relies on) OR its
  // template path shows up in `git worktree list`. Resolving by branch means a
  // worktree registered under a path that differs from the plan template no longer
  // false-NGs here and silently masks a real dispatch (Issue #1473).
  const unresolved = resolutions.filter((r) => {
    if (r.resolved && r.resolved.id) return false;
    const target = r.templatePath ?? '';
    return !(target && registered.includes(target.replace(/^\.\.\//, '')));
  });
  const present = unresolved.length === 0;
  // BLOCKING since Issue #90. It used to be a limitation the run continued past,
  // which is the one shape where continuing cannot help: a worktree the CLI
  // cannot resolve has no `send` target, so every issue behind it is recorded
  // `failed` without a single worker having been started. Refusing here is what
  // makes the report say `worktree_unresolved` instead of `worker_failed`, and
  // — because the pre-flight runs before the run directory exists — what leaves
  // the same `--out` free for the re-run after the worktree is created.
  add('worktrees_present', present, true, present ? 'planned worktrees resolve (commandmate ls branch match or git worktree list)' : `${unresolved.length} planned worktree(s) neither resolve via commandmate ls nor appear in git worktree list`);

  return { checks, unresolved };
}

// The two paths a worker-method Skill has to occupy in one worktree, in a fixed
// order so every message, every contract and every limitation names them the same
// way. Relative on purpose: they go into a contract a worker reads, and the
// worktree they are relative to is the worker's own cwd.
function workerMethodPaths(skillId) {
  return WORKER_METHOD_ROOTS.map((root) => `${root}/${skillId}/${WORKER_METHOD_ENTRY}`);
}

// Is the Skill really in this worktree? The same shape as the acceptance-gate
// probe (#114): read the worktree the `ls` resolution named, decide from what is
// actually there, and never from what the plan or the operator asserted.
//
// A path that cannot be stat'ed counts as missing rather than as an error. The
// question here is only "can a worker open this file", and every way the answer
// is no — absent, a directory, unreadable — has the same fix and the same
// consequence.
function probeWorkerMethod(worktreePath, skillId) {
  const found = [];
  const missing = [];
  for (const relative of workerMethodPaths(skillId)) {
    let readable = false;
    try {
      readable = statSync(join(worktreePath, relative)).isFile();
    } catch {
      readable = false;
    }
    (readable ? found : missing).push(relative);
  }
  return { ok: missing.length === 0, found, missing };
}

// Probe every issue of a wave whose worktree actually resolved. An issue whose
// worktree could not be resolved is already reported as `worktree_unresolved`;
// re-reporting it here as a missing Skill would name the wrong fix.
function workerMethodUnavailable(inputs, resolutions) {
  if (inputs.workerMethod === null) return [];
  return resolutions
    .filter((entry) => entry.templatePath !== null && entry.resolved.id !== null && Boolean(entry.worktreePath))
    .map((entry) => ({ number: entry.number, probe: probeWorkerMethod(entry.worktreePath, inputs.workerMethod) }))
    .filter((entry) => !entry.probe.ok);
}

// One blocking reason per issue whose worktree does not carry the Skill (ADR
// section 3.4). All-or-nothing: dispatching only the workers that happen to have
// it would make "the whole wave passed" mean something different in every run,
// which is the promise the wave barrier is built on (#93 論点2).
function workerMethodUnavailableReasons(entries, skillId) {
  return entries.map(({ number, probe }) => ({
    code: 'worker_method_unavailable',
    detail: redact(`#${number}: --worker-method ${skillId} was requested, but this worktree does not carry ${probe.missing.join(' or ')}`
      + `${probe.found.length > 0 ? ` (it does carry ${probe.found.join(', ')}, which is only half an install: the other Agent cannot see it, and this runner never learns which Agent takes the task)` : ''}`
      + `. Nothing was dispatched — a run started with --worker-method is a run whose premise is that the method is in place, and a contract naming a file the worker cannot open would state something this runner cannot measure. `
      + `Run \`commandmate skill install ${skillId}\` for this worktree and re-run the same command, or drop --worker-method`),
  }));
}

// The run-wide declaration (ADR section 9). One entry, recorded whether or not
// the run goes on to dispatch anything, because "this run was started with a
// method" is what every other line of the report is read against.
function workerMethodDeclaredLimitation(skillId) {
  return {
    code: 'worker_method_declared',
    detail: `--worker-method ${skillId}: this run declares a worker-side development method. Before dispatching, each worktree is checked for ${workerMethodPaths(skillId).join(' and ')}, and every dispatched issue's task text carries a \`## Method\` section naming them. `
      + 'The method adds HOW only: it does not widen scope.allow, relax a gate or authorise a push or PR — where the two disagree the contract wins. '
      + 'This records that the reference was DECLARED; whether a worker actually followed the method is not measured by dispatch',
  };
}

// One blocking reason per unresolved worktree (Issue #90). A single aggregate
// count ("2 planned worktrees do not resolve") tells an operator that something
// is missing but not WHICH issue to create a worktree for, and the branch is the
// only handle `cmate-worktree-setup` takes. `entries` are drift resolutions;
// `resolved.note` already carries the redacted branch.
function worktreeUnresolvedReasons(entries) {
  return entries.map((entry) => ({
    code: 'worktree_unresolved',
    detail: redact(`#${entry.number}: ${entry.resolved?.note || 'no registered worktree resolved for this issue'}`),
  }));
}

// The blocking pre-flight (Issue #90): the first wave's worktree resolution and
// its drift re-check, run BEFORE the run directory is created. It is the same
// check the wave loop performs — the loop reuses this result for wave 0 rather
// than probing the world twice — moved earlier for one reason: a refusal must
// not consume `--out`. The old order created `<plan-dir>/dispatch` first, so a
// run refused for a missing worktree left a directory behind and the re-run
// (after `cmate-worktree-setup` created that worktree) died on `out_exists`
// with the operator's only recourse being to invent a new `--out`.
//
// `waveIndex` / `waveIssues` name the first wave this run will actually
// dispatch. On an ordinary run that is wave 0 and the whole of it; on a resume
// (Issue #98) it is the first wave with anything left to do, holding only the
// issues that were not carried over — a carried issue's worktree may well have
// been removed after its branch was merged, and demanding it resolve would
// refuse a run that has no reason to touch it.
function preflightDispatch(inputs, plan, waveIndex, waveIssues) {
  const resolutions = resolveWave(inputs, plan, waveIssues);
  const { checks, unresolved } = driftChecks(inputs, plan, waveIndex, resolutions);
  const blocking = checks.find((check) => check.blocking && !check.ok);
  // The worker-method probe, and why it is HERE (Issue #128 / ADR section 3.4).
  // A missing method Skill is refused on the same terms #90 refuses a missing
  // worktree: before the run directory exists, so the fix (`skill install`) is
  // followed by the SAME command rather than by inventing a new `--out`.
  // Only reached when the world is otherwise sound — a worktree that did not
  // resolve has no path to probe, and its own reason already names the fix.
  const methodMissing = blocking ? [] : workerMethodUnavailable(inputs, resolutions);
  const reasons = blocking
    ? (blocking.code === 'worktrees_present' && unresolved.length > 0
      ? worktreeUnresolvedReasons(unresolved)
      : [{ code: `drift_${blocking.code}`, detail: blocking.detail }])
    : workerMethodUnavailableReasons(methodMissing, inputs.workerMethod);
  return {
    waveIndex,
    resolutions,
    checks,
    unresolved,
    blocked: Boolean(blocking) || methodMissing.length > 0,
    reasons,
  };
}

// The report a blocked pre-flight prints. `out_dir` is null because nothing was
// written — the field already means "null when nothing was written", and it is
// how a reader (and the summary) can tell that the same command may simply be
// re-run once the drift is fixed.
function preflightFailureReport(inputs, plan, preflight, preparation = null, resume = null, lockKeys = []) {
  const report = emptyReport(inputs, plan, null);
  report.status = 'failure';
  // The unattended declaration outlives the refusal, exactly like the
  // worker-method one below: what a stopped run was declared to be is part of
  // reading why it stopped (Issue #122 / ADR section 7.2).
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  // A refused resume still says it WAS a resume, and what it would have carried:
  // otherwise the reader cannot tell a first attempt that stopped from a fourth
  // one, and the re-run advice below ("re-run the same command") is only true
  // because this attempt's directory was never created either (Issue #98).
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // The declaration survives the refusal: a report that stopped because the
  // method was missing must still say which method the operator asked for
  // (Issue #128 / ADR section 9).
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  // A preparation that could not run is not drift: nothing about branch, base or
  // permission moved — a conditional dependency was missing, misconfigured or
  // disagreed with the plan's profile. `dispatch_error` is the pre-dispatch stop
  // the schema already reserves for that shape (Issue #93).
  // A missing worker-method Skill is the same shape and reuses the same
  // stop_reason rather than adding one to the enum: the operator's move is
  // "install the conditional dependency and re-run", exactly as it is for #93.
  const preparationFailed = preparation !== null && preparation.reasons.length > 0;
  const methodBlocked = preflight.reasons.some((reason) => reason.code === 'worker_method_unavailable');
  report.stop_reason = preparationFailed || methodBlocked ? 'dispatch_error' : 'drift';
  report.drift_checks = preflight.checks;
  // The preparation's reasons come first: when the stage was asked for, why it
  // could not deliver a worktree is the actionable half, and "this issue has no
  // worktree" is the symptom it explains.
  report.blocking_reasons = [...(preparation?.reasons ?? []), ...preflight.reasons];
  recordPreparation(report, preparation);
  // The pre-flight is where a `commandmate sync` is most likely to have run: it is
  // the first thing that resolves worktrees. A refusal must say the registry was
  // re-scanned (or could not be) before it concluded "no registered worktree".
  recordSyncAttempt(report);
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed: preflight.checks.length > 0,
    parallelismBounded: true,
    barrierEnforced: true,
    noAutoPromptResponse: true,
    reportStatus: 'failure',
  });
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, false, [], resume);
  return report;
}

// =============================================================================
// Unattended — exclusivity, the plan-only refusal, and the undo baseline
// (Issue #122 / references/adr-unattended-mode.md sections 3, 7.2, 14.1)
// =============================================================================

// Where the per-worktree locks live. `$TMPDIR` (per user, per machine) is the
// default because the lock has to be found by EVERY starter on the machine — a
// cron job, a CI step and a person all reach the same directory. The override
// exists for a caller that needs an explicit location (and for this repository's
// fixtures, which must not touch a shared directory); a job definition that
// points it somewhere different per run has turned the lock off, which is why
// the contract says so out loud.
function lockRoot() {
  const override = process.env[LOCK_ROOT_ENV];
  return override && override.trim() !== '' ? override.trim() : join(tmpdir(), LOCK_DIR_NAME);
}

// CommandMate derives a worktree id from (repository, branch); so does this key.
// It does not have to EQUAL the server's id — nothing compares the two — it has
// to be a stable, collision-free function of the same pair, because that pair is
// what identifies the worktree before `commandmate ls` has been asked (the lock
// is taken before the pre-flight, which is where `ls` happens).
function worktreeLockKey(plan, issue) {
  const slug = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const repo = slug(String(plan.profile.repository ?? '').split('/').pop() ?? '');
  const branch = slug(issue.branch);
  const key = `${repo}-${branch}`.replace(/^-|-$/g, '');
  return (key === '' ? `issue-${issue.number}` : key).slice(0, LOCK_KEY_MAX);
}

// Is the process that wrote this lock still running? EPERM means "alive, owned
// by somebody else" — the answer is still alive, so the lock still holds.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The stale-lock rule, decided here because a lock nobody can reclaim is worse
// than no lock at all (ADR section 14.1 requires this rule to be stated):
//
//   1. the owner record names a LIVE pid on THIS host  -> held, refuse;
//   2. the owner record names a DEAD pid on this host  -> stale, reclaim. This is
//      the `kill -9` case: the run died without releasing;
//   3. the owner record names ANOTHER host             -> refuse. This process
//      cannot judge the liveness of a pid on a machine it is not on;
//   4. the owner record is missing or unreadable       -> reclaim only once the
//      directory is older than the grace period. A fresh one means a run is
//      between its `mkdirSync` and its `owner.json` write, which is microseconds.
//
// Refusing is always the safe error: it costs a re-run, while reclaiming a live
// lock costs two supervisors in one worktree — the exact state this prevents.
function lockOwnerVerdict(dir) {
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(join(dir, LOCK_OWNER_FILE), 'utf8'));
  } catch {
    owner = null;
  }
  if (owner === null || typeof owner !== 'object') {
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(dir).mtimeMs;
    } catch {
      ageMs = 0;
    }
    return ageMs >= LOCK_STALE_GRACE_MS
      ? { stale: true, why: 'its owner record is unreadable and the lock is older than the stale grace period' }
      : { stale: false, why: 'it was just created and its owner record is not written yet' };
  }
  if (owner.host !== hostname()) {
    return { stale: false, why: `it is owned by a run on another host (${redact(String(owner.host ?? 'unknown'))})` };
  }
  if (pidAlive(owner.pid)) {
    return { stale: false, why: `its owner (pid ${owner.pid}, plan ${redact(String(owner.plan_run_id ?? 'unknown'))}) is still running` };
  }
  return { stale: true, why: `its owner (pid ${owner.pid}) is gone, so the lock was left behind by a killed run` };
}

// Locks this process holds, released on exit. Only paths THIS run created are
// ever removed — a release that walked the root would delete other runs' locks.
const heldLocks = [];
let releaseRegistered = false;

function releaseUnattendedLocks() {
  for (const dir of heldLocks.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a lock that outlives its process is reclaimed by the stale
      // rule above, which is exactly the `kill -9` path.
    }
  }
}

// Take one lock, atomically. `mkdirSync` WITHOUT `recursive` fails with EEXIST
// when the directory is already there, and that failure is the mutex: there is
// no read-then-write window for a second run to slip into (the TOCTOU the ADR
// warns about). The `owner.json` write comes after, so it describes a lock that
// is already ours.
function acquireOneLock(dir, meta) {
  const create = () => {
    try {
      mkdirSync(dir);
      return { ok: true };
    } catch (error) {
      if (error.code === 'EEXIST') return { ok: false, exists: true };
      return { ok: false, exists: false, detail: redact(error.message ?? String(error)) };
    }
  };
  let attempt = create();
  if (!attempt.ok && attempt.exists) {
    const verdict = lockOwnerVerdict(dir);
    if (!verdict.stale) return { ok: false, why: verdict.why };
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, why: `it could not be reclaimed (${redact(error.message ?? String(error))})` };
    }
    // Exactly one retry. A loop here would be the TOCTOU this design avoids:
    // losing the retry means another run took the reclaimed lock first, which is
    // a refusal, not something to race for.
    attempt = create();
    if (!attempt.ok) return { ok: false, why: 'another run took it while this one was reclaiming it' };
  }
  if (!attempt.ok) return { ok: false, why: `the lock directory could not be created (${attempt.detail ?? 'unknown error'})` };
  heldLocks.push(dir);
  if (!releaseRegistered) {
    process.on('exit', releaseUnattendedLocks);
    releaseRegistered = true;
  }
  writeFileSync(join(dir, LOCK_OWNER_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { ok: true };
}

// All-or-nothing over the worktrees this attempt may drive. Partial exclusivity
// is not exclusivity: holding three of four locks and dispatching anyway puts a
// second supervisor in the fourth worktree, which is the whole harm.
//
// `issues` is what this attempt may dispatch — the whole plan on an ordinary
// run, and only the not-carried issues on a resume (a carried issue is never
// sent to, and its worktree may legitimately be gone).
function acquireUnattendedLocks(plan, issues) {
  const root = lockRoot();
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      keys: [],
      reasons: [{
        code: 'unattended_locked',
        detail: `the exclusivity lock root could not be created (${redact(error.message ?? String(error))}); `
          + `--unattended will not dispatch without it. Set ${LOCK_ROOT_ENV} to a writable directory that is the SAME for every run on this machine`,
      }],
    };
  }
  const keys = [];
  const meta = { host: hostname(), pid: process.pid, plan_run_id: String(plan.run_id ?? 'unknown'), stage: UNATTENDED_STAGE };
  for (const issue of issues) {
    const key = worktreeLockKey(plan, issue);
    const result = acquireOneLock(join(root, key), meta);
    if (result.ok) {
      keys.push(key);
      continue;
    }
    releaseUnattendedLocks();
    return {
      ok: false,
      keys: [],
      reasons: [{
        code: 'unattended_locked',
        detail: `#${issue.number}: the worktree lock "${key}" is held — ${result.why}. Another dispatch run is driving this worktree, `
          + 'so this one stopped before the pre-flight: nothing was probed, no worktree was prepared and no worker was sent to. '
          + `Locks live in $${LOCK_ROOT_ENV} (default $TMPDIR/${LOCK_DIR_NAME}/<worktree-key>) and are released when the owning run exits`,
      }],
    };
  }
  return { ok: true, keys, reasons: [] };
}

// The run-wide declaration (ADR section 7.2). One entry, in EVERY unattended
// report including the ones that stopped, so what the run declared — and what
// that declaration implied — is readable from the report alone.
//
// Deliberately free of absolute paths: `redact()` would replace them with
// `[REDACTED-PATH]` and, worse, would tally a redaction that a run without the
// flag does not have, so the "an unattended run differs only by these two
// limitations" property would stop being true.
function unattendedModeLimitation(inputs, lockKeys) {
  return {
    code: 'unattended_mode',
    detail: `--unattended（段階 ${UNATTENDED_STAGE}）: この invocation に人間は居ない、という入力の宣言である。`
      + '締め付けだけを含意し、権限は1つも足していない — **`--approve` は含意しない**、prompt には答えない、'
      + 'ゲートを無効化せず、blocking を limitation に格下げせず、status を1段も上げない。'
      + `含意した締め付け: --contract-mode require / pre-flight で全 Issue の scope 宣言を all-or-nothing 検査（--out を作る前）/ `
      + `--wall-clock-budget ${inputs.wallClockBudget}s / worktree 単位の排他 lock ${lockKeys.length} 件（${lockKeys.join(', ') || 'なし'}）/ `
      + 'verification_gates_unrecorded を limitation ではなく blocking として扱う'
      + '（gate を名指しできない pass は、無人 merge の根拠にしない。段階 C）。'
      + '拒否する緩和フラグ: --auto-yes / --allow-questions / --contract-mode off|auto（invalid_input, exit 3）。'
      + 'monitor を併用するなら monitor 側の `--no-auto-approve` は要件である（契約の autoYes: off は monitor を止めない）。',
  };
}

// The undo baseline (ADR section 7.2), one entry per worktree this run drives,
// recorded BEFORE the first message reaches its worker.
//
// Branch name and short SHA, never a path — measured in Issue #115 (ADR section
// 14.4): once the worktree has been cleaned up `git reset --hard` exits 128 and
// the only move left is `git branch -f <branch> <sha>`, which needs the branch
// name. The four conditions under which the baseline is NOT enough are in
// SKILL.md section 5; they are stated there rather than here because they are
// about the undo procedure, not about this run.
function unattendedBaselineLimitation(issue, sha) {
  const short = shortSha(sha ?? '');
  return {
    code: 'unattended_baseline',
    detail: redact(`#${issue.number}: branch ${issue.branch} @ ${short} — dispatch 開始時の worktree HEAD。`)
      + (short === 'unknown'
        ? 'HEAD を読めなかった（worktree が無い/壊れている）ので、この Issue の取り消し起点は記録できていない。'
        : '取り消しは worktree が在れば `git reset --hard <sha>`、片付いていれば `git branch -f <branch> <sha>`。'
          + 'untracked file は戻らず、merge / push 済みなら戻せない（SKILL.md 第5節）。'),
  };
}

// The plan-only gates, evaluated together BEFORE `--out` exists (ADR section 3).
//
// Three findings, one refusal:
//
//   - `open_questions` — the existing gate (Issue #52), which under
//     `--unattended` can no longer be waived (`--allow-questions` is refused);
//   - `contract_scope_dropped` — a path the plan DECLARES that the contract will
//     not carry (Issue #161 / #162). The old reading of this gate was
//     `length > 0`: an issue that declared 250 files or wrote one absolute path
//     passed it while the contract quietly went out with a narrower permission
//     than the plan had, and the worker met the difference as a scope-gate
//     failure it could not resolve. Half a scope is not a scope;
//   - `contract_scope_unknown` — no scope at all, per issue. Today this is
//     decided inside the wave loop, by which time the other workers of the wave
//     have already been sent to: the refusal is real but it lands on a world
//     that is already mutating, and no one is present to clean it up.
//
// All three are pure functions of the plan, so evaluating them here costs nothing
// and buys the property #90 established for missing worktrees: the run stops
// without consuming `--out`, so the same command can be re-run after the issue
// bodies are fixed and re-planned. Reporting them TOGETHER matters because an
// issue with no declared files usually also carries the planner's "affected files
// are unclear" question — reporting only one of the two would hide half the fix.
// For the same reason the drop is reported BEFORE the empty-scope finding of the
// same issue: when every declared path was dropped, the drop is the explanation
// of the emptiness, and a reader who meets it second reads it as a second
// problem.
//
// The scope condition is the CONTRACT's, not the plan's: `contractScopeReview`
// drops patterns the contract will not carry, so an issue can name files and
// still produce a shorter — or an empty — `scope.allow`. That is the condition
// the wave loop refuses on, so it is the condition checked here.
function unattendedPlanReasons(plan) {
  const reasons = [];
  const openQuestions = collectOpenQuestions(plan);
  if (openQuestions.length > 0) {
    reasons.push({
      code: 'open_questions',
      detail: `${openQuestions.length} issue(s) carry an unanswered planner question: ${formatOpenQuestions(openQuestions)} `
        + 'Nothing was dispatched and --out was not created: answer them in the issue body and re-plan. '
        + '--allow-questions is refused under --unattended, because taking on a question needs somebody to take it on',
    });
  }
  for (const issue of plan.issues ?? []) {
    const scope = contractScopeReview(issue);
    if (scope.dropped.length > 0) {
      reasons.push({
        code: 'contract_scope_dropped',
        detail: `${contractScopeDroppedDetail(issue.number, (issue.suspected_files ?? []).length, scope.dropped)}. `
          + 'Under --unattended this is checked for EVERY issue of the plan before anything is dispatched, so no worker of any '
          + 'wave was started and --out was not created (with a human present the same issue is dispatched with the narrowed '
          + 'scope and the loss is recorded as a limitation)',
      });
    }
    if (scope.allow.length > 0) continue;
    reasons.push({
      code: 'contract_scope_unknown',
      detail: `#${issue.number}: the plan names no file this issue may write, so its execution contract would declare no scope. `
        + 'Under --unattended this is checked for EVERY issue of the plan before anything is dispatched, so no worker of any wave '
        + 'was started (with a human present the same issue is refused inside its wave, by which time the rest of the wave is already running). '
        + "State the issue's target files and re-run the planner",
    });
  }
  return reasons;
}

// The report an unattended refusal prints. Same shape as #90's pre-flight
// refusal: `out_dir: null` because nothing was written, `dispatch_error` because
// the stop is before any wave, and the declaration is still recorded — a report
// that stopped must still say what it was declared to be.
function unattendedRefusalReport(inputs, plan, reasons, { humanRequired, lockKeys = [], resume = null }) {
  const report = emptyReport(inputs, plan, null);
  report.status = 'failure';
  report.stop_reason = 'dispatch_error';
  report.human_required = humanRequired;
  report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  report.blocking_reasons = reasons;
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed: false,
    parallelismBounded: true,
    barrierEnforced: true,
    noAutoPromptResponse: true,
    reportStatus: 'failure',
  });
  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, false, collectOpenQuestions(plan), resume);
  return report;
}

// =============================================================================
// Worktree preparation — composition of cmate-worktree-setup (Issue #93)
// =============================================================================
//
// `--prepare-worktrees` closes the one hand-off that kept this from being a
// single entry point: the worktrees a plan dispatches into have to exist before
// the first wave, and creating them lived in another Skill invoked by hand. If it
// was forgotten the run stopped at the pre-flight (Issue #90) — correct, but not
// end to end.
//
// What this runner does NOT do is create them itself. Collision detection, the
// base-SHA re-confirmation immediately before creation, the proportional baseline
// and the sync all already exist in cmate-worktree-setup; re-implementing them
// here would be two implementations of one rule, of which only one ever gets
// fixed. So the stage is a COMPOSITION: an injected provider performs that
// Skill's procedure, and this runner
//
//   1. decides WHO to prepare (the issues the pre-flight could not resolve —
//      the only side that knows this),
//   2. checks the result document against the provider's own contract
//      (worktree-setup.result.v1) and against the plan (branch agreement), and
//   3. re-scans the registry and resolves again, falling back to #90's unchanged
//      refusal for anything still unresolved.
//
// The shape is the same one the UAT runner uses for its semantic gate: the
// judgement (what to create / whether acceptance passed) happens outside, the
// runner validates a contract document and never re-implements the procedure.
// The full adjudication, including why a partial preparation stops the run and
// why nothing is ever deleted, is in references/adr-worktree-preparation.md.

const SETUP_SKILL_ID = 'cmate-worktree-setup';
const SUPPORTED_SETUP_SCHEMA_VERSION = 1;

// The top-level fields worktree-setup.result.v1 requires. A document missing any
// of them is not the contract, whatever else it contains.
const SETUP_REQUIRED_FIELDS = [
  'result_schema_version', 'skill_id', 'skill_version', 'generated_at', 'status', 'phase_reached',
  'request', 'repository', 'profile', 'plan', 'worktrees', 'baseline', 'commandmate_sync',
  'collisions', 'redactions', 'next_actions', 'blocking_reasons', 'limitations',
  'completion_check', 'summary_markdown',
];
const SETUP_STATUSES = new Set(['success', 'partial', 'failure']);

// How many of the provider's own blocking reasons are lifted into this report.
// Enough to act on, bounded so a provider cannot flood a dispatch report. The
// bound is NAMED where it bites (#165): five reasons shown out of nine reads as
// "there were five" unless the detail says otherwise, and an operator who cannot
// tell a complete list from a cut one goes looking in the wrong place.
const MAX_SETUP_REASONS = 5;

// Where the cmate-worktree-setup package sits when it is installed: next to this
// one, which is the layout both this repository and the installer produce. The
// probe only sharpens the message — "not installed" and "installed but nothing
// was given to invoke it with" are different sentences for the operator — and it
// never decides the outcome on its own.
const SETUP_PACKAGE_SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', SETUP_SKILL_ID, 'SKILL.md');

function setupPackageNote() {
  return existsSync(SETUP_PACKAGE_SKILL_MD)
    ? `the ${SETUP_SKILL_ID} package is installed next to this skill, but nothing was given to invoke it with`
    : `the ${SETUP_SKILL_ID} package is not installed next to this skill (commandmate skill install ${SETUP_SKILL_ID})`;
}

// Conformance against worktree-setup.result.v1, limited to what this composition
// depends on. Returns null when the document is usable, or the reason it is not.
function setupNonConformance(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object';
  for (const field of SETUP_REQUIRED_FIELDS) {
    if (!(field in doc)) return `missing required field "${field}"`;
  }
  if (doc.result_schema_version !== SUPPORTED_SETUP_SCHEMA_VERSION) {
    return `unsupported result_schema_version ${JSON.stringify(doc.result_schema_version)}; this runner understands ${SUPPORTED_SETUP_SCHEMA_VERSION}`;
  }
  if (doc.skill_id !== SETUP_SKILL_ID) return `skill_id is not ${SETUP_SKILL_ID}`;
  if (typeof doc.skill_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.skill_version)) {
    return 'skill_version is not a semantic version';
  }
  if (!SETUP_STATUSES.has(doc.status)) return `status ${JSON.stringify(doc.status)} is not one of success/partial/failure`;
  for (const field of ['worktrees', 'baseline', 'blocking_reasons', 'limitations']) {
    if (!Array.isArray(doc[field])) return `${field} is not an array`;
  }
  return null;
}

// One invocation for the whole unresolved set, not one per issue: the provider's
// input contract takes `issue_numbers` as a list, and its collision detection and
// base resolution are repository-wide work that would otherwise be redone N times.
function runWorktreeSetup(inputs, plan, numbers) {
  const argv = inputs.worktreeSetupArgv;
  const args = [
    ...argv.slice(1),
    '--issues', numbers.join(','),
    '--profile', String(plan.profile.id ?? 'unknown'),
    '--base', String(plan.profile.base),
  ];
  return runCli(argv[0], args);
}

// A 40-hex base SHA, shortened for a human-readable evidence line. Never invented:
// a provider that recorded no SHA (an entry it did not create) says so.
function shortSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 12) : 'unknown';
}

function preparationRecord(requested) {
  return {
    attempted: true,
    requested,
    ok: false,
    reasons: [],
    limitations: [],
    prepared: [],
    missing: [...requested],
    artifact: null,
  };
}

// `--prepare-worktrees` was set, but the pre-flight was blocked by something a
// worktree cannot fix. Recorded rather than silently skipped: an operator who
// asked for the stage must be told it did not run, and why.
function skippedPreparation(preflight) {
  const first = preflight.reasons[0];
  return {
    attempted: false,
    requested: [],
    ok: false,
    reasons: [],
    limitations: [{
      code: 'worktree_setup_skipped',
      detail: `--prepare-worktrees was set, but the pre-flight was blocked by ${first ? first.code : 'a drift check'} first, so the ${SETUP_SKILL_ID} provider was not invoked: creating worktrees cannot fix branch/base/permission drift`,
    }],
    prepared: [],
    missing: [],
    artifact: null,
  };
}

// The stage itself. `unresolved` is the pre-flight's own list of issues whose
// worktree neither `commandmate ls` nor `git worktree list` knew about.
//
// Returns evidence, never throws: every way it can fail is a named blocking
// reason the caller renders into the same pre-flight refusal #90 already prints,
// so a failed preparation still leaves `--out` unconsumed and the same command
// re-runnable.
function prepareWorktrees(inputs, plan, unresolved) {
  const requested = unresolved.map((entry) => entry.number).sort((a, b) => a - b);
  const evidence = preparationRecord(requested);

  if (inputs.worktreeSetupArgv === null) {
    evidence.reasons.push({
      code: 'worktree_setup_unavailable',
      detail: `--prepare-worktrees was set but no ${SETUP_SKILL_ID} provider was given: pass --worktree-setup <launcher>, which is invoked as \`<launcher> --issues <n,n> --profile <id> --base <ref>\` and must print a worktree-setup.result.v1 document on stdout (${setupPackageNote()}). Nothing was prepared and nothing was dispatched`,
    });
    return evidence;
  }

  const result = runWorktreeSetup(inputs, plan, requested);
  let doc = null;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    doc = null;
  }
  // The document is authoritative and the exit code is only consulted when there
  // is no usable document: a provider that created a worktree whose baseline then
  // failed reports `partial` and may well exit non-zero, and folding that into
  // "nothing happened" would lose a worktree that exists on disk.
  const nonConformance = doc === null ? 'stdout is not valid JSON' : setupNonConformance(doc);
  if (nonConformance !== null) {
    const detail = excerpt(result.stderr || result.stdout || 'the provider produced no output');
    if (result.status === null) {
      evidence.reasons.push({
        code: 'worktree_setup_unavailable',
        detail: `the ${SETUP_SKILL_ID} provider could not be run (${redact(detail ?? 'spawn failed')}); ${setupPackageNote()}. Nothing was prepared and nothing was dispatched`,
      });
      return evidence;
    }
    evidence.reasons.push({
      code: 'worktree_setup_failed',
      detail: `the ${SETUP_SKILL_ID} provider exited ${result.status} and its output is not a worktree-setup.result.v${SUPPORTED_SETUP_SCHEMA_VERSION} document (${nonConformance}): ${redact(detail ?? 'no output')}`,
    });
    return evidence;
  }

  evidence.limitations.push({
    code: 'worktree_setup_ran',
    detail: redact(`--prepare-worktrees invoked ${SETUP_SKILL_ID} ${doc.skill_version} once for ${requested.map((n) => `#${n}`).join(', ')} with the plan's profile (${String(plan.profile.id ?? 'unknown')} / base ${plan.profile.base}): status ${doc.status}, phase_reached ${doc.phase_reached}, ${doc.worktrees.length} worktree entr(ies), ${doc.limitations.length} limitation(s) of its own`),
  });

  const rows = new Map();
  for (const row of doc.worktrees) {
    if (row && typeof row === 'object' && Number.isInteger(row.issue_number)) rows.set(row.issue_number, row);
  }
  const baselines = new Map();
  for (const row of doc.baseline) {
    if (row && typeof row === 'object' && Number.isInteger(row.issue_number)) baselines.set(row.issue_number, row);
  }

  // Branch agreement is how "the same profile" is actually checked (ADR section 6):
  // the two `branch_template`s cannot be compared as strings — their placeholder
  // spellings are not standardised across the two Skills — but the branch they
  // produce is exactly what `commandmate ls` matches on, so that is what is
  // asserted. A mismatch is a profile disagreement, not a missing worktree, and
  // it gets a message that says so.
  const mismatched = [];
  const evidenceRows = [];
  for (const number of requested) {
    const issue = issueOf(plan, number);
    const row = rows.get(number);
    if (!row) continue;
    const made = row.created === true || row.reused === true;
    const branch = typeof issue.branch === 'string' ? issue.branch : null;
    if (made && branch !== null && row.branch !== branch) {
      mismatched.push({ number, planned: branch, produced: String(row.branch) });
      continue;
    }
    if (!made) continue;
    const baseline = baselines.get(number) ?? null;
    const outcome = baseline && typeof baseline.outcome === 'string' ? baseline.outcome : 'not_run';
    const exitCode = baseline && Number.isInteger(baseline.exit_code) ? baseline.exit_code : null;
    evidence.prepared.push(number);
    evidenceRows.push({
      issue: number,
      branch: redact(String(row.branch)),
      directory: redact(String(row.directory ?? '')),
      created: row.created === true,
      reused: row.reused === true,
      base_sha: typeof row.base_sha === 'string' ? redact(row.base_sha) : null,
      baseline_outcome: outcome,
      baseline_exit_code: exitCode,
    });
    evidence.limitations.push({
      code: 'worktree_prepared',
      detail: redact(`#${number}: ${SETUP_SKILL_ID} ${row.created === true ? 'created' : 'reused'} branch ${row.branch} at ${row.directory} from base ${shortSha(row.base_sha)}; baseline ${outcome}${exitCode === null ? '' : ` (exit ${exitCode})`}`),
    });
  }
  evidence.missing = requested.filter((number) => !evidence.prepared.includes(number));

  if (mismatched.length > 0) {
    for (const entry of mismatched) {
      evidence.reasons.push({
        code: 'worktree_profile_mismatch',
        detail: redact(`#${entry.number}: ${SETUP_SKILL_ID} created branch ${entry.produced}, but the plan dispatches into ${entry.planned}. The two sides resolved different profiles (different branch_template), so \`commandmate ls\` can never match the plan's branch. Pass the SAME profile to both`),
      });
    }
    return evidence;
  }

  if (evidence.prepared.length === 0) {
    const all = doc.blocking_reasons.map((reason) => (typeof reason === 'string' ? reason : JSON.stringify(reason)));
    const own = all.slice(0, MAX_SETUP_REASONS).join('; ');
    // Counted OUTSIDE the excerpt on purpose: excerpt() may cut the joined text
    // again, and the one thing that must survive both cuts is the fact that
    // something was cut.
    const more = Math.max(0, all.length - MAX_SETUP_REASONS);
    const blocked = own
      ? `; it blocked on: ${excerpt(own, 400)}${more > 0 ? ` (+${more} more reason(s) not listed here; read the provider's own report for the rest)` : ''}`
      : ' and named no blocking reason';
    evidence.reasons.push({
      code: 'worktree_setup_failed',
      detail: redact(`the ${SETUP_SKILL_ID} provider reported status ${doc.status} and created no worktree for ${requested.map((n) => `#${n}`).join(', ')}${blocked}`),
    });
    return evidence;
  }

  if (evidence.missing.length > 0) {
    // Partial preparation does not become a partial dispatch (ADR section 3). The
    // run still stops — through #90's unchanged path, on the issues that are
    // still unresolved — and what WAS created is kept and named here.
    evidence.limitations.push({
      code: 'worktree_setup_partial',
      detail: `the ${SETUP_SKILL_ID} provider prepared ${evidence.prepared.map((n) => `#${n}`).join(', ')} but not ${evidence.missing.map((n) => `#${n}`).join(', ')}; the prepared worktrees are kept (nothing is deleted here) and the run stops on the ones that are still unresolved`,
    });
  }

  // The registry re-scan the created worktrees need. `git worktree add` does not
  // register anything with the CommandMate server, so a worktree that was just
  // created has no id to send to until a sync makes it visible. This one is
  // FORCED: the run's earlier sync (Issue #91) ran before these worktrees
  // existed, so its answer says nothing about them.
  const sync = attemptSync(inputs, { force: true });
  evidence.ok = true;
  evidence.artifact = {
    provider: {
      skill_id: SETUP_SKILL_ID,
      skill_version: redact(String(doc.skill_version)),
      status: doc.status,
      phase_reached: String(doc.phase_reached),
    },
    requested,
    prepared: [...evidence.prepared],
    missing: [...evidence.missing],
    worktrees: evidenceRows,
    provider_sync: {
      available: doc.commandmate_sync?.available === true,
      attempted: doc.commandmate_sync?.attempted === true,
    },
    dispatch_sync: { ran: true, ok: sync.ok, detail: redact(sync.detail) },
  };
  return evidence;
}

// The evidence, in the report. No new field: `dispatch_schema_version` stays 1
// because merge and uat refuse any other version, and what they read
// (`worker_state`, `verification.outcome`) has not changed — so the preparation
// travels the same way #91's sync attempt does, through `limitations` (ADR section 7).
function recordPreparation(report, preparation) {
  if (preparation === null) return;
  report.limitations.push(...preparation.limitations);
}

// The structured half of the same evidence. Written only once the run has an
// output directory, which means only when the preparation let the run proceed:
// a refusal writes nothing at all (#90), so its evidence lives in the report.
function writePreparationArtifact(outDir, preparation) {
  if (preparation === null || preparation.artifact === null) return;
  const dir = join(outDir, 'worktree-setup');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'prepared.json'), `${JSON.stringify(preparation.artifact, null, 2)}\n`, 'utf8');
}

// Is this pre-flight refusal one the preparation stage can address? Only when
// every blocking reason is a missing worktree. `driftChecks` reports the FIRST
// blocking failure, so a run blocked on `cli_available` / `repo_access` /
// `base_resolvable` / `branch_matches` never reaches here — and must not, since
// creating a worktree on a drifted world is a mutation that cannot help.
function blockedOnWorktreesOnly(preflight) {
  return preflight.blocked
    && preflight.unresolved.length > 0
    && preflight.reasons.length > 0
    && preflight.reasons.every((reason) => reason.code === 'worktree_unresolved');
}

// =============================================================================
// Version gate: does this CommandMate speak the execution contract? (#1588)
// =============================================================================

// The execution contract (`send --contract`) and the contract verdict
// (`wait --verify`, `commandmate verify`) landed together in CommandMate 0.17.0
// (Issues #1544 / #1545). Rather than assume, the runner asks the binary in front
// of it once, before the first wave, and records the answer. The point of the
// probe is not the branch, it is the DISCLOSURE: falling back silently would keep
// reporting `verification.outcome: pass` while the thing that produced it had
// changed from "every declared gate passed" to "the profile baseline exited 0".
function probeContractSupport(inputs) {
  const send = runCm(inputs, ['send', '--help']);
  const wait = runCm(inputs, ['wait', '--help']);
  const hasContract = send.ok && `${send.stdout}${send.stderr}`.includes('--contract');
  const hasVerify = wait.ok && `${wait.stdout}${wait.stderr}`.includes('--verify');
  if (hasContract && hasVerify) {
    return { supported: true, detail: 'commandmate accepts send --contract and wait --verify' };
  }
  if (!send.ok && !wait.ok) {
    return {
      supported: false,
      detail: 'commandmate did not answer `send --help` / `wait --help` (not installed, not on PATH, or not permitted)',
    };
  }
  const missing = [];
  if (!hasContract) missing.push('send --contract');
  if (!hasVerify) missing.push('wait --verify');
  return {
    supported: false,
    detail: `commandmate is missing ${missing.join(' and ')} (the execution contract needs CommandMate >= 0.17.0)`,
  };
}

// =============================================================================
// Execution contract generation (CommandMate task contract v1)
// =============================================================================
//
// Canonical spec: CommandMate's docs/design/task-contract.md. v1 is a CLOSED key
// set — version / title / goal / scope / verify / autoYes / success — where an
// unknown key is a hard error, `title` and `goal` are required, `verify.gates: []`
// is an error, and `scope.allow` is effectively required because
// `success.requireScopeClean` defaults to true.
//
// Everything below is derived from the approved plan and from the artifacts the
// CALLER measured for this run — the worktree's `verify.yaml` gate ids (§2.9),
// the worker-method Skill installed in that worktree (§3.0.2) and, since Issue
// #176, the issue body — in a fixed order, with no clock, no randomness and no
// other environment read: the same plan against the same world must produce a
// BYTE-IDENTICAL contract. That is the same Claude/Codex parity rule the planner
// already lives under, and it is what makes a contract reviewable — a diff
// between two runs is a change in the plan or in the world, never a change in
// the runner, and every world input is named in `limitations` so a reader can
// tell which of the two moved.

// A double-quoted YAML scalar. JSON string escaping is a strict subset of YAML
// 1.2's double-quoted style, so JSON.stringify is both correct and stable — and,
// unlike a bare scalar, the result can never be re-read as a boolean (`off`), a
// number, or the start of a comment (`#123 …`).
function yamlString(value) {
  return JSON.stringify(String(value));
}

// The goal as a literal block scalar. The contract is a reviewed, committed
// artifact rather than a wire format, so the goal stays readable instead of
// becoming one escaped line. The text is normalised first — CR removed, trailing
// whitespace removed, trailing blank lines dropped — so the block can never
// acquire an ambiguous indentation, and buildContractGoal always opens with a
// header line (a whitespace-led first line would need an explicit indentation
// indicator to be legal).
function yamlBlockScalar(key, text, indent = '  ') {
  const lines = String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((line) => (line === '' ? '' : `${indent}${line}`)).join('\n');
  return `${key}: |\n${body}`;
}

// Why one declared path is not in the contract. The reason is not decoration:
// it is the only thing that decides the fix, and the two families need OPPOSITE
// fixes — a shape reason is repaired by rewriting the path, while `over_bound`
// cannot be repaired by rewriting anything (the bound is CommandMate's, not this
// runner's) and is repaired by declaring fewer files, i.e. by splitting the
// issue. A single "invalid" would tell a reader neither.
const SCOPE_DROP_HINT = {
  not_a_string: 'suspected_files carried a non-string entry (the plan schema says string)',
  empty: 'the entry is empty once trimmed, so it names no path',
  too_long: `the pattern is longer than ${MAX_SCOPE_PATTERN_LENGTH} characters`,
  absolute: 'the pattern is an absolute path (leading "/"), and scope patterns are repository-relative',
  drive_letter: 'the pattern opens with a Windows drive letter ("C:"), which cannot match a repository-relative path',
  backslash: 'the pattern contains a backslash, which is not a path separator in a scope pattern',
  parent_escape: 'the pattern has a ".." segment, which escapes the repository',
  nul_byte: 'the pattern contains a NUL byte',
  over_bound: `the contract accepts at most ${MAX_SCOPE_PATTERNS} patterns and this issue declared more`,
  over_broad: 'the pattern matches every path in the repository (`**`, `*`, `.`), so a contract carrying it has no scope gate at all',
};

// A dropped pattern as it can safely be printed. Control characters (the NUL
// case above is one) are escaped rather than embedded, so the report stays
// readable and stays free of bytes a terminal would eat; an over-long pattern is
// cut with its true length stated, because the length IS the finding there and
// 200+ characters of noise would bury the entries beside it.
function scopePatternLabel(pattern) {
  const text = String(pattern).replace(/[\x00-\x1f\x7f]/g, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
  return text.length > 80 ? `"${text.slice(0, 80)}…" (${text.length} chars)` : `"${text}"`;
}

// `scope.allow` for one issue: the files the plan says this issue owns, AND the
// declared paths that did not reach it (Issue #161 / #162).
//
// The doc comment this replaces said the drops were free — "a contract rejected
// at `send` is a dispatch that never happens" — and that CommandMate's contract
// parser would reject every shape dropped here. Measured against CommandMate
// 0.22.2, both halves are wrong in the direction that matters:
//
//   - `validateScopePattern` tests exactly THREE things: a NUL byte, a leading
//     `/`, and a `..` segment. A Windows drive letter and a backslash are NOT
//     rejected there, so the old comment named two shapes the parser never
//     refuses. They are still dropped here — a backslash-bearing pattern cannot
//     match a repository-relative path on any platform this ships to — but that
//     drop is this runner's decision, and it has to be reported as one.
//   - For everything else the parser is LOUD: it names the offending entry and
//     its reason (`validateScopePattern` / `validateStringList`), and refuses a
//     list over the bound BY NUMBER (`at most 200 entries (got 250)`), exiting 2
//     with every violation listed. So dropping does not avoid a failed dispatch —
//     it converts a refusal that says exactly what is wrong into a dispatch that
//     SUCCEEDS with a narrower permission than the plan declared. The worker then
//     edits the file its own issue named, fails the scope gate, and has no way
//     back: the contract's `scope.allow` is a send-time snapshot.
//
// So the drops stay (a list `send` will accept is still the only list worth
// sending), but they are no longer silent: the caller gets them, the pre-flight
// refuses on them before `--out` exists, and the wave loop records them.
//
// `dropped` is deterministic, like everything else that feeds a contract: the
// shape drops come first, in the plan's declaration order, then the over-bound
// drops in the sorted order they were cut in. A duplicate is NOT a drop — the
// path is still in the contract, just once. The result is sorted so the contract
// does not depend on the plan's iteration order.
function contractScopeReview(issue) {
  const seen = new Set();
  const allow = [];
  const dropped = [];
  const drop = (pattern, reason) => dropped.push({ pattern: String(pattern), reason });
  const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
  for (const raw of files) {
    if (typeof raw !== 'string') { drop(raw, 'not_a_string'); continue; }
    const pattern = raw.trim();
    if (pattern === '') { drop(raw, 'empty'); continue; }
    if (pattern.length > MAX_SCOPE_PATTERN_LENGTH) { drop(pattern, 'too_long'); continue; }
    if (pattern.startsWith('/')) { drop(pattern, 'absolute'); continue; }
    if (/^[A-Za-z]:/.test(pattern)) { drop(pattern, 'drive_letter'); continue; }
    if (pattern.includes('\\')) { drop(pattern, 'backslash'); continue; }
    if (pattern.split('/').includes('..')) { drop(pattern, 'parent_escape'); continue; }
    if (pattern.includes('\u0000')) { drop(pattern, 'nul_byte'); continue; }
    // #219: the planner's contractScopeDrops refuses the same shape at plan
    // review, where the fix is an edit to the issue body. Here is where it stops
    // reaching a worker: `allow: ["**"]` is a contract whose scope gate can
    // never fail, which is a gate that is not there.
    if (isOverBroadScope(pattern)) { drop(pattern, 'over_broad'); continue; }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    allow.push(pattern);
  }
  allow.sort();
  for (const pattern of allow.slice(MAX_SCOPE_PATTERNS)) drop(pattern, 'over_bound');
  return { allow: allow.slice(0, MAX_SCOPE_PATTERNS), dropped };
}

// The array-only view, for the two callers that build the contract itself. They
// sit downstream of a gate that has already reported `dropped`, so nothing about
// them changes.
function contractScopeAllow(issue) {
  return contractScopeReview(issue).allow;
}

// The sentence both the pre-flight refusal and the wave-loop limitation open
// with. What it carries is fixed by what a reader can act on: HOW MANY paths went
// missing out of how many were declared, WHICH ones (the first few — fifty lines
// of paths read as noise and their reasons repeat), and WHY each went, because
// the two reason families need opposite fixes. The paths are `redact`ed like
// every other body-derived text in a report, which is also what keeps an
// `absolute` drop from printing a host path back out.
function contractScopeDroppedDetail(number, declared, dropped) {
  const counts = new Map();
  for (const entry of dropped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  const tally = [...counts.entries()].map(([reason, count]) => `${reason} x${count}`).join(', ');
  const samples = dropped.slice(0, 3).map((entry) => `${entry.reason} ${scopePatternLabel(entry.pattern)}`).join('; ');
  const more = dropped.length > 3 ? `; …and ${dropped.length - 3} more` : '';
  const hints = [...counts.keys()].map((reason) => `${reason}: ${SCOPE_DROP_HINT[reason]}`).join('. ');
  return redact(
    `#${number}: ${dropped.length} of the ${declared} path(s) this issue declares do NOT reach its execution contract's `
    + `scope.allow (${tally}). Dropped: ${samples}${more}. ${hints}. `
    + 'The contract scope is a send-time snapshot, so a worker told to edit one of these files fails the scope gate '
    + `and cannot widen it from inside the worktree. Declare fewer files (${MAX_SCOPE_PATTERNS} is CommandMate's contract bound, `
    + 'not this runner\'s — split the issue) or write the offending paths as plain repository-relative paths, then re-plan',
  );
}

function contractTitle(issue) {
  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  const raw = redact(title === '' ? `Issue #${issue.number}` : `#${issue.number} ${title}`);
  return raw.length > MAX_CONTRACT_TITLE ? `${raw.slice(0, MAX_CONTRACT_TITLE - 1)}…` : raw;
}

// The `## Method` section, or nothing at all (Issue #128 / ADR section 3.3).
//
// It goes into BOTH task-text generators — the contract goal and the fallback
// worker prompt — at the same place, immediately before `## Objective`:
//
//   - Not first. `yamlBlockScalar` relies on the goal opening with a non-blank
//     header line, and the header is also what identifies the task to a human.
//   - Not inside `## Rules`. Rules are last, and last is what the 8000-char
//     truncation eats first: a contract could then lose its method reference
//     without saying so. Measured: the insertion point sits at a FIXED offset of
//     365 chars for every issue whose title is of ordinary length, no matter how
//     many acceptance criteria or files it declares, so the truncation cannot
//     reach this section at all.
//   - Before `## Objective`, because a worker reads top to bottom. A method
//     stated after the objective arrives after the work has started.
//
// Only ONE generator carrying it would be worse than neither carrying it:
// `--contract-mode auto` silently falls back to `buildWorkerPrompt()` on a CLI
// with no `send --contract`, and the method would then disappear from exactly the
// runs nobody is watching (ADR section 1.2).
//
// The text names the Skill, its two paths and the precedence rule, and nothing
// else. Summarising the method here would put a second copy of it in this
// runner, which is the case ADR section 3.2 rejects: the copy and the Skill drift
// apart, and the worker reads the copy.
function workerMethodSection(skillId) {
  if (skillId === null) return [];
  return [
    '## Method',
    `Follow the \`${skillId}\` Skill installed in this worktree. Read it before you`,
    'start, and follow it for the whole task:',
    ...workerMethodPaths(skillId).map((relative) => `- ${relative}`),
    'The two copies are byte-identical; read whichever one your agent can see.',
    'The Skill supplies METHOD only. It does not widen the files you may change,',
    'does not relax any gate, and does not authorise a push or a pull request.',
    'Where the Skill and this task disagree, THIS TASK WINS.',
    'If the Skill is not there, STOP and report it — do not improvise a method.',
    '',
  ];
}

// =============================================================================
// Negative constraints, transcribed from the issue body (Issue #176)
// =============================================================================
//
// MEASURED (2026-08-09, Kewton/BorderFreeKidsMap #35). The issue body carried a
// 「送ってよい / 送ってはいけない」table with THREE prohibitions. The plan's prose
// extraction carried two of them into `acceptance_criteria`; the goal is built
// from the plan, so the third one reached the worker as NOTHING — not as "not
// permitted", but as text that does not exist. The worker read the contract,
// nothing in it forbade a facility id in the payload, and it shipped one. Every
// gate was green: `scope.allow` constrains PATHS and `verify.gates` constrain
// EXIT CODES, and a prohibition is neither. A human found it in review.
//
// So the goal stops summarising this one class of text. A section or block that
// states a prohibition is TRANSCRIBED — the body's own bytes — and when one
// cannot be carried whole the goal SAYS SO instead of shortening it. A shortened
// prohibition is the failure above with extra steps.
//
// WHY THE BODY IS RE-READ HERE, at dispatch, with `gh issue view`:
// the plan does not carry it. It carries `objective` (the body's first non-empty
// line), `acceptance_criteria` (checkbox/bullet extraction) and `suspected_files`
// — all POSITIVE-form extraction, which is the structural cause of this bug: the
// prohibition is not in any of those three fields, so no amount of re-reading the
// plan can recover it. The one artifact that holds it is the body, and the body
// is also the authority (the plan is a derived summary of it). It is read
// READ-ONLY, once per issue, with the same `gh` binary the pre-flight repo probe
// already uses, and a failed read degrades to the pointer line below rather than
// stopping a dispatch: the body is what the worker is being pointed AT, so being
// unable to read it is a reason to say so, not a reason to send nothing.

// The heading words that make a whole section a constraint, and the words that
// make a TABLE or a LIST one wherever it sits.
//
// HARDCODED, deliberately, not declared per profile (the decision Issue #176
// asks for; recorded in references/dispatch-contract.md §2.4.1):
//
//   - A profile-declared set means the repository whose profile forgot a word
//     gets a goal with the prohibition silently missing — which is this bug,
//     re-created by configuration. A default that has to be declared is not a
//     default.
//   - A narrowable list of "which prohibitions get transcribed" is a
//     permission-widening knob wearing a configuration hat. §2.9 already refuses
//     the same shape for gates: `--verify-gates` cannot narrow what the issue
//     declared.
//   - `scope_companions` IS profile-declared because test-file layout genuinely
//     differs per repository. Prohibition vocabulary does not: it is a property
//     of the language issues are written in, not of the repository's toolchain.
//
// The list is a FLOOR, not a ceiling: the block rule below fires on prohibition
// wording under any heading at all, which is what covers the headings this list
// does not know. Over-capture (transcribing a section that turns out to be
// ordinary prose) costs goal length, and length is bounded and reported.
// Under-capture costs the run above.
const CONSTRAINT_HEADING_RE = new RegExp([
  '非対象', 'やらないこと', 'やってはいけない', '対象外', '禁止', '禁じ',
  'しないこと', 'してはいけない', 'してはならない', 'セキュリティ', 'テスト方針',
  'non-?goals?', 'out of scope', 'must ?not', 'security', 'testing (policy|strategy)',
].join('|'), 'i');

const CONSTRAINT_TEXT_RE = new RegExp([
  'してはいけない', 'してはならない', 'しないこと', '使ってはいけない',
  '送ってはいけない', '触ってはいけない', '入れてはいけない', '載せてはいけない',
  '禁止', '禁じ', '不可', '\\bNG\\b',
  "\\bmust\\s+not\\b", "\\bmust\\s+never\\b", "\\bmay\\s+not\\b", '\\bnever\\b',
  '\\bforbidden\\b', '\\bprohibited\\b', "\\bdo\\s+not\\b", "\\bdon'?t\\b",
].join('|'), 'i');

// Why a constraint block did not reach the goal. Both reasons are repaired the
// same way — read the body — which is exactly what the pointer line says.
const CONSTRAINT_DROP_HINT = {
  over_budget: `the transcript is bounded at ${MAX_CONSTRAINT_TRANSCRIPT} characters and this block did not fit in what was left`,
  over_count: `the goal transcribes at most ${MAX_CONSTRAINT_BLOCKS} blocks`,
};

// The issue body, split at ATX headings. Fenced blocks are tracked so a `#` line
// inside a fence is content, not a heading — the ```acceptance-gates block the
// planner reads is exactly such a fence, and a body whose fences were mis-paired
// would slice into the wrong sections.
function issueBodySections(body) {
  const sections = [];
  let current = { heading: null, lines: [] };
  let fence = null;
  for (const line of String(body).replace(/\r/g, '').split('\n')) {
    const opener = /^\s*(```|~~~)/.exec(line);
    if (opener !== null) {
      if (fence === null) fence = opener[1];
      else if (opener[1] === fence) fence = null;
      current.lines.push(line);
      continue;
    }
    const heading = fence === null ? /^(#{1,6})\s+(.+)$/.exec(line) : null;
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    sections.push(current);
    current = { heading: `${heading[1]} ${heading[2].trim()}`, lines: [] };
  }
  sections.push(current);
  return sections;
}

// The tables and lists inside one section, as contiguous runs of lines. A table
// is every line that opens with `|` — header, separator and data rows together,
// because a prohibition table's meaning is in the pairing of its columns and a
// row lifted out of it says nothing. A list keeps its indented continuation
// lines for the same reason.
function markdownBlocks(lines) {
  const blocks = [];
  let run = null;
  const close = () => { if (run !== null) blocks.push(run); run = null; };
  for (const line of lines) {
    const kind = /^\s*\|/.test(line) ? 'table'
      : /^\s*([-*+]|\d+[.)])\s/.test(line) ? 'list'
        : null;
    if (kind !== null) {
      if (run === null || run.kind !== kind) { close(); run = { kind, lines: [] }; }
      run.lines.push(line);
      continue;
    }
    // An indented non-blank line continues the list item above it.
    if (run !== null && run.kind === 'list' && /^\s+\S/.test(line)) { run.lines.push(line); continue; }
    close();
  }
  close();
  return blocks;
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

// Where a transcribed block came from, as the body wrote it. Truncated from the
// HEAD (unlike `excerpt`, which keeps the tail): a heading identifies itself in
// its first words.
function constraintLabel(text) {
  const label = redact(String(text).replace(/\s+/g, ' ').trim());
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

// Every constraint block in one body, in the body's own order.
//
// A section whose HEADING matches is taken whole and its inner blocks are not
// taken again — the section already contains them, and a second copy of a
// prohibition in the same goal reads as two different prohibitions.
function collectConstraintBlocks(body) {
  const found = [];
  for (const section of issueBodySections(body)) {
    const label = section.heading === null ? '（本文冒頭）' : section.heading;
    if (section.heading !== null && CONSTRAINT_HEADING_RE.test(section.heading)) {
      const lines = trimBlankEdges(section.lines);
      if (lines.length > 0) found.push({ label, what: '節', lines });
      continue;
    }
    for (const block of markdownBlocks(section.lines)) {
      if (!CONSTRAINT_TEXT_RE.test(block.lines.join('\n'))) continue;
      const lines = trimBlankEdges(block.lines);
      if (lines.length > 0) found.push({ label, what: block.kind === 'table' ? '表' : '箇条書き', lines });
    }
  }
  return found;
}

// The body of one issue, read once per run. Memoized because the goal is built
// TWICE for every dispatched issue — once into the contract, once into the
// `<out>/prompts/` artifact that records what the worker read — and the two must
// be the same bytes. A second `gh` call could answer differently (somebody edits
// the issue mid-wave) and the artifact would then disagree with the contract
// about what was sent.
const issueBodyReads = new Map();

function readIssueBody(inputs, plan, number) {
  if (issueBodyReads.has(number)) return issueBodyReads.get(number);
  const result = runCli(inputs.gh, ['issue', 'view', String(number), '--repo', plan.profile.repository, '--json', 'body']);
  const parsed = parseCliJson(result);
  const value = parsed !== null && typeof parsed.body === 'string'
    ? { ok: true, body: parsed.body, reason: null }
    : { ok: false, body: '', reason: excerpt(result.stderr || result.stdout || 'gh issue view returned no body field', 160) ?? 'gh issue view returned nothing' };
  issueBodyReads.set(number, value);
  return value;
}

// What the goal will carry for one issue: the blocks that fit, and the ones that
// did not.
//
// Two rules, both about not producing a transcript that misleads:
//
//   - A block is NEVER cut to fit. Half a prohibition table authorises the half
//     it dropped, and half a `## 非対象` section reads as a complete one.
//   - The first block that does not fit ENDS the transcript; everything after it
//     is dropped too, even a short block that would have fitted. Best-fit packing
//     would keep a trailing `## テスト方針` while dropping the
//     `## セキュリティ上の考慮` above it, and a reader has no way to see that the
//     transcript is not a prefix of the body. A prefix plus "there is more, go
//     read it" is honest; a subset in body order that silently skips the middle
//     is a summary again, chosen by length.
function issueBodyConstraints(inputs, plan, issue) {
  const read = readIssueBody(inputs, plan, issue.number);
  if (!read.ok) return { read: false, reason: read.reason, blocks: [], dropped: [] };
  const found = collectConstraintBlocks(read.body);
  const blocks = [];
  const dropped = [];
  let used = 0;
  for (const block of found) {
    if (dropped.length > 0) { dropped.push({ ...block, reason: dropped[0].reason }); continue; }
    const size = block.lines.join('\n').length;
    if (blocks.length >= MAX_CONSTRAINT_BLOCKS) { dropped.push({ ...block, reason: 'over_count' }); continue; }
    if (used + size > MAX_CONSTRAINT_TRANSCRIPT) { dropped.push({ ...block, reason: 'over_budget' }); continue; }
    used += size;
    blocks.push(block);
  }
  return { read: true, reason: null, blocks, dropped };
}

// The ONE line Issue #176 requires whenever the transcription is incomplete. It
// names the command rather than the fact, because a worker that has just been
// told "there is more" and not told how to get it will proceed without it.
function issueBodyPointerLine(number) {
  return `本文に他節がある。\`gh issue view ${number}\` で全文を読め`;
}

// The `## Constraints…` section, or nothing at all.
//
// Nothing at all is the common case and it matters: an issue whose body states no
// prohibition produces the goal this runner produced before #176, byte for byte.
//
// It sits immediately after `## Objective` — see the placement note in
// buildContractGoal — and it is the same text in the contract goal and in the
// fallback worker prompt. Carrying it in only ONE of the two would put the
// prohibitions in every run except the ones with the older CLI, which is the
// asymmetry ADR §1.2 refuses for `## Method`.
function constraintSection(constraints, number) {
  if (constraints === null) return [];
  const rule = [
    'A prohibition this contract does not state is NOT a permission: it is text the',
    'summary did not carry. The issue body is the authority.',
    '契約が言及していない禁止事項は、契約が許可したのではなく書いていないだけである。',
  ];
  // Two headings, one prefix. A heading that says "transcribed" above nothing at
  // all is the same false statement in miniature; a reader (or a grep) still finds
  // either one by `## Prohibitions and constraints`.
  if (!constraints.read) {
    return [
      '## Prohibitions and constraints — the issue body could not be read',
      `本文を読み取れなかった（${constraints.reason}）ので、本文由来の転記はこの goal に1件も無い。`,
      ...rule,
      issueBodyPointerLine(number),
      '',
    ];
  }
  if (constraints.blocks.length === 0 && constraints.dropped.length === 0) return [];
  const heading = '## Prohibitions and constraints — transcribed from the issue body';
  const body = [];
  for (const block of constraints.blocks) {
    body.push(`[原文転記] 本文「${constraintLabel(block.label)}」の${block.what}`);
    body.push(...block.lines);
    body.push('');
  }
  const tail = [];
  if (constraints.dropped.length > 0) {
    const named = constraints.dropped
      .map((block) => `「${constraintLabel(block.label)}」の${block.what}（${block.reason}）`)
      .join('、');
    tail.push(`転記しきれず落とした: ${named}。`);
    tail.push(issueBodyPointerLine(number));
    tail.push('');
  }
  return [
    heading,
    'これは要約ではない。以下は Issue 本文からの原文転記である。',
    ...rule,
    '',
    ...body,
    ...tail,
  ];
}

// The report entry for one issue's transcription — exactly one, or none. Which
// one is what a reader (or a CI step) acts on, so the three facts get three
// codes rather than one code with three details:
//
//   issue_body_unreadable          nothing was transcribed and nobody knows what
//                                  is in the body. The goal carries the pointer.
//   issue_constraints_untranscribed a prohibition was FOUND and did not fit. This
//                                  is the machine-readable half of the pointer
//                                  line Issue #176 asks for: the line lives in a
//                                  file the worker it constrains can rewrite,
//                                  while the report is a run artifact, so a CI
//                                  step that must not ship a silently shortened
//                                  contract has something to test.
//   issue_constraints_transcribed   a prohibition was found and carried whole.
//                                  Positive evidence, the shape
//                                  `worker_method_applied` already takes: 転記
//                                  したことは、守られたことではない.
//
// An issue whose body states no prohibition records NOTHING — a limitation per
// dispatched issue saying "there was nothing to say" is noise that hides the
// entries above.
function constraintLimitation(number, constraints) {
  if (!constraints.read) {
    return {
      code: 'issue_body_unreadable',
      detail: redact(`#${number}: the issue body could not be read (${constraints.reason}), so no prohibition from it was transcribed into the task text. `
        + 'The goal carries the "read the body" pointer instead. scope.allow and verify.gates are unaffected — they come from the plan — but a negative '
        + 'constraint has nowhere else to ride, so treat this run as one where the worker was told to go read the issue and may not have'),
    };
  }
  if (constraints.dropped.length > 0) {
    return {
      code: 'issue_constraints_untranscribed',
      detail: redact(`#${number}: ${constraints.blocks.length} constraint block(s) from the issue body were transcribed verbatim into the task text and `
        + `${constraints.dropped.length} were NOT (${[...new Set(constraints.dropped.map((block) => block.reason))].map((reason) => CONSTRAINT_DROP_HINT[reason]).join('; ')}). `
        + 'Nothing was shortened — a half-transcribed prohibition authorises the half it drops — so the dropped blocks are named in the goal beside the '
        + `\`gh issue view ${number}\` pointer. Split the issue, or shorten the body's constraint sections, if the worker must have them all in the contract`),
    };
  }
  if (constraints.blocks.length > 0) {
    return {
      code: 'issue_constraints_transcribed',
      detail: redact(`#${number}: ${constraints.blocks.length} constraint block(s) from the issue body were transcribed verbatim into the task text `
        + `(${constraints.blocks.map((block) => `「${constraintLabel(block.label)}」の${block.what}`).join('、')}). `
        + '転記したことは、守られたことではない — dispatch can see the text was carried, not that the worker honoured it'),
    };
  }
  return null;
}

// The contract's `goal` — the body CommandMate sends after the preamble it
// composes itself.
//
// Deliberately NOT the same text as buildWorkerPrompt(): the preamble already
// states the allowed paths, the commit requirement and the completion criterion,
// and it writes that criterion out as the REAL gate commands resolved from
// verify.yaml. Repeating the profile baseline here would tell the worker to
// satisfy one thing while a different thing judges it.
// `requiredGates` and `definedGates` add ONE section each, and only when the
// issue declared them. An issue with no `acceptance-gates` block produces the
// same bytes as before this feature existed — the non-regression the ADR §4 (6)
// fixture pins.
//
// The section is what finally makes the "## Rules" sentence below true for the
// mechanized part of the acceptance criteria: until now the goal told the worker
// that "the same gates decide the verdict" while the verdict was actually the
// repository's common gate set, which the issue had no way to speak to (ADR §1.1).
function buildContractGoal(plan, issue, requiredGates = [], workerMethod = null, constraints = null, definedGates = []) {
  const goal = [
    `# Issue #${issue.number} — ${issue.title ?? 'no title'}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    // Issue #176, and placed HERE for the reason the `## Method` note gives: this
    // block sits at a fixed offset from the top of every goal, so the 8000-char
    // truncation — which cuts from the END — cannot reach it. The one line that
    // must survive in EVERY goal is the one that names the authority.
    `Issue body: \`gh issue view ${issue.number}\` — the authority. This goal is a summary of it.`,
    '',
    ...workerMethodSection(workerMethod),
    '## Objective',
    issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`,
    '',
    // Immediately after the objective, and before everything else, for two
    // reasons. A worker reads top to bottom, and a prohibition read after the
    // work has started arrives too late (ADR §3.3's argument for `## Method`).
    // And the goal truncates from the END: the earlier a section sits, the less
    // reachable it is by the cut. It follows the objective rather than preceding
    // it because "what must not happen" is unreadable before "what is being
    // asked for".
    ...constraintSection(constraints, issue.number),
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'Derive from the issue; if unclear, stop and ask.'),
    '',
    '## Files you may change',
    bullets(declaredScopeFiles(issue), 'Unknown — inspect first; do not touch files owned by another issue.'),
    ...derivedScopeNote(issue),
    '',
    ...(requiredGates.length === 0 ? [] : [
      '## Acceptance gates this issue declared',
      ...requiredGates.map((id) => `- ${id}`),
      'These are gate ids from this repository\'s .commandmate/verify.yaml, named by the',
      'issue itself. They take part in the verdict; run them and make them pass.',
      '',
    ]),
    // The commands, not only the ids (Issue #125). A gate that exists ONLY in
    // this contract is one the worker cannot look up: it is in no file in the
    // worktree, and `verify.yaml` does not mention it. CommandMate's own preamble
    // resolves `gateDefinitions[].command` into the completion criterion for the
    // same reason, and stating it here too means the section a reader of
    // `<out>/prompts/` sees is the section the worker was sent.
    ...(definedGates.length === 0 ? [] : [
      '## Acceptance gates this issue defined',
      ...definedGates.map((gate) => `- ${gate.id}: ${gate.command}`),
      'The issue declared these commands itself and the execution contract carries them',
      'as verify.gateDefinitions. They run in ADDITION to this repository\'s own gates and',
      'take part in the verdict. Do not add them to .commandmate/verify.yaml — they belong',
      'to this issue, and the contract is what declares them.',
      '',
    ]),
    '## Rules',
    // FIRST in Rules (Issue #176). Rules are last in the goal and last is what the
    // truncation eats first, so the one rule that cannot be allowed to disappear
    // goes at the top of the list. It is stated for EVERY issue, including the ones
    // whose body the heuristic above found no prohibition in: a heuristic that
    // missed one leaves the worker with exactly the belief that produced the
    // measured failure.
    '- A prohibition this contract does not state is NOT a permission — it is text the',
    '  summary did not carry. Read the issue body (read-only) before you decide',
    '  anything it might constrain. 契約が言及していない禁止事項は、許可ではない。',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- The completion criterion above is the contract\'s, not a suggestion: run those',
    '  commands yourself and make them pass before reporting done. Do not report done',
    '  on a failing gate — the same gates decide the verdict.',
    '- Keep working across turns until the whole task is finished; do not stop half-done.',
    '- When the work is complete, make a SINGLE commit of this issue\'s changes on the',
    '  work branch. Verification can pass on uncommitted work, but nothing downstream',
    '  can deliver it, so the commit is what ends the task.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
  const redacted = redact(goal);
  if (redacted.length <= MAX_CONTRACT_GOAL) return redacted;
  const marker = '\n\n（この goal は契約の上限 8000 文字に合わせて切り詰められています）';
  return `${redacted.slice(0, MAX_CONTRACT_GOAL - marker.length)}${marker}`;
}

// The prompt types the contract authorises under `--auto-yes`, and why the runner
// stopped writing `mode: safe` (Issue #136, the correction on the issue).
//
// MEASURED, in the installed CommandMate 0.22.1:
//   - `dist/server/src/lib/polling/auto-yes-resolver.js`, `evaluatePolicyAgainstTexts`:
//       mode 'off'          -> {reason: 'mode-off'} for everything;
//       mode 'safe'         -> `promptType === 'yes_no' ? null : {reason: 'type-not-allowed'}`
//                              — the allow list is NOT consulted, `yes_no` is hardcoded;
//       mode 'allow-listed' -> `policy.allowPromptTypes.includes(promptType)`;
//       mode null (no block)-> falls through to `return null`, i.e. no constraint.
//   - `dist/server/src/lib/detection/prompt-detect-multiple-choice.js`: Claude's
//     permission menu (`❯ 1.` / `2.` / `3.`) is detected as `multiple_choice`.
//   - `dist/server/src/lib/tasks/contract-parser.js`: AUTO_YES_MODES is
//     ['off','safe','allow-listed'] and PROMPT_TYPES is ['yes_no','multiple_choice',
//     'approval','choice','input','continue'].
//   - the same resolver's `resolveBaseAnswer`: an answer is only ever produced for
//     `yes_no` ('y') and `multiple_choice` (the default option, else the first).
//     The other four types resolve to null before any policy is consulted.
//
// So `mode: safe` suppressed the ONE type that a Claude worker raises most —
// which is the bug: `--auto-yes` promised "prompts do not stop this run" and then
// wrote the policy that stops it on every edit approval.
//
// DECISION: under `--auto-yes` the contract states `mode: allow-listed` with
// exactly the two types the resolver can answer at all. The two alternatives were
// weighed against this:
//   - writing NO autoYes block (mode null, "no constraint") would work today, and
//     is rejected because it makes the run's authorisation unreadable: this runner
//     writes `mode: off` precisely because an active prohibition and an omission
//     are different things, and the same argument applies to permission. A null
//     policy also silently inherits whatever a future CommandMate teaches the base
//     rules to answer, without this Skill ever deciding to grant it.
//   - listing all six PROMPT_TYPES would grant four types that `resolveBaseAnswer`
//     never answers — a contract claiming an authorisation nobody can use, which
//     is exactly the kind of line a reader would later take as evidence.
// Under no `--auto-yes` the block stays `mode: off`: the safe default is an active
// prohibition, unchanged (ADR §4).
//
// `denyPatterns` is deliberately NEVER written. CommandMate #1699 measured what a
// deny list costs when it is matched against pane text: a command approved several
// turns earlier stayed inside the scrollback window and went on suppressing every
// later prompt — the run looked hung, and nothing said why. The scope gate and the
// verification gates are where this Skill constrains a worker; the parser's
// default (an empty list) is what the contract carries.
const AUTO_YES_ALLOWED_PROMPT_TYPES = ['yes_no', 'multiple_choice'];

// The contract document for one issue. Field order is fixed, so is every list.
//
// `requiredGates` is the issue's resolved `require:` list and `definedGates` its
// resolved `gates:` entries (both empty when the issue declared none). They are
// passed in rather than re-read here because the CALLER is what checked them
// against the worktree — a contract must never name a gate this run has not seen
// in `.commandmate/verify.yaml`, nor define one that file already declares.
function buildTaskContract(plan, issue, inputs, requiredGates = [], workerMethod = null, constraints = null, definedGates = []) {
  const allow = contractScopeAllow(issue);
  const verifyGates = contractVerifyGates(inputs.verifyGates, requiredGates, definedGateIds(definedGates));
  const lines = [];
  lines.push('# Generated by cmate-orchestrate (dispatch runner) from an approved plan.');
  lines.push('# Do not edit by hand: the same plan regenerates this file byte for byte.');
  lines.push('version: 1');
  lines.push(`title: ${yamlString(contractTitle(issue))}`);
  lines.push(yamlBlockScalar('goal', buildContractGoal(plan, issue, requiredGates, workerMethod, constraints, definedGates)));
  lines.push('scope:');
  if (allow.length === 0) {
    lines.push('  allow: []');
  } else {
    lines.push('  allow:');
    for (const pattern of allow) lines.push(`    - ${yamlString(pattern)}`);
  }
  lines.push('  deny: []');
  // `verify` is omitted unless the operator named gates: an id that does not
  // exist in the repository's verify.yaml makes `send --contract` exit 2.
  // Omitting the key means "run every declared gate", which is the stricter
  // reading, never the looser one — and it is why an issue's `require:` list
  // alone does NOT write this key (contractVerifyGates, ADR §3.4).
  // `gateDefinitions` is the OTHER half (Issue #125): the gates the issue
  // declared with a `gates:` block, carried by the contract itself. It is written
  // whenever the issue defined one, independently of `verify.gates` — the two
  // keys answer different questions (which gates run vs what a gate IS), and
  // omitting `gates` while defining one is the normal case, meaning "every
  // repository gate plus these".
  //
  // Nothing here touches `.commandmate/verify.yaml`. That is the point of the
  // upstream design: the file stays in the work-evidence change set so an agent
  // weakening its own judge is still visible, and the definition rides in the
  // contract, which is already snapshotted into `tasks.contract_json` and already
  // excluded from that change set.
  if (verifyGates.length > 0 || definedGates.length > 0) {
    lines.push('verify:');
    if (verifyGates.length > 0) {
      lines.push('  gates:');
      for (const gate of verifyGates) lines.push(`    - ${yamlString(gate)}`);
    }
    if (definedGates.length > 0) {
      lines.push('  gateDefinitions:');
      for (const gate of definedGates) {
        // The command is written VERBATIM — it is the thing that runs, and a
        // redacted command is a broken one. The goal's copy of the same line
        // does pass through `redact()`, so an issue that wrote an absolute host
        // path into its gate reads differently in the two places. That is the
        // safe direction (the prose a human reads does not echo the path) and
        // the case barely exists: a gate command naming `/Users/...` cannot run
        // in anyone else's worktree either.
        lines.push(`    - id: ${yamlString(gate.id)}`);
        lines.push(`      command: ${yamlString(gate.command)}`);
        // Absent when the author stated none, so CommandMate's own
        // DEFAULT_TIMEOUT_SEC applies rather than a number this runner invented.
        if (gate.timeoutSec !== undefined) lines.push(`      timeoutSec: ${gate.timeoutSec}`);
        // Same rule for the #1771 / #1772 fields: written only when the issue
        // declared them, so a contract for an issue that used none is byte-
        // identical to the one this runner wrote before the keys existed, and
        // "not declared" keeps meaning "this gate runs exactly once, exclusive
        // of nothing" rather than a default this runner chose.
        if (gate.mutex !== undefined) lines.push(`      mutex: ${yamlString(gate.mutex)}`);
        if (gate.retryOnFail !== undefined) lines.push(`      retryOnFail: ${gate.retryOnFail}`);
        if (gate.flakyIsPass !== undefined) lines.push(`      flakyIsPass: ${gate.flakyIsPass}`);
      }
    }
  }
  // The contract states the same Auto-Yes stance the runner itself takes, so the
  // server-side policy and the supervision loop cannot disagree. `off` is an
  // active prohibition (distinct from omitting the block, which says nothing).
  //
  // These lines are a POLICY DECLARATION and nothing else (Issue #136): the
  // server's Auto-Yes poller reads them only after it has already started, and it
  // starts only when the WORKTREE's auto-yes state is enabled. Enabling that state
  // is the separate job of `send --auto-yes` (autoYesSendFlags). BOTH are needed —
  // the policy decides which prompts may be answered, the state decides whether
  // anything is looking — and neither one alone answers a single prompt.
  //
  // Which types are authorised, and why not `safe`, is decided at
  // AUTO_YES_ALLOWED_PROMPT_TYPES above.
  lines.push('autoYes:');
  lines.push(`  mode: ${yamlString(inputs.autoYes ? 'allow-listed' : 'off')}`);
  if (inputs.autoYes) {
    lines.push('  allowPromptTypes:');
    for (const type of AUTO_YES_ALLOWED_PROMPT_TYPES) lines.push(`    - ${yamlString(type)}`);
  }
  lines.push('success:');
  lines.push('  requireWorkEvidence: true');
  // Always true (Issue #50). It used to be `allow.length > 0`, which turned an
  // empty scope into the ONE configuration where a worker may write any file in
  // the worktree and still be judged clean — the plan that named no file got the
  // widest permission of all. The gate is now unconditional, and an empty scope
  // is refused before a contract is ever sent (see the dispatch loop); a
  // contract built with no allow list therefore fails closed rather than open.
  lines.push('  requireScopeClean: true');
  lines.push('  autoVerifyOnStop: false');
  return `${lines.join('\n')}\n`;
}

function contractRelativePath(issueNumber) {
  return `${CONTRACT_DIR}/${CONTRACT_FILE_PREFIX}${issueNumber}.yaml`;
}

// =============================================================================
// Acceptance gates (Issue #114 / references/adr-issue-acceptance-gates.md)
// =============================================================================
//
// The plan carries `issues[].acceptance_gates.require` — gate ids the ISSUE said
// must take part in its verdict. The planner checked their SYNTAX only; it never
// opens the target repository. This runner does: it holds the `ls`-resolved
// worktree path, so it can read that worktree's own `.commandmate/verify.yaml`
// and answer whether the ids exist (ADR §3.4).
//
// Nothing here writes to the worktree, and that is now the whole design rather
// than a property of stage 1. `require:` selects gates that are ALREADY declared;
// `gates:` DEFINES new ones, and the definition travels in the execution
// contract's `verify.gateDefinitions` (CommandMate #1791) instead of being
// appended to `.commandmate/verify.yaml`. The file that records what this
// repository counts as passing stays in the work-evidence change set on purpose —
// an agent weakening its own judge must remain visible — so the one thing this
// runner must never do to it is write (ADR §3.5.1).

// The ids a contract's `verify.gates` may name WITHOUT them appearing in
// verify.yaml. Transcribed from CommandMate's own contract-vs-config check,
// which builds its known set as {work-evidence, scope} ∪ declared gate ids.
// `env-clean` is a built-in gate but is deliberately NOT in that set, so a
// `require: [env-clean]` is refused here exactly as `send --contract` would.
const CONTRACT_BUILT_IN_GATE_IDS = ['work-evidence', 'scope'];

// The worktree's gate table is read by lib.mjs's `readVerifyConfigGates` — the
// same function `inspect.mjs --evaluate-gates` uses to find the COMMAND behind
// an id it is about to run at the base (Issue #218). The reader stood here until
// then and moved unchanged: same subset, same fail-closed refusals, the same ids
// in the same order. Only the address changed, so that "what this repository
// declares" has one reader instead of two that can drift apart.

// The `require:` list of one plan issue, re-validated on the way in. The plan is
// an INPUT — a hand-edited one must not be able to put a malformed id into a
// contract, where the failure would be reported as "the runner wrote a bad
// contract" instead of "the plan declares something unusable".
function issueRequiredGates(issue) {
  const declared = issue.acceptance_gates;
  if (declared === null || declared === undefined) return { ids: [], define: [], error: null };
  const bad = (reason) => ({ ids: [], define: [], error: reason });
  if (typeof declared !== 'object' || Array.isArray(declared)) return bad('acceptance_gates must be an object or null');
  if (declared.version !== 1) return bad(`acceptance_gates.version must be 1 (got ${JSON.stringify(declared.version)})`);
  if (!Array.isArray(declared.require)) return bad('acceptance_gates.require must be a list');
  if (declared.require.length > MAX_GATE_IDS) return bad(`acceptance_gates.require names more than ${MAX_GATE_IDS} gate ids`);
  const ids = [];
  for (const id of declared.require) {
    if (typeof id !== 'string' || !GATE_ID_RE.test(id)) return bad(`acceptance_gates.require contains "${redact(String(id))}", which is not a valid gate id`);
    if (ids.includes(id)) return bad(`acceptance_gates.require repeats "${id}"`);
    ids.push(id);
  }
  const definitions = issueDefinedGates(declared, ids);
  if (definitions.error !== null) return bad(definitions.error);
  // The block that names nothing at all. The planner refuses it, so a plan that
  // carries one was hand-edited — and "declares acceptance gates" would then be
  // true of an issue whose verdict nothing extra judges.
  if (ids.length === 0 && definitions.define.length === 0) return bad('acceptance_gates declares neither a required nor a defined gate');
  return { ids, define: definitions.define, error: null };
}

// `acceptance_gates.gates` — the gates the ISSUE defines, which travel in the
// contract's `verify.gateDefinitions` (CommandMate #1791). Re-validated on the
// way in for the same reason `require` is: the plan is an INPUT, and a
// hand-edited one must not be able to put an entry into a contract that
// `send --contract` then rejects with "the contract was invalid" about a worker
// that never ran.
//
// Every rule here is transcribed from verify-config's `validateGateEntries`, the
// function upstream runs over BOTH `.commandmate/verify.yaml` gates and a
// contract's definitions — that is, exactly the rules whose violation would make
// `send --contract` exit 2. Two rules are deliberately elsewhere:
//
//   - the collision with the worktree's own gate ids needs the worktree, so the
//     dispatch loop does it after `ls` has resolved a path;
//   - the `issue-<number>-` naming is a NOTATION rule, not an upstream one, so
//     the planner owns it. Re-checking it here would refuse a hand-edited plan
//     that CommandMate itself would accept, which is a different job from
//     "never write a contract the server will reject".
function issueDefinedGates(declared, requiredIds) {
  const bad = (error) => ({ define: [], error });
  if (declared.gates === undefined) return { define: [], error: null };
  if (!Array.isArray(declared.gates) || declared.gates.length === 0) return bad('acceptance_gates.gates must be a non-empty list when the key is present');
  if (declared.gates.length > MAX_GATE_DEFINITIONS) return bad(`acceptance_gates.gates defines more than ${MAX_GATE_DEFINITIONS} gates`);
  const define = [];
  const seen = new Set(requiredIds);
  for (const gate of declared.gates) {
    if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return bad('acceptance_gates.gates contains an entry that is not an object');
    const id = gate.id;
    if (typeof id !== 'string' || !GATE_ID_RE.test(id)) return bad(`acceptance_gates.gates contains "${redact(String(id))}", which is not a valid gate id`);
    if (RESERVED_GATE_IDS.includes(id)) return bad(`acceptance_gates.gates redefines "${id}", which is reserved for a built-in gate`);
    if (seen.has(id)) return bad(`acceptance_gates declares "${id}" twice`);
    seen.add(id);
    if (typeof gate.command !== 'string' || gate.command.trim() === '') return bad(`acceptance_gates.gates entry "${id}" declares no command`);
    const entry = { id, command: gate.command };
    if (gate.timeoutSec !== undefined) {
      if (!Number.isInteger(gate.timeoutSec) || gate.timeoutSec < MIN_GATE_TIMEOUT_SEC || gate.timeoutSec > MAX_GATE_TIMEOUT_SEC) {
        return bad(`acceptance_gates.gates entry "${id}" declares timeoutSec ${JSON.stringify(gate.timeoutSec)}, which is not an integer in ${MIN_GATE_TIMEOUT_SEC}..${MAX_GATE_TIMEOUT_SEC}`);
      }
      entry.timeoutSec = gate.timeoutSec;
    }
    // Issues #223 / #224: the same three fields upstream's shared validator
    // accepts on a gate entry, with the same value domains. Re-checked here for
    // the reason every rule in this function is — the plan is an INPUT, and a
    // hand-edited one must not put an entry into a contract that
    // `send --contract` then rejects about a worker that never ran.
    if (gate.mutex !== undefined) {
      if (typeof gate.mutex !== 'string' || gate.mutex === '' || gate.mutex.length > MAX_GATE_MUTEX_LENGTH || !GATE_MUTEX_RE.test(gate.mutex)) {
        return bad(`acceptance_gates.gates entry "${id}" declares mutex ${JSON.stringify(gate.mutex)}, which is not a 1..${MAX_GATE_MUTEX_LENGTH} character name matching ${GATE_MUTEX_RE.source}`);
      }
      entry.mutex = gate.mutex;
    }
    if (gate.retryOnFail !== undefined) {
      if (gate.retryOnFail !== 0 && gate.retryOnFail !== MAX_RETRY_ON_FAIL) {
        return bad(`acceptance_gates.gates entry "${id}" declares retryOnFail ${JSON.stringify(gate.retryOnFail)}, and only 0 or ${MAX_RETRY_ON_FAIL} are allowed`);
      }
      entry.retryOnFail = gate.retryOnFail;
    }
    if (gate.flakyIsPass !== undefined) {
      if (typeof gate.flakyIsPass !== 'boolean') {
        return bad(`acceptance_gates.gates entry "${id}" declares flakyIsPass ${JSON.stringify(gate.flakyIsPass)}, which is not true or false`);
      }
      if (gate.flakyIsPass && gate.retryOnFail !== MAX_RETRY_ON_FAIL) {
        return bad(`acceptance_gates.gates entry "${id}" declares flakyIsPass: true without retryOnFail: ${MAX_RETRY_ON_FAIL}; without a retry a gate can never be FLAKY`);
      }
      entry.flakyIsPass = gate.flakyIsPass;
    }
    define.push(entry);
  }
  return { define, error: null };
}

// The contract's `verify.gates` list — ADR §3.4, whose whole point is that
// adding a requirement must never NARROW what runs.
//
//   operator   issue      contract
//   --------   -------    ----------------------------------------------------
//   none       none       key omitted  (= every declared gate runs)
//   none       require    key omitted  (= every declared gate runs, and the
//                                        required ones are necessarily among
//                                        them — their existence was verified)
//   --gates    none       the operator's list, in the operator's order
//   --gates    require    the union, sorted and de-duplicated
//
// Writing `verify.gates: [<require>]` for row 2 is the mistake this table
// exists to prevent: it would turn "these gates must also judge me" into "only
// these gates judge me", and lint and test would stop running on the very issue
// that asked for a stricter verdict.
//
// `definedGates` (the ids of the issue's `gates:` definitions, Issue #125) joins
// the union for a reason the table above cannot express: when `verify.gates` is
// written at all, CommandMate's contract parser REQUIRES every id in
// `verify.gateDefinitions` to appear in it — "defined but not named in
// verify.gates" is a contract error, because that contract is the definition's
// only declaration site and an unselected one would never run anywhere. Omitting
// the key (rows 1 and 2) already runs every definition, so nothing is needed
// there.
function contractVerifyGates(operatorGates, requiredGates, definedGates = []) {
  if (operatorGates.length === 0) return [];
  if (requiredGates.length === 0 && definedGates.length === 0) return operatorGates.slice();
  return [...new Set([...operatorGates, ...requiredGates, ...definedGates])].sort();
}

// The ids of the gates an issue defines, in the author's order.
function definedGateIds(definedGates) {
  return definedGates.map((gate) => gate.id);
}

// Place the contract in the worktree (what `send --contract` reads) and keep a
// copy in the run artifact (what a human or a later audit reads — the worktree
// copy can be edited or deleted by the worker it constrains).
function placeContract(worktreePath, issueNumber, text, artifactDir) {
  const relative = contractRelativePath(issueNumber);
  const target = join(worktreePath, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, 'utf8');
  writeFileSync(join(artifactDir, `issue-${issueNumber}.yaml`), text, 'utf8');
  return relative;
}

// =============================================================================
// Worker prompt (self-contained, generic — no repository-local worker Skill)
// =============================================================================

// NOT shared with merge/uat: those two redact each item on the way in, because
// their bullets render values lifted from a terminal. Here every caller passes
// already-redacted plan text.
function bullets(items, fallback) {
  if (!Array.isArray(items) || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join('\n');
}

// The files the ISSUE declared, without the ones the planner derived from them
// (CommandMate #3004). `scope_defaults` — same-directory lockfiles and the
// conventional test paths of every declared source file (ADR layer L1) — is a
// PERMISSION the contract's `scope.allow` still carries in full; listing it in
// the goal presented it as work. Measured on Kewton/Musunest: 55 / 61 / 60
// listed paths for 20 / 22 / 22 real files (#180 / #182 / #181), so the goal
// read as three times the work, the 8000-character cap was spent on files that
// do not exist, and "is this dispatchable" was judged on the inflated number.
// A plan without `scope_defaults` (written before #44) lists every entry, as
// before. A test path the issue itself declared is a declared file and stays.
function declaredScopeFiles(issue) {
  const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
  const derived = new Set(Array.isArray(issue.scope_defaults) ? issue.scope_defaults : []);
  return files.filter((file) => !derived.has(file));
}

// One line saying the derived allowances exist and what they are for, so a
// worker that needs a lockfile or a test beside a declared file knows it may
// write one — without the goal enumerating paths most of which never exist.
function derivedScopeNote(issue) {
  const files = new Set(Array.isArray(issue.suspected_files) ? issue.suspected_files : []);
  const derived = (Array.isArray(issue.scope_defaults) ? issue.scope_defaults : []).filter((file) => files.has(file));
  if (derived.length === 0) return [];
  return [
    `Also allowed, not listed: ${derived.length} path(s) the planner derived from the files above (lockfiles`,
    'beside a dependency manifest, conventional test paths beside a source file). They are permissions,',
    'not work items: write one only if the task needs it.',
  ];
}

// Everything a worker needs to act on one issue, drawn only from the plan. It is
// deliberately Agent-agnostic and repository-agnostic: the same prompt works for
// any worker CLI because it names the objective, the boundary (only the
// issue's files), the branch/worktree, the baseline to run, and the rule that a
// blocking question must stop and ask rather than be guessed.
function buildWorkerPrompt(plan, issue, workerMethod = null, constraints = null) {
  return [
    `# Worker task — issue #${issue.number}`,
    '',
    `Repository: ${plan.profile.repository}`,
    `Base branch: ${plan.profile.base}`,
    `Work branch: ${issue.branch ?? '(from profile template)'}`,
    `Worktree: ${issue.worktree ?? '(from profile template)'}`,
    // Same line, same reason, as the contract goal's (Issue #176). This path is the
    // one an older CLI takes, and it is the path nobody is watching.
    `Issue body: \`gh issue view ${issue.number}\` — the authority. This prompt is a summary of it.`,
    '',
    ...workerMethodSection(workerMethod),
    '## Objective',
    issue.objective ?? issue.title ?? `Resolve issue #${issue.number}.`,
    '',
    ...constraintSection(constraints, issue.number),
    '## Acceptance criteria',
    bullets(issue.acceptance_criteria, 'Derive from the issue; if unclear, stop and ask.'),
    '',
    '## Files you may change',
    bullets(issue.suspected_files, 'Unknown — inspect first; do not touch files owned by another issue.'),
    '',
    '## Verification to run before reporting done',
    bullets(plan.profile.baseline, 'Run the repository baseline.'),
    '',
    '## Rules',
    '- A prohibition this prompt does not state is NOT a permission — it is text the',
    '  summary did not carry. Read the issue body (read-only) before you decide',
    '  anything it might constrain. 契約が言及していない禁止事項は、許可ではない。',
    '- Stay within this issue. Do not modify files another issue in the plan owns.',
    '- Run the verification above and report its real result. Do not report done on a failing baseline.',
    '- Keep working across turns until the whole task is finished; do not stop half-done.',
    '- When the work is complete, make a SINGLE commit of this issue\'s changes on the',
    '  work branch. That commit is the completion signal — the supervisor treats a new',
    '  commit as "done" and will otherwise nudge you to keep going.',
    '- If a step is destructive, ambiguous, or blocked, STOP and ask. Do not guess.',
    '- Do not print tokens, secrets, or absolute host paths.',
  ].join('\n');
}

// =============================================================================
// Supervision primitives
// =============================================================================

// One `commandmate ls --json` lookup by branch. `listed` distinguishes the two
// ways this comes back empty, which the sync retry below has to tell apart: a
// parsed list that simply holds no matching row (a registry that may be stale)
// versus an `ls` that produced no list at all (a broken or unreachable CLI, which
// re-scanning cannot fix).
function lookupWorktree(inputs, branch) {
  const result = runCm(inputs, ['ls', '--json']);
  const rows = parseCliJson(result);
  if (!Array.isArray(rows)) {
    return { id: null, path: null, note: excerpt(result.stderr || result.stdout || 'ls returned no worktree list'), listed: false };
  }
  const match = rows.find((row) => row && (row.branch === branch || row.name === branch));
  const id = match && typeof match.id === 'string' && WORKTREE_ID_RE.test(match.id) ? match.id : null;
  // Issue #1473: git operations (commit detection and baseline verification) must
  // run in the SAME worktree that `send`/`wait`/`capture` target — the one
  // CommandMate actually registered — not the plan's `worktree_template` path,
  // which can differ. `ls --json` reports each worktree's real `path`; carry it
  // (path-escape checked) so the supervisor cwd's into the registered directory.
  // The plan template stays a fallback for when `ls` omits a path.
  const path = match && typeof match.path === 'string' ? safeWorktreeTarget(match.path) : null;
  return { id, path, note: id ? '' : `no registered worktree matches branch ${redact(branch)}`, listed: true };
}

// The one `commandmate sync` a run is allowed, and what came of it. Null until an
// unresolved branch triggers it; read again when the report is assembled so the
// attempt is stated in `limitations` rather than changing the run's behaviour in
// silence (Issue #91).
let syncAttempt = null;

// `commandmate sync` re-scans every repository and registers the worktrees it
// finds with the server. It is a SERVER-WIDE rescan, so one call answers for every
// branch in the run: syncing per branch would re-scan the same registry N times
// for the same answer. `fresh` says whether this caller is the one that ran it.
//
// `force` is the one thing that buys a SECOND re-scan, and only the worktree
// preparation stage sets it (Issue #93): once worktrees have been created, the
// world the earlier sync answered about no longer exists, so "we already asked"
// stops being a reason not to ask again. Anything the earlier attempt could not
// resolve is dropped from the tally for the same reason — it was measured against
// a registry that predates the new worktrees.
function attemptSync(inputs, { force = false } = {}) {
  const fresh = force || syncAttempt === null;
  if (fresh) {
    const previous = syncAttempt;
    const result = runCm(inputs, ['sync']);
    syncAttempt = {
      runs: (previous?.runs ?? 0) + 1,
      ok: result.ok,
      detail: result.ok
        ? 'the server re-scanned its repositories'
        : excerpt(result.stderr || result.stdout || 'commandmate sync failed'),
      resolved: previous?.resolved ?? [],
      unresolved: force ? [] : (previous?.unresolved ?? []),
    };
  }
  return { fresh, ok: syncAttempt.ok, detail: syncAttempt.detail };
}

// Resolve the CommandMate worktree id an issue's work lives in, at dispatch time.
// The public CLI is worktree-id based (`send <id> …`); the id is the one
// CommandMate assigned, a `<repo>-<branch>` slug we cannot reconstruct reliably.
// A plan may already carry a resolved `worktree_id`; otherwise we ask the live
// CLI which worktree currently holds the issue's branch — `commandmate ls --json`
// is the source of truth for the id.
//
// `commandmate sync` DOES exist (CommandMate 0.21.0+, Kewton/CommandMate#1680):
// it re-scans repositories and registers their worktrees with the server. It
// CREATES nothing, so it cannot conjure a worktree that was never made — but it
// does close the one gap `ls` alone cannot see: a worktree that exists on disk and
// was created after the server last scanned is registered nowhere, so it has no
// id to send to. When `ls` lists rows but none match the branch we therefore sync
// ONCE and read `ls` again (Issue #91). A CLI too old to have `sync` fails that
// call; the branch then stays unresolved and the run stops exactly as it did
// before (Issue #90) — the sync failure itself never stops it.
function resolveWorktreeId(inputs, issue) {
  if (typeof issue.worktree_id === 'string' && WORKTREE_ID_RE.test(issue.worktree_id)) {
    return { id: issue.worktree_id, path: null, note: '' };
  }
  const branch = typeof issue.branch === 'string' ? issue.branch : null;
  if (!branch) return { id: null, path: null, note: 'issue has no branch to resolve a worktree from' };
  const first = lookupWorktree(inputs, branch);
  // Resolved, or `ls` did not answer at all: a re-scan is only meaningful against
  // a registry we could actually read.
  if (first.id !== null || !first.listed) return { id: first.id, path: first.path, note: first.note };

  const sync = attemptSync(inputs);
  const stillUnresolved = (note) => {
    syncAttempt.unresolved.push(redact(branch));
    return { id: null, path: null, note };
  };
  if (!sync.ok) {
    return stillUnresolved(`${first.note} (commandmate sync could not re-scan the registry: ${sync.detail})`);
  }
  if (!sync.fresh) {
    // The rescan already happened earlier in this run, so the `ls` above already
    // read the post-sync registry. Re-syncing would ask the same question twice.
    return stillUnresolved(`${first.note} (commandmate sync had already re-scanned the registry earlier in this run)`);
  }
  const retried = lookupWorktree(inputs, branch);
  if (retried.id !== null) {
    syncAttempt.resolved.push(redact(branch));
    return { id: retried.id, path: retried.path, note: '' };
  }
  return stillUnresolved(`${retried.note} (commandmate sync re-scanned the registry and ls still resolves no id)`);
}

// State the sync attempt in the report. Both outcomes are worth a limitation: a
// successful re-scan means the id an operator reads was NOT the one the plan or a
// first `ls` produced, and a failed one means an unresolved-worktree stop was
// judged on a registry that could not be refreshed (a CommandMate older than
// 0.21.0 has no `sync`). Neither is a blocking reason — the run's outcome is
// decided by whether the worktree resolved, not by the sync (Issue #91).
function recordSyncAttempt(report) {
  if (syncAttempt === null) return;
  const resolved = syncAttempt.resolved.length > 0 ? syncAttempt.resolved.join(', ') : 'none';
  const unresolved = syncAttempt.unresolved.length > 0 ? syncAttempt.unresolved.join(', ') : 'none';
  // More than one re-scan means the preparation stage forced a second one after
  // creating worktrees (Issue #93). Stated, because "sync ran once per run" is a
  // property the report has always asserted and this is the one exception to it.
  if (syncAttempt.runs > 1) {
    report.limitations.push({
      code: 'worktree_sync_rescanned',
      detail: `commandmate sync ran ${syncAttempt.runs} times in this run: once while resolving worktrees and once more after --prepare-worktrees created worktrees the earlier re-scan could not have seen`,
    });
  }
  // "run once" is the ordinary case and stays worded that way; a preparation run
  // says how many times instead, so this sentence never contradicts the
  // `worktree_sync_rescanned` one above it.
  const howOften = syncAttempt.runs > 1 ? `was run ${syncAttempt.runs} times` : 'was run once';
  report.limitations.push(syncAttempt.ok
    ? {
      code: 'worktree_sync_ran',
      detail: `commandmate ls resolved no worktree for a planned branch, so commandmate sync ${howOften} and ls was retried: ${syncAttempt.detail}; resolved after the re-scan: ${resolved}; still unresolved: ${unresolved}`,
    }
    : {
      code: 'worktree_sync_unavailable',
      detail: `commandmate ls resolved no worktree for a planned branch and commandmate sync failed (${syncAttempt.detail}), so the registry could not be re-scanned and ${unresolved} stayed unresolved; the sync failure alone did not stop the run (a CommandMate older than 0.21.0 has no sync subcommand)`,
    });
}

// Resolve every issue of one wave ONCE: its id (what send/wait/capture address),
// the real `path` `commandmate ls` reports (what git rev-parse and the baseline
// cwd into), and the plan template path that is the fallback when `ls` omits a
// path. The drift probe, the supervision loop and the verification gate all read
// this single resolution, so the id path and the git path can never diverge
// (Issue #1473). Called once per wave — and, for the first wave, by the
// pre-flight, whose result the loop reuses rather than resolving twice.
function resolveWave(inputs, plan, waveIssues) {
  return waveIssues.map((number) => {
    const issue = issueOf(plan, number);
    const templatePath = safeWorktreeTarget(issue.worktree ?? '');
    const resolved = resolveWorktreeId(inputs, issue);
    const worktreePath = resolved.path ?? templatePath;
    return { number, issue, templatePath, resolved, worktreePath };
  });
}

// The HEAD commit of a worktree, read INSIDE it (there is no commandmate call for
// this). The supervisor snapshots this before dispatch and compares after each
// idle: a changed HEAD means the worker committed its work — the real completion
// signal (Issue #1468). Null when HEAD cannot be read (a broken/absent worktree),
// which the supervisor treats as "no commit yet", never as done.
async function worktreeHeadSha(inputs, worktreePath) {
  if (!worktreePath) return null;
  const result = await runCliAsync(inputs.git, ['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

// The auto-yes window `commandmate send --auto-yes` opens, and why this runner
// names one instead of taking the CLI's default (Issue #136).
//
// MEASURED, in the installed CommandMate 0.22.1 — the same bundle ADR §14.6 read
// the poller out of:
//   - `dist/cli/config/duration-constants.js`: `DURATION_MAP = {'1h': 3600000,
//     '3h': 10800000, '8h': 28800000}` and `parseDurationToMs` returns null for
//     anything else; `dist/cli/commands/send.js` then prints "Error: Invalid
//     duration. Must be one of: 1h, 3h, 8h" and exits BEFORE any side effect. The
//     window is therefore not a free number — it is one of exactly three, and a
//     computed "seconds" value would abort the dispatch rather than widen it.
//   - `dist/cli/commands/send.js`: `DEFAULT_AUTO_YES_DURATION = '1h'` when
//     `--duration` is omitted. Omitting it is a choice of 1h, not a choice of
//     "no expiry".
//
// WHAT HAS TO BE COVERED is one worker's supervision in ONE worktree. The state
// `send --auto-yes` enables is per worktree and every issue in a plan has its own,
// so neither the wave count nor the wave width multiplies the need (ADR §14.2
// measured that wave width does not move the wall clock either: a wave is
// supervised concurrently, so 3 issues cost the same 8×`--wait-timeout` as 1).
// The per-worker ceiling that section measured is `--max-turns × --wait-timeout`:
//   - defaults, 8 × 300 s = 40 min      → 1h covers it with 20 min to spare;
//   - the run in #136, 10 × 2700 s = 7 h 30 min → the default 1h is gone during the
//     second wait, which is this same bug wearing different clothes.
//
// DECISION: arm the SMALLEST of the three windows that covers `--max-turns ×
// --wait-timeout`, and never a flat 8h. Two reasons, and the second is what rules
// out "just always take the widest":
//   1. the window OUTLIVES this process. Auto-yes is server-side worktree state;
//      revoking it is not on the CLI surface these runners are allowed to use
//      (commandmate-cli-contract.json has no `auto-yes` subcommand), and a run
//      that is killed mid-wave would not get to revoke anything anyway. Hours of
//      auto-yes nobody asked for means answered prompts for whoever opens that
//      worktree next.
//   2. expiry is NOT fatal. The prompt path this runner drives itself — `wait
//      --on-prompt agent` → exit 10 → `commandmate respond` under `--auto-yes` —
//      does not consult the worktree state at all, so a window that closes early
//      degrades to exactly the pre-#136 behaviour instead of stalling the run.
// So over-granting costs something real and under-granting costs the tail of a
// very long run; the window is sized to the ceiling, not to the backstop
// (`hardIterations`, which exists so a prompt/respond ping-pong cannot spin
// forever — sizing to it would buy 8h for a default run that needs 40 min).
//
// `--max-turns × --wait-timeout` is a FLOOR: ADR §14.2 measured the real elapsed
// ABOVE the formula by the per-turn CLI overhead, and could not put a number on
// that overhead for a real server. The comparison is therefore STRICT — a need
// that reaches a window's exact length takes the next one up — which leaves the
// remainder of the window as headroom for the overhead instead of inventing a
// figure for it.
const AUTO_YES_WINDOWS = [
  { duration: '1h', seconds: 3600 },
  { duration: '3h', seconds: 10800 },
  { duration: '8h', seconds: 28800 },
];

// The supervision one armed worktree has to outlive, in seconds.
function autoYesCeilingSeconds(inputs) {
  return inputs.maxTurns * inputs.waitTimeout;
}

function autoYesWindow(inputs) {
  const need = autoYesCeilingSeconds(inputs);
  return AUTO_YES_WINDOWS.find((window) => need < window.seconds) ?? AUTO_YES_WINDOWS[AUTO_YES_WINDOWS.length - 1];
}

// The flags that ENABLE auto-yes on the worktree, for the one send that opens a
// worker's supervision (Issue #136). Empty unless `--auto-yes` was explicitly
// passed, so the safe default — and every run that predates this — sends exactly
// what it sent before. The contract's `autoYes.mode` is written either way: it
// declares the policy, this enables the state the poller checks before it reads
// any policy at all.
function autoYesSendFlags(inputs) {
  if (!inputs.autoYes) return [];
  return ['--auto-yes', '--duration', autoYesWindow(inputs).duration];
}

// `commandmate send <worktree-id> <message>`, then confirm the worker actually
// started (Issue #1468). A send can leave the message unsubmitted (Enter not
// confirmed), which would leave the worker idle so the next `wait` returns
// "completed" with nothing done. We capture the worker's live state right after
// sending; if it is neither generating nor holding a prompt, we treat the send as
// unconfirmed and re-send once to force submission. The commit check below is the
// real ground truth, so this is a best-effort confirmation, not a guarantee.
//
// `armAutoYes` is set by the ONE send that opens a worker's supervision (Issue
// #136), never by a nudge or a re-instruction: the state is already enabled by
// then, and the flags carry a duration whose clock the first send started on
// purpose. The re-send below stays plain for the same reason — it exists to submit
// a message the first send may have left in the input box, not to re-arm anything.
async function sendAndConfirm(inputs, worktreeId, message, { armAutoYes = false } = {}) {
  const first = await sendRetryingNotReady(inputs, worktreeId, ['send', worktreeId, message, ...(armAutoYes ? autoYesSendFlags(inputs) : [])]);
  if (!first.ok) {
    return { sent: false, note: excerpt(first.stderr || first.stdout || 'send failed') };
  }
  const capture = parseCliJson(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, confirmed: true, note: '' };
  const again = await runCmAsync(inputs, ['send', worktreeId, message]);
  if (!again.ok) {
    return { sent: true, confirmed: false, note: 'send may not have submitted and the re-send failed' };
  }
  return { sent: true, confirmed: false, note: 're-sent after an unconfirmed first send' };
}

// What happened on the send side of each worker, keyed by worktree id and read
// back once its supervision has returned (CommandMate#3006 / #3007). A side
// table rather than a field on every return of the two supervision loops: those
// have a dozen exits each, and a fact that only some of them remembered to carry
// is a fact the report would lose on the others.
const sendTraces = new Map();

function sendTraceOf(worktreeId) {
  if (!sendTraces.has(worktreeId)) sendTraces.set(worktreeId, { notReadyRetries: [], stalePrompt: null });
  return sendTraces.get(worktreeId);
}

function sleepMs(ms) {
  return ms > 0 ? new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }) : Promise.resolve();
}

// ONE `commandmate send`, retried exactly once when the server refused it as
// not-ready (CommandMate#3006; the rule and both spellings are in lib.mjs
// `sendNotReadyKind`). Everything else — exit 2 PROMPT_WAITING, a 409, a
// contract rejection — is returned untouched, as before: those are refusals a
// second identical send cannot change. A retry that the wall-clock budget cannot
// fit is not made; the budget's own timeout then reports the stop.
async function sendRetryingNotReady(inputs, worktreeId, args) {
  const first = await runCmAsync(inputs, args);
  const kind = sendNotReadyKind(first);
  if (kind === null) return first;
  const delayMs = sendPauseMs(SEND_NOT_READY_RETRY_DELAY_MS);
  const entry = { kind, delay_ms: delayMs, contract: args.includes('--contract'), outcome: 'not_retried', first: excerpt(first.stderr || first.stdout), second: null };
  sendTraceOf(worktreeId).notReadyRetries.push(entry);
  if (wallClockDeadline !== null && Date.now() + delayMs >= wallClockDeadline) return first;
  await sleepMs(delayMs);
  if (wallClockExhausted()) return first;
  const second = await runCmAsync(inputs, args);
  entry.outcome = second.ok ? 'sent' : 'refused_again';
  if (!second.ok) entry.second = excerpt(second.stderr || second.stdout);
  return second;
}

// The report's half of a not-ready retry: one limitation per retry, sent or not.
function notReadyRetryLimitation(issue, entry) {
  const cause = entry.kind === 'session_starting'
    ? 'the session was still starting (503 SESSION_STARTING)'
    : 'the agent\'s composer was not ready (prompt not ready)';
  const outcome = {
    sent: 'the retry went through',
    refused_again: `the retry was refused too (${entry.second ?? 'no output'}), so this send failed exactly as it did before the retry existed`,
    not_retried: 'no retry was made: the --wall-clock-budget could not fit the wait before it',
  }[entry.outcome];
  return {
    code: 'send_retried_not_ready',
    detail: redact(`#${issue}: a \`commandmate send\` exited ${SEND_NOT_READY_EXIT} because ${cause}; nothing had been typed. `
      + `Waited ${Math.round(entry.delay_ms / 1000)}s and sent it once more — ${outcome}`
      + (entry.contract && entry.outcome === 'sent'
        ? '. The refused `send --contract` had already marked its task failed, so the recorded task id is the retry\'s'
        : '')),
  };
}

// A question left on the session by an EARLIER turn (CommandMate#3007).
//
// MEASURED (Kewton/Musunest #201 / #204): a worker that stopped on a question in a
// previous run still shows it when the next contract is sent to the same session,
// and the question UI holds the composer. Upstream refuses such a send in two
// different ways, neither of which says "a stale question": a question the
// scraper can read is 409 PROMPT_WAITING (exit 2), while one it cannot read — and
// Command Code's plan review, which the send guard deliberately does not count —
// only times out the composer wait (exit 99, "prompt not ready"). So dispatch
// LOOKS before the first send: one `capture --json`, and either of the two flags
// the server publishes for "a human has to decide on this screen" stops it.
//
//   isPromptWaiting        a prompt the server can answer (AskUserQuestion, y/n)
//   isSelectionListActive  a selection screen it cannot answer for anyone
//                          (an unreadable question UI, the plan review)
//
// The question is NEVER answered — not with --auto-yes either: it belongs to a
// turn whose context this run does not have. The default is to stop with
// `stale_prompt_on_session`. `--interrupt-stale-prompt` dismisses it with
// `commandmate interrupt` (the GUI's interrupt button; Esc on these screens),
// reads the session again, and sends only when neither flag is up any more.
//
// A capture that cannot be read does not stop the send: this check is a
// narrowing on top of the server's own guard, which is fail-open for the same
// reason (a false refusal makes a session nobody can talk to), and the send
// itself is still refused upstream if a readable prompt is there.
const STALE_PROMPT_SETTLE_MS = 3000;
const STALE_SCREEN_FLAGS = ['isPromptWaiting', 'isSelectionListActive'];

function readStaleScreen(result) {
  const payload = parseCliJson(result);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const flags = STALE_SCREEN_FLAGS.filter((flag) => payload[flag] === true);
  const question = typeof payload.promptData?.question === 'string' ? payload.promptData.question : '';
  return {
    flags,
    excerpt: excerpt(question || (typeof payload.content === 'string' ? payload.content : '')) ?? 'a question or selection screen',
  };
}

// Null when the first send may go ahead; otherwise the stop, already recorded in
// the worker's send trace.
async function clearStalePrompt(inputs, worktreeId) {
  const screen = readStaleScreen(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  if (screen === null || screen.flags.length === 0) return null;
  const record = { flags: screen.flags, excerpt: screen.excerpt, action: 'stopped', detail: null };
  sendTraceOf(worktreeId).stalePrompt = record;
  if (!inputs.interruptStalePrompt) return record;
  const interrupted = await runCmAsync(inputs, ['interrupt', worktreeId]);
  if (!interrupted.ok) {
    record.action = 'interrupt_failed';
    record.detail = `\`commandmate interrupt\` exited ${interrupted.status ?? 'with an error'} (${excerpt(interrupted.stderr || interrupted.stdout) ?? 'no output'})`;
    return record;
  }
  await sleepMs(sendPauseMs(STALE_PROMPT_SETTLE_MS));
  const after = readStaleScreen(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  if (after === null) {
    record.action = 'not_confirmed';
    record.detail = 'the session could not be read after the interrupt, so nothing shows the composer is back';
    return record;
  }
  if (after.flags.length > 0) {
    record.action = 'still_on_screen';
    record.detail = `the session still reports ${after.flags.join(' / ')} after the interrupt (${after.excerpt})`;
    return record;
  }
  record.action = 'interrupted';
  return null;
}

// The supervision result for a worker stopped by a stale screen. `prompt`,
// because that is what it is — a session waiting on a human's decision — and the
// halt ladder already stops the run for a human on it.
function stalePromptStop(stale) {
  return `a question from an earlier turn is still on this session (${stale.flags.join(' / ')}); nothing was sent and it was not answered`
    + (stale.detail ? `; --interrupt-stale-prompt did not clear it: ${stale.detail}` : '');
}

function stalePromptBlockingReason(issue, stale) {
  return {
    code: 'stale_prompt_on_session',
    detail: redact(`#${issue}: before the first send, \`commandmate capture --json\` showed ${stale.flags.join(' and ')} — a question or selection screen `
      + `left by an earlier turn holds the composer: "${stale.excerpt}". Nothing was sent, and the question was NOT answered. `
      + (stale.detail
        ? `--interrupt-stale-prompt was given and did not clear it: ${stale.detail}. Look at the session (\`commandmate capture <worktree-id>\`) before doing anything else. `
        : 'Look at it (`commandmate capture <worktree-id>`); if it belongs to a turn that is over, dismiss it WITHOUT answering with `commandmate interrupt <worktree-id>` '
          + '(or re-run with --interrupt-stale-prompt, which does that and sends only once the composer is back); if it still matters, answer it yourself. ')
      + 'Then re-dispatch this issue with --resume'),
  };
}

function stalePromptInterruptedLimitation(issue, stale) {
  return {
    code: 'stale_prompt_interrupted',
    detail: redact(`#${issue}: before the first send the session showed ${stale.flags.join(' and ')} from an earlier turn ("${stale.excerpt}"). `
      + 'Under --interrupt-stale-prompt it was dismissed with `commandmate interrupt` WITHOUT being answered, a second capture showed the composer back, and only then was this run\'s work sent. '
      + 'Whatever that question asked was not decided by anyone'),
  };
}

// The message that nudges an idle-but-uncommitted worker to keep going.
const NUDGE_MESSAGE = [
  '続けて作業を進め、この Issue の実装を最後まで完遂してください。',
  '指示どおりに書けないと分かったら、進めずに止めて報告してください。',
  'まだ変更が commit されていません。完了したら work ブランチに単一 commit を作成してください（それが完了の合図です）。',
].join('\n');

// The default nudge, plus the profile's / flag's text appended AFTER it — never
// instead of it, so the single-commit completion line cannot be dropped.
function nudgeMessage(inputs) {
  return inputs.nudgeExtra === null ? NUDGE_MESSAGE : `${NUDGE_MESSAGE}\n${inputs.nudgeExtra}`;
}

// Sent after a `send --contract` that capture says never started. It doubles as
// the submission the first send may have left unconfirmed and as a harmless nudge
// if it did register.
const CONTRACT_CONFIRM_MESSAGE = [
  '上の実行契約に従って作業を開始してください。',
  '完了したら work ブランチに単一 commit を作成してください（それが完了の合図です）。',
].join('\n');

// Sent when the gates passed but nothing was committed. work-evidence counts
// uncommitted changes, so this is a real pass on work nothing downstream can
// deliver — the commit, not the verdict, is what is missing.
const COMMIT_REQUEST_MESSAGE = [
  '検証（ゲート）は通りましたが、変更がまだ commit されていません。',
  'この Issue の変更を work ブランチに単一 commit として作成してください（それが完了の合図です）。',
].join('\n');

// `commandmate send <worktree-id> --contract <path>`: CommandMate parses the
// contract, records a task row, composes preamble + goal as the message, and
// prints the TASK ID on stdout. A contract the server rejects exits 2 with every
// violation on stderr and sends nothing, so a rejected contract is an honest
// failed dispatch — never a quiet downgrade to a plain send.
//
// `--auto-yes` rides on THIS send (Issue #136), and that is the SECOND of the two
// things the flag has to do. The contract's `autoYes` block is a policy the server
// only ever consults from inside its Auto-Yes poller, and that poller does not
// start unless the worktree's auto-yes state is enabled (`if
// (!autoYesState?.enabled) return { started: false, reason: 'auto-yes not enabled'
// }` — `dist/server/src/lib/auto-yes-poller.js`, ADR §14.6). So however permissive
// the contract is, a worktree nobody enabled answers nothing; and however enabled
// the worktree is, a policy that forbids the prompt's type answers nothing either
// (see AUTO_YES_ALLOWED_PROMPT_TYPES). This send is where the state is enabled,
// because it is the send that opens the supervision.
async function sendContractAndConfirm(inputs, worktreeId, relativeContractPath) {
  // A not-ready retry re-sends WITH --contract, and that is not a double send:
  // the refused attempt typed nothing, and `send --contract` marks the task it
  // created `failed` before it exits (CommandMate `send.ts`), so the retry's task
  // row is the only one anybody works on. `readTaskId` below reads the retry's.
  const first = await sendRetryingNotReady(inputs, worktreeId, ['send', worktreeId, '--contract', relativeContractPath, ...autoYesSendFlags(inputs)]);
  if (!first.ok) {
    return { sent: false, taskId: null, note: excerpt(first.stderr || first.stdout || 'contract send failed') };
  }
  const taskId = readTaskId(first.stdout);
  const capture = parseCliJson(await runCmAsync(inputs, ['capture', worktreeId, '--json']));
  const started = capture && (capture.isGenerating === true || capture.isRunning === true || capture.isPromptWaiting === true);
  if (started) return { sent: true, taskId, confirmed: true, note: '' };
  // Re-sending WITH --contract would create a second task row for the same work
  // and leave the first one running forever, so the confirmation is a plain
  // message: it submits whatever the first send left in the input box.
  const again = await runCmAsync(inputs, ['send', worktreeId, CONTRACT_CONFIRM_MESSAGE]);
  if (!again.ok) {
    return { sent: true, taskId, confirmed: false, note: 'the contract send may not have submitted and the confirmation send failed' };
  }
  return { sent: true, taskId, confirmed: false, note: 're-sent a plain confirmation after an unconfirmed contract send' };
}

// The task id `send --contract` prints. The last non-empty stdout line is the id;
// anything that does not look like one is treated as absent rather than recorded.
function readTaskId(stdout) {
  const lines = String(stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : null;
  return last && TASK_ID_RE.test(last) ? last : null;
}

// `commandmate wait --verify` prints one `GATE <id> PASS|FAIL|FLAKY` line per
// executed gate (CommandMate verify-runner's reportGates). Transcribing them
// into the report is what lets a reviewer read WHAT judged the work — not only
// that something passed (#47 / CommandMate #1678 B-5: three static-only gate sets
// passed while the app's core feature was broken, and the report could not show
// what the pass was based on). Unparseable output degrades to an empty list,
// never to an invented gate.
//
// The pattern and the words live in lib.mjs (Issue #224): four runners here read
// this vocabulary, and a word known to one of them and not the others is how
// `FLAKY` would land as `unknown` in the PR body and `fail` in the matrix.
const MAX_REPORTED_GATES = 50;

// Where a gate came from, for #97's PR evidence: `issue` when this issue's
// `acceptance-gates` block named the id, `repo` when it is part of the
// repository's common set and the issue said nothing about it.
//
// MEASURED (ADR §10 item 4): the CLI's own gate line carries no provenance. It is
// `GATE <id> PASS|FAIL|FLAKY (<detail>)`, where detail is `exit=`/duration (both
// two-valued on a retried gate, plus `waited=` on a mutexed one) or the
// work-evidence counts — CommandMate's verify-runner formatGateLine builds it and
// there is nothing else in it. So origin cannot be READ; it is DECIDED here, from
// the one fact this runner owns: which ids it resolved out of the issue's
// `require:` and wrote into the contract. That decision is deterministic, and it
// fixes the case the ADR asked to fix: a gate that is in verify.yaml but was not
// required is `repo`, because being in the common set is exactly what makes it
// common. Absence of the field means "not recorded" and is never read as `repo`.
function gateOrigin(id, requiredGateIds) {
  return requiredGateIds.has(id) ? 'issue' : 'repo';
}

// Both streams of a finished `wait`, as one text to scan. MEASURED against
// CommandMate 0.22.2: reportGates writes the `GATE` lines to **stderr** and keeps
// stdout for the machine-readable output, so a reader that looked at stdout alone
// found none of them and recorded `gates: []` for every contract pass (#160).
// Concatenating is safe rather than merely convenient: GATE_LINE_RE anchors at the
// start of a line, so no interleaving of the two streams can produce a gate that
// neither of them printed — the worst case is the order the lines are listed in.
function waitStreams(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

// Cap the reported list, and say how much the cap ate (#165). A silent slice at
// MAX_REPORTED_GATES reads exactly like a run that had that many gates, which is
// the same "quietly shortened" failure `capped()`/`droppedNote()` fixed for the PR
// body in merge.mjs. Entries that did not cleanly pass are taken first when the
// list must be cut: on a failing run the gates that NAME the failure are the ones
// the report exists for, and they must not fall out of the window behind 50
// passes. `flaky` is kept in that group with `fail` (Issue #224) — it is the one
// word a reader opened the report to find, and a gate that failed and then passed
// must not be the entry the cap eats. A list that fits is returned untouched, in
// the CLI's own order.
function capGates(gates) {
  if (gates.length <= MAX_REPORTED_GATES) return { gates, dropped: 0 };
  const ordered = [
    ...gates.filter((gate) => NON_PASS_GATE_VERDICTS.has(gate.verdict)),
    ...gates.filter((gate) => !NON_PASS_GATE_VERDICTS.has(gate.verdict)),
  ];
  return { gates: ordered.slice(0, MAX_REPORTED_GATES), dropped: gates.length - MAX_REPORTED_GATES };
}

// The `checks` line a cut list owes the reader: what was shown, what was not, and
// that the ordering was not the CLI's. Empty when nothing was dropped.
function droppedGateChecks({ dropped }) {
  if (dropped <= 0) return [];
  return [`the gate list was cut to ${MAX_REPORTED_GATES} entries to bound this report; ${dropped} further gate(s) are not listed (failing gates were kept first, so the cut fell on passing ones)`];
}

// Returns { gates, dropped } — the cut is part of the answer, never silent.
function gatesFromWaitOutput(output, requiredGateIds = new Set()) {
  const gates = [];
  for (const line of String(output ?? '').split('\n')) {
    const parsed = parseGateLine(line.trim());
    if (parsed) {
      const id = redact(parsed.id);
      // The verdict is TRANSCRIBED, never re-derived: `flaky` stays `flaky` here
      // and the run's own verdict stays the wait's exit code (section 2.6). A
      // reader that collapsed FLAKY into pass or fail would be re-adjudicating
      // from a display line, and it would get `flakyIsPass` wrong in both
      // directions — the declaration that decides it is not on this line.
      gates.push({ id, verdict: parsed.verdict, origin: gateOrigin(id, requiredGateIds) });
    }
  }
  return capGates(gates);
}

// `commandmate verify <worktree-id> --json` prints the verification run document
// (CommandMate's VerificationRunView), whose `gates[]` is what turns "verification
// failed" into something a worker can act on.
//
// NOTE: this starts a SECOND run, so its own verdict can differ from the wait's.
// The wait's exit code stays the verdict; this call is used only to NAME gates.
// When it cannot, that is recorded rather than papered over — a re-instruction
// that cannot say what failed is a guess, and the worker should be told so.
//
// Async on purpose: it runs inside the per-worker supervision that a wave drives
// concurrently (#1474). A synchronous execFileSync here would block the event loop
// for a whole gate run and stall every other worker in the wave.
async function describeFailingGates(inputs, worktreeId) {
  // `verify` exits with the verdict, so on the very runs this function exists to
  // read — a failing gate — the exit is 20, not 0. The run document is still on
  // stdout; parse it regardless of exit status (parseCliJson's ok-check would
  // discard every failing run and leave the re-instruction with no gate names).
  const result = await runCmAsync(inputs, ['verify', worktreeId, '--json']);
  let run = null;
  try {
    run = JSON.parse(result.stdout);
  } catch {
    run = null;
  }
  const gates = run && Array.isArray(run.gates) ? run.gates : null;
  if (!gates) {
    return {
      failing: [],
      checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_FAILED} (a gate failed; the breakdown could not be read from commandmate verify --json)`],
      summary: 'the failing gates could not be read from commandmate verify --json',
    };
  }
  const failing = gates
    .filter((gate) => gate && FAILED_GATE_STATUSES.has(gate.status))
    .map((gate) => {
      const isScope = /scope/i.test(String(gate.gateId ?? ''));
      return {
        id: redact(String(gate.gateId ?? 'unknown')),
        status: String(gate.status),
        exitCode: Number.isInteger(gate.exitCode) ? gate.exitCode : null,
        tail: excerpt(gate.logTail ?? '', 200),
        isScope,
        // Only reached when the run already failed, so a `flaky` here is a gate
        // that failed, passed on the retry and was still counted as a failure —
        // i.e. `flakyIsPass` was not declared. Saying so is the difference
        // between telling the worker "unit is broken" and telling it "unit did
        // not reproduce; the repository counts that as a failure anyway".
        flakyOutcome: gateFlakyOutcome(gate),
        violations: isScope ? scopeViolationLines(gate.logTail) : [],
      };
    });
  if (failing.length === 0) {
    return {
      failing,
      checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_FAILED} (a gate failed; the confirming commandmate verify run named none)`],
      summary: 'the confirming verify run named no failing gate',
    };
  }
  return {
    failing,
    // The flaky note goes AFTER the exit code, never before it: merge.mjs reads
    // the first `exit <n>` in this line into the PR body's Exit column, and a
    // second number in front of it would be transcribed as this gate's exit.
    checks: failing.map((gate) => `gate ${gate.id}: ${gate.status}${gate.exitCode !== null ? ` (exit ${gate.exitCode})` : ''}${gate.flakyOutcome === 'flaky' ? ' — FLAKY: it failed, then passed on a re-run of the same tree, and this repository does not declare flakyIsPass for it' : ''}`),
    summary: failing.map((gate) => gate.id).join(', '),
  };
}

// The violating paths of a scope-gate failure, transcribed line by line from
// that gate's logTail — the scope gate already lists every out-of-scope path
// there (CommandMate #1678 B-2; CLI display is #1683). Lines are copied rather
// than parsed for path shapes, so a format change on the CommandMate side
// degrades to a verbatim quote instead of an empty list.
//
// EVERY line is kept (Issue #164). The bound below is a DISPLAY bound and
// nothing else. It used to be applied HERE, before the dedup/sort that builds
// the loop guard's comparison set, which made the guard compare "the first 20
// lines of the logTail" rather than "the violations": two turns whose only
// difference fell outside that window read as the SAME answer, so a worker that
// was really converging was cut off with `scope_unsatisfiable` (measured on the
// fixture d67: 22 violations each turn, differing only from line 21 on — the old
// code stopped the run on turn 2). The reverse misreading was possible too, a fix
// inside the window pulling an untouched line into it and reading as progress.
// Keeping them all is cheap: CommandMate bounds a logTail at 8192 bytes
// (`DEFAULT_MAX_LOG_TAIL_BYTES` in src/lib/verification/verify-config.ts), a few
// hundred lines at worst — and the runs that overflow 20 are the repo-wide
// formatter / `lint --fix` accidents the scope gate exists to catch.
function scopeViolationLines(logTail) {
  return String(logTail ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => redact(line));
}

// How many transcribed violation lines one MESSAGE may carry. Bounding the
// re-instruction and the report detail is still right — an unbounded quote of a
// repo-wide accident helps nobody — so the number is unchanged. What changed is
// that a cut is now COUNTED and NAMED wherever it happens, the rule merge.mjs
// already applies to PR bodies with `capped()` / `droppedNote()`: shortening a
// list is fine, shortening it silently is not.
const MAX_SCOPE_VIOLATION_LINES = 20;

// The bounded view of one failing verification's scope violations: what a message
// may print, how many lines it had to leave out, and the full count so the
// message can say what it is a view OF.
function scopeViolationDisplay(failing) {
  const lines = failing.filter((gate) => gate.isScope).flatMap((gate) => gate.violations);
  return {
    shown: lines.slice(0, MAX_SCOPE_VIOLATION_LINES),
    dropped: Math.max(0, lines.length - MAX_SCOPE_VIOLATION_LINES),
    total: lines.length,
  };
}

// The scope-gate violations of ONE failing verification, as a comparable set —
// the input to the loop guard below (ADR section 6 / Issue #148). The lines come
// from the same transcription the re-instruction prints, so nothing new is read
// from the CLI to decide whether the loop is converging — but this set is built
// from ALL of them, never from the bounded view a message shows (Issue #164):
// what the worker was told is a display decision, and a display decision must not
// decide whether a run continues.
//
// Deduplicated and sorted, because "the same answer" is about the SET of paths:
// two turns that named the same two files in a different order are the worker
// repeating itself, not making progress. `null` means this turn produced nothing
// comparable — no scope gate failed, or its logTail could not be read — and a
// null never compares equal to anything, including another null: "we could not
// see the paths twice" is not evidence that they are the same paths.
function scopeViolationSet(failing) {
  const scopeGates = failing.filter((gate) => gate.isScope);
  if (scopeGates.length === 0) return null;
  const violations = [...new Set(scopeGates.flatMap((gate) => gate.violations))].sort();
  return violations.length === 0 ? null : violations;
}

// The re-instruction sent to a worker whose contract verification failed. It
// quotes the gates, because "verification failed" alone makes the worker guess.
function buildVerifyReinstruction(failing) {
  const lines = ['検証（commandmate verify）が不合格でした。次のゲートが通っていません。'];
  if (failing.length === 0) {
    lines.push('- （失敗ゲートの内訳を取得できませんでした。`commandmate verify <worktree-id>` を自分で実行して確認してください）');
  }
  for (const gate of failing) {
    const exit = gate.exitCode !== null ? ` (exit ${gate.exitCode})` : '';
    const tail = gate.tail ? ` — ${gate.tail}` : '';
    lines.push(`- ${gate.id}: ${gate.status}${exit}${tail}`);
  }
  // A scope failure is the one gate the worker may be structurally unable to fix:
  // scope.allow comes from the Issue's 対象ファイル via the plan, so when the
  // violating change is unavoidable the fix lives in the Issue, not the worktree.
  // Name the paths and say so, instead of asking for a retry that cannot succeed.
  const scopeGates = failing.filter((gate) => gate.isScope);
  if (scopeGates.length > 0) {
    const violations = scopeViolationDisplay(failing);
    lines.push('');
    lines.push('scope ゲートについて: 実行契約 scope.allow の外のファイルが変更されています。違反 path（scope ゲートの記録から転記）:');
    if (violations.total === 0) {
      lines.push('- （logTail から違反 path を読み取れませんでした。`commandmate verify <worktree-id>` で確認してください）');
    }
    for (const line of violations.shown) lines.push(`- ${line}`);
    // A worker that is told about 20 of 23 violations cannot fix the other 3, and
    // silence about the cut would read as "these are all of them" (Issue #164).
    if (violations.dropped > 0) {
      lines.push(`- （ほか ${violations.dropped} 行は、このメッセージの表示上限 ${MAX_SCOPE_VIOLATION_LINES} 行を超えたため省略しました。`
        + `scope ゲートの記録は全部で ${violations.total} 行あります —— 残りは \`commandmate verify <worktree-id>\` で確認してください）`);
    }
    lines.push('scope.allow は Issue の対象ファイルから生成されます。違反 path を許可するには Issue の対象ファイルに追加して plan を作り直す必要があります。');
    lines.push('この変更が受入条件の達成に不可避なら worker 側では解決できません — 停止してその旨を報告してください。回避できるなら、違反 path への変更を取り消して scope 内で完了してください。');
  }
  lines.push('原因を修正し、すべてのゲートが通る状態にしてから、work ブランチに単一 commit を作成してください。');
  lines.push('判断が要る・直しようがない場合は推測せず停止して質問してください。');
  return lines.join('\n');
}

// Has the worker committed since dispatch started? Null HEAD (a broken or absent
// worktree) is "no commit yet", never "done" — the same rule as the legacy loop.
async function hasNewCommit(inputs, worktreePath, baseSha) {
  const current = await worktreeHeadSha(inputs, worktreePath);
  return current !== null && current !== baseSha;
}

// Supervise one worker that was dispatched under an execution contract.
//
// The verdict is CommandMate's, read from `commandmate wait --verify`'s exit code
// — the runner no longer re-implements verification. Completion is still a NEW
// COMMIT (#1468), because a verdict and a deliverable are different things:
// work-evidence counts uncommitted changes, so the gates can pass on a tree that
// nothing downstream can push.
//
// `--on-prompt agent` is explicit and deliberate. The mode names who ANSWERS the
// prompt: `agent` returns it to this caller as exit 10 (which is how the runner
// halts and shows it to a human), while `human` makes `wait` block until someone
// answers it in the UI and never returns 10 at all. The Issue body's
// `--on-prompt human` would therefore have replaced "stop and present the prompt"
// with "hang until --timeout, then report a timeout" — the opposite of the
// human-in-the-loop rule it was written to serve.
async function superviseWithContract(inputs, worktreeId, worktreePath, relativeContractPath, issueGateIds = []) {
  // The ids the ISSUE named — the ones it `require`d and the ones it defined —
  // as a set, so every gate this loop records can say where it came from
  // (#97 / ADR §8.2). A gate the issue DEFINED is issue-declared by
  // construction: nothing but this contract knows it exists.
  const requiredGateIds = new Set(issueGateIds);
  const baseSha = await worktreeHeadSha(inputs, worktreePath);
  // When this worker's supervision opened. The elapsed time a liveness probe
  // reports is measured from here (Issue #179) — against `--wait-timeout` it is
  // what shows whether one turn simply outgrew the window.
  const startedAtMs = Date.now();
  let autoResponded = false;

  const stale = await clearStalePrompt(inputs, worktreeId);
  if (stale !== null) {
    return {
      state: 'prompt', taskId: null, verdict: null, notJudged: false,
      promptExcerpt: stale.excerpt, nudges: 0, autoResponded, note: stalePromptStop(stale),
    };
  }
  const sent0 = await sendContractAndConfirm(inputs, worktreeId, relativeContractPath);
  if (!sent0.sent) {
    // A send that failed after the deadline failed BECAUSE of the deadline: the
    // remaining budget is every child's timeout, so the runner killed it. Saying
    // "dispatch failed" would send the operator to a worker that never got the
    // message, for a clock this runner stopped (Issue #122).
    const cutShort = wallClockExhausted();
    return {
      state: cutShort ? 'timeout' : 'failed', taskId: null, verdict: null, notJudged: false,
      promptExcerpt: null, nudges: 0, autoResponded,
      note: cutShort
        ? 'the --wall-clock-budget was exhausted before this worker was dispatched'
        : `contract dispatch failed: ${sent0.note}`,
    };
  }
  const taskId = sent0.taskId;
  let turns = 1;
  // How long each TURN took, in the order they ran (Issue #220). Recorded, never
  // adjudicated: at the `--max-turns` cap it is what lets a human see at a glance
  // that twelve "turns" burned 7s each — no model does twelve turns of real work
  // in 84 seconds — without the runner having to decide what "too fast" is. A
  // turn is closed by the send that opens the NEXT one, so `--auto-yes` answering
  // a prompt mid-turn does not split it in two, and the array's length is exactly
  // `turns`.
  const turnDurations = [];
  let turnStartedAtMs = Date.now();
  const closeTurn = () => {
    const now = Date.now();
    turnDurations.push(Math.max(0, Math.round((now - turnStartedAtMs) / 1000)));
    turnStartedAtMs = now;
  };
  // The same reading for every later send in this loop (nudge, commit request,
  // re-instruction): a send the budget cut short is a stopped clock, not a
  // failed worker.
  const budgetCutoff = () => (wallClockExhausted()
    ? {
      state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
      note: `the --wall-clock-budget was exhausted during turn ${turns}; this worker was left mid-supervision`,
    }
    : null);
  // Once a pass is in hand it is FINAL for this run: the passing run moved the
  // task to `succeeded`, and a later verification run that cannot bind to a live
  // contract is exactly the detached-contract `error` → exit 99 case (#1620).
  // Asking twice would manufacture the very "no verdict" state we escalate on.
  let verdict = null;
  let passed = false;
  // The previous turn's scope violations (ADR section 6 / Issue #148), kept so
  // this loop can tell a worker that is CONVERGING from one that is repeating
  // itself. Reset by every turn that is not a scope-gate failure, so only two
  // CONSECUTIVE identical answers count — the narrow reading, which blocks less.
  let previousScopeViolations = null;
  // The worst cut any turn's scope re-instruction had to make (Issue #164). The
  // loop guard compares every violating line, but a MESSAGE is bounded, so a
  // worker can be told about 20 of 23. That is a fact about what the worker was
  // given to act on, and it belongs in the record rather than only in the message
  // that was sent — a report listing 20 paths must not read as a run that had 20.
  let scopeViolationCut = null;
  // Whether the send that opened the CURRENT turn was the supervision nudge —
  // the only turn a stop-and-report is read from (Issue #287).
  let nudgedThisTurn = false;
  let nudgeSinceIso = null; // when the nudge that opened this turn was sent (Issue #296)
  const scopeCutClause = () => (scopeViolationCut === null
    ? ''
    : `; a scope re-instruction was bounded: ${scopeViolationCut.shown.length} of ${scopeViolationCut.total} violating line(s) were transcribed `
      + `and ${scopeViolationCut.dropped} were left out of the message (the loop guard compared all ${scopeViolationCut.total})`);

  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    // The wall-clock budget, checked between turns (Issue #122). The remaining
    // budget is already every child's timeout, so a wedged `wait` cannot outlive
    // it; this check is what turns "the child was killed" into an honest
    // `timeout` state instead of an infrastructure failure attributed to the
    // worker. Any verdict already in hand is kept — it was really reached.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted after ${turns} turn(s); supervision stopped without waiting for this worker`,
      };
    }
    const waitArgs = passed
      ? ['wait', worktreeId, '--on-prompt', 'agent', '--timeout', String(inputs.waitTimeout)]
      : ['wait', worktreeId, '--on-prompt', 'agent', '--verify', '--timeout', String(inputs.waitTimeout)];
    const waited = await runCmAsync(inputs, waitArgs);
    // The same check AFTER the call, and it is not redundant: the remaining
    // budget is this child's timeout, so a `wait` that outlives the deadline
    // comes back killed. Classifying that as an infrastructure failure would
    // blame the worker for a clock this runner stopped — the operator would go
    // read a worker log to find out why the run they time-boxed ended.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted during turn ${turns}; the pending \`commandmate wait\` was cut short and this worker was left mid-supervision`,
      };
    }
    const code = waited.ok ? VERIFY_EXIT_PASS : (waited.status ?? null);
    const done = (state, note) => ({ state, taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded, note: `${note}${scopeCutClause()}` });

    if (code === WAIT_EXIT_PROMPT) {
      const promptExcerpt = await capturePrompt(inputs, worktreeId);
      if (inputs.autoYes) {
        autoResponded = true;
        await respondWorker(inputs, worktreeId);
        continue; // answered; wait again within the same turn
      }
      return { state: 'prompt', taskId, verdict, notJudged: false, promptExcerpt, nudges: turns - 1, autoResponded, note: '' };
    }
    if (code === WAIT_EXIT_TIMEOUT) {
      // One `capture`, here, before returning (Issue #179): this timeout is
      // either "the runner stopped watching" or "the worker stopped", and the
      // report cannot say which unless it is read at the moment it happened.
      const liveness = await probeWorkerLiveness(inputs, worktreeId, startedAtMs, turns);
      return {
        ...done('timeout', `wait timed out after ${inputs.waitTimeout}s; ${livenessNoteClause(liveness)}`),
        liveness,
      };
    }

    if (!passed && code === VERIFY_EXIT_NO_VERDICT) {
      // No gate judged this work. That is neither a pass nor a failure, so it is
      // not re-instructed, not retried, and not rounded either way.
      verdict = {
        ran: true,
        outcome: 'not_run',
        gates: [],
        checks: [`commandmate wait --verify → exit ${VERIFY_EXIT_NO_VERDICT} (the verification run ended error/cancelled; no verdict was reached)`],
      };
      const committed = await hasNewCommit(inputs, worktreePath, baseSha);
      return {
        state: committed ? 'completed' : 'failed',
        taskId, verdict, notJudged: true, promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `escalated to a human rather than re-instructed as a verification failure (exit ${VERIFY_EXIT_NO_VERDICT}: the run ended error/cancelled)`,
      };
    }

    if (code === VERIFY_EXIT_PASS) {
      if (!passed) {
        passed = true;
        // The GATE lines of THIS passing run are the only safe source of the
        // gate list: a `commandmate verify` after a pass cannot bind to the
        // succeeded task and manufactures exit 99 (#1620).
        const passGates = gatesFromWaitOutput(waitStreams(waited), requiredGateIds);
        verdict = {
          ran: true,
          outcome: 'pass',
          gates: passGates.gates,
          checks: [
            `commandmate wait --verify → exit ${VERIFY_EXIT_PASS} (every declared gate passed)`,
            ...droppedGateChecks(passGates),
          ],
        };
      }
      if (await hasNewCommit(inputs, worktreePath, baseSha)) {
        // The note states only what THIS loop observed — the turn count and the
        // commit. It deliberately no longer asserts the verification result
        // (Issue #83): that sentence was a SECOND, independent claim, and when
        // the recording of `verdict` was skipped the note went on saying
        // "verification passed" beside `outcome: not_run`. The verification
        // clause is appended once, at the recording site, from the very object
        // the report carries — see `verificationNoteClause`.
        const note = turns > 1
          ? `completed after ${turns - 1} follow-up message(s); a new commit was detected`
          : 'completed; a new commit was detected';
        return done('completed', note);
      }
      if (turns >= inputs.maxTurns) {
        return done('failed', `no commit was produced after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`);
      }
      previousScopeViolations = null; // this turn was not a scope-gate failure
      const asked = await sendAndConfirm(inputs, worktreeId, COMMIT_REQUEST_MESSAGE);
      if (!asked.sent) return budgetCutoff() ?? done('failed', `commit request failed: ${asked.note}`);
      closeTurn();
      turns += 1;
      nudgedThisTurn = false;
      continue;
    }

    if (code === VERIFY_EXIT_NOT_STARTED) {
      // work-evidence found no commit and no change: the worker has not started,
      // or has nothing to show yet. Never a pass.
      const startGates = gatesFromWaitOutput(waitStreams(waited), requiredGateIds);
      verdict = {
        ran: true,
        outcome: 'fail',
        gates: startGates.gates,
        checks: [
          `commandmate wait --verify → exit ${VERIFY_EXIT_NOT_STARTED} (work-evidence found no commit and no uncommitted change)`,
          ...droppedGateChecks(startGates),
        ],
      };
      // A worker that answered the nudge by stopping and reporting (Issue #287)
      // is not nudged again — read BEFORE the cap, so a report given on the last
      // turn is recorded as one rather than as the cap's "why there is nothing".
      if (nudgedThisTurn) {
        const workerReport = await readWorkerStopReport(inputs, worktreeId, worktreePath, turns, nudgeSinceIso);
        if (workerReport !== null) {
          return {
            ...done('failed', workerReportNoteClause(workerReport, inputs, 'no work evidence (no commit, no uncommitted change)')),
            workerReport,
          };
        }
      }
      if (turns >= inputs.maxTurns) {
        // One collection, here (Issue #220), for the same reason #179 reads the
        // liveness at a wait timeout: this cap is either "the worker ran N turns
        // and produced nothing" or "the worker never got a turn", the recoveries
        // are opposite (split the Issue vs. wait and --resume), and nothing in
        // the report could tell them apart. The adjudication is untouched — exit
        // 21 is still a `fail`, `worker_state` is still `failed`; what is added
        // is only WHY there is nothing.
        // Read BEFORE `closeTurn` moves the marker: this is when the send that
        // opened the LAST turn happened, and it is the instant a `stop` event
        // has to be newer than for that turn to have completed.
        const lastSendAtMs = turnStartedAtMs;
        closeTurn();
        const turnEvidence = await probeWorkerTurnEvidence(
          inputs, worktreeId, worktreePath, turns, turnDurations, lastSendAtMs,
        );
        return {
          ...done('failed', `no work evidence after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap; ${turnEvidenceNoteClause(turnEvidence)}`),
          turnEvidence,
        };
      }
      previousScopeViolations = null; // this turn was not a scope-gate failure
      // Taken BEFORE the send: `commandmate reply --since` keeps a reply written
      // at or after it, and a stamp taken after could postdate a fast worker's answer.
      nudgeSinceIso = new Date().toISOString();
      const nudged = await sendAndConfirm(inputs, worktreeId, nudgeMessage(inputs));
      if (!nudged.sent) return budgetCutoff() ?? done('failed', `nudge failed: ${nudged.note}`);
      closeTurn();
      turns += 1;
      nudgedThisTurn = true;
      continue;
    }

    if (code === VERIFY_EXIT_FAILED) {
      const waitGates = gatesFromWaitOutput(waitStreams(waited), requiredGateIds);
      const failing = await describeFailingGates(inputs, worktreeId);
      verdict = {
        ran: true,
        outcome: 'fail',
        // The wait's own GATE lines are primary; when a CLI prints none, the
        // confirming verify run's failing gates still name what was judged.
        gates: waitGates.gates.length > 0 ? waitGates.gates : failing.failing.map((gate) => ({ id: gate.id, verdict: 'fail', origin: gateOrigin(gate.id, requiredGateIds) })),
        checks: [...failing.checks, ...droppedGateChecks(waitGates)],
      };
      const committed = await hasNewCommit(inputs, worktreePath, baseSha);
      if (turns >= inputs.maxTurns) {
        // As above: the failing gates are named by the verification clause the
        // recording site appends, out of the same `verdict` the report carries,
        // so this note states only the cap and the missing commit.
        return done(
          committed ? 'completed' : 'failed',
          `the --max-turns ${inputs.maxTurns} cap was reached${committed ? '' : ' with no commit'}`,
        );
      }
      // The loop guard (ADR section 6 / Issue #148). Ranked BELOW the --max-turns
      // cap on purpose: the cap is the operator's own bound and the note it
      // writes is the one existing runs are read by, so a run that reached it
      // ends the way it always has.
      //
      // "Is this change unavoidable?" cannot be decided here. "Is this loop
      // converging?" can: `scope.allow` is a snapshot taken when the contract
      // was sent, so a worker cannot widen it from inside the worktree — the
      // only move it has is to make the violating change go away. A turn that
      // names the SAME paths as the turn before is a worker that has answered,
      // and re-sending the same re-instruction spends turns to receive the same
      // answer again (measured: Kewton/BorderFreeKidsMap #35 burned a whole run
      // this way). One fewer violating path is progress and is re-instructed as
      // before — this stops the repeat, not the retry.
      //
      // The comparison runs on the WHOLE violation set; the bounded view below is
      // only what the next message may print (Issue #164). Which lines fit in a
      // message is a display decision, and it decided this stop until #164.
      const scopeViolations = scopeViolationSet(failing.failing);
      const shownViolations = scopeViolationDisplay(failing.failing);
      if (shownViolations.dropped > (scopeViolationCut?.dropped ?? 0)) scopeViolationCut = shownViolations;
      if (scopeViolations !== null && previousScopeViolations !== null
        && scopeViolations.join('\n') === previousScopeViolations.join('\n')) {
        // Recorded on the EXISTING adjudication-failure path: no new state, no
        // new stop_reason, and the verdict is untouched — verification really
        // did fail, and that is CommandMate's exit code to give (#142's rule).
        // What changes is only that the run stops here instead of at the cap.
        return {
          state: committed ? 'completed' : 'failed',
          taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded,
          scopeUnsatisfiable: { violations: scopeViolations, turns },
          note: `the scope gate named the same violating path(s) on two consecutive turns, so this re-instruction loop is not converging; `
            + `stopped after ${turns} turn(s) without sending turn ${turns + 1} (the --max-turns cap is ${inputs.maxTurns})${scopeCutClause()}`,
        };
      }
      previousScopeViolations = scopeViolations;
      const resent = await sendAndConfirm(inputs, worktreeId, buildVerifyReinstruction(failing.failing));
      if (!resent.sent) return budgetCutoff() ?? done('failed', `re-instruction failed: ${resent.note}`);
      closeTurn();
      turns += 1;
      nudgedThisTurn = false;
      continue;
    }

    // 1 / 2 / anything else: infrastructure, not a verdict.
    return done('failed', excerpt(waited.stderr || waited.stdout || `wait exited ${code ?? 'with an error'}`));
  }
  return { state: 'failed', taskId, verdict, notJudged: false, promptExcerpt: null, nudges: turns - 1, autoResponded, note: 'supervision exceeded its hard iteration bound' };
}

// Supervise one worker to a real completion. A worker idles after every turn, so
// the loop drives it turn by turn: dispatch, then wait; on idle-with-no-new-commit
// nudge it and wait again, until it commits (completed), raises a prompt, times
// out, fails, or the --max-turns cap is reached with no commit (an honest failed).
// A prompt is answered only under --auto-yes; otherwise it halts for a human.
async function superviseUntilCommit(inputs, worktreeId, worktreePath, initialMessage) {
  const baseSha = await worktreeHeadSha(inputs, worktreePath);
  // As on the contract path (Issue #179): the clock the liveness probe's elapsed
  // time is measured against.
  const startedAtMs = Date.now();
  let autoResponded = false;

  // The fallback path arms the worktree exactly as the contract path does (Issue
  // #136): `--auto-yes` promises "prompts do not stop this run", and which
  // dispatch path a CLI version put the run on is not something the operator who
  // passed the flag chose.
  // The stale-screen check (CommandMate#3007), BEFORE auto-yes is armed: a
  // worktree whose session holds an old question must not be given a window in
  // which the server could answer it.
  const stale = await clearStalePrompt(inputs, worktreeId);
  if (stale !== null) {
    return { state: 'prompt', promptExcerpt: stale.excerpt, nudges: 0, autoResponded, note: stalePromptStop(stale) };
  }
  const sent0 = await sendAndConfirm(inputs, worktreeId, initialMessage, { armAutoYes: true });
  if (!sent0.sent) {
    // As on the contract path: a send the budget killed is a stopped clock.
    const cutShort = wallClockExhausted();
    return {
      state: cutShort ? 'timeout' : 'failed', promptExcerpt: null, nudges: 0, autoResponded,
      note: cutShort
        ? 'the --wall-clock-budget was exhausted before this worker was dispatched'
        : `dispatch failed: ${sent0.note}`,
    };
  }
  let turns = 1;
  // As on the contract path (Issue #287): every later turn here is opened by
  // the nudge, and only those turns are read for a stop-and-report.
  let nudgedThisTurn = false;
  let nudgeSinceIso = null; // when the nudge that opened this turn was sent (Issue #296)
  const budgetCutoff = () => (wallClockExhausted()
    ? {
      state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
      note: `the --wall-clock-budget was exhausted during turn ${turns}; this worker was left mid-supervision`,
    }
    : null);

  // A hard bound on wait iterations, above the turn cap, so an unexpected
  // prompt/respond ping-pong under --auto-yes can never spin forever.
  const hardIterations = inputs.maxTurns * 4 + 8;
  for (let i = 0; i < hardIterations; i += 1) {
    // The wall-clock budget (Issue #122), on the fallback path too: the profile
    // baseline this path is judged by is the very command with no timeout of its
    // own, so a run without this check would sit inside it past its deadline.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted after ${turns} turn(s); supervision stopped without waiting for this worker`,
      };
    }
    const waited = await runCmAsync(inputs, ['wait', worktreeId, '--timeout', String(inputs.waitTimeout)]);
    // As on the contract path: a `wait` killed by the budget's own timeout is a
    // stopped clock, not a failed worker.
    if (wallClockExhausted()) {
      return {
        state: 'timeout', promptExcerpt: null, nudges: turns - 1, autoResponded,
        note: `the --wall-clock-budget was exhausted during turn ${turns}; the pending \`commandmate wait\` was cut short and this worker was left mid-supervision`,
      };
    }
    if (!waited.ok && waited.status === WAIT_EXIT_PROMPT) {
      const promptExcerpt = await capturePrompt(inputs, worktreeId);
      if (inputs.autoYes) {
        autoResponded = true;
        await respondWorker(inputs, worktreeId);
        continue; // answered; wait again within the same turn
      }
      return { state: 'prompt', promptExcerpt, nudges: turns - 1, autoResponded, note: '' };
    }
    if (!waited.ok && waited.status === WAIT_EXIT_TIMEOUT) {
      // The same one `capture` as on the contract path (Issue #179). Which
      // dispatch path a CLI version put the run on is not something the operator
      // chose, and the question — did the runner stop watching, or did the
      // worker stop? — is identical on both.
      const liveness = await probeWorkerLiveness(inputs, worktreeId, startedAtMs, turns);
      return {
        state: 'timeout',
        promptExcerpt: null,
        nudges: turns - 1,
        autoResponded,
        liveness,
        note: `wait timed out after ${inputs.waitTimeout}s; ${livenessNoteClause(liveness)}`,
      };
    }
    if (!waited.ok) {
      return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: excerpt(waited.stderr || waited.stdout || `wait exited ${waited.status ?? 'with an error'}`) };
    }

    // wait returned idle. Real completion is a NEW commit, not the idle itself.
    const currentSha = await worktreeHeadSha(inputs, worktreePath);
    if (currentSha !== null && currentSha !== baseSha) {
      const note = turns > 1 ? `completed after ${turns - 1} nudge(s); new commit detected` : 'completed; new commit detected';
      return { state: 'completed', promptExcerpt: null, nudges: turns - 1, autoResponded, note };
    }
    if (nudgedThisTurn) {
      const workerReport = await readWorkerStopReport(inputs, worktreeId, worktreePath, turns, nudgeSinceIso);
      if (workerReport !== null) {
        return {
          state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, workerReport,
          note: workerReportNoteClause(workerReport, inputs, 'no new commit'),
        };
      }
    }
    if (turns >= inputs.maxTurns) {
      return {
        state: 'failed',
        promptExcerpt: null,
        nudges: turns - 1,
        autoResponded,
        note: `no new commit after ${turns} turn(s); gave up at the --max-turns ${inputs.maxTurns} cap`,
      };
    }
    nudgeSinceIso = new Date().toISOString(); // before the send; see the contract path
    const nudged = await sendAndConfirm(inputs, worktreeId, nudgeMessage(inputs));
    if (!nudged.sent) {
      const cutShort = budgetCutoff();
      if (cutShort) return cutShort;
      return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: `nudge failed: ${nudged.note}` };
    }
    turns += 1;
    nudgedThisTurn = true;
  }
  return { state: 'failed', promptExcerpt: null, nudges: turns - 1, autoResponded, note: 'supervision exceeded its hard iteration bound' };
}

async function capturePrompt(inputs, worktreeId) {
  const result = await runCmAsync(inputs, ['capture', worktreeId, '--json']);
  const payload = parseCliJson(result);
  const raw = payload?.promptData?.question ?? payload?.content ?? result.stdout ?? '';
  return excerpt(raw) ?? 'a prompt is awaiting input';
}

// =============================================================================
// Worker liveness at a wait timeout (Issue #179)
// =============================================================================
//
// `--wait-timeout` is the ceiling on ONE `commandmate wait`, not on the worker.
// When a turn outlasts that window the runner reports a timeout while the worker
// keeps going — MEASURED (Kewton/BorderFreeKidsMap #62, 2026-08-10): with
// `--wait-timeout 1800` against a ~40-minute turn, the worker ran on, finished,
// and committed. Nothing in the report could tell that from a worker that died,
// so an operator either re-dispatched on top of finished work (a second worker
// landing on the first one's tree) or ran `capture --json` by hand to find out
// which had happened. #89 / #121 built the recovery (`--reverify`); this is the
// step before it — WHICH of the two this timeout was.
//
// So the runner asks, ONCE, at the moment the wait times out. Once, not polled:
// this is a fact about the instant the run stopped watching, and a loop here
// would be `--wait-while-generating` — a different feature with a different
// clock (see the Issue's optional item, deliberately not implemented).
//
// Three findings, and the third is the one that has to exist: a capture that
// cannot be read is not evidence of either state. It gets its own code, on the
// rule merge.mjs wrote for `change_evidence_unavailable` — "we could not look"
// must never be recorded as "there was nothing there".
const LIVENESS_ALIVE = 'wait_window_exhausted';
const LIVENESS_STALLED = 'worker_stalled';
const LIVENESS_UNREADABLE = 'worker_liveness_unreadable';

async function probeWorkerLiveness(inputs, worktreeId, startedAtMs, turns) {
  const result = await runCmAsync(inputs, ['capture', worktreeId, '--json']);
  const elapsed = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
  const windowClause = `\`commandmate wait\` returned exit ${WAIT_EXIT_TIMEOUT} after --wait-timeout ${inputs.waitTimeout}s on turn ${turns}, `
    + `${elapsed}s after this worker was dispatched`;
  const stopClause = 'The run still stopped here and worker_state stays `timeout`; this entry says WHICH KIND of timeout it was';
  const unreadable = (why) => ({
    code: LIVENESS_UNREADABLE,
    is_running: null,
    is_generating: null,
    is_prompt_waiting: null,
    session_status: null,
    elapsed_seconds: elapsed,
    detail: `${windowClause}; the worker's liveness was NOT measured: ${why}. `
      + `This is neither "still running" nor "stopped" — read neither into it. `
      + `Run \`commandmate capture <worktree-id> --json\` by hand before deciding between waiting (then --reverify) and re-dispatching. ${stopClause}`,
  });
  if (!result.ok) {
    return unreadable(`\`commandmate capture <worktree-id> --json\` exited ${result.status ?? 'with an error'}`
      + ` (${excerpt(result.stderr || result.stdout) ?? 'no output'})`);
  }
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return unreadable('`commandmate capture <worktree-id> --json` printed no parseable JSON object');
  }
  // A field this runner cannot read as a boolean is recorded as null rather than
  // as `false`: the CLI not saying "running" is not the CLI saying "not running".
  const flag = (value) => (typeof value === 'boolean' ? value : null);
  const isRunning = flag(payload.isRunning);
  const isGenerating = flag(payload.isGenerating);
  const isPromptWaiting = flag(payload.isPromptWaiting);
  const sessionStatus = typeof payload.sessionStatus === 'string' && payload.sessionStatus.length > 0
    ? excerpt(payload.sessionStatus, 40)
    : null;
  if (isRunning === null && isGenerating === null && isPromptWaiting === null) {
    return unreadable('the capture JSON carries none of isRunning / isGenerating / isPromptWaiting, so it says nothing about whether the worker is alive');
  }
  const observed = `capture reports isRunning=${String(isRunning)} / isGenerating=${String(isGenerating)}`
    + ` / isPromptWaiting=${String(isPromptWaiting)} / sessionStatus=${sessionStatus ?? 'unknown'}`;
  // The same predicate the send-confirmation uses (`sendAndConfirm`): any one of
  // the three is a session that is alive. A pending prompt is alive but blocked,
  // so it is named separately — waiting alone would never move it.
  const alive = isRunning === true || isGenerating === true || isPromptWaiting === true;
  return {
    code: alive ? LIVENESS_ALIVE : LIVENESS_STALLED,
    is_running: isRunning,
    is_generating: isGenerating,
    is_prompt_waiting: isPromptWaiting,
    session_status: sessionStatus,
    elapsed_seconds: elapsed,
    detail: alive
      ? `${windowClause}; ${observed} — the WAIT WINDOW ran out, not the worker. `
        + (isPromptWaiting === true
          ? 'The capture also reports a PENDING PROMPT, so this worker is waiting for a human answer rather than working: answer it (or re-dispatch), because waiting alone will not move it. '
          : 'Do NOT re-dispatch: a second worker would land on a tree the first one may still be finishing. Wait for it to go idle, then re-judge in place with --reverify (nothing is sent). '
            + 'If one turn is routinely longer than the window, raise --wait-timeout to the measured turn length. ')
      + stopClause
      : `${windowClause}; ${observed} — NO EVIDENCE of a running worker. `
        + 'Read the worker\'s log and its worktree before re-dispatching: "not running" is not "nothing was done", and an uncommitted change is still work this run would put a second worker on top of. '
        + stopClause,
  };
}

// The one-sentence version of the same finding, for the worker `note` a human
// reads first. Rendered from the recorded object rather than composed beside it,
// for the reason Issue #83 gave: two independent claims about one fact drift.
function livenessNoteClause(liveness) {
  if (liveness.code === LIVENESS_UNREADABLE) {
    return `worker liveness at the timeout: ${LIVENESS_UNREADABLE} — the \`capture\` could not be read, so neither "still running" nor "stopped" was measured`;
  }
  const observed = `isRunning=${String(liveness.is_running)} / sessionStatus=${liveness.session_status ?? 'unknown'}`;
  return liveness.code === LIVENESS_ALIVE
    ? `worker liveness at the timeout: ${LIVENESS_ALIVE} — capture still reported a live worker (${observed}) ${liveness.elapsed_seconds}s in, `
      + 'so the wait window ran out rather than the worker; wait for it to idle and re-judge with --reverify instead of re-dispatching'
    : `worker liveness at the timeout: ${LIVENESS_STALLED} — capture reported no running worker (${observed}) ${liveness.elapsed_seconds}s in`;
}

// =============================================================================
// Why there is nothing at the --max-turns cap (Issue #220)
// =============================================================================
//
// `--max-turns` bounds how many times this loop re-instructs a worker. When the
// cap is reached on exit 21 — work-evidence found no commit and no uncommitted
// change, every turn — the report used to say only
//
//     no work evidence after 12 turn(s); gave up at the --max-turns 12 cap
//
// and that one sentence covered two opposite worlds:
//
//   - the worker really took 12 turns and produced nothing (the Issue is too
//     large or too vague → split it, re-plan)
//   - the worker never got a single turn (the API was down → wait, then
//     `--resume`; changing the Issue would be changing the wrong thing)
//
// MEASURED (Kewton/CommandMate#1834, from Kewton/BorderFreeKidsMap): `#231
// worker=failed verify=fail … no work evidence after 12 turn(s)`. The worktree
// held 0 commits and 0 uncommitted changes, `capture` said `isRunning: true /
// sessionStatus: ready`, and all 1,001 pane lines were blank. The truth was in
// `~/.claude/projects/<worktree>/*.jsonl`, read BY HAND: `API Error: 529
// Overloaded`, 13 times in a row. Not one turn had run. The recovery was to wait
// ten minutes and `--resume`, and the next attempt finished in one turn.
//
// Why the existing signals cannot see it (this is what picks the materials
// below): `sendAndConfirm`'s "started" and `probeWorkerLiveness`'s "alive" both
// read `isRunning || isGenerating || isPromptWaiting`, and CommandMate's
// `isRunning` means "the tmux session exists and is healthy", not "a turn is in
// flight" — so a live-but-inert session is always true. And `wait` returns
// SUCCESS on the first poll that sees `sessionStatus === 'ready'`, so a worker
// that bounces straight back to its prompt on an upstream error "completes" a
// turn in 5–10s, which is how twelve turns burn in under two minutes.
//
// THE ADJUDICATION DOES NOT MOVE. `verification.outcome` stays `fail`, the exit
// code stays 21, `worker_state` stays `failed`, and blocking `worker_failed`
// still says why the run stopped. What is added is one optional object saying
// WHY THERE IS NOTHING — the same shape #179 added for a wait timeout, for the
// same reason and under the same rules.
//
// Three codes, and the third is again the one that has to exist:
const TURN_EVIDENCE_UPSTREAM = 'worker_upstream_unavailable';
const TURN_EVIDENCE_NOTHING = 'worker_produced_nothing';
const TURN_EVIDENCE_UNREADABLE = 'worker_output_unreadable';
//
// Neither of the first two is a default. `worker_upstream_unavailable` needs
// POSITIVE evidence that the upstream refused; `worker_produced_nothing` needs
// POSITIVE evidence that a turn actually ran. With neither in hand the runner
// says `worker_output_unreadable` and refuses to round — the rule merge.mjs
// wrote for `change_evidence_unavailable` and #179 re-used for
// `worker_liveness_unreadable`. Rounding "we could not look" to
// `worker_produced_nothing` is exactly the report that sent an operator to split
// a perfectly good Issue.

// How many identical one-line errors at the END of a transcript count as "no
// turn ran". Three, because two can be the tail of a turn that then succeeded;
// the measured case had 13.
const TRANSCRIPT_ERROR_RUN_MIN = 3;
// The transcript is read from its END and bounded twice: by bytes (a long
// session is tens of MB and this runs inside a supervision loop) and by entries.
// Both bounds are stated in `detail` when they bite, because a bound nobody
// mentions reads as "there was nothing else there".
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 2000;
// What the operator runs to read the same file this runner read. Path-free on
// purpose: absolute paths are redacted out of every artifact (§4 of the
// contract), so a transcribed path would reach the report as [REDACTED-PATH] and
// help nobody. This command recomputes it from the worktree instead.
const MANUAL_TRANSCRIPT_COMMAND =
  'cd <worktree> && ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(pwd | sed \'s/[^a-zA-Z0-9]/-/g\')"/*.jsonl | head -1';

// Claude Code's transcript root. `CLAUDE_CONFIG_DIR` replaces `~/.claude`
// wholesale when it is set, which is also what makes this measurable in a
// fixture without writing into a developer's real home directory.
function claudeProjectsDir() {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const root = typeof configured === 'string' && configured.length > 0 ? configured : join(homedir(), '.claude');
  return join(root, 'projects');
}

// The last `maxBytes` of a file, as text, plus whether anything was cut.
function readFileTail(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), truncated: length < size };
  } finally {
    closeSync(fd);
  }
}

// One assistant entry, reduced to the two things that matter here: what it SAID,
// and whether it used a tool. A tool call is the least deniable proof a turn ran
// — an upstream that never answered cannot have produced one.
function assistantEntryParts(entry) {
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return { text: content, hasTool: false };
  if (!Array.isArray(content)) return { text: '', hasTool: false };
  const texts = [];
  let hasTool = false;
  for (const part of content) {
    if (part?.type === 'tool_use') hasTool = true;
    else if (typeof part?.text === 'string') texts.push(part.text);
  }
  return { text: texts.join('\n'), hasTool };
}

// Chrome the TUI draws whether or not anything happened. Without this filter
// "the snippet is not blank" would be true of every live session and could never
// be evidence of a turn: the frame, the composer caret and the footer hints are
// there before the first token and after the last one. Only what survives this
// counts as OUTPUT.
const TUI_CHROME_LINE = /^(?:[\s─-╿▀-▟|+._=-]*|[>❯»]\s*|\?\s*for shortcuts.*|esc to interrupt.*|Press up to edit queued messages.*|⏵+.*|Bypassing Permissions.*)$/i;

// Where a worker's Claude Code transcript is, and its bounded tail as parsed
// JSONL entries — or why it could not be read. Shared by the #220 cap probe and
// the #287 stop-report reader, so the two can never disagree about WHICH file
// is this worker's (or refuse for different reasons).
function transcriptNotRead(reason) {
  return { ok: false, reason };
}

function readTranscriptEntries(worktreePath, cliToolId) {
  // dispatch is deliberately agent-agnostic — it drives worktrees, not CLIs — so
  // the only thing that can name the agent is `capture --json`'s `cliToolId`.
  // Not naming it is not permission to guess: Codex keeps rollouts under
  // `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, a layout this runner does
  // not read, and reading the wrong layout would produce confident nonsense.
  if (typeof cliToolId !== 'string' || cliToolId.length === 0) {
    return transcriptNotRead('`commandmate capture <worktree-id> --json` did not name the CLI tool (`cliToolId`), so which agent\'s transcript layout to read is unknown');
  }
  if (cliToolId !== 'claude') {
    return transcriptNotRead(`this runner reads Claude Code's transcript layout only; \`cliToolId\` is "${excerpt(cliToolId, 24)}" (Codex keeps its rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)`);
  }
  let absolute;
  try {
    absolute = realpathSync(resolve(worktreePath));
  } catch {
    absolute = resolve(worktreePath);
  }
  // Claude Code's own encoding of a session cwd: every non-alphanumeric byte
  // becomes a hyphen (`/Users/x/repo_a` → `-Users-x-repo-a`).
  const dir = join(claudeProjectsDir(), absolute.replace(/[^a-zA-Z0-9]/g, '-'));
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  } catch {
    return transcriptNotRead('no Claude Code transcript directory exists for this worktree (CLAUDE_CONFIG_DIR/projects/<encoded cwd>)');
  }
  if (names.length === 0) return transcriptNotRead('the Claude Code transcript directory for this worktree holds no *.jsonl file');
  if (names.length > 1) {
    // Picking "the newest" would be a guess dressed as a measurement: several
    // sessions can share one worktree, and the wrong one answers a different
    // question. The operator has the whole directory and can read them all.
    return transcriptNotRead(`the Claude Code transcript directory for this worktree holds ${names.length} *.jsonl files and this runner will not guess which session was this worker's (read them with: ${MANUAL_TRANSCRIPT_COMMAND})`);
  }
  const path = join(dir, names[0]);
  let tail;
  try {
    tail = readFileTail(path, TRANSCRIPT_TAIL_BYTES);
  } catch (error) {
    return transcriptNotRead(`the Claude Code transcript for this worktree could not be read: ${excerpt(error.message, 80)}`);
  }
  const lines = tail.text.split('\n').filter((line) => line.trim().length > 0);
  // A tail read can start mid-entry; that first fragment is not a record.
  if (tail.truncated && lines.length > 0) lines.shift();
  const entries = [];
  for (const line of lines.slice(-TRANSCRIPT_MAX_ENTRIES)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line this runner cannot parse is not evidence of anything, in either
      // direction. It is skipped, not counted.
    }
  }
  if (entries.length === 0) return transcriptNotRead('the Claude Code transcript for this worktree holds no readable JSONL entry');
  return { ok: true, path, tail, lines, entries };
}

// The transcript half of the evidence. Returns the object the report carries
// plus the sentences (if any) it supports. Nothing in here can FAIL the probe:
// every unreadable path becomes `{ read: false, reason }`, which is a fact about
// this run and not an error in it.
function readWorkerTranscript(worktreePath, cliToolId) {
  const notRead = (reason) => ({ record: { read: false, reason: redact(reason) }, upstream: null, turn: null, signature: null });
  const read = readTranscriptEntries(worktreePath, cliToolId);
  if (!read.ok) return notRead(read.reason);
  const { path, tail, lines, entries } = read;
  const assistants = entries.filter((entry) => entry?.type === 'assistant').map(assistantEntryParts);
  const bounded = tail.truncated || lines.length > TRANSCRIPT_MAX_ENTRIES
    ? ` (only the last ${TRANSCRIPT_MAX_ENTRIES} entr(ies) of the final ${TRANSCRIPT_TAIL_BYTES} byte(s) were read)`
    : '';

  // (b) of the rule: a run of IDENTICAL one-line errors at the very end. Same
  // text, no tool call, no multi-line answer — a CLI that bounced off the API
  // and printed the same sentence again. Anything else ends the run, including
  // one different error, because "several unrelated errors" is a different
  // finding and this one is about a wall.
  let trailing = 0;
  let signature = null;
  for (let i = assistants.length - 1; i >= 0; i -= 1) {
    const { text, hasTool } = assistants[i];
    const line = text.trim();
    if (hasTool || line.length === 0 || line.includes('\n')) break;
    if (matchUpstreamFault(line) === null) break;
    if (signature === null) signature = line;
    else if (signature !== line) break;
    trailing += 1;
  }
  const record = {
    read: true,
    path: redact(path),
    trailing_identical_error_entries: trailing,
  };
  if (trailing >= TRANSCRIPT_ERROR_RUN_MIN) {
    return {
      record,
      upstream: `the worker's Claude Code transcript ends with ${trailing} identical one-line upstream errors in a row ("${excerpt(signature, 80)}")${bounded}`,
      turn: null,
      signature: excerpt(signature, 80),
    };
  }
  // The other side: anything in the transcript that an upstream refusal could
  // not have produced.
  const toolTurn = assistants.some((entry) => entry.hasTool);
  const spoken = assistants.find((entry) => entry.text.trim().length > 0 && matchUpstreamFault(entry.text) === null);
  const turn = toolTurn
    ? `the worker's Claude Code transcript contains at least one assistant tool call${bounded}`
    : (spoken ? `the worker's Claude Code transcript contains non-error assistant output ("${excerpt(spoken.text, 80)}")${bounded}` : null);
  return {
    record,
    upstream: null,
    turn,
    signature: trailing > 0 ? excerpt(signature, 80) : null,
  };
}

// The hooks half. `structuredEvents` has been in `capture --json` since
// CommandMate 0.24.0 and is the only signal that says "a turn ENDED" rather than
// "a session exists": a `stop` event is emitted when the CLI finishes a turn.
// Absent hooks are absent evidence, not evidence of absence — a repository with
// no hooks installed yields no sentence at all here, which is how the run ends
// up `worker_output_unreadable` instead of being labelled from nothing.
function readStructuredEvents(payload, lastSendAtMs) {
  const raw = payload?.structuredEvents;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { record: null, upstream: null, turn: null };
  }
  const text = (value) => (typeof value === 'string' && value.length > 0
    ? excerpt(value, 64)
    : (typeof value === 'number' && Number.isFinite(value) ? String(value) : null));
  // Epoch seconds, epoch milliseconds and ISO strings are all in the wild; a
  // stamp this runner cannot read is null, which produces no sentence.
  const millis = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };
  const record = {
    last_event_type: text(raw.lastEventType),
    last_event_at: text(raw.lastEventAt),
    last_stop_event_at: text(raw.lastStopEventAt),
  };
  const lastEventMs = millis(raw.lastEventAt);
  const lastStopMs = millis(raw.lastStopEventAt);
  if (lastEventMs === null) return { record, upstream: null, turn: null };
  if (lastStopMs !== null && lastStopMs >= lastSendAtMs) {
    return {
      record,
      upstream: null,
      turn: `hooks reported a \`stop\` event at ${record.last_stop_event_at} — after the send that opened the last turn — so that turn did end`,
    };
  }
  return {
    record,
    upstream: `hooks are live (last event ${record.last_event_type ?? 'unknown'} at ${record.last_event_at}) but no \`stop\` event has come back since the send that opened the last turn (last stop: ${record.last_stop_event_at ?? 'never'}) — the turn was submitted and never completed`,
    turn: null,
  };
}

// CommandMate #1839 exposes its own `UPSTREAM_FAULTS` verdict as
// `capture --json`'s `upstreamFault`. Used when it is there and never required:
// an older CLI simply does not carry the field, and pinning this runner to the
// new one would make old sessions unreadable rather than merely less informed.
// The shape is read defensively for the same reason.
function captureUpstreamFault(payload) {
  const fault = payload?.upstreamFault;
  if (fault === null || fault === undefined || fault === false) return null;
  if (typeof fault === 'string') return fault.length > 0 ? excerpt(fault, 80) : null;
  if (fault === true) return 'the CLI reported an upstream fault (no detail)';
  if (typeof fault !== 'object' || Array.isArray(fault)) return null;
  for (const key of ['signature', 'matched', 'matchedText', 'detail', 'message', 'id', 'kind', 'type']) {
    if (typeof fault[key] === 'string' && fault[key].length > 0) return excerpt(fault[key], 80);
  }
  return 'the CLI reported an upstream fault (no readable detail)';
}

// The whole probe. ONE `capture`, then whatever else is readable from the
// worktree, and never a second look — as in #179 this is a fact about the
// instant the run gave up, not a poll.
async function probeWorkerTurnEvidence(inputs, worktreeId, worktreePath, turns, turnDurations, lastSendAtMs) {
  const capture = await runCmAsync(inputs, ['capture', worktreeId, '--json']);
  let payload = null;
  let captureFailure = null;
  if (!capture.ok) {
    captureFailure = `\`commandmate capture <worktree-id> --json\` exited ${capture.status ?? 'with an error'}`
      + ` (${excerpt(capture.stderr || capture.stdout, 120) ?? 'no output'})`;
  } else {
    const parsed = parseCliJson(capture);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
    else captureFailure = '`commandmate capture <worktree-id> --json` printed no parseable JSON object';
  }

  const snippet = typeof payload?.realtimeSnippet === 'string' ? payload.realtimeSnippet : null;
  const snippetBlank = snippet === null ? null : snippet.trim().length === 0;
  const lineCount = Number.isInteger(payload?.lineCount) ? payload.lineCount : null;
  const snippetFault = matchUpstreamFault(snippet);
  // `realtimeSnippet` is the last ~100 lines of the PANE, not the turn. The
  // chrome filter is what makes "not blank" mean something (see TUI_CHROME_LINE).
  const snippetOutput = snippet === null
    ? null
    : (snippet.split('\n').find((line) => !TUI_CHROME_LINE.test(line.trim()) && matchUpstreamFault(line) === null) ?? null);

  // A capture that could not be read says nothing about the AGENT either, and
  // the transcript layout is per-agent — so the reason recorded here is the
  // capture, not a missing field inside a payload that never arrived.
  const transcript = payload === null
    ? {
      record: { read: false, reason: redact('the capture could not be read, so the worker\'s agent (and therefore which transcript layout to read) is unknown') },
      upstream: null,
      turn: null,
      signature: null,
    }
    : readWorkerTranscript(worktreePath, payload.cliToolId);
  const events = readStructuredEvents(payload, lastSendAtMs);
  const cliFault = captureUpstreamFault(payload);

  // The ladder. TRANSCRIPT first, in both directions, because it is the record
  // of the conversation rather than a picture of a terminal — then the screen and
  // the hooks. Within one source, UPSTREAM outranks TURN: the two can co-occur
  // (a worker that read files and then hit a wall leaves both), and of the two
  // readings only "the upstream refused" explains a cap with no work evidence at
  // all. It is also the safer error: waiting and `--resume`-ing an Issue that was
  // in fact too large costs one run, while splitting an Issue that was fine costs
  // a human rewriting a correct Issue.
  const upstreamEvidence = [transcript.upstream, snippetFault ? `the worker's pane matches an upstream-fault signature ("${excerpt(snippetFault.matched, 80)}")` : null, events.upstream, cliFault ? `\`capture --json\` itself reported an upstream fault ("${cliFault}")` : null].filter((entry) => entry !== null);
  const turnEvidence = [transcript.turn, snippetOutput !== null ? `the worker's pane carries non-blank, non-error output ("${excerpt(snippetOutput, 80)}")` : null, events.turn].filter((entry) => entry !== null);

  let code;
  let because;
  if (transcript.upstream !== null) {
    code = TURN_EVIDENCE_UPSTREAM;
    because = upstreamEvidence;
  } else if (transcript.turn !== null) {
    code = TURN_EVIDENCE_NOTHING;
    because = turnEvidence;
  } else if (upstreamEvidence.length > 0) {
    code = TURN_EVIDENCE_UPSTREAM;
    because = upstreamEvidence;
  } else if (turnEvidence.length > 0) {
    code = TURN_EVIDENCE_NOTHING;
    because = turnEvidence;
  } else {
    code = TURN_EVIDENCE_UNREADABLE;
    because = [];
  }

  const capClause = `the --max-turns ${inputs.maxTurns} cap was reached with \`commandmate wait --verify\` returning exit ${VERIFY_EXIT_NOT_STARTED} `
    + `(work-evidence: no commit, no uncommitted change) on every one of ${turns} turn(s), which took ${turnDurations.join('/')}s`;
  const standsClause = 'The adjudication is unchanged: verification really did fail (exit '
    + `${VERIFY_EXIT_NOT_STARTED}), \`worker_state\` stays \`failed\` and blocking \`worker_failed\` still says why the run stopped; this entry says WHY THERE IS NOTHING`;
  const detail = code === TURN_EVIDENCE_UPSTREAM
    ? `${capClause}. Evidence that the UPSTREAM was unavailable: ${because.join('; ')}. `
      + 'Do NOT split the Issue and do NOT re-plan: nothing about this Issue has been measured, because no turn ran. '
      + `Wait for the upstream to recover, then re-dispatch the same plan with \`dispatch.mjs --plan <plan.json> --resume <this run's dispatch directory>\`. ${standsClause}.`
    : code === TURN_EVIDENCE_NOTHING
      ? `${capClause}. Evidence that turns really RAN: ${because.join('; ')}. `
        + 'So the worker was working and still produced no commit and no uncommitted change: read the worker log, then split or re-write the Issue and re-plan. '
        + `${standsClause}.`
      : `${capClause}. NEITHER was measured: no positive evidence that the upstream was unavailable, and no positive evidence that any turn ran`
        + `${captureFailure === null ? '' : ` (${captureFailure})`}`
        + `${transcript.record.read === false ? ` (transcript: ${transcript.record.reason})` : ''}`
        + `${events.record === null ? ' (no structuredEvents in the capture, so hook evidence was unavailable)' : ''}. `
        + 'Read NEITHER "the worker produced nothing" NOR "the upstream was down" into this — it is not a weaker version of either. '
        + `Check by hand with \`commandmate capture <worktree-id> --json\` and, for a Claude Code worker, its transcript: \`${MANUAL_TRANSCRIPT_COMMAND}\`. `
        + 'An upstream wall reads as the same one-line error repeated; a real turn reads as tool calls. '
        + `${standsClause}.`;

  return {
    code,
    turns,
    turn_durations_seconds: turnDurations,
    snippet_blank: snippetBlank,
    line_count: lineCount,
    upstream_signature: transcript.signature ?? (snippetFault ? excerpt(snippetFault.matched, 80) : null) ?? cliFault ?? null,
    structured_events: events.record,
    transcript: transcript.record,
    detail: redact(detail),
  };
}

// The one-sentence version, for the `note` a human reads first. Rendered FROM
// the recorded object rather than composed beside it (Issue #83's rule): two
// independent claims about one fact drift.
function turnEvidenceNoteClause(evidence) {
  const turnsClause = `${evidence.turns} turn(s) took ${evidence.turn_durations_seconds.join('/')}s`;
  if (evidence.code === TURN_EVIDENCE_UPSTREAM) {
    return `why there is nothing: ${TURN_EVIDENCE_UPSTREAM} — the upstream was unavailable`
      + `${evidence.upstream_signature === null ? '' : ` ("${evidence.upstream_signature}")`}`
      + `, so this is not a measurement of the Issue; ${turnsClause}. Wait and --resume rather than splitting the Issue`;
  }
  if (evidence.code === TURN_EVIDENCE_NOTHING) {
    return `why there is nothing: ${TURN_EVIDENCE_NOTHING} — turns really ran and produced no commit and no uncommitted change; ${turnsClause}`;
  }
  return `why there is nothing: ${TURN_EVIDENCE_UNREADABLE} — neither "the upstream was unavailable" nor "turns ran and produced nothing" was measured; ${turnsClause}. Read neither into it`;
}

// =============================================================================
// A worker that stopped and reported (Issue #287)
// =============================================================================
//
// The supervision nudge asks a worker that finds it cannot write what it was told
// to STOP AND REPORT instead of pressing on (CommandMate#3009, 0.34.0). A worker
// that did exactly that used to be nudged on to the `--max-turns` cap and then
// recorded as "no commit / no work evidence" — the same `failed` as a worker that
// said nothing — and its report was nowhere in the report. The consumer
// (Kewton/Musunest) treats that stop as a GOOD stop, so the words have to survive
// and the run has to be able to tell it from silence.
//
// What counts as "stopped and reported", decided here and nowhere else:
//
//   - the turn was opened by the supervision NUDGE (the message that carries the
//     stop-and-report instruction) — a first turn or a commit request / gate
//     re-instruction is not one;
//   - it ended without progress: exit 21 on the contract path (work-evidence: no
//     commit, no uncommitted change), no new commit on the fallback path;
//   - the worker's transcript records THAT nudge as its last human message, and
//     after it the worker's last word is text — not a tool call left hanging,
//     not an upstream error line.
//
// The third condition is what makes "the reply of THIS turn" a measurement
// rather than a guess: a transcript whose last human message is not our nudge
// (a session that has not recorded it, a stale file) has no reply this runner
// can attribute to the turn, and is read as "no report" — the conventional loop
// goes on exactly as before. So does every world in which the reply could not be
// read at all (a failed or unparseable `capture`, a non-Claude agent, no or
// several transcripts): "we could not look" is never a report, and it is never a
// reason to stop either. The screen (`realtimeSnippet`) is deliberately not
// used: it holds the nudge's own echo beside the reply, and a pane cannot say
// which lines belong to which turn.
//
// Found, the nudge STOPS: another nudge would ask the same question of a worker
// that has already answered it, spend turns up to the cap, and bury the answer.
// The adjudication does not move — `verification.outcome` stays what the turn's
// `wait --verify` returned, `worker_state` stays `failed`, blocking
// `worker_failed` still says why the run stopped. What is added is the report
// itself (`worker_report`) and a blocking `worker_stopped_with_report` that
// sends a human to read it.
const WORKER_STOPPED_WITH_REPORT = 'worker_stopped_with_report';
// The same excerpt rule as every other transcribed text in this report (tail
// kept, whitespace collapsed, redacted), with a wider bound: a report is the
// deliverable of this turn, and its conclusion is at the end.
const WORKER_REPORT_EXCERPT_LIMIT = 600;
// How a transcript's human message is recognized as this runner's nudge. The
// first line only: `--nudge-message` / `worker_messages.nudge` append after it.
const NUDGE_MARKER = NUDGE_MESSAGE.split('\n')[0];

// The text of a transcript entry that a HUMAN (or this runner) sent, or null.
// Claude Code records tool results as `type: user` too; those are not messages.
function humanEntryText(entry) {
  if (entry?.type !== 'user') return null;
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((part) => part?.type === 'tool_result')) return null;
  const texts = content.filter((part) => typeof part?.text === 'string').map((part) => part.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

// `commandmate reply` (CommandMate 0.43.0+, Issue #296) reads the reply the
// server's transcript readers wrote to the ledger — for Claude, Codex,
// Antigravity, Command Code and OpenCode alike — so it is the reader when the
// CLI has it. Whether it has it is asked ONCE per process, the same way
// `probeContractSupport` asks about `send` / `wait` (`--help` succeeding is the
// answer; a version number is never compared). A CLI without it keeps the
// Claude-only transcript reader below, so nothing 0.35.0 read is lost.
let replySupported = null;
function probeReplySupport(inputs) {
  if (replySupported === null) replySupported = runCm(inputs, ['reply', '--help']).ok;
  return replySupported;
}

// The reply of the turn the nudge opened, or null: exit != 0, unparseable JSON
// and `reply: null` (no transcript row since the nudge) are all "no report".
// `--instance` is not passed: dispatch names none on `send` / `wait` either, so
// all three address the worktree's primary instance.
async function readReplyViaCli(inputs, worktreeId, turns, sinceIso) {
  const args = ['reply', worktreeId, ...(sinceIso === null ? [] : ['--since', sinceIso]), '--json'];
  const result = await runCmAsync(inputs, args);
  if (!result.ok) return null;
  const payload = parseCliJson(result);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.reply !== 'string') return null;
  return workerReportFromText(payload.reply.trim(), turns, 'commandmate_reply');
}

// The shared tail of both readers: the upstream-fault rule, the excerpt rule.
function workerReportFromText(text, turns, source) {
  if (text.length === 0) return null;
  if (matchUpstreamFault(text) !== null) return null;
  const clipped = excerpt(text, WORKER_REPORT_EXCERPT_LIMIT);
  if (clipped === null) return null;
  return {
    code: WORKER_STOPPED_WITH_REPORT,
    turn: turns,
    source,
    text: clipped,
    truncated: clipped.startsWith('…'),
  };
}

async function readWorkerStopReport(inputs, worktreeId, worktreePath, turns, sinceIso = null) {
  if (probeReplySupport(inputs)) return readReplyViaCli(inputs, worktreeId, turns, sinceIso);
  return readClaudeTranscriptReport(inputs, worktreeId, worktreePath, turns);
}

// ONE `capture` (for `cliToolId`, which names the transcript layout — the #220
// rule), then the transcript. Returns the `worker_report` object, or null for
// every world that is not a readable stop-and-report.
async function readClaudeTranscriptReport(inputs, worktreeId, worktreePath, turns) {
  const capture = await runCmAsync(inputs, ['capture', worktreeId, '--json']);
  if (!capture.ok) return null;
  const payload = parseCliJson(capture);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const read = readTranscriptEntries(worktreePath, payload.cliToolId);
  if (!read.ok) return null;
  let lastHuman = -1;
  for (let i = read.entries.length - 1; i >= 0; i -= 1) {
    if (humanEntryText(read.entries[i]) !== null) {
      lastHuman = i;
      break;
    }
  }
  if (lastHuman < 0 || !humanEntryText(read.entries[lastHuman]).includes(NUDGE_MARKER)) return null;
  const replies = read.entries.slice(lastHuman + 1)
    .filter((entry) => entry?.type === 'assistant')
    .map(assistantEntryParts);
  // The FINAL reply: the text entries after the last tool call (Claude Code
  // writes one entry per content block, so one answer can span several).
  const finalTexts = [];
  for (let i = replies.length - 1; i >= 0; i -= 1) {
    if (replies[i].hasTool) break;
    const text = replies[i].text.trim();
    if (text.length > 0) finalTexts.unshift(text);
  }
  if (finalTexts.length === 0) return null;
  return workerReportFromText(finalTexts.join('\n'), turns, 'claude_transcript');
}

// The one-sentence version for the worker `note`, rendered FROM the record
// (Issue #83's rule).
function workerReportNoteClause(report, inputs, progress) {
  return `the worker stopped and reported on turn ${report.turn} (opened by the supervision nudge) with ${progress}; `
    + `no further nudge was sent (the --max-turns cap is ${inputs.maxTurns}) — ${WORKER_STOPPED_WITH_REPORT}: read its report (worker_report) before deciding`;
}

function workerReportBlockingDetail(issue, report) {
  return `#${issue}: after the supervision nudge that opened turn ${report.turn} — which tells a worker that cannot write what it was told to stop and report — `
    + 'the worker ended that turn without progress and with a reply, so supervision stopped nudging it rather than spending the rest of --max-turns on a worker that had already answered. '
    + `Its report, ${report.source === 'commandmate_reply' ? 'read with `commandmate reply` (the transcript reader\'s ledger row)' : 'transcribed from its Claude Code transcript'}${report.truncated ? ` (the tail, cut to ${WORKER_REPORT_EXCERPT_LIMIT} characters)` : ''}: "${report.text}". `
    + 'Read it, then either fix the Issue (or its 対象ファイル / 受入条件) and re-plan, or — when the report says the obstacle is gone — re-dispatch the same plan with '
    + '`dispatch.mjs --plan <plan.json> --resume <this run\'s dispatch directory>`. '
    + 'The adjudication is unchanged: `worker_state` stays `failed` and blocking `worker_failed` still says why the run stopped; this entry is what the worker said';
}

// =============================================================================
// Recording a verification verdict (Issue #83)
// =============================================================================
//
// ONE function writes a worker's verification, and the same function writes the
// sentence about it that a human reads in `note`. That is the whole point: #83
// was two independent claims about the same fact — a note string composed inside
// the supervision loop ("verification passed and a new commit was detected") and
// a `verification` object assembled somewhere else — drifting apart, with the
// note right and the structured field wrong. A reader cannot tell which half to
// believe, and merge/uat believe the field, so the report's WORDING alone
// decided whether verified work was delivered. Deriving the wording from the
// recorded object makes the contradiction unrepresentable rather than merely
// unlikely.

function appendNote(note, clause) {
  return note ? `${note}; ${clause}` : clause;
}

// The human-readable half of `verification`, rendered from `verification`.
// `source` is how the verdict was reached: `contract` (CommandMate's
// `wait --verify` exit code) or `baseline` (the profile re-run fallback).
function verificationNoteClause(verification, source) {
  const gateIds = verification.gates.map((gate) => gate.id);
  if (verification.outcome === 'pass') {
    if (gateIds.length > 0) return `verification passed (${gateIds.join(', ')})`;
    return source === 'baseline'
      ? 'verification passed (profile baseline re-run; it declares no gates)'
      : 'verification passed, but the run named no gate (see checks)';
  }
  if (verification.outcome === 'fail') {
    const failed = verification.gates.filter((gate) => gate.verdict === 'fail').map((gate) => gate.id);
    return failed.length > 0 ? `verification failed (${failed.join(', ')})` : 'verification failed (see checks)';
  }
  return 'verification reached no verdict (not_run)';
}

// Record a verdict on a worker: the structured field, the note clause derived
// from it, and — when a pass names no gate — the fact that the gate list could
// not be read. That last one is the same shape as the planner's
// `unrecognized_file_extension` (orchestrate.mjs): what the runner FAILED to
// pick up is recorded, instead of an empty list that reads as "nothing ran".
// #47 / CommandMate #1678 B-5 exists so a report alone can answer WHAT a pass
// was based on; a silently empty `gates` returns the report to before that.
// `unattributed` is the stage-C promotion channel (Issue #142 / ADR sections 6.5
// and 8). Under `--unattended` the same finding is written to `blocking_reasons`
// instead of `limitations` and its issue number is collected here, so the wave
// barrier below can stop the run on it. The VERDICT is untouched either way: it
// is an exit code and it stands (that is what Issue #83 decided), so
// `verification.outcome` stays `pass` and the `checks` line is added on both
// paths. What the promotion changes is whether the run keeps going.
function recordVerification(report, worker, verification, source, unattended = false, unattributed = null) {
  worker.verification = verification;
  worker.note = appendNote(worker.note, verificationNoteClause(verification, source));
  if (source === 'contract' && verification.outcome === 'pass' && verification.gates.length === 0) {
    const detail = `#${worker.issue} passed verification, but no \`GATE <id> PASS|FAIL\` line could be read from the \`commandmate wait --verify\` output, so the report cannot name which gates the pass was based on; the verdict is the exit code and stands, but treat the pass as unattributed`;
    if (unattended) {
      if (unattributed) unattributed.add(worker.issue);
      report.blocking_reasons.push({
        code: 'verification_gates_unrecorded',
        detail: `${detail}. Under --unattended this is blocking rather than a limitation (ADR section 6.5): nobody is here to open the run and see WHAT judged it, and an unattributed pass is the whole basis an unattended merge would act on`,
      });
    } else {
      report.limitations.push({ code: 'verification_gates_unrecorded', detail });
    }
    worker.verification.checks = [
      ...verification.checks,
      'gate list unavailable: the wait --verify output carried no parseable `GATE <id> PASS|FAIL` line',
    ];
  }
}

// The FALLBACK verification gate, used when the CLI has no execution contract
// (`--contract-mode off`, or a CommandMate older than 0.17.0). Worker completion
// got us here; this re-runs the profile baseline INSIDE the worktree and passes
// only when every baseline command exits zero. A missing worktree or any non-zero
// step is a fail — never optimistically opened. Under a contract this is not
// called at all: the verdict is `commandmate wait --verify`'s exit code.
function verifyWorker(inputs, worktreePath, baseline) {
  if (!Array.isArray(baseline) || baseline.length === 0) {
    return { ran: true, outcome: 'fail', checks: [], note: 'profile has no baseline to verify against' };
  }
  const checks = [];
  for (const command of baseline) {
    const argv = String(command).trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) continue;
    checks.push(redact(String(command)));
    const res = runCli(argv[0], argv.slice(1), { cwd: worktreePath });
    if (!res.ok) {
      return { ran: true, outcome: 'fail', checks, note: excerpt(res.stderr || res.stdout || `baseline step failed: ${command}`) };
    }
  }
  return { ran: true, outcome: 'pass', checks, note: '' };
}

// =============================================================================
// Reverify — measuring work evidence, and re-judging without sending (#121)
// =============================================================================

// The two facts CommandMate's `work-evidence` gate counts, measured inside the
// worktree with the git CLI this runner already drives:
//
//   commits      `git rev-list --count <base>..HEAD` — the work branch's own
//                commits. The same range the gate counts, and the same range
//                merge later turns into a PR.
//   uncommitted  `git status --porcelain` — a non-empty listing.
//
// Positive evidence wins: one readable half that says "there is something here"
// is enough, because the question is whether there is anything to judge. The
// negative answer is the one that must be complete — "there is nothing here"
// requires BOTH halves to be readable and empty, and anything less comes back as
// `unreadable` so the caller can say "we could not look" instead of "it is
// empty". Neither answer is ever guessed from the prior report's worker_state.
async function workEvidence(inputs, plan, worktreePath) {
  if (!worktreePath) {
    return { present: false, unreadable: true, commits: null, uncommitted: null };
  }
  const counted = await runCliAsync(inputs.git, ['rev-list', '--count', `${plan.profile.base}..HEAD`], { cwd: worktreePath });
  const raw = counted.ok ? counted.stdout.trim() : '';
  const commits = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  const status = await runCliAsync(inputs.git, ['status', '--porcelain'], { cwd: worktreePath });
  const uncommitted = status.ok ? status.stdout.trim().length > 0 : null;
  return {
    present: (commits !== null && commits > 0) || uncommitted === true,
    unreadable: commits === null || uncommitted === null,
    commits,
    uncommitted,
  };
}

// How the measurement reads in a report line.
function workEvidenceDetail(evidence) {
  const commits = evidence.commits === null ? 'unreadable' : String(evidence.commits);
  const dirty = evidence.uncommitted === null ? 'unreadable' : (evidence.uncommitted ? 'yes' : 'no');
  return `commits on the work branch: ${commits}; uncommitted change in the worktree: ${dirty}`;
}

// The gate list of a `commandmate verify --json` run document. The ordinary path
// reads `GATE <id> PASS|FAIL` lines off `wait --verify`; a reverify has no wait,
// so the same facts are read out of the document's own `gates[]` (the shape
// describeFailingGates already reads). `skipped` is not a verdict and is left
// out rather than rounded, exactly as the ordinary path leaves it out.
//
// Returns { gates, dropped }, like gatesFromWaitOutput: the same cap applies here
// and it owes the reader the same accounting (#165).
function gatesFromVerifyDocument(run, requiredGateIds = new Set()) {
  const gates = [];
  for (const gate of (run !== null && typeof run === 'object' && Array.isArray(run.gates)) ? run.gates : []) {
    if (gate === null || typeof gate !== 'object') continue;
    const id = typeof gate.gateId === 'string' ? gate.gateId.trim() : '';
    if (id === '') continue;
    const status = String(gate.status ?? '');
    let verdict = FAILED_GATE_STATUSES.has(status) ? 'fail' : (status === 'passed' ? 'pass' : null);
    if (verdict === null) continue;
    // A gate whose two runs disagreed is reported as FLAKY whichever way the run
    // counted it, exactly as the wait's own GATE line spells it (#224). The
    // count itself is untouched: the run's verdict is its exit code.
    if (gateFlakyOutcome(gate) === 'flaky') verdict = 'flaky';
    gates.push({ id: redact(id), verdict, origin: gateOrigin(id, requiredGateIds) });
  }
  return capGates(gates);
}

// Re-judge ONE worktree as it stands. Nothing is sent, no contract is written
// and no worker turn is consumed; the only thing that happens is the same
// verification the ordinary path runs, against a tree whose work is finished.
//
// The verdict vocabulary is the ordinary one, unchanged (contract §2.1 / §2.6):
// 0 pass, 20 judged-and-failed, 21 the work-evidence gate finding nothing,
// 99 NO VERDICT AT ALL (escalated, never re-instructed), anything else
// infrastructure and therefore no verdict to record.
async function reverifyWorker(inputs, plan, contractMode, worktreeId, worktreePath, issueGateIds) {
  if (!contractMode) {
    // The fallback judge, unchanged: the profile baseline re-run inside the
    // worktree. It is the same function, called with the same arguments, as the
    // one the ordinary fallback path calls — a reverify must not be judged by a
    // different instrument than the run it is re-judging.
    const verification = verifyWorker(inputs, worktreePath, plan.profile.baseline);
    return {
      source: 'baseline',
      notJudged: false,
      verdict: {
        ran: verification.ran,
        report_schema_version: null,
        outcome: verification.outcome,
        gates: [],
        checks: verification.checks,
      },
      note: verification.note,
    };
  }
  const result = await runCmAsync(inputs, ['verify', worktreeId, '--json']);
  // `verify` exits WITH the verdict, so on a failing run the exit is 20 and the
  // run document is still on stdout. Parse it regardless of exit status — the
  // same reading describeFailingGates takes, and for the same reason.
  let run = null;
  try {
    run = JSON.parse(result.stdout);
  } catch {
    run = null;
  }
  const code = result.ok ? VERIFY_EXIT_PASS : (result.status ?? null);
  const reverifyGates = gatesFromVerifyDocument(run, new Set(issueGateIds));
  const done = (outcome, checks, extra = {}) => ({
    source: 'contract',
    notJudged: false,
    verdict: { ran: true, report_schema_version: null, outcome, gates: reverifyGates.gates, checks: [...checks, ...droppedGateChecks(reverifyGates)] },
    note: '',
    ...extra,
  });
  if (code === VERIFY_EXIT_PASS) {
    return done('pass', [`commandmate verify --json → exit ${VERIFY_EXIT_PASS} (every declared gate passed; re-judged in place, nothing was sent)`]);
  }
  if (code === VERIFY_EXIT_FAILED) {
    return done('fail', [`commandmate verify --json → exit ${VERIFY_EXIT_FAILED} (a gate failed; re-judged in place, nothing was sent)`]);
  }
  if (code === VERIFY_EXIT_NOT_STARTED) {
    // The judge disagrees with the git measurement that selected this issue.
    // Recorded as the verdict it is (exit 21 has always been `fail`), and the
    // disagreement itself is reported by the caller rather than smoothed over.
    return done('fail',
      [`commandmate verify --json → exit ${VERIFY_EXIT_NOT_STARTED} (work-evidence found no commit and no uncommitted change)`],
      { workEvidenceDisagreed: true });
  }
  if (code === VERIFY_EXIT_NO_VERDICT) {
    return {
      source: 'contract',
      notJudged: true,
      verdict: {
        ran: true,
        report_schema_version: null,
        outcome: 'not_run',
        gates: [],
        checks: [`commandmate verify --json → exit ${VERIFY_EXIT_NO_VERDICT} (the verification run ended error/cancelled; no verdict was reached)`],
      },
      note: `escalated to a human rather than re-judged (exit ${VERIFY_EXIT_NO_VERDICT}: the run ended error/cancelled)`,
    };
  }
  // 1 / 2 / 124 / anything else: infrastructure, not a verdict. No verdict is
  // recorded at all — the prior record stands, and the caller says why.
  return {
    source: 'contract',
    notJudged: false,
    verdict: null,
    note: excerpt(result.stderr || result.stdout || `commandmate verify exited ${code ?? 'with an error'}`) ?? 'commandmate verify could not be run',
  };
}

async function respondWorker(inputs, worktreeId) {
  // Only ever reached when --auto-yes is explicitly set. A generic affirmative;
  // the default path never calls this, which is what keeps prompt handling
  // human-in-the-loop.
  const result = await runCmAsync(inputs, ['respond', worktreeId, 'yes']);
  return result.ok;
}

// =============================================================================
// The open-questions gate (Issue #52)
// =============================================================================

// Every issue in the plan that still carries a planner question, in plan order.
// A plan written by an older runner may have no `questions` field at all; a
// missing field is "nothing to report", not a reason to refuse the plan.
function collectOpenQuestions(plan) {
  const out = [];
  for (const issue of plan.issues ?? []) {
    const questions = Array.isArray(issue.questions) ? issue.questions.filter((q) => typeof q === 'string' && q !== '') : [];
    if (questions.length > 0) out.push({ issue: issue.number, questions });
  }
  return out;
}

// The question TEXT, not just a count — an operator cannot act on "3 open
// questions", only on what they say. Bounded so a long question cannot flood the
// blocking reason, and redacted like every other field lifted out of an issue.
function formatOpenQuestions(entries) {
  return entries
    .map((entry) => `#${entry.issue}: ${entry.questions.map((q) => excerpt(redact(q), 200)).join(' / ')}`)
    .join('; ');
}

// =============================================================================
// DAG scheduling — the effective graph the ready gate reads (Issue #183)
// =============================================================================

// The edges an issue is actually gated on. Two filters, and both are the point:
//
//   1. `basis: lexical` is DROPPED. Issue #182 decided that an inference from
//      shared vocabulary alone is not an edge — the planner raises
//      `unconfirmed_lexical_dependency` on the consumer instead and emits no
//      edge — so `plan.dependencies` should never carry one. It is filtered here
//      anyway, and out loud, because the DAG gate is the one consumer that would
//      turn a phantom edge back into real waiting: a plan hand-edited (or written
//      by a runner from before the distinction) must not quietly re-serialise the
//      run that #182 un-serialised. An edge with NO basis at all is kept — absent
//      means "written before the distinction existed", never "ungrounded"
//      (execution-plan.v2 §dependency).
//   2. An edge naming an issue this plan does not contain is dropped: waiting for
//      a node that will never be scheduled is a deadlock, not a dependency.
//
// Returns the adjacency (issue -> Set of issues it waits for) and the dropped
// lexical edges, so the caller can record what it ignored.
function effectiveDependencies(plan) {
  const known = new Set((plan.issues ?? []).map((issue) => issue.number));
  const edges = new Map([...known].map((number) => [number, new Set()]));
  const lexical = [];
  for (const edge of plan.dependencies ?? []) {
    if (!known.has(edge.issue) || !known.has(edge.depends_on)) continue;
    if (edge.basis === 'lexical') {
      lexical.push(edge);
      continue;
    }
    edges.get(edge.issue).add(edge.depends_on);
  }
  return { edges, lexical };
}

// The scope each issue declares, as a set, for the mutual-exclusion rule below.
function declaredFilesByIssue(plan) {
  return new Map((plan.issues ?? []).map((issue) => [issue.number, new Set(issue.suspected_files ?? [])]));
}

// Two issues that name a file in common are never run AT THE SAME TIME, in either
// scheduling mode. In `wave` the planner enforces it by packing (rule 2 of
// planWaves: no shared-file pair in one wave) and the runner inherits it; in
// `dag` there are no waves to inherit it from, so the scheduler enforces it
// itself. This is NOT a dependency — it has no direction, it does not order the
// two issues, and a failure on one side does not block the other. It is only a
// statement that two workers must not write the same file concurrently, which is
// the one guarantee wave packing was providing that `plan.dependencies` does not.
function sharesDeclaredFile(files, a, b) {
  const left = files.get(a);
  const right = files.get(b);
  if (!left || !right) return false;
  for (const path of left) {
    if (right.has(path)) return true;
  }
  return false;
}

// The run-wide declaration `--schedule dag` writes, before anything is dispatched
// (the shape `unattended_mode` uses): every other line of the report is read
// against it. Absent — and therefore invisible — on a default run, which is what
// keeps such a run byte-for-byte the one it was before this flag existed.
function scheduleDagLimitation(plan) {
  return {
    code: 'schedule_dag',
    detail: `--schedule dag: issues are admitted by DEPENDENCY SATISFACTION, not by wave. An issue is dispatched as soon as every effective `
      + 'dependency of it (plan.dependencies minus the lexical-only edges Issue #182 refuses) is `completed` AND `verification.outcome: pass`, '
      + `and a slot is free — so an issue that only shared a wave with the slowest worker no longer waits for it. Three consequences a reader `
      + `of this report needs: (1) --max-parallel is a CONCURRENCY CAP (${plan.max_parallel} workers at once), never a wave width — `
      + 'the waves[] entries below are ADMISSION ROUNDS and their `barrier` is descriptive, not a gate; (2) plan.waves is reference information '
      + 'in this mode (it still records what the planner computed, and merge_order still comes from it), so a run whose waves look wrong is not '
      + 'thereby a run that dispatched wrong; (3) the post-merge integration verification (#175) has no wave boundary left to sit on — run '
      + '`merge.mjs --merge-prs --integration-verify` ONCE after this run, over everything it merged. '
      + 'This mode RAISES the achieved parallelism: the barrier was incidentally capping it at the width of each wave. On a repository whose '
      + 'verification gates share a resource (a port, one shared env) that can turn contention into false reds — Kewton/CommandMate#1771 (gate '
      + 'resource serialisation / per-worktree env injection) is still OPEN, so keep --max-parallel conservative until it lands',
  };
}

// =============================================================================
// The supervision loop
// =============================================================================

// The report every dispatch starts from — a success envelope the run then
// contradicts. Shared with the pre-flight refusal (Issue #90) so a run that
// stops before the first wave reports the same field set as one that dispatched;
// `outDir` is null there, because nothing was written.
function emptyReport(inputs, plan, outDir) {
  return {
    dispatch_schema_version: DISPATCH_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status: 'success',
    stop_reason: 'completed',
    human_required: false,
    plan_run_id: plan.run_id,
    out_dir: outDir,
    auto_yes: inputs.autoYes,
    max_parallel: plan.max_parallel,
    // Which reading `max_parallel` and `waves[]` below take (Issue #183). Written
    // ONLY on a `--schedule dag` run: an absent field is the default barrier, and
    // its absence is what keeps a run without the flag byte-for-byte the run it
    // was before the flag existed. Placed beside `max_parallel` because that is
    // the value whose MEANING it changes.
    ...(inputs.schedule === 'dag' ? { schedule: 'dag' } : {}),
    profile: {
      id: String(plan.profile.id ?? 'unknown'),
      repository: plan.profile.repository,
      base: plan.profile.base,
      verified: plan.profile.verified === true,
    },
    // Written ONLY when `--only` narrowed the plan (CommandMate#3008): the whole
    // plan and the subset this run took, side by side, so a reader can tell "not
    // selected" from "not dispatched". Absent otherwise.
    ...(inputs.onlyScope === null ? {} : { plan_scope: inputs.onlyScope }),
    drift_checks: [],
    waves: [],
    blocking_reasons: [],
    // The profile's operating defaults are stated FIRST, before the mode
    // declarations below (Issue #180): every value the rest of this report is
    // read against — the wait timeout a `wait_window_exhausted` is measured
    // from, the turn cap a `failed` gave up at, whether auto-yes was armed — is
    // decided there, and a reader who does not know which of them came from the
    // profile cannot reconstruct the run from the argv. Empty (and therefore
    // invisible) on a plan whose profile declares nothing.
    limitations: [
      ...inputs.dispatchDefaultNotes,
      ...(inputs.onlyScope === null ? [] : [onlyLimitation(inputs.onlyScope)]),
      ...humanOnlyLimitations(inputs, plan),
    ],
    redactions: [],
    completion_check: { passed: false, checks: [] },
    summary_markdown: '',
  };
}

// `preflight` is the first wave's already-computed resolution + drift re-check
// (Issue #90), or null when the run will refuse before any wave for a reason
// that does not depend on the state of the world (an unanswered planner
// question). The loop reuses it for wave 0 instead of probing the CLI twice.
//
// `resume` is the carry-over decision (Issue #98) or null on an ordinary run.
// `outDir` is THIS ATTEMPT's directory — the run directory on attempt 1, and
// `<run-dir>/resume-attempt-<n>/` on a resume — so every artifact this function
// writes lands beside the report that describes it and nothing an earlier
// attempt wrote is touched.
async function runDispatch(inputs, plan, outDir, preflight = null, preparation = null, resume = null, lockKeys = []) {
  const promptsDir = join(outDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  const report = emptyReport(inputs, plan, outDir);
  // This attempt re-judges instead of re-dispatching (Issue #121). Read off the
  // same decision object as the resume split, because it IS that split — only
  // what happens to the not-carried half differs.
  const reverifying = resume !== null && resume.reverifying === true;
  // The mode of the whole invocation, stated first: everything below is read
  // against it (Issue #122 / ADR section 7.2). Nothing is pushed when the flag
  // was not passed, which is what keeps a run without it byte-identical to a run
  // from before the flag existed.
  // The scheduling mode, stated before the unattended declaration for the same
  // reason that one is stated before everything else (Issue #183): it decides how
  // `max_parallel`, `waves[]` and every `barrier` below are to be read, and a
  // reader who does not know which mode ran cannot reconstruct the run from them.
  // Nothing is pushed on the default, which is what keeps a run without the flag
  // byte-identical to a run from before it existed.
  if (inputs.schedule === 'dag') report.limitations.push(scheduleDagLimitation(plan));
  if (inputs.unattended) report.limitations.push(unattendedModeLimitation(inputs, lockKeys));
  // Stated before anything else the run says: which attempt this is, what it
  // carried, and what it re-dispatched. Every other line of the report is read
  // against that.
  if (resume !== null) report.limitations.push(resumeLimitation(plan, resume));
  // The width a reverify was told to judge at (Issue #274). Pushed only when the
  // flag was passed, so a reverify without it keeps the report it always had.
  if (reverifying && inputs.verifyConcurrency !== null) {
    report.limitations.push({
      code: 'verify_concurrency_limited',
      detail: `--verify-concurrency ${inputs.verifyConcurrency}: this reverify re-judged at most ${inputs.verifyConcurrency} issue(s) at a time. `
        + 'It changes how many gate runs overlap, never which issues are judged or what a verdict says; it is a run argument, not part of the plan or the run id',
    });
  }
  // The run-wide method declaration (Issue #128 / ADR section 9), stated before
  // any wave: everything below — the `## Method` section in each contract, the
  // per-issue `worker_method_applied` entries — is read against it. Nothing is
  // pushed when the flag was not passed, which is what keeps a run without it
  // byte-identical to a run from before the flag existed.
  if (inputs.workerMethod !== null) report.limitations.push(workerMethodDeclaredLimitation(inputs.workerMethod));
  // The one case the arming above cannot cover (Issue #136): 8h is the longest
  // window the CLI accepts, and a run whose per-worker ceiling reaches it will
  // outlive its own auto-yes. That is not a failure — the runner's own exit-10
  // response path keeps working after the window closes — but it IS the run
  // silently becoming a different run halfway through, so it is written down
  // rather than left for the operator to infer from a stalled worker.
  if (inputs.autoYes) {
    const ceiling = autoYesCeilingSeconds(inputs);
    const window = autoYesWindow(inputs);
    if (ceiling >= window.seconds) {
      report.limitations.push({
        code: 'auto_yes_window_short',
        detail: `--auto-yes armed the worktree auto-yes for ${window.duration}, the longest window commandmate send accepts, but `
          + `--max-turns ${inputs.maxTurns} × --wait-timeout ${inputs.waitTimeout}s = ${ceiling}s of supervision can outlive it. `
          + 'After it expires the server answers no prompt on its own; this runner still answers the prompts `wait --on-prompt agent` '
          + 'returns to it, so the run continues, but a prompt raised inside a turn will sit until the wait of that turn times out. '
          + 'Lower --max-turns or --wait-timeout to bring the ceiling under 8h',
      });
    }
  }
  // Nothing is left to dispatch: every issue the plan names was already
  // completed AND verified. Reported as its own fact rather than as a silent
  // success, because "the run did nothing" and "the run did everything" produce
  // the same exit code and must not read the same.
  const nothingToDispatch = resume !== null && resume.firstActiveWave < 0;
  if (nothingToDispatch) {
    report.limitations.push(reverifying
      ? {
        code: 'reverify_no_work',
        detail: `再判定対象なし: every issue in plan ${plan.run_id} was already completed and verified in a prior attempt, so this attempt judged nobody again, `
          + 'sent nothing and started no worker. The verification records below are all carried over; this report is the one to hand to merge/uat',
      }
      : {
        code: 'resume_no_work',
        detail: `再実行対象なし: every issue in plan ${plan.run_id} was already completed and verified in a prior attempt, so this attempt dispatched nobody, `
          + 'started no worker and re-judged nothing. The verification records below are all carried over; this report is the one to hand to merge/uat',
      });
  }
  // The pre-flight's drift verdict is part of THIS report even when the run
  // stops before the first wave for an unrelated reason: it was really checked,
  // so it is really recorded.
  if (preflight) report.drift_checks.push(...preflight.checks);
  // Same for the worktree preparation (Issue #93): the worktrees this run
  // dispatches into may have been created minutes ago by another Skill, and what
  // was created, from which base, with which baseline verdict, is evidence this
  // report owns rather than points at.
  recordPreparation(report, preparation);
  writePreparationArtifact(outDir, preparation);

  // Loop-wide facts the completion check is derived from.
  let parallelismBounded = true;
  let barrierEnforced = true;
  let autoResponded = false;
  let stopped = false;

  const haltWith = (status, stopReason, reasons) => {
    report.status = status;
    report.stop_reason = stopReason;
    report.blocking_reasons.push(...reasons);
    stopped = true;
  };
  const halt = (status, stopReason, code, detail) => haltWith(status, stopReason, [{ code, detail }]);

  // The open-questions gate (Issue #52). The planner writes a question for every
  // issue it could not read acceptance criteria or affected files out of. Nothing
  // downstream used to read that field, so an issue with no stated definition of
  // done reached a real worker with exit 0. It is checked FIRST — before the
  // contract probe and before any drift check — because the answer never depends
  // on the state of the world, only on the plan.
  const openQuestions = collectOpenQuestions(plan);
  if (openQuestions.length > 0) {
    const detail = `${openQuestions.length} issue(s) carry an unanswered planner question: ${formatOpenQuestions(openQuestions)}`;
    if (inputs.allowQuestions) {
      report.limitations.push({
        code: 'open_questions_accepted',
        detail: `--allow-questions was set, so dispatch proceeded with the questions unanswered. ${detail}`,
      });
    } else {
      report.human_required = true;
      halt('failure', 'dispatch_error', 'open_questions',
        `${detail} Nothing was dispatched: answer them in the issue body and re-plan, ` +
          'or re-run with --allow-questions to take the risk explicitly.');
    }
  }

  // The version gate (#1588). Decided ONCE, before the first wave, and always
  // stated: `auto` falls back with an explicit limitation, `require` refuses to
  // fall back at all, `off` never probes. What is not allowed is degrading in
  // silence — the fallback reports the same `verification.outcome: pass` from a
  // materially weaker check.
  // Skipped once the open-questions gate has already stopped the run: probing a
  // CLI whose answer can no longer change anything is a side effect for nothing.
  let contractMode = false;
  if (stopped || nothingToDispatch) {
    // nothing to decide; no wave will be dispatched
  } else if (inputs.contractMode === 'off') {
    report.limitations.push({
      code: 'contract_disabled',
      detail: '--contract-mode off: dispatched without an execution contract; verification is the profile baseline re-run inside the worktree',
    });
  } else {
    const probe = probeContractSupport(inputs);
    if (probe.supported) {
      contractMode = true;
    } else if (inputs.contractMode === 'require') {
      halt('failure', 'dispatch_error', 'contract_unsupported',
        `${probe.detail}; --contract-mode require refuses to fall back, so nothing was dispatched`);
    } else {
      report.limitations.push({
        code: 'contract_unsupported',
        detail: `${probe.detail}; falling back to the profile-baseline verification (the pre-contract behaviour)`,
      });
    }
  }
  const contractsDir = join(outDir, 'contracts');
  // Not on a reverify: it writes no contract, and an empty `contracts/` beside
  // its report would say it did (Issue #121).
  if (contractMode && !reverifying) mkdirSync(contractsDir, { recursive: true });
  // Issues whose verification reached NO verdict (exit 99). Kept beside the
  // report rather than inside it: dispatch_schema_version 1 is a closed field set
  // and merge/uat both refuse any other version, so the fact travels through the
  // blocking reason and the worker note instead of a new field.
  const notJudged = new Set();
  // Issues that completed with no verification verdict recorded at all (#83).
  // Feeds the `verification_recorded` completion check below.
  const verificationUnrecorded = new Set();
  // Issues whose contract pass could not name a single gate, under `--unattended`
  // only (Issue #142 / ADR sections 6.5, 8 — stage C). `recordVerification` has
  // already written the blocking reason; this set is what makes the wave loop
  // STOP on it rather than carry an unattributed pass into the next wave.
  const unattributedPasses = new Set();

  // ---- state the two schedulers share ---------------------------------------
  //
  // Hoisted out of the wave loop by Issue #183 so that `wave` and `dag` drive the
  // SAME preparation, the SAME supervision and the SAME recording — a second copy
  // of any of it is one that only gets fixed in one mode. Every map is keyed by
  // issue number, which is unique across the plan, so the wave loop reads exactly
  // what it read when these were per-wave locals.
  //
  // `worktreePaths` remembers the git path per issue so the verification gate
  // reuses the exact same worktree the supervisor drove (Issue #1473).
  const worktreePaths = new Map();
  const contractVerdicts = new Map();
  const reverifyVerdicts = new Map();
  // The fallback (profile-baseline) verdicts, which are an ACTION rather than a
  // stored exit code. In `wave` they are run inside the recording pass, exactly as
  // before. In `dag` the action has to happen the moment a worker finishes —
  // nothing downstream of it can be admitted until its verdict is known — so it is
  // run there and only RECORDED later, in plan order. Splitting the action from
  // the recording is what keeps the report's order independent of the order
  // workers happen to finish in.
  const fallbackVerdicts = new Map();
  // Workers whose scope re-instruction loop was cut short (Issue #148), collected
  // here and written to `blocking_reasons` once supervision has joined, in worker
  // order: this map is filled CONCURRENTLY, so pushing from inside it would order
  // the report by whichever worker happened to finish first and two runs of the
  // same plan could differ.
  const scopeUnsatisfiable = new Map();
  // What the send side did for each issue (CommandMate#3006 / #3007): a
  // not-ready retry, or a stale question found before the first send. Read out
  // in plan order by recordScopeAndLivenessReasons, like the entries above.
  const sendTraceByIssue = new Map();

  // Step 3a for ONE issue: build its worker record, take its already-resolved
  // worktree id/path, write its prompt artifact and place its contract. Workers
  // that cannot be dispatched (unsafe target / unresolved worktree / no declared
  // scope / an unreadable acceptance-gate block) are recorded terminal here and
  // never supervised. `sink` collects what the caller has to keep: the wave (or
  // admission round) this issue belongs to.
  const prepareIssue = async (res, sink) => {
    const number = res.number;
    const worker = {
      issue: number,
      // The worker is tracked by its worktree id (there is no task id in the
      // public CLI); this field carries that id, or null when it did not run.
      task_id: null,
      worker_state: 'not_dispatched',
      verification: { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] },
      prompt: { detected: false, excerpt: null },
      note: '',
    };
    if (res.templatePath === null) {
      worker.note = redact(`refused unsafe worktree target for #${number}`);
      report.limitations.push({ code: 'unsafe_worktree_target', detail: `#${number}: worktree target rejected by path-escape guard` });
      sink.workers.push(worker);
      return;
    }
    if (res.resolved.id === null) {
      worker.worker_state = 'failed';
      worker.note = redact(`worktree unresolved: ${res.resolved.note}`);
      sink.unresolvedWorktrees.push(res);
      sink.workers.push(worker);
      return;
    }

    // The reverify branch (Issue #121). Everything below this point exists in
    // order to SEND: it resolves the issue's acceptance gates so a contract can
    // carry them, refuses the issue when that contract could not be written,
    // places the contract in the worktree, and writes the prompt artifact the
    // worker is about to read. A reverify writes no contract and sends no
    // message, so none of it applies — and running those dispatch-time
    // refusals here would report "#N was not dispatched" inside an attempt that
    // dispatches nobody by definition. What replaces them is the work-evidence
    // measurement and the same verification gate, both in step 3b.
    if (reverifying) {
      // The prior record is the STARTING POINT, not a blank one: an issue this
      // attempt turns out not to be able to re-judge must keep saying what the
      // attempt that dispatched it found.
      const prior = resume.priorRecords.get(number);
      if (prior !== undefined) {
        worker.worker_state = WORKER_STATE_VALUES.includes(prior.worker_state)
          ? prior.worker_state
          // A string the conformance check accepted but this runner cannot
          // read is not a state it may repeat. `failed` is the only value that
          // neither claims a deliverable (`completed`) nor claims that nothing
          // ever ran (`not_dispatched`).
          : 'failed';
        worker.task_id = typeof prior.task_id === 'string' && prior.task_id.length > 0 ? redact(prior.task_id) : null;
        worker.verification = transcribedVerification(prior.verification);
        worker.prompt = transcribedPrompt(prior.prompt);
        worker.note = redact(typeof prior.note === 'string' ? prior.note : '');
      }
      worktreePaths.set(number, res.worktreePath);
      // The issue's `require:` ids, for gate PROVENANCE only (#97). A
      // malformed block cannot refuse a dispatch that is not happening, so it
      // degrades to "no issue-declared gate" instead of stopping the issue.
      const declaredGates = issueRequiredGates(res.issue);
      sink.reverifiable.push({
        worker,
        worktreeId: res.resolved.id,
        worktreePath: res.worktreePath,
        issueGateIds: declaredGates.error === null
          ? [...declaredGates.ids, ...definedGateIds(declaredGates.define)]
          : [],
      });
      sink.workers.push(worker);
      return;
    }

    // Without a contract the worktree id is the only handle the public CLI
    // gives a worker, so it is what `task_id` carries. With one, the field
    // holds the REAL task id `send --contract` returns — recorded below, once
    // the send actually happened, so a failed dispatch reports no task rather
    // than a plausible-looking wrong one.
    worker.task_id = contractMode ? null : res.resolved.id;
    worktreePaths.set(number, res.worktreePath);

    // The issue's own acceptance gates, resolved against THIS worktree's
    // verify.yaml before anything is sent. `send --contract` would exit 2 on an
    // id that does not exist, but that reports "the contract was invalid" about
    // a worker that never ran; naming what is missing is what a human can act
    // on — the same reading `contract_scope_unknown` takes (ADR §3.4).
    const declared = issueRequiredGates(res.issue);
    const requiredGates = declared.ids;
    // The gates the issue DEFINES (Issue #125). They are resolved in the same
    // place and for the same reason: a definition whose id collides with a gate
    // the worktree already declares is an exit 2 at `send`, and that reports a
    // bad contract instead of the name that has to change.
    const definedGates = declared.define;
    if (declared.error !== null) {
      worker.note = redact(`#${number} was not dispatched: ${declared.error}`);
      report.limitations.push({
        code: 'acceptance_gate_block_invalid',
        detail: `#${number}: the plan's acceptance_gates could not be read (${declared.error}). The planner writes this field only from a syntactically valid \`acceptance-gates\` block, so a plan that reaches dispatch with a malformed one was edited by hand; re-run the planner rather than dispatching against a requirement nobody can enforce`,
      });
      sink.workers.push(worker);
      return;
    }
    if (requiredGates.length > 0 || definedGates.length > 0) {
      // What the issue said about its own verdict, in one phrase, for the
      // refusals below. `require` and `gates:` fail for the same reasons and a
      // block may carry either or both, so the message names what this issue
      // actually wrote rather than assuming one of the two.
      const declaredGatesPhrase = [
        ...(requiredGates.length > 0 ? [`requires gate(s) ${requiredGates.join(', ')}`] : []),
        ...(definedGates.length > 0 ? [`defines gate(s) ${definedGateIds(definedGates).join(', ')}`] : []),
      ].join(' and ');
      if (!contractMode) {
        // Without an execution contract there is no `verify.gates`, no
        // `verify.gateDefinitions` and no `wait --verify`: the judge is the
        // profile baseline re-run in the worktree, which cannot be told about a
        // gate id and has nowhere to put a gate the issue defined. Dispatching
        // anyway would produce exactly the run this whole feature exists to
        // prevent — a green verdict that never measured the condition the issue
        // wrote.
        worker.note = redact(`#${number} was not dispatched: it declares acceptance gates, and this run has no execution contract to carry them`);
        report.limitations.push({
          code: 'acceptance_gates_not_enforceable',
          detail: `#${number}: the issue ${declaredGatesPhrase}, but this dispatch runs without an execution contract (--contract-mode off, or the CLI has no \`send --contract\`), so nothing can carry the requirement into the verdict. The fallback judge is the profile baseline, which has no gate ids. Use a CommandMate with contract support, or remove the \`acceptance-gates\` block and state the condition for UAT`,
        });
        sink.workers.push(worker);
        return;
      }
      // Read for BOTH halves. `require` needs it to resolve ids; a `gates:`
      // definition needs it because CommandMate refuses a contract that declares
      // `verify.gateDefinitions` when the repository has no readable
      // `.commandmate/verify.yaml` at all (a run that cannot start is a
      // completion criterion nothing can evaluate), and because the collision
      // check below is against exactly those ids.
      const config = readVerifyConfigGates(res.worktreePath);
      if (!config.ok) {
        worker.note = redact(`#${number} was not dispatched: ${config.reason}`);
        report.limitations.push({
          code: 'acceptance_gate_id_unknown',
          detail: `#${number}: the issue ${declaredGatesPhrase}, but ${config.reason}. The ids are resolved against the worktree's own ${VERIFY_CONFIG_RELATIVE} because that is the one file BOTH judges read (\`commandmate verify\` and cmate-verify); declare the gates there, or drop the requirement from the issue`,
        });
        sink.workers.push(worker);
        return;
      }
      const known = new Set([...CONTRACT_BUILT_IN_GATE_IDS, ...config.ids]);
      const missing = requiredGates.filter((id) => !known.has(id));
      if (missing.length > 0) {
        worker.note = redact(`#${number} was not dispatched: required gate id(s) ${missing.join(', ')} are not declared in the worktree`);
        report.limitations.push({
          code: 'acceptance_gate_id_unknown',
          detail: `#${number}: the issue requires gate id(s) ${missing.join(', ')}, which ${VERIFY_CONFIG_RELATIVE} does not declare. Available there: ${[...known].sort().join(', ')}. The issue is NOT dispatched — a contract naming an unknown id exits 2 at \`send\`, which reports a bad contract instead of a missing gate`,
        });
        sink.workers.push(worker);
        return;
      }
      // The mirror image of `missing` (Issue #125): a DEFINITION may not name an
      // id the worktree already declares. Upstream refuses it rather than letting
      // a contract silently redefine a gate, and the reason is worth repeating
      // here: the report would show the same id either way, so the substitution
      // would not be readable — a delegation could replace the repository's own
      // definition of "passing" and nothing downstream could tell.
      //
      // The reserved ids are refused by the planner and by `issueDefinedGates`
      // already; this is the collision that needs the worktree.
      const shadowed = definedGateIds(definedGates).filter((id) => known.has(id));
      if (shadowed.length > 0) {
        worker.note = redact(`#${number} was not dispatched: defined gate id(s) ${shadowed.join(', ')} already exist in the worktree`);
        report.limitations.push({
          code: 'acceptance_gate_id_conflict',
          detail: `#${number}: the issue's \`gates:\` block defines gate id(s) ${shadowed.join(', ')}, which ${VERIFY_CONFIG_RELATIVE} already declares. A contract may ADD gates, never redefine one — the report would print the same id for either definition, so a repository's own idea of "passing" could be replaced without that being readable anywhere. Rename the issue's gate (it is scoped to the issue: \`issue-${number}-<what-it-measures>\`), or drop the definition and \`require:\` the existing gate instead. The issue is NOT dispatched — the same contract exits 2 at \`send\``,
        });
        sink.workers.push(worker);
        return;
      }
      if (contractVerifyGates(inputs.verifyGates, requiredGates, definedGateIds(definedGates)).length > MAX_GATE_IDS) {
        worker.note = redact(`#${number} was not dispatched: the operator's --verify-gates and the issue's acceptance-gates block exceed the contract's ${MAX_GATE_IDS}-id bound`);
        report.limitations.push({
          code: 'acceptance_gate_block_invalid',
          detail: `#${number}: the union of --verify-gates and the issue's \`require:\` / \`gates:\` ids names more than ${MAX_GATE_IDS} gate ids, which CommandMate's contract parser rejects. Narrowing the union is not an option — it would drop a requirement one side declared, and a definition dropped from \`verify.gates\` is a contract error in its own right — so the issue is not dispatched. Reduce one of the two lists`,
        });
        sink.workers.push(worker);
        return;
      }
    }

    // The issue body's prohibitions (Issue #176), read once per issue and used by
    // BOTH task-text generators below, so the contract and the `<out>/prompts/`
    // artifact can never disagree about what the worker was told.
    //
    // Lazy, and called only from the two generators, because the limitation it
    // records claims the text reached a worker: an issue refused below (an empty
    // scope, an unplaceable contract) has no task text for a prohibition to be in,
    // and a run that says otherwise about an issue it never dispatched is the same
    // class of wrong statement this Issue is about.
    let constraints = null;
    const constraintsFor = () => {
      if (constraints !== null) return constraints;
      constraints = issueBodyConstraints(inputs, plan, res.issue);
      const note = constraintLimitation(number, constraints);
      if (note !== null) report.limitations.push(note);
      return constraints;
    };

    let contractPath = null;
    if (contractMode) {
      const scope = contractScopeReview(res.issue);
      const allow = scope.allow;
      // Issue #161 / #162, the human-present half. The unattended pre-flight
      // refuses on this before `--out` exists; here the wave is already
      // running, so the run continues with the narrowed scope — but it says
      // so. A silent truncation reads as "everything the issue declared is in
      // the contract", which is the one thing that is not true, and the plan
      // side already holds itself to the opposite rule (plan-contract.md
      // §5.1: what was added is always visible, and so is what was removed).
      // Recorded BEFORE the empty-scope limitation below, because when the
      // drop is what emptied the scope it is the explanation of it.
      if (scope.dropped.length > 0) {
        report.limitations.push({
          code: 'contract_scope_dropped',
          detail: `${contractScopeDroppedDetail(number, (res.issue.suspected_files ?? []).length, scope.dropped)}. `
            + (allow.length === 0
              ? 'Nothing was left to declare, so the issue is not dispatched (see contract_scope_unknown below)'
              : `The issue IS dispatched, under the ${allow.length} pattern(s) that survived — under --unattended the same finding stops the run in pre-flight instead`),
        });
      }
      if (allow.length === 0) {
        // Issue #50: an empty scope used to be dispatched with
        // `requireScopeClean: false`, which disabled the scope gate entirely —
        // so the issue whose files the planner could NOT name was the one
        // whose worker could write anything. Refusing here is the only reading
        // that is not a widening: the boundary was never declared, so nothing
        // is dispatched against it. Name the issue's 対象ファイル and re-plan.
        worker.note = redact(`#${number} was not dispatched: the plan declares no scope for it`);
        report.limitations.push({
          code: 'contract_scope_unknown',
          detail: `#${number}: the plan names no suspected file, so the contract would declare no scope; the issue is NOT dispatched (a scope-less contract would either disable the scope gate or reject every change). State the issue's target files and re-run the planner`,
        });
        sink.workers.push(worker);
        return;
      }
      try {
        contractPath = placeContract(res.worktreePath, number, buildTaskContract(plan, res.issue, inputs, requiredGates, inputs.workerMethod, constraintsFor(), definedGates), contractsDir);
      } catch (error) {
        worker.worker_state = 'failed';
        worker.note = redact(`could not place the execution contract in the worktree: ${error.message}`);
        sink.workers.push(worker);
        return;
      }
    }

    const promptFile = join(promptsDir, `issue-${number}.md`);
    // In contract mode the artifact is the goal — the body CommandMate sends
    // after its own preamble — so the file still shows what the worker read.
    const prompt = contractMode
      ? buildContractGoal(plan, res.issue, requiredGates, inputs.workerMethod, constraintsFor(), definedGates)
      : buildWorkerPrompt(plan, res.issue, inputs.workerMethod, constraintsFor());
    writeFileSync(promptFile, `${prompt}\n`, 'utf8');

    // The per-issue half of the evidence (ADR section 9): the Skill was found
    // in THIS worktree and the reference really went into the text this worker
    // is about to be sent. Recorded here rather than up front because up front
    // it would only repeat the declaration — this entry exists to say the
    // writing happened, for the issues where it happened.
    if (inputs.workerMethod !== null) {
      const probe = probeWorkerMethod(res.worktreePath, inputs.workerMethod);
      report.limitations.push({
        code: 'worker_method_applied',
        detail: redact(`#${number}: ${inputs.workerMethod} was found in this worktree (${probe.found.join(', ')}), and a \`## Method\` section naming it was written into ${contractMode ? "the execution contract's goal" : 'the worker prompt'}. `
          + '適用されたことは、守られたことではない — dispatch can see that the reference was written, not that the worker followed it; that evidence is the worker\'s own deliverable'),
      });
    }

    // The undo baseline (Issue #122 / ADR section 7.2), read HERE: after the
    // runner has decided to dispatch this issue and before the first message
    // reaches its worker, so the SHA really is the state the worker started
    // from. Only under `--unattended` — a run with a human present has a
    // person who can read `git reflog`, and this costs one `git rev-parse` per
    // issue that a run without the flag must not pay.
    if (inputs.unattended) {
      report.limitations.push(unattendedBaselineLimitation(res.issue, await worktreeHeadSha(inputs, res.worktreePath)));
    }

    sink.workers.push(worker);
    sink.supervisable.push({ worker, worktreeId: res.resolved.id, worktreePath: res.worktreePath, prompt, contractPath, issueGateIds: [...requiredGates, ...definedGateIds(definedGates)] });
  };

  // One worker's supervision, and the state updates that belong to it. Awaited as
  // a group by the wave loop and raced one at a time by the DAG scheduler; the
  // body is identical either way, which is the point of it being one function.
  const superviseOne = async ({ worker, worktreeId, worktreePath, prompt, contractPath, issueGateIds }) => {
    const supervised = contractMode
      ? await superviseWithContract(inputs, worktreeId, worktreePath, contractPath, issueGateIds)
      : await superviseUntilCommit(inputs, worktreeId, worktreePath, prompt);
    worker.worker_state = supervised.state;
    worker.note = redact(supervised.note);
    if (supervised.taskId) worker.task_id = supervised.taskId;
    if (supervised.verdict) contractVerdicts.set(worker.issue, supervised.verdict);
    if (supervised.notJudged) notJudged.add(worker.issue);
    // Only the workers whose wait really timed out carry this (Issue #179).
    // Its ABSENCE is a fact too — "no probe was made" — so it is never written
    // as an empty or null-filled object.
    if (supervised.liveness) worker.worker_liveness = supervised.liveness;
    // Only the workers that reached the --max-turns cap on exit 21 carry this
    // (Issue #220), and for the same reason: its ABSENCE means no collection was
    // made, which must never read as "there was nothing to find".
    if (supervised.turnEvidence) worker.worker_turn_evidence = supervised.turnEvidence;
    // Only the workers that stopped and reported after a nudge carry this (Issue
    // #287); absent means no report was read, not that the worker said nothing.
    if (supervised.workerReport) worker.worker_report = supervised.workerReport;
    if (supervised.autoResponded) autoResponded = true;
    if (supervised.scopeUnsatisfiable) scopeUnsatisfiable.set(worker.issue, supervised.scopeUnsatisfiable);
    if (sendTraces.has(worktreeId)) sendTraceByIssue.set(worker.issue, sendTraces.get(worktreeId));
    if (supervised.state === 'prompt') {
      worker.prompt = { detected: true, excerpt: supervised.promptExcerpt };
    }
  };

  // The fallback judge, as an ACTION: the profile baseline re-run INSIDE the same
  // worktree the supervisor drove (Issue #1473). Split out of the recording below
  // so the DAG scheduler can run it the moment a worker finishes.
  const runFallbackVerification = (worker) => {
    const worktreePath = worktreePaths.get(worker.issue) ?? safeWorktreeTarget(issueOf(plan, worker.issue).worktree ?? '');
    return verifyWorker(inputs, worktreePath, plan.profile.baseline);
  };

  // Step 5 for ONE worker: write down the verdict that judged it, through the one
  // function that also writes the sentence a human reads (Issue #83).
  //
  // Issue #83: this used to be wrapped in `if (allCompleted)`, which conflated the
  // GATE with the RECORDING. A wave where any one worker failed, timed out, raised
  // a prompt or was refused a dispatch skipped the body entirely, so every OTHER
  // worker of that wave kept the initialiser `{ran: false, outcome: 'not_run', …}`
  // — including workers whose `wait --verify` had already returned exit 0 and
  // whose note said so. merge/uat read exactly `worker_state === 'completed' &&
  // verification.outcome === 'pass'`, so verified deliverables silently left the
  // delivery path with the PR, CI, guarded-merge and UAT gates all bypassed rather
  // than failed. The verdict is now recorded for every worker that has one; no
  // barrier is decided here.
  //
  // `precomputed` is the fallback verification the DAG scheduler already ran (see
  // `fallbackVerdicts`), or null to run it here — which is what the wave loop
  // does, unchanged.
  const recordWorkerVerdict = (worker, precomputed = null) => {
    if (reverifying) {
      // The verdict already exists too, for the same reason: step 3b' ran the
      // gate. Recorded through the SAME function as every other verdict, so
      // the note a human reads is derived from the field merge reads — the #83
      // invariant holds on this path by construction. An issue step 3b' did
      // not re-judge has no entry here, and its transcribed record stands.
      const judged = reverifyVerdicts.get(worker.issue);
      if (judged) recordVerification(report, worker, judged.verdict, judged.source, inputs.unattended, unattributedPasses);
    } else if (contractMode) {
      // The verdict already exists: it is the exit code CommandMate returned
      // while the worker was supervised. Re-running anything here would be a
      // second opinion from a weaker judge.
      const verdict = contractVerdicts.get(worker.issue);
      if (verdict) {
        recordVerification(report, worker, {
          ran: verdict.ran,
          report_schema_version: null,
          outcome: verdict.outcome,
          gates: verdict.gates ?? [],
          checks: verdict.checks,
        }, 'contract', inputs.unattended, unattributedPasses);
      }
    } else if (worker.worker_state === 'completed') {
      // The fallback judge is an ACTION, not a stored verdict, so it runs for
      // the workers it can judge: the ones that completed. A failed or never
      // dispatched worker has no deliverable to re-run a baseline against.
      const verification = precomputed ?? runFallbackVerification(worker);
      recordVerification(report, worker, {
        ran: verification.ran,
        report_schema_version: null,
        outcome: verification.outcome,
        // The fallback judge is the baseline re-run: it has no contract
        // gates, and the commands it ran are already named in checks.
        gates: [],
        checks: verification.checks,
      }, 'baseline');
      if (verification.note) worker.note = worker.note ? `${worker.note}; ${verification.note}` : verification.note;
    }
    // A completed worker whose verdict was never recorded is the #83 defect
    // itself. It is reported rather than passed over in silence: the note says
    // so, a limitation names it, and the completion check below fails.
    if (worker.worker_state === 'completed' && !worker.verification.ran) {
      verificationUnrecorded.add(worker.issue);
      report.limitations.push({
        code: 'verification_unrecorded',
        detail: `#${worker.issue} completed but no verification verdict was recorded for it, so its verification.outcome stays not_run and merge/uat will not treat it as eligible; this is a runner defect, not a worker one`,
      });
      worker.note = appendNote(worker.note, 'verification was NEVER RECORDED for this completed worker (outcome not_run)');
    }
  };

  // The L4 finding, named in the report (ADR sections 6 and 9 / Issue #148).
  // The VIOLATING PATHS are carried verbatim, because they are the whole
  // actionable content: they are what has to be added to the Issue's 対象ファイル
  // (or declared as a repo convention) before this plan can succeed, and an
  // operator who only reads the report has nowhere else to get them.
  //
  // Verbatim, but bounded: a repo-wide accident can name hundreds of paths, and
  // a detail that long stops being read. The list is cut to the same display
  // bound the re-instruction uses and the cut is stated with its count and with
  // how many the guard actually compared (Issue #164) — merge.mjs's
  // `capped()` / `droppedNote()` rule, so a shortened list never passes for a
  // complete one.
  const recordScopeAndLivenessReasons = (workers) => {
    for (const worker of workers) {
      const cut = scopeUnsatisfiable.get(worker.issue);
      if (!cut) continue;
      const shownPaths = cut.violations.slice(0, MAX_SCOPE_VIOLATION_LINES);
      const droppedPaths = cut.violations.length - shownPaths.length;
      report.blocking_reasons.push({
        code: 'scope_unsatisfiable',
        detail: redact(`#${worker.issue}: the scope gate named the SAME violating path(s) on two consecutive turns, so the re-instruction loop was not converging and supervision `
          + `stopped after ${cut.turns} turn(s) rather than spending the rest of --max-turns ${inputs.maxTurns} on the same answer. `
          + 'The contract\'s `scope.allow` is a snapshot of the Issue\'s 対象ファイル taken when the contract was sent, so a worker cannot widen it from inside the worktree — '
          + 'when the violating change is unavoidable, the fix is in the Issue, not in the worktree. '
          + `Violating path(s), transcribed from the scope gate: ${shownPaths.join(' | ')}`
          + (droppedPaths > 0
            ? ` (+${droppedPaths} more line(s) not listed here; this detail is cut to ${MAX_SCOPE_VIOLATION_LINES} line(s) — the loop guard compared all ${cut.violations.length}, and \`commandmate verify <worktree-id>\` prints the rest)`
            : '')
          + '. '
          + 'The verdict is untouched: verification really did fail, and that is CommandMate\'s exit code to give — what this stops is the run going further'),
      });
    }

    // The send side (CommandMate#3006 / #3007), in `workers` order for the same
    // reason as everything in this pass. A stale question that stopped the send
    // is a blocking reason — it is why this worker never started; one that was
    // interrupted, and every not-ready retry, is a limitation: the run went on,
    // and the report still has to say it did so by acting on the session.
    for (const worker of workers) {
      const trace = sendTraceByIssue.get(worker.issue);
      if (!trace) continue;
      if (trace.stalePrompt && trace.stalePrompt.action === 'interrupted') {
        report.limitations.push(stalePromptInterruptedLimitation(worker.issue, trace.stalePrompt));
      } else if (trace.stalePrompt) {
        report.blocking_reasons.push(stalePromptBlockingReason(worker.issue, trace.stalePrompt));
      }
      for (const entry of trace.notReadyRetries) report.limitations.push(notReadyRetryLimitation(worker.issue, entry));
    }

    // The liveness of every worker whose `commandmate wait` timed out (Issue
    // #179), read out of the record the supervision wrote. In `workers` order
    // and outside the concurrent loop, for the reason above: an entry pushed
    // from inside the supervision would order the report by whichever worker
    // finished first, and two runs of the same plan could differ. Under
    // `--schedule dag` that hazard is larger, not smaller — workers no longer
    // even finish within one group — which is why this pass runs over the whole
    // run's workers, in plan order, once supervision has joined.
    //
    // Recorded as its own blocking reason BESIDE the existing `worker_timeout`
    // rather than in place of it. `worker_timeout` answers "why did the run
    // stop" and has not changed meaning; this answers "what kind of timeout was
    // it", which is the question an operator could not answer from the report at
    // all. Whether the halt ladder below even reaches `worker_timeout` (a prompt
    // or an exit 99 elsewhere outranks it) does not change the fact this
    // measured, so it is written here and not there.
    for (const worker of workers) {
      const liveness = worker.worker_liveness;
      if (!liveness) continue;
      report.blocking_reasons.push({
        code: liveness.code,
        detail: redact(`#${worker.issue}: ${liveness.detail}`),
      });
    }

    // The same pass, for the same reason, over the --max-turns cap (Issue #220).
    // Written BESIDE the existing `worker_failed` rather than in place of it:
    // `worker_failed` answers "why did the run stop" and has not changed meaning,
    // while this answers "why is there nothing", which is the question whose two
    // answers demand opposite recoveries. In `workers` order and outside the
    // concurrent loop, so two runs of the same plan order it the same way.
    for (const worker of workers) {
      const evidence = worker.worker_turn_evidence;
      if (!evidence) continue;
      report.blocking_reasons.push({
        code: evidence.code,
        detail: redact(`#${worker.issue}: ${evidence.detail}`),
      });
    }

    // And for a worker that stopped and reported (Issue #287): beside
    // `worker_failed`, for the reason #220 gave — that code says why the run
    // stopped, this one says what the worker said.
    for (const worker of workers) {
      const workerReport = worker.worker_report;
      if (!workerReport) continue;
      report.blocking_reasons.push({
        code: WORKER_STOPPED_WITH_REPORT,
        detail: redact(workerReportBlockingDetail(worker.issue, workerReport)),
      });
    }
  };

  for (let waveIndex = 0; inputs.schedule !== 'dag' && waveIndex < plan.waves.length && !stopped; waveIndex += 1) {
    // The budget, checked before a wave is STARTED as well as between turns
    // (Issue #122 / ADR section 14.2): a wave is the largest mutating unit this
    // runner has, and starting one it cannot finish inside the budget is how a
    // run ends with workers nobody ever came back for.
    if (wallClockExhausted()) {
      halt('partial', 'timeout', 'wall_clock_budget_exhausted',
        `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted before wave ${waveIndex + 1} was dispatched; `
          + 'the remaining waves were not started. This is a stop, not a success: re-run with --resume once the cause of the slowness is understood');
      break;
    }
    const waveIssues = plan.waves[waveIndex];
    // 0. The resume split (Issue #98), before anything is probed. The issues a
    //    prior attempt completed AND verified are not dispatched again; their
    //    records join this wave as they stand, so the barrier below is computed
    //    over BOTH halves. That is what RECOMPUTES the barrier rather than
    //    replaying it: a wave whose issues were all carried dispatches nothing
    //    and advances at once, which is how an issue whose dependency already
    //    passed reaches a worker without waiting behind one.
    const carriedWorkers = resume === null
      ? []
      : waveIssues.filter((number) => resume.carried.has(number)).map((number) => resume.carried.get(number));
    const pending = resume === null ? waveIssues : resume.waveDispatch[waveIndex];

    // Guarded on `resume` rather than on emptiness alone: validatePlan already
    // refuses an empty wave, and an ordinary run that somehow reached one must
    // keep falling through to the barrier (which fails on zero workers) instead
    // of advancing past a wave nobody dispatched.
    if (resume !== null && pending.length === 0) {
      report.waves.push({
        index: waveIndex,
        dispatched: [],
        workers: carriedWorkers,
        // Every worker of this wave is a carried `completed` + `pass`, so both
        // halves of the barrier hold and the next wave may dispatch. Nothing was
        // sent and nothing mutated, which is also why no drift re-check ran for
        // it: there was no mutation for a drift check to guard.
        barrier: { all_workers_completed: true, all_verifications_passed: true, advanced: true },
      });
      continue;
    }

    // 1. max_parallel guard (belt-and-braces; validatePlan already refused a
    //    wider wave, but the runner never dispatches beyond the bound).
    const toDispatch = pending.slice(0, plan.max_parallel);
    if (pending.length > plan.max_parallel) {
      parallelismBounded = false;
      report.limitations.push({ code: 'parallelism_truncated', detail: `wave ${waveIndex} had ${pending.length} issues; capped at ${plan.max_parallel}` });
    }

    // Resolve each issue's CommandMate worktree ONCE, up front (see
    // `resolveWave`). The first dispatching wave was already resolved and
    // drift-checked by the pre-flight, whose result is reused here so the CLI is
    // not probed twice.
    const preflighted = preflight !== null && preflight.waveIndex === waveIndex;
    const resolutions = preflighted ? preflight.resolutions : resolveWave(inputs, plan, toDispatch);

    // 2. Drift re-check before this (mutating) wave.
    const drift = preflighted ? preflight : driftChecks(inputs, plan, waveIndex, resolutions);
    const checks = drift.checks;
    if (!preflighted) report.drift_checks.push(...checks);
    for (const check of checks) {
      if (!check.ok && !check.blocking) {
        report.limitations.push({ code: `drift_${check.code}`, detail: check.detail });
      }
    }
    const blockingDrift = checks.find((check) => check.blocking && !check.ok);
    if (blockingDrift) {
      // The carried workers of this wave are still recorded: they are facts a
      // prior attempt established, and drift found now does not un-verify work
      // that was already judged (Issue #98).
      const waveRecord = { index: waveIndex, dispatched: [], workers: carriedWorkers, barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false } };
      report.waves.push(waveRecord);
      // Drift before the very first wave means nothing was dispatched at all.
      // (Wave 0 never reaches this: the pre-flight already refused the run
      // before the run directory existed.)
      const status = waveIndex === 0 ? 'failure' : 'partial';
      const reasons = blockingDrift.code === 'worktrees_present' && drift.unresolved.length > 0
        ? worktreeUnresolvedReasons(drift.unresolved)
        : [{ code: `drift_${blockingDrift.code}`, detail: blockingDrift.detail }];
      haltWith(status, 'drift', reasons);
      break;
    }

    // 2b. The worker-method probe for a wave the pre-flight did not cover
    //     (Issue #128 / ADR section 3.4). Wave 0 was probed before the run
    //     directory existed; a later wave is probed HERE, at the moment its
    //     worktrees resolve, for the same reason #93 re-checks worktrees per
    //     wave: a worktree can be created, moved or emptied while an earlier
    //     wave was running. All-or-nothing, like the drift block above — the
    //     wave stops rather than dispatching the subset that happens to be
    //     equipped.
    const methodMissing = preflighted ? [] : workerMethodUnavailable(inputs, resolutions);
    if (methodMissing.length > 0) {
      report.waves.push({
        index: waveIndex,
        dispatched: [],
        workers: carriedWorkers,
        barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
      });
      haltWith(waveIndex === 0 ? 'failure' : 'partial', 'dispatch_error',
        workerMethodUnavailableReasons(methodMissing, inputs.workerMethod));
      break;
    }

    // 3a. Prepare every issue in the wave (sequential, cheap): build its worker
    //     record, take its already-resolved worktree id/path, and write its prompt
    //     artifact. `worktreePaths` remembers the git path per issue so the
    //     verification gate reuses the exact same worktree the supervisor drove
    //     (Issue #1473). Workers that cannot be dispatched (unsafe target /
    //     unresolved worktree) are recorded terminal here and never supervised.
    // Seeded with this wave's carried records (empty on an ordinary run), so the
    // barrier and the verification loop below see one wave, not two halves.
    const workers = [...carriedWorkers];
    const supervisable = [];
    // The reverify counterpart of `supervisable` (Issue #121): the not-carried
    // issues of this wave whose worktree resolved. Whether each of them is
    // actually re-judged is decided in step 3b, by the work-evidence
    // measurement — not here, and never from the prior report's worker_state.
    const reverifiable = [];
    // Issues whose worktree the CLI could not resolve at dispatch time, in wave
    // order. The drift re-check above passed, so this is the narrow window it
    // cannot cover: a worktree registered in `git worktree list` but not with
    // CommandMate, or one that disappeared between the pre-flight and now. Kept
    // apart from the other failures because the cause and the fix are different
    // (create the worktree — the worker never started), Issue #90.
    const unresolvedWorktrees = [];
    const sink = { workers, supervisable, reverifiable, unresolvedWorktrees };
    for (const number of toDispatch) {
      await prepareIssue(resolutions.find((r) => r.number === number), sink);
    }

    // 3b. Supervise the wave's workers CONCURRENTLY (Issue #1474). Each worker
    //     runs its own send -> wait -> commit-check -> nudge loop; because
    //     `commandmate wait` blocks until its worker idles, running them in
    //     parallel (the wave width is already <= max_parallel, so the runtime
    //     parallelism matches the plan bound) makes the wave take the slowest
    //     single worker instead of the sum. Each worker's commit detection,
    //     --max-turns, prompt handling and auto-yes respond stay strictly
    //     independent; the wave barrier below is unchanged.
    await Promise.all(supervisable.map((entry) => superviseOne(entry)));

    recordScopeAndLivenessReasons(workers);

    // 3b'. The reverify pass (Issue #121), in the place of the supervision loop
    //      and never beside it: `reverifiable` is empty on every other run, and
    //      `supervisable` is empty on a reverify. Two steps per issue, in this
    //      order and no other:
    //
    //        1. MEASURE whether the worktree holds work — the work-evidence
    //           criterion, with git, before anything is judged. An issue that
    //           holds none is not re-judged at all: asking the gate would turn
    //           "nobody worked here" into a verdict (exit 21 is `fail`) and
    //           downgrade a record on the strength of a run this flag exists to
    //           avoid making.
    //        2. JUDGE the ones that do, with the same instrument the ordinary
    //           path uses in the same mode.
    //
    //      Concurrent for the same reason the supervision loop is: a gate run is
    //      the slow part, the wave width is already <= max_parallel, and one
    //      issue's gates must not wait behind another's.
    //
    //      `--verify-concurrency` (Issue #274) narrows that to n at a time, taken
    //      in plan order; without it every issue starts at once, as before.
    await forEachLimited(reverifiable, inputs.verifyConcurrency, async ({ worker, worktreeId, worktreePath, issueGateIds }) => {
      // A pending prompt is a worker still mid-turn, waiting for a human. The
      // tree under it is being changed by somebody who has not finished, so a
      // verdict about it would describe a state that is not a deliverable — and
      // promoting the issue to `completed` would quietly take the human out of
      // the loop this runner exists to keep them in.
      if (worker.worker_state === 'prompt') {
        report.limitations.push({
          code: 'reverify_prompt_pending',
          detail: `#${worker.issue} was NOT re-judged: its prior attempt stopped on a worker prompt that is still pending. A prompt is a worker mid-turn `
            + 'waiting for a human, so the worktree is not a finished deliverable and judging it would describe a state nobody delivered. Answer the prompt '
            + '(or re-dispatch the issue with --resume), then re-judge',
        });
        worker.note = appendNote(worker.note, 'not re-judged by this --reverify attempt: a worker prompt is still pending');
        return;
      }
      const evidence = await workEvidence(inputs, plan, worktreePath);
      if (!evidence.present) {
        report.limitations.push(evidence.unreadable
          ? {
            code: 'reverify_evidence_unreadable',
            detail: `#${worker.issue} was NOT re-judged: this runner could not read whether its worktree holds work (${workEvidenceDetail(evidence)}). `
              + '"We could not look" is not "there is nothing there", so the prior record is transcribed unchanged rather than re-judged against a tree nobody measured',
          }
          : {
            code: 'reverify_no_work_evidence',
            detail: `#${worker.issue} was NOT re-judged: its worktree holds no work evidence (${workEvidenceDetail(evidence)}) — the same two facts CommandMate's `
              + 'work-evidence gate counts. --reverify re-judges work that is already there; an issue with nothing there needs a worker, not a verdict, so its prior '
              + 'record is transcribed unchanged. Use --resume to dispatch it',
          });
        worker.note = appendNote(worker.note, evidence.unreadable
          ? 'not re-judged by this --reverify attempt: the work evidence in its worktree could not be read'
          : 'not re-judged by this --reverify attempt: its worktree holds no work evidence (no commit, no uncommitted change)');
        return;
      }
      const judged = await reverifyWorker(inputs, plan, contractMode, worktreeId, worktreePath, issueGateIds);
      if (judged.workEvidenceDisagreed) {
        report.limitations.push({
          code: 'reverify_evidence_disagreement',
          detail: `#${worker.issue}: git says the worktree holds work (${workEvidenceDetail(evidence)}) but the verification run's own work-evidence gate found none `
            + `(exit ${VERIFY_EXIT_NOT_STARTED}). The gate's verdict stands — this runner does not overrule the judge — but the two disagree, which usually means the `
            + 'work is on a different branch than the one the plan names, or the gate counts a different range',
        });
      }
      // Completion is what it has always been: a COMMIT on the work branch
      // (#1468). The verdict does not decide it and never has — the two are
      // separate facts and the barrier reads them separately. Work that is only
      // in the working tree is left at its prior state on purpose: nothing
      // downstream can deliver an uncommitted change, and this flag cannot ask
      // for the commit, because asking is sending.
      if (evidence.commits !== null && evidence.commits > 0) {
        worker.worker_state = 'completed';
        worker.note = appendNote(worker.note,
          `re-judged in place by --reverify (nothing was sent); ${workEvidenceDetail(evidence)}`);
      } else {
        worker.note = appendNote(worker.note,
          `re-judged in place by --reverify (nothing was sent), but the work is NOT committed, so this issue is not a deliverable and its worker_state stays "${worker.worker_state}"; ${workEvidenceDetail(evidence)}`);
      }
      if (judged.note) worker.note = appendNote(worker.note, redact(judged.note));
      if (judged.notJudged) notJudged.add(worker.issue);
      if (judged.verdict === null) {
        // Infrastructure, not a verdict: the prior record stands untouched.
        report.limitations.push({
          code: 'reverify_judge_unavailable',
          detail: `#${worker.issue}: the verification could not be run against its worktree, so NO verdict was recorded and the prior attempt's record stands as it was. `
            + 'This is an infrastructure failure of this attempt, not a finding about the work',
        });
        return;
      }
      reverifyVerdicts.set(worker.issue, judged);
    });

    // 4. Wave barrier — every dispatched worker must have completed.
    const allCompleted = workers.length > 0 && workers.every((worker) => worker.worker_state === 'completed');

    // 5. Verification gate — only completed workers are verified, and every one
    //    must pass its profile baseline (re-run inside the worktree). Worker
    //    completion alone does not open this gate. Verification cwd's into the
    //    SAME worktree path the supervisor drove — the `commandmate ls` path, not
    //    the plan template — so a completed worker is never false-failed on a git
    //    path the send target never used (Issue #1473).
    //
    //    Issue #83: this loop used to be wrapped in `if (allCompleted)`, which
    //    conflated the GATE with the RECORDING. A wave where any one worker
    //    failed, timed out, raised a prompt or was refused a dispatch skipped the
    //    body entirely, so every OTHER worker of that wave kept the initialiser
    //    `{ran: false, outcome: 'not_run', gates: [], checks: []}` — including
    //    workers whose `wait --verify` had already returned exit 0 and whose note
    //    said so. merge/uat read exactly `worker_state === 'completed' &&
    //    verification.outcome === 'pass'`, so verified deliverables silently left
    //    the delivery path (`no_eligible_issues`) with the PR, CI, guarded-merge
    //    and UAT gates all bypassed rather than failed. The verdict is now
    //    recorded for every worker that has one; the barrier below is unchanged,
    //    because `allVerified` still starts at `allCompleted` and this loop can
    //    only ever clear it.
    let allVerified = allCompleted;
    for (const worker of workers) {
      // A carried worker was judged by the attempt that dispatched it, and this
      // attempt sent it nothing. Re-running the fallback baseline against its
      // worktree here would be a SECOND, weaker opinion about work a contract
      // gate already passed — and would fail outright once the branch is merged
      // and the worktree removed (Issue #98). Its transcribed verdict still
      // counts towards the barrier, in the `allVerified` line at the bottom.
      if (resume !== null && resume.carried.has(worker.issue)) {
        if (worker.verification.outcome !== 'pass') allVerified = false;
        continue;
      }
      recordWorkerVerdict(worker);
      if (worker.verification.outcome !== 'pass') allVerified = false;
    }

    const advanced = allCompleted && allVerified;
    const waveRecord = {
      index: waveIndex,
      // `dispatched` means "issues actually sent in this wave" (schema). A
      // reverify sends nothing, so the honest value is the empty list — and the
      // list being empty while `workers` is not is exactly the claim the flag
      // makes. Which issues it re-judged is in the `reverify_attempt` limitation,
      // in each worker's note, and in the ledger's `reverified`.
      dispatched: reverifying ? [] : toDispatch.slice(),
      workers,
      barrier: { all_workers_completed: allCompleted, all_verifications_passed: allVerified, advanced },
    };
    report.waves.push(waveRecord);

    // 6. Decide whether the loop may continue to the next wave. `advanced` is
    //    `allCompleted && allVerified`, so a non-advanced wave halts the loop
    //    here — the barrier and the verification gate are enforced by that break.
    if (!advanced) {
      const prompted = workers.find((worker) => worker.prompt.detected && worker.worker_state === 'prompt');
      const unjudged = workers.find((worker) => notJudged.has(worker.issue));
      if (prompted) {
        report.human_required = true;
        halt('partial', 'human_required', 'human_input_required', `#${prompted.issue} raised a prompt; halted for a human (no auto-response)`);
      } else if (unjudged) {
        // Ranked above worker_failed and verification_failed on purpose: 99 is
        // "nothing judged this", which no amount of re-dispatching can resolve.
        report.human_required = true;
        halt('partial', 'dispatch_error', 'verification_not_judged',
          `#${unjudged.issue}: verification exited ${VERIFY_EXIT_NO_VERDICT} — the run ended error/cancelled, so no gate judged the work. Halted for a human; not re-instructed as a verification failure (exit ${VERIFY_EXIT_FAILED}) and not rounded to a pass`);
      } else if (wallClockExhausted()) {
        // Ranked below the two human_required stops and above everything else
        // (Issue #122). A worker abandoned because the clock ran out looks like
        // `failed`/`timeout` from the inside, and reporting it as a worker
        // failure would send the operator into a worktree to debug a worker that
        // was doing nothing wrong. Ranked below the prompt and the 99 because
        // those two are findings the run really made and re-running cannot
        // resolve, while this one says only "there was not enough time".
        // `timeout` is reused rather than a new stop_reason value invented: the
        // enum is a schema-versioned closed set (ADR section 11).
        halt('partial', 'timeout', 'wall_clock_budget_exhausted',
          `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted during wave ${waveIndex + 1}; the workers of this wave were left mid-supervision `
            + 'and the next wave was not dispatched. The worktree branches are where their workers left them (the unattended_baseline limitation records where each one started)');
      } else if (unresolvedWorktrees.length > 0) {
        // Ranked above worker_failed (Issue #90). Both are `worker_state:
        // 'failed'`, but they are opposite findings: worker_failed means a
        // worker ran and did not finish (read its log, split the issue), while
        // this means NO worker was ever started because there was nothing to
        // send to. Reporting the generic code sent operators to re-plan an issue
        // whose only defect was a missing worktree.
        haltWith('partial', 'drift', worktreeUnresolvedReasons(unresolvedWorktrees));
      } else if (workers.some((worker) => worker.worker_state === 'failed')) {
        const failed = workers.find((worker) => worker.worker_state === 'failed');
        halt('partial', 'worker_failed', 'worker_failed', `#${failed.issue} did not complete; the next wave was not dispatched`);
      } else if (workers.some((worker) => worker.worker_state === 'timeout')) {
        const timed = workers.find((worker) => worker.worker_state === 'timeout');
        halt('partial', 'timeout', 'worker_timeout', `#${timed.issue} timed out; the next wave was not dispatched`);
      } else if (workers.some((worker) => worker.worker_state === 'not_dispatched')) {
        // A worker the runner REFUSED to start — no declared scope (Issue #50),
        // an unsafe worktree target — never ran, so it cannot be a verification
        // failure. Saying it was would name the wrong cause and send the
        // operator into a worktree to debug a plan-level defect.
        const skipped = workers.find((worker) => worker.worker_state === 'not_dispatched');
        halt('partial', 'dispatch_error', 'not_dispatched', `#${skipped.issue} was never dispatched: ${skipped.note || 'the runner refused to start it'}`);
      } else if (!allVerified) {
        const failedVerify = workers.find((worker) => worker.verification.outcome !== 'pass');
        halt('partial', 'verification_failed', 'verification_failed', `#${failedVerify.issue} completed but its verification did not pass; the next wave was not dispatched`);
      } else {
        halt('partial', 'dispatch_error', 'wave_not_advanced', `wave ${waveIndex} did not advance`);
      }
      break;
    }

    // The stage-C stop (Issue #142 / ADR sections 6.5, 8). Placed AFTER the
    // ranking above, deliberately: every stop in that chain is a finding this
    // run really made about a worker, and this one is a finding about what the
    // report can SHOW. When both hold, the worker-level cause is the one an
    // operator acts on first, and the promoted reason is in `blocking_reasons`
    // either way (`recordVerification` wrote it when it happened, not here), so
    // ranking it last loses nothing.
    //
    // The wave DID advance: `barrier.advanced` stays true, because the barrier
    // measures completion and verification and both held. What stops the run is
    // that the next wave would be dispatched on top of a pass nobody can attribute.
    if (unattributedPasses.size > 0) {
      report.status = 'partial';
      report.stop_reason = 'dispatch_error';
      stopped = true;
      break;
    }
  }

  // ===========================================================================
  // The DAG scheduler (`--schedule dag`, Issue #183)
  // ===========================================================================
  //
  // The same steps the wave loop runs, in the same order, over a different unit:
  // an ADMISSION ROUND instead of a wave. A round is "every issue that became
  // ready since the last decision, up to the free slots", and rounds overlap in
  // time — the loop admits, then waits for the FIRST worker to finish rather than
  // for all of them, which is the whole of the change.
  //
  // Determinism is not a side effect here, it is a design constraint: workers
  // finish in whatever order the world produces, so nothing that lands in the
  // report may be written from inside a completion. Everything ordered — the
  // scope/liveness reasons, the verdict recording, the blocked-issue reasons —
  // runs once at the end, in plan order. What DOES have to happen at completion
  // time is the fallback verification, because nothing downstream can be admitted
  // until its verdict exists; that action is run there and recorded here.
  if (inputs.schedule === 'dag' && !stopped && !nothingToDispatch) {
    const { edges: dagEdges, lexical } = effectiveDependencies(plan);
    if (lexical.length > 0) {
      report.limitations.push({
        code: 'schedule_dag_lexical_edge_ignored',
        detail: `${lexical.length} dependency edge(s) in this plan carry \`basis: lexical\` (${lexical.map((edge) => `#${edge.issue}→#${edge.depends_on}`).join(', ')}) and were NOT used as ready gates. `
          + 'Issue #182 decided that an inference from shared vocabulary alone is not an edge — the planner raises `unconfirmed_lexical_dependency` on the consumer and '
          + 'emits no edge — so a plan that carries one was written by an older runner or edited by hand. Honouring it here would re-serialise exactly the run #182 '
          + 'un-serialised; the ordering it asked for was never grounded in a file or in a statement. Re-run the planner if the ordering is real, and state it in the issue body',
      });
    }
    const declaredFiles = declaredFilesByIssue(plan);
    // The plan's own wave flattening — which is `merge_order` — is the admission
    // order. It is a topological order of the full edge set (planWaves only puts
    // an issue in a wave once every dependency is in an earlier one), so it is a
    // topological order of the effective subset too, and it is what makes "the
    // first ready issue" mean the same thing on every run of the same plan.
    const order = plan.waves.flat();
    // Issues whose record says "completed AND verification pass". A carried issue
    // (`--resume`) joins as satisfied: a prior attempt already established it.
    const satisfied = new Set();
    // Issues that reached a terminal state that is NOT green, plus the ones that
    // were never started because of one. Downstream of these nothing is admitted.
    const unsatisfiable = new Set();
    const blockedBy = new Map();
    const pending = new Set(order);
    const workerOf = new Map();
    const dispatchedIssues = new Set();
    const groupEntries = [];
    const running = new Map();
    // Issues whose worktree the CLI could not resolve at dispatch time (Issue
    // #90), run-wide rather than per-group: a round is not a unit an operator
    // acts on, and the fix — create the worktree — is the same whenever it was
    // found.
    const dagUnresolved = [];
    let haltAdmission = false;

    if (resume !== null) {
      const carried = order.filter((number) => resume.carried.has(number));
      for (const number of carried) {
        satisfied.add(number);
        pending.delete(number);
      }
      if (carried.length > 0) {
        // Nothing was sent and nothing mutated, which is also why no drift
        // re-check ran for it: there was no mutation for a drift check to guard.
        report.waves.push({
          index: report.waves.length,
          dispatched: [],
          workers: carried.map((number) => resume.carried.get(number)),
          barrier: { all_workers_completed: true, all_verifications_passed: true, advanced: true },
        });
      }
    }

    const ready = (number) => [...(dagEdges.get(number) ?? [])].every((dep) => satisfied.has(dep));
    const overlapsAny = (number, others) => others.some((other) => sharesDeclaredFile(declaredFiles, number, other));
    // A finished worker is GREEN when both halves of the old barrier hold for it
    // alone: it committed, and its verdict is a pass. Read here rather than from
    // `worker.verification`, because the recording happens at the end of the run.
    const isGreen = (worker) => {
      if (worker.worker_state !== 'completed') return false;
      if (notJudged.has(worker.issue)) return false;
      const verdict = contractMode ? contractVerdicts.get(worker.issue) : fallbackVerdicts.get(worker.issue);
      return verdict !== undefined && verdict.outcome === 'pass';
    };

    // One admission round: the wave loop's steps 1-3a for the issues admitted now.
    // Returns false when it halted the run.
    const admitRound = async (roundIndex, numbers) => {
      // The pre-flight already resolved and drift-checked the first group this
      // run dispatches (Issue #90), and round 0 admits exactly the set it probed
      // — the admission rule below is the planner's wave-packing rule, so the
      // first round IS `plan.waves[0]` (or, on a resume, the first wave with work
      // left). Reused rather than probed twice; if the two disagree the world is
      // probed again rather than assumed.
      const preflighted = roundIndex === 0 && preflight !== null
        && preflight.resolutions.length === numbers.length
        && preflight.resolutions.every((entry) => numbers.includes(entry.number));
      const resolutions = preflighted ? preflight.resolutions : resolveWave(inputs, plan, numbers);

      const drift = preflighted ? preflight : driftChecks(inputs, plan, roundIndex, resolutions);
      if (!preflighted) report.drift_checks.push(...drift.checks);
      for (const check of drift.checks) {
        if (!check.ok && !check.blocking) {
          report.limitations.push({ code: `drift_${check.code}`, detail: check.detail });
        }
      }
      const blockingDrift = drift.checks.find((check) => check.blocking && !check.ok);
      if (blockingDrift) {
        report.waves.push({
          index: report.waves.length,
          dispatched: [],
          workers: [],
          barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
        });
        const reasons = blockingDrift.code === 'worktrees_present' && drift.unresolved.length > 0
          ? worktreeUnresolvedReasons(drift.unresolved)
          : [{ code: `drift_${blockingDrift.code}`, detail: blockingDrift.detail }];
        haltWith(roundIndex === 0 ? 'failure' : 'partial', 'drift', reasons);
        return false;
      }

      const methodMissing = preflighted ? [] : workerMethodUnavailable(inputs, resolutions);
      if (methodMissing.length > 0) {
        report.waves.push({
          index: report.waves.length,
          dispatched: [],
          workers: [],
          barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
        });
        haltWith(roundIndex === 0 ? 'failure' : 'partial', 'dispatch_error',
          workerMethodUnavailableReasons(methodMissing, inputs.workerMethod));
        return false;
      }

      const groupWorkers = [];
      const sink = { workers: groupWorkers, supervisable: [], reverifiable: [], unresolvedWorktrees: dagUnresolved };
      for (const number of numbers) {
        await prepareIssue(resolutions.find((entry) => entry.number === number), sink);
      }
      const entry = {
        index: report.waves.length,
        dispatched: numbers.slice(),
        workers: groupWorkers,
        // Recomputed once every worker of this round is terminal. In this mode it
        // gates nothing — what released each downstream issue is its own
        // dependency's record — but the two facts are still true of this group and
        // are still what merge/uat and status read a group by.
        barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
      };
      report.waves.push(entry);
      groupEntries.push(entry);

      const started = new Set(sink.supervisable.map((item) => item.worker.issue));
      for (const worker of groupWorkers) {
        workerOf.set(worker.issue, worker);
        dispatchedIssues.add(worker.issue);
        pending.delete(worker.issue);
        // A worker the preparation REFUSED never runs, so it is terminal now —
        // and it is not green, so nothing downstream of it may be admitted.
        if (!started.has(worker.issue)) unsatisfiable.add(worker.issue);
      }
      for (const item of sink.supervisable) {
        const issue = item.worker.issue;
        running.set(issue, superviseOne(item).then(() => issue, () => issue));
      }
      return true;
    };

    // What a settled worker changes: whether its downstream may go, and — under
    // `--unattended` — whether anything may go at all.
    const harvest = (issue) => {
      const worker = workerOf.get(issue);
      if (!worker) return;
      if (!contractMode && !reverifying && worker.worker_state === 'completed') {
        fallbackVerdicts.set(issue, runFallbackVerification(worker));
      }
      if (isGreen(worker)) {
        satisfied.add(issue);
      } else {
        unsatisfiable.add(issue);
        // The safe side, and the one the Issue asked for explicitly: with a human
        // present a failure stops only its DOWNSTREAM, because the independent
        // series are unaffected facts and stopping them wastes the run. With
        // nobody present the run stops admitting entirely — the same thing the
        // wave barrier did, kept for the same reason `--unattended` keeps every
        // other tightening: nobody is here to read a report and decide that the
        // other half is worth continuing.
        if (inputs.unattended) haltAdmission = true;
      }
      // The stage-C stop (Issue #142), read at the moment it becomes true rather
      // than after the whole run: an unattributed pass under `--unattended` is a
      // pass nobody can name the gates of, and admitting more work on top of it is
      // exactly what the wave loop refuses to do. The verdict itself is untouched
      // (it is an exit code and it stands); `recordVerification` writes the
      // blocking reason during the recording pass below.
      if (inputs.unattended && contractMode) {
        const verdict = contractVerdicts.get(issue);
        if (verdict && verdict.outcome === 'pass' && (verdict.gates ?? []).length === 0) haltAdmission = true;
      }
    };

    let roundIndex = 0;
    for (;;) {
      // 1. Propagate unsatisfiability down the graph, in topological order, so one
      //    pass reaches every transitively blocked issue.
      for (const number of order) {
        if (!pending.has(number)) continue;
        const upstream = [...(dagEdges.get(number) ?? [])].filter((dep) => unsatisfiable.has(dep)).sort((a, b) => a - b);
        if (upstream.length === 0) continue;
        pending.delete(number);
        unsatisfiable.add(number);
        blockedBy.set(number, upstream);
      }

      // 2. Fill the free slots, in plan order. `--max-parallel` is read as what it
      //    already meant — the number of workers this run may drive at once — and
      //    the file-overlap rule the planner enforced by packing is enforced here
      //    against BOTH the running set and the rest of this admission.
      const admitted = [];
      if (!stopped && !haltAdmission) {
        const free = plan.max_parallel - running.size;
        for (const number of order) {
          if (admitted.length >= free) break;
          if (!pending.has(number)) continue;
          if (!ready(number)) continue;
          if (overlapsAny(number, [...running.keys()])) continue;
          if (overlapsAny(number, admitted)) continue;
          admitted.push(number);
        }
      }

      if (admitted.length > 0) {
        // The budget, checked before a group is STARTED as well as between turns
        // (Issue #122 / ADR section 14.2): starting work this run cannot finish
        // inside the budget is how a run ends with workers nobody came back for.
        if (wallClockExhausted()) {
          halt('partial', 'timeout', 'wall_clock_budget_exhausted',
            `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted before admission round ${roundIndex + 1} was dispatched; `
              + `the remaining issue(s) were not started. This is a stop, not a success: re-run with --resume once the cause of the slowness is understood`);
        } else if (await admitRound(roundIndex, admitted)) {
          roundIndex += 1;
        }
      }

      // 3. Nothing running means nothing left to wait for; whatever is still
      //    pending is either blocked, halted, or cut short by the budget, and the
      //    pass after the loop says which.
      if (running.size === 0) break;
      // Wait for the FIRST worker to finish — the one line the wave barrier does
      // not have. Every promise resolves with its own issue number, so the settled
      // one can be taken out of the running set without polling.
      // eslint-disable-next-line no-await-in-loop
      const settled = await Promise.race([...running.values()]);
      running.delete(settled);
      harvest(settled);
    }

    // ---- everything ordered, once, at the end, in plan order ----------------
    const dispatchedWorkers = order.map((number) => workerOf.get(number)).filter(Boolean);
    recordScopeAndLivenessReasons(dispatchedWorkers);
    for (const worker of dispatchedWorkers) recordWorkerVerdict(worker, fallbackVerdicts.get(worker.issue) ?? null);

    for (const entry of groupEntries) {
      const allCompleted = entry.workers.length > 0 && entry.workers.every((worker) => worker.worker_state === 'completed');
      const allVerified = allCompleted && entry.workers.every((worker) => worker.verification.outcome === 'pass');
      entry.barrier = { all_workers_completed: allCompleted, all_verifications_passed: allVerified, advanced: allCompleted && allVerified };
    }

    // The issues that never reached a worker, and WHY — the named codes this
    // Issue asked for. Two different findings, kept apart because the fix is
    // different: `blocked_by_upstream_failure` is about a dependency that really
    // is not green (fix that issue, then `--resume`), while
    // `schedule_halted_unattended` is about an issue whose every dependency
    // passed and that was stopped by the mode (re-run it; nothing is wrong with
    // it). Rounding the second into the first would send an operator to debug an
    // issue that has nothing wrong with it.
    const haltedIssues = haltAdmission ? order.filter((number) => pending.has(number)) : [];
    const notStarted = order.filter((number) => blockedBy.has(number) || haltedIssues.includes(number));
    if (notStarted.length > 0) {
      const blockedWorkers = [];
      for (const number of notStarted) {
        const upstream = blockedBy.get(number) ?? [];
        const worker = {
          issue: number,
          task_id: null,
          worker_state: 'not_dispatched',
          verification: { ran: false, report_schema_version: null, outcome: 'not_run', gates: [], checks: [] },
          prompt: { detected: false, excerpt: null },
          note: '',
        };
        if (upstream.length > 0) {
          worker.note = redact(`blocked_by_upstream_failure: not dispatched because ${upstream.map((n) => `#${n}`).join(', ')} did not reach completed + verification pass`);
          report.blocking_reasons.push({
            code: 'blocked_by_upstream_failure',
            detail: `#${number} was not dispatched: its dependency ${upstream.map((n) => `#${n}`).join(', ')} did not reach \`completed\` AND \`verification.outcome: pass\`, `
              + 'so the work it would build on is not there. Only the DOWNSTREAM of the failure was stopped — independent chains kept running, which is what '
              + '--schedule dag changes about a failure. Fix the upstream issue, then re-run with --resume: this issue is untouched and its worktree was never driven',
          });
        } else {
          worker.note = redact('schedule_halted_unattended: not dispatched because --unattended stopped admission after an earlier issue did not reach completed + verification pass');
          report.blocking_reasons.push({
            code: 'schedule_halted_unattended',
            detail: `#${number} was not dispatched, and NOT because of its own dependencies — every dependency of it passed. --unattended stops the whole run at the first `
              + 'issue that does not reach `completed` AND `verification.outcome: pass`, rather than stopping only that issue\'s downstream, because nobody is here to read '
              + 'the report and decide that the independent half is worth continuing. Nothing is wrong with this issue: re-run with --resume once the failure is understood',
          });
        }
        workerOf.set(number, worker);
        blockedWorkers.push(worker);
      }
      report.waves.push({
        index: report.waves.length,
        dispatched: [],
        workers: blockedWorkers,
        barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
      });
    }

    // The halt ladder, over the whole run rather than over one wave, and in the
    // same order of precedence (dispatch-contract §3.1). Two differences, both
    // forced by there being no wave: the wording never says "the next wave was
    // not dispatched" (in this mode independent work kept going), and the
    // `not_dispatched` rung skips the issues that were blocked or halted. Those
    // have a blocking reason of their own, and ranking them here would make the
    // stop_reason name the CONSEQUENCE (an issue nobody started) instead of the
    // CAUSE (the upstream that failed).
    const everyone = order.map((number) => workerOf.get(number)).filter(Boolean);
    const runGreen = notStarted.length === 0
      && everyone.every((worker) => worker.worker_state === 'completed' && worker.verification.outcome === 'pass');
    if (!stopped && !runGreen) {
      const prompted = everyone.find((worker) => worker.prompt.detected && worker.worker_state === 'prompt');
      const unjudged = everyone.find((worker) => notJudged.has(worker.issue));
      const refused = everyone.find((worker) => worker.worker_state === 'not_dispatched'
        && !blockedBy.has(worker.issue) && !haltedIssues.includes(worker.issue));
      if (prompted) {
        report.human_required = true;
        halt('partial', 'human_required', 'human_input_required', `#${prompted.issue} raised a prompt; halted for a human (no auto-response)`);
      } else if (unjudged) {
        report.human_required = true;
        halt('partial', 'dispatch_error', 'verification_not_judged',
          `#${unjudged.issue}: verification exited ${VERIFY_EXIT_NO_VERDICT} — the run ended error/cancelled, so no gate judged the work. Halted for a human; not re-instructed as a verification failure (exit ${VERIFY_EXIT_FAILED}) and not rounded to a pass`);
      } else if (wallClockExhausted()) {
        halt('partial', 'timeout', 'wall_clock_budget_exhausted',
          `--wall-clock-budget ${inputs.wallClockBudget}s was exhausted; the workers still running were left mid-supervision and no further issue was admitted. `
            + 'The worktree branches are where their workers left them (the unattended_baseline limitation records where each one started)');
      } else if (dagUnresolved.length > 0) {
        haltWith('partial', 'drift', worktreeUnresolvedReasons(dagUnresolved));
      } else if (everyone.some((worker) => worker.worker_state === 'failed')) {
        const failed = everyone.find((worker) => worker.worker_state === 'failed');
        halt('partial', 'worker_failed', 'worker_failed', `#${failed.issue} did not complete; its downstream was not dispatched`);
      } else if (everyone.some((worker) => worker.worker_state === 'timeout')) {
        const timed = everyone.find((worker) => worker.worker_state === 'timeout');
        halt('partial', 'timeout', 'worker_timeout', `#${timed.issue} timed out; its downstream was not dispatched`);
      } else if (refused) {
        halt('partial', 'dispatch_error', 'not_dispatched', `#${refused.issue} was never dispatched: ${refused.note || 'the runner refused to start it'}`);
      } else if (everyone.some((worker) => worker.verification.outcome !== 'pass' && worker.worker_state === 'completed')) {
        const failedVerify = everyone.find((worker) => worker.verification.outcome !== 'pass' && worker.worker_state === 'completed');
        halt('partial', 'verification_failed', 'verification_failed', `#${failedVerify.issue} completed but its verification did not pass; its downstream was not dispatched`);
      } else {
        halt('partial', 'dispatch_error', 'not_dispatched',
          `${notStarted.length} issue(s) were never dispatched: ${notStarted.map((n) => `#${n}`).join(', ')}`);
      }
    } else if (!stopped && unattributedPasses.size > 0) {
      report.status = 'partial';
      report.stop_reason = 'dispatch_error';
      stopped = true;
    }
  }

  // Auto-yes is an explicit deviation from the safe default; surface it, but do
  // not treat an authorized auto-response as a broken invariant.
  if (autoResponded) {
    report.limitations.push({ code: 'auto_yes_used', detail: 'a worker prompt was auto-answered because --auto-yes was set' });
  }

  // Whether a worktree id came from the first `ls` or from the one after a
  // `commandmate sync` is a fact about how this run resolved its targets, so it is
  // recorded whatever the outcome — including on the runs it made succeed.
  recordSyncAttempt(report);

  // `--only` (CommandMate#3008): account for the issues this run was told not to
  // touch. After every wave, so it cannot be mistaken for a scheduling decision,
  // and it changes neither the status nor the completion check: a run whose
  // SELECTED issues all passed is a success.
  // The human-only issues (Issue #286) join the same entry, in issue order.
  const excludedWorkers = [
    ...(inputs.onlyScope === null ? [] : onlyExcludedWorkers(inputs)),
    ...humanOnlyWorkers(inputs),
  ].sort((a, b) => a.issue - b.issue);
  if (excludedWorkers.length > 0) {
    report.waves.push({
      index: report.waves.length,
      dispatched: [],
      workers: excludedWorkers,
      barrier: { all_workers_completed: false, all_verifications_passed: false, advanced: false },
    });
  }

  // Completion self-check. `no_auto_prompt_response` guards the safe default: a
  // prompt is never answered UNLESS --auto-yes was explicitly set.
  // A resume with nothing left to dispatch mutates nothing, so there is no
  // mutating wave for a drift re-check to guard. That is a satisfied check, not
  // a skipped one — but it must SAY so rather than borrow the sentence about a
  // check that really ran (Issue #98).
  const driftReconfirmed = report.drift_checks.length > 0 || nothingToDispatch;
  report.completion_check = buildCompletionCheck({
    planApproved: true,
    driftReconfirmed,
    driftDetail: report.drift_checks.length === 0 && nothingToDispatch
      ? 'nothing was dispatched (every issue was already completed and verified in a prior attempt), so there was no mutating wave to re-check drift before'
      : null,
    parallelismBounded,
    barrierEnforced,
    // The invariant `barrier_enforced` states is mode-dependent, so the sentence
    // it states it in has to be too (Issue #183). The id is unchanged — it is a
    // schema-versioned closed set — and so is what it MEANS: nothing was
    // dispatched on top of work that had not both completed and passed. What
    // differs is the unit that held: a wave in one mode, an issue's own
    // dependencies in the other.
    barrierDetail: inputs.schedule === 'dag'
      ? 'each issue was dispatched only after EVERY effective dependency of it completed AND passed verification (no wave barrier: --schedule dag)'
      : null,
    noAutoPromptResponse: !autoResponded || inputs.autoYes,
    verificationRecorded: [...verificationUnrecorded],
    reportStatus: report.status,
  });
  if (!report.completion_check.passed && report.status === 'success') {
    report.status = 'partial';
    report.limitations.push({ code: 'completion_check_failed', detail: 'a completion check did not pass; see completion_check' });
  }

  report.redactions = redactionsList();
  report.summary_markdown = renderSummary(report, contractMode, openQuestions, resume);
  return report;
}

function buildCompletionCheck({ planApproved, driftReconfirmed, driftDetail = null, parallelismBounded, barrierEnforced, barrierDetail = null, noAutoPromptResponse, verificationRecorded = [], reportStatus }) {
  const checks = [
    { id: 'plan_approved', passed: planApproved, detail: planApproved ? 'an approved plan was loaded and validated' : 'no valid plan was loaded' },
    { id: 'drift_reconfirmed', passed: driftReconfirmed, detail: driftDetail ?? (driftReconfirmed ? 'drift was re-checked before dispatch' : 'no drift check ran') },
    { id: 'parallelism_bounded', passed: parallelismBounded, detail: parallelismBounded ? 'no wave dispatched more than max_parallel workers' : 'a wave exceeded max_parallel and was truncated' },
    { id: 'barrier_enforced', passed: barrierEnforced, detail: barrierDetail ?? (barrierEnforced ? 'the next wave dispatched only after completion AND verification' : 'the wave barrier was not enforced') },
    { id: 'no_auto_prompt_response', passed: noAutoPromptResponse, detail: noAutoPromptResponse ? 'no prompt was answered without explicit --auto-yes' : 'a worker prompt was answered without authorization' },
    // Issue #83. `completed` with no verdict recorded is not a verification
    // failure and not a worker failure — it is the RUNNER failing to write down
    // what it was told. It used to be indistinguishable from "verification did
    // not run", which merge/uat read as ineligible and no one read as a bug.
    {
      id: 'verification_recorded',
      passed: verificationRecorded.length === 0,
      detail: verificationRecorded.length === 0
        ? 'every completed worker carries the verification verdict that judged it'
        : `no verification verdict was recorded for completed worker(s) ${verificationRecorded.map((n) => `#${n}`).join(', ')}; the report cannot say what judged them`,
    },
  ];
  // A failure result is a legitimate outcome, but it still must not claim a
  // passed completion check unless every invariant above actually held.
  const passed = checks.every((check) => check.passed) && reportStatus !== 'failure';
  return { passed, checks };
}

// =============================================================================
// Summary
// =============================================================================

// The preparation stage's own vocabulary (Issue #93). The summary is rendered
// from the REPORT rather than from the stage's return value so the two cannot
// disagree: every sentence below is a code that is also in the JSON.
const PREPARATION_LIMITATION_CODES = ['worktree_setup_ran', 'worktree_prepared', 'worktree_setup_partial', 'worktree_setup_skipped'];
const PREPARATION_BLOCKING_CODES = ['worktree_setup_unavailable', 'worktree_setup_failed', 'worktree_profile_mismatch'];

function renderSummary(report, contractMode = false, openQuestions = [], resume = null) {
  const lines = [];
  const haltedOnQuestions = report.blocking_reasons.some((reason) => reason.code === 'open_questions');
  const worktreeUnresolved = report.blocking_reasons.some((reason) => reason.code === 'worktree_unresolved');
  const preparationLimitations = report.limitations.filter((entry) => PREPARATION_LIMITATION_CODES.includes(entry.code));
  const preparationBlocking = report.blocking_reasons.filter((entry) => PREPARATION_BLOCKING_CODES.includes(entry.code));
  lines.push('## 対象と結論');
  const verb = report.status === 'success' ? '完了' : report.status === 'partial' ? '途中停止' : '未実行';
  lines.push(`plan ${report.plan_run_id} を ${report.profile.repository} に dispatch: ${report.status}（${verb}, stop=${report.stop_reason}）。`);
  // A run that dispatched nobody judged nobody. Naming the adjudication
  // mechanism there states a past-tense fact that never happened (Issue #90).
  // A resume that had nothing left to dispatch judged nobody either, but it does
  // hold verdicts — carried ones. Saying "契約で裁定した" there would claim this
  // attempt ran a gate it never ran (Issue #98).
  // A reverify's `dispatched` is empty by construction, so the "carried
  // everything" sentence above would be a lie about the one attempt that judges
  // WITHOUT dispatching (Issue #121). It gets its own sentence, naming the
  // instrument it really used.
  const dispatchedAny = report.waves.some((wave) => wave.dispatched.length > 0);
  const reverifying = resume !== null && resume.reverifying === true;
  lines.push(report.waves.length === 0
    ? '裁定: 1件も dispatch していないため、裁定は行っていない。'
    : reverifying
      ? (contractMode
        ? '裁定: `--reverify` — 1件も send せず、worktree の現状を `commandmate verify --json` の exit code で判定し直した。引き継ぎ分は前回記録の転記で、再判定していない。'
        : '裁定: `--reverify` — 1件も send せず、worktree の現状を profile baseline の再実行で判定し直した。引き継ぎ分は前回記録の転記で、再判定していない。')
      : (resume !== null && !dispatchedAny)
        ? '裁定: この attempt では 1件も dispatch していない。verification はすべて前回 attempt の記録を引き継いだもので、ここで再判定はしていない。'
        : contractMode
          ? '裁定: 実行契約（`commandmate send --contract` / `wait --verify` の exit code）を一次ソースにした。'
          : '裁定: 実行契約は使わず、profile baseline を worktree 内で再実行するフォールバックで判定した。');
  const notJudged = report.blocking_reasons.find((reason) => reason.code === 'verification_not_judged');
  if (haltedOnQuestions) lines.push('plan の Issue に未回答の open question が残っていたため、worker を 1 人も dispatch せずに停止した。');
  else if (notJudged) lines.push('検証が判定に到達しなかった（exit 99）ため、不合格として再指示せず human 提示で停止した。');
  else if (report.human_required) lines.push('worker が prompt を出したため、自動応答せず human 提示で停止した。');
  else if (worktreeUnresolved) lines.push('対象 Issue の worktree が `commandmate ls` で解決できなかったため、その Issue には worker を dispatch していない（worker の失敗ではない）。');
  lines.push('');

  // The resume section (Issue #98). Placed first because every other section is
  // read against it: which attempt this is, what was NOT re-run and why, and
  // what this attempt actually dispatched.
  if (resume !== null && reverifying) {
    lines.push('## reverify');
    lines.push(`- attempt ${resume.attempt}（resumed_from: \`${resume.priorRelative}\` / attempt ${resume.priorAttempt}）。既存 artifact は上書きしていない。この attempt の artifact は \`${RESUME_ATTEMPT_PREFIX}${resume.attempt}/\` 配下。`);
    lines.push('- **`send` を1回も呼んでいない。** 実行契約も書いていないし、worker のターンも1つも消費していない。');
    lines.push(resume.carriedIssues.length === 0
      ? '- 引き継ぎ: なし（前回 attempt に「worker completed かつ verification pass」の Issue が無かった）。'
      : `- 引き継ぎ（再判定もしない）: ${resume.carriedIssues.map((n) => `#${n}`).join(', ')} — worker completed かつ verification pass。verification 記録は転記しただけである。`);
    lines.push(resume.redispatchIssues.length === 0
      ? '- **再判定対象なし**: plan の全 Issue が既に completed かつ verification pass だった。'
      : `- 再判定の候補: ${resume.redispatchIssues.map((n) => `#${n}`).join(', ')}。このうち **worktree に作業証跡（work ブランチの commit / 未 commit の変更）が在るものだけ**を判定し直した。`);
    const notReverified = report.limitations.filter((entry) => entry.code === 'reverify_no_work_evidence'
      || entry.code === 'reverify_evidence_unreadable' || entry.code === 'reverify_prompt_pending');
    if (notReverified.length > 0) {
      lines.push('- 判定し直していない Issue（前回記録をそのまま転記した）:');
      for (const entry of notReverified) lines.push(`  - ${entry.detail}`);
    }
    lines.push('- 完了の定義は通常経路と同じ「work ブランチの新規 commit」である。未 commit の作業だけの Issue は `completed` に上げない（納品できないし、この経路は commit を要求できない — 要求は send だからである）。');
    lines.push('');
  } else if (resume !== null) {
    lines.push('## resume');
    lines.push(`- attempt ${resume.attempt}（resumed_from: \`${resume.priorRelative}\` / attempt ${resume.priorAttempt}）。既存 artifact は上書きしていない。この attempt の artifact は \`${RESUME_ATTEMPT_PREFIX}${resume.attempt}/\` 配下。`);
    lines.push(resume.carriedIssues.length === 0
      ? '- 引き継ぎ: なし（前回 attempt に「worker completed かつ verification pass」の Issue が無かった）。'
      : `- 引き継ぎ（再 dispatch しない）: ${resume.carriedIssues.map((n) => `#${n}`).join(', ')} — worker completed かつ verification pass。verification 記録は転記しただけで、ここで再判定はしていない。`);
    lines.push(resume.redispatchIssues.length === 0
      ? '- **再実行対象なし**: plan の全 Issue が既に completed かつ verification pass だった。1件も dispatch していない。'
      : `- 再実行対象: ${resume.redispatchIssues.map((n) => `#${n}`).join(', ')}。`);
    lines.push('- 引き継ぎ分は Wave barrier 上「完了」として数えるので、依存元が pass 済みの Issue はその Wave を待たずに dispatch される。');
    lines.push('');
  }

  // The questions themselves, verbatim. A code alone ("open_questions") tells an
  // operator that something is missing but not what to write in the issue, so the
  // text is reproduced here whether the gate stopped the run or was waived
  // (Issue #52).
  if (openQuestions.length > 0) {
    lines.push('## open question');
    lines.push(haltedOnQuestions
      ? '- 次の question に Issue 本文で答えて re-plan する（引き受けて進めるなら `--allow-questions`）。'
      : '- `--allow-questions` により、次の question を未回答のまま dispatch した。');
    for (const entry of openQuestions) {
      for (const question of entry.questions) {
        lines.push(`- #${entry.issue}: ${excerpt(redact(question), 200)}`);
      }
    }
    lines.push('');
  }
  // The preparation stage, when it was asked for. Placed before the waves
  // because it happened before them, and because a run that stopped here never
  // had a wave to report (Issue #93).
  if (preparationLimitations.length > 0 || preparationBlocking.length > 0) {
    lines.push('## worktree 準備');
    lines.push('- `--prepare-worktrees` 指定。pre-flight で未解決だった Issue の worktree は `cmate-worktree-setup` に作らせる（dispatch 自身は worktree を作らない）。');
    for (const entry of preparationBlocking) lines.push(`- 停止: ${entry.code} — ${entry.detail}`);
    for (const entry of preparationLimitations) lines.push(`- ${entry.code}: ${entry.detail}`);
    lines.push('');
  }

  // The unattended section (Issue #122). Printed only when the operator opted
  // in, so a run without `--unattended` reads exactly as it did before the flag
  // existed — including this summary. It is placed before the waves because it
  // is the frame every line below is read in: what was declared, what that
  // implied, and where each worktree stood before this run touched it.
  const unattendedDeclared = report.limitations.find((entry) => entry.code === 'unattended_mode');
  if (unattendedDeclared) {
    const baselines = report.limitations.filter((entry) => entry.code === 'unattended_baseline');
    lines.push('## 無人運転（unattended）');
    lines.push(`- 宣言: ${unattendedDeclared.detail}`);
    lines.push(baselines.length === 0
      ? '- 取り消しの起点: なし（1件も dispatch していないので、この run が動かした worktree は無い）。'
      : `- 取り消しの起点: ${baselines.length} 件の worktree について branch と開始時 SHA を記録した（unattended_baseline）。**untracked file・merge/push 済みの変更・gc 済みの object は戻らない**（SKILL.md 第5節）。`);
    lines.push('- **`--unattended` は mutation の許可ではない。** merge / uat を無人で回すなら `--approve` を別に書く。');
    lines.push('');
  }

  // The method section (Issue #128 / ADR section 9). Printed only when the
  // operator opted in, so a run without `--worker-method` reads exactly as it
  // did before the flag existed — including this summary.
  const methodDeclared = report.limitations.find((entry) => entry.code === 'worker_method_declared');
  const methodApplied = report.limitations.filter((entry) => entry.code === 'worker_method_applied');
  const methodBlocked = report.blocking_reasons.filter((entry) => entry.code === 'worker_method_unavailable');
  if (methodDeclared || methodBlocked.length > 0) {
    lines.push('## 方法論');
    if (methodDeclared) lines.push(`- 宣言: ${methodDeclared.detail}`);
    for (const entry of methodBlocked) lines.push(`- 停止: ${entry.code} — ${entry.detail}`);
    lines.push(methodApplied.length === 0
      ? '- 適用: なし（契約 / prompt を1件も書いていない）。'
      : `- 適用: ${methodApplied.length} 件の Issue の task text に \`## Method\` 節を書いた。`);
    // The one sentence this whole feature must not let a reader lose: dispatch
    // measures that the reference was written, never that it was obeyed
    // (ADR section 3.5 — the same discipline as cmate-verify's "PASS は宣言した
    // ゲートが通った以上のことを意味しない").
    lines.push('- **「適用された」と「守られた」は別の事実である。** dispatch が測れるのは、宣言・install の実在・契約への記載の3つだけで、worker が実際に方法論に従ったかは測っていない。');
    lines.push('');
  }

  // The scheduling section (Issue #183). `dag` gets its own heading and its own
  // vocabulary because the word "Wave" would be a lie there: the entries are
  // admission rounds, `advanced` gates nothing, and the two facts an operator has
  // to leave with — what stopped where, and that the post-merge integration
  // verification now has to be run once at the end — have no place in the wave
  // table. A run without the flag renders exactly what it always did.
  if (report.schedule === 'dag') {
    lines.push('## スケジューリング（dag）');
    lines.push('- 依存充足ベースの逐次投入。Issue は **自分の依存が completed かつ verification pass になった時点**で空き枠へ入る（wave barrier は無い）。`plan.waves` は参考情報である。');
    lines.push(`- \`--max-parallel\` は**同時実行数の上限**（${report.max_parallel}）。下の各行は wave ではなく**投入ラウンド**で、\`次へ=\` は「そのラウンドが揃って green か」を述べているだけで、何かを止めてはいない。`);
    if (report.waves.length === 0) {
      lines.push('- dispatch 前に停止（ラウンドなし）。');
    } else {
      for (const wave of report.waves) {
        const dispatched = wave.dispatched.map((n) => `#${n}`).join(', ') || 'なし';
        lines.push(`- Round ${wave.index + 1}: dispatch=${dispatched} / worker完了=${wave.barrier.all_workers_completed} / verify pass=${wave.barrier.all_verifications_passed} / 揃って green=${wave.barrier.advanced}`);
      }
    }
    const blocked = report.blocking_reasons.filter((entry) => entry.code === 'blocked_by_upstream_failure');
    const halted = report.blocking_reasons.filter((entry) => entry.code === 'schedule_halted_unattended');
    if (blocked.length > 0) {
      lines.push(`- 上流が green にならなかったため止めた Issue: ${blocked.length} 件（\`blocked_by_upstream_failure\`）。**独立系列は止めていない。**`);
      for (const entry of blocked) lines.push(`  - ${entry.detail}`);
    }
    if (halted.length > 0) {
      lines.push(`- **無人なので全停止した**（\`--unattended\`。下流だけを止める側に倒していない）。依存は満たしていたが投入しなかった Issue: ${halted.length} 件（\`schedule_halted_unattended\`）。`);
      for (const entry of halted) lines.push(`  - ${entry.detail}`);
    }
    lines.push('- **合流後の統合ブランチ検証（#175）は wave 境界を失っている。** この run のあと `merge.mjs --merge-prs --integration-verify` を **1回**回して、この run が merge した集合に対して判定すること。');
    lines.push('- 並列度はこのモードで上がる。検証ゲートが資源（ポート等）を共有するリポジトリでは偽赤が増えうるので、Kewton/CommandMate#1771 が着地するまでは `--max-parallel` を保守的に置くこと。');
  } else {
    lines.push('## Wave');
    if (report.waves.length === 0) {
      lines.push('- dispatch 前に停止（wave なし）。');
    } else {
      for (const wave of report.waves) {
        const dispatched = wave.dispatched.map((n) => `#${n}`).join(', ') || 'なし';
        lines.push(`- Wave ${wave.index + 1}: dispatch=${dispatched} / worker完了=${wave.barrier.all_workers_completed} / verify pass=${wave.barrier.all_verifications_passed} / 次waveへ=${wave.barrier.advanced}`);
      }
    }
  }
  lines.push('');
  lines.push('## worker と verification');
  const workers = report.waves.flatMap((wave) => wave.workers);
  if (workers.length === 0) {
    lines.push('- worker なし。');
  } else {
    for (const worker of workers) {
      lines.push(`- #${worker.issue}: worker=${worker.worker_state} / verify=${worker.verification.outcome}${worker.prompt.detected ? ' / prompt検出（human必要）' : ''}`);
    }
  }
  lines.push('');
  lines.push('## drift 再確認');
  const lastWave = report.waves.length ? report.waves[report.waves.length - 1].index : 0;
  const lastChecks = report.drift_checks.filter((check) => check.wave_index === lastWave);
  if (lastChecks.length === 0) {
    lines.push('- drift check なし。');
  } else {
    for (const check of lastChecks) {
      lines.push(`- ${check.code}: ${check.ok ? 'ok' : 'NG'}${check.blocking ? '' : '（非blocking）'}`);
    }
  }
  lines.push('');
  lines.push('## 未解決と next action');
  if (report.blocking_reasons.length === 0 && report.limitations.length === 0) {
    lines.push('- なし。全 wave が完了し verification も pass した。');
  } else {
    for (const reason of report.blocking_reasons) lines.push(`- blocking: ${reason.code} — ${reason.detail}`);
    for (const limitation of report.limitations) lines.push(`- limitation: ${limitation.code} — ${limitation.detail}`);
    if (haltedOnQuestions) {
      lines.push(report.limitations.some((entry) => entry.code === 'unattended_mode')
        // Same reason as the contract line below: `--allow-questions` is a
        // refused input under `--unattended`, so it is not an option to offer.
        ? '- next: 上記 open question を Issue 本文に反映して plan を作り直す。`--unattended` は `--allow-questions` を拒否するので、未回答のまま押し通す道は無い（引き受ける人が居ないときに立てられる旗ではない）（owner: human）。'
        : '- next: 上記 open question を Issue 本文に反映して plan を作り直す。回答せずに進めると判断したなら `--allow-questions` を明示して再実行する（owner: human）。');
    }
    if (report.human_required && !haltedOnQuestions && !report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 提示した prompt を human が確認し、承認のうえ再開する（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'verification_not_judged')) {
      lines.push('- next: 判定に到達しなかった検証 run（exit 99）を human が調べる。契約が run に束ねられたか・タスクが既に終端でないかを確認する。20（判定して不合格）ではないので worker への再指示ループには流さない（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_unsupported')) {
      lines.push(report.limitations.some((entry) => entry.code === 'unattended_mode')
        // `--contract-mode auto` is the advice for an attended run; under
        // --unattended it is a refused input, so naming it here would send the
        // operator to a flag combination that exits 3 (Issue #122).
        ? '- next: CommandMate を 0.17.0 以上へ更新して契約経路で再実行する。`--unattended` は `--contract-mode require` を含意するので、フォールバックへ落とす選択肢は無い（落とすなら `--unattended` を外し、人間が読む運転に戻す）（owner: operator）。'
        : '- next: CommandMate を 0.17.0 以上へ更新して契約経路で再実行するか、`--contract-mode auto` でフォールバック実行する（owner: operator）。');
    }
    // The two unattended-only stops (Issue #122). Both are re-runnable, but for
    // opposite reasons, and saying which is which is the whole point of the line.
    if (report.blocking_reasons.some((reason) => reason.code === 'unattended_locked')) {
      lines.push('- next: 同じ worktree を別の dispatch run が動かしている。**その run の終了を待って同じコマンドを再実行する**（`--out` は消費していない）。lock が残り続けるなら、所有 run の pid が生きているかを確認する（死んでいれば次の run が自動で回収する）（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'wall_clock_budget_exhausted')) {
      lines.push('- next: `--wall-clock-budget` に到達して打ち切った。**成功ではない。** 何に時間を使ったか（baseline / acceptance コマンドは自前の timeout を持たない）を確認し、原因を潰すか budget を実測に合わせて増やしたうえで `--resume` で再開する（owner: operator）。');
    }
    // The three readings of one `wait` timeout (Issue #179). They are separate
    // lines because they name DIFFERENT commands: `--reverify` re-judges finished
    // work in place, `--resume` sends a new worker, and doing the second one to a
    // worker that is still running is exactly the failure this measurement exists
    // to prevent. The third says only that nobody measured, and refuses to guess.
    if (report.blocking_reasons.some((reason) => reason.code === LIVENESS_ALIVE)) {
      lines.push('- next: **`--wait-timeout` が worker の1ターンより短かっただけで、worker は生きている**（timeout 時の `capture` が稼働を示した。blocking の `wait_window_exhausted` と該当 worker の `worker_liveness` を読む）。**ここで再 dispatch しない** —— 完走しかけの作業の上に2人目の worker を重ねることになる。worker が idle 化するのを待ってから `dispatch.mjs --plan <plan.json> --reverify <この run の dispatch ディレクトリ>` で**送らずに裁定だけ取り直す**。1ターンの実測に対して窓が恒常的に短いなら `--wait-timeout` をその実測に合わせて上げる（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === LIVENESS_STALLED)) {
      lines.push('- next: timeout した時点の `capture` に**稼働の証拠が無かった**（blocking の `worker_stalled`）。worker のログと worktree を読み、**作業証跡（commit / 未 commit の変更）を確かめてから** `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再 dispatch する。**「動いていない」は「作業が無い」ではない** —— 未 commit の作業が在るなら、それを潰さないことが先である（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === LIVENESS_UNREADABLE)) {
      lines.push('- next: timeout した worker の生死を**測れていない**（`capture` が失敗した / 出力が読めなかった。blocking の `worker_liveness_unreadable`）。**読めなかったことを「動いている」とも「止まっている」とも読み替えない。** `commandmate capture <worktree-id> --json` を手で叩いて確かめ、動いていれば idle 化を待って `--reverify`、止まっていれば worktree の作業証跡を確かめてから `--resume` で再 dispatch する（owner: operator）。');
    }
    // The three readings of one `--max-turns` cap (Issue #220). Separate lines
    // for the same reason as the timeout trio above: they name OPPOSITE actions
    // — `--resume` the same plan, or re-plan the Issue — and the third refuses
    // to pick. The worker record's `worker_turn_evidence` carries the materials.
    if (report.blocking_reasons.some((reason) => reason.code === TURN_EVIDENCE_UPSTREAM)) {
      lines.push('- next: **`--max-turns` に到達したが、worker は1ターンも実行できていない**（上流が落ちていた。blocking の `worker_upstream_unavailable` と該当 worker の `worker_turn_evidence` を読む）。**Issue を分割しない・re-plan しない** —— この run は当該 Issue について何も測っていない。上流の復旧を待ってから `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で**同じ plan のまま**再開する（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === TURN_EVIDENCE_NOTHING)) {
      lines.push('- next: **worker は実際にターンを回したうえで、commit も未 commit の変更も残していない**（blocking の `worker_produced_nothing`）。worker のログを読み、**Issue の粒度か指示の曖昧さ**を疑う。分割か書き直しをして re-plan する。`--resume` だけでは同じ所で止まる（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === WORKER_STOPPED_WITH_REPORT)) {
      lines.push('- next: worker が nudge に従って**止めて報告した**（blocking の `worker_stopped_with_report` と該当 worker の `worker_report.text` に報告の文がある）。**報告を読んでから決める** —— 書けない理由が Issue 側（対象ファイル・受入条件・指示の矛盾）にあるなら Issue を直して re-plan し、障害が解消済みなら `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再開する。報告の無い無進捗（`worker_produced_nothing` など）とは別の停止である（owner: human）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === TURN_EVIDENCE_UNREADABLE)) {
      lines.push('- next: `--max-turns` に到達した理由を**測れていない**（blocking の `worker_output_unreadable`）。**「ターンを回して何も出なかった」とも「上流が落ちていた」とも読み替えない。** `commandmate capture <worktree-id> --json` と、Claude worker なら `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<cwd を非英数字ごと "-" にしたもの>/*.jsonl` の末尾を手で読んでから、上の2つのどちらかへ進む（owner: operator）。');
    }
    // Issue #161 / #162. Placed BEFORE the empty-scope line because the drop is
    // what emptied the scope whenever both fire on the same issue, and because
    // its action differs: the empty case is "write the target files", this one
    // is "write FEWER, or write them differently".
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_scope_dropped')) {
      lines.push(`- next: 宣言された対象 file の一部が実行契約の \`scope.allow\` に入らない（件数上限 ${MAX_SCOPE_PATTERNS} 超過、または契約が扱えない形の path）。**落ちた path と理由が blocking reason に出ている。** 上限超過なら Issue を分割し、形の問題なら repository-relative な path に書き直して re-plan する。上限は CommandMate 側の契約上限なので runner 側では上げられない（\`--out\` は消費していない）（owner: human）。`);
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'contract_scope_unknown')) {
      lines.push('- next: 対象 file を1件も宣言していない Issue がある。**Issue 本文に対象ファイルを書いて re-plan する。** `--unattended` は plan 全体を pre-flight で検査するので、1件でも欠けていれば1人も dispatch しない（`--out` は消費していない）（owner: human）。');
    }
    // The stage-C promotion (Issue #142). The verdict itself is not in doubt —
    // it is an exit code — so the action is about the EVIDENCE, and the line
    // says so rather than sending the operator to debug a worker.
    //
    // The action names the RUNNER's version, not CommandMate's (Issue #170). It
    // used to say "re-run with a CommandMate that prints GATE lines", which #160
    // disproved twice over: CommandMate already printed them (verify-runner's
    // `reportGates`, measured on 0.22.2) and printed them to STDERR, which the
    // dispatch runner did not read until 0.26.0 — so on that runner the advised
    // re-run stops in exactly the same place, every time. This is the only place
    // an operator sees, and codes-and-recovery.md is the wording of record.
    if (report.blocking_reasons.some((reason) => reason.code === 'verification_gates_unrecorded')) {
      lines.push('- next: pass の根拠となった gate を report が名指しできていない。**まず runner の版を疑う** —— `GATE <id> PASS|FAIL` 行は **stderr に出る**のに 0.26.0 までの dispatch は stdout しか読んでおらず、**その版では再実行しても必ず同じ所で止まる**（#160 で修正済み。直すのは CommandMate の版ではなく runner の版である）。修正版でも空なら、その run が本当に `GATE` 行を出していないということなので、`commandmate wait <worktree-id> --verify` を手で回して **stderr** を確かめる。**裁定（exit code）は pass のままだが、無人 merge の根拠にはしない**（段階 C）。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する（owner: operator）。');
    }
    if (report.limitations.some((reason) => reason.code === 'contract_unsupported')) {
      lines.push('- next: 契約非対応の CLI だったため裁定はフォールバック（baseline 再実行）である。契約ゲートで裁定したい場合は CommandMate を 0.17.0 以上へ更新する（owner: operator）。');
    }
    // The attended twin of the pre-flight stop above (Issue #161 / #162). The
    // run went on, so this is not a next action for the run — it is the reason a
    // pass here does not mean the issue's whole declaration was in force.
    if (report.limitations.some((reason) => reason.code === 'contract_scope_dropped')) {
      lines.push(`- next: 宣言された対象 file の一部が実行契約の \`scope.allow\` に入らないまま dispatch した（件数上限 ${MAX_SCOPE_PATTERNS} 超過、または契約が扱えない形の path）。**worker の権限は Issue の宣言より狭い。** 落ちた path が limitation に出ているので、その file の編集が要るなら Issue を分割するか path を書き直して re-plan する（owner: human）。`);
    }
    // `commandmate sync` is the only fix for "the worktree is on disk but the
    // server never scanned it", so a CLI without it turns a registration gap into
    // an unresolved worktree the operator would otherwise re-create by hand.
    if (report.limitations.some((reason) => reason.code === 'worktree_sync_unavailable')) {
      lines.push('- next: `commandmate sync` が使えない CLI だったため、server 未登録の worktree を登録し直せていない。worktree が disk に実在するなら CommandMate を 0.21.0 以上へ更新して再実行する（owner: operator）。');
    }
    // The resume next-actions (Issue #98). The point of the whole feature is that
    // a partial failure now has a one-command answer, so the summary states that
    // command instead of leaving "再 dispatch する" to be interpreted as re-plan.
    if (report.limitations.some((entry) => entry.code === 'resume_no_work')) {
      lines.push('- next: 再実行対象は無い。この attempt の report をそのまま merge / uat に渡す（owner: operator）。');
    }
    if (report.limitations.some((entry) => entry.code === 'reverify_no_work')) {
      lines.push('- next: 再判定対象は無い。この attempt の report をそのまま merge / uat に渡す（owner: operator）。');
    }
    // The reverify next-action (Issue #121). An issue this attempt could not
    // re-judge needs a WORKER, not another verdict, so the command it names is
    // the other one — saying "re-run --reverify" would loop on the same finding.
    if (report.limitations.some((entry) => entry.code === 'reverify_no_work_evidence'
      || entry.code === 'reverify_evidence_unreadable' || entry.code === 'reverify_prompt_pending')) {
      lines.push('- next: 判定し直せなかった Issue（作業証跡が無い / 読めない / prompt 保留）は、裁定ではなく worker が要る。`dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で dispatch し直す（owner: operator）。');
    }
    // The L4 stop (Issue #148). It replaces the generic verification-failure line
    // rather than sitting beside it: "worktree を診断して再 dispatch" is the one
    // instruction that is WRONG here — re-dispatching the same plan re-runs the
    // same unsatisfiable loop, because `scope.allow` is a snapshot of the Issue's
    // 対象ファイル and nothing in the worktree can widen it.
    const scopeUnsatisfiable = report.blocking_reasons.some((reason) => reason.code === 'scope_unsatisfiable');
    if (scopeUnsatisfiable) {
      lines.push('- next: **worker では直せない。** 契約の `scope.allow` は send 時 snapshot なので worktree の中からは広げられない。上記 blocking の違反 path を **Issue の対象ファイルに足して re-plan する**（repo の規約なら profile 側に宣言する）。同じ plan のまま再 dispatch すると同じ所で止まる（owner: human）。');
    }
    if (report.stop_reason === 'verification_failed' && !scopeUnsatisfiable) lines.push('- next: verification 失敗の worktree を診断し、修正後に再 dispatch する（owner: operator）。');
    if (report.status !== 'success' && report.out_dir !== null) {
      lines.push('- next: 原因を直したら `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再開する。worker completed かつ verification pass の Issue は再 dispatch されず、その verification 記録だけが引き継がれる（owner: operator）。');
    }
    // The conditional dependency, named (Issue #93). A stage the operator asked
    // for and that could not run must say what to install and what to pass —
    // "worktree を作成して再実行" is the answer to a different question.
    // The conditional dependency the operator named themselves (Issue #128).
    // "install it and re-run the same command" is the whole fix, and it is worth
    // saying that `--out` was not consumed — that is why the same command works.
    if (methodBlocked.length > 0) {
      lines.push('- next: `commandmate skill install <skill-id>` で方法論スキルを対象 worktree に入れ（`.claude/skills` と `.agents/skills` の両方に入る）、**同じコマンドをそのまま再実行**する。`--out` は消費していない。方法論なしで走らせてよいなら `--worker-method` を外す（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_setup_unavailable')) {
      lines.push('- next: `cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。`--prepare-worktrees` を外せば従来どおり「worktree を自分で作ってから dispatch」になる（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_setup_failed')) {
      lines.push('- next: `cmate-worktree-setup` provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる（owner: operator）。');
    }
    if (report.blocking_reasons.some((reason) => reason.code === 'worktree_profile_mismatch')) {
      lines.push('- next: plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。branch が一致しないと `commandmate ls` の branch 一致では解決できない。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す（owner: operator）。');
    }
    // The worktree case names the fix (Issue #90). "drift を解消して再開" is true
    // but useless here: nothing about branch/base/permission moved — a worktree
    // was never created. The `--out` sentence matters because it is the whole
    // reason the pre-flight runs before the run directory: the operator can
    // re-run the SAME command, not invent a new output path.
    if (worktreeUnresolved) {
      lines.push(`- next: cmate-worktree-setup で未解決 Issue の worktree を作成し（plan と同じ profile / 同じ branch_template）、${report.out_dir === null ? '同じコマンドで再実行する（`--out` は消費していない）' : '再 dispatch する'}（owner: operator）。1つのコマンドで通したいなら \`--prepare-worktrees --worktree-setup <launcher>\` を付けて再実行する。`);
    } else if (report.stop_reason === 'drift') {
      lines.push('- next: drift（branch/base/permission）を解消し、plan を再確認して再開する（owner: operator）。');
    }
  }
  return lines.join('\n');
}

// =============================================================================
// Failure envelope
// =============================================================================

function dispatchFailure(error) {
  return {
    dispatch_schema_version: DISPATCH_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status: 'failure',
    stop_reason: 'dispatch_error',
    human_required: false,
    plan_run_id: 'unknown',
    out_dir: null,
    auto_yes: false,
    max_parallel: 1,
    profile: { id: 'unknown', repository: 'unknown/unknown', base: 'unknown', verified: false },
    drift_checks: [],
    waves: [],
    blocking_reasons: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    limitations: [],
    redactions: redactionsList(),
    completion_check: buildCompletionCheck({
      planApproved: false,
      driftReconfirmed: false,
      parallelismBounded: true,
      barrierEnforced: true,
      noAutoPromptResponse: true,
      reportStatus: 'failure',
    }),
    summary_markdown: `## 対象と結論\ndispatch 失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  };
}

// =============================================================================
// Entry point
// =============================================================================

async function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  // The clock starts at the top of the run, not at the first wave: the budget is
  // the invocation's wall clock, and the pre-flight, the contract probe and the
  // worktree preparation stage are part of what it pays for (Issue #122).
  startWallClockBudget(inputs.wallClockBudget);
  const rawPlan = loadPlan(inputs.planPath);
  const validatedPlan = validatePlan(rawPlan);
  // The human-only issues leave the plan first (Issue #286), so `--only` below
  // and everything after it sees only what can be dispatched.
  const humanOnly = excludeHumanOnly(validatedPlan);
  inputs.humanOnly = { issues: humanOnly.issues, dependencies: humanOnly.dependencies };
  // `--only` narrows the plan ONCE, here, before anything reads it (CommandMate#3008).
  const restricted = restrictToOnly(inputs, humanOnly.plan);
  const plan = restricted.plan;
  inputs.onlyScope = restricted.scope;
  inputs.onlyCarried = restricted.carried;
  // The profile's operating defaults (Issue #180), resolved against the flags
  // actually typed. It happens HERE — after the plan is readable and before the
  // resume decision, the lock, the pre-flight and `--out` — because the values it
  // decides are inputs to all four, and because a refusal it raises has to leave
  // the world exactly as untouched as an argv refusal does.
  applyDispatchDefaults(inputs, plan);
  applyWorkerMessages(inputs, plan);

  // The resume decision (Issue #98) is made FIRST: it decides which directory
  // this attempt writes into, which wave the pre-flight has to probe, and which
  // issues it may demand a worktree for. It is also where a report from another
  // plan is refused — before anything is probed, sent or written.
  // `--reverify` (Issue #121) is the same decision reached through a different
  // flag, so it is built by the same function and travels in the same variable:
  // every "this attempt appends into a prior run" rule below — the directory it
  // writes into, which wave the pre-flight probes, which worktrees it may lock,
  // which report it refuses — is one rule, not two.
  const resume = inputs.reverifyDir !== null
    ? buildResume(inputs, plan, 'reverify')
    : (inputs.resumeDir === null ? null : buildResume(inputs, plan));
  const outDir = resume !== null ? resume.dir : (inputs.outDir ?? join(dirname(inputs.planPath), 'dispatch'));
  // `--out` claims a new directory; `--resume` appends into an existing one, and
  // protects the earlier attempts by writing under a `resume-attempt-<n>/` name
  // that does not exist yet (nextAttemptNumber) rather than by refusing here.
  if (resume === null && existsSync(outDir)) {
    throw new SkillError('out_exists', `dispatch directory ${outDir} already exists; refusing to overwrite`, 4);
  }
  // Where THIS attempt's artifacts go — the run directory on a first dispatch,
  // `<run-dir>/resume-attempt-<n>/` on a resume.
  const attemptDir = resume === null ? outDir : resume.attemptDir;

  // ---- unattended: exclusivity, then the plan-only gates (Issue #122) -------
  //
  // Both happen BEFORE the pre-flight, and in this order.
  //
  // The lock comes first because the window Issue #115 measured opens at process
  // start: two runs that are both inside their pre-flight have neither created
  // `--out` nor sent anything, and the `--prepare-worktrees` stage — which
  // creates worktrees and branches — sits inside exactly that window. A lock
  // taken after the pre-flight would be taken after the mutation it guards.
  //
  // The plan-only refusal comes second because it needs no world at all: an
  // unanswered planner question and an undeclarable scope are facts about the
  // plan, and refusing on them before probing anything is what leaves `--out`
  // unconsumed for the re-run after the re-plan.
  let lockKeys = [];
  if (inputs.unattended) {
    const lockable = resume === null
      ? (plan.issues ?? [])
      : (plan.issues ?? []).filter((issue) => !resume.carried.has(issue.number));
    const locks = acquireUnattendedLocks(plan, lockable);
    if (!locks.ok) {
      const report = unattendedRefusalReport(inputs, plan, locks.reasons, { humanRequired: false, resume });
      process.stderr.write(`nothing was dispatched; another run holds the worktree lock, so ${attemptDir} was not created — re-run once it has finished\n`);
      return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
    }
    lockKeys = locks.keys;

    const planReasons = unattendedPlanReasons(plan);
    if (planReasons.length > 0) {
      // human_required: these are not re-dispatchable. The fix is an edit to the
      // issue body followed by a re-plan, which is what the field means (the
      // schema says "None of the three is resolvable by re-dispatching"), and it
      // is what stops a CI job from retrying the same plan forever.
      const report = unattendedRefusalReport(inputs, plan, planReasons, { humanRequired: true, lockKeys, resume });
      process.stderr.write(`nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once the issues are fixed and re-planned\n`);
      return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
    }
  }

  // Blocking pre-flight, BEFORE the attempt directory exists (Issue #90).
  // Skipped when the plan alone already refuses the run: the open-questions gate
  // is a pure function of the plan, and probing a world whose answer can no
  // longer change anything is a side effect for nothing (the same reason the
  // contract probe is skipped once the run has stopped). That gate still reports
  // from inside runDispatch, so its artifacts are written exactly as before.
  // Skipped too when a resume has nothing left to dispatch: there is no mutating
  // wave to guard, and a carried issue's worktree may legitimately be gone.
  const refusedOnQuestions = !inputs.allowQuestions && collectOpenQuestions(plan).length > 0;
  const preflightWave = resume === null ? 0 : resume.firstActiveWave;
  const preflightIssues = resume === null
    ? plan.waves[0]
    : (preflightWave < 0 ? [] : resume.waveDispatch[preflightWave].slice(0, plan.max_parallel));
  const skipPreflight = refusedOnQuestions || preflightWave < 0;
  let preflight = skipPreflight ? null : preflightDispatch(inputs, plan, preflightWave, preflightIssues);

  // The worktree preparation stage (Issue #93), between the refusal and the
  // refusal's report. It runs ONLY when the operator asked for it and only when
  // the pre-flight's whole complaint is missing worktrees; when it delivers, the
  // pre-flight is re-run against the changed world rather than patched — the
  // decision to dispatch is made by the same check either way, and anything the
  // preparation did not fix falls through to #90's unchanged refusal.
  let preparation = null;
  if (preflight !== null && preflight.blocked && inputs.prepareWorktrees) {
    preparation = blockedOnWorktreesOnly(preflight)
      ? prepareWorktrees(inputs, plan, preflight.unresolved)
      : skippedPreparation(preflight);
    if (preparation.ok) preflight = preflightDispatch(inputs, plan, preflightWave, preflightIssues);
  }

  if (preflight !== null && preflight.blocked) {
    const report = preflightFailureReport(inputs, plan, preflight, preparation, resume, lockKeys);
    // The advice names what actually blocked. "once the drift is fixed" is the
    // wrong instruction for a missing worker-method Skill, and the operator only
    // gets one line on stderr (Issue #128).
    const methodBlocked = preflight.reasons.some((reason) => reason.code === 'worker_method_unavailable');
    process.stderr.write(methodBlocked
      ? `nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once ${inputs.workerMethod} is installed in every worktree it dispatches into\n`
      : `nothing was dispatched; ${attemptDir} was not created, so the same command can be re-run once the drift is fixed\n`);
    return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n` };
  }

  mkdirSync(attemptDir, { recursive: true });

  const report = await runDispatch(inputs, plan, attemptDir, preflight, preparation, resume, lockKeys);
  writeFileSync(join(attemptDir, DISPATCH_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(join(attemptDir, DISPATCH_SUMMARY_FILE), `${report.summary_markdown}\n`, 'utf8');

  // The attempt ledger (Issue #98), at the run directory's root and append-only.
  // It is what makes the history readable by a machine without reopening every
  // report: which report each attempt wrote, what it resumed from, what it
  // carried and what it dispatched. Written for the first attempt too, so the
  // history has no implicit first line.
  const attempt = resume === null ? 1 : resume.attempt;
  appendAttemptHistory(outDir, {
    attempt,
    kind: resume === null ? 'initial' : resume.mode,
    plan_run_id: plan.run_id,
    resumed_from: resume === null ? null : { attempt: resume.priorAttempt, report: resume.priorRelative },
    report: attemptReportRelative(attempt),
    summary: attemptSummaryRelative(attempt),
    status: report.status,
    stop_reason: report.stop_reason,
    carried_over: resume === null ? [] : resume.carriedIssues,
    dispatched: report.waves.flatMap((wave) => wave.dispatched),
    // The reverify half of the ledger (Issue #121). `dispatched` is empty on such
    // an attempt — nothing was sent — so without this line the ledger could not
    // say what the attempt actually did. Absent on every other kind rather than
    // written as `[]`, so an old reader sees the file it has always seen.
    ...(resume !== null && resume.reverifying ? { reverified: resume.redispatchIssues.slice() } : {}),
  });

  process.stderr.write(`wrote dispatch artifacts to ${attemptDir}\n`);
  const exitCode = report.status === 'success' ? 0 : report.status === 'partial' ? 7 : 1;
  return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n` };
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = await run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const report = dispatchFailure(error);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
