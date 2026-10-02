---
name: cmate-orchestrate
description: 複数の GitHub Issue を並列で進める。dry-run で依存と file 衝突を解いた Wave plan を作り、承認後に監督付きで dispatch し、検証 pass したものだけを PR/merge し、UAT で受入を確認する4段の runner。run の状態は read-only の status runner が phase × Issue のマトリクスで出す。
---

# cmate-orchestrate（plan → dispatch → merge → uat）

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である（グローバル導入をしない
> npx 運用、同梱 runner の `--cli <launcher>`、環境変数 `CM`）。ランチャー解決は実行時の話であり、
> **plan.json には混入しない**。規約と推奨する導入形態は
> [references/runner-operations.md](./references/runner-operations.md) 第1節。

複数の Issue を並列で進めるための、**計画**・**監督付き実行**・**PR/CI/merge**・
**UAT と回数上限つき修正ループ** を安全に行う手順である。実務は4つの
**deterministic runner**（Node stdlib のみ）が行う。

runner は決定的なので、この文書が述べるのは「いつ使うか・どう呼ぶか・出力をどう読むか・
止まったら何をするか」の4点だけである。**各 runner が何をどう保証しているかの正本は
`references/*-contract.md`** で、この文書はそこへ一方向に参照する。4点に収まらない機構の細部は
[references/runner-operations.md](./references/runner-operations.md)（運転ノート）と
[references/codes-and-recovery.md](./references/codes-and-recovery.md)（code の全一覧と対処表）に
置いてあり、なぜその挙動なのかは [references/release-notes.md](./references/release-notes.md)。

| runner | script | 役割 | mutation | 契約の正本 |
|---|---|---|---|---|
| plan | `scripts/orchestrate.mjs` | dry-run で Wave plan を生成する。**default invocation** | なし | [plan-contract.md](./references/plan-contract.md) |
| dispatch | `scripts/dispatch.mjs` | 承認済み plan を worker へ配り、Wave barrier と verification gate で監督する | あり | [dispatch-contract.md](./references/dispatch-contract.md) |
| merge | `scripts/merge.mjs` | 検証 pass した Issue を PR 作成 / guarded merge する | あり（承認時） | [merge-contract.md](./references/merge-contract.md) |
| uat | `scripts/uat.mjs` | 受入テストと、不合格時の回数上限つき修正ループ | あり（承認時） | [uat-contract.md](./references/uat-contract.md) |

これに、**mutation を一切しない read-only の view runner** が付く。phase の一部ではなく、
上の4つが残した artifact を読むだけである。

| runner | script | 役割 | mutation |
|---|---|---|---|
| status | `scripts/status.mjs` | run directory の artifact を突き合わせ、phase × Issue のマトリクスを出す | **なし（read-only）** |

`scripts/lib.mjs` は共有ヘルパーで、単体では起動しない。`scripts/profile-init.mjs`（第3.5節）と
`scripts/inspect.mjs`（第3.6節）は phase ではなく **read-only の準備 runner** で、**どちらも
何も書かず裁定せず、所見は warning・exit は 0 である。**
merge 後の観測 runner は `scripts/observe.mjs`（[契約](./references/observe-contract.md)）。

## 1. いつ使うか / 使わないか

**使う**: 着手前に Issue 間の依存と file 衝突を解いておきたいとき。複数 Issue を並列に worker へ
配り、前段が壊れていないことを確認しながら段階的に進めたいとき。納品と受入まで同じ gate の下で
通したいとき。**走っている / 走り終えた run が今どこにいるかを知りたいとき**（`status.mjs`。
read-only なので、いつ何回呼んでも run に影響しない）。

**使う（続き）**: **Wave 途中で一部の Issue だけが落ちた run を再開したいとき**
（`dispatch.mjs --resume`。第3.2節。completed かつ verification pass の Issue は再 dispatch せず、
その verification 記録だけを引き継ぐ）。

**使わない（スコープ外）**: Issue 本文の自動編集。回数無制限のループ。cross-model review。
どの mutating runner も、明示承認・verification pass・CI pass の gate 無しに mutation を行わない。
`--resume` も上限つき（`uat` の `--max-attempts` と同じ設計）ではなく**人間が明示的に叩く**もので、
runner が自分で再試行ループを回すことはない。

## 2. 前提条件

**CLI**: `commandmate`（`>=0.11.0 <1.0.0`）・`git`・`gh`・`node >=22`。宣言している権限は
`filesystem_read` / `filesystem_write` / `process_execution` / `network_access` で、これは
orchestration 全体が要求する集合である（plan にも同じ集合を提示する）。base branch・branch 名・
worktree path・baseline は **profile から解決**し、`develop`/`npm`/`cargo` を hardcode しない
（[profile-contract.md](./references/profile-contract.md)）。**リポジトリ固有の伴走ファイル規約
も profile の任意 field `scope_companions` で宣言する** —— `spec/` ミラーのような
宣言済み path の関数は `derive`、集約テストのような固定名の伴走は `require` に書く。planner は
リポジトリを開かないので、規約の出どころは profile だけである
（[adr-scope-derivation.md](./references/adr-scope-derivation.md) 第3節）。内蔵 profile
（`node-commandmate` / `rust-commandagent`）以外のリポジトリで使うなら、まず
`scripts/profile-init.mjs` で profile draft を起案する（第3.5節）。

**worktree**: dispatch は worktree を**作らない**。dispatch 対象 Issue の worktree が事前に存在し、
`commandmate ls` で解決できること。無ければ
[cmate-worktree-setup](../cmate-worktree-setup/) で作成する。branch 名を一致させるため、
**cmate-worktree-setup と本 skill には同じ profile（同じ `branch_template`）を渡す**こと。
解決できない Issue があると、dispatch は**最初の Wave の前に停止する**: `worktree_unresolved` で
1人も dispatch せず、`--out` も作らない（第5節）。1つのコマンドで通したいなら
`--prepare-worktrees --worktree-setup <launcher>` を渡す（第3.2節）。**その場合も worktree を作るのは
`cmate-worktree-setup` であって dispatch ではない。** 前提の全文（`commandmate sync` を1度だけ試す
挙動を含む）は [references/runner-operations.md](./references/runner-operations.md) 第2節。

**条件付き依存の Skill**（既定では使わない。使う phase を明示的に選んだときだけ要る）。

