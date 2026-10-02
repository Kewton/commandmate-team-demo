#!/usr/bin/env node
// cmate-orchestrate — post-merge observation runner (Node stdlib only, Node >= 22).
//
// Issue #221.
//
// Some acceptance criteria cannot be measured where the work happens. "the CI
// wall clock of 3 runs after the merge is a minute shorter than before", "the e2e
// step is 30% faster over 5 runs and flaky count is within +1" are claims about
// the BASE BRANCH AFTER the merge, and nothing in this package went there:
// `uat.mjs` runs the profile baseline inside the issue's own worktree BEFORE the
// merge (uat-contract.md), and `merge.mjs --integration-verify` runs the
// integration set ONCE on the merged base (#175 / #195) to answer "is the
// combined state green" — not "how long does it take, N times".
//
// So a human measured it by hand, and the measurement went wrong in three
// distinct ways (Kewton/CommandMate#1835, measured on Kewton/BorderFreeKidsMap):
//
//   1. THE FIRST RUNS ARE OUTLIERS. A median over the 3 runs right after the
//      merge was 446s and got reported as a miss; once the runs piled up, the
//      median of 8 was 385.0s — 63.5s better, i.e. the criterion was met. The
//      report had to be retracted.
//   2. THE RUN CARRIES NOISE THE CRITERION IS NOT ABOUT. A whole-run wall clock
//      includes `setup-node`, which measured 38s–66s on its own. A criterion
//      about the e2e time has to read the e2e STEP, which needs the jobs API.
//   3. THE DEFECT SHOWS UP ON RUN 5. Runs 1–4 were green; on the fifth, `serve`
//      died three times and the job hung for 28 minutes. Four runs said the
//      opposite of what five said.
//
// ---- What this runner does, and the one thing it refuses to do --------------
//
// It collects what the profile DECLARED (`observations`, lib.mjs
// normalizeObservations), N times, on the merged base, and writes down every
// single value it saw. That is all.
//
//   IT DOES NOT ADJUDICATE. There is no verdict field, no threshold, and the
//   words `pass` and `fail` do not appear in its output at all — the one
//   exception being a GitHub `conclusion` transcribed verbatim, which is
//   GitHub's word about GitHub's run and is always carried under a key named
//   `conclusion`. `status` reports COMPLETENESS OF COLLECTION and nothing else:
//   `success` = every observation got the `--runs` samples that were asked for,
//   `partial` = something was short or unobservable. Case 3 is why: five people
//   can read one set of numbers and reach different conclusions, and a runner
//   that picked one would be hiding the disagreement rather than resolving it.
//
//   IT SHOWS EVERY RUN. `summary_markdown` renders one table row per sample,
//   including the ones excluded from the aggregate. Case 1 happened because a
//   median was read without the series under it.
//
//   IT NEVER DROPS A SAMPLE SILENTLY. A `cancelled` / `in_progress` / non-green
//   run is excluded from the median and mean — an unfinished or abandoned run
//   did not measure the thing — and its count is stated by conclusion, in the
//   report and in the summary.
//
//   IT IS READ-ONLY UNLESS TOLD OTHERWISE, and the exception is narrow. This is
//   the FIRST path in this package that writes to GitHub (`gh` was `pr view` /
//   `pr checks` / `pr merge` / `issue view` until now, and SKILL.md §1 puts
//   automatic issue-body editing out of scope). `--comment` needs `--approve`,
//   posts a COMMENT and never touches a body.
//
// ---- Why it is not part of uat.mjs (fixed by the Issue) ---------------------
//
// uat runs in the issue's worktree, before delivery; observe runs on the base
// branch, after it. Folding the second into the first would mean a UAT phase
// that sometimes reaches the network for run history and sometimes does not, and
// whose `status` would then mean two different things.

import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  loadJson,
  normalizeObservations,
  redact,
  redactionsList,
} from './lib.mjs';

const OBSERVE_SCHEMA_VERSION = 1;

// The upper bound on how many runs `gh run list` is asked for. The window filter
// (created after `mergedAt`) is applied here rather than by gh, so the list has
// to be long enough to still contain `--runs` post-merge runs after older ones
// are dropped. Four times the request, floored at 20, is what the measured cases
// needed; the ceiling is gh's own `--limit` maximum.
const RUN_LIST_FLOOR = 20;
const RUN_LIST_CEILING = 100;

// The directory name of the throwaway detached checkout `kind: command` measures
// in. Same shape as merge.mjs's INTEGRATION_TREE_DIRNAME, and for the same
// reason: the invocation's own working tree is never touched.
const COMMAND_TREE_PREFIX = 'observe-tree';

const USAGE = `cmate-orchestrate post-merge observation runner (collects; never adjudicates)

Usage:
  observe.mjs --plan <plan.json> --merge <merge-report.json> --runs <n>
              [--inspect <report.json>] [--profile <profile.json>]
              [--max-wait <sec>] [--poll-interval <sec>] [--out <dir>]
              [--comment --approve] [--gh <bin>] [--git <bin>]

Options:
  --plan <path>          Execution plan the merge was made from. Its
                         profile.observations is what gets collected.
  --merge <path>         merge-report.json of the run that merged. Only targets
                         with merged: true are observed.
  --runs <n>             How many samples to collect per observation. REQUIRED:
                         3 and 8 gave opposite answers on the same repository,
                         so the number is a decision, not a default.
  --inspect <path>       A JSON document holding "before" values. Any object in
                         it with a matching id and a numeric value/median is
                         shown beside the new numbers; no match means baseline
                         null. No particular producer is assumed.
  --profile <path>       Read observations from this profile file instead of
                         from the plan. For a plan frozen before the profile
                         declared them; recorded in the report either way.
  --max-wait <sec>       Keep re-querying until every observation has --runs
                         samples, up to this many seconds. Default 0 (one sweep).
  --poll-interval <sec>  Seconds between re-queries while waiting. Default 30.
  --out <dir>            Artifact directory. Default <merge dir>/observe.
                         Refuses an existing path.
  --comment              Post summary_markdown as an ISSUE COMMENT on every
                         observed issue. Requires --approve. Never edits a body.
  --approve              Explicit approval for the only write this runner has.
  --gh <bin>             gh binary. Default: gh.
  --git <bin>            git binary. Default: git.
  -h, --help             This text.

status is completeness of collection (success / partial), never a verdict.`;

