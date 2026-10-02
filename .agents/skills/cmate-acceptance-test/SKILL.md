---
name: cmate-acceptance-test
description: Issue の受入条件を自動検証と手動確認に分け、証跡付きで検証して Go / Conditional Go / No-Go を判定する。受入テスト、受入条件の検証、マージ可否・リリース可否の判断を求められたときに使う。
---

# cmate-acceptance-test

対象 Issue の受入条件が満たされているかを証跡 (evidence) に基づいて検証し、
可否を `go` / `conditional_go` / `no_go` で返す手順である。

出力は **versioned result document**（`schemas/acceptance-result.v1.json`）と
**human-readable summary** の 2 つであり、どちらか一方だけを返して終了してはならない。

判定の中心にある規則は 1 つだけである。

> **検証していないものを pass に丸めない。**
> 未実行・環境依存・flaky・blocked・手動未確認は、pass でも fail でもない固有の
> outcome として記録し、判定に反映する。

この文書が述べるのは「いつ使うか」「どう呼ぶか」「出力をどう読むか」「止まったとき
何をするか」の 4 つだけである。分類・evidence・決定表の規則は §8 の references と
schema が正本であり、食い違った場合は references と schema を採る。

## 0. 使う場面 / 使わない場面

使う場面:

- Issue の受入条件を満たしたかどうかを、証跡付きで確認したいとき。
- マージ・リリースの可否を、第三者が再現できる形で残したいとき。
- 何が検証済みで、何が未検証のまま残っているかを分けて報告したいとき。
- **cmate-orchestrate の UAT 意味ゲートへ判定を渡したいとき。** この Skill の result
  document は orchestrate の uat runner が読む意味ゲートの**入力**である。
  その場合の出力先は §1 の `result_path` に従う。

使わない場面:

- 実装や修正そのもの。この Skill は検証のみを行い、production code を変更しない。
- 失敗した test を通すための修正。原因調査と修正は別の手順に渡す。
- 受入条件が存在しない、または合意されていない Issue の可否判断。§4 Step 1 で停止する。

## 1. 入力

| 名前 | 必須 | 内容 | 欠けたときの動作 |
|---|---|---|---|
| `issue_ref` | 必須 | Issue 番号または Issue URL | `status: failure` / `verdict: no_go` を出力して停止。`target.issue_ref` に何を書くかは §5 に従う |
| `target_ref` | 必須 | 検証対象の worktree path、branch、commit | 利用者に問い合わせる。応答が得られなければ `failure` で停止 |
| `test_commands` | 任意 | 実行してよい command と引数の一覧 | 自動検証を行わず、全 criterion を `manual` または `not_run` として扱う |
| `criteria_override` | 任意 | Issue 本文の代わりに使う受入条件 | Issue 本文から抽出する |
| `evidence_dir` | 任意 | evidence の保存先（既定 `./acceptance-evidence/`） | 既定値を使う |
| `result_path` | 任意 | result document の出力先（既定 `./acceptance-result.json`） | 既定値を使う |

入力に関する強い制約:

1. **`target_ref` は利用者が明示したものだけを使う。** 現在の作業 directory、既存の
   worktree、production の設定を「たぶんこれだろう」で対象にしない。
2. 受入条件が Issue 本文から機械的に抽出できないときは、抽出結果を利用者に提示して
   確認を取る。確認が取れない条件は `classification: not_verifiable` として記録する。
3. **cmate-orchestrate から使う場合の `result_path`。** 既定の `./acceptance-result.json`
   は orchestrate の uat runner からは読まれない。runner は `--acceptance-dir` 配下の
   `issue-<n>.json`（`<n>` は対象 Issue 番号）だけを開くので、その file 名で置く。
   例: `--acceptance-dir ./acceptance/` に対して `./acceptance/issue-60.json`。

## 2. 権限

宣言している権限の正本は `commandmate.skill.yaml` の `declared_permissions` と
`risk_rationale` である。宣言は強制ではないので、そこに無い操作が必要になった時点で、
実行せずに利用者へ確認する。宣言からは読み取れない線が 3 つある。