| Skill | いつ要るか | 未導入だとどうなるか |
|---|---|---|
| [cmate-acceptance-test](../cmate-acceptance-test/) / [cmate-uat](../cmate-uat/) | uat の**意味ゲート**を使うとき（実機環境が要るなら後者） | orchestrate は動くが **UAT の裁定は機械ゲートだけ**になる。report の `limitations[]`（`acceptance_not_run`）に記録される |
| [cmate-worktree-setup](../cmate-worktree-setup/) | dispatch の **`--prepare-worktrees`** を使うとき | **停止する**（`limitations` ではなく `blocking_reasons` の `worktree_setup_unavailable`）。1人も dispatch せず `--out` も作らない |
| [cmate-worker-development](../cmate-worker-development/) | dispatch の **`--worker-method`** を使うとき | **停止する**（`limitations` ではなく `blocking_reasons` の `worker_method_unavailable`）。最初の Wave なら1人も dispatch せず `--out` も作らない |

3つとも**黙って劣化しない**という型は同じだが、**結果は違う**。意味ゲートは未導入でも機械ゲートで
裁定できるので**続行して記録**し、worktree 準備と方法論は**停止**する。停止と続行を分けた理由、
`--worker-method` が「両 root（`.claude/skills/` と `.agents/skills/`）に在ること」を要求する理由、
未導入の環境で相対リンクが切れることの意味は
[references/runner-operations.md](./references/runner-operations.md) 第3節。
plan / merge はどの Skill にも依存しない。

---

## 3. 呼び出し方と呼び出し順

**plan → （人間の承認）→ dispatch → merge / uat** の順に、別々の invocation で呼ぶ。
1つの runner が次の phase を勝手に始めることはない。

**承認つき運転が既定である。** 人間が plan を読んでから dispatch を叩き、mutation を許すのは
`--approve` を書いた invocation だけ、という運転がこの Skill の標準形である。
`--unattended`（第3.2節）はその**代替ではなく、同じ規律を人間の居ない環境で成り立たせるための宣言**で
あって、**外すのは「人間の待ち」だけ・ゲートは1つも外さない**。承認つき運転が守っていたのは
「人間が読む」ことそのものではなく **人間が読むまで壊れた状態が下流へ流れないこと**であり、
無人でそれを維持する方法は承認を機械に代行させることではなく、
**人間に提示して待つ経路を、その場で止まる経路に変換すること**である。
**無人運転の driver は CI の job 定義（または cron script）であって runner ではない。**

### 3.1 plan（dry-run。既定の入り口）

```
orchestrate.mjs <issue>... [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--issues a,b,c` | — | Issue 番号（positional でも可）。1件以上 |
| `--profile <id>` | `node-commandmate` | 内蔵 profile。`node-commandmate` / `rust-commandagent` |
| `--profile-json <path>` | — | 独自 profile |
| `--issue-json <path>` | — | Issue fixture。offline・決定的に回す。**形式は [plan-contract.md](./references/plan-contract.md) 第1.1節** |
| `--base <ref>` / `--repo <owner/name>` | profile 由来 | 上書き。**`--repo` は profile の `verified` を降格させる** |
| `--max-parallel <1-3>` | `3` | 1 Wave の最大幅 |
| `--depends <a:b>` / `--no-infer` / `--order <a,b>` | — | 依存の override / 推論無効化 / 順序の主張 |
| `--run-id <id>` | 入力 hash（**Issue 内容と profile 全体を含む**） | run_id の明示 |
| `--runs-dir <path>` | `.commandmate/orchestrate/runs` | artifact の出力先 |
| `--allow-unverified` | off | unverified profile での planning を許可 |

`--issue-json` が無ければ read-only の `gh issue view` で Issue を取得する。これが planner
唯一の network access である。**契約の入力は number / title / body / labels だけで、
コメントは読まれない。** コメントで決めた内容は **dispatch 前に Issue 本文へ畳み込んでから**
plan を作ること（本文の精錬には cmate-issue-refinement が使える）。

`<runs-dir>/<run_id>/` に `plan.json`・`result.json`・`manifest.md`・`issue-analysis.md`・
`dependency-plan.md` を書き、run directory が既にあれば上書きせず `run_exists` で終了する。
既定 run_id は Issue 内容と **解決後の profile 全体**を含む hash なので、**本文を直しても
profile を直しても自動的に別 run** になる（Issue #157。`baseline` / `branch_template` /
`worktree_template` / `verified` / `scope_companions` はいずれも plan の中身を決めるため、
field を選ばず丸ごと hash する）。`run_exists` は「同じ id に hash された run が既にある」
までしか述べず、**「何も変えていない」とは断定しない**（cwd の `origin` は hash の外）。
plan は「入力 + cwd の origin」の純粋関数で、**同一入力からは同一 plan が出る**（Claude/Codex
parity）。`--run-id` を固定して2つの `--runs-dir` に出し `plan.json` を `diff` すれば確認できる。

### 3.2 dispatch（監督付き実行）

```
dispatch.mjs --plan <承認済み plan.json> [options]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--plan <path>` | **必須** | planner が出した承認済み `plan.json` |
| `--out <dir>` | `<plan-dir>/dispatch` | artifact の出力先。既存なら `out_exists`。`--resume` とは排他 |
| `--resume <dir>` | — | 部分失敗した run の再開。`<dir>` は再開対象の `--out`。**pass 済みは再 dispatch せず記録だけ引き継ぐ**（[運転ノート](./references/runner-operations.md) 第7節） |
| `--reverify <dir>` | — | **`send` を1回も呼ばずに**裁定だけ取り直す。`<dir>` は対象 run の `--out`。作業が既に worktree に在るのに裁定が古い、という状態のための経路（[運転ノート](./references/runner-operations.md) 第8節）。`--out` / `--resume` とは排他 |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |
| `--auto-yes` | **off** | worker prompt を自動応答する。既定は停止して human へ提示。**契約のポリシーと worktree の auto-yes 状態は別物で、この flag は両方を動かす**（片方だけでは1つも応答されない。[dispatch-contract.md](./references/dispatch-contract.md) 第2.10節）|
| `--no-auto-yes` | — | **off 側を明示する。** profile が `dispatch_defaults.auto_yes` を宣言していても、この run だけ off にできる（[profile-contract.md](./references/profile-contract.md) 第10節）。`--auto-yes` との同時指定は `invalid_input` |
| `--allow-questions` | **off** | 未回答 question を持つ Issue を含む plan を dispatch する |
| `--unattended` | **off** | **人間が居ないことの宣言。締め付けだけを含意し、権限は1つも足さない**（[運転ノート](./references/runner-operations.md) 第10節）。`--approve` を含意しない。緩和フラグとの併用は `invalid_input` |
| `--wall-clock-budget <sec>` | **off** | run 全体の壁時計上限。到達で `partial` / `stop_reason: timeout`。`--unattended` では**必須** |
| `--prepare-worktrees` | **off** | pre-flight で未解決だった worktree を `cmate-worktree-setup` に作らせてから続行する。既定 off＝従来どおり停止 |
| `--worktree-setup <launcher>` | — | 上記 provider の呼び出し口（`--cli` と同じ argv 規約）。`--prepare-worktrees` 無しに渡すと `invalid_input` |
| `--worker-method <skill-id>` | **off** | worker が従うべき開発スキル（例 `cmate-worker-development`）を名指しする。**install を実測してから** dispatch し、無ければ停止する。契約 goal と worker prompt の**両方**に `## Method` 節が入る。**渡さない run は 1 bit も変わらない** |
| `--schedule <mode>` | **`wave`** | `wave` / `dag`。`dag` は wave barrier をやめ、**その Issue 自身の依存**が pass した時点で空き枠へ投入する。**渡さない run は report が byte 単位で従来どおり。** 規則・停止・制約は第3.2節 |
| `--contract-mode <m>` | `auto` | `auto` / `require`（フォールバック拒否）/ `off`（probe せず baseline 裁定） |
| `--verify-gates <ids>` | 省略＝全ゲート | 契約の `verify.gates` に載せる gate id。**存在しない id を発明しない**。run 全体に1つ。Issue 側の `require:` / `gates:` とは**和集合**を取る（絞り込みが Issue の要求を落とすことは許さない） |
| `--expect-branch <name>` | — | plan 承認時の統合 branch。不一致なら drift |
| `--wait-timeout <sec>` | `300` | `commandmate wait` の**1回あたり** timeout。**worker の1ターンの上限ではない** —— ターンがこの窓より長いと runner は timeout を報告するが worker は走り続ける。timeout の時点で `capture` を1回叩いて生死を測り、`worker_liveness` と blocking（`wait_window_exhausted` / `worker_stalled` / `worker_liveness_unreadable`）に転記する（第5節の対処表・[dispatch-contract.md](./references/dispatch-contract.md) 第2.11節） |
| `--max-turns <n>` | `8` | 各 worker を駆動する最大ターン数。未 commit で到達なら `failed` |