// =============================================================================
// Input
// =============================================================================

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        plan: { type: 'string' },
        merge: { type: 'string' },
        runs: { type: 'string' },
        inspect: { type: 'string' },
        profile: { type: 'string' },
        'max-wait': { type: 'string' },
        'poll-interval': { type: 'string' },
        out: { type: 'string' },
        comment: { type: 'boolean' },
        approve: { type: 'boolean' },
        gh: { type: 'string' },
        git: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', redact(error.message), 3);
  }
}

function positiveInt(value, label, { min = 1, max = 1000 } = {}) {
  if (!/^[0-9]+$/.test(String(value))) {
    throw new SkillError('invalid_input', `${label} must be an integer, got ${redact(String(value))}`, 3);
  }
  const number = Number(value);
  if (number < min || number > max) {
    throw new SkillError('invalid_input', `${label} must be between ${min} and ${max}, got ${number}`, 3);
  }
  return number;
}

function resolveInputs(parsed) {
  const values = parsed.values;
  if (!values.plan) throw new SkillError('invalid_input', '--plan <plan.json> is required', 3);
  if (!values.merge) throw new SkillError('invalid_input', '--merge <merge-report.json> is required', 3);
  // Not defaulted, on purpose. The whole Issue is about N: a median over 3 runs
  // reported a miss that a median over 8 did not, so a runner that supplied the
  // number would be making the decision the operator has to make and record.
  if (values.runs === undefined) {
    throw new SkillError(
      'invalid_input',
      '--runs <n> is required. It is not defaulted: 3 runs and 8 runs of the same workflow gave opposite '
        + 'answers about the same change (CommandMate#1835), so how many samples this observation rests on '
        + 'is a decision the operator makes and the report records',
      3,
    );
  }
  // The approval gate for the ONLY write this runner has. Refused before any
  // input is read and before a single `gh` call is made, so a mistyped
  // invocation cannot post anything on its way to being rejected.
  if (values.comment === true && values.approve !== true) {
    throw new SkillError(
      'approval_required',
      '--comment writes a comment to GitHub and therefore requires --approve. This is the first path in this '
        + 'package that writes to GitHub at all; nothing is posted without an explicit approval on the same '
        + 'invocation. (It only ever posts a COMMENT — no issue body is edited.)',
      2,
    );
  }
  return {
    planPath: values.plan,
    mergePath: values.merge,
    runs: positiveInt(values.runs, '--runs', { min: 1, max: 100 }),
    inspectPath: values.inspect ?? null,
    profilePath: values.profile ?? null,
    maxWaitSec: values['max-wait'] === undefined ? 0 : positiveInt(values['max-wait'], '--max-wait', { min: 0, max: 86400 }),
    pollIntervalSec: values['poll-interval'] === undefined ? 30 : positiveInt(values['poll-interval'], '--poll-interval', { min: 1, max: 3600 }),
    outDir: values.out ?? null,
    comment: values.comment === true,
    approve: values.approve === true,
    gh: values.gh ?? 'gh',
    git: values.git ?? 'git',
  };
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('load_error', 'plan must be a JSON object', 6);
  }
  if (plan.skill_id !== SKILL_ID) {
    throw new SkillError('load_error', `plan skill_id "${redact(String(plan.skill_id))}" is not ${SKILL_ID}`, 6);
  }
  const profile = plan.profile;
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new SkillError('load_error', 'plan has no profile', 6);
  }
  if (typeof profile.repository !== 'string' || typeof profile.base !== 'string') {
    throw new SkillError('load_error', 'plan.profile must carry repository and base', 6);
  }
  return plan;
}

function validateMerge(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new SkillError('load_error', 'merge report must be a JSON object', 6);
  }
  if (report.skill_id !== SKILL_ID) {
    throw new SkillError('load_error', `merge report skill_id "${redact(String(report.skill_id))}" is not ${SKILL_ID}`, 6);
  }
  if (!Array.isArray(report.targets)) {
    throw new SkillError('load_error', 'merge report has no targets', 6);
  }
  return report;
}

// WHERE the declaration comes from, stated rather than inferred.
//
// The plan is the default because that is the handoff every other runner uses:
// dispatch reads `plan.profile.dispatch_defaults` (#196) and merge reads
// `plan.profile.integration_baseline` (#195), and both do it so that what runs is
// what the approved plan froze. If the on-disk profile silently won, two observe
// runs of one run_id could measure different things and the report could not say
// which.
//
// `--profile` exists because a plan CANNOT be re-planned after its wave merged:
// adding `observations` to the profile derives a new run id (the whole resolved
// profile is in the hash), and the run being observed already happened. Observing
// is read-only and post-merge, so reading the profile file directly cannot touch
// the plan's purity — but it IS a different source, so it is named in the report
// and raises a notice.
function resolveObservations(inputs, plan) {
  if (inputs.profilePath !== null) {
    const profile = loadJson(inputs.profilePath, 'profile');
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new SkillError('load_error', 'profile must be a JSON object', 6);
    }
    return { source: 'profile_file', path: inputs.profilePath, observations: normalizeObservations(profile.observations) ?? [] };
  }
  return { source: 'plan', path: inputs.planPath, observations: plan.profile.observations ?? [] };
}