- 対象 repository の外の path を読まない。
- network は Issue 本文の取得だけに使う。evidence を外部へ upload しない。
- 環境変数は**設定されているか否か**だけを確認し、値を読み出さない
  （記録形式は [`references/evidence.md`](./references/evidence.md) §3）。

## 3. 実行してよい command

Skill 自身が実行してよいのは、manifest の `requirements.commands` に宣言された
次の read-only な用途に限る。Issue の書き換え（`gh issue edit` など）は含まれない。

- `gh` — `gh issue view <ref> --json number,title,body,labels,state` のみ。
- `git` — `git status`、`git diff`、`git log`、`git rev-parse`、`git show` のみ。

対象 project の test command（`npm test`、`pytest` など）は **入力として与えられたもの**
だけを実行する。推測して実行しない。実行前に利用者へ提示して確認を取る。
確認が得られなかった command は実行せず、対応する criterion を `not_run` にする。
`not_run` を pass に丸めない。

どの操作が実行前の cleanup plan を要するかは
[`references/test-plan.md`](./references/test-plan.md) §2 が正本である（§4 Step 3）。

## 4. 手順

### Step 0 — 前提の確認

1. `issue_ref` と `target_ref` が揃っているかを確認する。欠けていれば §5 に従って停止する。
2. `target_ref` を解決し、commit SHA と branch 名を記録する（`git rev-parse HEAD`、
   `git rev-parse --abbrev-ref HEAD`）。この 2 つは result document の `target` に入る。
3. 作業 tree に未 commit の変更があるかを `git status --porcelain` で確認し、
   `target.dirty` に記録する。

### Step 1 — 受入条件の抽出

1. Issue 本文を取得し、受入条件（checkbox、「受入条件」節、`Acceptance Criteria`）を
   列挙する。
2. 各条件に `id` を振る（`AC-01` から連番。抽出順で固定し、実行結果で並べ替えない）。
3. 条件が 0 件のときは §5 に従って停止する。条件のない Issue を「問題なし」としない。

### Step 2 — 分類と risk tier

各条件に `classification`、`risk_tier`、検証に使う `check` を決め、分類の根拠を 1 行で
`notes` に残す。3 つの classification と 3 つの risk tier の定義、および迷ったときに
どちらへ倒すかは [`references/test-plan.md`](./references/test-plan.md) §1–§2 が正本である。

### Step 3 — test plan の提示と確認

1. 分類結果を test plan として利用者に提示する。提示形式は
   [`references/test-plan.md`](./references/test-plan.md) §5、`confirm_required` に
   添える cleanup plan の要件は同 §4 にある。cleanup plan を書けない操作は実行しない。
2. 利用者の応答を `confirmations` に記録する。確認なしに `confirm_required` の項目を
   実行しない。
3. 対話できない実行形態（非対話 batch）では、`confirm_required` の項目をすべて
   `not_run` にして先へ進む。「対話できないから承認されたとみなす」ことはしない。

### Step 4 — 実行と evidence 収集

確認済みの check を、plan の順に実行する。1 件ごとに evidence を作る。
evidence の type ごとの必須項目、flaky の記録方法、redaction 規則は
[`references/evidence.md`](./references/evidence.md) が正本である。

中断した場合も、そこまでの evidence を保存し、未実行の check を `not_run` として
result document を出力する（§5）。

### Step 5 — 判定

各 criterion に `outcome` を付け、そこから `status` と `verdict` を導く。
`status` は「検証しきったか」、`verdict` は「受入してよいか」を表し、**両者は独立する**
（全条件を検証して 1 件落ちた実行は `status: success` かつ `verdict: no_go`）。

outcome の 7 値、丸めの禁止、`status` と `verdict` の決定表は
[`references/verdict-rubric.md`](./references/verdict-rubric.md) が正本である。
決定表に**そのまま**従い、表にない組み合わせを自分で判断しない。

### Step 6 — result document の出力

`result_path` に、`schemas/acceptance-result.v1.json` に適合する JSON を書く。
`result_schema_version` は `1` である。**この Step は途中で失敗した場合も必ず実行する。**

