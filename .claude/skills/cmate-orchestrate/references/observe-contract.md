# 観測契約 v1（merge 後の観測 runner）

`cmate-orchestrate` の観測 runner（`scripts/observe.mjs`）が、**merge のあとに base branch の上で
何を N 回測り、何を report に残すか**の定義である。機械検証用の正本は
[../schemas/observe-report.v1.json](../schemas/observe-report.v1.json) であり、この文書はその
読み方と、schema では表現できない規則を述べる。

出どころは [#221](https://github.com/Kewton/commandmate-skills/issues/221) と、その元になった
[Kewton/CommandMate#1835](https://github.com/Kewton/CommandMate/issues/1835)（利用リポジトリ
Kewton/BorderFreeKidsMap での実測）である。

`observe_schema_version` は 1 である。**未知の field を足さないこと。**

---

## 1. 何を解く runner か

受入条件には **worktree の中では測れないもの**がある。

> merge 後の CI 3 run の wall-clock 中央値が着手前より 1 分以上短い
> CI 5 run の e2e 時間が 30% 以上短く、flaky 件数が +1 以内

skill にはこれを測る段が無かった。`uat.mjs` は **worktree 内**で profile baseline を回す
受入判定であり（[uat-contract.md](./uat-contract.md)）、merge 後の CI を観測する経路ではない。
`merge.mjs --integration-verify` は merge 後 base 上で検証集合を **1 回**回して「統合ブランチが
green か」を答える段であり（[merge-contract.md](./merge-contract.md) 第5.4節）、run 時間を N 回
集める段ではない。結果、人間が手で測り、**測り方の誤りが混ざった。**

実測された誤りは3つで、この runner の形はすべてそこから来ている。

| 実測 | この runner の対応 |
|---|---|
| **最初の 2 本が外れ値だった。** merge 直後 3 run の中央値 446 秒を見て「未達」と報告 → run が溜まってから 8 run の中央値は 385.0 秒（−63.5 秒）で達成。誤報告を撤回した | **全 run を1行ずつ並べる**（`samples[]` と `summary_markdown` の表）。中央値だけを見せない。`--runs` は**既定値を持たない** —— 何件に基づく数字かは人間が決めて report に残す |
| **run 全体に `setup-node` のばらつきが乗る**（38〜66 秒）。e2e 並列化の受入条件を run の wall-clock で読むと、条件と違うものを測ることになる | `kind: gh_job_step` が **job / step 名で秒数を採る**（`gh api …/jobs`）。run 全体を採る `gh_run` とは別の宣言である |
| **5 run 目で初めて出た不良。** 1〜4 run 目は緑で、5 run 目で serve が 3 回死んで 28 分ハングした | 集めるのは `--runs` 件で、**足りなければ `partial`**。件数は `requested` / `collected` / `counted` として数字で残る |

## 2. 固定事項（Issue が固定したもの）

- **裁定しない。** report に verdict field は無い。`status` は**観測の完了度**だけを表す。
  数字が揃っても結論が割れる（実測3件目がそれである）ので、読み方は人間が決める。
- **採否の語彙を出力に持ち込まない。** `pass` / `fail` の語は report のどこにも出ない。
  唯一の例外は **GitHub の `conclusion` の逐語転記**で、それは常に `conclusion` という名の
  key の下に在る（第6節）。
- **`uat.mjs` に混ぜない。** uat は worktree、observe は merge 後 base である。混ぜると
  「network に触る run と触らない run」が同じ phase になり、`status` が2つの意味を持つ。
- **`mergedAt` / merge commit は `merge-report.json` に無い**（`pr_number` と `merged: bool` だけ）。
  `gh pr view <n> --json mergedAt,mergeCommit` で取り、**この report に記録する**。
  取れなければその Issue は `not_observable`（理由付き）で、**窓の始まりを推測しない**（第5節）。
- **`--comment` は `--approve` 必須。** この package で **runner が GitHub に書く初の経路**である。
  既定は書かない・書くのはコメントのみ・本文は触らない（第8節）。
- **`--max-wait` 到達で揃わなくても、集まった分を出して `partial`。** 切り捨てを名乗る
  （[#165](https://github.com/Kewton/commandmate-skills/issues/165) と同じ規律）。

## 3. 入力

```
observe.mjs --plan <plan.json> --merge <merge-report.json> --runs <n>
            [--inspect <report.json>] [--profile <profile.json>]
            [--max-wait <sec>] [--poll-interval <sec>] [--out <dir>]
            [--comment --approve] [--gh <bin>] [--git <bin>]
```

| 名前 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `--plan <path>` | 必須 | なし | merge した plan。`profile.observations` が観測の宣言元である |
| `--merge <path>` | 必須 | なし | その run の `merge-report.json`。**`merged: true` の target だけ**が対象になる |
| `--runs <n>` | 必須 | **無い** | 観測ごとに集める件数。**既定値を置かない**（第1節・実測1） |
| `--inspect <path>` | 任意 | なし | 「着手前の値」を持つ JSON（第7節）。**特定の producer 形式に依存しない** |
| `--profile <path>` | 任意 | なし | plan ではなく profile file から宣言を読む（第4.2節） |
| `--max-wait <sec>` | 任意 | `0` | 揃うまで再照会する上限秒。`0` は1巡だけ |
| `--poll-interval <sec>` | 任意 | `30` | 再照会の間隔秒 |
| `--out <dir>` | 任意 | `<merge dir>/observe` | 出力先。**既存なら `out_exists`（exit 4）** |
| `--comment` | 任意 | off | `summary_markdown` を Issue に**コメント**する。**`--approve` 必須** |
| `--approve` | 任意 | off | 上の唯一の書き込みへの明示承認 |
| `--gh` / `--git` | 任意 | `gh` / `git` | CLI の差し替え（fixture 用） |

読めない入力・受け付けられない invocation は **観測せずに拒否**する。envelope の `status` は
`refused`、`issues` は `null` である（「見て何も無かった」と「見られなかった」を同じ形にしない。
`inspect.mjs` の `inspection: null` と同じ規律）。

## 4. profile の宣言（`observations`）

### 4.1 形

```json
"observations": [
  { "id": "ci-wallclock", "kind": "gh_run",      "workflow": "ci.yml", "unit": "s" },
  { "id": "e2e-step",     "kind": "gh_job_step", "workflow": "ci.yml", "job": "e2e", "step": "Run e2e", "unit": "s" },
  { "id": "bundle-size",  "kind": "command",     "command": "bash scripts/measure-bundle.sh", "unit": "bytes" }
]
```

正規化と検証は `scripts/lib.mjs` の `normalizeObservations` が持つ。**planner と observe の両方が
読むので lib.mjs に在る** —— 2つ持てば「宣言が何を意味するか」について2つの意見を持つことになり、
その食い違いは黙って進む（planner が拒否する profile を observe が受ける、またはその逆）。

profile 側の規約全文は [profile-contract.md](./profile-contract.md) 第12節。**拒否はすべて
`load_error` / exit 6** である（同 第9.3節と同じ規律）: 未知 `kind`、`kind` ごとの必須 key 不足、
`unit` 不足、entry の未知 field、id の重複、token でない id、array でない宣言。
**未知 kind を黙って飛ばさない** —— 飛ばした run は「揃った観測集合」を名乗りながら
著者が頼んだ測定を欠いている。

### 4.2 宣言の出どころは `plan` が既定で、`--profile` は明示の逃げ道である

既定は **`plan.profile.observations`** である。dispatch が `plan.profile.dispatch_defaults` を読み
（[#196](https://github.com/Kewton/commandmate-skills/issues/196)）、merge が
`plan.profile.integration_baseline` を読む（[#195](https://github.com/Kewton/commandmate-skills/issues/195)）
のと同じ handoff で、**走るものは承認された plan が凍結したもの**である。ここで on-disk の profile を
黙って優先すると、同じ `run_id` の 2 回の observe が違うものを測れてしまい、report はどちらを測ったか
言えない。

`--profile <path>` を**併設**する理由は、**merge 済みの wave は re-plan できない**からである。
profile に `observations` を足すと run_id は変わり（解決済み profile 全体が hash 対象。
[#157](https://github.com/Kewton/commandmate-skills/issues/157)）、観測したい run はもう起きてしまっている。
observe は read-only かつ merge 後なので profile file を直接読んでも plan の純関数性には触れない。
ただし **別の出どころであることは黙らせない**: `observations_source: "profile_file"` を report に書き、
`observations_from_profile_file` を limitation に積む。

宣言が空（key が無い / `[]`）なら **`observations_undeclared`（exit 3）で拒否**する。
「観測を1件もしなかった run」を「観測した run」と同じ形にしないためである。

## 5. 観測の窓

窓は **その Issue の merge の瞬間**に始まる。`gh pr view <n> --repo <r> --json mergedAt,mergeCommit`
で取り、`issues[].merged_at` / `issues[].merge_commit` に記録する。

**推測しない。** 取れなければその Issue は `observable: false`・`observations: []`・
`not_observable` の limitation（理由付き）である。merge report 自身の時刻で近似すると、
**その merge が起こしていない run をその merge に帰属させる**ことになる。

`merged: true` の target が1件も無い merge report は `nothing_merged`（exit 3）で拒否する
（base branch が動いていないので、merge 後の状態が無い）。

## 6. kind と、それぞれが何を測るか

| kind | 何を呼ぶか | 値 | counted の条件 |
|---|---|---|---|
| `gh_run` | `gh run list --workflow <w> --branch <base> --limit <n> --json databaseId,url,status,conclusion,createdAt,startedAt,updatedAt` | `startedAt` → `updatedAt` の秒数 | `status: completed` かつ `conclusion: success` |
| `gh_job_step` | 上に加えて `gh api repos/{owner}/{repo}/actions/runs/{id}/jobs` | 指定 job の指定 step の `started_at` → `completed_at` の秒数 | その **step の** `conclusion: success` |
| `command` | `git fetch origin <base>` → `git worktree add --detach <dir> <mergeCommit>` → command を `--runs` 回 | stdout の**最後の「行全体が数値」の行** | 数値が読めた |

- **run の選び方は「merge より後に created された run を、古い順に `--runs` 件」**である。
  古い順なのが「merge 後の N run」の字義どおりの読みであり、同時に**外れ値が見える**読みでもある
  （実測1の外れ値は run 1 と 2 である。黙って 3 本目から始める report は答えを選んでいる）。
- **`command` が checkout するのは merge commit** である。「今の branch tip」より強い主張で、
  `gh pr view` が既に oid を返しているので取れる。使い捨ての detached worktree で、呼び出し元の
  working tree には触れない（`--integration-verify` と同じ規律）。後始末に失敗したら
  `observe_tree_left` で名乗る（消せなかったことを黙らない）。
- command は空白で分割し **shell を通さず** spawn する（`baseline` / `integration_baseline` と同じ規則）。
  非 0 終了や数値なしは **除外された sample**（理由付き）であって、裁定ではない。

### 集計と除外

- `median` / `mean` は **`counted: true` の sample だけ**から計算する。
- `counted: false` の sample は **`excluded[]` に `{conclusion, count}` として必ず出る**。
  黙って落とさない。`collected - counted` と `excluded` の合計は常に一致する。
- `conclusion` は **GitHub の逐語転記**である。`in_progress`（まだ結論していない run / step）と、
  gh を呼ばない kind のための `ok` / `no_number_on_stdout` / `command_unavailable` /
  `jobs_unavailable` / `job_not_found` / `step_not_found` だけが runner 自身の語である。
  **report の中で `pass` / `fail` の byte が出うるのはこの field だけ**である。

## 7. 着手前の値（`--inspect`）

`--inspect` が指す JSON を**幅優先**で歩き、**同じ id を持ち、`value`（優先）または `median` に
有限数を持つ最初の object** を「着手前の値」として並べる。見つけた場所は
`baseline_source`（slash path）に残す —— 一致を**信じるのではなく確かめられる**ようにするためである。

**特定の producer の形式に依存しない。** 隣接 Issue
（[#218](https://github.com/Kewton/commandmate-skills/issues/218)）は同 wave で並行実装中であり、
その artifact 形式に依存すると「まだ無いもの」に依存することになる。だからこの規則は
**曖昧さが無い範囲でいちばん弱い規則**にしてある。

一致が無ければ `baseline: null` である。それは **artifact についての事実**であって欠陥ではない。
`--inspect` を渡したのに一致が無い観測があれば `baseline_unavailable` を limitation に積むが、
**collection の完了度は変わらない**（`--runs` 件揃っていれば `success` のままである）。
差分（`median - baseline`）は summary に出すが、**それが達成かどうかは言わない。**

## 8. `--comment`（`--approve` 必須）

この package で **runner が GitHub に書く初の経路**である。それまでの `gh` は
`pr view` / `pr checks` / `pr merge` / `issue view` だけで、SKILL.md 第1節は
**「Issue 本文の自動編集」をスコープ外**としている。**この runner はその線を動かさない。**

- 既定は**書かない**。
- `--comment` を `--approve` 無しで渡すと **`approval_required` / exit 2 で拒否**する。
  拒否は**入力を読む前・最初の `gh` の前**に起きるので、打ち間違いの invocation が
  拒否されるまでの途中で何かを投稿することはありえない。
- 書くのは **`gh issue comment <n> --repo <r> --body-file <path>`** だけである。
  **本文（body）は触らない。**
- 投稿する byte は **`summary_markdown` と 1 byte も違わない**。そのため summary は
  コメントの**前**に確定し、コメントの後に**作り直さない** —— 作り直せば、report は
  「誰も投稿していない文面のコメント」を説明することになる。コメントの結果は
  `comment.written[]` と `limitations[]`（`comment_not_written`）にだけ載る。

### 出力の path は redaction する（merge / uat との差）

`out_dir` と `artifacts[]` は **redact して**記録する。`merge-report.json` / `uat-report.json` は
`out_dir` を渡されたまま入れるので、**ここだけ規約が違う。** 理由は1つ:
**この report は publish されることを前提に設計された唯一の report である**（`--comment`）。
ホストの home directory を名乗る path が、GitHub コメントの 1 byte 隣に在ってはならない。
**実際の directory は stderr に出る**ので、操作には困らない。

## 9. `status` / exit code

| status | 意味 | exit |
|---|---|---|
| `success` | **全観測が `--runs` 件揃った**（除外された sample が在ってもよい）。対象 Issue はすべて観測できた | 0 |
| `partial` | 揃わなかった / 観測不能があった / 要求したコメントが載らなかった。**集まった分は出ている** | 7 |
| `refused` | invocation を受け付けなかった。**1件も観測していない**（`issues` は `null`） | 2 / 3 / 4 / 6 |

`refused` は house の `failure` ではない。この document の status 語彙は **collection について
1つだけ**であり、「何も集めていない、理由はこれ」を、work についての裁定と読める語を借りずに
言う必要があるからである。

**「揃った」は「集めた sample の件数」であって「集計に入った件数」ではない。** 5 run 中 1 本が
`cancelled` でも 5 件揃っているので `success` であり、除外 1 件は数字で出ている。
これは規律の違いではなく、**この runner が測っているのは collection であって品質ではない**という
一点の帰結である。

## 10. completion check

member は `passed` ではなく **`satisfied`** である。この document は何も裁定しないので、
verdict の名を持つ field を置けば、そこから verdict が読み込まれる。

| id | 何を主張するか |
|---|---|
| `no_adjudication` | 集めただけで採否は決めていない |
| `every_sample_listed` | 全 sample を1件ずつ report と summary に並べている |
| `exclusions_counted` | 集計に入れなかった sample は件数として明記している |
| `merge_facts_from_github` | `mergedAt` / merge commit は merge-report ではなく `gh pr view` から取り、この report に記録した |
| `writes_only_when_approved` | GitHub へ書いたのは `--comment --approve` が揃ったときのコメントだけである |

いずれかが `false` なら `status` は `success` にならない。

## 11. status runner はこの report を見ない

**`status.mjs --run <run-dir>` は observe artifact を phase 列に載せない。** observe の出力先は
`--out` であって run directory とは限らず、status の phase モデルは
plan → dispatch → merge / uat である。**この report は単独で読むものである。**

ただし **`NEXT_ACTION_HINTS` には本 runner の code が全件入っている** ——
表に無い code は `UNKNOWN_CODE_HINT` に落ちるので、「まだ誰も分類していない code」と
「表示する場所がまだ無い code」が同じ形になってしまうためである（`inspect.mjs` の code と
同じ扱い。[codes-and-recovery.md](./codes-and-recovery.md) 第6.2節末尾）。

code の一覧と severity・対処は [codes-and-recovery.md](./codes-and-recovery.md) 第7節が正本である。

## 12. スコープ外

- **受入条件の判定。** 数字が線を超えたかどうかは言わない。
- **Issue 本文の編集。** `--comment` はコメントであり、本文には触らない。
- **run の再実行。** 足りなければ `partial` と言うだけで、workflow を起動しない。
- **単位の換算。** 転記した数字と、profile が宣言した `unit` をそのまま出す。
- **flaky 件数の集計。** 実測3件目の「5 run 目で serve が死んだ」は `conclusion` の除外件数として
  出るが、「flaky が +1 以内か」は**受入条件の判定**であり第12節の1つ目に当たる。

## 13. version 運用

`observe_schema_version` を上げるのは **既存 field の意味を変えるか、削るとき**だけである。
field の追加は 1 のままで行い、schema の `required` に足す（reader は closed schema なので、
未知 field を足す runner が契約違反である）。
