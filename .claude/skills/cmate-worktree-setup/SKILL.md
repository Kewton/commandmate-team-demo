---
name: cmate-worktree-setup
description: 1つ以上のIssueについて、profile から解決した branch・directory・base SHA で衝突しない専用 worktree を作成し、baseline 結果を証跡付きで返す。実装や orchestrate を始める前に、既存の branch/directory/worktree を壊さず作業場所を用意したいときに使う。
---

# cmate-worktree-setup

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。呼び出し頻度が高い経路では npx の起動コスト
> （1 回あたり 0.5〜0.9 秒）を避けるため、`~/.local/bin/commandmate` に
> `exec npx --yes commandmate@latest "$@"` の薄いラッパを置く導入形態を推奨する（README の
> 「CommandMate CLI の導入形態」）。

1つ以上のIssueについて、対象repositoryを検証し、**衝突しない専用worktree**を作成し、
その base commit と baseline 結果を **証跡付き** で返すための、portable な標準手順である。

CommandMate（Node）と CommandAgent（Rust）双方の実績あるworktree作成手順を統合したものであり、
どちらか一方の branch 命名・directory・baseline を hardcode しない。branch / base / path / baseline は
すべて **repository profile から解決** する。

この Skill は既存の branch / directory / worktree を **暗黙に上書き・reset・reuse しない**。
作成前に dry-run の plan を提示し、利用者の確認を経てから作成する。

この文書が述べるのは「いつ使うか」「どう呼ぶか」「出力をどう読むか」「どこで止まり、
人間が何をするか」の 4 つだけである。規則の正本は第8節の references と schema にあり、
食い違った場合はそちらを採る。

## 1. この Skill が答える問い

1. この repository はどの profile か（Node/CommandMate か Rust/CommandAgent か、あるいは unverified か）。
2. どの branch・directory に、どの base commit（**resolved SHA**）から worktree を作るか。
3. その target は既存の branch / directory / worktree と衝突しないか。
4. 作成後、どの baseline を実行し、その結果はどうだったか。
5. CommandMate worktree sync は利用可能か。可能なら worktree ID は何か。
6. どこで止まったか。作成済み / 未作成のどちらか。次に何をすべきか。

## 2. 入力

| 名前 | 必須 | 型 | 既定値 | 説明 |
|---|---|---|---|---|
| `issue_numbers` | 必須 | 正の整数の配列 | なし | 対象Issue番号。1件以上。正の整数以外は拒否する |
| `profile` | 任意 | `node` / `rust` / `unverified` | 自動検出 | profile を明示指定して自動検出を上書きする |
| `base` | 任意 | 文字列（git ref） | profile 既定 | branch 作成元の base ref を上書きする |
| `max_issues` | 任意 | 正の整数 | 5 | 1回の run で扱うIssueの上限 |
| `reuse_existing` | 任意 | 真偽 | `false` | exact match の branch/directory/worktree の reuse を許可する（明示時のみ） |
| `install_dependencies` | 任意 | 真偽 | `false` | dependency install を許可する。plan 表示＋明示承認が別途必要 |

Step 0 で検証し、不備があればそこで終了する。**推測で番号を補わない**（`issue_numbers` の
規則は [references/result-contract.md](./references/result-contract.md) 3.1 と schema の
`request`、`profile` / `base` に絶対path・`..`・symlink・repository 外が混じった場合の拒否は
[references/safety.md](./references/safety.md) 第1節が正本）。`max_issues` を超えた分は
落として `limitations` に記録する。**黙って切り捨てない。**

## 3. 権限と禁止事項

宣言している権限は `filesystem_read` / `filesystem_write` / `process_execution` / `network_access`
である。この Skill の手順として **禁止** される操作（既存物の暗黙上書き・path escape・
未承認の dependency install・secret と絶対path の残置など）は
[references/safety.md](./references/safety.md) が正本であり、そのいずれについても
利用者に許可を求めない。

本体 CommandMate の `/worktree-setup` slash command や GUI / API 経由の worktree 作成が
行うこと（server の起動停止、Issue 専用 DB / port の設定、GitHub Project status 更新、
PR / Issue への write、既存worktree の強制削除・cleanup・並列 dispatch）は、いずれも
**本 Skill の scope 外**である。棲み分けは [references/safety.md](./references/safety.md)
第0節、scope 外の列挙は
[references/profile-conventions.md](./references/profile-conventions.md) 第6節にある。

`network_access` は **dependency install を明示承認したときだけ** 使う（host は target
repository の package manager 設定次第なので、install 前に plan で列挙する）。worktree 作成
そのもの（branch を local の resolved SHA から作る）は network を必要としない。

## 4. 手順

各 step は順に実行する。完了できなかった step は握りつぶさず、result に記録して続行する。
作成に踏み込むのは Step 4（plan 確認後）以降だけである。

### Step 0. 入力を検証する

第2節の規則で `issue_numbers` と `profile` / `base` を検証する。不備があればここで終了する。

### Step 1. repository を inspect する（read-only）

`git worktree list --porcelain` と repository の実体を正本とし、文字列 grep だけで判定しない。
次を把握する。存在しないことも結果である。

- repository root と remote（`slug` は remote から導く。**絶対path を result に出さない**）
- current branch と integration branch、default base
- 既存の local branch / remote branch / worktree
- 各Issueに対応する target directory の有無
- integration worktree が dirty か（dirty なら **変更しない**）

### Step 2. profile を検出する

[references/profile-conventions.md](./references/profile-conventions.md) の signal で
`node`（Node/CommandMate）か `rust`（Rust/CommandAgent）かを判定し、検出根拠を
`profile.detection_evidence` に repository 相対 path 付きで記録する。

