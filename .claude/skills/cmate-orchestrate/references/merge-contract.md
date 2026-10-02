# merge 契約 v1

`cmate-orchestrate` の merge runner（`scripts/merge.mjs`）が、dispatch 済みの plan に対して
**PR 作成・CI 確認・guarded merge** の mutating phase をどう実行し、`gh` / `git` CLI とどう
話すかの定義である。機械検証用の正本は
[../schemas/merge-report.v1.json](../schemas/merge-report.v1.json)（merge report）であり、
この文書はその読み方と、schema では表現できない規則を述べる。

計画コア（[plan-contract.md](./plan-contract.md)）は dry-run で plan を作り、dispatch runner
（[dispatch-contract.md](./dispatch-contract.md)）は worker を監督して verification gate まで進める。
merge runner は、その **dispatch report で「worker 完了かつ verification pass」だった Issue** だけを
対象に、PR を作り、CI を確認し、条件を満たしたときだけ merge する。3つは別 runner であり、
planner の `--phase merge`/`--phase pr` は依然として `not_implemented` を返す。

`merge_schema_version` は 1 である。field の追加・削除・意味の変更、および enum への値の追加は
version を上げて行う。**未知の field を足さないこと。**

## 1. explicit phase flag（1 invocation = 1 mutating phase）

CommandAgent の explicit phase flag 設計（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）を踏襲し、
**1 回の invocation で有効化できる mutating phase はちょうど1つ** である。

| flag | phase | 内容 |
|---|---|---|
| `--create-prs` | `create_prs` | verification pass した branch を push し、PR を作成する |
| `--merge-prs` | `merge_prs` | 各 PR の CI を確認し、green のときだけ merge する（guarded） |

両方指定・どちらも未指定は `invalid_input` で拒否する（既定で片方を選ばない）。

## 2. 入力

```
merge.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--create-prs | --merge-prs) [options]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json`（plan-core の出力） |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible 集合の唯一の根拠 |
| `--create-prs` / `--merge-prs` | どちらか1つ必須 | なし | 有効化する mutating phase |
| `--approve` | 任意 | **off** | 明示承認。無ければ mutation しない preview |
| `--unattended` | 任意 | **off** | この invocation に人間は居ない、という**入力の宣言**（5.3節）。**`--create-prs` でのみ受理**する。`--merge-prs` との併用は `invalid_input`（段階 C 未実装） |
| `--integration-verify` | 任意 | **off** | 合流後の統合ブランチを検証する（5.4節）。**`--merge-prs` でのみ受理**する。`--create-prs` との併用は `invalid_input`（merge しない phase には合流後が無い） |
| `--merge-method <m>` | 任意 | `squash` | `merge_prs` の merge 方式（`merge`/`squash`/`rebase`） |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` で拒否 |
| `--gh <path>` | 任意 | `gh` | PR 作成・CI 確認・merge に使う GitHub CLI |
| `--git <path>` | 任意 | `git` | branch push と base preflight に使う git |

`commandmatedev` は使わない。公式経路は public `gh`/`git` である。

## 3. eligible 集合（verification gate の継承）

merge runner が対象にするのは、dispatch report の `waves[].workers[]` のうち
**`worker_state` が `completed` かつ `verification.outcome` が `pass`** の Issue だけである。
worker 完了だけでは対象にしない。verification が pass していない Issue を PR や merge に
変えることは無い。対象は plan の `merge_order` 順に処理し、依存順を守る。

eligible が空の場合は `no_eligible_issues`（limitation）を載せて no-op success とし、mutation
はしない。

**dispatch の wave barrier は、この runner まで含めて完成する**（[#175](https://github.com/Kewton/commandmate-skills/issues/175)）。
「全 worker completed かつ verification pass」は **1本ずつの branch について**の条件であって、
**それらを合流させた統合ブランチについては何も言っていない**。`--integration-verify`（5.4節）を
渡した run では、barrier は「合流後の統合ブランチも green」まで含む。渡さない run では
従来どおりの意味のままである（既定 off）。

## 4. 2つの gate（承認 と CI pass）

**PR 作成・merge は、次の gate をすべて満たすときだけ実行する。丸めない。**

1. **明示承認（approval gate）** — `--approve` が無ければ、その phase は **preview** であり、
   push・PR 作成・merge を **一切しない**。`create_prs` の preview は「何を作るか」を、
   `merge_prs` の preview は read-only の `pr view` / `pr checks` で「CI が green なら merge する」
   ことを報告するに留め、`mutated` は false のままにする。
2. **CI pass（CI gate, `merge_prs` のみ）** — PR を merge するのは、その PR の versioned CI
   checks が **すべて green** のときだけである。1つでも failure なら `ci_failed`、pending や
   check が1つも無いなら `ci_pending` として **merge を拒否** する。未知の check state は
   green と見なさない。

`mutated` が true になるのは、`git push` / `gh pr create` / `gh pr merge` を実際に呼んだときだけ
であり、`--approve` 無しでは常に false である。

## 5. gh / git 呼び出し規約

merge runner は次を呼ぶ。各呼び出しは失敗で非0を返し、握りつぶさない。

| phase | 呼び出し | 期待する出力 | 用途 |
|---|---|---|---|
| 両 phase | `git rev-parse --git-path index.lock`（cwd = 呼び出し元） | lock が置かれる path | 呼び出し元 worktree の `index.lock` 検査（5.5節）。**invocation あたり1回**、pre-flight より前に引く。失敗しても停止しない（記録が null になるだけ） |
| preflight | `gh --version` | exit 0 | gh 到達性 |
| preflight | `gh repo view <repo> --json nameWithOwner` | `{ "nameWithOwner": "…" }` | repo アクセス |
| preflight | `git rev-parse --verify <base>` | exit 0 | base 解決 |
| create_prs | `gh repo view <repo> --json defaultBranchRef` | `{ "defaultBranchRef": { "name": "…" } }` | Issue 自動クローズの到達性（invocation あたり1回） |
| create_prs | `git diff --name-only -z <base>...<branch>`（cwd = その Issue の worktree） | NUL 終端の変更 file 一覧 | PR 本文の「実変更」（読めなければ本文に「読めなかった」と書く） |
| create_prs | `git diff --numstat -z <base>...<branch>`（cwd = 同上） | `<added>\t<deleted>\t<path>` の NUL 終端レコード | PR 本文の diff 規模 |
| create_prs | `git log --no-merges --format=%s%x1f%b%x1e <base>..<branch>`（cwd = 同上） | コミットごとの件名と本文 | PR タイトルの type / scope（5.7節）と、ワーカーの申告（5.8節）。**Issue あたり1回** |
| create_prs | `git push --set-upstream origin <branch>` | exit 0 | verification pass branch を push |
| create_prs | `gh pr create --repo R --base B --head <branch> --title T --body-file F` | PR URL を stdout | PR 作成 |
| merge_prs | `gh pr view <branch> --repo R --json number,url,state` | `{ "number", "url", "state" }` | PR 発見 |
| merge_prs | `gh pr checks <number> --repo R --json name,state` | `[{ "name", "state" }]` | CI 確認 |
| merge_prs | `gh pr merge <number> --repo R --<method>` | exit 0 | guarded merge |
| merge_prs（`--integration-verify` のみ） | `git fetch origin <base-branch>` | exit 0 | 合流後の base を remote から読み直す（5.4節） |
| merge_prs（同上） | `git rev-parse --verify FETCH_HEAD` | 合流後の tip の SHA | 検証対象の同定（短縮 SHA を report に載せる） |
| merge_prs（同上） | `git worktree add --detach <out>/integration-tree FETCH_HEAD` | exit 0 | 使い捨ての合流後 checkout |
| merge_prs（同上） | profile の `baseline` の各 command（cwd = 上の checkout） | すべて exit 0 なら green | 統合検証そのもの。**runner は command を1つも持たない** |
| merge_prs（同上） | `git worktree remove --force <out>/integration-tree` | exit 0 | 後始末（失敗しても裁定は変えず、`integration_verify_tree_left` に残す）。**成否は必ず `integration_verify.tree_removed` に記録する**（5.5節） |

規則:

- PR body は objective・受入条件・**検証証拠**（5.2節）・`Resolves #n` からなる self-contained な
  内容とし、`<out>/pr-bodies/issue-<n>.md` に artifact として残す。