// =============================================================================
// CLI invocation
// =============================================================================

// One structured call to an external CLI. Never throws: the caller decides what a
// non-zero exit means, and here it usually means "this observation is not
// available", never "the observation is bad".
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

function jsonOf(result) {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// `gh pr create --base` and `gh run list --branch` want a branch name, while a
// profile base is a tracking ref like "origin/develop". Same rule merge.mjs uses.
function baseBranchName(base) {
  return String(base).replace(/^[A-Za-z0-9._-]+\//, '');
}

function excerpt(text, limit = 200) {
  const clean = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

// =============================================================================
// The merge facts the merge report does NOT carry (fixed by the Issue)
// =============================================================================
//
// merge-report.v1 records `pr_number` and `merged: bool` and stops there: there
// is no `mergedAt` and no merge commit anywhere in it, and there never was.
// Every window this runner opens starts at the moment of the merge, so both are
// read from GitHub with `gh pr view --json mergedAt,mergeCommit` and written into
// THIS report — an observation window whose start nobody recorded is an
// observation nobody can re-check.
//
// When they cannot be read, that issue is `not_observable` WITH THE REASON. It is
// never approximated from the report's own timestamps: a window that starts at a
// guessed instant silently attributes runs to a merge that did not cause them.
function readMergeFacts(inputs, repository, prNumber) {
  const result = runCli(inputs.gh, [
    'pr', 'view', String(prNumber),
    '--repo', repository,
    '--json', 'mergedAt,mergeCommit',
  ]);
  const document = jsonOf(result);
  if (document === null) {
    return {
      mergedAt: null,
      mergeCommit: null,
      note: `\`gh pr view ${prNumber} --json mergedAt,mergeCommit\` could not be read`
        + `${result.ok ? ' (the answer was not JSON)' : ` (${excerpt(result.stderr || result.stdout || 'no output', 160)})`}`,
    };
  }
  const mergedAt = typeof document.mergedAt === 'string' && document.mergedAt !== '' ? document.mergedAt : null;
  const oid = document.mergeCommit && typeof document.mergeCommit === 'object' ? document.mergeCommit.oid : null;
  const mergeCommit = typeof oid === 'string' && oid !== '' ? oid : null;
  if (mergedAt === null) {
    return {
      mergedAt: null,
      mergeCommit,
      note: `PR #${prNumber} reports no mergedAt, so the start of the observation window is unknown`,
    };
  }
  if (Number.isNaN(Date.parse(mergedAt))) {
    return { mergedAt: null, mergeCommit, note: `PR #${prNumber} reports a mergedAt this runner cannot parse` };
  }
  return { mergedAt, mergeCommit, note: null };
}

// =============================================================================
// Collection
// =============================================================================

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function secondsBetween(from, to) {
  const start = Date.parse(String(from ?? ''));
  const end = Date.parse(String(to ?? ''));
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return round3((end - start) / 1000);
}

// The runs of one workflow on the base branch that were CREATED after this
// issue's merge, oldest first, capped at `runs`.
//
// Oldest first is the literal reading of "the N runs after the merge", and it is
// also the reading that makes case 1 visible: the outliers are runs 1 and 2, and
// a report that silently started at run 3 would be choosing the answer.
function listRunsAfter(inputs, repository, base, workflow, mergedAt, runs) {
  const limit = Math.min(RUN_LIST_CEILING, Math.max(RUN_LIST_FLOOR, runs * 4));
  const result = runCli(inputs.gh, [
    'run', 'list',
    '--repo', repository,
    '--workflow', workflow,
    '--branch', baseBranchName(base),
    '--limit', String(limit),
    '--json', 'databaseId,url,status,conclusion,createdAt,startedAt,updatedAt',
  ]);
  const document = jsonOf(result);
  if (document === null || !Array.isArray(document)) {
    return {
      rows: null,
      note: `\`gh run list --workflow ${workflow}\` could not be read`
        + `${result.ok ? ' (the answer was not a JSON array)' : ` (${excerpt(result.stderr || result.stdout || 'no output', 160)})`}`,
    };
  }
  const cutoff = Date.parse(mergedAt);
  const rows = document
    .filter((row) => row !== null && typeof row === 'object')
    .filter((row) => {
      const created = Date.parse(String(row.createdAt ?? ''));
      return !Number.isNaN(created) && created > cutoff;
    })
    .sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)))
    .slice(0, runs);
  return { rows, note: null };
}

// A run that has not concluded has no duration to report; a run that concluded
// as anything other than `success` measured an execution that did not do the
// work. Both are excluded from the aggregate and both are COUNTED — the bucket
// key is the GitHub conclusion verbatim, or `in_progress` for a run that has not
// concluded at all.
function runBucket(row) {
  if (String(row.status ?? '') !== 'completed') return 'in_progress';
  const conclusion = String(row.conclusion ?? '');
  return conclusion === '' ? 'in_progress' : conclusion;
}

function ghRunSamples(inputs, repository, base, declaration, mergedAt, runs) {
  const { rows, note } = listRunsAfter(inputs, repository, base, declaration.workflow, mergedAt, runs);
  if (rows === null) return { samples: [], note };
  const samples = rows.map((row) => {
    const bucket = runBucket(row);
    const value = secondsBetween(row.startedAt ?? row.createdAt, row.updatedAt);
    return {
      run_id: Number.isSafeInteger(row.databaseId) ? row.databaseId : null,
      url: typeof row.url === 'string' ? redact(row.url) : null,
      conclusion: bucket,
      value: bucket === 'success' ? value : null,
      counted: bucket === 'success' && value !== null,
      note: bucket === 'success' && value === null ? 'the run carries no readable start/end timestamp' : '',
    };
  });
  return { samples, note: null };
}

