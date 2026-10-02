# UAT 契約 v1

`cmate-orchestrate` の UAT runner（`scripts/uat.mjs`）が、dispatch・merge 済みの plan に対して
**UAT（受入テスト）の実行と、不合格時の回数上限つき修正ループ** をどう実行し、
`commandmate` / `git` / `gh` CLI とどう話すかの定義である。機械検証用の正本は
[../schemas/uat-report.v1.json](../schemas/uat-report.v1.json)（UAT report）であり、この文書は
その読み方と、schema では表現できない規則を述べる。

計画コア（[plan-contract.md](./plan-contract.md)）は plan を作り、dispatch runner
（[dispatch-contract.md](./dispatch-contract.md)）は worker を verification gate まで進め、
merge runner（[merge-contract.md](./merge-contract.md)）は verification pass した Issue を納品する。
UAT runner は、その **dispatch report で「worker 完了かつ verification pass」だった Issue** だけを
対象に受入テストを実行し、不合格の Issue には fix worktree を作って修正・再検証・再merge を試みる。
4つは別 runner であり、planner の `--phase uat` は依然として `not_implemented` を返す。

`uat_schema_version` は 1 である。**未知の field を足さないこと**（schema に無い field を書く runner は
契約違反である）。version 運用の規則は第13節にある。

## 1. explicit phase flag（1 invocation = 1 phase）

CommandAgent の explicit phase flag 設計（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)、
`--write-uat` / `--create-uat-fix-worktrees` 相当）を踏襲し、**1 回の invocation で有効化できる phase は
ちょうど1つ** である。

| flag | phase | 内容 |
|---|---|---|
| `--write-uat` | `write_uat` | eligible な Issue に UAT を1回実行し report を書く。read-only（worktree も fix もしない） |
| `--create-uat-fix-worktrees` | `fix_uat` | UAT 不合格時に fix worktree を作り、修正・再検証・再merge・再UAT を回数上限つきで繰り返す |

両方指定・どちらも未指定は `invalid_input` で拒否する（既定で片方を選ばない）。

## 2. 入力

