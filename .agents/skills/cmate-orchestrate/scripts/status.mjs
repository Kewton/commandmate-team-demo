#!/usr/bin/env node
// cmate-orchestrate — run status view (Node stdlib only, Node >= 22).
//
// The four runners each write their own artifact — plan.json, dispatch/
// dispatch-report.json, <phase>/merge-report.json, <phase>/uat-report.json — and
// each summary_markdown describes ONE phase. Answering "where is this run, and
// which issue is waiting on what" therefore meant opening several JSON files and
// joining them by issue number. This runner does that join and nothing else: it
// prints the phase × issue matrix that no single artifact carries.
//
// It is READ-ONLY in the strongest sense available: it reads files under the run
// directory and calls no subprocess at all. No `commandmate`, no `git`, no `gh`,
// no network. That is a contract, not an omission — a status view that probed the
// live world could report a state the artifacts do not prove, and the whole point
// of the run directory is that it is the evidence. What is displayed here is
// exactly what the artifacts say, which is why a missing artifact is reported as
// "未実行" rather than inferred from the phase before it.
//
// Three invariants follow from that, and they are the reason to prefer this over
// reading the JSON by hand:
//
//   1. Nothing is guessed. A phase with no artifact is 未実行; a phase whose
//      artifact will not parse (or carries an unsupported schema version) is
//      読取不能 and is dropped ON ITS OWN — every other phase still renders. One
//      corrupt file never blanks the view.
//   2. Nothing is rounded up. partial / blocked / failure, a completed worker
//      whose verification did not pass, a red CI, a conditional_go: all shown as
//      recorded. This runner has no notion of "close enough to success".
//   3. Every displayed value goes through the same redaction the mutating runners
//      use (lib.mjs REDACTIONS), so viewing a run cannot leak what writing it
//      redacted.
//
// Both outputs are pure functions of the artifacts — no clock, no randomness, no
// unordered iteration — so `--json` is byte-identical across runs and across
// agents (Claude/Codex parity), and two operators diffing a status view are
// diffing the run rather than their terminals.

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  isFlakyVerdict,
  loadJson,
  redact,
  redactionsList,
  validateDispatch,
} from './lib.mjs';

const STATUS_SCHEMA_VERSION = 1;
const SUPPORTED_PLAN_SCHEMA_VERSIONS = [1, 2];
const SUPPORTED_MERGE_SCHEMA_VERSION = 1;
const SUPPORTED_UAT_SCHEMA_VERSION = 1;

// The plan artifact IS the definition of a run directory ("--run <path>: the
// directory that holds plan.json"), so it is looked for at the root only. The
// other three are located by a bounded, sorted scan instead, because their
// directory is an operator choice: the defaults are `dispatch/`,
// `dispatch/<create-prs|merge-prs>/` and `dispatch/<write-uat|uat-fix>/`, and any
// of them may have been redirected with `--out`. A scan finds them wherever they
// were put inside the run; a hardcoded list would silently report 未実行 for a run
// that is merely laid out differently.
const PLAN_ARTIFACT = 'plan.json';
const SCANNED_ARTIFACTS = new Map([
  ['dispatch-report.json', 'dispatch'],
  ['merge-report.json', 'merge'],
  ['uat-report.json', 'uat'],
]);
const SCAN_MAX_DEPTH = 4;
const SCAN_MAX_ENTRIES = 20000;

const PHASES = ['plan', 'dispatch', 'merge', 'uat'];

// The phase whose absence has a specific reading. The first phase with no
// artifact is the one worth naming a command for; suggesting `merge.mjs` while
// there is no dispatch report would be advice that cannot be followed.
const PHASE_ABSENT_DETAIL = {
  plan: 'plan.json が無い',
  dispatch: 'dispatch artifact が無い。plan 承認待ち or dispatch 未実行',
  merge: 'merge artifact が無い',
  uat: 'uat artifact が無い',
};
// Why a per-issue cell says 読取不能. The parse error itself is long and belongs in
// one place — the phase-evidence table names the artifact and quotes it once.
const UNREADABLE_ISSUE_DETAIL = 'この phase の artifact が読めない。「phase の証跡」で理由を確認する';

const PHASE_ABSENT_HINT = {
  dispatch: 'plan.json を確認・承認し、dispatch.mjs --plan <plan.json> を実行する。',
  merge: 'merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> --create-prs を実行する。',
  uat: 'uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> --write-uat を実行する。',
};

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate status runner (read-only run status view)

Usage:
  status.mjs --run <run-dir> [--json]

Options:
  --run <path>           The run directory that holds plan.json (required).
                         A path to plan.json itself is accepted too.
  --json                 Emit the structured view instead of the text table.
  --help                 Show this help.

Reads only the artifacts under <run-dir>: no commandmate, git or gh is invoked and
no network is used. A phase with no artifact is reported as 未実行 and a phase whose
artifact will not parse as 読取不能 — nothing is inferred from the phase before it,
and partial / blocked / failure are shown as recorded. Exit is 0 whenever a view
was produced, however bad the news in it; read the view, not the exit code.`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        run: { type: 'string' },
        json: { type: 'boolean' },
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
  if (!values.run) {
    throw new SkillError('invalid_input', '--run <path> is required (the run directory that holds plan.json)', 3);
  }
  return { run: values.run, json: Boolean(values.json) };
}

// The run directory, from either the directory itself or its plan.json. A missing
// plan.json is a `load_error` rather than an empty view: the argument names a run
// directory, and a path that holds no plan is a wrong path — reporting "everything
// is 未実行" for a typo would be the one honest-looking answer that misleads.
function resolveRunDir(runArg) {
  const target = resolve(runArg);
  let stats;
  try {
    stats = statSync(target);
  } catch (error) {
    throw new SkillError('load_error', `cannot read run directory at ${redact(target)}: ${redact(error.message)}`, 6);
  }
  const dir = stats.isDirectory() ? target : (basename(target) === PLAN_ARTIFACT ? resolve(target, '..') : null);
  if (dir === null) {
    throw new SkillError('load_error', `--run must name a run directory or its ${PLAN_ARTIFACT}: ${redact(target)}`, 6);
  }
  if (!existsSync(join(dir, PLAN_ARTIFACT))) {
    throw new SkillError('load_error', `no ${PLAN_ARTIFACT} under ${redact(dir)}; --run must name a run directory`, 6);
  }
  return dir;
}

// =============================================================================
// Artifact discovery
// =============================================================================

// Bounded and deterministic: entries are visited in sorted order, symlinks are
// never followed (a symlink is neither isFile nor isDirectory here), depth and
// total entries are capped so a status view cannot be turned into a filesystem
// walk by an artifact directory someone filled up.
function scanArtifacts(runDir) {
  const found = new Map(PHASES.map((phase) => [phase, []]));
  found.get('plan').push(PLAN_ARTIFACT);

  let budget = SCAN_MAX_ENTRIES;
  const walk = (dir, prefix, depth) => {
    if (depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable subdirectory hides its artifacts, never the view
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (budget <= 0) return;
      budget -= 1;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const phase = SCANNED_ARTIFACTS.get(entry.name);
      if (phase !== undefined) found.get(phase).push(relative);
    }
  };
  walk(runDir, '', 1);
  return found;
}

// =============================================================================
// Artifact loading (one artifact's failure is that artifact's failure)
// =============================================================================

// A schema-version or skill-id mismatch is treated exactly like unparseable
// bytes: 読取不能. Reading fields out of a document this runner does not
// understand is how a status view starts inventing state.
function validatePlanDocument(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new SkillError('plan_invalid', 'plan must be a JSON object', 3);
  }
  if (!SUPPORTED_PLAN_SCHEMA_VERSIONS.includes(plan.plan_schema_version)) {
    throw new SkillError('plan_invalid', `unsupported plan_schema_version ${plan.plan_schema_version}; this runner understands ${SUPPORTED_PLAN_SCHEMA_VERSIONS.join(' or ')}`, 3);
  }
  if (plan.skill_id !== SKILL_ID) {
    throw new SkillError('plan_invalid', `plan.skill_id "${plan.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (!Array.isArray(plan.issues)) {
    throw new SkillError('plan_invalid', 'plan.issues is missing', 3);
  }
  return plan;
}