- `profile` 入力があればそれを優先し、検出結果と食い違えば `limitations` に記録する。
- どちらにも一致しなければ `unverified` とし、**実行前に利用者の確認を得る**。確認が
  得られなければ status `failure` で止まる（同 第3節）。動作確認済みは `node` / `rust` だけである。

### Step 3. plan を組み立てる（dry-run。ここでは作成しない）

profile から branch / directory / base ref を解決し、base ref を **resolved commit SHA** に確定する
（`profile.base_sha` と各 `plan[].base_sha`）。symbolic ref だけを base として記録しない。

各Issueについて、Issue番号 / branch / directory（repository 相対）/ base ref と base SHA /
baseline command / CommandMate sync の有無 / collision を plan に載せる。plan entry の各 field は
[references/result-contract.md](./references/result-contract.md) 3.4 が正本である。

collision を検出した対象は `plan[].blocked_by` に列挙し、`collisions` にも記録する。
plan を提示し、利用者の確認を得る。**確認前に作成へ進まない。**

### Step 4. worktree を作成する（確認後）

作成の直前に **base SHA を再確認** する（plan 後に base が動いていないか）。再確認した SHA から
branch と worktree を作成する。drift・collision・reuse・未承認 install の扱いは
[references/safety.md](./references/safety.md) 第2〜4節が正本で、要点は
「`blocked_by` が空でない entry は作らない」「reuse は `reuse_existing` の明示かつ exact match の
ときだけ」「drift した entry は作らず `limitations` に記録する」「install は明示承認時だけ」である。

### Step 5. baseline を実行する

profile 別の **proportional baseline** を、作成した worktree 内で実行し、`baseline[]` に
`outcome` と `exit_code` で記録する。**結果を丸めない。baseline が失敗しても worktree を
自動削除しない**（診断できる形で保持し、status は `partial` になる。
[references/safety.md](./references/safety.md) 第5節）。出力は redaction した短い excerpt だけを残す。

### Step 6. CommandMate sync を行う（optional）

`git worktree add` で作った worktree は CommandMate server 側の一覧に自動では載らないので、
CLI から server 側の再走査を起動し、登録された worktree ID を `commandmate_sync.worktree_id`
に記録する。CommandMate `>=0.21` の CLI には `commandmate sync` が **実在する**。

**sync を使えない環境（server 未起動、sync を持たない旧 CLI）では失敗にしない。**
`available=false` / `worktree_id=null` として記録し、worktree 作成の成否には影響させない。
ID の解決経路（`commandmate ls --json`）・推測 id の禁止・public `commandmate` を使うことは
[references/profile-conventions.md](./references/profile-conventions.md) 第5節が正本である。

### Step 7. result を組み立てる

[references/result-contract.md](./references/result-contract.md) と
[schemas/worktree-setup.result.v1.json](./schemas/worktree-setup.result.v1.json) に従って
result object を作り、`summary_markdown` に人が読む要約を同 reference 第4節の見出し構成で書く。

### Step 8. completion check を実行する

result を返す前に、`completion_check` の6件を自分で実行して記録する。6件の id と、
それぞれが何を確かめるかは
[references/result-contract.md](./references/result-contract.md) 3.11 が正本である。
いずれかが false なら status は `success` にならない。

## 5. 出力

result object 1件を返す。契約は
[references/result-contract.md](./references/result-contract.md) にある。
status は `success` / `partial` / `failure` の3値で、どの条件でどれになるか、
`limitations` / `blocking_reasons` を何件書く必要があるかは同 reference 第2節と
schema の `status` description が正本である。

`partial` を `success` に見せかけないこと。この Skill の価値は、
**作成済み / 未作成と、どこで止まったか** が後から検証できることにある。

## 6. 失敗時の動作

| 状況 | status | 動作 |
|---|---|---|
| `issue_numbers` が空・非整数 | `failure` | `input_invalid`。inspect しない |
| `profile`/`base` に path escape | `failure` | 採用せず `path_escape_rejected` |
| profile が unverified で確認が得られない | `failure` | `profile_unconfirmed`。作成しない |
| integration worktree が dirty | `failure` | `dirty_integration`。変更しない |
| collision（reuse 明示なし） | `partial`/`failure` | 当該Issueを作成せず `collisions` に記録 |
| plan 後に base が drift | 続行 | 当該entryを作成せず `limitations` に drift を記録 |
| baseline が失敗 | `partial` | worktree を保持し `baseline[].outcome=fail` |
| CommandMate sync が使えない（CLI が古い / server 未起動） | 続行 | `available=false`、失敗にしない（optional） |
| dependency install 未承認 | 続行 | install せず `limitations` に記録 |

推測で作成しないこと。確信が持てない target は作らず、plan と未解決点だけを返す。

## 7. 完了条件

result object が [references/result-contract.md](./references/result-contract.md) の契約
（status の規則、field ごとの定義、`summary_markdown` の見出し構成）と
[schemas/worktree-setup.result.v1.json](./schemas/worktree-setup.result.v1.json) に適合し、
`completion_check` の6件を実行して結果を申告したときにのみ、この Skill の実行は完了である。

## 8. 参照

- [references/profile-conventions.md](./references/profile-conventions.md) — Node/Rust profile 規約、検出、unverified、proportional baseline、CommandMate sync 経路、scope 外
- [references/result-contract.md](./references/result-contract.md) — result の各 field、status、completion check、summary の構成
- [references/safety.md](./references/safety.md) — 本体経路との棲み分け、path escape 拒否、暗黙上書き禁止、base 再確認、dependency install risk、redaction、fail closed
- [references/agent-compatibility.md](./references/agent-compatibility.md) — Agent 差異と Claude/Codex の reload・呼出方法
- [schemas/worktree-setup.result.v1.json](./schemas/worktree-setup.result.v1.json) — 機械検証用 schema