```
uat.mjs --plan <plan.json> --dispatch <dispatch-report.json> (--write-uat | --create-uat-fix-worktrees) [options]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | 承認済み `plan.json`（plan-core の出力） |
| `--dispatch <path>` | 必須 | なし | dispatch runner の `dispatch-report.json`。eligible 集合の唯一の根拠 |
| `--write-uat` / `--create-uat-fix-worktrees` | どちらか1つ必須 | なし | 有効化する phase |
| `--approve` | 任意 | **off** | fix loop の明示承認。無ければ mutation しない preview |
| `--max-attempts <1-5>` | 任意 | `2` | fix 試行回数の上限。ループはこれを超えない |
| `--acceptance-dir <dir>` | 任意 | なし | 意味ゲートの入力 directory（第4節）。`issue-<n>.json` を読む。read-only |
| `--require-acceptance` | 任意 | off | 意味ゲートを必須にする。`--acceptance-dir` 無しでの指定は `invalid_input`（exit 3） |
| `--unattended` | 任意 | off | **この invocation に人間は居ない**という宣言（第5.2節）。権限は足さず、締め付けだけを含意する。`--require-acceptance` と `--max-attempts` の明示を要求し、`--create-uat-fix-worktrees` では `--expect-branch` も要求する |
| `--expect-branch <name>` | 任意 | なし | 再merge が入るべき integration branch。`--unattended --create-uat-fix-worktrees` では**必須**（第5.1／5.2節） |
| `--out <dir>` | 任意 | `<dispatch-dir>/<phase>` | 出力先。既存なら `out_exists` で拒否 |
| `--cli <launcher>` | 任意 | `$CM` → `commandmate` | preflight と fix worker dispatch（send/wait）に使うランチャー。解決規約は dispatch-contract.md 第 2.8 節と同一 |
| `--git <path>` | 任意 | `git` | base 解決・fix worktree 作成・再merge に使う git |
| `--gh <path>` | 任意 | `gh` | repo 到達性 preflight に使う gh |
| `--wait-timeout <sec>` | 任意 | `300` | fix worker の1回あたり wait timeout |
| `--max-turns <n>` | 任意 | `8` | fix worker を駆動する最大ターン数（初回 send + nudge）。未 commit のまま到達で当該 fix worker を failed とする |
| `--fix-nudge-message <text>` | 任意 | なし | fix worker の nudge の既定文の**後ろ**へ追記する文面。優先順は flag → plan の `profile.worker_messages.fix_nudge` → 追記なし。空白のみ・2000 文字超は `invalid_input`（plan 側の不正は `plan_invalid`）。既定文の commit 行は消えない。採用結果は limitations（`worker_messages_applied`）に文字数だけ残す（`fix_uat` のみ） |
| `--poll-limit <n>` | 任意 | `120` | 互換のため保持（wait は block するので poll しない） |

`commandmatedev` は使わない。公式経路は public `commandmate`/`gh`/`git` である。

## 3. eligible 集合（verification gate の継承）

対象にするのは、dispatch report の `waves[].workers[]` のうち **`worker_state` が `completed` かつ
`verification.outcome` が `pass`** の Issue だけである。verification が pass していない Issue を UAT に
かけることも、修正・再merge することも無い。対象は plan の `merge_order` 順に処理する。

eligible が空の場合は `no_eligible_issues`（limitation）を載せて no-op success とし、UAT を実行しない。

## 4. 二層裁定（機械ゲート + 意味ゲート）

[#1616](https://github.com/Kewton/CommandMate/issues/1616) 以降、受入の裁定は二層である。

| 層 | 判定するもの | 出力元 | 実行者 |
|---|---|---|---|
| 機械ゲート | profile `baseline` が worktree 内で全部 exit 0 か | runner 内の実測 | uat runner（決定的） |
| 意味ゲート | Issue の**受入条件**が満たされているか | `acceptance-result.v1` document | **エージェント**（cmate-acceptance-test か cmate-uat） |

**役割分担を崩さない。** 判定の生成はエージェント側の手順であり、uat runner の中で LLM を実行したり、
受入条件を自動解釈したりは **しない**。runner がするのは、document を読み・検証し・照合し・合成する
ことだけである。

**意味ゲートの Skill は別途 install が要る。** `cmate-orchestrate` の install には含まれない。
producer は 2 つあり、**どちらを入れるかは受入条件の性質で決まる**。

```bash
commandmate skill install cmate-acceptance-test   # 立てなくても検証できる対象
commandmate skill install cmate-uat               # 実機環境を立てないと検証できない対象
```

| producer | 何をするか | 選ぶ基準 |
|---|---|---|
| `cmate-acceptance-test` | 渡された対象を検証して判定する。環境は立てない | test command を叩けば確かめられる受入条件 |
| `cmate-uat` | 環境を起動し・隔離を実測し・TC を回し・証跡を残してから判定する（#260） | サーバや DB を立てないと確かめられない受入条件 |

どちらも同じ `acceptance-result.v1` を書き、**runner は同じ合成規則で裁定する**（第 4.2 節）。
producer の違いは裁定を変えない。per-issue の `acceptance.producer` に記録するだけである。

未導入ならどちらも `--acceptance-dir` に渡す document を作れないので、裁定は機械ゲートだけになる。
その場合 runner は意味ゲートが参加していないことを `limitations[]` の `acceptance_not_run` に
記録する（黙って劣化しない）。本書中の `../../cmate-acceptance-test/...` への相対リンクも
未導入では解決しない。

### 4.1 意味ゲートの入力

`--acceptance-dir <dir>` の `issue-<n>.json` を読む。document は
[cmate-acceptance-test](../../cmate-acceptance-test/schemas/acceptance-result.v1.json) の
`acceptance-result.v1` に適合していなければならない（**schema の正本はこの 1 本**で、
producer が増えても増やさない）。runner は各 document について:

1. JSON として parse できること。
2. `result_schema_version` が 1、`skill.id` が **`cmate-acceptance-test` か `cmate-uat`**、
   `skill.version` が semver。
3. `verdict` が `go`/`conditional_go`/`no_go`、`status` が `success`/`partial`/`failure`、
   `verdict_reason` が非空、required field が揃っていること。
4. `target.issue_ref` が **その Issue を指す**こと（Issue URL・`owner/repo#<n>`・裸の番号を解釈する）。

を確認する。**未知の `verdict` を `go` と読まない。** 到達した状態を per-issue に記録する。

