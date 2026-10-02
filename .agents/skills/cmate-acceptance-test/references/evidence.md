# evidence — 必須項目と redaction

`SKILL.md` の Step 4 で使う。判定の根拠を、後から第三者が確認できる形で残すための規則である。

evidence の目的は「そう判定した理由」を再構成できるようにすることであって、
実行の全 log を保存することではない。**残す量ではなく、辿れることを要件とする。**

## 1. 共通の必須項目

すべての evidence entry は次を持つ。

| field | 内容 |
|---|---|
| `id` | `EV-01` から連番。criterion から参照される |
| `type` | `command` / `test` / `diff` / `manual_observation` |
| `collected_at` | 収集時刻（RFC 3339、UTC） |
| `summary` | 1〜3 行。何を実行し、何が観察されたか |
| `redacted` | 伏字処理を行ったかどうか |

`summary` は「PASSED」だけにしない。何が pass したのかが分かる語を含める。

## 2. type ごとの必須項目

### `command`

- `command` — 実行した command 文字列（引数を含む。§3 の規則で伏字処理する）
- `exit_code` — 整数。**必ず実測値を書く。** 推定や「たぶん 0」は不可
- `duration_ms` — 任意
- `output_excerpt` — stdout / stderr の抜粋。上限 4000 文字。超えたら
  先頭・末尾・エラー行を優先して切り詰め、`truncated: true` を立てる
- `attempts` — 再実行した場合の試行回数と各回の exit code

exit code を取得できなかった場合（timeout、強制終了）は `exit_code` を `null` にし、
`summary` にその理由を書く。0 と書かない。

### `test`

- `framework` — 実行した test runner
- `total` / `passed` / `failed` / `skipped` — 件数
- `failed_tests` — 失敗した test の識別子（最大 20 件）
- `skipped` が 0 でない場合、skip された test が受入条件に関わるかを `summary` に書く

`skipped` を `passed` に足さない。

### `diff`

- `commit` — 対象の commit SHA（40 桁）
- `changed_files` — path と追加 / 削除行数の一覧
- **file の内容そのものは記録しない。** path と行数で足りる

### `manual_observation`

- `observer` — 誰が観察したか（`user` / agent 名）
- `procedure` — 実行した手順
- `observed` — 観察された事実。解釈ではなく事実を書く
- `conclusion` — その事実から criterion をどう判定したか

観察していないものを `manual_observation` として作らない。
「実行すれば通るはず」は evidence ではない。

## 3. redaction

evidence と result document に、次を**書かない**。

1. token、API key、password、signed URL、session cookie
2. 環境変数の値。必要なのは「設定されているか否か」だけである
3. 個人を特定する data、本番の顧客 data
4. 受入条件と無関係な file の内容
5. machine 固有の絶対 path（利用者名を含む home directory など）

### 手順

- command 文字列と output は、保存する前に伏字処理する。
- 伏字は `<redacted:kind>` の形式にする（例 `<redacted:token>`、`<redacted:env-value>`）。
  伏せた事実が残らないと、後から「何が伏せられたか」を判断できない。
- 環境変数は `NAME=<set>` / `NAME=<unset>` の形でのみ記録する。値は書かない。
- 絶対 path は対象 repository root からの相対 path に置き換える。
- 伏字処理を行った entry は `redacted: true` にする。

### 見つけたときの動作

evidence を書き出す前に伏字処理する。**書いてから消すのでは遅い。**
すでに保存済みの file に含まれていることに気付いた場合は、その file を削除し、
削除した事実と対象を summary に記録する。伏字処理できなかった entry は保存しない。

なお、secret を含む可能性のある値を利用者へそのまま表示することも同じ扱いである。
標準出力もまた記録である。

## 4. 保存先と参照

- evidence は `evidence_dir`（既定 `./acceptance-evidence/`）配下に置く。
- result document には evidence の `id` と相対 path を書く。内容の全文を埋め込まない。
- criterion からは `evidence_ids` で参照する。`outcome: pass` / `fail` / `flaky` の
  criterion に evidence が 1 件も結び付いていない状態は schema 違反であり
  （`schemas/acceptance-result.v1.json` の `criterion.evidence_ids`）、
  `SKILL.md` §6 の完了条件を満たさない。
