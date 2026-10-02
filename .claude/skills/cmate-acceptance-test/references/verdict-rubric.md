# verdict rubric — outcome から status と verdict を決める

`SKILL.md` の Step 5 と Step 7 で使う。判定は決定表に従い、表にない解釈を加えない。

## 1. criterion の outcome

| outcome | 意味 | 必要な evidence |
|---|---|---|
| `pass` | 検証し、条件を満たしていた | 1 件以上（必須） |
| `fail` | 検証し、条件を満たしていなかった | 1 件以上（必須） |
| `flaky` | 同一手順で結果が安定しない | 必須。全試行の結果を `attempts` に残す |
| `blocked` | 環境・認証・依存が欠けていて検証できない | 任意。欠けているものを示せるなら添える |
| `not_run` | 実行しなかった（未確認、非対話、中断、時間切れ） | 任意 |
| `manual_pending` | 手動確認が必要で、まだ行われていない | 任意 |
| `not_verifiable` | この環境・時点では判定材料が存在しない | 任意 |

evidence が任意の 4 つも、`notes` に理由を書くことは必須である。
「なぜ確定していないか」が書けない未確定項目は、次 action も書けない。

丸めの禁止（この 4 つは頻出の誤りである）:

- `flaky` を `pass` にしない。1 回でも落ちたなら安定していない。
- `blocked` を `fail` にしない。実装の問題と環境の問題は別である。
- `not_run` を `pass` にしない。実行していない。
- `manual_pending` を `pass` にしない。誰も見ていない。

## 2. status（Skill 実行の完了度）

上から順に評価し、最初に一致したものを採る。

| # | 条件 | status |
|---|---|---|
| 1 | 入力不足、Issue 取得失敗、受入条件 0 件、対象解決失敗のいずれか | `failure` |
| 2 | `pass` / `fail` 以外の outcome を持つ criterion が 1 件以上ある | `partial` |
| 3 | 全 criterion が `pass` または `fail` | `success` |

`status` は「受入の可否」ではなく「検証しきったか」を表す。
全条件を検証して 1 件落ちた実行は `success` であり、判定は `no_go` になる。

## 3. verdict（受入の可否）

上から順に評価し、最初に一致したものを採る。

| # | 条件 | verdict |
|---|---|---|
| 1 | `status` が `failure` | `no_go` |
| 2 | `outcome: fail` の criterion が 1 件以上ある | `no_go` |
| 3 | `status` が `success`（= 全 `pass`） | `go` |
| 4 | 未確定の criterion すべてに `next_action` と担当がある | `conditional_go` |
| 5 | 上記以外 | `no_go` |

行 4 の「未確定」とは `flaky` / `blocked` / `not_run` / `manual_pending` /
`not_verifiable` を指す。1 件でも次 action と担当を書けないものが残るなら、
行 5 に落ちて `no_go` である。**書けないことは、判断できないことである。**

`conditional_go` は「条件付きで進んでよい」であり、条件は列挙されていなければならない。
`conditional_go` を出すときは、`next_actions` が空であってはならない。

## 4. 決定表の確認例

| 状況 | outcome の内訳 | status | verdict |
|---|---|---|---|
| 全条件を検証し全て満たした | pass 5 | `success` | `go` |
| 1 件が満たされなかった | pass 4 / fail 1 | `success` | `no_go` |
| 1 件が不安定 | pass 4 / flaky 1 | `partial` | `conditional_go`（次 action があるとき） |
| 環境が無く 1 件検証できない | pass 4 / blocked 1 | `partial` | `conditional_go`（同上） |
| 危険な check の承認が得られない | pass 3 / not_run 1 | `partial` | `conditional_go`（同上） |
| 未確定があり次 action を書けない | pass 4 / blocked 1 | `partial` | `no_go` |
| fail と blocked が混在 | pass 3 / fail 1 / blocked 1 | `partial` | `no_go` |
| Issue に受入条件が無い | — | `failure` | `no_go` |

## 5. human-readable summary の雛形

Step 7 で提示する。順序を変えない。離席から戻った利用者が、これだけで
「何が終わっていて、何が残っているか」を復元できることが要件である。

```
受入テスト結果: <GO | CONDITIONAL GO | NO-GO>
理由: <1 行>

対象
  Issue      #<n> <title>
  repository <owner/repo>
  branch     <branch> @ <short-sha><, 未 commit の変更あり>
  実行        <agent> <version> / <収集時刻 UTC>

受入条件 (<pass 件数>/<総数> 検証済み)
  [PASS]    AC-01 <要約>                      evidence: EV-01
  [FAIL]    AC-02 <要約>                      evidence: EV-02
  [FLAKY]   AC-03 <要約> (3 回中 2 回成功)     evidence: EV-03
  [BLOCKED] AC-04 <要約> — <欠けているもの>
  [PENDING] AC-05 <要約> — 手動確認が必要

実行した check
  - <command> → exit 0
  - <test> → 12 passed / 0 failed

実行しなかった check
  - <command> — 承認が得られなかった (risk: confirm_required)
  - <manual observation> — 手動確認が未実施

次 action
  1. <action> — 担当: <誰>
  2. <action> — 担当: <誰>

evidence: <evidence_dir>/  (result: <result_path>)
```

「実行した check」と「実行しなかった check」は必ず別の節にする。
1 つの一覧に混ぜると、未実行が実行済みに見える。