**`skill.id` の 2 値は allowlist であって緩和ではない。** この 2 つ以外の id は従来どおり
`invalid` である。「acceptance-result.v1 に見えるから通す」ことはしない —— 誰が書いたか分からない
判定を意味ゲートとして通すのは、`target.issue_ref` を解決できない document を `mismatched` に
落とすのと同じ理由で拒否する。

| state | 意味 |
|---|---|
| `not_configured` | `--acceptance-dir` 未指定。意味ゲートは参加していない（#1616 以前の挙動） |
| `missing` | directory はあるがその Issue の document が無い |
| `invalid` | JSON でない、または `acceptance-result.v1` に適合しない（**未知の `skill.id` もここ**） |
| `mismatched` | 適合しているが `target.issue_ref` が別 Issue を指している |
| `loaded` | 適合し対象も一致。`verdict` が合成に入る唯一の state |

**producer は per-issue の `acceptance.producer` に `{id, version}` で記録する。**
`loaded` だけが producer を名乗れる（`missing` には producer が無く、`invalid` は
まさに id が適合しなかった側なので、runner が保証できる producer が無い）。
fix prompt の受入判定見出しもこの値から組む —— 特定の Skill 名を固定で書くと、
その Skill が出していない判定にその名前が乗る。

### 4.2 合成規則

| 機械ゲート | 意味ゲート | 合成 `verdict` | status への影響 |
|---|---|---|---|
| `pass` | `go` | `pass` | 合格 |
| `pass` | `conditional_go` | `conditional` | `success` にしない。`partial` / `acceptance_conditional` |
| `pass` | `no_go` | `fail` | 不合格。fix loop の対象 |
| `fail` | 任意 | `fail` | 不合格（機械ゲートで既に落ちている） |
| `pass` | `missing`/`invalid`/`mismatched` | `pass` | baseline のみで裁定し `acceptance_not_run` を `limitations` に記録。`--require-acceptance` 時は `fail` |
| `pass` | `not_configured` | `pass` | 従来挙動。limitation は記録しない（劣化ではなく未使用） |

**中心規則: 検証していないものを pass に丸めない。** `conditional_go` は human 判断であって
自動修正の対象ではないので、fix loop は `conditional` を `target` から外し、修正も pass 化もしない。
合成 verdict は per-issue の `verdict`、旧来の `outcome` はその射影（`pass` は合成 pass のときだけ）で
あり、#1616 を知らない reader が `conditional`/`fail` を pass と読むことはない。

`acceptance_not_run` を記録するのは **degrade したときだけ**である（`--acceptance-dir` を渡していない
run は劣化していない）。report には `acceptance.configured` / `acceptance.verdicts` の内訳と、
per-issue の `baseline` / `acceptance` / `verdict` / `verdict_source` を記録する。

### 4.2.1 findings / conditions の上限と、切ったことの明記

per-issue の `acceptance.findings`（`fail` した criterion ＋ blocking reason）と
`acceptance.conditions`（未解決 criterion ＋ next_actions ＋ limitations）は **各 8 件が上限**である
（report を小さく保つため。全量は acceptance result document 側に残る）。この上限には二つの規則がある。

- **切ったことを必ず書く。** 上限に達したときは **8 枠目を注記に使い**、
  `Not listed here: N further item(s) — <種別ごとの内訳>.` を最後の要素として載せる。
  8 件のリストが全量なのか切られたのかを読み分けられる（merge.mjs の `capped()` / `droppedNote()`
  と同じ扱い）。注記は 9 件目としてではなく 8 枠目として入るので、上限そのものは動かない。
- **種別ごとに最低 1 枠を確保する。** items は種別順（criteria → next_actions → limitations）に
  並ぶので、確保が無いと `fail` した criterion が枠を食い尽くして next_actions と limitations が
  1 件も載らない。`conditions` は **人が閉じるべき残件**であり、丸ごと沈黙してよいものではない。

上限値も合成 verdict の裁定もこの注記に影響されない（読み取りの問題であって、合否の問題ではない）。

### 4.3 write_uat（read-only assessment）