`--auto-yes` / `--wait-timeout` / `--max-turns` の**既定は profile 側でも宣言できる**
（`dispatch_defaults`。[profile-contract.md](./references/profile-contract.md) 第10節）。
リポジトリの事情を毎回 flag で言い直すのをやめるための field であり、
**flag は常に profile を上書きする**。`--unattended` と auto-yes の排他のような既存の検証は、flag 由来か
profile 由来かを問わず**解決後の値**に対して効く。

`commandmatedev` は使わない。公式経路は public `commandmate` である（ADR CommandMate
[#1447](https://github.com/Kewton/CommandMate/issues/1447)）。

呼ぶ前に押さえておく **3つの不変条件**（詳細と根拠は
[dispatch-contract.md](./references/dispatch-contract.md)）:

1. **open question ゲートが最初に効く。** 未回答の planner question を持つ Issue が1件でも
   あれば、**1人も dispatch せずに停止する**。直し方は「Issue 本文に回答を書いて re-plan」。
2. **裁定と完了は別物である。** 裁定の ground truth は `wait --verify` の exit code、完了の
   ground truth は **worktree ブランチの新規 commit** である。worker は各ターン後に idle 化する
   ので、`wait` の idle を完了とみなさない。
3. **barrier と verification gate。** `completed` かつ verification pass が揃うまで次へ進まない
   ——既定（`wave`）は Wave 単位、`--schedule dag` は **Issue ごと**（第3.2節）。**worker
   completion を verification success と同一視しない。** そして **barrier は「1本ずつの branch が
   green」では閉じない** —— `merge.mjs --merge-prs --integration-verify`（第3.3節）を使う運転では
   **合流後の統合ブランチが green であることまでが barrier である**
   （[#175](https://github.com/Kewton/commandmate-skills/issues/175)。file が重ならない意味的衝突は
   plan にも PR 個別 CI にも出ないので、合流させてからしか測れない）。

**オプション別の運用は、この文書の外にある。** 下の表は「何をしたいときにどの flag か」だけで、
規則・停止条件・設計理由は名指しした先が持つ（**一方向参照**である。食い違ったら正本が勝つ）。

| 何をしたいとき | flag / 入力 | 運転ノート | 契約の正本 |
|---|---|---|---|
| worktree を dispatch に用意させる | `--prepare-worktrees` / `--worktree-setup` | [runner-operations.md](./references/runner-operations.md) 第4節 | [dispatch-contract.md](./references/dispatch-contract.md) 第3.0.1節 |
| worker に開発の方法（HOW）を渡す | `--worker-method <skill-id>` | 同 第5節 | 同 第1節・第3.0節 |
| Issue が名指し（`require:`）／定義（`gates:`）したゲートを裁定に入れる | Issue 本文の `acceptance-gates` ブロック | 同 第6節 | 同 第2.9節 ／ [acceptance-gates-notation.md](./references/acceptance-gates-notation.md) |
| **決めていないことを worker に決めさせない** | Issue 本文の `open-questions` ブロック | — | [plan-contract.md](./references/plan-contract.md) 第5.5節 ／ [open-questions-notation.md](./references/open-questions-notation.md) |
| 部分失敗した run を再開する | `--resume <前回の --out>` | 同 第7節 | 同 第8節 |
| 送らずに裁定だけ取り直す | `--reverify <前回の --out>` | 同 第8節 | 同 第8.5節 |
| 裁定機構（契約経路 / baseline）を選ぶ | `--contract-mode` | 同 第9節 | 同 第2.4節・第2.7節 |
| 人間の居ない環境で回す | `--unattended` + `--wall-clock-budget` | 同 第10節 | 同 第3.0.3節・第3.0.4節 |
| monitor と併用する | （monitor 側の `--no-auto-approve`） | 同 第11節 | — |

読む前に押さえておく点だけ、ここに残す。

- **`--prepare-worktrees` / `--worker-method` は、揃わなければ停止する**（`limitations` ではなく
  `blocking_reasons`）。最初の Wave なら `--out` を消費していないので、揃えて**同じコマンドを
  再実行**すればよい。**Issue の分割や re-plan は要らない。**
- **`--resume` / `--reverify` は `completed` かつ verification `pass` の Issue を引き継ぎ、
  再判定しない。** `--reverify` は `send` を1回も呼ばず、worker のターンを1つも消費しない。
- **契約が言及していない禁止事項は、契約が許可したのではなく書いていないだけである。Issue 本文が
  正本である**（[#176](https://github.com/Kewton/commandmate-skills/issues/176)）。`goal` は本文の
  要約だが、**否定的制約の節と、禁止表現を含む表・箇条書きだけは要約せず原文転記する**。読めない
  ときも上限で落ちたときも停止せず、goal がそう名乗って `issue_body_unreadable` /
  `issue_constraints_untranscribed` を記録する。**転記が完走しても、worker 側は本文を自分で読む**
  （[cmate-worker-development](../cmate-worker-development/) A 段）。転記対象の見出し語・上限・
  配置・非回帰は [dispatch-contract.md](./references/dispatch-contract.md) 第2.4.1節。
- **`--schedule dag` は並列度を上げるため、検証ゲートが資源（ポート等）を共有するリポジトリでは
  偽赤が増えうる。[Kewton/CommandMate#1771](https://github.com/Kewton/CommandMate/issues/1771)
  が着地するまでは `--max-parallel` を保守的に設定すること。** 失敗の伝播・合流後検証・
  `--max-parallel` を runner が下げない理由は第3.2節。
- **`--unattended` が含意するのは締め付けだけである。** ゲートを1つも無効化せず、`--approve` を
  含意せず、緩和フラグとの併用は `invalid_input` で拒否する。**無人運転の driver は CI の job 定義
  （または cron script）であって runner ではない。**
- **dispatch で `--unattended` が足す締め付けの1つは、裁定の根拠の要求である。** 契約 pass なのに
  ゲートを1つも名指しできない Issue（`verification_gates_unrecorded`）で先へ進むのをやめる。
  **裁定そのものは書き換えない**（第3.0.3節。フラグ無しは limitation で続行。対処は第5節）。
- **`--unattended` と monitor を併用するなら、monitor 側の `--no-auto-approve` は推奨ではなく
  要件である**（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測。
  [runner-operations.md](./references/runner-operations.md) 第11節）。
- **どちらの裁定機構で判定したかは、常に report と summary に明示される**（黙って劣化しない）。
- **監視の一次はこの `wait` ループである。** [cmate-orchestrate-monitor](../cmate-orchestrate-monitor/)
  は別機構のサイドカーで、**統合も廃止もしない**（同 第11節）。

### 3.3 merge（PR 作成 / guarded merge）

```
merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

**1 invocation で mutating phase をちょうど1つ**だけ有効化する。両方指定・どちらも未指定は
`invalid_input` で拒否する。

| flag | 既定 | 効果 |
|---|---|---|
| `--dispatch <path>` | **必須** | eligible の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ | PR 作成 / CI 確認付き guarded merge |
| `--approve` | **off** | 明示承認。無ければ mutation しない preview |
| `--unattended` | **off** | **人間が居ないことの宣言。締め付けだけを含意し、権限は1つも足さない。**`--approve` を含意しない。**両 phase で受理する**（phase ごとに含意する締め付けが違う。下記） |
| `--integration-verify` | **off** | **合流後の統合ブランチで profile baseline を回す**（`--merge-prs` のみ。下記）。赤なら success にせず、次 wave を止める |
| `--merge-method <m>` | `squash` | `merge` / `squash` / `rebase` |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--gh` / `--git <path>` | `gh`/`git` | 実行する CLI |

対象は dispatch report で **`completed` かつ verification `pass`** の Issue **だけ**である
（verification gate の継承）。`--approve` 無しに push・PR 作成・merge は一切しない。
merge するのは CI checks が**すべて green** のときだけで、failure は `ci_failed`、
pending・check 0 件は `ci_pending` として **merge を拒否**する。

#### PR 本文は「検証証拠の提出」である

`create_prs` が書く PR 本文（`<out>/pr-bodies/issue-<n>.md`）の Verification 節は、
**定型文ではなくこの Issue の実測値**である。人間が見るのは PR だけなので、証拠が
run ディレクトリの JSON の中にしか無い状態を残さない。載せるのは verdict・gate ごとの合否と
exit code・宣言 scope と実変更 file の対比（scope 外の件数を含む）・diff 規模の4つで、
**転記であって主張ではなく**、**読めなかったものも `flaky` も pass に丸めず**（#224）、
上限で打ち切ったなら**打ち切った件数を本文に明記する**。出どころの表と規則の全文は
[references/runner-operations.md](./references/runner-operations.md) 第12節。

merge-report.json / merge-summary.md の構造は変わらない。

#### 合流後の統合ブランチ検証（`--integration-verify`。既定 off。**`--merge-prs` のみ**）

**wave barrier の後半である。** 「全 worker completed + verification pass」は
**1本ずつの branch** についての条件で、**合流後については何も言っていない**。
wave の衝突検出は `suspected_files` の重なりしか見ず、guarded merge が確認する CI は
**兄弟 PR が入る前の base** で走っているので、「片方がデータを直し、もう片方がそのデータの
性質に依存する検査を書く」類の**意味的衝突は誰にも捕まらない**
（[#175](https://github.com/Kewton/commandmate-skills/issues/175) の実測では develop に入った
直後から赤で、**発覚は promotion PR の CI** だった）。

- **やること**: この invocation の全 merge が終わったあと、`git fetch origin <base>` で合流後の
  tip を読み直し、**使い捨ての detached checkout** に取り出して **profile の `baseline`** を
  そこで回す。終わったら畳む。**invocation の作業ツリーには触れない。**
- **何を実行するかは profile から取る。** `npm` も `develop` も runner は持たない。
- **赤なら success にしない**（`partial` / exit 7 / `stop_reason: merge_failed` / 名指しは
  `blocking_reasons[]` の **`integration_verify_failed`**）。**次 wave を dispatch しない。**
  次 wave 側が読むのは `merge-report.json` の **`integration_verify.outcome`** で、
  進んでよいのは **`status: success` かつ `outcome: "pass"`** のときだけである
  （`"not_run"` は「測っていない」であって green ではない。field ごと無いのはフラグを
  使っていない run である）。**受け口の実装は
  [#183](https://github.com/Kewton/commandmate-skills/issues/183) が入れる**
  —— #175 では dispatch を1行も変えていない。
- **profile が `baseline` を宣言していなければ、1件も merge せずに拒否する**
  （`failure` / exit 1 / `preflight_failed` / `integration_verify_unavailable`）。
  opt-in した検証が走らないまま「完了」と報告されるのが、この機能が消しに来た事象そのものだからである。
- **既定 off で、フラグ無しの report は #175 以前と byte 単位で同一**である（fixture で固定）。
  `merge_schema_version` は 1 のまま、`stop_reason` にも `outcome` にも値を足していない。
- 代替案の **merge queue（base 更新 → CI 再走 → merge の直列化）は実装していない** ——
  まずは合流後検証の1段で足りる、が #175 の裁定である。

正本は [merge-contract.md](./references/merge-contract.md) 第5.4節。

#### 無人運転（`--unattended`。既定 off。**両 phase**）

dispatch の同名フラグ（第3.2節）と**同じ宣言**である。**mutation の権限を与えるフラグではない。**

- **`--approve` を含意しない。** `--unattended` だけの invocation は従来どおり preview であり、
  push も PR 作成も merge もしない。**無人で回す CI は両方書く。**
- **`--create-prs` が含意する締め付けは1つだけである: `change_evidence_unavailable` を
  limitation ではなく blocking として扱う。** PR 本文に実変更を載せられなかったという事実は、
  人間が読む運転なら読み手が branch を開いて補える劣化だが、無人では**証拠の無い PR が黙って
  作られる**ことになる。昇格した run は **その Issue の PR を作らずに停止**する
  （`partial` / exit 7 / `stop_reason: pr_create_failed`）。
  フラグ無しでは従来どおり limitation を記録して続行する（fixture で二点測定してある）。
- **`--merge-prs` が含意する締め付けも1つだけである: 全 eligible Issue が「受入ゲートブロック
  （```acceptance-gates）を持つ」かつ「受入条件を持つ」こと。** 段階 A / B が到達する最遠点は
  PR であり、PR は人間が読む場所だが、**ここで読み替えが起きると誰も読まないまま base branch に
  入る**。1件でも欠ければ **1つも merge せずに停止**する（`failure` / exit 1 /
  `stop_reason: preflight_failed`。名指しは `acceptance_gates_required` /
  `no_acceptance_criteria`）。**除外ではなく停止であり、条件を満たす Issue も merge しない**
  —— 対象集合を黙って縮めない。
- **どちらの phase でも新しい `stop_reason` 値は足していない**（schema version も上げていない）。
- **job 定義側で置くべき環境変数は dispatch と同じ2つである。** `GH_TOKEN`（または
  `GH_ENTERPRISE_TOKEN`）と **`GIT_TERMINAL_PROMPT=0`**。実測（#115）によれば
  **`gh pr create` / `gh pr merge` は TTY 非依存で完結する** —— 認証切れも確認プロンプトも gh は
  待たずに非ゼロで落ち、既存の `pr_create_failed` / `merge_failed` / `preflight_failed` が受けるので、
  **この runner に `gh` 由来の停止は足していない**。**`git push` の資格情報プロンプトだけは別**で、
  制御端末を持つ起動元では「止まる」ではなく**無言で待つ**に化ける。runner はこれを検査しない。
- 証跡は `merge_schema_version` を上げずに `limitations[]` の `unattended_mode` で運ぶ。

正本は [merge-contract.md](./references/merge-contract.md) 第5.3節、裁定は
[adr-unattended-mode.md](./references/adr-unattended-mode.md) 第8節・第9節（実装で変えた点は第17節）。

### 3.4 uat（受入テストと回数上限つき修正ループ）

```
uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

こちらも **1 invocation で phase をちょうど1つ**である。

| flag | 既定 | 効果 |
|---|---|---|
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ | read-only の受入判定 / 修正ループ |
| `--approve` | **off** | fix loop の明示承認。無ければ preview |
| `--max-attempts <1-5>` | `2` | fix 試行の回数上限。ループはこれを超えない |
| `--acceptance-dir <dir>` | — | 意味ゲートの入力（`issue-<n>.json`）を置いた directory |
| `--require-acceptance` | off | result の欠落・不適合・Issue 不一致を limitation ではなく**不合格**にする |
| `--unattended` | **off** | **人間が居ないことの宣言。締め付けだけを含意し、権限は1つも足さない。**`--approve` を含意しない。下記 |
| `--expect-branch <name>` | — | 再merge が入るべき integration branch。`--unattended --create-uat-fix-worktrees` では**必須** |
| `--out <dir>` | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` |
| `--cli` / `--git` / `--gh <path>` | `commandmate`/`git`/`gh` | 実行する CLI |

裁定は **機械ゲート（profile baseline）+ 意味ゲート（受入条件の Go / Conditional Go / No-Go）の
二層**である。**意味ゲートの判定を出すのはエージェント側の手順であり、uat runner は result
document を検証して合成するだけである**（runner 内で LLM 判定はしない）。合成規則の全表は
[uat-contract.md](./references/uat-contract.md) 第4.2節。

**意味ゲートを使うときのエージェント手順**（uat runner を呼ぶ前に行う）:

1. eligible 集合を dispatch report から取る（`worker_state: completed` かつ
   `verification.outcome: pass`）。
2. 各 Issue について [cmate-acceptance-test](../cmate-acceptance-test/) を、`issue_ref` = その
   Issue、`target_ref` = その Issue の **worktree**、`result_path` =
   `<acceptance-dir>/issue-<n>.json` で実行する。Issue 本文は read-only で取得する（**書き戻さない**）。
3. 出力が [`acceptance-result.v1`](../cmate-acceptance-test/schemas/acceptance-result.v1.json)
   に適合し、`target.issue_ref` がその Issue を指していることを確認する。
   **別 Issue の result を流用しない。**
4. その directory を `--acceptance-dir` として渡す。必須にするなら `--require-acceptance` も渡す。

生成できない Issue があるときに、他 Issue の result を代用したり判定を推測で書いたりしては
ならない。**生成できなかったこと自体が記録すべき事実**である（runner が `acceptance_not_run`
として記録する）。

#### 無人運転（`--unattended`。既定 off）

dispatch / merge の同名フラグと**同じ宣言**である。**mutation の権限を与えるフラグではない。**

- **`--require-acceptance` と `--max-attempts` の明示を要求する**（欠ければ `invalid_input` /
  exit 3）。**意味ゲート無しの無人 UAT は「dispatch が既に通した baseline をもう一度走らせた」で
  しかなく、受入を確認したとは言えない。** その帰結として `acceptance_not_run` は
  **昇格ではなく「起こらない」**（劣化は不合格になる）。
- **`--create-uat-fix-worktrees` では、fix worktree を1つも作る前に invocation cwd を検査する。**
  再merge（`git merge --no-ff`）は **cwd 指定を持たない**ので、fix は **invocation cwd の現在の
  branch** に入る。実測（#115）では、CI が base branch を checkout していれば **fix が review を
  経ずにそこへ入り**（push 済みなら不可逆）、detached HEAD なら
  **「merged」と報告しながらどの branch にも残らない**。したがって
  **HEAD が detached でないこと**と **HEAD が `--expect-branch` と一致すること**を確かめ、
  外れていれば `failure` / exit 1 / `stop_reason: preflight_failed` で停止する
  （名指しは `unattended_cwd_detached` / `unattended_cwd_branch_mismatch`）。
  **worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしない。**
- `--write-uat` は read-only なので cwd 検査は掛からない（守るべき cwd が無い）。
- **新しい `stop_reason` 値は足していない**（`uat_schema_version` も 1 のまま）。
- job 定義側で `GH_TOKEN` と **`GIT_TERMINAL_PROMPT=0`** を置くこと（merge と同じ。runner は
  検査しない）。

正本は [uat-contract.md](./references/uat-contract.md) 第5.1〜5.2節、裁定は
[adr-unattended-mode.md](./references/adr-unattended-mode.md) 第8節・第14.3節（実装で変えた点は第17節）。

### 3.5 profile-init（profile の起案と点検。plan の前。read-only）

```
profile-init.mjs [--repo-root <path>] [--out <path>] [--emit envelope|profile] [--repo <owner/name>] [--id <id>]
profile-init.mjs --check <profile.json> [--repo-root <path>]
```

内蔵 profile 以外のリポジトリで使うときの **最初の一歩**である。toolchain manifest・lockfile・
workflow・CONTRIBUTING 等・git config を読み（一覧は第7.1節）、profile JSON の **draft** を
起案する。**network も subprocess も clock も使わない**ので、同じ tree からは byte 単位で
同じ draft が出る。

| flag | 既定 | 効果 |
|---|---|---|
| `--repo-root <path>` | cwd | 調べるリポジトリ |
| `--out <path>` | — | draft の書き出し先。**既存なら `out_exists`（exit 4）** |
| `--emit <mode>` | `envelope` | stdout に出すもの。`profile` なら draft JSON |
| `--repo <owner/name>` / `--id <id>` | 推定 / 導出 | 推定させずに宣言する |
| `--check <path>` | — | **起案しない別 mode**（第9.7節）。上の flag と併用不可 |

押さえるべき点は3つ。**出力は draft であって profile ではない**（`verified` は常に `false`。
plan に渡すには `--allow-unverified` が要る）。
**「読み取った」と「材料が無かった」が出力上で区別される**（`provenance[]` / `todos[]`）。
**推定できなかった baseline は fail-closed の placeholder になる**（埋めずに dispatch
すれば止まる、が正しい壊れ方）。

**`--check` は起案の逆向き**で、既にある profile の `scope_companions` を tree に突き合わせ、
規則ごとに `when` の一致件数と `add` の実在件数を出す（**構文として正しいまま何にも一致しない
規則**を plan の前に見るため）。**0 件一致は warning であって error ではない**（exit 0。
**裁定しない**）。一致判定は planner と**同じ関数**（`lib.mjs`）である。

全文は [runner-operations.md](./references/runner-operations.md) 第13節、正本は
[profile-contract.md](./references/profile-contract.md) 第7節（起案）・第8節
（`verified: true` の条件）・第9.7節（`--check`）。

### 3.6 inspect（plan の前に走る read-only の準備 runner。mode は2つ）

```
inspect.mjs --check-references [--repo-root <path>] [--ref <rev>] <issue>...
inspect.mjs --evaluate-gates  [--repo-root <path>] [--repeat <n>] <issue>...
```

**planner は対象リポジトリを開かない**（第9.1節）。その不変条件が**残す穴**を2つ塞ぐ ——
本文の主張（`path:line`・「N 行」）が古いこと（実測 16 件中 11 件。CommandMate #1831）と、
**受入条件が「着手前に落ちる」かを誰も確かめないこと**（実測 3 件。CommandMate #1832）。

| flag | 既定 | 効果 |
|---|---|---|
| `--check-references` | — | 本文の `path:line`・「N 行」を tree に突き合わせる mode |
| `--evaluate-gates` | — | 宣言された受入ゲートを base で先行実行する mode。**どちらか必須・排他** |
| `--repo-root <path>` | cwd | 突き合わせ先 / 実行先の checkout |
| `--ref <rev>` | — | working tree でなくこの revision を読む（`--check-references` 専用） |
| `--repeat <n>` | 2 | 各 gate の実行回数（`--evaluate-gates` 専用）。1 では非決定性を検出できない |

両 mode 共通: `--issues` / 裸の番号 / `--issue-json`（GitHub 不要）で対象を指定し、`--out` に
報告を書く（既存なら `out_exists` / exit 4）。

**何も書かず**（plan.json には 1 byte も書かない）、**裁定せず**（所見は warning か notice、
**exit は 0**）、**読めない入力は点検せず拒否する**（envelope の `inspection` / `evaluation` が
`null` になる）。**読み口は planner と同じ関数**である。

**`--evaluate-gates` は Issue が宣言したコマンドを実行する runner である**（`profile-init.mjs
--check` の「subprocess を使わない」とは性質が違う）。実行前に `--repo-root` が clean で
あることを確かめ、汚れていれば `invalid_input`（exit 3）で**1つも実行しない**（`--base <rev>`
と HEAD が違うときも同じ）。**散文の受入条件からコマンドは導出しない**
（acceptance-gates-notation.md 第5節・第5.1節。閾値は `gates:` に
`test $(wc -l < path) -le 860` と書けば対象になる）。「測れなかった」は `not_evaluable` の
**notice** であり、「通った」にも「落ちた」にも丸めない。

判定範囲・出力・**見ないもの**（意味的な矛盾と表記ゆれ）は
[runner-operations.md](./references/runner-operations.md) 第15節・第16節、code は
[codes-and-recovery.md](./references/codes-and-recovery.md) 第6.2節・第6.3節が正本。

### 3.7 status（run の横断ビュー。read-only）

```
status.mjs --run <run-dir> [--json]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--run <path>` | **必須** | run directory（`plan.json` のある directory）。`plan.json` 自身の path でも可 |
| `--json` | off | 人間可読のテキスト表の代わりに構造化 view を出す |

**どの phase でも、いつでも呼べる。** plan → dispatch → merge / uat が残す artifact は別々の JSON に
分かれており、各 `summary_markdown` は**単一 phase の要約**である。「この run は今どの phase で、
どの Issue が何待ちか」に答えるには複数の JSON を突き合わせる必要があった。それをやるのがこの
runner で、**それ以外は何もしない。**

**完全 read-only である。** run directory 配下の file を読むだけで `commandmate` / `git` / `gh` を
呼ばず、何も書かないので、走っている run に向けても安全である。

**証跡に無い状態は推測しない。** artifact が無い phase は `未実行`、読めない phase は `読取不能`、
report は読めたがその Issue の記録が無い場合は `記録なし` になる。`partial` / `blocked` /
`failure` はそのまま見せ、success に丸めない。

**exit code は「view を出せたか」だけを表す。** run が blocked でも読取不能があっても **0** で、
非 0 は入力エラー（`invalid_input` 3 / `load_error` 6）に限る。**run の状態は exit code ではなく
view の中で読むこと。**

Issue ごとに出す4欄と「次にやること」の作り方、`--json` の field 一覧、表示規則の全文は
[references/runner-operations.md](./references/runner-operations.md) 第14節。

---

## 4. 出力の読み方

4 runner とも、機械可読な envelope / report を **stdout** に、進捗 notice を **stderr** に出す。
mutating runner は `<out>/` にも report と summary markdown を書く。準備 runner の
profile-init も同じ規約で、status は `success` / `partial`（雛形か warning がある）/
`failure`、exit は 0 / `invalid_input` 3 / `out_exists` 4 / `load_error` 6 である。
envelope の `mode` が `draft` / `check` を名乗り、**`--check` も同じ規約**である。

**まず run 全体を見るなら `status.mjs --run <run-dir>`**（第3.7節）。以下の status / code /
limitation は個々の report の語彙で、status runner はそれらを phase × Issue のマトリクスに
並べ、code を第5節の対処表へマップして見せる。

### status

| status | 意味 | exit |
|---|---|---|
| `success` | 全部通った（preview・no-op を含む） | 0 |
| `partial` | 途中停止、または warning つきで完走した | plan は 0 / 他は 7 |
| `blocked` | **uat のみ。** fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない・1件も dispatch できない | plan は code 依存 / 他は 1 |

**plan の exit code は `partial` でも 0 である。成否は exit code ではなく `status` と
`warnings` で判断すること。** planner は warning が1件でもあれば `success` にしない。

### code の一覧

plan の失敗 code と exit、plan の warning code、limitation code の**全一覧**は
[references/codes-and-recovery.md](./references/codes-and-recovery.md) 第1〜3節にある
（**一方向参照**である）。読むときの要点は3つ。

- 失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**
- `no_acceptance_criteria` / `no_suspected_files` は dispatch の open question ゲートと対になる。
  **この2つを放置したまま `--allow-questions` で押し通さないこと。**
- Issue 本文の ```open-questions ブロック（[references/open-questions-notation.md](./references/open-questions-notation.md)）は
  1件につき1件の blocking question になる（`open_question_declared`、#178）。**これだけは planner の推論ではない** ——
  他の question は「本文から読み取れなかった」という不在についての報告だが、これは
  「**まだ決めていない**」という著者自身の申告なので、planner が計算しても答えは出ない。
  **その問いを決めて本文へ畳み込み、ブロックを消して re-plan する**（ブロックの削除が「決めた」の記録である）。
  ブロックが読めなければ `open_question_block_invalid` で、**「ブロックが無かった」には丸めない**。
  見出し（`## 未決の問い` 等）は**検出しない** —— 散文から停止を作らないためである（同記法 第5節）。
- planner は**推測で決めない2つ**を question にする（#182）。同じ file の2つの綴りが本文に在れば
  `ambiguous_file_candidate`（**どちらも落とさず**両方 scope に入れて訊く）、生産者/消費者の推論が
  **共有 topic token だけ**を根拠にしていれば `unconfirmed_lexical_dependency`（**edge にせず**、
  同じ wave に置いて訊く）。後者は「語彙が一致しただけの3 Issue が3 wave に直列化する」を
  止めるためのもので、edge が要るなら本文か `--depends` で述べる
  （[plan-contract.md](./references/plan-contract.md) 第3.1節・第5.4節）。
- planner は agent ハーネスの path（`.claude/skills/**` / `.agents/skills/**` / `.commandmate/**`）を
  **既定で `scope.allow` に入れない** —— worker が自分を裁く runner を書き換えられる状態を作らない
  ためである。Issue が `## 対象ファイル` に明示的に書いたときだけ入り、`harness_path_in_scope` が
  付いて `partial` になる。落とした path は `reference_files`（読むが scope 外）に出る
  （[plan-contract.md](./references/plan-contract.md) 第5.3節）。
- limitation は「停止はしていないが、後から効いてくる制約」である。`conditional_go` の保持
  （`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は limitation ではなく
  **stop_reason / blocking reason** である。**停止であって、続行しながらの注記ではない。**

### completion check

各 runner は report に completion check を自己申告する（plan 5件 / dispatch 6件 / merge 5件 /
uat 6件）。**いずれかが false なら `status` は `success` にならない。** 項目は各正本の
「completion_check」節にある。token・secret・絶対 path・raw terminal は
report/artifact に残さない（redaction）。

---

## 5. 停止したとき、人間が何をするか

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

`status.mjs --run <run-dir>`（第3.7節）は**対処表を機械的に引いた結果**を、どの Issue の話かを
添えて出す。JSON を自分で突き合わせる前に、まずこれを読めばよい。

**対処表の正本は [references/codes-and-recovery.md](./references/codes-and-recovery.md) 第4節**
である（「何が起きたか」と、なぜその対処なのかまで書いてある）。status runner が引くのもそれで、
**そこに無い code は status runner も推測しない**（「detail と `summary_markdown` を読む」に落ちる）。
下は同じ表の索引で、code から対処の一行へ引くためのものである。

| 止まり方 | 人間がすること |
|---|---|
| plan `no_acceptance_criteria` / `no_suspected_files` | **Issue 本文に受入条件と対象 file を書いて re-plan する** |
| plan `open_question_declared` | 著者が「まだ決めていない」と申告している（推論ではない）。**問いを決めて本文へ畳み込み、ブロックを消して re-plan する。** `--allow-questions` は「worker に決めさせる」判断である |
| plan `open_question_block_invalid` | ブロックを読めなかった。**構文を直すか消して re-plan する。** 「無かった」には丸めていない（detail が壊れ方を名指しする） |
| plan `harness_path_in_scope` | Issue が成果物見出しに agent ハーネスの path を書いたので scope に入れた（既定は「入れない」）。**本当に成果物なのかを読んで決める。** 違うなら見出しから外して re-plan する |
| plan `ambiguous_file_candidate` | 同じ file の2つの綴りが本文に在る。**どちらが対象かを決めて、もう片方を消して re-plan する。** 両方とも対象なら `--allow-questions`（両方 scope に入っている） |
| plan `unconfirmed_lexical_dependency` | 語彙だけを共有する2 Issue が在る。**順序が要るなら `depends on #N` か `--depends`。** 独立なら `--allow-questions`。**`--no-infer` はこの答えではない** |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | `dependency-plan.md` の edge `reason` を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | 既存の `plan.json` と突き合わせ、違うなら本文か profile を直す。同じでよいなら `--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する |
| dispatch `open_questions` + `human_required` | blocking reason に出ている質問の答えを Issue 本文に書いて re-plan する |
| dispatch `drift` | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch `worktree_unresolved` | **`cmate-worktree-setup` で worktree を作り、同じコマンドを再実行する。** plan と同じ profile を使う。**re-plan は不要** |
| dispatch `blocked_by_upstream_failure` / `schedule_halted_unattended`（`--schedule dag`） | 上流が green にならず投入しなかった。**上流を直して `--resume`** |
| dispatch `worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` | provider を install する / `--worktree-setup <launcher>` を渡す / plan と**同じ profile** を渡す。**作成済みの worktree は消していない** |
| dispatch `worker_method_unavailable` | **`commandmate skill install <skill-id>` で対象 worktree に入れ、同じコマンドを再実行する。** **re-plan は不要** |
| dispatch exit 10（prompt 検出） | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | **再 dispatch では解けない。** CommandMate 側のログを見る |
| dispatch `worker_failed` | **まず `worker_turn_evidence.code` を読む**。上流障害なら分割せず `--resume` |
| dispatch `wait_window_exhausted`（`stop_reason: timeout`） | `capture` は **worker が稼働中**だと答えている。**再 dispatch しない** —— idle 化を待って **`--reverify`**、必要なら `--wait-timeout` を実測に合わせる |
| dispatch `worker_stalled`（同上） | `capture` に**稼働の証拠が無い**。worker ログと作業証跡を確かめてから `--resume` |
| dispatch `worker_liveness_unreadable`（同上） | `capture` 自体が読めず**生死を測れていない**。**どちらとも読み替えない。** 手で `capture` を確かめる |
| dispatch で**一部の Issue だけ**落ちた | 落ちた分を直して **`--resume <その run の dispatch ディレクトリ>`**。pass 済みは再 dispatch されない。**re-plan は不要** |
| dispatch `resume_plan_mismatch` / `resume_invalid` | その plan 自身の dispatch ディレクトリを指すか `--out` で新規 run にする。**壊れた report を半分だけ信じない** |
| dispatch `resume_no_work`（`status: success`） | 停止ではない。その attempt の report をそのまま merge / uat に渡す |
| dispatch `contract_unsupported` + `require` | CommandMate を 0.17.0 以上に上げる。**`--unattended` の run では `auto` は選べない** |
| dispatch `contract_scope_unknown`（`--unattended`） | **Issue 本文に対象ファイルを書いて re-plan する** |
| dispatch `unattended_locked` | **先行 run の終了を待って、同じコマンドをそのまま再実行する** |
| dispatch `wall_clock_budget_exhausted` | **成功ではない。** 原因を潰すか budget を実測に合わせてから `--resume` で再開する |
| merge `ci_failed` / `ci_pending` | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR の状態を確認し、conflict は手で解消する |
| merge `issue_autoclose_not_default_branch` | merge 後に **Issue を手動でクローズする** |
| merge `integration_verify_failed`（`--integration-verify`） | **合流後の統合ブランチが赤い。merge 済みなので phase 再実行では戻らない。** green にするまで**次の wave を dispatch しない** |
| merge `integration_verify_unavailable`（同上） | **`baseline` が無ければ1件も merge していない**（profile に書いて再実行）。probe 失敗なら**merge 済みで測れていない** —— 手で1回通してから進む |
| uat `acceptance_conditional` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |
| merge `change_evidence_unavailable`（`--unattended`） | `git diff <base>...<branch>` が答えず**その PR は作っていない**。worktree を復旧して再実行する。**「読めなかった」を「scope 内だった」と読み替えない** |
| dispatch `verification_gates_unrecorded`（`--unattended`） | 契約 pass なのに `GATE` 行を読めず、**pass の根拠を report が名指しできない**。**まず runner の版を確かめる**（0.26.0 以前は `GATE` 行が **stderr に出る**のを読み落とす。#160）。修正版でも空なら `commandmate wait <id> --verify` を手で確かめる |
| merge `acceptance_gates_required` / `no_acceptance_criteria`（`--unattended --merge-prs`） | 受入ゲート／受入条件が無い。**1つも merge していない。Issue 本文に書いて re-plan する**（除外して回す道は無い） |
| uat `unattended_cwd_detached` / `unattended_cwd_branch_mismatch`（`--unattended`） | 再merge の入り先（cwd の branch）が detached / `--expect-branch` と違う。**fix worktree を1つも作っていない。** cwd を checkout して再実行する |

**無人 run の取り消し**は、`limitations` の `unattended_baseline`（**branch 名と短縮 SHA**）を起点に
**上流から順に**行う —— `git reset --hard <sha>`、worktree が既に片付いていれば
`git branch -f <branch> <sha>`。**この起点が担保するのは worktree branch の1段だけである**
（untracked file・既に merge / push された変更・消えた object には届かない）。手順と効かない4条件は
[references/codes-and-recovery.md](./references/codes-and-recovery.md) 第5節。
**取り消せるのはリポジトリの状態であって、送られた通知ではない。**

## 6. 参照

**契約の正本**（この文書と食い違ったら正本が優先する）— 第3節の runner 表からもリンクしている
4つの `*-contract.md` に加えて:

- [references/acceptance-gates-notation.md](./references/acceptance-gates-notation.md) — Issue 本文の `acceptance-gates` ブロックの記法（**記法の正本**）
- [references/profile-contract.md](./references/profile-contract.md) — profile の形と unverified の扱い
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と fallback
- [references/release-notes.md](./references/release-notes.md) — なぜその挙動なのか（経緯）

**運転ノート**（SKILL.md が4点に収めるために移送した機構の細部。この文書から一方向に参照する）:

- [references/runner-operations.md](./references/runner-operations.md) — 各 runner のオプション運用（ランチャー表記・前提・dispatch の各 flag・PR 本文・profile-init・status）
- [references/codes-and-recovery.md](./references/codes-and-recovery.md) — 出力 code の全一覧と、**停止したときの対処表の正本**

**ADR（裁定の記録。契約の正本ではない）**:

- [references/adr-issue-acceptance-gates.md](./references/adr-issue-acceptance-gates.md) — Issue 受入条件の機械ゲート化
- [references/adr-worktree-preparation.md](./references/adr-worktree-preparation.md) — worktree 準備段の合成（`--prepare-worktrees`）
- [references/adr-worker-development-skill.md](./references/adr-worker-development-skill.md) — ワーカー側方法論の呼び出し口（`--worker-method`）
- [references/adr-unattended-mode.md](./references/adr-unattended-mode.md) — 無人運転（`--unattended`）の段階 A〜C
- [references/adr-scope-derivation.md](./references/adr-scope-derivation.md) — scope の導出（宣言 → 認可境界の閉包）**proposed**

**機械検証用 schema** — `schemas/` に
[execution-plan.v2](./schemas/execution-plan.v2.json)（plan）・
[orchestrate-result.v1](./schemas/orchestrate-result.v1.json)（planner envelope）・
[dispatch-report.v1](./schemas/dispatch-report.v1.json)・
[merge-report.v1](./schemas/merge-report.v1.json)・
[uat-report.v1](./schemas/uat-report.v1.json)。意味ゲートの入力は
[acceptance-result.v1](../cmate-acceptance-test/schemas/acceptance-result.v1.json)（別 package）。
status runner の `--json` は artifact ではなく view なので（何も書かない）`schemas/` に対応する
file を持たない。field は第3.7節が正本である。