// The step, not the run (measured case 2). `setup-node` alone varied by 28
// seconds between runs of the same workflow, so a criterion about the e2e time
// read off the run's wall clock is measuring the wrong thing.
function jobStepSeconds(inputs, repository, runId, jobName, stepName) {
  const result = runCli(inputs.gh, ['api', `repos/${repository}/actions/runs/${runId}/jobs`]);
  const document = jsonOf(result);
  if (document === null || !Array.isArray(document.jobs)) {
    return { value: null, conclusion: 'jobs_unavailable', note: excerpt(result.stderr || result.stdout || 'the jobs API answer could not be read', 160) };
  }
  const job = document.jobs.find((entry) => entry !== null && typeof entry === 'object' && String(entry.name ?? '') === jobName);
  if (job === undefined) {
    return { value: null, conclusion: 'job_not_found', note: `run ${runId} has no job named "${redact(jobName)}"` };
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const step = steps.find((entry) => entry !== null && typeof entry === 'object' && String(entry.name ?? '') === stepName);
  if (step === undefined) {
    return { value: null, conclusion: 'step_not_found', note: `job "${redact(jobName)}" of run ${runId} has no step named "${redact(stepName)}"` };
  }
  const conclusion = String(step.conclusion ?? '') === '' ? 'in_progress' : String(step.conclusion);
  const value = secondsBetween(step.started_at, step.completed_at);
  return {
    value: conclusion === 'success' ? value : null,
    conclusion,
    note: conclusion === 'success' && value === null ? 'the step carries no readable start/end timestamp' : '',
  };
}

function ghJobStepSamples(inputs, repository, base, declaration, mergedAt, runs) {
  const { rows, note } = listRunsAfter(inputs, repository, base, declaration.workflow, mergedAt, runs);
  if (rows === null) return { samples: [], note };
  const samples = rows.map((row) => {
    const runId = Number.isSafeInteger(row.databaseId) ? row.databaseId : null;
    const url = typeof row.url === 'string' ? redact(row.url) : null;
    const bucket = runBucket(row);
    if (runId === null) {
      return { run_id: null, url, conclusion: bucket, value: null, counted: false, note: 'the run carries no id, so its jobs cannot be read' };
    }
    if (bucket === 'in_progress') {
      // Not asked for: a run still going has no completed step to measure, and
      // querying it would spend an API call to learn what the list already said.
      return { run_id: runId, url, conclusion: 'in_progress', value: null, counted: false, note: '' };
    }
    const step = jobStepSeconds(inputs, repository, runId, declaration.job, declaration.step);
    return {
      run_id: runId,
      url,
      conclusion: step.conclusion,
      value: step.value,
      counted: step.value !== null,
      note: step.note,
    };
  });
  return { samples, note: null };
}

// A number printed on stdout by a command run in a throwaway detached checkout of
// the MERGE COMMIT — the state of the base branch immediately after this issue
// landed, which is a stronger claim than "the tip right now" and is available
// because `gh pr view` already gave us the oid.
//
// The command is split on whitespace and spawned WITHOUT a shell, the same rule
// `baseline` and `integration_baseline` follow. Nothing is judged: a command that
// exits non-zero or prints no number yields an excluded sample with a reason.
function commandSamples(inputs, repository, base, declaration, mergeCommit, runs, treeDir, limitations) {
  if (mergeCommit === null) {
    return { samples: [], note: 'the merge commit is unknown, so the state to measure cannot be checked out' };
  }
  const branch = baseBranchName(base);
  const fetched = runCli(inputs.git, ['fetch', 'origin', branch]);
  if (!fetched.ok) {
    return { samples: [], note: `origin/${branch} could not be fetched (${excerpt(fetched.stderr || fetched.stdout || 'git fetch did not exit 0', 160)})` };
  }
  const added = runCli(inputs.git, ['worktree', 'add', '--detach', treeDir, mergeCommit]);
  if (!added.ok) {
    return { samples: [], note: `${mergeCommit.slice(0, 7)} could not be checked out (${excerpt(added.stderr || added.stdout || 'git worktree add did not exit 0', 160)})` };
  }
  const argv = String(declaration.command).split(/\s+/).filter(Boolean);
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    if (argv.length === 0) {
      samples.push({ run_id: null, url: null, conclusion: 'command_unavailable', value: null, counted: false, note: 'the declared command is empty' });
      continue;
    }
    const result = runCli(argv[0], argv.slice(1), { cwd: treeDir });
    if (!result.ok) {
      samples.push({
        run_id: null,
        url: null,
        conclusion: 'command_unavailable',
        value: null,
        counted: false,
        note: excerpt(result.stderr || result.stdout || 'the command did not exit 0', 160),
      });
      continue;
    }
    const value = lastNumberOnStdout(result.stdout);
    samples.push({
      run_id: null,
      url: null,
      conclusion: value === null ? 'no_number_on_stdout' : 'ok',
      value,
      counted: value !== null,
      note: value === null ? excerpt(result.stdout || '(no output)', 120) : '',
    });
  }
  // Best effort, and said out loud when it does not work: a checkout nobody knows
  // about is a surprise the next `git worktree add` reports instead of this run.
  const removed = runCli(inputs.git, ['worktree', 'remove', '--force', treeDir]);
  if (!removed.ok) {
    limitations.push({
      code: 'observe_tree_left',
      detail: `the throwaway checkout used for observation "${declaration.id}" could not be removed `
        + `(${excerpt(removed.stderr || removed.stdout || 'git worktree remove did not exit 0', 160)}); `
        + 'it is under this run\'s --out directory — remove it with `git worktree remove --force`',
    });
  }
  return { samples, note: null };
}