各 eligible Issue の worktree 内で **profile の `baseline` を実行**し（`commandmate uat`
は無い。全 baseline command が exit 0 なら `pass`、それ以外は **pass として扱わない**）、
第4.2節の規則で意味ゲートと合成する。このphaseは worktree も fix も再merge もしない（mutation なし）。

- 全 eligible が合成 `pass` → `success`（stop_reason `completed`）。
- 1件でも `fail` → `partial`（stop_reason `uat_failed`）。不合格 Issue を `unresolved_issues` に載せ、
  `--create-uat-fix-worktrees --approve` を促す `next_action` を返す。
- `conditional` が残る → `partial`（stop_reason `acceptance_conditional`）。該当 Issue を
  `conditional_issues` に、条件を per-issue の `acceptance.conditions` に載せ、owner `human` の
  `next_action` を返す。`unresolved_issues`（＝不合格）には載せない。両方あるときは
  `uat_failed` が stop_reason を取り、`acceptance_conditional` は `blocking_reasons` に残る。

## 5. fix_uat（回数上限つき修正ループ）

`target` を eligible として、次を繰り返す。**各反復が1つの attempt** であり、`attempts[]` に **append**
する（既存 attempt を上書きしない）。各 Issue は「現行 worktree」（初回は dispatch worktree、fix が
成立した後はその fix worktree）で受入判定する。

1. **assess** — `target` の各 Issue の現行 worktree で **baseline を再実行**し、第4.2節の規則で
   意味ゲートと合成する（read-only）。合成 `conditional` の Issue は `target` から外して記録する
   （human 判断を自動修正しない）。`fail` が無くなればループを抜ける。`conditional` を保持したまま
   `success` にはしない（`partial` / `acceptance_conditional`）。
2. **preview** — `--approve` が無ければ、不合格集合を報告して停止する（`partial` / `uat_failed`）。
   worktree・fix・再merge は **一切しない**（`mutated` は false のまま）。
3. **上限判定** — これまでの fix 回数が `--max-attempts` に達していれば、不合格集合を
   `unresolved_issues` に載せて **`blocked`**（stop_reason `max_attempts_reached`）で停止する。
   **成功に丸めない。**
4. **fix**（承認あり・上限未達のときだけ、mutation）—
   - 不合格 Issue ごとに fix worktree を作る（第6節）。作れなければ `worktree_failed` で停止。
   - fix worker を **dispatch runner と同じ監督ループ**で駆動する（#1468）。worktree-id は fix branch
     から導出する。fix worktree の開始時 SHA を `git rev-parse HEAD` で記録し、`commandmate send`
     （送信直後に `capture` で確定を確認し、未確定なら1回だけ再送。fix worktree はこの run が作るので
     最初の送信は必ず新しいセッションの起動を伴い、起動が間に合わず断られた send ——
     503 `SESSION_STARTING` / prompt not ready（exit 99）—— は dispatch と同じ判定で**1回だけ**送り直し、
     その事実を fix 記録の `note` に残す。[dispatch-contract.md](./dispatch-contract.md) 第2.13節）→ `commandmate wait` で idle 化を
     待つ。**wait の exit 0（idle）は完了ではない**。fix worktree のブランチに **新規 commit** が出れば
     `completed`、未 commit なら **継続 nudge** を送って `wait` へ戻る（fix prompt には「完了時に単一
     commit」を明記）。prompt を出したら `fix_failed`（fix loop は自動応答しない）、`--max-turns`
     到達で未 commit なら当該 fix worker を `failed` として `fix_failed` で停止する。fix prompt には、
     意味ゲートが `no_go` を出していれば **verdict・findings（`fail` した criterion と blocking reason）・
     未解決の条件を引用**する（「UAT に失敗した」だけを渡すと修正が当てずっぽうになる）。判定が
     得られていないときは「baseline のみで落ちた」と明記し、受入条件が通ったかのように書かない。
     完了（commit 検出）した fix worker のみ **fix worktree 内で baseline を再実行して再検証**する。
   - **再検証 pass した fix のみ** `git merge --no-ff` で **再merge** する（再検証不合格は再merge せず、
     その Issue は次反復で再試行する）。conflict なら `remerge_failed` で停止。
   - `target` を不合格集合に更新し、再merge した Issue の現行 worktree を fix worktree に切り替えて、
     次の反復（再UAT）へ進む。