function validateMergeDocument(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new SkillError('merge_invalid', 'merge report must be a JSON object', 3);
  }
  if (report.merge_schema_version !== SUPPORTED_MERGE_SCHEMA_VERSION) {
    throw new SkillError('merge_invalid', `unsupported merge_schema_version ${report.merge_schema_version}; this runner understands ${SUPPORTED_MERGE_SCHEMA_VERSION}`, 3);
  }
  if (report.skill_id !== SKILL_ID) {
    throw new SkillError('merge_invalid', `merge report skill_id "${report.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (!Array.isArray(report.targets)) {
    throw new SkillError('merge_invalid', 'merge report has no targets', 3);
  }
  return report;
}

function validateUatDocument(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new SkillError('uat_invalid', 'uat report must be a JSON object', 3);
  }
  if (report.uat_schema_version !== SUPPORTED_UAT_SCHEMA_VERSION) {
    throw new SkillError('uat_invalid', `unsupported uat_schema_version ${report.uat_schema_version}; this runner understands ${SUPPORTED_UAT_SCHEMA_VERSION}`, 3);
  }
  if (report.skill_id !== SKILL_ID) {
    throw new SkillError('uat_invalid', `uat report skill_id "${report.skill_id}" is not ${SKILL_ID}`, 3);
  }
  if (!Array.isArray(report.attempts)) {
    throw new SkillError('uat_invalid', 'uat report has no attempts', 3);
  }
  return report;
}

const VALIDATORS = {
  plan: validatePlanDocument,
  // The dispatch document is validated by the shared checker the merge and uat
  // runners use, so "readable here" means the same thing as "consumable there".
  dispatch: validateDispatch,
  merge: validateMergeDocument,
  uat: validateUatDocument,
};

const ARTIFACT_LABEL = {
  plan: 'plan',
  dispatch: 'dispatch report',
  merge: 'merge report',
  uat: 'uat report',
};

function readArtifact(runDir, phase, relativePath) {
  try {
    const document = VALIDATORS[phase](loadJson(join(runDir, relativePath), ARTIFACT_LABEL[phase]));
    return { path: relativePath, state: 'ok', detail: '読取OK', document };
  } catch (error) {
    if (error instanceof SkillError) {
      return { path: relativePath, state: 'unreadable', detail: clip(error.detail ?? error.message, 200), document: null };
    }
    throw error;
  }
}

// =============================================================================
// Next-action hints — the SKILL.md §5 vocabulary, keyed by report code
// =============================================================================

// Every entry is one line of "what a human does about this", drawn from SKILL.md
// §5 (停止したとき、人間が何をするか) and the limitation table in §4. The map is
// keyed by the code the reports actually carry — a `stop_reason`, a
// `blocking_reasons[].code`, a `limitations[].code` or a plan `warnings[].code` —
// so a code that gains a hint here needs no change anywhere else.
//
// A code with no entry gets UNKNOWN_CODE_HINT rather than an invented sentence:
// pointing at the detail that IS in the report beats guessing what it means.
const NEXT_ACTION_HINTS = new Map(Object.entries({
  // ---- plan: warning / failure vocabulary ----------------------------------
  no_acceptance_criteria: 'Issue 本文に受入条件を書き足して re-plan する（run_id は本文を含む hash なので自動的に別 run になる）。',
  no_suspected_files: 'Issue 本文に対象 file を書き足して re-plan する。worker に渡す scope を空のままにしない。',
  profile_repository_mismatch: '--profile / --profile-json / --repo のどれかを渡して、対象リポジトリの意図を明示する。',
  profile_repository_override: '--repo で profile の検証が対象を失っている。verified な profile を使うか、降格を承知で進める。',
  external_dependency: 'この plan に無い Issue への依存を宣言している。依存先を plan に加えるか、依存を本文から外す。',
  // Issue #286: the same two codes are a plan warning and a dispatch limitation.
  human_only_excluded: '人がやる Issue（`human-only` ラベル）なので dispatch しない。停止でも失敗でもない。人の作業として進め、終わったら Issue を閉じる。',
  human_only_dependency: 'human-only の Issue に依存している。dispatch は人の作業を待たないので、その Issue が終わったことを人が確かめてから依存側を dispatch / merge する。',
  ambiguous_dependency_direction: 'dependency-plan.md の edge reason を読み、Issue 本文か --depends で依存の向きを一意にする。',
  unrecognized_file_extension: '既知拡張子外の path が抽出から落ちた。worker に書かせるなら `## 対象ファイル` の下に backtick で書いて re-plan する（見出しの下では拡張子によらず拾う）。',
  shadowed_file_candidate: '他候補の suffix だったため候補から落ちた。Issue 本文で path を完全形で書き直す。',
  scope_pattern_declared: 'notice。宣言 scope に glob / ディレクトリが入っている。plan は展開しないので、pattern そのものを権限として読む（`**` は階層を跨ぐ）。',
  scope_pattern_dropped: 'notice。成果物見出しの外に書いた glob / ディレクトリは scope に入っていない。worker に書かせるなら `## 対象ファイル` へ移して re-plan する。',
  prose_path_ignored: 'notice。成果物見出しを持つ Issue の、見出しの外にだけ書いた path は scope に入らず reference_files に回っている。worker に書かせるなら `## 対象ファイル` の下へ書き足して re-plan する。',
  cycle_detected: 'dependency-plan.md の edge reason を見て、Issue 本文か --depends で cycle を解く。',
  override_incomplete: '--depends の override が不完全である。両端が plan 内にある形にして再実行する。',
  dependency_order_violation: '--order の主張が DAG と矛盾している。順序を直すか --order を外す。',
  run_exists: '入力が完全に同一の再実行である。本文を直すか、--run-id / --runs-dir を渡す。',

  // ---- dispatch ------------------------------------------------------------
  open_questions: '未回答の planner question がある。blocking reason に質問の本文が出ているので、Issue 本文に回答を書いて re-plan する。',
  human_required: 'worker が人間の判断を求めている。capture の内容が report に出ているので自分で判断して答える（runner は自動応答しない）。',
  human_input_required: 'worker が人間の判断を求めている。capture の内容が report に出ているので自分で判断して答える（runner は自動応答しない）。',
  verification_not_judged: '誰も判定していない（exit 99）。再 dispatch では解けないので CommandMate 側のログを見る。判定していないものを worker に直させない。',
  worker_failed: '**まず該当 worker の `worker_turn_evidence.code` を読む**（exit 21 で `--max-turns` cap に到達した run にだけ付く。#220）。`worker_upstream_unavailable` なら Issue を分割せず待って `--resume`、`worker_produced_nothing` なら worker ログを読んで Issue を分割か書き直して re-plan、`worker_output_unreadable` ならどちらとも決めつけず手で確かめる。`worker_report` があれば worker が止めて報告している（#287）のでその文を読む。field 自体が無いなら prompt / worker ログを読む。',
  timeout: 'worker が時間内に終わっていない。--wait-timeout / --max-turns と worker の詰まりを確認する。timeout は完了ではない。',
  worker_timeout: 'worker が時間内に終わっていない。--wait-timeout / --max-turns と worker の詰まりを確認する。timeout は完了ではない。',
  // The three readings of one `--max-turns` cap (#220). Separate entries because
  // they name OPPOSITE actions: `--resume` the same plan, or re-plan the Issue.
  // The third names neither, on purpose.
  worker_upstream_unavailable: '`--max-turns` に到達したが、**worker が1ターンも実行できていない肯定的証拠がある**（上流障害）。**Issue を分割しない・re-plan しない。** 上流の復旧を待って `--resume` で同じ plan を再開する。',
  worker_produced_nothing: 'worker は実際にターンを回したうえで commit も未 commit の変更も残していない。worker ログを読み、Issue の粒度か指示の曖昧さを直して re-plan する。`--resume` だけでは同じ所で止まる。',
  worker_output_unreadable: '`--max-turns` 到達の理由を**測れていない**。**「働いて何も出なかった」とも「上流が落ちていた」とも読み替えない。** `commandmate capture <worktree-id> --json` と worker の transcript 末尾を手で読んでから、上の2つのどちらかへ進む。',
  // A worker that answered the supervision nudge by stopping and reporting
  // (#287): a different stop from the three above — the worker SAID something.
  worker_stopped_with_report: 'worker が nudge に従って**止めて報告した**。該当 worker の `worker_report.text`（blocking の detail にも同じ文）を**まず読む**。書けない理由が Issue 側にあるなら Issue を直して re-plan し、障害が解消済みなら `--resume` で再開する。報告の無い無進捗（`worker_produced_nothing` など）と同じ扱いにしない。',
  not_dispatched: 'dispatch されなかった Issue がある。worker の note（対象 file が空 / worktree 未解決）を読んで原因を潰す。',
  verification_failed: '判定して不合格である（exit 20 / 21）。落ちた gate を特定して worker へ再指示する。',
  wave_not_advanced: 'wave barrier が閉じている。同 wave の worker completion と verification の両方を確認する。',
  drift: 'plan 承認後に branch / HEAD / 権限が動いた。drift の内容を確認し、必要なら re-plan する。drift の上に dispatch しない。',
  dispatch_error: 'blocking_reasons の code を読む（open_questions / contract_unsupported / verification_not_judged など、原因ごとに対処が違う）。',
  contract_unsupported: 'CLI が実行契約に非対応である。CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで --contract-mode auto に落とす。',
  contract_disabled: '--contract-mode off を明示したため probe していない。契約裁定が要るなら auto / require で実行する。',
  contract_scope_unknown: '対象 file が空の Issue が dispatch されていない。Issue 本文に対象 file を書いて re-plan する。',
  open_questions_accepted: '未回答 question を --allow-questions で引き受けている。回答を本文へ畳み込んで re-plan するのが本筋である。',
  auto_yes_used: '--auto-yes で prompt を自動応答している。何に答えたのかを report で確認する。',
  parallelism_truncated: 'wave が max_parallel より広く、上限で切られた。--max-parallel か plan の wave 幅を見直す。',
  unsafe_worktree_target: 'worktree path が path-escape guard に弾かれた。profile の worktree_template を直す。',
  worktree_unresolved: 'worktree を解決できていない。cmate-worktree-setup で worktree を作成して再実行する。',
  worker_method_unavailable: '`--worker-method` で指定した Skill が worktree に入っていない。`commandmate skill install <skill-id>` で入れて同じコマンドを再実行する（`--out` は消費していない）。方法論なしでよいなら flag を外す。',
  worker_method_declared: '`--worker-method` 付きの run である。契約 / prompt に `## Method` 節が入っている。適用されたことは、守られたことではない。',
  worker_method_applied: '当該 Issue の task text に `## Method` 節を書いた。遵守の証拠は worker の成果物側で確認する（dispatch は測っていない）。',
  verification_unrecorded: 'completed した worker に裁定が1つも記録されていない（runner 側の欠陥）。裁定なしを pass として扱わない。',
  verification_gates_unrecorded: 'pass の根拠となった gate を report が名指しできない。GATE 行を出す CLI で再実行して根拠を残す。',
  // ---- unattended（#122 段階 A → #134 段階 B → #142 段階 C）-------------------
  // One entry for the code, not one per runner: `unattended_mode` is the same
  // declaration wherever it appears, and the per-run detail (which tightenings
  // THIS invocation implied) is in the report's own limitation text.
  unattended_mode: '`--unattended` を宣言した run である。締め付けのみを含意し（contract require / pre-flight の scope 検査 / wall-clock budget / worktree lock / 証拠と受入条件の要求）、mutation 権限は足していない。**`--approve` は含意しない。**',
  unattended_baseline: 'その Issue の worktree が dispatch 開始時どこに居たか（branch と短縮 SHA）。取り消しの起点である。untracked file・merge/push 済み・gc 済みは戻らない。',
  unattended_locked: '同じ worktree を別の dispatch run が動かしている。その run の終了を待って**同じコマンドを再実行する**（`--out` は消費していない）。死んだ run の lock は次の run が自動回収する。',
  wall_clock_budget_exhausted: '`--wall-clock-budget` に到達して打ち切った。**成功ではない。** 何に時間を使ったか（baseline / acceptance コマンドは自前の timeout を持たない）を確認し、原因を潰すか budget を実測に合わせてから `--resume` で再開する。',

  // ---- merge ---------------------------------------------------------------
  unsafe_branch: 'branch 名が safe-ref guard に弾かれた。profile の branch_template を直す。',
  push_failed: 'branch の push が失敗した。認証と remote の状態を確認して再実行する。',
  pr_create_failed: 'push / PR 作成の失敗要因を解消してから --create-prs を再実行する。',
  pr_missing: '先に --create-prs で PR を作成する。',
  pr_closed: 'PR が open でない。PR の状態を確認する。',
  ci_failed: 'CI を直す。green 無しに merge しない。',
  ci_pending: 'CI が pending、または check が0件である。green を確認してから再実行する。',
  merge_failed: 'conflict / branch protection を手で解消してから再実行する。',
  // SKILL.md §5 の merge 行。#134 で表には書いたがこの表には無く、#142 で写した
  // （#134 の実装ノート 第16.6節が「次に status を触る Issue で写す」と残した欠落）。
  change_evidence_unavailable: '宣言 scope と実変更を対比できない。対象 Issue の worktree を復旧して `git diff <base>...<branch>` が答える状態にしてから再実行する。**`--unattended` では blocking**（読めなかったを scope 内だったと読ませない）。',
  // ---- merge: unattended 段階 C（#142）-------------------------------------
  acceptance_gates_required: '無人 merge の対象 Issue に受入ゲートブロック（```acceptance-gates）が無い。**Issue 本文に書いて re-plan する。** 該当 Issue だけを除外して回す道は無い（対象集合を黙って縮めないため）。',
  issue_autoclose_not_default_branch: 'base がデフォルトブランチでないため `Resolves #n` が効かない。merge 後に Issue を手動でクローズする。',
  preflight_failed: 'gh 認証・repo 到達性・base 解決を復旧してから再実行する。',
  preflight_cli_available: 'CLI を実行可能にしてから再実行する。',
  preflight_repo_access: 'gh の認証と repo 到達性を復旧してから再実行する。',
  preflight_base_resolvable: 'base ref が解決できる状態（fetch 済み）にしてから再実行する。',
  // ---- merge: 呼び出し元 worktree の index.lock（#222）----------------------
  // どちらも notice であり、裁定を1つも変えない。hint の先頭が「merge は壊れていない」
  // なのは実測どおりの読み順である —— 症状（merge 後の `git pull` が index.lock で落ちる）
  // を「merge が壊れた」と読んで巻き戻すのが、この2 code が消そうとしている二次被害である。
  caller_index_lock_pre_existing: '呼び出し元 worktree の `index.lock` が **run の開始前から** 在った。**merge は壊れていない**（この runner は呼び出し元の index を読み書きしない）。裁定は `integration_verify.outcome` と各 target の `merged` を読む。lock は **runner が消さない** —— size 0 かつ `pgrep -fl \'git \'` に該当が無ければ stale なので人間が手で消す。原因はこの run の外に在る。',
  caller_index_lock_appeared: '呼び出し元 worktree の `index.lock` が **run の実行中に出現した**（この runner が作ったという主張ではない。merge runner に呼び出し元の index を書く git verb は無い）。**merge と統合検証の裁定は変わらない。まず `integration_verify.outcome` と `merged` を読み、merge 済みのものを巻き戻さない。** lock は runner が消さない —— size 0・mtime が run 中・`pgrep -fl \'git \'` に該当なし、の3つが揃うときだけ人間が手で消す。',

  // ---- uat -----------------------------------------------------------------
  uat_failed: 'UAT 不合格である。--create-uat-fix-worktrees の修正ループを回すか、不合格の内容を読んで人間が直す。',
  uat_failed_preview: 'preview で不合格を検出した。--approve を付けて修正ループを回すか、内容を読んで人間が直す。',
  acceptance_conditional: '受入判定が conditional_go である。条件を読んで人間が判断する（自動修正の対象ではない）。',
  max_attempts_reached: '上限まで直してもなお不合格である。unresolved_issues と next_actions を読む。success に丸めない。',
  worktree_failed: 'fix worktree を作成できなかった。既存 worktree と base の状態を確認して再実行する。',
  fix_failed: 'fix worker が修正に到達しなかった。fix prompt と worker ログを読み、指示が過大なら Issue を分割する。',
  remerge_failed: 're-merge が conflict した。conflict を手で解消してから再実行する。',
  acceptance_not_run: 'cmate-acceptance-test か cmate-uat（実機環境を立ててから判定する方）を入れて result を用意し、必要なら --require-acceptance で必須にする。',
  // ---- uat: unattended 段階 C（#142。ADR 第14.3節の実測）--------------------
  unattended_cwd_detached: 'invocation cwd が detached HEAD である。再merge（`git merge --no-ff`）はどの branch にも残らないのに成功と報告されるため、fix worktree を1つも作らずに停止した。integration branch を checkout してから再実行する。',
  unattended_cwd_branch_mismatch: 'invocation cwd の branch が `--expect-branch` と違う。再merge はその branch に入る（base branch なら review を経ずに入り、push 済みなら不可逆）ため、fix worktree を1つも作らずに停止した。integration branch を checkout してから再実行する。',

  // ---- inspect --check-references（#217）------------------------------------
  //
  // These never appear in a run directory: `inspect.mjs` has no run artifacts to
  // write and this runner reads nothing else. They are here anyway, because the
  // fallback for an unknown code is UNKNOWN_CODE_HINT — and that would make "a
  // code nobody has classified yet" and "a code with no view to show it in" the
  // same thing. An operator who pastes a code into `hintFor` gets the same
  // sentence codes-and-recovery.md §6.2 gives them.
  reference_file_missing: '本文が引く file が対象 tree に無い。path の綴りか、その file を動かした先行 Issue を確認して本文を直し、re-plan する。',
  reference_line_out_of_range: '本文の行番号が実測の行数を超えている。先行 Issue がその file を縮めている。実測を正として本文の行番号を取り直す。',
  reference_identifier_moved: '本文が指す行に識別子が無く、別の行にある。`found_at` が実測行なので、本文の `:N` をそこへ直す。',
  reference_line_count_stale: '本文の「N 行」が実測と違う。受入条件が「着手前と同じ N」の形になっていないかを確かめる（なっていれば、直さない限り先行 Issue の追加を消すのが正解になる）。',
  reference_claim_inconsistent: '本文の中で主張が食い違っている（同一 path に2つの行数主張、または同一 path:line に2つの識別子）。どちらが意図かは runner には決められないので、実測を正として本文を1つに畳む。',

  // ---- inspect --evaluate-gates（#218）--------------------------------------
  //
  // Same reason as the block above — no run view shows them, and the fallback
  // would erase the difference between "unclassified" and "nowhere to show it".
  // 正本は codes-and-recovery.md 第6.3節。
  acceptance_gate_already_satisfied: '宣言した受入ゲートが**着手前の base で既に通っている**。直しても直さなくても緑になるので、ゲートとして働かない。何が変われば赤から緑になるのかを書き直して re-plan する。',
  acceptance_gate_nondeterministic: '宣言した受入ゲートが**実行ごとに結果を変える**。出力に時刻・乱数・並び順が混ざっていないかを見る。着手後も安定して通らないので、そのままでは完了を判定できない。',
  acceptance_gate_not_evaluable: 'notice。宣言した受入ゲートを**測れなかった**（id が verify.yaml に無い / built-in / timeout / ブロックが読めない / --repo-root が base でない）。**「通った」でも「落ちた」でもない。** 理由は report の `reason` にある。',
  // ---- observe（#221）-------------------------------------------------------
  //
  // Here for the reason the inspect codes above are here, with one addition:
  // observe writes to `--out`, which is not necessarily inside a run directory,
  // and its phase model is not plan/dispatch/merge/uat — so `status.mjs` does not
  // put its artifact in the run view at all (observe-contract.md §11). That makes
  // the hint table the ONLY place an operator can look a code up, which is
  // exactly why every one of them is here rather than only the blocking ones.
  //
  // None of them is a verdict about the work. `observe.mjs` collects and does not
  // adjudicate, so each hint says what to do about the COLLECTION.
  approval_required: '`--comment` は GitHub への書き込みなので `--approve` が要る。**既定は書かない。** 観測だけしたいなら `--comment` を外して同じコマンドを回す（`--out` は消費していない）。書いてよいなら両方を付ける（書くのはコメントだけで、Issue 本文は触らない）。',
  observations_undeclared: 'profile が観測を1件も宣言していない（key が無いか `[]`）。`observations` を profile に書く（profile-contract.md 第12節）。**plan は merge 済みなので re-plan できない** —— 後から足したなら `--profile <path>` で profile file を直接読ませる（report に `observations_from_profile_file` が残る）。',
  nothing_merged: 'その merge report は1件も merge していない（preview か、対象が無かったか、最初の merge の前に止まったか）。base branch が動いていないので merge 後の状態が無い。**実際に merge した run の report を渡す。**',
  not_observable: 'その Issue の `mergedAt` が読めず、観測の窓を開けられなかった（**推測しない**: 始まりを捏造した窓は、その merge が起こしていない run をその merge に帰属させる）。`gh pr view <pr> --json mergedAt,mergeCommit` を手で叩いて認証と PR 番号を確かめ、直ってから同じコマンドを回す。他の Issue の観測は出ている。',
  observation_incomplete: '`--runs` に足りない件数しか集まっていない。**足りないまま出している**（数字は report に在る）。run が溜まってから取り直すか、`--max-wait` を渡して待つ。**3 run と 8 run で結論が逆になった実測がある**ので、件数を確かめずに中央値だけを読まないこと。',
  observation_unavailable: 'その観測を1件も集められなかった（`gh run list` / jobs API / checkout が答えなかった）。detail に理由が在る。**「観測できなかった」を「変化が無かった」と読み替えない。**',
  observations_from_profile_file: 'notice。宣言を plan ではなく `--profile` の profile file から読んだ run である（merge 済みの wave は re-plan できないための逃げ道）。plan と file は違いうるので、**どの宣言を測ったのかは report の `observations_declared` を読む。**',
  baseline_unavailable: 'notice。`--inspect` の文書に同 id の数値が無かったので着手前の値が `null` である。**artifact についての事実であって欠陥ではない。** 差分が要るなら着手前の値を持つ文書を渡して取り直す（観測そのものは揃っている）。',
  comment_not_written: 'notice。観測の要約を Issue にコメントできなかった。**観測は失われていない**（`--out` 配下に report と summary が在る）。detail の理由（認証・権限）を潰して同じコマンドを回すか、`observe-summary.md` を手で貼る。',
  observe_tree_left: 'notice。`kind: command` の使い捨て checkout を削除できなかった。`--out` 配下に残っているので `git worktree remove --force <dir>` で消す。**観測の数字は変わらない。**',

  // ---- shared --------------------------------------------------------------
  no_eligible_issues: 'dispatch report に completed かつ verification pass の Issue が無い。まず dispatch を通す。',
  completion_check_failed: 'completion check のどれかが passed でない。report の completion_check を読む。',
  runner_error: 'runner が入力を受け付けていない。blocking_reasons の detail を読み、引数と入力 artifact を直す。',
}));