// The LAST line of stdout that is entirely a number. Last rather than first so a
// measurement script may log on its way to the answer, and "entirely" so a line
// like "built in 3 steps" is not mistaken for a value.
function lastNumberOnStdout(stdout) {
  const lines = String(stdout).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === '' || !/^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(line)) continue;
    const value = Number(line);
    if (Number.isFinite(value)) return round3(value);
  }
  return null;
}

function collectOnce(inputs, repository, base, declaration, facts, treeDir, limitations) {
  if (declaration.kind === 'gh_run') {
    return ghRunSamples(inputs, repository, base, declaration, facts.mergedAt, inputs.runs);
  }
  if (declaration.kind === 'gh_job_step') {
    return ghJobStepSamples(inputs, repository, base, declaration, facts.mergedAt, inputs.runs);
  }
  return commandSamples(inputs, repository, base, declaration, facts.mergeCommit, inputs.runs, treeDir, limitations);
}

// =============================================================================
// Aggregation
// =============================================================================

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round3(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function mean(values) {
  if (values.length === 0) return null;
  return round3(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Every sample that did NOT enter the aggregate, tallied by the reason it did
// not. Ordered by first appearance so the report's bytes are a function of the
// series and not of a Map's iteration accident.
function exclusionsOf(samples) {
  const tally = new Map();
  for (const sample of samples) {
    if (sample.counted) continue;
    const key = sample.conclusion ?? 'unknown';
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()].map(([conclusion, count]) => ({ conclusion, count }));
}

// The "before" value, looked up by id in whatever document `--inspect` names.
//
// NO artifact format is assumed. The Issue's companion work (#218) was being
// implemented in the same wave, so depending on its shape would have meant
// depending on something that did not exist yet. The rule is therefore the
// weakest one that is still unambiguous: the first object anywhere in the
// document that has this id and a finite number under `value` (preferred) or
// `median`. No match is `baseline: null` — which is a fact, not a defect.
function findBaseline(document, id) {
  const stack = [{ node: document, path: '' }];
  while (stack.length > 0) {
    const { node, path } = stack.shift();
    if (node === null || typeof node !== 'object') continue;
    if (!Array.isArray(node) && String(node.id ?? '') === id) {
      for (const key of ['value', 'median']) {
        const candidate = node[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return { value: round3(candidate), source: `${path}/${key}` };
        }
      }
    }
    const entries = Array.isArray(node)
      ? node.map((child, index) => [String(index), child])
      : Object.entries(node);
    for (const [key, child] of entries) stack.push({ node: child, path: `${path}/${key}` });
  }
  return { value: null, source: null };
}

function summarize(declaration, samples, note, baseline, runs) {
  const counted = samples.filter((sample) => sample.counted);
  const values = counted.map((sample) => sample.value);
  return {
    id: declaration.id,
    kind: declaration.kind,
    unit: declaration.unit,
    requested: runs,
    collected: samples.length,
    counted: counted.length,
    complete: samples.length === runs,
    samples,
    excluded: exclusionsOf(samples),
    median: median(values),
    mean: mean(values),
    baseline: baseline.value,
    baseline_source: baseline.source,
    note: note === null ? '' : redact(note),
  };
}

// =============================================================================
// Waiting
// =============================================================================

// A synchronous sleep. Node stdlib only and this runner is a straight-line
// script, so there is no event loop to yield to.
function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// =============================================================================
// Reporting
// =============================================================================

const KIND_LABELS = {
  gh_run: 'run 全体の wall-clock',
  gh_job_step: 'job step の所要',
  command: 'merge commit 上の command',
};

// One table row per SAMPLE, excluded ones included. This is the whole point of
// the summary: case 1 was a median read without the series under it, and a
// median that is not accompanied by its runs is a number nobody can check.
//
// The conclusion is the LAST column and every cell in it is a value transcribed
// from GitHub (or a reason token for a non-gh kind). It is the only place in this
// document where a word from somebody else's vocabulary appears.
function renderObservation(entry, issueNumber) {
  const lines = [
    '',
    `#### #${issueNumber} / \`${entry.id}\`（${KIND_LABELS[entry.kind] ?? entry.kind}・単位 ${entry.unit}）`,
    '',
    `| # | run | 値（${entry.unit}） | URL | conclusion |`,
    '|---|---|---|---|---|',
  ];
  for (const [index, sample] of entry.samples.entries()) {
    lines.push(
      `| ${index + 1} | ${sample.run_id === null ? '—' : sample.run_id} | `
        + `${sample.value === null ? '—' : sample.value} | ${sample.url === null ? '—' : sample.url} | ${sample.conclusion} |`,
    );
  }
  if (entry.samples.length === 0) lines.push('| — | — | — | — | — |');
  lines.push('');
  lines.push(
    `- 収集 ${entry.collected} / 要求 ${entry.requested} 件、集計に入れたのは ${entry.counted} 件。`
      + `中央値 ${entry.median === null ? '—' : entry.median} ${entry.unit} / 平均 ${entry.mean === null ? '—' : entry.mean} ${entry.unit}。`,
  );
  if (entry.excluded.length > 0) {
    lines.push(
      `- 集計から除外 ${entry.excluded.reduce((sum, item) => sum + item.count, 0)} 件（`
        + `${entry.excluded.map((item) => `${item.conclusion}: ${item.count}`).join(' / ')}）。**黙って落としていない。**`,
    );
  }
  lines.push(
    entry.baseline === null
      ? '- 着手前の値: **無い**（`--inspect` に同 id の数値が無かったか、渡していない）。差分は出していない。'
      : `- 着手前の値: ${entry.baseline} ${entry.unit}（\`${entry.baseline_source}\`）。`
        + `差は ${entry.median === null ? '—' : round3(entry.median - entry.baseline)} ${entry.unit}。`,
  );
  if (entry.note !== '') lines.push(`- 観測できなかった理由: ${entry.note}`);
  if (!entry.complete) {
    lines.push(`- **${entry.requested} 件を要求して ${entry.collected} 件しか集まっていない。** 足りないまま出している。`);
  }
  return lines;
}

function renderSummary(report) {
  const lines = [
    '## 目的',
    'merge 後の base branch で、profile が宣言した観測を集めた記録である。'
      + '**この runner は採否を決めない** —— `status` は集まり具合だけを表し、数字の読み方は人間が決める。',
    '',
    '## 収集条件',
    `- 対象: ${report.repository} の \`${report.base}\`。観測の宣言元は `
      + `${report.observations_source === 'plan' ? '`plan.profile.observations`' : '`--profile` が指す profile file'}。`,
    `- 要求件数 \`--runs ${report.runs_requested}\`、待ち時間の上限 ${report.max_wait_sec} 秒。`,
    `- 観測 ${report.observations_declared.length} 件 × 対象 Issue ${report.issues === null ? 0 : report.issues.length} 件。`,
  ];
  for (const issue of report.issues ?? []) {
    lines.push('', `### #${issue.issue}（PR #${issue.pr_number === null ? '—' : issue.pr_number}）`);
    if (!issue.observable) {
      lines.push(`- **観測できない**（\`not_observable\`）。${issue.note}`);
      continue;
    }
    lines.push(
      `- merge: ${issue.merged_at}`
        + `${issue.merge_commit === null ? '（merge commit は取れていない）' : ` / \`${issue.merge_commit.slice(0, 7)}\``}。`
        + 'この2つは merge-report.json には無く、`gh pr view --json mergedAt,mergeCommit` で取った。',
    );
    for (const entry of issue.observations) lines.push(...renderObservation(entry, issue.issue));
  }
  lines.push(
    '',
    '## この記録の読み方',
    '- **中央値だけを見ない。** 上の表は全 run を並べてある —— merge 直後の 1〜2 本が外れ値で、'
      + '3 run の中央値が「未達」と読めて 8 run の中央値が逆を言った事例（CommandMate#1835）がこの表の理由である。',
    '- **run 全体の時間には `setup-node` 等のばらつきが乗る。** step についての受入条件なら `gh_job_step` で採る。',
    '- **少ない run では出ない不良がある。** 5 run 目で初めて出た事例がある。`--runs` を増やして取り直すのは安い。',
    '- **除外した run は件数として上に出ている。** 除外は「無かったこと」ではない。',
  );
  if (report.limitations.length > 0) {
    lines.push('', '## 制約');
    for (const limitation of report.limitations) lines.push(`- \`${limitation.code}\`: ${limitation.detail}`);
  }
  return lines.join('\n');
}

// Deliberately NOT called `passed`. Nothing in this document adjudicates, and a
// field named after a verdict is how a verdict gets read into one.
function completionChecks(report) {
  const issues = report.issues ?? [];
  const observations = issues.flatMap((issue) => issue.observations);
  const checks = [
    {
      id: 'no_adjudication',
      satisfied: true,
      detail: '観測を集めただけで、採否は決めていない（status は集まり具合である）',
    },
    {
      id: 'every_sample_listed',
      satisfied: observations.every((entry) => entry.samples.length === entry.collected),
      detail: `全 ${observations.reduce((sum, entry) => sum + entry.samples.length, 0)} sample を1件ずつ report と summary に並べている`,
    },
    {
      id: 'exclusions_counted',
      satisfied: observations.every(
        (entry) => entry.excluded.reduce((sum, item) => sum + item.count, 0) === entry.collected - entry.counted,
      ),
      detail: '集計に入れなかった sample は件数として明記している（黙って落としていない）',
    },
    {
      id: 'merge_facts_from_github',
      satisfied: issues.every((issue) => !issue.observable || issue.merged_at !== null),
      detail: 'mergedAt / merge commit は merge-report.json ではなく gh pr view から取り、この report に記録した',
    },
    {
      id: 'writes_only_when_approved',
      satisfied: report.comment.written.length === 0 || (report.comment.requested && report.comment.approved),
      detail: report.comment.written.length === 0
        ? 'GitHub へは1 byte も書いていない'
        : '--comment --approve が揃っているのでコメントだけを書いた（本文は触っていない）',
    },
  ];
  return { satisfied: checks.every((check) => check.satisfied), checks };
}

function buildReport(fields) {
  return {
    observe_schema_version: OBSERVE_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    status: fields.status,
    runs_requested: fields.runsRequested,
    max_wait_sec: fields.maxWaitSec,
    plan_run_id: fields.planRunId,
    out_dir: fields.outDir,
    repository: fields.repository,
    base: fields.base,
    observations_source: fields.observationsSource,
    observations_declared: fields.observationsDeclared,
    issues: fields.issues,
    comment: fields.comment,
    artifacts: fields.artifacts,
    errors: fields.errors,
    limitations: fields.limitations,
    redactions: redactionsList(),
    completion_check: fields.completionCheck,
    summary_markdown: fields.summary,
  };
}

// The refusal envelope. `status: "refused"` rather than the house `failure`,
// because this document has exactly one status vocabulary and it is about
// COLLECTION: `success` and `partial` say how much was collected, and a third
// value has to say "nothing was, and here is why" without borrowing a word that
// reads as a verdict on the work. `issues: null` carries the same distinction
// inspect.mjs's `inspection: null` does — "we could not look" must never come
// back looking like "we looked and there was nothing".
function observeRefusal(error) {
  const detail = redact(error.detail ?? error.message);
  return buildReport({
    status: 'refused',
    runsRequested: 0,
    maxWaitSec: 0,
    planRunId: null,
    outDir: null,
    repository: 'unknown/unknown',
    base: 'unknown',
    observationsSource: null,
    observationsDeclared: [],
    issues: null,
    comment: { requested: false, approved: false, written: [] },
    artifacts: [],
    errors: [{ code: error.code, detail }],
    limitations: [],
    completionCheck: {
      satisfied: false,
      checks: [
        { id: 'no_adjudication', satisfied: true, detail: '入力を受け付けなかったのであって、観測を裁定してはいない' },
        { id: 'every_sample_listed', satisfied: true, detail: '1 sample も集めていない' },
        { id: 'exclusions_counted', satisfied: true, detail: '除外すべき sample が無い' },
        { id: 'merge_facts_from_github', satisfied: false, detail: 'gh pr view に到達していない' },
        { id: 'writes_only_when_approved', satisfied: true, detail: 'GitHub へは1 byte も書いていない' },
      ],
    },
    summary: `## 結論\n観測していない（${error.code}）。${detail}`,
  });
}

// =============================================================================
// The one write (Issue #221)
// =============================================================================
//
// `gh issue comment <n> --body-file <path>`. A COMMENT, on the issue, with the
// body untouched — SKILL.md §1 puts automatic issue-body editing out of scope and
// this does not move that line. The body posted is byte-identical to the
// report's `summary_markdown`, which is why the summary is rendered before this
// runs and never re-rendered after it.
function postComments(inputs, repository, issues, outDir, summary, report) {
  const written = [];
  for (const issue of issues) {
    if (!issue.observable) continue;
    const bodyPath = join(outDir, `observe-comment-${issue.issue}.md`);
    try {
      writeFileSync(bodyPath, `${summary}\n`, 'utf8');
    } catch (error) {
      written.push({ issue: issue.issue, ok: false, note: `the comment body could not be written locally: ${excerpt(error.message, 120)}` });
      continue;
    }
    const result = runCli(inputs.gh, ['issue', 'comment', String(issue.issue), '--repo', repository, '--body-file', bodyPath]);
    written.push({
      issue: issue.issue,
      ok: result.ok,
      note: result.ok ? '' : excerpt(result.stderr || result.stdout || 'gh issue comment did not exit 0', 160),
    });
    if (!result.ok) {
      report.limitations.push({
        code: 'comment_not_written',
        detail: `the observation summary could not be posted as a comment on #${issue.issue} `
          + `(${excerpt(result.stderr || result.stdout || 'gh issue comment did not exit 0', 160)}); `
          + 'the report and its summary are on disk under --out, so nothing is lost — post it by hand or re-run',
      });
    }
  }
  return written;
}

// =============================================================================
// Entry point
// =============================================================================

function observedTargets(merge) {
  return merge.targets.filter((target) => target !== null && typeof target === 'object' && target.merged === true);
}

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  const plan = validatePlan(loadJson(inputs.planPath, 'plan'));
  const merge = validateMerge(loadJson(inputs.mergePath, 'merge report'));
  const declared = resolveObservations(inputs, plan);

  if (declared.observations.length === 0) {
    throw new SkillError(
      'observations_undeclared',
      `${declared.source === 'plan' ? 'plan.profile' : 'the profile file'} declares no observations, so there is `
        + 'nothing for this runner to collect. Declare them in the profile\'s `observations` field '
        + '(references/profile-contract.md §12) — an empty run is not reported as an observation that was made',
      3,
    );
  }

  const targets = observedTargets(merge);
  if (targets.length === 0) {
    throw new SkillError(
      'nothing_merged',
      `the merge report at ${redact(inputs.mergePath)} records no target with merged: true, so no base branch `
        + 'moved and there is no post-merge state to observe. Observe the run that actually merged',
      3,
    );
  }

  const repository = plan.profile.repository;
  const base = plan.profile.base;
  const outDir = inputs.outDir ?? join(dirname(inputs.mergePath), 'observe');
  if (existsSync(outDir)) {
    throw new SkillError('out_exists', `observe directory ${redact(outDir)} already exists; refusing to overwrite`, 4);
  }
  mkdirSync(outDir, { recursive: true });

  const inspectDocument = inputs.inspectPath === null ? null : loadJson(inputs.inspectPath, 'inspect artifact');
  const limitations = [];
  if (declared.source === 'profile_file') {
    limitations.push({
      code: 'observations_from_profile_file',
      detail: `the observations were read from ${redact(declared.path)} rather than from the approved plan. `
        + 'That is the documented escape for a plan frozen before the profile declared them '
        + '(re-planning would derive a new run id, and the wave being observed has already merged), '
        + 'and it is recorded because the plan and the file can differ',
    });
  }

  const issues = [];
  const deadline = Date.now() + inputs.maxWaitSec * 1000;
  for (const target of targets) {
    const number = target.issue;
    const prNumber = typeof target.pr_number === 'number' ? target.pr_number : null;
    if (prNumber === null) {
      issues.push({
        issue: number,
        pr_number: null,
        merged_at: null,
        merge_commit: null,
        observable: false,
        note: 'the merge report records no PR number for this issue, so its merge instant cannot be read',
        observations: [],
      });
      limitations.push({
        code: 'not_observable',
        detail: `#${number} carries no pr_number in the merge report, so \`gh pr view\` has nothing to ask about `
          + 'and the observation window has no start. Nothing was collected for it',
      });
      continue;
    }
    const facts = readMergeFacts(inputs, repository, prNumber);
    if (facts.mergedAt === null) {
      issues.push({
        issue: number,
        pr_number: prNumber,
        merged_at: null,
        merge_commit: facts.mergeCommit,
        observable: false,
        note: redact(facts.note ?? 'the merge instant could not be read'),
        observations: [],
      });
      limitations.push({
        code: 'not_observable',
        detail: `#${number}: ${redact(facts.note ?? 'the merge instant could not be read')}. `
          + 'The window every observation opens starts at the merge, and it is never guessed — '
          + 'a window with an invented start attributes runs to a merge that did not cause them',
      });
      continue;
    }

    const collected = [];
    for (const declaration of declared.observations) {
      let attempt = collectOnce(
        inputs, repository, base, declaration, facts,
        join(outDir, `${COMMAND_TREE_PREFIX}-${number}-${declaration.id}`), limitations,
      );
      // `--max-wait` is the only place this runner spends wall clock. It re-asks
      // for the SAME window until the samples are there or the budget is gone,
      // and when the budget runs out it publishes what it has and says so
      // (Issue #165's discipline: name the truncation, do not round it away).
      while (attempt.samples.length < inputs.runs && Date.now() < deadline) {
        sleepSeconds(Math.min(inputs.pollIntervalSec, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))));
        attempt = collectOnce(
          inputs, repository, base, declaration, facts,
          join(outDir, `${COMMAND_TREE_PREFIX}-${number}-${declaration.id}`), limitations,
        );
      }
      const baseline = inspectDocument === null ? { value: null, source: null } : findBaseline(inspectDocument, declaration.id);
      if (inspectDocument !== null && baseline.value === null) {
        limitations.push({
          code: 'baseline_unavailable',
          detail: `the --inspect document carries no numeric value under id "${declaration.id}", so the `
            + '"before" column is null for it. That is a fact about the artifact, not a defect in it',
        });
      }
      const entry = summarize(declaration, attempt.samples, attempt.note, baseline, inputs.runs);
      if (attempt.note !== null && attempt.samples.length === 0) {
        limitations.push({
          code: 'observation_unavailable',
          detail: `#${number} / "${declaration.id}": ${redact(attempt.note)}. Nothing was collected for it`,
        });
      } else if (!entry.complete) {
        limitations.push({
          code: 'observation_incomplete',
          detail: `#${number} / "${declaration.id}": ${entry.collected} of the ${inputs.runs} requested sample(s) `
            + `were available${inputs.maxWaitSec === 0 ? ' and --max-wait was 0, so nothing was waited for' : ` within --max-wait ${inputs.maxWaitSec}s`}. `
            + 'The values that WERE collected are in the report; the shortfall is stated rather than filled in',
        });
      }
      collected.push(entry);
    }

    issues.push({
      issue: number,
      pr_number: prNumber,
      merged_at: facts.mergedAt,
      merge_commit: facts.mergeCommit,
      observable: true,
      note: '',
      observations: collected,
    });
  }

  const everythingCollected = issues.every(
    (issue) => issue.observable && issue.observations.every((entry) => entry.complete),
  );

  const report = buildReport({
    status: everythingCollected ? 'success' : 'partial',
    runsRequested: inputs.runs,
    maxWaitSec: inputs.maxWaitSec,
    planRunId: typeof plan.run_id === 'string' ? plan.run_id : null,
    // Redacted, unlike merge/uat's `out_dir`, and the difference is deliberate:
    // this is the one report in the package that is DESIGNED to be published
    // (`--comment`). A host path that names somebody's home directory should not
    // be a byte away from a GitHub comment, and nothing downstream reads this
    // field as a path — the runner prints the real directory on stderr.
    outDir: redact(outDir),
    repository,
    base,
    observationsSource: declared.source,
    observationsDeclared: declared.observations,
    issues,
    comment: { requested: inputs.comment, approved: inputs.approve, written: [] },
    artifacts: [],
    errors: [],
    limitations,
    completionCheck: { satisfied: false, checks: [] },
    summary: '',
  });
  report.summary_markdown = renderSummary(report);

  // The comment goes out with the summary as it stands HERE, so the bytes posted
  // to GitHub and the bytes in `summary_markdown` are the same bytes. A comment
  // outcome therefore lands in `comment.written[]` and `limitations[]` only —
  // re-rendering the summary afterwards would make the report describe a comment
  // whose text nobody posted.
  if (inputs.comment && inputs.approve) {
    report.comment.written = postComments(inputs, repository, issues, outDir, report.summary_markdown, report);
  }
  if (report.comment.written.some((entry) => !entry.ok)) {
    report.status = 'partial';
  }
  report.completion_check = completionChecks(report);
  if (!report.completion_check.satisfied && report.status === 'success') report.status = 'partial';
  report.redactions = redactionsList();

  const reportPath = join(outDir, 'observe-report.json');
  const summaryPath = join(outDir, 'observe-summary.md');
  report.artifacts = [redact(reportPath), redact(summaryPath)];
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, rendered, 'utf8');
  writeFileSync(summaryPath, `${report.summary_markdown}\n`, 'utf8');

  process.stderr.write(
    `wrote observation artifacts to ${outDir}. This runner collects; it does not adjudicate — read the table.\n`,
  );
  return { exitCode: report.status === 'success' ? 0 : 7, stdout: rendered };
}

function main() {
  const argv = process.argv.slice(2);
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      process.stdout.write(`${JSON.stringify(observeRefusal(error), null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