`attempts_used`（fix 回数）は常に `max_attempts` 以下である。ループが無限に回ることは無い。

### 5.1 再merge は invocation の cwd に入る（無人運転の前提）

**`git merge --no-ff` は cwd 指定を持たない。** 上の再merge は `--git` に渡された CLI を
**uat プロセスの cwd** で実行するので、fix が入る先は **invocation cwd の現在の branch** である。
[#115](https://github.com/Kewton/commandmate-skills/issues/115) が使い捨てリポジトリで実測した
（[adr-unattended-mode.md](./adr-unattended-mode.md) 第14.3節）:

| cwd / HEAD | merge exit | 何が起きるか |
|---|---|---|
| **`main` を checkout**（branch push を受けた CI の既定）| 0 | **`main` が進む。** PR も CI も review も経ていない。その `main` が push 済みなら**不可逆** |
| **detached HEAD**（`actions/checkout` が SHA を取ったとき）| 0 | merge commit はできるが**どの branch からも到達できない**。`remerge_failed` は出ないので、uat は **`outcome: merged` と報告する**（静かな false success）|
| fix branch がその checkout に無い | 1 | `remerge_failed`（正しい停止）|
| cwd が別 branch の linked worktree | 0 | その worktree の branch が進む |

人間が居る運転では、cwd を選んだのが人間なので前提は満たされている。**無人運転（`--unattended`）で
`fix_uat` を回す段階 C では、これは前提ではなく検査すべき条件になる。**

**この検査は段階 C（[#142](https://github.com/Kewton/commandmate-skills/issues/142)）で実装した。**
規定は第5.2節にある。段階 A（[#122](https://github.com/Kewton/commandmate-skills/issues/122)）でも
段階 B（[#134](https://github.com/Kewton/commandmate-skills/issues/134)。merge `--create-prs` まで）でも
uat runner は `--unattended` を受け付けなかった（渡すと `invalid_input`）ので、それらの release に
この検査は存在しない。

## 5.2 無人運転（`--unattended`）

[adr-unattended-mode.md](./adr-unattended-mode.md) 第8節の**段階 C** である
（[#142](https://github.com/Kewton/commandmate-skills/issues/142)）。dispatch / merge の同名フラグと
**同じ宣言**であり、runner 間で伝播はしない —— この runner は上流の dispatch が unattended
だったかを**検査しない**（同 ADR 第8節）。

**`--unattended` は「この invocation に人間は居ない」という入力の宣言であって、
mutation の権限を与えるフラグではない。含意するのは締め付けだけである**（ADR 第2節「裁定 0」）。

| 論点 | 規定 |
|---|---|
| `--approve` との関係 | **含意しない。** `--unattended` だけの `--create-uat-fix-worktrees` は preview であり、fix worktree も fix worker も再merge も無い |
| 含意する締め付け（両 phase） | **`--require-acceptance` と `--max-attempts` の明示を要求する**（欠けていれば `invalid_input` / exit 3。ADR 第8節）。意味ゲート無しの無人 UAT は「dispatch が既に通した baseline をもう一度走らせた」でしかなく、**受入を確認したとは言えない**。`--max-attempts` を明示させるのは dispatch が `--wall-clock-budget` にそうしているのと同じ理由で、**誰も打っていない上限は default であって、この run について誰かがした決定ではない** |
| `acceptance_not_run` | **昇格しない。起こさない**（ADR 第6.5節 3行目）。`--require-acceptance` が必須である帰結として、result 欠落・不適合・Issue 不一致は **fail**（`verdict_source: acceptance_required`）になり、劣化を記録する limitation は発生しない |
| 追加で含意する締め付け（`--create-uat-fix-worktrees` のみ） | **invocation cwd の pre-flight**（第5.1節・ADR 第14.3節）。fix worktree を**1つも作る前に** `git symbolic-ref -q HEAD` を撃ち、(a) 出力が空（**detached HEAD**）なら `unattended_cwd_detached`、(b) `--expect-branch` と一致しなければ `unattended_cwd_branch_mismatch` で停止する。どちらも `failure` / exit 1 / `stop_reason: preflight_failed`。**worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしない**（`attempts[]` は空、`mutated: false`） |
| `--expect-branch` | `--unattended --create-uat-fix-worktrees` では**必須**（欠ければ `invalid_input`）。比較対象になる integration branch が plan のどこにも無いためである —— `profile.base` は **base** であり、fix を base に入れることこそこの検査が防ぐ事故である。dispatch の `--expect-branch`（drift check `branch_matches`）と同じ形・同じ名前 |
| `--write-uat` | cwd の pre-flight は**効かない**。read-only で worktree も再merge も作らないので、守るべき cwd が無い。含意する2つの明示要求は効く（裁定の意味の問題であり、phase に依らない） |
| 証跡 | `limitations[]` の **`unattended_mode`**（run 全体で1件。pre-flight で止まった run にも残る）。含意した締め付けを phase ごとに書き分ける。**絶対 path を書かない**（redaction の tally がフラグ無しの run と食い違うため） |
| 変えないもの | `uat_schema_version` は **1 のまま**。`stop_reason` にも**値を1つも足していない**（新しい停止語彙は要らない、を実装がそのまま守った）。`preflight[]` の `code` は schema の閉じた enum なので cwd 検査は**そこには載らず**、名指しするのは `blocking_reasons[]` の code である |

**`git push` / `gh` 由来の停止は足していない**（ADR 第14.5節。merge 契約 第5.3節と同じ）。
無人運転では job 定義側で `GH_TOKEN` と **`GIT_TERMINAL_PROMPT=0`** を置くこと。
**runner はこれを検査しない。**

## 6. fix worktree（#1448 worktree-result との整合）

fix worktree は [cmate-worktree-setup](../../cmate-worktree-setup/) の worktree-result（#1448）の形で
記録する。各 attempt の `worktrees[]` は次を満たす。

- branch は `<issue.branch>-uat-fix-<attempt>`、directory は `<issue.worktree>-uat-fix-<attempt>` と
  し、attempt ごとに異なる target にして **既存 worktree を暗黙上書きしない**。
- 作成直前に base を **resolved commit SHA** に再確認して記録する（`base_sha`、`^[0-9a-f]{40}$`）。
  symbolic ref だけを base にしない。
- branch は safe-ref 検査、directory は path-escape 検査（絶対path・drive・backslash・control・
  先頭以外の `..` を拒否）を通す。通らない target は作成しない。
- `--approve` 無しでは作成せず、`created=false` の preview として base_sha だけ記録する。

## 7. 停止と status / stop_reason / exit

failure・blocked は途中で **停止** し、`blocking_reasons`・`unresolved_issues`・該当 attempt に記録する。

| status | 条件 | exit |
|---|---|---|
| `success` | 全 eligible が合成裁定を通過（修正後の pass を含む）／eligible が無い no-op | 0 |
| `partial` | preview、不合格の assess-only、`conditional_go` の保持、fix 途中停止（worktree/fix/remerge の失敗） | 7 |
| `blocked` | fix 上限到達でなお不合格が残る（成功に丸めない） | 8 |
| `failure` | 何も試せない（preflight 失敗・plan/dispatch 不正・invalid input） | 1 |

`stop_reason` は `completed` / `uat_failed` / `acceptance_conditional` / `max_attempts_reached` /
`worktree_failed` / `fix_failed` / `remerge_failed` / `preflight_failed` / `runner_error`。
最初の blocking 条件を採る。**failure・blocked を `completed` として報告しない。**

`--unattended` はこの写像を1文字も変えない（ADR 第6.1節）。段階 C の cwd pre-flight も
**既存の `preflight_failed` で受ける**（何も試していないので `failure` / exit 1）——
何が起きたかを名指しするのは `blocking_reasons[]` の code
（`unattended_cwd_detached` / `unattended_cwd_branch_mismatch`）であって `stop_reason` ではない。
**新しい値は足さない。**

## 8. run artifact（append 履歴）

`--out` は既存なら `out_exists` で拒否する（**既存 run artifact を上書きしない**）。各 attempt は
`<out>/attempts/attempt-<n>/` に fix prompt などを書き、`<out>/attempts/history.jsonl` に1行ずつ
**append** する。`uat-report.json` / `uat-summary.md` を最後に書く。

## 9. security（redaction）

token・secret・絶対 path・raw terminal 全量を report/artifact に残さない。UAT scenario 名・fix note・
worker note は redaction 済みの短い抜粋のみとし、除去した値は `redactions` に kind と count だけで
記録する。fix worktree の directory に絶対 path は残さない。

## 10. next action（result report）

`next_actions[]` に、次に何を誰がすべきかを載せる（`success` 以外では最低1件）。

- `uat_failed`（write_uat / preview）→ `--create-uat-fix-worktrees --approve` で修正する（owner: operator）。
- `acceptance_conditional` → 記録された条件を確認し受入可否を決める（owner: **human**）。
  条件を自動で閉じない。
- `blocked`（上限到達）→ 人手で triage する（owner: human）。回数無制限ループはしない。
- `worktree_failed` / `fix_failed` / `remerge_failed` → 該当 worktree を診断し解消して再実行（owner: operator）。
- `preflight_failed` → commandmate 到達性・repo access・base 解決を復旧して再実行（owner: operator）。
  `--unattended` の cwd 検査で止まった場合は、**invocation cwd を integration branch（`--expect-branch`）に
  checkout してから**再実行する（owner: operator）。fix worktree は1つも作られていない。

## 11. completion_check（report）

report は6つの check を自己申告する（0.7.x は `acceptance_not_rounded` を除く5件）。

| id | 内容 |
|---|---|
| `single_phase` | phase をちょうど1つだけ有効化した |
| `approval_enforced` | `--approve` 無しに mutation していない（`mutated ⟹ approved`） |
| `attempts_bounded` | fix 回数が `max_attempts` を超えていない |
| `blocked_reported` | 上限到達で不合格が残るとき status を `blocked` にした（成功/partial に丸めていない） |
| `verification_gated` | UAT 対象がすべて verification pass 済みで、再merge した fix はすべて再検証 pass だった |
| `acceptance_not_rounded` | `go` 以外の受入判定を pass に合成していない。`conditional_go` を保持したまま `success` にしていない |

`passed` は全件 true、かつ status が `failure` でないときだけ true。
`blocked` は正当な終了であり、`passed` を true にしうる。

## 12. スコープ外

回数無制限の review/fix ループ、crash 後の resume・attempt retry（Phase 5）、cross-model review
（Phase 5）、Issue 本文の自動編集は **この runner では行わない**。

意味ゲートについては次も行わない。**runner 内での LLM 実行・受入条件の自動解釈**（判定の生成は
エージェント側の手順）、**cmate-acceptance-test 自体の変更**（result document を消費するのみ）、
CommandMate 本体への `commandmate uat` subcommand 追加。

なお機械ゲートの**測り方**（現在は worktree 内の profile baseline 再実行）が
[#1588](https://github.com/Kewton/CommandMate/issues/1588) で契約付き `wait --verify` の exit code に
移行しても、意味ゲートの合成は独立である。合成が読むのは baseline の **outcome だけ**であり、
その outcome をどう測ったかには依存しない。

## 13. version 運用

判定基準は「**既に世に出た report が、新しい schema でも引き続き適合するか**」である。

- **適合しなくなる変更** → `uat_schema_version` を上げる。required field の追加、field の削除、
  既存 field の**意味の変更**、既存 enum 値の削除・改名、範囲の縮小（`maxItems` を減らす等）。
- **適合し続ける変更（additive）** → `uat_schema_version` は据え置き、Skill の `version` を上げ、
  何を足したかを schema の `description` に書く。**optional field の追加**、既存 enum への
  **値の追加**（旧 report は旧値のままなので適合する）、範囲の緩和（`maxItems` を増やす等）。
- 文言・見出しの調整のみ → Skill の `version` だけを上げる。

0.8.0（[#1616](https://github.com/Kewton/CommandMate/issues/1616)）はこの additive 側で行った:
per-issue の `verdict` / `verdict_source` / `baseline` / `acceptance`、top-level の `acceptance` /
`conditional_issues` はいずれも **optional**、`stop_reason` に `acceptance_conditional` を追加、
`completion_check.checks` の `maxItems` を 5 → 6 に緩和（`minItems` は 5 のまま）。0.7.x が書いた
report は無改変で v1 に適合し続ける。**新しい runner が書く report を旧 runner の schema で検証すると
落ちる**（schema は package と一緒に動く）ため、report の読み手は同梱 schema を使うこと。
