# result contract v1

`cmate-worktree-setup` が返す result object の定義である。
機械検証用の正本は
[../schemas/worktree-setup.result.v1.json](../schemas/worktree-setup.result.v1.json)
であり、この文書はその読み方と、schema では表現できない規則を述べる。

`result_schema_version` は 1 である。field の追加・削除・意味の変更は version を上げて行う。
**未知の field を足さないこと。** 受け手は schema にない field を無視せず、契約違反として扱う。
この Skill は self-contained であり、result に dependency field を持たない。

## 1. 全体の形

```json
{
  "result_schema_version": 1,
  "skill_id": "cmate-worktree-setup",
  "skill_version": "0.1.0",
  "generated_at": "2026-07-21T00:00:00Z",
  "status": "success",
  "phase_reached": "complete",
  "request": { "issue_numbers": [1448], "max_issues": 5, "reuse_existing": false },
  "repository": { "slug": "Kewton/CommandMate", "current_branch": "…", "dirty": false },
  "profile": { "selected": "node", "verified": true, "base_sha": "…", "baseline_command": "…" },
  "plan": [],
  "worktrees": [],
  "baseline": [],
  "commandmate_sync": { "available": false, "attempted": false, "worktree_id": null, "detail": "…" },
  "collisions": [],
  "redactions": [],
  "next_actions": [],
  "blocking_reasons": [],
  "limitations": [],
  "completion_check": { "passed": true, "checks": [] },
  "summary_markdown": "## 対象と結論\n…"
}
```

すべての top-level field は必須である。該当が無い場合は空配列を置く。
field を省略することと空配列を置くことは意味が違う。前者は「答えていない」、
後者は「確かめた上で無かった」である。

## 2. status と phase

| status | 条件 | 必須 |
|---|---|---|
| `success` | 要求された全Issueの worktree を作成し、baseline が pass、6つの check がすべて true | — |
| `partial` | worktree は作成したが、baseline 失敗・sync が使えない・collision skip・drift・check 失敗のいずれかがある | `limitations` 1件以上 |
| `failure` | worktree を1件も作成していない | `blocking_reasons` 1件以上 |

`phase_reached` は到達した最遠の phase（`inspect` / `plan` / `create` / `baseline` / `sync` / `complete`）。
`inspect` / `plan` で終わった場合、`worktrees` に `created=true` の entry は存在しない。

`completion_check.passed` が false のとき status を `success` にしてはならない。
`failure` でも `request` と、判明した範囲の `repository` / `profile` は埋める。
どこまで進んで失敗したかが分からない失敗報告は、再実行の判断材料にならない。

## 3. field 定義

### 3.1 `request`

正規化した入力を返す。`issue_numbers` は正の整数のみ。`max_issues` を超えた分は
採用せず、落とした番号は `limitations` に書く。`reuse_existing` は明示指定を反映し、
推測で true にしない。`base` を上書きした場合は `base_override` に記録する。

### 3.2 `repository`

`slug` は remote から導いた `owner/name`。**repository root を絶対path として出さない。**
`dirty` は integration worktree の状態で、true のときこの Skill は integration worktree を変更しない。

### 3.3 `profile`

`selected` は `node` / `rust` / `unverified`。`verified` を true にできるのは `node` / `rust` だけ。
`base_sha` は base ref を確定した commit SHA。confirm 前の段階では null を許すが、
作成に進むには非 null が要る。`baseline_command` は profile の proportional baseline を
そのまま実行できる形で記録する（[profile-conventions.md](./profile-conventions.md)）。

### 3.4 `plan`

作成前に確定した dry-run。1 Issue につき1 entry。

- `base_sha` は plan 時点で resolved commit SHA（40 hex）であること。symbolic ref だけを載せない。
- `directory` は repository 相対の安全な path（絶対path・`..`・backslash・制御文字を含まない）。
- `blocked_by` は collision の種類。空なら作成可。非空なら Step 4 の規則で扱う。
- `sync_planned` は CommandMate sync を意図するか。sync を使えないなら false。

### 3.5 `worktrees`

作成を試みた各 target の結果。

- `created=true` は新規作成。`reused=true` は `reuse_existing` 明示下の exact match reuse。
  **両方を同時に true にしない。** どちらも false なら plan されたが未作成。
