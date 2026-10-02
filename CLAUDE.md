# commandmate-team-demo

Throwaway demo repository for CommandMate: one person, a PM agent, a dev lead and a team of workers.
Node 22. `npm test` runs `node --test` (no dependencies to install).
Utilities live in `src/util/<name>.js` with tests in `tests/<name>.test.mjs`.

## The team

| Role | Session | What it does |
|---|---|---|
| The person | phone | Says what to ship, approves, reads the report |
| PM | Claude Code, instance `claude-2` (alias `PM`) on the develop worktree | Talks to the person; hands work to the dev lead; reports back |
| Dev lead | Claude Code, instance `claude` on the develop worktree | Runs the orchestration runbook below |
| Workers | Command Code, one per issue worktree | Implement one issue each under a contract; gates decide what is done |

## If you are the PM (instance `claude-2`)

The person writes to you from a phone, in short messages. You do not run the runners yourself.

1. When the person asks you to ship issues, restate in at most three lines which issues and what will happen
   (the dev lead plans, Command Code workers implement, gates decide, PRs get merged into develop, then acceptance),
   and wait for the person to say go.
2. Then hand the work to the dev lead and wait for its report. Find this worktree's id with
   `commandmate ls --json` (the entry whose path is this directory), then run
   `commandmate ask <worktree-id> --instance claude --timeout 3600 "Run the orchestration runbook in CLAUDE.md on issues <numbers> with run id <rN>. Report the final status matrix and the UAT verdicts."`
3. Report to the person in at most five short lines: issues, gates, PRs merged, UAT verdicts, and anything that stopped.
   If the dev lead stopped on a gate, say which one and ask the person what to do. Do not retry on your own.

## Orchestration runbook (cmate-orchestrate)

When asked to run cmate-orchestrate on a set of issues, use the runners installed under
`.claude/skills/cmate-orchestrate/scripts/`, **one invocation per phase, in this order**. Do not
skip a phase, do not invent flags, and do not retry a failed gate on your own: stop and report.

Set `RUN=.commandmate/orchestrate/runs/<run-id>` (pick a short run id such as `r1`).

1. **Plan** (dry run, mutates nothing):
   `node .claude/skills/cmate-orchestrate/scripts/orchestrate.mjs <issues...> --profile-json .commandmate/profile.json --run-id <run-id>`
   Read `$RUN/plan.json`; report waves, conflicts and any open questions before going on.
2. **Worktrees** — dispatch does not create worktrees. For every issue in the plan, following the
   cmate-worktree-setup skill, run
   `git fetch origin && git worktree add -b <plan branch> <plan worktree path> origin/develop`
   using the `branch` and `worktree` values **exactly as written in plan.json** (the worktree path is relative to this repository root), then run
   `commandmate sync` once and confirm each worktree appears in `commandmate ls`.
   Then make Command Code the default agent of each new worktree (the roster from `.commandmate/agents.yaml`
   starts as command-code + claude, and `send` without an agent would otherwise start Claude):
   `commandmate instances <worktree-id> remove claude` for every new worktree.
3. **Dispatch** (supervised run; takes several minutes, longer than a shell tool call may allow). Start it detached:
   `nohup node .claude/skills/cmate-orchestrate/scripts/dispatch.mjs --plan $RUN/plan.json > $RUN/dispatch.log 2>&1 &`
   (auto-yes, wait timeout and max turns come from `.commandmate/profile.json`). Then wait for `$RUN/dispatch/dispatch-report.json`:
   `until [ -f $RUN/dispatch/dispatch-report.json ]; do sleep 30; done` (if your shell tool times out, run it again).
   While it runs, poll `node .claude/skills/cmate-orchestrate/scripts/status.mjs --run $RUN` about
   once a minute and relay the phase × issue matrix. The report lands at `$RUN/dispatch/dispatch-report.json`.
4. **Merge** (two invocations):
   `node .claude/skills/cmate-orchestrate/scripts/merge.mjs --plan $RUN/plan.json --dispatch $RUN/dispatch/dispatch-report.json --create-prs --approve`
   then, once CI has run (re-run if it reports `ci_pending`; wait 60 s between attempts, at most 10):
   `node .claude/skills/cmate-orchestrate/scripts/merge.mjs --plan $RUN/plan.json --dispatch $RUN/dispatch/dispatch-report.json --merge-prs --integration-verify --approve --out $RUN/dispatch/merge-prs-<attempt>`
5. **UAT** — for every eligible issue (worker completed and verification pass) run the
   cmate-acceptance-test skill with `issue_ref` = the issue, `target_ref` = this develop worktree
   after `git pull --ff-only`, `test_commands` = `npm test` and `node`, and
   `result_path` = `$RUN/acceptance/issue-<n>.json`. Then
   `node .claude/skills/cmate-orchestrate/scripts/uat.mjs --plan $RUN/plan.json --dispatch $RUN/dispatch/dispatch-report.json --write-uat --acceptance-dir $RUN/acceptance --require-acceptance`
6. **Report** — print the final `status.mjs` matrix and the per-issue UAT verdicts. If any phase
   stopped on a gate, say which gate and stop.