- `--base` は profile の base（例 `origin/develop`）から先頭 remote 節を除いた branch 名にする。
- `--title` は profile の `pr_title_template` が無ければ Issue タイトル、あればその型を埋めたもの（5.7節）。
- CI の green 判定は、check state を pass（`SUCCESS`/`NEUTRAL`/`SKIPPED`）・pending
  （`PENDING`/`QUEUED`/`IN_PROGRESS`/…）・それ以外（failure 扱い）に分け、
  **1件以上 かつ 全て pass** のときだけ green とする。check が0件なら green にしない。
- branch 名は safe-ref 検査（英数・`._/-` のみ、`..` 無し、先頭 `/`・`-` 不可）を通す。
- `git diff` は **必ず `-z`** で読む（[#174](https://github.com/Kewton/commandmate-skills/issues/174)）。
  既定の改行区切りでは git が path を C クォートして返す（`core.quotePath` が既定 true なので
  非ASCII バイトは8進エスケープ、`"`・`\`・制御文字はその設定に関係なくクォート）ため、
  plan の `scope.allow`（Issue が書いたままの UTF-8）と突き合わせると**同じ file が一致しない**。
  `-c core.quotePath=false` は非ASCII しか解かない。`-z` は munge を止め、区切りも NUL になるので
  改行を含む path が2件に割れることも無い。PR 本文が引用する command 行も `-z` 付きで書く
  （読み手が同じ command を再実行して同じ path を得られるようにするため）。

## 5.1 Issue 自動クローズの到達性（`Resolves #n` の限界）

GitHub が closing keyword で Issue を閉じるのは、その PR が **デフォルトブランチ** に merge
された時だけである。profile の `base` はデフォルトブランチとは限らず（`feature/* → develop →
stg → main` の運用では `origin/develop`）、その場合 PR body の `Resolves #n` は **効かない**
— PR は merge されるのに Issue は open のまま残る（[#39](https://github.com/Kewton/commandmate-skills/issues/39)）。

`create_prs` phase の冒頭で `gh repo view <repo> --json defaultBranchRef` を **1回だけ** 引き、
PR の base（`baseBranchName(plan.profile.base)`）と比較する。

| 比較結果 | 動作 |
|---|---|
| base ≠ デフォルトブランチ | `limitations[]` に `issue_autoclose_not_default_branch` を記録し、各 PR body に注記を1行足す |
| base = デフォルトブランチ | 何も記録しない |
| 取得失敗 / `defaultBranchRef` 欠落 | **照合をスキップ**する。limitation も blocking も足さず、PR 作成フローを阻害しない |

記録に留める。`gh issue close` を runner が勝手に実行することはしない（「勝手に閉じない」
という製品方針より）。**merge 後のクローズは operator の手作業である。**

## 5.2 PR body の Verification 節 = 検証証拠の提出

worker の完了は「実装結果と**検証証拠を提出する**」ことである。検証そのもの（`wait --verify` の
exit code を一次ソースとし、verification pass だけを merge 対象にすること）は dispatch 側で
済んでいるが、**証拠が人間に届くのは PR 本文だけ**である。そこで Verification 節は定型文を
持たず、当該 Issue の実測値だけで構成する（[#97](https://github.com/Kewton/commandmate-skills/issues/97)）。

| 節 | 内容 | 出どころ |
|---|---|---|
| verdict | `verification.outcome`。`ran: false` なら「検証は走っていない」と明示する | dispatch report の当該 worker（同じ Issue が複数 wave にあれば**最後**の記録） |
| Gates 表 | gate 名 / 合否 / exit code（`gate <id>: <status> (exit n)` 形の check 行から拾える場合。無ければ `—`） | `verification.gates` + `verification.checks` |
| Checks 表 | 記録された check 行そのまま / そこに書かれた exit code | `verification.checks` |
| 宣言 scope vs 実変更 | `scope.allow`（plan の `suspected_files`）と実変更 file の対比表、**scope 外変更の件数** | plan + `git diff --name-only -z <base>...<branch>`（当該 worktree で実行） |
| diff 規模 | 変更 file 数・追加/削除行数 の1行 | `git diff --numstat -z`（同上） |

規則:

1. **転記であって主張ではない。** dispatch report は runner が書いた保証の無い**入力**なので、
   転記値は例外なく `redact()` を通す。redact 済みだと仮定しない。
2. **読めなかったものを pass に丸めない。** diff が読めなければ本文にその事実と理由を書き、
   `limitations[]` に `change_evidence_unavailable` を記録する。「変更なし」とも
   「scope 内に収まっていた」とも書かない。`ran: false` も同様に明示する。
3. **黙って切り詰めない。** gh の本文上限（65536 字）に収めるため gates（30）・checks（15）・
   path（50）の一覧は上限件数で打ち切るが、**打ち切った件数を本文に書く**。本文全体が上限を
   超える場合も、切り詰めた旨の marker を末尾に置く。
4. 実変更が `scope.allow` の外に出ていれば違反 path を本文で名指しし、`limitations[]` に
   `branch_changed_outside_declared_scope` を記録する。契約ゲート `requireScopeClean` の
   人間可読版であり、**phase は止めない**（機械ゲートは上流で既に判定済みである）。
5. scope entry は原則ただの repo 相対 path だが、契約は pattern を許すので `*` / `**` を
   解釈して照合する。pattern を literal として扱うと scope 内の変更を違反と誤報する。

merge-report.json / merge-summary.md の**構造は変えない**。本文と report が食い違わないよう、
上の 2 つの limitation だけを既存の `limitations[]` に足す。

## 5.3 無人運転（`--unattended`。両 phase）

[adr-unattended-mode.md](./adr-unattended-mode.md) 第8節の**段階 B**（`--create-prs`。
[#134](https://github.com/Kewton/commandmate-skills/issues/134)）と**段階 C**（`--merge-prs`。
[#142](https://github.com/Kewton/commandmate-skills/issues/142)）である。dispatch の同名フラグ
（[dispatch-contract.md](./dispatch-contract.md) 第3.0.3節）と**同じ宣言**であり、
runner 間で伝播はしない —— この runner は上流の dispatch が unattended だったかを**検査しない**
（同 ADR 第8節「runner 間で unattended を伝播させない」）。

**`--unattended` は「この invocation に人間は居ない」という入力の宣言であって、
mutation の権限を与えるフラグではない。含意するのは締め付けだけである**（ADR 第2節「裁定 0」）。

| 論点 | 規定 |
|---|---|
| `--approve` との関係 | **含意しない。** `--unattended` だけの invocation は preview であり、push も PR 作成も merge もしない。無人で回す CI は**両方**書く。これにより `approved: true` は「この mutation は明示的に承認された」を意味し続ける |
| `--create-prs` が含意する締め付け | **1つだけ: `change_evidence_unavailable` を limitation ではなく blocking として扱う**（5.2節 規則2 / ADR 第6.5節）。**その Issue の PR を作らずに停止**する（`partial` / exit 7 / `stop_reason: pr_create_failed`・target outcome `pr_failed`）。以降の eligible は `skipped` として残す。**PR 本文（`pr-bodies/issue-<n>.md`）も書かない** —— 作らない PR の本文を残さない |
| `--merge-prs` が含意する締め付け | **1つだけ: 全 eligible Issue が「受入ゲートブロックを持つ」かつ「受入条件を持つ」こと**（ADR 第9節 条件2）。1件でも欠ければ **1つも merge せずに停止**する（`failure` / exit 1 / `stop_reason: preflight_failed`）。**除外ではなく停止**であり、**条件を満たす Issue も merge しない** —— 対象集合を黙って縮めない（第3節・ADR 却下案 C と同じ理由）。読むのは plan だけで、`acceptance_gates` の `require` と `gates` が**どちらも**空／欠落なら `acceptance_gates_required`（[#125](https://github.com/Kewton/commandmate-skills/issues/125): `gates:` だけを宣言したブロックも declaration である —— 既存ゲートを選ぶのは誰かが既に書いた条件の再利用だが、定義するのは Issue が新しい条件を書いたということであり、後者を「宣言していない」と読むのは強いほうを拒むことになる）、`acceptance_criteria` が空なら planner と同じ code **`no_acceptance_criteria`** を `blocking_reasons[]` に積む（Issue ごとに1件、**最初の1件で打ち切らない**）。**ゲート id が実在するかは問わない** —— それは worktree を持つ dispatch の問い（`acceptance_gate_id_unknown`）であり、ここで再判定すると既に消えているかもしれない worktree について二番目に悪い意見を出すことになる |
| 昇格しないもの | **`branch_changed_outside_declared_scope`。** 契約ゲート `requireScopeClean` が上流で既に判定しており、unattended dispatch は契約経路を必須にしているので、この limitation は「機械ゲートが通ったうえでの人間可読版」であることが保証される（ADR 第6.5節） |
| phase をまたがないこと | 段階 C の受入条件検査は **`--merge-prs` のみ**に効く。`--create-prs` の締め付けリストは段階 B の1件のままである（後から段階 B の意味を変えない）。fixture で両方向に固定してある |
| 拒否する入力 | dispatch の緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode`）はこの runner に存在しないので、未知 option として `invalid_input`（exit 3）になる。**受理して無視しない** |
| 証跡 | `limitations[]` の **`unattended_mode`**（run 全体で1件。preflight で止まった run にも残る）。**phase ごとに含意した締め付けを detail に書き分ける**（`--merge-prs` の report が `--create-prs` の昇格を語らない）。**絶対 path を書かない**（redaction の tally がフラグ無しの run と食い違うため） |
| 変えないもの | `merge_schema_version` は **1 のまま**。`stop_reason` にも target `outcome` にも**値を1つも足していない**。全 gate が通る世界では、フラグ無しの run と**同じ `status` / `stop_reason` / 作られる PR / merge される PR** になり、差分は `unattended_mode` の1件だけである（両 phase について fixture で機械的に固定してある） |

**`gh` 由来の停止は足していない。** [#115](https://github.com/Kewton/commandmate-skills/issues/115)
の実測（ADR 第14.5節）どおり **`gh pr create` / `gh pr merge` は TTY 非依存で完結する** ——
認証切れも確認プロンプトも gh は待たずに非ゼロで落ち、既存の `pr_create_failed` /
`merge_failed` / `preflight_failed` が受ける。足すべきは停止ではなく**入力の衛生**であり、
無人運転では **job 定義側**で次を置くこと。

- `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）
- **`GIT_TERMINAL_PROMPT=0`**

**`git push` の資格情報プロンプトだけは別**で、git は stdin ではなく `/dev/tty` を読むため、
**制御端末を持つ起動元**（tmux ペインから起動した cron、人間の shell）では
`stdio: ['ignore', …]` はプロンプトを止めない —— 「止まる」ではなく**無言で待つ**に化ける唯一の
経路である。**runner はこれを検査しない**（別プロセスの環境を runner は保証できない。
第4節の monitor と同じ理由）。

## 5.4 合流後の統合ブランチ検証（`--integration-verify`。既定 off。`--merge-prs` のみ）

[#175](https://github.com/Kewton/commandmate-skills/issues/175) である。**wave barrier の
意味を「全 worker completed + verification pass」から「合流後の統合ブランチも green」へ
拡張する**のがこの節であり、拡張は opt-in で入る（既定 off、フラグ無しの挙動は #175 以前と
**byte 単位で同一**。fixture `m22-integration-verify-absent` が pre-#175 の runner が書いた
golden と byte 比較して固定している）。

### なぜ要るか（実測）

wave の衝突検出が見るのは `suspected_files` の重なりだけである。**片方がデータを直し、
もう片方がそのデータの性質に依存する検査を書く**類の衝突は file が重ならないので
「衝突なし」として同一 wave に入る。そして guarded merge が確認するのは **PR 個別の CI**
であり、その CI は**兄弟 PR が merge される前の base** で走っている。結果として
**合流後の状態は誰も検証していない**。

実測（2026-08-12、Kewton/BorderFreeKidsMap #105 × #106）: 一方が `facilities.json` の重複を
除去し、他方が「同じ素材名が2回出るデータが存在する」ことに依存する空振り検査を test に
足した。file 重なり 0、plan の file conflict にも出ず、PR 個別 CI は両方 green（8秒差で merge）。
develop に入った直後から `npm run test:unit` が赤で、**発覚は develop → stg の promotion PR の CI**
だった。

### 何を、どこで、いつ実行するか

| 論点 | 規定 |
|---|---|
| 何を | **profile の `integration_baseline` ?? `baseline`**（[profile-contract.md](./profile-contract.md) 第11節。[#195](https://github.com/Kewton/commandmate-skills/issues/195)）。`integration_baseline` を宣言していない profile では `baseline` —— dispatch の fallback 検証が worktree の中で再実行するのと同じ配列 —— がそのまま走る（#195 以前と同一）。**`npm` も `develop` も runner は1つも持たない** —— 規約の出どころは profile だけ、という設計原則（同第1節・ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）をここでも守る |
| どちらを採ったか | `integration_verify.source`（`"integration_baseline"` \| `"baseline"`）に**必ず記録する**。何も実行しなかった run でも記録する。**どちらを測ったのかが report から読めないと、この分離は「静かな2つ目の baseline」になる**（profile-contract.md 第11.3節） |
| どこで | **使い捨ての detached checkout**。`git fetch origin <base-branch>` で remote を読み直し、`FETCH_HEAD`（＝ **今この invocation が merge し終えた後の** base の tip）を `git worktree add --detach <out>/integration-tree` で取り出し、その中で baseline を回して `git worktree remove --force` で畳む。**invocation の作業ツリーには一切触れない**（operator が checkout している branch は operator のものである）。ここで作るのは branch を持たず CommandMate にも登録しない使い捨てなので、[adr-worktree-preparation.md](./adr-worktree-preparation.md) が `cmate-worktree-setup` に委ねている **worker 用 worktree の準備段ではない** |
| なぜ `FETCH_HEAD` か | ローカルの `develop` も、fetch 前の `origin/develop` も、**各 PR の CI が既に green だと主張した状態**である。合流後を測るには remote が今持っている tip でなければならない |
| いつ | merge ループの**後**に**1回だけ**（PR ごとではない）。対象は **この invocation が実際に merge した PR** の集合（`integration_verify.merged_issues`）。途中で止まった run でも、1件でも merge していれば実行する —— 止まったことと、既に入った分が green かは別の問いだからである |
| 走らない場合 | この invocation が1件も merge していないとき（preview・eligible 無し・最初の merge の前に停止）。`outcome: not_run` と limitation `integration_verify_not_run` を残す。**「測っていない」であって「green」ではない** |
| `--approve` との関係 | 含意しない。承認が無ければ merge が無く、merge が無ければ検証する合流後も無い（上の行に落ちる） |
| `--unattended` との関係 | **独立である。** `--unattended`（5.3節）はこのフラグを含意せず、このフラグも `--unattended` を含意しない。段階 C が `--merge-prs` に含意する締め付けは**受入ゲートブロックと受入条件の1つだけ**であり、後から品目を足して段階 B / C の意味を変えることはしない（5.3節「phase をまたがないこと」と同じ規律）。無人で合流後まで見たい CI は**両方書く** |

### 実行できる command が1つも無いとき —— **error（skip ではない）**

`--integration-verify` を渡したのに、解決された集合（第11.2節の表）に command が1つも無い場合、
**最初の merge の前に `failure` / exit 1 / `stop_reason: preflight_failed` /
`blocking_reasons[]` に `integration_verify_unavailable` で拒否する。1件も merge しない。**

- skip にすると、**opt-in した検証が走らないまま「merge phase 完了」と報告される**。それは
  この Issue が消しに来た事象そのものである（誰も合流後を見ていないのに緑に見える）。
- 同じ読みは既に2箇所にある: dispatch の fallback 検証は baseline が空なら
  `outcome: fail`（「検証すべき gate が無いから pass」に化けさせない）、profile-init が
  埋められない baseline に置く雛形は **exit 0 しない command** である
  （profile-contract.md 第7.2節）。**埋め忘れた baseline は fail-closed でなければならない。**
- **merge の前**に拒否するので世界は動いていない。operator は profile を直して
  同じコマンドを再実行すればよく、取り消すものは何も無い。

**この拒否は2種類あり、対処が逆である**（[#195](https://github.com/Kewton/commandmate-skills/issues/195)）。
`source` が両者を分ける。

| `source` | 何が起きたか | 対処 |
|---|---|---|
| `"baseline"` | `integration_baseline` は未宣言で、フォールバック先の `baseline` が空である | profile に `baseline` を書く（合流後を別集合で判定するなら `integration_baseline` に書く） |
| `"integration_baseline"` | **`"integration_baseline": []` が宣言されている** ——「このリポジトリに統合検証の定義は無い」 | **`baseline` へは落とさない。** 合流後の「合格の定義」を `integration_baseline` に書く。`baseline` を流用してよいなら **key ごと消す**（未宣言に戻せばフォールバックが効く） |

後者に「`baseline` を宣言してから再実行する」と案内するのは、**operator が意図して書いた宣言を
取り消せという指示**になる —— #195 が消しに来た静かなフォールバックを、散文で提供し直すことになる。
summary の next action は `source` で分岐する。

### code と、停止が次 wave へ伝わる経路

| code | どこに | いつ | status / stop_reason |
|---|---|---|---|
| `integration_verify_failed` | `blocking_reasons[]` | 合流後の baseline が赤 | `partial` / `merge_failed`（exit 7） |
| `integration_verify_unavailable` | `blocking_reasons[]` | 検証を実行できない（実行できる command が無い ／ fetch・rev-parse・checkout の失敗） | command が無い場合は `failure` / `preflight_failed`（exit 1、merge 前。`source` が上の表のどちらかを名指す）。merge 後の probe 失敗は `partial` / `merge_failed`（exit 7） |
| `integration_verify_not_run` | `limitations[]` | 1件も merge していないので検証対象が無い | 変えない |
| `integration_verify_tree_left` | `limitations[]` | 使い捨て checkout を畳めなかった | 変えない（裁定は baseline の結果のまま） |

**次 wave の dispatch が読むのは `merge-report.json` の `integration_verify.outcome` である。**

- `"pass"` —— 合流後の統合ブランチが green。**barrier のこの半分は満たされた。**
- `"fail"` —— 赤。**次 wave を dispatch しない。**（`blocking_reasons[]` に
  `integration_verify_failed` が、`status` に `partial` が同じ事実を運ぶ。3つは同時に立つので、
  どれを読んでも同じ結論になる）
- `"not_run"` —— **測っていない。green ではない。** barrier は満たされていないので進まない。
- **field ごと無い** —— その run は `--integration-verify` を渡していない。**「検証して green だった」
  ではなく「検証していない」である。** 既定 off なのでこれが従来どおりの run であり、
  barrier を旧来の意味（全 worker completed + verification pass）で運用している。

**`outcome` は既存の判定を置き換えるのではなく、条件を1つ足す。** 進んでよいのは
**`status: "success"` かつ `integration_verify.outcome: "pass"`** のときだけである
（この2つは独立している —— 途中で止まった phase でも、既に merge した分の合流後が green であれば
`pass` は立つ。それは「入った分は健全である」であって「wave を配り切った」ではない）。

**この Issue では dispatch runner を1行も変えていない**（`orchestrate.mjs` / `dispatch.mjs` は
別 Issue が同時に触っているため）。受け口の実装は
[#183](https://github.com/Kewton/commandmate-skills/issues/183) が拾う。ここで決めてあるのは
**report 側の field 設計**であり、dispatch はそれを読むだけでよい。

#### #183（DAG スケジューリング）から見たこの検証の位置

[#183](https://github.com/Kewton/commandmate-skills/issues/183) が `dispatch --schedule dag` を
足したことで、**上の「次 wave」という言い方が成り立たない run が存在する**ようになった。dag では
wave 境界が無いので、「wave ごとに merge して合流後を測ってから次へ」という運用上の停止点が
構造的に消える。#183 の裁定は次のとおりである（詳細と根拠は
[dispatch-contract.md 第3.2節](./dispatch-contract.md)）。

**`--schedule dag` の run では、合流後の統合ブランチ検証は run の末尾に1回回す。**

```bash
node scripts/merge.mjs --dispatch <out>/dispatch-report.json --merge-prs --approve --integration-verify
```

- **`merge.mjs` は1行も変わっていない。** #183 が足したのは dispatch 側の scheduler だけで、
  この検証は**この節の実装をそのまま**、別 invocation として呼ぶ（1 invocation = 1 mutating phase の
  規律は第1節のままである）。dispatch が内側で merge を呼ぶ形は採らなかった —— merge は `--approve`
  と PR 作成 / merge という別の権限を持ち、`--integration-verify` は base を fetch するので、
  承認境界が dispatch の flag 1つに畳まれてしまう。
- 「merge のたび」「N 件ごと」は採らなかった。wave 境界には「そこまでの依存が閉じている」という
  意味があったが、任意の N にはそれが無く、境界の意味が run ごとに変わる。
- **dag が失うのは「合流後の赤を早く見つけること」であって、「合流後を見ること」ではない。**
  依存を宣言している下流は上流の `verification pass` を待つので、壊れた前段の上に積むことは起きない。
  残るのはこの節が見つけたクラス（**file が重ならないのに合流後だけ赤くなる**）で、これは wave 境界でも
  dag でも **merge の時にしか測れない**。dispatch の report と summary はこの1行の指示を必ず書く
  （limitation `schedule_dag`）。

### 変えていないもの

- `merge_schema_version` は **1 のまま**。`stop_reason` にも target `outcome` にも
  `preflight[].code` にも **値を1つも足していない**（第6節・第10節）。#195 も
  `blocking_reasons[]` / `limitations[]` の code を1つも足していない —— 分岐したのは
  `detail` と summary の next action だけで、機械が読む面は `integration_verify.source` の1 field である。
- 足したのは **optional な field `integration_verify` 1つだけ**で、それも
  `--integration-verify` を渡した run にしか現れない。渡さない run の report は
  **key 集合も bytes も #175 以前と同一**である（#195 が足した `source` はその object の中にあるので、
  この性質は変わらない。fixture `m22` が pre-#175 の golden と byte 比較して固定し続ける）。
- **`integration_baseline` を宣言していない profile の run も #175 以前と同一**である。
  解決は未宣言のとき `baseline` に落ちるので、既存 profile が測る集合は1つも変わらない
  （fixture `m23` / `m24` が `source: "baseline"` としてそれを固定する）。
- merge queue 方式（base 更新 → CI 再走 → merge の直列化）は**実装しない**。Issue 本文が
  「まずは合流後検証の1段で十分」と裁定している。合流後検証で赤を捕まえられない事象が
  実運用で繰り返し出たときに、その事例とともに再検討する。

## 5.5 呼び出し元 worktree の `index.lock`（両 phase。既定 on。裁定を変えない）

### なぜ要るか（実測）

`--merge-prs --approve --integration-verify` が `status: success` /
`integration_verify.outcome: pass` で終わったあと、**呼び出し元 worktree に 0 バイトの
`index.lock` が残り、後続の `git pull --ff-only` が落ちる**ことが同日に 2 回あった
（[#222](https://github.com/Kewton/commandmate-skills/issues/222) / CommandMate #1836。
発見時点でそれぞれ約 40 分・52 分経過、`pgrep -fl 'git '` は該当なし、手で消せば復旧）。

**危険なのは lock ではなく、それが「merge が壊れた」と読めることである。** merge も統合検証も
終わっているので、ここで巻き戻すと**正しく終わった run の上に二次被害を積む**。

**この runner に原因は無い。** 上の第5節の表が全件である —— 呼ぶ git verb は `fetch` /
`rev-parse` / `worktree add|remove` / `diff` / `push` だけで、`checkout` / `merge` / `reset` /
`read-tree` / `stash` / `pull` / `update-index` は**1つも無い**（呼び出し元の index を書く経路が
無い）。統合検証は 5.4 節どおり `git worktree add --detach` の使い捨て checkout で行い、
**呼び出し元の作業ツリーを触らない**。`runCli` は `timeout` も `killSignal` も渡さないので、
runner が git を SIGKILL する経路も無い。したがってこの節が約束するのは修理ではなく**測定**である。

### 何を、いつ測るか

| いつ | 何を |
|---|---|
| run の開始時（**pre-flight より前**。この invocation が git を1回も呼ぶ前） | `git rev-parse --git-path index.lock` → `stat`。結果を `caller_worktree.index_lock_before` に記録する |
| report を書く直前（success / failure / partial のいずれでも。summary を組み立てる前） | 同じ path を再度 `stat`。結果を `caller_worktree.index_lock_after` に記録する |

path を git に**訊く**のは、linked worktree では `.git` が file であり、実体が
`<main>/.git/worktrees/<name>/index.lock` に在るからである（実測の失敗メッセージが出した path が
まさにそれ）。記録は**呼び出し cwd からの相対**にする —— 第7節（絶対 path を残さない）に従い、
かつ復帰は同じ cwd で走るのでそのまま使える。git が答えられない（リポジトリでない等）ときは
**両方 null**であり、それは「lock は無かった」ではなく「**何も測っていない**」である。

### code と、裁定に対する位置

| 何が起きたか | code | severity |
|---|---|---|
| 開始時から在った | `caller_index_lock_pre_existing` | **notice**（limitation。停止しない） |
| 開始時に無く、終了時に在る | `caller_index_lock_appeared` | **notice**（limitation。停止しない） |

**どちらも status / stop_reason / exit を1文字も動かさない。** 停止しない理由は 2 つある:
この runner は呼び出し元の index を読み書きしないので**止める理由が無い**こと、そして
merge と統合検証が終わった run を failure に落とすのは**本節が消そうとしている誤読そのもの**で
あることである。`caller_index_lock_appeared` は「開始時に無く終了時に在る」という**観測**であって、
**この runner が作ったという主張ではない**。

**runner は lock を消さない。** lock は「今この index を書いている」という git の宣言であり、
他人が保持中の lock を消すと**それが守っていた index が壊れる**。復帰手順（先に
`integration_verify.outcome` と各 target の `merged` を読む → size 0 / mtime が run 中 /
`pgrep -fl 'git '` に該当なし、が揃うときだけ人間が手で消す）は
[codes-and-recovery.md](./codes-and-recovery.md) 第4節が正本である。

### 後片付けの報告（`integration_verify.tree_removed`）

同じ Issue で、使い捨て checkout の後片付けを**両方向**記録するようにした。#175 では
畳めなかった側（`integration_verify_tree_left`）しか記録が無く**成功が無言**だったので、
「畳んだ」と「言えるほど新しくない runner」が同じ report だった。`tree_removed` は
`integration_verify.ran` が true のとき**だけ**現れる（＝畳む対象が在ったときだけ）ので、
不在は「checkout を作っていない」であって「測っていない」ではない。`false` は必ず
`integration_verify_tree_left` と併存する。

### 変えていないもの

- `merge_schema_version` は **1 のまま**。`stop_reason` にも target `outcome` にも
  `preflight[].code` にも値を1つも足していない（第6節・第10節）。
- 足したのは optional な `caller_worktree`（**両 phase**に出る。`--create-prs` も同じ cwd から
  `git push` / `git diff` を回すので、片方だけ答えられる report は「もう片方は触らない」という
  測っていない主張に読める）と、`integration_verify` の内側の `tree_removed` である。
- **lock が無い run の意味は変わらない**: 両方 null であり、それは #222 以前のすべての run が
  記録していたはずの値である（fixture `m22` の golden はこの block だけを増やして byte 比較を
  続ける）。
- **lock を消す経路は実装にも fixture にも1つも無い**。`m33` / `m34` は run のあとに lock file が
  **残っていること**をファイルシステムの事実として確かめる —— limitation が同じでも、unlink する
  実装なら赤くなる。

## 5.6 宣言 scope の判定（`scopeMatches`）

PR 本文の「Declared scope vs. actual changes」節（第5.2節）は、変更 file 1件ごとに
「宣言 scope の内側か」を判定して out-of-scope 件数と対比表を作る。この判定は
**CommandMate の scope ゲートと同じ関係**でなければならない —— ここが本文に出る
「違反」であり、上流のゲートが下す「不合格」と食い違えば、レビュアは実在しない違反を
読むか、実在する違反を見落とす。

**実装は移植である。** `lib.mjs` の `scopeMatches` は CommandMate
`src/lib/verification/scope-gate.ts` の `globToRegExp`（CommandMate #1546、設計正本は
同 repository の `docs/design/task-contract.md` 第2.2節）の部分集合を、Node stdlib だけで
写したものである（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。

| 記法 | 意味 |
|---|---|
| `**`（segment 全体） | 階層を跨ぐ。**0 段も跨ぐ**ので `a/**` は `a/b` にも `a/b/c` にも一致し、`**/*.ts` は `x.ts` に一致する |
| `a**b`（segment 全体でない） | segment 内 wildcard に潰れる（階層は跨がない） |
| `*` / `?` | segment 内。`/` は跨がない |
| `{a,b}` | 選択。入れ子可。**括弧が閉じていなければ literal**（shell と同じ。`src/{a` は `{` を含む path） |
| `[` `]` | **literal。** Next.js の `src/app/[...path]/` を文字クラスとして読むと、その path を名指した pattern が何にも一致しなくなる |
| ディレクトリ | 配下すべてに一致する。`src/lib` / `src/lib/` / `src/lib/**` は同じ意味である |

**0.31.0 までは `*` と `**` だけを解釈し、それ以外は literal だった。** 上流が許可する
3つの形 —— ディレクトリ前置（`src/lib`。人がディレクトリを書く綴り）・`?`・`{a,b}` ——
がすべて「一致しない」と判定され、in-scope の変更が違反として数えられていた。
移植で消えたのはこの食い違いだけであり、判定の**置き場所**は変わっていない:
`requireScopeClean` を下すのは上流のゲートであって、この runner ではない（第5.2節）。

**同じ関数を planner も使う。** 2つの Issue が同じ wave に入れるかの判定
（`scopeEntriesOverlap`）は同じ移植の上に載っている。1つの関係に対する実装が
package 内に2つあれば、その2つは黙って食い違う。

## 5.7 PR タイトルの型（`pr_title_template`。既定 off。`--create-prs` のみ）

CommandMate#3005。profile 側の定義は [profile-contract.md](./profile-contract.md) 第13節。

- **欄が無い plan では何も変えない。** タイトルは Issue タイトルのまま、target の `note` も従来の文面のまま。
- 欄があれば、Issue ごとに `git log`（5節の表）でブランチのコミットを読み、型が使う placeholder を埋める。
  `{{type}}` / `{{scope}}` は **コミット件名から取る**。squash merge ではコミットが PR タイトルに
  置き換わるので、タイトルはコミット件名の後継であり、その type / scope を継ぐのが自然である。
  Issue の label は type の語彙ではない（`enhancement` と `feat` の対応表は、この runner が発明する第二の規約になる）。
- **決まらなければ、その PR は作らずに止める。** push もしない。target は `pr_failed`、
  `blocking_reasons` に `pr_title_undetermined`（detail に template と、どの件名がなぜ決めさせなかったか）、
  `stop_reason: pr_create_failed` / `partial`（exit 7）。以降の Issue は `skipped`（他の PR 作成失敗と同じ）。
  preview（`--approve` 無し）でも同じ判定をする —— 作れない PR の preview は何も示さない。
- 決まったタイトルは `redact()` を通し、target の `note` に `titled "<title>"` として残す。
- `merge_schema_version`・`stop_reason` の enum・target の field は変えていない。

## 5.8 ワーカーの申告（`--create-prs`。常に on。申告が無ければ何も足さない）

CommandMate#3005。ワーカーが Issue を読み替えた・Issue が決めていないことを判断した、という申告は、
merge を止めるかどうかを人が決める材料である。それがワーカーの最後の報告（この runner が読まない場所）に
しか無いと、PR を読んだ人には届かない。

**規約**（ワーカー側の正本は `cmate-worker-development` の `references/evidence-vocabulary.md`）:
ブランチ上のコミットの**メッセージ本文**の行で、行頭が `読み替え` / `判断` / `本文に無い指摘` の
いずれかと `:`（全角 `：` も可）で始まるものを1件の申告とする。直下の字下げ行はその申告の続き。
行頭でない・コロンが無い行は申告ではない。置き場所をコミットメッセージにしたのは、ワーカーが既に
書いている場所で、ブランチと一緒に運ばれ、他の誰も書き込まないからである（`.commandmate/` は
人が書く場所なので、ワーカーにファイルを置かせない）。

| 状態 | PR 本文 | report |
|---|---|---|
| 申告あり | `Resolves #n` の直前に `## ワーカーの申告` 節。古いコミットから順に `- <ラベル>: <本文>`（`redact()` 済み、1件 500 字・20 件まで。打ち切った件数は本文に書く） | limitation `worker_declarations_transcribed`（Issue ごとに1件） |
| 申告なし | **節を出さない**（#3005 以前と同じ本文） | 何も足さない |
| `git log` が読めない | 節に「読めなかった。申告が無い証拠ではない」と書く | limitation `worker_declarations_unread` |

**申告は merge を止めない。** 止めるかどうかは人が読んで決める（転記したことは、読まれたことではない）。
PR も止めない（読めないことは PR 作成を止めない。`--unattended` でも limitation のまま）。

## 6. 停止と status / stop_reason / exit

failure・blocked は途中で **停止** し、`blocking_reasons` と該当 target に記録する。停止後の
eligible は outcome `skipped` として残し、対象集合を隠さない。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible を失敗なく処理（preview を含む） | 0 |
| `partial` | 途中停止（PR 作成失敗・CI failure/pending・PR 不在・merge conflict） | 7 |
| `failure` | 何も試せない（preflight 失敗・plan 不正・invalid input） | 1 |

`stop_reason` は `completed` / `preflight_failed` / `pr_create_failed` / `pr_missing` /
`pr_closed` / `ci_failed` / `ci_pending` / `merge_failed` / `runner_error`。
最初の blocking 条件を採る。**failure を `completed` として報告しない。**

`--unattended` はこの写像を1文字も変えない（ADR 第6.1節）。昇格した
`change_evidence_unavailable` も**既存の `pr_create_failed` で受ける**し、段階 C の受入条件検査は
**既存の `preflight_failed` で受ける**（何も試していないので `failure` / exit 1）——
何が起きたかを名指しするのは `blocking_reasons[]` の code
（`acceptance_gates_required` / `no_acceptance_criteria`）であって `stop_reason` ではない
（dispatch の `wall_clock_budget_exhausted` と同じ形）。**新しい値は足さない。**
`preflight[]` の `code` は schema の閉じた enum なので、この検査は**そこには載らない**
（version を上げないための帰結。ADR 第11節）。

`--integration-verify`（5.4節）も**新しい値を足さない**。写像は次のとおりである。

| 何が起きたか | status / stop_reason | 名指しする code |
|---|---|---|
| 合流後の baseline が赤 | `partial` / **`merge_failed`** | `integration_verify_failed` |
| merge 済みだが検証を実行できなかった | `partial` / **`merge_failed`** | `integration_verify_unavailable` |
| baseline 未宣言で merge の前に拒否 | `failure` / **`preflight_failed`** | `integration_verify_unavailable` |

**`ci_failed` / `ci_pending` は使わない。** この report の2値は「**その PR の CI が green で
なかったので merge しなかった**」を意味しており、合流後の赤は **merge が成功した後**の話である。
そこへ流すと、report の中で最も安全に関わる事実（何が既に base に入ったか）が**逆に読める**。
`merge_failed` は「merge 段で悪い結果になった」であり、そこに寄せたうえで
**何が起きたかは `blocking_reasons[]` の code が名指しする**（dispatch の
`wall_clock_budget_exhausted` と同じ形）。summary の next action も、conflict/branch protection
の行ではなく統合検証専用の行を出す（「既に merge 済みなので phase の再実行では戻らない」）。

**`stop_reason` に `integration_verify_failed` を足さなかったのは意図である。** 足すには
第10節どおり `merge_schema_version` を上げる必要があり、上げると `status.mjs`
（`SUPPORTED_MERGE_SCHEMA_VERSION = 1` を pin している。かつ #175 の宣言 scope の外である）が
**フラグを使っていない run の report まで含めて全部読めなくなる**。version を上げられる Issue で
まとめて見直す。

## 7. security（redaction）

token・secret・絶対 path・raw terminal 全量を report/artifact に残さない。PR title・body・
CI check 名・失敗 note・URL は redaction 済みの短い抜粋のみとし、除去した値は `redactions` に
kind と count だけで記録する（値・長さ・伏字は残さない）。

## 8. completion_check（report）

report は5つの check を自己申告する。

| id | 内容 |
|---|---|
| `single_phase` | mutating phase をちょうど1つだけ有効化した |
| `approval_enforced` | `--approve` 無しに mutation していない（`mutated ⟹ approved`） |
| `verification_gated` | 対象がすべて verification pass 済み Issue である |
| `ci_gated` | merge した PR はすべて CI green だった（CI 無しに merge していない） |
| `failures_not_rounded` | 失敗があるとき status を `success` にしていない |

`passed` は5件すべて true、かつ status が `failure` でないときだけ true。

## 9. スコープ外

UAT 修正ループ（[#1456](https://github.com/Kewton/CommandMate/issues/1456)）、Issue 本文の自動編集、
明示承認・CI pass 無しの無条件 merge は **この runner では行わない**。

**無人 merge（`--merge-prs --unattended`）も現時点ではスコープ外**である。
[adr-unattended-mode.md](./adr-unattended-mode.md) 第8節の段階 C であり、`verification_gates_unrecorded`
の昇格と [#100](https://github.com/Kewton/commandmate-skills/issues/100) 段階1 を前提とする。
実装するまでは `invalid_input` で拒否する（5.3節）。

## 10. version 運用

- field の追加・削除・意味の変更、enum への値追加 → `merge_schema_version` を上げる。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。

**例外は1つだけあり、それが `integration_verify`（5.4節・[#175](https://github.com/Kewton/commandmate-skills/issues/175)）である。**
version を据え置いたまま **optional な field を1つ**足した。判断の材料は次の3つである。

1. **この field は opt-in の run にしか現れない。** `--integration-verify` を渡さない run の
   report は key 集合も bytes も従来と同一なので、既存の読み手が出会う文書は1 byte も変わらない
   （fixture で byte 固定してある）。
2. **上げると壊れる読み手が居て、それをこの Issue では直せない。** `status.mjs` は
   `merge_schema_version === 1` を pin しており、`scripts/status.mjs` は #175 の宣言 scope の外である。
   2 に上げると **フラグを使っていない run の report まで「読取不能」になる** —— optional field を
   足すより明確に悪い。
3. **enum には1つも足していない。** `stop_reason` / target `outcome` / `preflight[].code` は
   閉じたままである（第6節）。

version 規則を緩めたのではなく、**この1件について理由を書いて据え置いた**。次に
`merge_schema_version` を上げる変更（`status.mjs` も一緒に直せる Issue）で、この field の扱いを
required にするかを含めて見直す。

**[#195](https://github.com/Kewton/commandmate-skills/issues/195) の `integration_verify.source` も
同じ例外の下に置く。** 足したのは `integration_verify` object の**内側の1 field**（required）で、
`merge_schema_version` は 1 のままである。上の3点はそのまま成立する。

1. `--integration-verify` を渡さない run の report には `integration_verify` object 自体が無いので、
   **その内側に何を足しても既存の読み手が出会う文書は1 byte も変わらない**（fixture `m22` が固定し続ける）。
2. `status.mjs` は今も `merge_schema_version === 1` を pin しており、**`scripts/status.mjs` は
   #195 の宣言 scope の外**である（version を上げると、フラグを使っていない run の report まで読取不能になる）。
   なお status runner は JSON schema による検証をしておらず version だけを見るので、**#195 以前に書かれた
   `source` の無い report も従来どおり読める**。
3. `stop_reason` / target `outcome` / `preflight[].code` の閉じた enum には**やはり1つも足していない**
   （`source` は新しい field の enum である）。

`source` を optional にしなかったのは、この field の目的が「どちらを測ったのかを report **単体**で
読めること」だからである。欠けていてよい field は、読み手が「たぶん `baseline` だろう」と補うことを
許す —— それは第5.4節が消しに来た推測そのものである。
