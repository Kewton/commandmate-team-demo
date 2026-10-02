# test plan — 分類、risk tier、cleanup plan

`SKILL.md` の Step 2 と Step 3 で使う。受入条件を「実行できる検証」へ落とし、
実行前に何を確認するかを決めるための規則である。

## 1. classification

各受入条件を 3 つのどれかに分類する。判断できないものを `automated` に寄せない。

| classification | 条件 | 例 |
|---|---|---|
| `automated` | command の exit code、test の結果、diff の内容だけで真偽が決まる | 「`npm run lint` が通る」「API が 400 を返す」 |
| `manual` | 人間の観察が要る。見た目、文言、操作感、外部 system の状態 | 「初見利用者が期待効果を説明できる」「画面の警告が読める」 |
| `not_verifiable` | この環境・この時点では判定材料が存在しない | 「本番負荷で劣化しない」を負荷環境なしで問われた場合 |

分類の根拠を 1 行で残す。根拠が書けない条件は `not_verifiable` である。

条件が「A かつ B」の形をしているときは分割し、`AC-03a` / `AC-03b` のように
枝番を振る。片方だけ検証できた条件を丸ごと `pass` にしない。

## 2. risk tier

分類とは独立に、**その検証を実行すること自体の危険度**を決める。

| risk tier | 条件 | 実行前に必要なもの |
|---|---|---|
| `safe` | 読み取りのみ、または対象 worktree 内の一時 file 作成のみ。副作用が worktree 内に閉じる | なし |
| `confirm_required` | destructive、外部書き込み、worktree 外への書き込み、長時間実行、課金が発生しうる | 利用者の確認 + cleanup plan |
| `blocked` | 必要な環境・認証・data が存在せず、実行できない | 実行しない。`outcome: blocked` |

`confirm_required` に当たる具体例:

- data の削除・truncate、migration の適用、schema の変更
- branch / tag の削除、force push、`git reset --hard`
- 外部 API への書き込み、mail や message の送信、deploy、release の作成
- 対象 repository の外への file 書き込み
- 本番相当の credential を要する操作

判断に迷ったら `confirm_required` にする。`safe` を広く取ると、確認なしの副作用が通る。

## 3. 本番 data と既存 worktree

- 本番 data、本番 credential、既存の worktree を **暗黙に fixture として使わない**。
  使う必要があるなら `confirm_required` として明示し、確認を取る。
- test 用の data は、対象 worktree 内に新しく作る。既存 file を上書きしない。
  同名 file が既にある場合は、上書きの可否を個別に確認する。
- 「たまたま手元にある DB」を対象にしない。何を対象にしたかを `target` に記録できない
  検証は、再現できないので `blocked` である。

## 4. cleanup plan

`confirm_required` の check には、確認を求める前に cleanup plan を添える。
plan には次の 4 つを書く。

1. **作るもの** — 作成する file、record、branch、外部 resource
2. **戻し方** — 具体的な手順（「元に戻す」ではなく、実際に実行する command）
3. **戻せないもの** — 送信済み message、外部 system の副作用、削除された data
4. **失敗したときに残るもの** — cleanup 自体が失敗した場合に手作業で消す対象

戻せないものがある場合、その事実を確認要求の中で先に述べる。
cleanup plan を書けない操作は実行しない。これは判断ではなく規則である。

実行後は cleanup を実施し、結果（成功 / 失敗 / 手作業が残る）を evidence に記録する。
cleanup の失敗は summary の「次 action」に必ず現れる。

## 5. test plan の提示形式

利用者に提示する plan は、確認の単位が分かる粒度で並べる。

```
test plan (Issue #<n> / <branch> @ <short-sha>)

[1] AC-01 <条件の要約>
    classification: automated   risk: safe
    check: command `npm run lint`
    期待: exit code 0
[2] AC-02 <条件の要約>
    classification: automated   risk: confirm_required
    check: command `npm run migrate -- --apply`
    期待: exit code 0、migration が 1 件適用される
    cleanup: `npm run migrate -- --rollback` で戻す。
             失敗時は <table> に適用済み row が残る。
[3] AC-03 <条件の要約>
    classification: manual      risk: safe
    check: manual observation — <観察手順>
[4] AC-04 <条件の要約>
    classification: not_verifiable
    理由: <この環境に判定材料がない理由>

確認: [2] を実行してよいか。
```

`confirm_required` が複数ある場合も、まとめて 1 回の「はい」で通さない。
危険度の異なる操作を 1 つの確認に束ねると、利用者が何に同意したか分からなくなる。
