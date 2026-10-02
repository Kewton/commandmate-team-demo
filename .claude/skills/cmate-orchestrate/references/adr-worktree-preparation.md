# ADR: worktree 準備段の合成（[#93](https://github.com/Kewton/commandmate-skills/issues/93)）

status: **proposed**（人間のレビュー待ち。実装は本 ADR の裁定に従って同じブランチで行い、
レビューで裁定が覆ったら実装ごと差し戻す）

ロードマップ Phase 2（エピック [#96](https://github.com/Kewton/commandmate-skills/issues/96)）の
「**単一の入口**から plan → worktree 準備 → dispatch → merge → UAT を通す」ための中核である。
本 ADR は、dispatch runner が worktree 準備を**どう合成するか**の 4 論点を裁定する。

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[dispatch-contract.md](./dispatch-contract.md)（第1節の入力・第3.0節の pre-flight）と
[../SKILL.md](../SKILL.md)（第2節の条件付き依存・第3.2節の flag）と
[runner-operations.md](./runner-operations.md) 第4節・
[codes-and-recovery.md](./codes-and-recovery.md) 第4節の対処表にある。
ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に「なぜ変えたか」を追記する**
（[release-notes.md](./release-notes.md) と同じ運用）。

本文中の行番号は **main = `15f33e0` 時点**の実測値である。

---

## 1. 現状（実測）

### 1.1 dispatch は worktree を作らない。作られていなければ止まる

`scripts/dispatch.mjs` の `driftChecks()`（478〜526行）は、最初の Wave の各 Issue について
`commandmate ls --json` の branch 一致（`resolveWorktreeId()` 916〜946行）と
`git worktree list --porcelain` の path 一致で worktree の存在を確かめ、どちらでも解決できない
Issue があれば `worktrees_present` を **blocking** として落とす（523行）。
`preflightDispatch()`（548〜558行）はこれを `--out` を作る前に走らせ、
`preflightFailureReport()`（564〜585行）が未解決 Issue 1件につき1件の
`worktree_unresolved` を出して exit 1 で止まる（[#90](https://github.com/Kewton/commandmate-skills/issues/90)）。

`resolveWorktreeId()` は、`ls` が行を返したのに branch が一致しなかったときだけ
`commandmate sync` を **run 全体で1度** 実行して `ls` を読み直す
（927〜945行、[#91](https://github.com/Kewton/commandmate-skills/issues/91)）。
sync は server 側の再スキャンであって **worktree を作らない**ので、
「disk に在るが server 未登録」だけを解消する。「そもそも作られていない」はここでは解けない。

### 1.2 したがって、一気通貫の穴はここ1箇所である

plan → dispatch の間に「worktree を作る」段が人手で挟まっている。忘れると #90 で止まる。
止血としては正しい（1人も dispatch せずに止まり、`--out` も消費しない）が、
**入口が1つではない**。埋めるべき穴はこの1箇所で、それ以上ではない。

### 1.3 作る手順は既に別 Skill にある

[cmate-worktree-setup](../../cmate-worktree-setup/) が、collision 検査・base SHA の作成直前
再確認・proportional baseline・`commandmate sync`・結果の証跡化までを手順として持ち、
出力は [result-contract.md](../../cmate-worktree-setup/references/result-contract.md) と
[worktree-setup.result.v1.json](../../cmate-worktree-setup/schemas/worktree-setup.result.v1.json)
で機械検証可能な形に定義されている。

---

## 2. 論点1 — 呼び出し形態（何をどう再利用するか）

### 裁定

**dispatch は `git worktree add` 相当を自前実装しない。** 準備段は、
`cmate-worktree-setup` の手順を実行する **provider を注入して呼び出し**、その
**result contract v1 を入力として検証する**合成とする。dispatch が持つ責務は次の3つだけである。

1. **誰について呼ぶか** — pre-flight で `worktree_unresolved` になった Issue の集合。
   plan 全体でも、operator の指定でもない（決めるのは dispatch にしかできない）。
2. **結果が plan と整合するか** — 生成された branch が plan の branch と一致するか（第6節）。
3. **registry に載ったか** — `commandmate sync` → `ls --json` で解決し直し、
   解決しなければ #90 の停止に落とす。

inspect / profile 検出 / plan（dry-run）/ collision 検査 / base SHA の再確認 / 作成 /
baseline / sync（Step 1〜6）は **すべて provider 側**である。dispatch はそのどれも実装しない。

### 呼び出し規約

```
<worktree-setup launcher> --issues <n[,n...]> --profile <plan.profile.id> --base <plan.profile.base>
```

- launcher は `--cli` と同じ「実行ファイル + 固定引数」の argv であり、**シェルを経由しない**
  （`resolveLauncher()` の guard をそのまま使う。パイプ・リダイレクト・変数展開は拒否）。
- **stdout が result document**（`worktree-setup.result.v1`）である。
- **exit code は、文書が読めなかったときだけ見る。** 文書が契約に適合していれば、
  そこに書かれた `status` / `worktrees[]` が判断材料であり、exit code で上書きしない
  （「作ったが baseline が落ちた」を「何もしていない」に丸めないため）。
- 引数として渡すのは `cmate-worktree-setup` の入力契約（同 SKILL.md 第2節）にある名前だけである。
  `issue_numbers` / `profile` / `base` に対応する3つ。dispatch は branch を指定しない
  （branch は profile が決めるものであり、呼び出し側が指図するものではない）。

### 検討した案と却下理由

| 案 | 内容 | 裁定 |
|---|---|---|
| A | dispatch 内で `git worktree add` 相当を実装する | **却下。** collision 検査・base SHA 再確認・baseline は `cmate-worktree-setup` の責務であり、二重実装は片方だけが直る未来を作る。Issue #93 の方針でもある |
| B | 事前に作った result document を `--worktree-setup-result <path>` で受け取るだけ（uat の `--acceptance-dir` 型） | **単独では却下。** 「どの Issue について作る必要があるか」を判定できるのは pre-flight を持つ dispatch だけなので、事前生成では常に全 Issue 分作る（不要な collision 検査を毎回させる）か、人間が判断する（＝一気通貫でない）ことになる |
| C | provider を注入し、run 中に呼び、result contract を検証する | **採用。** B の良い部分（result contract を入力に取り、runner は検証だけする）を含み、呼ぶ対象を pre-flight の結果から決められる |

C は uat の意味ゲートと**同じ形**である: 判断（受入判定 / worktree 作成）は runner の外で行い、
runner は契約文書を検証して合成するだけで、**runner 内で手順を再実装しない**。

### 対象は pre-flight が見た集合（＝最初の Wave）だけである

pre-flight が解決するのは **最初の Wave の Issue** だけなので（#90）、準備段の対象もそこに限る。
Issue #93 の要件が「pre-flight で `worktree_unresolved` になった Issue について」と書いている
とおりであり、それ以上に広げない。

- 2つ目以降の Wave の worktree が無い場合は、従来どおり **その Wave の解決時**に
  `worktree_unresolved` で止まる（既存 fixture d28 の窓）。準備段はそこを塞がない。
- 広げなかった理由は2つある。走らない可能性のある Wave のために worktree を先に作るのは、
  最も情報が少ない時点で最も多くを mutate することであり、Wave 1 が失敗すれば作った分は
  全部無駄になる。そして pre-flight が Wave 0 に限られているのは #90 の裁定そのもの
  （後の Wave の worktree は後から作られてよい）であって、本 ADR で覆すものではない。
- 実運用で足りないと分かったら広げる（第9節）。

---

## 3. 論点2 — 部分成功（3件中1件だけ作成に失敗したとき）

### 裁定

**all-or-nothing。成功した分だけを dispatch しない。** ただし**作れた分は消さない**（第4節）。

準備段を経てなお解決できない Issue が残った場合、dispatch は **#90 の停止に落ちる**:
`worktree_unresolved` を未解決 Issue ごとに1件出し、`--out` を作らずに exit 1 で止まる。
準備段が作れた分は `worktree_prepared` として証跡に残り、作れなかった分は
`worktree_setup_partial` に列挙される。

### 理由

1. **plan の wave 構造は「この集合を並列に走らせる」という約束である。** 部分集合を dispatch
   すると、barrier（全 worker 完了かつ verification pass で次 wave）が、そもそも全員が
   入っていない wave に対して判定される。「全部通った」の意味が run ごとに変わる。
2. **#90 と一貫させる。** worktree が無い Issue は「worker が失敗した」ではなく
   「worker が起動していない」である。準備段があってもこの区別は変わらない。
3. **経路を増やさない。** 実装上も、準備後に pre-flight を**もう一度**走らせるだけでよく、
   停止の語彙・report の形・`--out` 未消費の再実行性は #90 のまま変わらない。
   準備段のために新しい停止形を作らないこと自体が、この裁定の価値である。
4. **再実行は前進する。** 作れた分は残っているので、再実行時の provider 呼び出しは
   残りの Issue についてだけ行われる（pre-flight が解決済みを未解決集合に入れない）。

「1件でも作れたなら走らせたい」は運用として理解できるが、それは **plan を分ける**ことで
表明すべきである（走らせたい集合が変わったのだから plan も変わる）。runner が黙って
対象集合を縮めてよい、にはしない。

---

## 4. 論点3 — 失敗時の後始末（作ってしまった worktree を消すか）

### 裁定

**dispatch は worktree を削除しない。作ったものは残す。** cleanup の owner は
**human / operator** であり、手段は [cmate-worktree-cleanup](../../cmate-worktree-cleanup/) である。
この owner と手段を `next_actions` 相当（summary の「未解決と next action」）に明示する。

### 理由

1. **provider 自身がそう決めている。** `cmate-worktree-setup` は baseline が失敗しても
   worktree を自動削除せず、診断できる形で保持する
   （[safety.md](../../cmate-worktree-setup/references/safety.md) 第5節）。
   呼び出し側がそれを消すのは、呼び出し先の裁定を無効化することである。
2. **破壊は別 Skill の責務である。** worktree/branch の削除は
   `cmate-worktree-cleanup` の scope であり、dispatch の宣言権限で最も危険な操作を、
   最も情報が少ない状況（準備が中途半端に失敗した直後）で自動実行する理由がない。
3. **誰が作ったかを dispatch は知らない。** 同名の worktree が既にあった場合、それを作ったのが
   今回の provider か、人間か、以前の run かを result document だけからは断定できない
   （`reused` は provider が `reuse_existing` を明示されたときだけ立つ）。
   **確信の持てない破壊をしない**は、この package 全体の規則である。
4. **残っていることが再実行の前進性になる**（第3節の理由4）。

「消さないと next run が collision する」は起きない: collision 検査は provider 側にあり、
再実行時に未解決でなくなった Issue はそもそも provider に渡らない。

---

## 5. 論点4 — `cmate-worktree-setup` 未導入時の振る舞い

### 裁定

**`blocking_reasons` で停止する（`limitations` ではない）。** code は
`worktree_setup_unavailable`。`--prepare-worktrees` を指定したのに provider を呼べない
（`--worktree-setup` が無い / 実行できない）ときの停止であり、
**黙って #90 の fail-fast に戻ることもしない**（指定した準備段が実行されなかった事実を隠さない）。

停止は pre-flight の中で起きるので、`--out` は消費されない。

### `cmate-acceptance-test`（`acceptance_not_run`）との違い

uat の意味ゲートは、未導入でも **機械ゲート（baseline）だけで裁定できる**。判定の質は落ちるが、
run は意味を持って続く。だから `limitations` に劣化を記録して続行する。

worktree 準備は違う。**準備できなければ dispatch 対象が存在しない。** 続行しても全 Issue が
「worker を起動できないまま failed」になるだけで、続行に意味がない。#90 が
「continue しても助からない唯一の形」として blocking を選んだのと同じ理由である。

踏襲するのは「**黙って劣化しない**」という型であって、「limitations に書いて続行する」という
挙動ではない。型を踏襲した結果が、こちらでは停止になる。

### 既定は off

`--prepare-worktrees` の既定は **off** であり、指定しなければ #90 の fail-fast のままである
（後方互換）。既定を on にするかは**本 ADR の scope 外**とし、運用実績を見て別 Issue で判断する。
off のときは provider を**一度も呼ばない**（副作用のある段を、頼まれてもいないのに実行しない）。

---

## 6. profile の同一性を何で機械検査するか

`cmate-worktree-setup` と dispatch には**同じ profile**を渡す必要がある。両者の
`branch_template` がずれると、生成される branch がずれ、`commandmate ls` の branch 一致で
解決できないからである。これを次の2つで機械検査する。

1. **二重指定の拒否（入力時）。** `--worktree-setup` の argv に `--profile` / `--profile-json` /
   `--base` / `--repo` / `--issues` / `--issue-numbers` が含まれていたら `invalid_input` で拒否する。
   profile / base / 対象 Issue は **plan が正本**であり、準備段に別の値を渡す経路を作らない。
2. **branch での照合（結果時）。** result document の `worktrees[].branch` が plan の当該 Issue の
   `branch` と一致しなければ `worktree_profile_mismatch` で停止する。

**`branch_template` の文字列そのものでは照合しない。** placeholder の綴りは両 skill で
標準化されていない（plan は `feature/issue-{number}-{slug}`、worktree-setup 側は profile 規約に
従う）ので、文字列比較は**同じ branch を作る 2 つの template を不一致と誤判定する**。
照合すべきは規約ではなく**生成物**である。template は証跡として記録するだけにする。

---

## 7. 証跡（report に何を残すか）

`dispatch_schema_version` は **1 のまま**とし、**field を足さない**。理由は
[dispatch-contract.md](./dispatch-contract.md) 冒頭と同じで、merge / uat は dispatch report の
version を厳密に見るため、準備段のためだけに version を上げると、
`worker_state` / `verification.outcome` が何も変わっていないのに両 runner が読めなくなる。

したがって準備段の事実は、#91 の `worktree_sync_ran` と同じ経路で運ぶ。

| 何を | どこに |
|---|---|
| provider を呼んだ事実（対象 Issue・status・phase_reached・skill_version） | `limitations[]` の `worktree_setup_ran` |
| 何を作ったか（Issue・branch・base SHA・baseline 合否と exit code） | `limitations[]` の `worktree_prepared`（**Issue ごとに1件**） |
| 要求したのに作られなかった Issue | `limitations[]` の `worktree_setup_partial` |
| 呼べなかった / 失敗した / profile 不一致 | `blocking_reasons[]`（`worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch`） |
| 構造化した準備結果 | `<out>/worktree-setup/prepared.json`（**転記であって passthrough ではない**。値は redact 済み） |
| 人が読む要約 | `summary_markdown` の「worktree 準備」節 |

`prepared.json` は準備段が成功して run が進んだときにだけ書かれる（停止したときは `--out` を
作らないという #90 の約束が優先する）。停止したときの証跡は `limitations` / `blocking_reasons` /
`summary_markdown` に残る。

---

## 8. 影響しないと決めたこと

- **既定の挙動は変えない。** `--prepare-worktrees` なしの run は #90 / #91 のままである
  （d27 / d28 / d29 / d30 の期待値を1つも緩めない。緩めなければならないなら、それは実装が
  後方互換を壊した合図である）。
- **plan runner・merge runner・uat runner・status runner を変えない。** 準備段は dispatch の
  pre-flight の中で完結する。
- **schema を変えない**（第7節）。
- **`cmate-worktree-setup` package を変えない。** 呼び出し規約（第2節）は dispatch 側の契約
  文書に書く。provider がその規約を満たすかは provider の責任である。

## 9. 見直す条件

- `--prepare-worktrees` の既定を on にするか — 運用実績を見て**別 Issue**で判断する。
- 2つ目以降の Wave まで準備段を広げるか — 「Wave 1 は通ったのに Wave 2 で worktree が無くて
  止まった」が実運用で繰り返し出るなら、pre-flight の対象範囲（#90 の裁定）ごと再検討する。
  そのときは「plan 全 Issue 分を先に作る」の mutation 量が正当化できるかが論点になる。
- provider の呼び出し規約（第2節）を CommandMate 本体の経路（`/worktree-setup` 相当）に
  寄せるか — 本体側にコマンドラインの入口ができたときに、この ADR に追記して見直す。
- 部分成功で走らせたい要求が実運用で繰り返し出るか — 出たなら「plan を分ける」で足りるのか、
  runner の裁定として必要なのかを、その事例とともに再検討する（第3節の裁定を覆すのは
  本 ADR への追記による）。