const UNKNOWN_CODE_HINT = '§5 対処表に無い code である。該当 report の detail と summary_markdown を読む。';

// Codes the runners compose at runtime, so they cannot be table keys: dispatch
// emits `drift_<check>` and merge `preflight_<check>`. The prefix carries the
// action, and the suffix is already in the detail.
const HINT_PREFIXES = [
  ['drift_', 'drift'],
  ['preflight_', 'preflight_failed'],
];

function hintFor(code) {
  const direct = NEXT_ACTION_HINTS.get(code);
  if (direct !== undefined) return direct;
  for (const [prefix, alias] of HINT_PREFIXES) {
    if (code.startsWith(prefix)) return NEXT_ACTION_HINTS.get(alias) ?? UNKNOWN_CODE_HINT;
  }
  return UNKNOWN_CODE_HINT;
}

// `completed` is the one stop_reason that asks nothing of anybody.
const SILENT_STOP_REASONS = new Set(['completed']);

// =============================================================================
// Text helpers
// =============================================================================

// East Asian wide characters occupy two terminal columns. Counting code points
// instead would misalign every table that holds a Japanese cell — and 未実行 /
// 読取不能 are exactly the cells a reader scans the matrix for.
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const point = char.codePointAt(0);
    const wide =
      (point >= 0x1100 && point <= 0x115f) ||
      (point >= 0x2e80 && point <= 0x303e) ||
      (point >= 0x3041 && point <= 0x33ff) ||
      (point >= 0x3400 && point <= 0x4dbf) ||
      (point >= 0x4e00 && point <= 0x9fff) ||
      (point >= 0xa000 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padCell(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function renderTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? '')), 1),
  );
  const line = (cells) => `| ${cells.map((cell, index) => padCell(cell ?? '', widths[index])).join(' | ')} |`;
  const rule = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
  return [line(headers), rule, ...rows.map((row) => line(row))];
}