- `base_sha` は **作成直前に再確認** した SHA。未作成の entry では null。
- drift（plan 後に base が動いた）で作成を見送った場合は `created=false` とし、`note` と
  `limitations` に drift を記録する。

### 3.6 `baseline`

- `outcome` は `pass` / `fail` / `not_run` / `skipped`。丸めない。`fail` でも worktree は保持する。
- `exit_code` は測定値。kill / timeout / 未実行では null。その場合に 0 を書かない。
- `output_excerpt` は redaction 済みの短い抜粋のみ。**raw terminal の全量を残さない。**
  redaction したら `redacted=true` にする。

### 3.7 `commandmate_sync`

`available` は sync 経路を使えるかどうか。sync は optional なので、`available=false` は失敗ではない。
`worktree_id` は sync 後に `commandmate ls --json` から解決した ID
（[profile-conventions.md](./profile-conventions.md) 第5節）。未取得なら null にし、推測で埋めない。
token や絶対path を `detail` に残さない。

### 3.8 `collisions`

planned target と一致した既存物。`kind` は `local_branch` / `remote_branch` / `directory` / `worktree`。
worktree は `git worktree list --porcelain` から判定し、substring grep で決めない。
`detail` は既存名（絶対path を redaction 済み）。

### 3.9 `redactions`

`kind` と `count` のみ。redaction した値そのもの・一部・伏字化した値・長さのいずれも書かない。
kind は schema の `redaction_kind` enum に従う。

### 3.10 `next_actions` / `blocking_reasons` / `limitations`

- `next_actions` は `action` と `owner`。owner の無い action は next action ではない。
  cleanup 等の次の一手を、作成済み worktree の状態に応じて示す。
- `blocking_reasons` は run が進めなかった理由。status が `failure` のとき非空。
- `limitations` は使えなかった capability と代替、落とした Issue、drift、unverified profile など。

### 3.11 `completion_check`

`checks` は6件で、id は次がちょうど1回ずつ現れる。各 check が何を確かめるかは次のとおり。

| check id | 何を確かめるか | 規則の正本 |
|---|---|---|
| `input_validated` | `issue_numbers` が正の整数のみで、`max_issues` の上限適用が記録されている | 本書 3.1、schema の `request` |
| `plan_confirmed` | 作成前に plan を提示し、確認を得た（または未作成で終わった） | 本書 3.4 |
| `no_implicit_overwrite` | 既存 branch / directory / worktree を暗黙に上書き・reset・reuse していない | [safety.md](./safety.md) 第2節 |
| `base_reconfirmed` | 作成した worktree の base SHA を作成直前に再確認した | [safety.md](./safety.md) 第3節、本書 3.5 |
| `baseline_reported` | baseline の結果を丸めず、失敗時は worktree を保持した | [safety.md](./safety.md) 第5節、本書 3.6 |
| `no_secret_or_abspath` | result / summary に token・secret・絶対path が無い | [safety.md](./safety.md) 第6節、本書 3.9 |

`passed` は6件すべて true のときだけ true。false の check には理由を `detail` に書く。
**1件でも false なら status を `success` にしてはならない**（第2節）。

## 4. `summary_markdown`

人が読む要約。次の見出しを、この順序でちょうど1回ずつ含める。

```markdown
## 対象と結論
## profile
## plan（dry-run）
## 作成結果
## baseline
## CommandMate sync
## 未解決とnext action
```

規則:

- 「結論」相当を「対象と結論」の先頭3行以内に書く。status が `partial` / `failure` のときは
  先頭でそれを明示し、**作成済み / 未作成** を一目で分かるようにする。
- branch / directory / base SHA / baseline command を1画面で確認できるように並べる。
- collision・baseline failure・sync failure を区別して書く。作成済みかどうかを曖昧にしない。
- token・secret・絶対path を書かない。値は構造化 field と食い違わせない。
- 末尾は無条件の「完了」で終えず、next action と owner で終える。

## 5. version 運用

- field の追加・削除・意味の変更 → `result_schema_version` を上げる
- enum への値の追加 → `result_schema_version` を上げる（受け手は未知の enum 値を受け付けない）
- 文言・見出しの調整のみ → Skill の `version` だけを上げる