### Step 7 — human-readable summary

result document と同じ内容を、
[`references/verdict-rubric.md`](./references/verdict-rubric.md) §5 の雛形の順で提示する。
利用者が離席から戻ったときに、これだけで状態を復元できることが要件である。

## 5. 失敗時の動作

| 状況 | 動作 |
|---|---|
| 入力が欠けている | 推測で補わない。`status: failure`、`verdict: no_go`、`blocking_reasons` に不足入力を記録 |
| Issue を取得できない | 再試行は 1 回まで。失敗したら `status: failure` |
| 受入条件が 0 件 | `status: failure`（Step 1-3） |
| 確認が得られない | 当該 check を `not_run`、`status: partial` |
| command が異常終了 | それ自体は failure ではない。exit code を evidence に残し、criterion を `fail` か `blocked` に分類する（環境要因なら `blocked`） |
| 環境が要件を満たさない | `blocked`。`fail` に丸めない |
| 途中で中断された | そこまでの evidence を保存し、未実行を `not_run` として `status: partial` を出力 |
| result document を書けない | summary を必ず標準出力へ出し、書けなかったことを明示する |

いかなる失敗経路でも、**result document と summary を出さずに終了しない**。

### `target.issue_ref` に何を書くか

`target.issue_ref` は schema 上 required で、空文字列を許さない
（`schemas/acceptance-result.v1.json`）。失敗経路でも result document を出す以上、
`issue_ref` が渡されなかったときに何を書くかがここで決まっている必要がある。

- **呼び出し元から渡された入力をそのまま記録する。** 裸番号、`#<n>`、`owner/repo#<n>`、
  Issue URL のいずれでもよい。正規化も補完もしない。
- **何も渡されなかった場合は、固定文字列 `unspecified` を記録する。**
  推測で Issue 番号を埋めてはならない。branch 名、作業 directory 名、直近の commit から
  番号を復元することもこれに当たる。

`unspecified` は Issue 番号として解決できない文字列である。consumer である
cmate-orchestrate の uat runner は `target.issue_ref` から Issue 番号を解決できないと、
その result を **mismatched**（対象 Issue を担保すると確認できない）に分類し、
`--require-acceptance` 付きの実行ではその Issue を不合格にする。
これは意図した安全側の挙動である。どの Issue のものか分からない判定を、
その Issue の意味ゲートとして通してはならないからである。

## 6. 完了条件（completion check）

完了したと報告してよいのは、次の 3 つがすべて真のときだけである。
1 つでも偽なら `status` は `success` にならない。

1. result document が [`schemas/acceptance-result.v1.json`](./schemas/acceptance-result.v1.json)
   に適合している（criterion ごとの `id` / `classification` / `outcome`、`pass` に対する
   evidence、`confirm_required` に対する `confirmations`、次 action の担当は schema の要件）。
2. `status` と `verdict` が
   [`references/verdict-rubric.md`](./references/verdict-rubric.md) の決定表と矛盾せず、
   実行した check と実行しなかった check が同 §5 の雛形どおり別々に示されている。
3. evidence が [`references/evidence.md`](./references/evidence.md) §3 の redaction 規則を
   満たしている。

## 7. Agent 差異

対応 Agent の差、fallback、再読み込みの方法は
[`references/agent-compatibility.md`](./references/agent-compatibility.md) を参照する。
version ごとの変更点・期待効果・制約は
[`references/changelog.md`](./references/changelog.md) にある。

## 8. 参照

- [`references/test-plan.md`](./references/test-plan.md) — 分類と risk tier、cleanup plan
- [`references/evidence.md`](./references/evidence.md) — evidence の必須項目と redaction
- [`references/verdict-rubric.md`](./references/verdict-rubric.md) — 決定表と summary 雛形
- [`references/agent-compatibility.md`](./references/agent-compatibility.md) — Agent 差異と reload
- [`references/changelog.md`](./references/changelog.md) — version 履歴・期待効果・制約
- [`schemas/acceptance-result.v1.json`](./schemas/acceptance-result.v1.json) — result document schema