// A bounded, redacted one-liner. Free text out of an issue body or a terminal is
// already redacted by the runner that stored it; redacting again is cheap and
// makes this runner's output safe even against a hand-edited artifact.
function clip(value, limit = 96) {
  const text = redact(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function numberList(values) {
  return values.length === 0 ? 'なし' : values.map((n) => `#${n}`).join(', ');
}

// =============================================================================
// Per-phase views
// =============================================================================

// The state vocabulary, used identically at phase level and per issue:
//
//   ok          the artifact was read and it has a record for this issue
//   not_run     there is no artifact for this phase
//   unreadable  every artifact for this phase failed to parse or validate
//   no_record   the artifact was read and it says nothing about this issue
//
// `no_record` is the distinction that makes the matrix trustworthy: "merge never
// ran" and "merge ran and did not consider this issue" are different facts, and
// only the second one tells you the verification gate held.

function phaseView(phase, artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  const unreadable = artifacts.filter((artifact) => artifact.state !== 'ok');
  let state;
  if (artifacts.length === 0) state = 'not_run';
  else if (readable.length === 0) state = 'unreadable';
  else if (unreadable.length > 0) state = 'partial_read';
  else state = 'ok';

  const detail = artifacts.length === 0
    ? `未実行（${PHASE_ABSENT_DETAIL[phase]}）`
    : (readable.length === 0
      ? `読取不能（${unreadable.map((artifact) => artifact.detail).join(' / ')}）`
      : (unreadable.length > 0 ? `一部 artifact が読取不能（${unreadable.length}件）` : '読取OK'));

  return {
    state,
    detail,
    artifacts: artifacts.map((artifact) => ({
      path: artifact.path,
      state: artifact.state,
      detail: artifact.detail,
      // The per-artifact headline: what the report says about itself. Recorded
      // for a readable artifact of any phase, absent for an unreadable one.
      report: artifact.state === 'ok' ? reportHeadline(phase, artifact.document) : null,
    })),
  };
}

function reportHeadline(phase, document) {
  if (phase === 'plan') {
    return {
      run_id: String(document.run_id ?? ''),
      generated_mode: String(document.generated_mode ?? ''),
      warning_codes: (document.warnings ?? []).map((warning) => String(warning.code)),
      max_parallel: Number.isInteger(document.max_parallel) ? document.max_parallel : null,
      waves: Array.isArray(document.waves) ? document.waves.length : null,
    };
  }
  if (phase === 'dispatch') {
    return {
      status: String(document.status ?? ''),
      stop_reason: String(document.stop_reason ?? ''),
      human_required: document.human_required === true,
      waves: Array.isArray(document.waves) ? document.waves.length : null,
    };
  }
  if (phase === 'merge') {
    return {
      phase: String(document.phase ?? ''),
      status: String(document.status ?? ''),
      stop_reason: String(document.stop_reason ?? ''),
      approved: document.approved === true,
      mutated: document.mutated === true,
    };
  }
  return {
    phase: String(document.phase ?? ''),
    status: String(document.status ?? ''),
    stop_reason: String(document.stop_reason ?? ''),
    approved: document.approved === true,
    attempts_used: Number.isInteger(document.attempts_used) ? document.attempts_used : null,
    max_attempts: Number.isInteger(document.max_attempts) ? document.max_attempts : null,
  };
}

// ---- plan -------------------------------------------------------------------

function planIssueView(number, artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  const view = {
    state: 'no_record',
    detail: '',
    title: null,
    wave: null,
    depends_on: [],
    branch: null,
    classification: null,
    open_questions: 0,
  };
  if (artifacts.length === 0) return { ...view, state: 'not_run', detail: PHASE_ABSENT_DETAIL.plan };
  if (readable.length === 0) return { ...view, state: 'unreadable', detail: UNREADABLE_ISSUE_DETAIL };

  const plan = readable[readable.length - 1].document;
  const issue = (plan.issues ?? []).find((candidate) => candidate.number === number);
  if (issue === undefined) return { ...view, detail: 'plan にこの Issue の記録が無い' };

  const waves = Array.isArray(plan.waves) ? plan.waves : [];
  const waveIndex = waves.findIndex((wave) => Array.isArray(wave) && wave.includes(number));
  const dependsOn = (Array.isArray(plan.dependencies) ? plan.dependencies : [])
    .filter((edge) => edge.issue === number)
    .map((edge) => ({ issue: edge.depends_on, kind: String(edge.kind ?? '') }))
    .sort((a, b) => a.issue - b.issue);
  return {
    ...view,
    state: 'ok',
    title: clip(issue.title ?? '', 72),
    wave: waveIndex >= 0 ? waveIndex : null,
    depends_on: dependsOn,
    branch: clip(issue.branch ?? '', 72),
    classification: String(issue.classification ?? ''),
    open_questions: (Array.isArray(issue.questions) ? issue.questions : []).length,
  };
}

// ---- dispatch ---------------------------------------------------------------

function dispatchIssueView(number, artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  const view = {
    state: 'no_record',
    detail: '',
    wave_index: null,
    worker_state: null,
    verification_ran: false,
    verification_outcome: null,
    gates: [],
    flaky_gates: [],
    task_id: null,
    prompt_detected: false,
    prompt_excerpt: null,
    note: '',
  };
  if (artifacts.length === 0) return { ...view, state: 'not_run', detail: PHASE_ABSENT_DETAIL.dispatch };
  if (readable.length === 0) return { ...view, state: 'unreadable', detail: UNREADABLE_ISSUE_DETAIL };

  // Later artifacts win, and the record inside one is taken in wave order: with
  // the attempt history of #98 the last record IS the current one, and until then
  // an issue appears in exactly one wave, so this reduces to "the only record".
  let found = null;
  for (const artifact of readable) {
    for (const wave of artifact.document.waves ?? []) {
      for (const worker of wave.workers ?? []) {
        if (worker.issue === number) found = { worker, waveIndex: wave.index, artifact };
      }
    }
  }
  if (found === null) {
    return { ...view, detail: 'dispatch report にこの Issue の worker 記録が無い。dispatch されていない' };
  }
  const { worker, waveIndex } = found;
  const verification = worker.verification ?? {};
  return {
    ...view,
    state: 'ok',
    wave_index: Number.isInteger(waveIndex) ? waveIndex : null,
    worker_state: String(worker.worker_state ?? ''),
    verification_ran: verification.ran === true,
    verification_outcome: String(verification.outcome ?? ''),
    gates: (Array.isArray(verification.gates) ? verification.gates : [])
      .map((gate) => ({ id: clip(gate.id, 48), verdict: String(gate.verdict ?? '') })),
    // Listed on their own as well as inside `gates` (Issue #224). A FLAKY gate is
    // the one entry an operator scanning a wave is looking for — it failed and
    // then passed against the same tree — and in a run with twenty gates it is
    // otherwise one token in a comma-separated line. The verdict is NOT re-read
    // from it: `verification_outcome` above is the runner's exit code and stays
    // the answer to "did this pass".
    flaky_gates: (Array.isArray(verification.gates) ? verification.gates : [])
      .filter((gate) => isFlakyVerdict(gate.verdict))
      .map((gate) => clip(gate.id, 48)),
    task_id: typeof worker.task_id === 'string' ? clip(worker.task_id, 64) : null,
    prompt_detected: (worker.prompt ?? {}).detected === true,
    prompt_excerpt: (worker.prompt ?? {}).excerpt ? clip((worker.prompt ?? {}).excerpt, 160) : null,
    note: clip(worker.note ?? '', 160),
  };
}

// ---- merge ------------------------------------------------------------------

// A run can hold two merge artifacts — create_prs and merge_prs — and they carry
// COMPLEMENTARY facts about the same issue: the first has the PR number, the
// second the CI verdict and the merge. So the fields are folded across artifacts
// in sorted-path order with last-non-null-wins, and every artifact's own outcome
// stays listed in `outcomes` so nothing is hidden by the fold.
function mergeIssueView(number, artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  const view = {
    state: 'no_record',
    detail: '',
    outcomes: [],
    pr_number: null,
    pr_url: null,
    branch: null,
    ci_verdict: null,
    ci_summary: null,
    merged: false,
  };
  if (artifacts.length === 0) return { ...view, state: 'not_run', detail: PHASE_ABSENT_DETAIL.merge };
  if (readable.length === 0) return { ...view, state: 'unreadable', detail: UNREADABLE_ISSUE_DETAIL };

  let eligibleAnywhere = false;
  for (const artifact of readable) {
    const report = artifact.document;
    if ((report.eligible_issues ?? []).includes(number)) eligibleAnywhere = true;
    const target = (report.targets ?? []).find((candidate) => candidate.issue === number);
    if (target === undefined) continue;
    view.state = 'ok';
    view.outcomes.push({
      artifact: artifact.path,
      phase: String(report.phase ?? ''),
      outcome: String(target.outcome ?? ''),
      approved: report.approved === true,
      note: clip(target.note ?? '', 160),
    });
    if (target.pr_number !== null && target.pr_number !== undefined) view.pr_number = target.pr_number;
    if (target.pr_url) view.pr_url = clip(target.pr_url, 160);
    if (target.branch) view.branch = clip(target.branch, 72);
    if (target.ci_checked === true) {
      view.ci_verdict = target.ci_passed === true
        ? 'green'
        : (target.outcome === 'ci_failed' ? 'failed' : target.outcome === 'ci_pending' ? 'pending' : 'not_green');
      view.ci_summary = clip(target.ci_summary ?? '', 96);
    }
    if (target.merged === true) view.merged = true;
  }
  if (view.state === 'no_record') {
    view.detail = eligibleAnywhere
      ? 'merge report の eligible だが target まで到達していない。先の target で phase が止まった'
      : 'merge report の eligible_issues に含まれない。verification pass していない';
  }
  return view;
}

// ---- uat --------------------------------------------------------------------

// The run's verdict for an issue is its LAST assessment: the fix loop re-assesses,
// and an earlier attempt's failure is history rather than the outcome. The fix
// count is the number of attempts that actually dispatched a fix FOR THIS ISSUE,
// which is what "how many times did we try to repair it" means.
function uatIssueView(number, artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  const view = {
    state: 'no_record',
    detail: '',
    verdict: null,
    outcome: null,
    verdict_source: null,
    acceptance_state: null,
    acceptance_verdict: null,
    fix_attempts: 0,
    unresolved: false,
    conditional: false,
    note: '',
  };
  if (artifacts.length === 0) return { ...view, state: 'not_run', detail: PHASE_ABSENT_DETAIL.uat };
  if (readable.length === 0) return { ...view, state: 'unreadable', detail: UNREADABLE_ISSUE_DETAIL };

  let eligibleAnywhere = false;
  for (const artifact of readable) {
    const report = artifact.document;
    if ((report.eligible_issues ?? []).includes(number)) eligibleAnywhere = true;
    let assessment;
    let fixes = 0;
    for (const attempt of report.attempts ?? []) {
      for (const result of attempt.uat_results ?? []) {
        if (result.issue === number) assessment = result;
      }
      if ((attempt.fixes ?? []).some((fix) => fix.issue === number && fix.dispatched === true)) fixes += 1;
    }
    if ((report.unresolved_issues ?? []).includes(number)) view.unresolved = true;
    if ((report.conditional_issues ?? []).includes(number)) view.conditional = true;
    if (assessment === undefined) continue;
    view.state = 'ok';
    view.outcome = String(assessment.outcome ?? '');
    view.verdict = assessment.verdict === undefined ? null : String(assessment.verdict);
    view.verdict_source = assessment.verdict_source === undefined ? null : String(assessment.verdict_source);
    const acceptance = assessment.acceptance;
    view.acceptance_state = acceptance && acceptance.state !== undefined ? String(acceptance.state) : null;
    view.acceptance_verdict = acceptance && acceptance.verdict ? String(acceptance.verdict) : null;
    view.note = clip(assessment.note ?? '', 160);
    view.fix_attempts = fixes;
  }
  if (view.state === 'no_record') {
    view.detail = eligibleAnywhere
      ? 'uat report の eligible だが判定記録が無い'
      : 'uat report の eligible_issues に含まれない。verification pass していない';
  }
  return view;
}

// =============================================================================
// Next actions
// =============================================================================

// A blocking reason belongs to an issue when its OWN detail names that issue —
// the runners write `#<n> did not complete; …`. That is evidence, not inference:
// the alternative (attributing a run-level stop to whichever issue looks
// unfinished) is exactly the guessing this runner refuses to do. A reason that
// names no issue in the run stays at run level.
function issuesNamedIn(detail, numbers) {
  const named = new Set();
  for (const match of String(detail).matchAll(/#(\d+)\b/g)) {
    const number = Number(match[1]);
    if (numbers.includes(number)) named.add(number);
  }
  return [...named].sort((a, b) => a - b);
}

// How far this phase got, as far as its artifacts prove: null (never ran),
// 'unreadable' (ran, but we cannot tell how it went), 'stopped' (an artifact
// reports a stop_reason other than completed) or 'clean'. plan carries no
// stop_reason, so a readable plan is 'clean' even with warnings — a plan with
// warnings is a plan to read, not a phase that failed.
function phaseProgress(artifacts) {
  const readable = artifacts.filter((artifact) => artifact.state === 'ok');
  if (artifacts.length === 0) return null;
  if (readable.length === 0) return 'unreadable';
  const allCompleted = readable.every((artifact) =>
    typeof artifact.document.stop_reason !== 'string' || artifact.document.stop_reason === 'completed');
  return allCompleted ? 'clean' : 'stopped';
}

function collectNextActions(artifactsByPhase, issueNumbers) {
  const runLevel = [];
  const perIssue = new Map(issueNumbers.map((number) => [number, []]));
  const progress = new Map(PHASES.map((phase) => [phase, phaseProgress(artifactsByPhase.get(phase))]));

  const add = (target, entry) => {
    // A (phase, source, code) pair says one thing once. Two artifacts of the same
    // phase reporting the same code is one action, not two lines.
    if (target.some((existing) => existing.phase === entry.phase && existing.source === entry.source && existing.code === entry.code)) return;
    target.push(entry);
  };

  for (const phase of PHASES) {
    const artifacts = artifactsByPhase.get(phase);

    // A phase with no artifact is itself an action, for the FIRST such phase only.
    // The command is only suggested when every earlier phase actually completed:
    // telling an operator to run merge while dispatch stopped partial would be
    // advice the gates would refuse anyway.
    if (artifacts.length === 0) {
      const hint = PHASE_ABSENT_HINT[phase];
      if (hint !== undefined) {
        const stalled = PHASES.slice(0, PHASES.indexOf(phase))
          .find((earlier) => progress.get(earlier) === 'stopped' || progress.get(earlier) === 'unreadable');
        add(runLevel, {
          phase,
          source: 'not_run',
          code: 'not_run',
          detail: PHASE_ABSENT_DETAIL[phase],
          hint: stalled === undefined
            ? hint
            : (progress.get(stalled) === 'unreadable'
              ? `${stalled} の artifact が読めない。この phase は ${stalled} の artifact を入力に取るので、先に証跡を作り直す。`
              : `${stalled} が完走していないので、この phase はまだ回さない。先に ${stalled} の停止理由を解消する。`),
        });
        break; // later phases cannot be run before this one; naming them is noise
      }
      continue;
    }

    for (const artifact of artifacts) {
      if (artifact.state !== 'ok') {
        add(runLevel, {
          phase,
          source: 'unreadable',
          code: 'unreadable',
          detail: `${artifact.path}: ${artifact.detail}`,
          hint: 'artifact が読めない。JSON を確認し、壊れているなら該当 phase を再実行して証跡を作り直す。',
        });
        continue;
      }
      const document = artifact.document;

      // plan carries `warnings[]`; the three mutating runners carry a
      // `stop_reason` plus `blocking_reasons[]` and `limitations[]`.
      for (const warning of document.warnings ?? []) {
        const code = String(warning.code);
        add(runLevel, { phase, source: 'warning', code, detail: clip(warning.detail, 200), hint: hintFor(code) });
      }
      const stopReason = typeof document.stop_reason === 'string' ? document.stop_reason : null;
      if (stopReason !== null && !SILENT_STOP_REASONS.has(stopReason)) {
        add(runLevel, {
          phase,
          source: 'stop_reason',
          code: stopReason,
          detail: `status=${String(document.status ?? '')} / stop_reason=${stopReason}`,
          hint: hintFor(stopReason),
        });
      }
      for (const [source, entries] of [['blocking', document.blocking_reasons], ['limitation', document.limitations]]) {
        for (const entry of entries ?? []) {
          const code = String(entry.code);
          const detail = clip(entry.detail, 200);
          const action = { phase, source, code, detail, hint: hintFor(code) };
          const named = issuesNamedIn(entry.detail, issueNumbers);
          if (named.length === 0) {
            add(runLevel, action);
            continue;
          }
          for (const number of named) add(perIssue.get(number), action);
        }
      }
    }
  }
  return { runLevel, perIssue };
}

// =============================================================================
// The view
// =============================================================================

function issueNumbersFrom(artifactsByPhase) {
  // The plan's issue list is the run's issue list. When the plan is unreadable
  // the numbers are recovered from whatever the later phases recorded, so a run
  // with a corrupt plan still shows the issues its dispatch report proves.
  const planArtifacts = artifactsByPhase.get('plan').filter((artifact) => artifact.state === 'ok');
  if (planArtifacts.length > 0) {
    const numbers = (planArtifacts[planArtifacts.length - 1].document.issues ?? [])
      .map((issue) => issue.number)
      .filter((number) => Number.isInteger(number));
    return [...new Set(numbers)].sort((a, b) => a - b);
  }
  const numbers = new Set();
  for (const artifact of artifactsByPhase.get('dispatch')) {
    if (artifact.state !== 'ok') continue;
    for (const wave of artifact.document.waves ?? []) {
      for (const worker of wave.workers ?? []) {
        if (Number.isInteger(worker.issue)) numbers.add(worker.issue);
      }
    }
  }
  for (const phase of ['merge', 'uat']) {
    for (const artifact of artifactsByPhase.get(phase)) {
      if (artifact.state !== 'ok') continue;
      for (const number of artifact.document.eligible_issues ?? []) {
        if (Number.isInteger(number)) numbers.add(number);
      }
      for (const target of artifact.document.targets ?? []) {
        if (Number.isInteger(target.issue)) numbers.add(target.issue);
      }
      for (const attempt of artifact.document.attempts ?? []) {
        for (const result of attempt.uat_results ?? []) {
          if (Number.isInteger(result.issue)) numbers.add(result.issue);
        }
      }
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

// The run header, taken from the first artifact that carries each field. plan is
// preferred (it is the origin of run_id and profile), and a run whose plan is
// unreadable falls back to the dispatch/merge/uat copies rather than showing
// "unknown" for facts the artifacts do state.
function runIdentity(artifactsByPhase) {
  const identity = { run_id: null, profile: null };
  for (const phase of PHASES) {
    for (const artifact of artifactsByPhase.get(phase)) {
      if (artifact.state !== 'ok') continue;
      const document = artifact.document;
      const runId = phase === 'plan' ? document.run_id : document.plan_run_id;
      if (identity.run_id === null && typeof runId === 'string' && runId !== '') identity.run_id = runId;
      if (identity.profile === null && document.profile && typeof document.profile === 'object') {
        identity.profile = {
          id: clip(document.profile.id ?? '', 48),
          repository: clip(document.profile.repository ?? '', 72),
          base: clip(document.profile.base ?? '', 48),
          verified: document.profile.verified === true,
        };
      }
    }
  }
  return identity;
}

function buildView(runDir, artifactsByPhase) {
  const issueNumbers = issueNumbersFrom(artifactsByPhase);
  const phases = {};
  for (const phase of PHASES) phases[phase] = phaseView(phase, artifactsByPhase.get(phase));

  const { runLevel, perIssue } = collectNextActions(artifactsByPhase, issueNumbers);

  const issues = issueNumbers.map((number) => ({
    number,
    plan: planIssueView(number, artifactsByPhase.get('plan')),
    dispatch: dispatchIssueView(number, artifactsByPhase.get('dispatch')),
    merge: mergeIssueView(number, artifactsByPhase.get('merge')),
    uat: uatIssueView(number, artifactsByPhase.get('uat')),
    next_actions: perIssue.get(number),
  }));

  const evidenced = PHASES.filter((phase) => phases[phase].state === 'ok' || phases[phase].state === 'partial_read');
  const identity = runIdentity(artifactsByPhase);

  const view = {
    status_schema_version: STATUS_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    run: {
      // The directory is redacted like every other displayed value, so a status
      // view can be pasted into an issue without leaking a host path.
      dir: redact(runDir),
      name: basename(runDir),
      run_id: identity.run_id,
      profile: identity.profile,
    },
    latest_phase_with_evidence: evidenced.length > 0 ? evidenced[evidenced.length - 1] : null,
    phases,
    issues,
    next_actions: runLevel,
    unreadable: PHASES.flatMap((phase) => phases[phase].artifacts
      .filter((artifact) => artifact.state !== 'ok')
      .map((artifact) => ({ phase, path: artifact.path, detail: artifact.detail }))),
    // Tallied by kind only, never the value — the same channel the mutating
    // runners use. Populated last so it counts every redaction above.
    redactions: [],
  };
  view.redactions = redactionsList();
  return view;
}

// =============================================================================
// Text rendering
// =============================================================================

const MISSING_CELL = { not_run: '未実行', unreadable: '読取不能', no_record: '記録なし' };

function planCell(view) {
  if (view.state !== 'ok') return MISSING_CELL[view.state];
  const wave = view.wave === null ? 'W?' : `W${view.wave}`;
  const deps = view.depends_on.length === 0 ? '' : ` dep:${view.depends_on.map((dep) => `#${dep.issue}`).join('+')}`;
  const questions = view.open_questions > 0 ? ` Q${view.open_questions}` : '';
  return `${wave}${deps}${questions}`;
}

function dispatchCell(view) {
  if (view.state !== 'ok') return MISSING_CELL[view.state];
  const prompt = view.prompt_detected ? ' prompt!' : '';
  return `${view.worker_state}/${view.verification_outcome}${prompt}`;
}

function mergeCell(view) {
  if (view.state !== 'ok') return MISSING_CELL[view.state];
  const parts = [];
  if (view.pr_number !== null) parts.push(`PR#${view.pr_number}`);
  const last = view.outcomes[view.outcomes.length - 1];
  if (last !== undefined) parts.push(last.outcome);
  if (view.ci_verdict !== null) parts.push(`CI=${view.ci_verdict}`);
  return parts.length === 0 ? '記録なし' : parts.join(' ');
}

function uatCell(view) {
  if (view.state !== 'ok') return MISSING_CELL[view.state];
  const verdict = view.verdict ?? view.outcome ?? '';
  const fixes = view.fix_attempts > 0 ? ` fix${view.fix_attempts}` : '';
  const held = view.conditional ? ' 人間判断待ち' : '';
  return `${verdict}${fixes}${held}`;
}

function renderPhaseEvidence(view) {
  const rows = [];
  for (const phase of PHASES) {
    const phaseData = view.phases[phase];
    if (phaseData.artifacts.length === 0) {
      rows.push([phase, '-', MISSING_CELL.not_run, phaseData.detail]);
      continue;
    }
    for (const artifact of phaseData.artifacts) {
      if (artifact.state !== 'ok') {
        rows.push([phase, artifact.path, MISSING_CELL.unreadable, artifact.detail]);
        continue;
      }
      const report = artifact.report;
      const headline = phase === 'plan'
        ? `warnings=${report.warning_codes.length === 0 ? 'なし' : report.warning_codes.join(',')} / waves=${report.waves}`
        : `status=${report.status} / stop=${report.stop_reason}${report.phase ? ` / phase=${report.phase}` : ''}${
          phase === 'dispatch' ? ` / human_required=${report.human_required}` : ''}${
          phase === 'merge' ? ` / approved=${report.approved} / mutated=${report.mutated}` : ''}${
          phase === 'uat' ? ` / approved=${report.approved} / attempts=${report.attempts_used}/${report.max_attempts}` : ''}`;
      rows.push([phase, artifact.path, '読取OK', headline]);
    }
  }
  return renderTable(['phase', 'artifact', '状態', 'report'], rows);
}

function renderIssueDetail(issue) {
  const lines = [];
  const plan = issue.plan;
  const title = plan.state === 'ok' && plan.title ? ` ${plan.title}` : '';
  lines.push(`### #${issue.number}${title}`);

  if (plan.state !== 'ok') {
    lines.push(`- plan     : ${MISSING_CELL[plan.state]}（${plan.detail}）`);
  } else {
    const deps = plan.depends_on.length === 0
      ? 'なし'
      : plan.depends_on.map((dep) => `#${dep.issue}(${dep.kind})`).join(', ');
    lines.push(`- plan     : Wave ${plan.wave === null ? '?' : plan.wave} / 依存: ${deps} / branch: ${plan.branch || '（記録なし）'} / ${plan.classification}`);
    if (plan.open_questions > 0) {
      lines.push(`             未回答 question ${plan.open_questions} 件（dispatch の open question ゲートに掛かる）`);
    }
  }

  const dispatch = issue.dispatch;
  if (dispatch.state !== 'ok') {
    lines.push(`- dispatch : ${MISSING_CELL[dispatch.state]}（${dispatch.detail}）`);
  } else {
    // Transcribed, never re-read: a verdict this view has never heard of shows as
    // itself rather than being rounded to something it recognises.
    const gates = dispatch.gates.length === 0
      ? '（GATE 行の記録なし）'
      : dispatch.gates.map((gate) => `${gate.id}=${gate.verdict}`).join(', ');
    lines.push(`- dispatch : Wave ${dispatch.wave_index === null ? '?' : dispatch.wave_index} / worker_state=${dispatch.worker_state} / verification=${dispatch.verification_outcome}（ran=${dispatch.verification_ran}） / gates: ${gates}`);
    if (dispatch.flaky_gates.length > 0) {
      lines.push(`             FLAKY: ${dispatch.flaky_gates.join(', ')}（同一 tree の再実行で fail→pass。裁定は上の verification が正で、この行は再読しない）`);
    }
    if (dispatch.task_id !== null) lines.push(`             task_id: ${dispatch.task_id}`);
    if (dispatch.prompt_detected) lines.push(`             prompt 検出: ${dispatch.prompt_excerpt ?? '（excerpt なし）'}`);
    if (dispatch.note) lines.push(`             note: ${dispatch.note}`);
  }

  const merge = issue.merge;
  if (merge.state !== 'ok') {
    lines.push(`- merge    : ${MISSING_CELL[merge.state]}（${merge.detail}）`);
  } else {
    const outcomes = merge.outcomes.map((entry) => `${entry.phase}=${entry.outcome}${entry.approved ? '' : '(preview)'}`).join(' / ');
    lines.push(`- merge    : ${outcomes} / merged=${merge.merged}`);
    if (merge.pr_number !== null || merge.pr_url !== null) {
      lines.push(`             PR: ${merge.pr_number === null ? '（番号なし）' : `#${merge.pr_number}`} ${merge.pr_url ?? ''}`.trimEnd());
    }
    if (merge.ci_verdict !== null) lines.push(`             CI: ${merge.ci_verdict}（${merge.ci_summary}）`);
  }

  const uat = issue.uat;
  if (uat.state !== 'ok') {
    lines.push(`- uat      : ${MISSING_CELL[uat.state]}（${uat.detail}）`);
  } else {
    const verdict = uat.verdict === null ? `outcome=${uat.outcome}` : `verdict=${uat.verdict}（outcome=${uat.outcome}）`;
    lines.push(`- uat      : ${verdict} / fix attempt ${uat.fix_attempts} 回${uat.verdict_source === null ? '' : ` / source=${uat.verdict_source}`}`);
    if (uat.acceptance_state !== null) {
      lines.push(`             意味ゲート: state=${uat.acceptance_state} / verdict=${uat.acceptance_verdict ?? 'なし'}`);
    }
    if (uat.unresolved) lines.push('             unresolved（この run の停止時点で不合格）');
    if (uat.conditional) lines.push('             conditional_go（人間の判断待ち。自動修正の対象ではない）');
    if (uat.note) lines.push(`             note: ${uat.note}`);
  }

  if (issue.next_actions.length === 0) {
    lines.push('- 次       : （この Issue を名指しした blocking reason は無い）');
  } else {
    for (const action of issue.next_actions) {
      lines.push(`- 次       : [${action.phase} ${action.source} ${action.code}] ${action.hint}`);
      lines.push(`             根拠: ${action.detail}`);
    }
  }
  return lines;
}

function renderText(view) {
  const lines = [];
  lines.push('# cmate-orchestrate run status（read-only。証跡が証明する範囲のみ）');
  lines.push('');
  lines.push(`run       : ${view.run.name}`);
  lines.push(`run dir   : ${view.run.dir}`);
  lines.push(`run_id    : ${view.run.run_id ?? '（不明）'}`);
  lines.push(view.run.profile === null
    ? 'profile   : （不明）'
    : `profile   : ${view.run.profile.id}（${view.run.profile.repository}, base=${view.run.profile.base}, verified=${view.run.profile.verified}）`);
  lines.push(`証跡の最終 phase : ${view.latest_phase_with_evidence ?? '（読める artifact が無い）'}`);
  lines.push('');

  lines.push('## phase × Issue');
  if (view.issues.length === 0) {
    lines.push('- Issue の記録が1件も無い（plan が読めず、後続 phase の証跡も無い）。');
  } else {
    const rows = view.issues.map((issue) => [
      `#${issue.number}`,
      planCell(issue.plan),
      dispatchCell(issue.dispatch),
      mergeCell(issue.merge),
      uatCell(issue.uat),
    ]);
    lines.push(...renderTable(['Issue', 'plan', 'dispatch', 'merge', 'uat'], rows));
  }
  lines.push('');

  lines.push('## phase の証跡');
  lines.push(...renderPhaseEvidence(view));
  lines.push('');

  if (view.issues.length > 0) {
    lines.push('## Issue 詳細');
    for (const issue of view.issues) {
      lines.push(...renderIssueDetail(issue));
      lines.push('');
    }
  }

  lines.push('## 次にやること（run 全体）');
  if (view.next_actions.length === 0) {
    lines.push('- なし。読めた artifact に停止理由・warning・limitation は記録されていない。');
  } else {
    for (const action of view.next_actions) {
      lines.push(`- [${action.phase} ${action.source} ${action.code}] ${action.hint}`);
      lines.push(`  根拠: ${action.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// =============================================================================
// Failure envelope
// =============================================================================

function statusFailure(error) {
  return {
    status_schema_version: STATUS_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    run: { dir: null, name: null, run_id: null, profile: null },
    latest_phase_with_evidence: null,
    phases: {},
    issues: [],
    next_actions: [],
    unreadable: [],
    errors: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    redactions: redactionsList(),
  };
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
  const runDir = resolveRunDir(inputs.run);
  const paths = scanArtifacts(runDir);

  const artifactsByPhase = new Map(PHASES.map((phase) => [
    phase,
    paths.get(phase)
      .filter((relativePath) => existsSync(join(runDir, relativePath)))
      .map((relativePath) => readArtifact(runDir, phase, relativePath)),
  ]));

  const view = buildView(runDir, artifactsByPhase);

  // An unreadable artifact is announced on stderr as well, so an operator piping
  // `--json` into a tool still learns that part of the run could not be read.
  for (const entry of view.unreadable) {
    process.stderr.write(`unreadable ${entry.phase} artifact ${entry.path}: ${entry.detail}\n`);
  }

  // Exit 0 whenever a view was produced. The status of the RUN is in the view
  // (status / stop_reason / 読取不能), and folding it into this process's exit
  // code would make "the run is blocked" indistinguishable from "the status view
  // failed" — mirroring the planner, whose partial also exits 0.
  return {
    exitCode: 0,
    stdout: inputs.json ? `${JSON.stringify(view, null, 2)}\n` : renderText(view),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      const detail = redact(error.detail ?? error.message);
      process.stdout.write(wantsJson
        ? `${JSON.stringify(statusFailure(error), null, 2)}\n`
        : `# cmate-orchestrate run status\n\nstatus runner 失敗（${error.code}）。${detail}\n`);
      process.stderr.write(`error [${error.code}]: ${detail}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
