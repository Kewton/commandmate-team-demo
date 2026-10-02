# ADR: ワーカー側の開発スキル（[#103](https://github.com/Kewton/commandmate-skills/issues/103)）

status: **accepted / 段1〜5 実装済み**（Issue [#123](https://github.com/Kewton/commandmate-skills/issues/123) / [#128](https://github.com/Kewton/commandmate-skills/issues/128)）。段6〜7 は別 Issue である。

エピック [#96](https://github.com/Kewton/commandmate-skills/issues/96) の
「ビジョンの7段のうち、**ワーカーが Issue を受け取ってから何をするか**」を埋めるための
新 package を、**どう呼び出すか**から裁定する。方法論そのものより**呼び出し口（seam）**の設計が
難しく、そこが決まる前に skill 本文を書くと作り直しになるため、本 ADR を先に置く。

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は、新 package の
`SKILL.md` と `references/`（方法論と作業規律）、および
[dispatch-contract.md](./dispatch-contract.md)（第1節の入力・第3.0節の pre-flight・第5節の停止）と
[../SKILL.md](../SKILL.md)（第2節の条件付き依存・第3.2節の flag）と
[runner-operations.md](./runner-operations.md) 第5節・
[codes-and-recovery.md](./codes-and-recovery.md)（第3節の limitation code・第4節の対処表）にある。ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に
「なぜ変えたか」を追記する**（[release-notes.md](./release-notes.md) と同じ運用）。

本文中の行番号は **main = `ced8f78` 時点**の実測値である。Issue #103 本文が引用している
`631〜665行` は **main = `c261475` 時点**の実測値であり、その時点では正しい（第8節の規律4）。

---

## 1. 現状（実測）

### 1.1 `buildContractGoal()` が渡すのは WHAT と制約だけである

`scripts/dispatch.mjs` の `buildContractGoal()`（1425〜1459行）が組み立てる `goal` は、
次の順で固定されている。

| 節 | 中身 | 由来 |
|---|---|---|
| header | `# Issue #<n> — <title>` / Repository / Base branch / Work branch / Worktree | plan の profile と issue |
| `## Objective` | `issue.objective`（planner が本文の最初の非空行から取る） | plan |
| `## Acceptance criteria` | `issue.acceptance_criteria`（無ければ「Derive from the issue; if unclear, stop and ask.」） | plan |
| `## Files you may change` | `issue.suspected_files`（無ければ「Unknown — inspect first…」） | plan |
| `## Rules` | 6項目（下記） | 生成器の固定文字列（1444〜1453行） |

`## Rules` の6項目は次のとおりである（1444〜1453行の実測）。

1. この Issue の外に出るな（他 Issue が持つ file を触るな）
2. 上の完了条件は契約のものであって提案ではない。**自分でそのコマンドを回して通せ**
3. ターンをまたいで最後までやれ。半分でやめるな
4. 完了したら work branch に **単一 commit** を作れ
5. 破壊的・曖昧・ブロックのときは **止まって訊け**
6. token / secret / 絶対 path を出すな

**この6項目に「方法」は1つも無い。** 調査せよ・計画を残せ・テストを先に書け・
自分の緑を反証せよ、に相当する指示は存在しない。渡しているのは **WHAT（目的・受入条件・境界）と
制約**であり、**HOW は渡していない**。ワーカーが何流で作るかは、ワーカー次第である。

### 1.2 ワーカーへ渡る文字列は 2 箇所で作られており、片方は別の Rules を持つ

`buildContractGoal()` は 2 箇所から呼ばれる。

- **1469行** — 契約 yaml の `goal`（`yamlBlockScalar('goal', …)`）。
- **2610行** — `contractMode ? buildContractGoal(plan, res.issue) : buildWorkerPrompt(plan, res.issue)`。

すなわち契約非対応 CLI・`--contract-mode off` のフォールバック経路では
`buildWorkerPrompt()`（1538〜1569行）が使われ、そちらの `## Rules` は **5項目で、内容が違う**
（`## Verification to run before reporting done` に profile baseline を列挙し、
「commit が完了信号である」と書く）。**方法論を渡す経路を1つだと思って設計すると、
フォールバックで黙って消える。**

生成器のコメント（1417〜1424行）は、2つが別文であることを意図として記録している。

> Deliberately NOT the same text as `buildWorkerPrompt()`: the preamble already
> states the allowed paths, the commit requirement and the completion criterion,
> and it writes that criterion out as the REAL gate commands resolved from
> verify.yaml. Repeating the profile baseline here would tell the worker to
> satisfy one thing while a different thing judges it.

**契約 `goal` は「CommandMate が自分で組む preamble のあとに送られる本文」である。**
つまり goal はもともと「preamble が言うことを二度言わない」設計であり、
**分量を足す方向の変更はこの設計方針と正面から衝突する**（第3節の案 (b)）。

### 1.3 goal の上限は 8000 字。実測の余裕は約 6.1k 字である

`MAX_CONTRACT_GOAL = 8000`（137行）。超えると **末尾を切り落として**日本語のマーカーを足す
（1456〜1458行）。切られるのは末尾、すなわち **`## Rules` から先に消える**。

実測（本リポジトリの Issue #90 / #93 / #95 / #97 / #98 / #100 / #103 の実本文を
`scripts/orchestrate.mjs` に通して plan を作り、`buildContractGoal()` の生成規則を適用して測った）:

| Issue | 受入条件 | 対象 file | goal 長 | 余裕 |
|---|---|---|---|---|
| #90 | 6 | 6 | 1910 | 6090 |
| #93 | 7 | 2 | 1595 | 6405 |
| #95 | 5 | 0 | 1421 | 6579 |
| #97 | 6 | 3 | 1670 | 6330 |
| #98 | 7 | 3 | 1750 | 6250 |
| #100 | 7 | 2 | 1625 | 6375 |
| #103 | 9 | 5 | 1784 | 6216 |

参考として、golden fixture の goal（`tests/fixtures/cmate-orchestrate/dispatch-cases/
d13-contract-verified-pass/contracts/issue-210.yaml`）は 1268 字である。

**したがって「8000 字上限を圧迫する」は、今日の実測では正しくない。** 最も長い #90 でも
6090 字空いており、2000 字程度の方法論要約は物理的に入る。案 (b) を分量だけで却下することは
できない（第3節はそう却下しない）。

ただし上限そのものは飾りではない。`## Files you may change` は `issue.suspected_files` を
**上限なしに列挙する**（1441行。`bullets()` は 1528〜1531行で、件数も長さも切らない）。
scope 側の上限は `MAX_SCOPE_PATTERNS = 200` / `MAX_SCOPE_PATTERN_LENGTH = 200`（138〜139行）
なので、200 件 × 200 字の Issue は **今日でも goal が切り詰められうる**。
そのとき最初に消えるのは `## Rules` である。方法論を goal に足すことは、
**この切り詰めが起きる閾値を、足した分だけ手前へ動かす**ことを意味する。

### 1.4 方法論は今、契約の外側に手書きされている

2026-08-07 に本リポジトリの #90〜#100 を `cmate-orchestrate` で並列開発した際、
オーケストレーターは 6 本の契約すべてに「作業ルール（厳守）」を**手書き**した
（件数は Issue #103 第「実運用で毎回書き直している」節の申告であり、契約 yaml は
`.commandmate/tasks/` として gitignore されているのでリポジトリからは検証できない。
検証できるのは、その run が生んだ PR 本文である）。内容は
「変異注入で反証する」「既存テストの期待値を書き換えない」「PR を作らない・push しない」
「manifest を再生成する」といった、**リポジトリ非依存の開発作法**である。
実際に効いたことは、その回の PR 本文が実測として残している。

- PR [#101](https://github.com/Kewton/commandmate-skills/pull/101)（#92）— 隔離 worktree で
  `lib.mjs` / manifest の**両方向**に不一致を注入し、いずれも exit 1 になることを実測した表。
- PR [#104](https://github.com/Kewton/commandmate-skills/pull/104)（#90）— 実装を `origin/main` へ
  戻すと新規ケースが **22 assertion** 落ちることを実測した表。
- PR [#102](https://github.com/Kewton/commandmate-skills/pull/102)（#100）— 文書のみの変更なので
  「変異注入は非適用」と明記したうえで、**ADR の事実主張をコードで裏取りした表**を証拠に置いた。

**これはどこにも資産化されていない。** 次回また手書きになる。手書きである限り、
Issue ごとに揺れ、書き忘れが起き、外部リポジトリでは誰も書かない。

### 1.5 スラッシュコマンドではこの穴を埋められない

CommandMate リポジトリ内では `/pm-auto-issue2dev` が HOW を供給しているが、
**スラッシュコマンドはリポジトリスコープ**である。外部リポジトリのワーカーに送ると
`Unknown command` になり、しかも `send` は exit 0 を返し `capture` にも意味のある内容が出ないので、
**supervisor から見て失敗に見えない**。`cmate-orchestrate` が「誰でも使える」ことを目指す以上、
方法論を特定リポジトリの資産に依存させることはできない。本 ADR の裁定は、
どの経路もコマンド名に依存しない（第3節）。

### 1.6 Skill の install は worktree 単位であり、dispatch はその path を持っている

CommandMate は Skill を **登録済み worktree の** `.agents/skills/<skill-id>/` と
`.claude/skills/<skill-id>/` の**両方へ byte-identical に**配備する（README。両置きは
2026-07-31 / 2026-08-02 の対照実験で load-bearing であることが確認されている）。

dispatch は `commandmate ls --json` が返す worktree の実 path を持っている
（`lookupWorktree()` 1580〜1596行。path は `safeWorktreeTarget()` で path escape を検査済み、
1594行）。既に git をその cwd で回してもいる（`worktreeHeadSha()` 1737〜1743行）。

**したがって「対象 worktree にその Skill が入っているか」は、dispatch が実測できる。**
これは #100 が `<worktree>/.commandmate/verify.yaml` を読んで gate id の実在を確かめると
決めたのと同じ経路であり（[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第3.4節）、
新しい能力を要さない。

なお `commandmate` CLI の許可された表面（`tests/fixtures/cmate-orchestrate/
commandmate-cli-contract.json`）に `skill` サブコマンドは**無い**。install の有無は
**worktree 内の file を見て**判定するしかない（第3.4節・第13節の未決事項1〜3）。

---

## 2. 裁定 0 — このスキルが足すのは「方法」であって「権限」ではない

[adr-unattended-mode.md](./adr-unattended-mode.md) 第2節と同じ形で、先に不変条件を置く。

1. **ゲートを緩めない。** 本 skill はどの検証も置き換えず、どの停止も limitation に格下げしない。
   裁定は従来どおり `commandmate wait --verify` の exit code である。
2. **権限を増やさない。** `scope.allow` を広げない。push / PR / merge の権限を持たない（第6節）。
3. **契約の外へ出ない。** 契約が禁じたことを skill が許可することはない。両者が食い違ったら
   **契約が勝つ**。skill は契約の中で「どう進めるか」だけを決める。
4. **既定では何も起きない。** 呼び出し口は明示 opt-in であり、指定しない run は 1 bit も
   変わらない（第11節）。

不変条件 3 が重要である。方法論が契約を上書きできる設計にすると、
「契約は PR を作るなと言っているが、方法論は7段目で PR を作れと言っている」という
**どちらが勝つか読み手に分からない状態**が生まれる。これは #103 が指摘した二重 PR の
問題そのものであり、第6節の裁定はここから出る。

---

## 3. 論点1 — 呼び出し口（seam）

### 3.1 選択肢と失敗様態

| | (a) goal がスキル名を参照する | (b) goal が方法論の要約を埋め込む | (c) ワーカーが自分で invoke する |
|---|---|---|---|
| runner の変更 | 参照節を1つ足す | 方法論の全文を runner が抱える | 無し |
| 正本の数 | **1つ**（skill 側） | **2つ以上**（skill と runner。しかも runner 内で 1425行と 1538行の 2 箇所） | 1つだが、参照されるとは限らない |
| 方法の更新 | skill を再リリースするだけ | **`cmate-orchestrate` の再リリースが要る** | skill を再リリースするだけ |
| goal 長への影響 | +200〜300 字（実測 1421〜1910 → 1700〜2200） | +1500〜2500 字。切り詰め閾値が同じだけ手前へ動く（第1.3節） | 0 |
| 未 install | **黙って素通りする**（何もしないのと同じ） | 起きない（install 不要） | 黙って素通りする |
| 委譲（B / E 段） | skill 側で条件付き依存として宣言でき、dispatch が実測できる | **要約は委譲先の install を検査できない**。同じ穴が1段下で再発する | skill 側で宣言できる |
| report から読めるか | 宣言・実測・契約への書き込みの3つが記録できる | 「埋め込んだ」という自己申告のみ | **何も読めない** |
| 再現性 | 全 worker に同一文字列が届く | 同左 | **worker ごとに揺れる**（並列開発の前提が崩れる） |

(c) は却下である。理由は3つ。**記録が残らない**（report から「方法論が適用されたか」が読めない、
という #103 の要求を満たせない）。**決定性が無い**（同じ plan から同じ run が出ない）。そして
[adr-unattended-mode.md](./adr-unattended-mode.md) 却下案 H と同型で、
**呼び出しが暗黙**である（何が効いたのかを後から誰も判定できない）。

### 3.2 裁定

**(a) を採る。ただし「参照するだけ」では #103 が禁じた黙った素通りが残るので、
dispatch が対象 worktree の install を実測し、実測できないときは停止する。**

呼び出し口は次の3つで構成する。

1. **明示 opt-in のフラグ** — `--worker-method <skill-id>`。既定は**指定なし**であり、
   指定しない run は従来どおり（第11節）。既定を on にするかは本 ADR の scope 外とし、
   運用実績を見て別 Issue で判断する（#93 の `--prepare-worktrees` と同じ扱い）。
2. **install の実測** — 対象 worktree の `.claude/skills/<id>/SKILL.md` /
   `.agents/skills/<id>/SKILL.md` を読み、**在ることを確かめてから** dispatch する。
   在らなければ停止する（第3.4節）。
3. **契約への書き込み** — `goal` に `## Method` 節を1つ足す（第3.3節）。
   フォールバック経路の worker prompt にも**同じ節を同じ位置に**足す
   （足さないと `--contract-mode auto` のフォールバックで方法論だけが黙って消える。第1.2節）。

**(b) を却下する理由は分量ではない**（第1.3節のとおり、分量では入る）。3つある。

1. **正本が2つになる。** 方法論の文面が runner の中にあると、skill 側の文面と必ずずれる。
   ずれたとき、worker が読むのは runner の写しであって skill ではない。
   これは `cmate-worktree-setup` の手順を dispatch が再実装しないと決めた
   [adr-worktree-preparation.md](./adr-worktree-preparation.md) 第2節と同じ判断であり、
   #100 第2.1節の「翻訳を挟まない」と同じ判断である。
2. **方法の更新に `cmate-orchestrate` の再リリースが要る。** 方法論は運用で育つものであり、
   最も頻繁に変わる。最も頻繁に変わるものを、4 runner と schema を抱える package の
   リリースサイクルに縛るのは、依存の向きが逆である。
3. **要約は委譲できない。** 本 skill の B 段（調査）と E 段（検証）は既存 skill への委譲である
   （第4.3節）。goal に埋めた要約は「`cmate-repository-analysis` を使え」と**書ける**が、
   それが install されているかは**検査できない**。#103 が「黙って劣化させるな」と言っている
   その穴が、1段下で完全に同じ形で再発する。(a) では skill 側が条件付き依存として宣言し、
   その宣言に従って dispatch が実測できる。

加えて、(b) は第1.2節の重複を悪化させる。**(a) も 2 箇所（1425行と 1538行）に同じ節を書く**が、
その節は skill 名しか含まないので **方法が変わっても runner を変えずに済む**。
(b) の重複は方法が変わるたびに 2 箇所を更新する必要があり、しかも既に文面が違う 2 つの
`## Rules` の隣に置かれるので、**ずれても誰も気づかない**。

### 3.3 goal のどこに何を書くか

`## Method` 節を **`## Objective` の直前**に置く。

```
# Issue #103 — …
Repository: … / Base branch: … / Work branch: … / Worktree: …

## Method
Follow the `cmate-worker-development` skill installed in this worktree
(.claude/skills/cmate-worker-development/SKILL.md). Read it before you start.
It defines how to go from this contract to committed, evidenced work.
If the skill is missing, STOP and report it — do not improvise a method.

## Objective
…
```

理由:

- **`# Issue #…` の行は動かさない。** `yamlBlockScalar()` は、goal が必ず非空白の見出し行で
  始まることを前提にしている（1369〜1384行のコメント: 空白で始まる第1行は明示の
  indentation indicator を要する）。先頭に節を差すとこの不変条件を壊しうる。
- **`## Rules` の中に置かない。** Rules は末尾であり、切り詰めが起きたとき最初に消える区画である
  （第1.3節）。方法論の参照が消えた契約が、消えたことを言わずに送られる。
- **`## Objective` より前に置く。** ワーカーは上から読む。目的を読んだ直後に着手されると、
  末尾の方法論は間に合わない。
- 実測: 上記の節は約 280 字であり、#90（最長 1910 字）でも goal は 2200 字程度、
  余裕は約 5800 字残る。

**節の中身に方法論の要約を書かない。** 書いた瞬間に (b) になる。書くのは
「どの skill を読むか」「どこに在るか」「無ければ止まれ」の3つだけである。

### 3.4 未 install の扱い — 停止する

**`--worker-method` を指定したのに対象 worktree に skill が無ければ、
`blocking_reasons` の `worker_method_unavailable` で停止する。** 未解決 Issue ごとに1件出し、
最初の Wave については **`--out` を作る前**の pre-flight で判定するので `--out` を消費しない
（#90 の停止形をそのまま使う）。2つ目以降の Wave は、従来どおり **その Wave の解決時**に
同じ code で止まる（#93 第2節が worktree について採ったのと同じ範囲の切り方）。

**all-or-nothing である。** install されている worker だけ方法論つきで走らせ、残りを素通りさせない。
wave の barrier は「この集合を並列に走らせる」約束の上に立っており（#93 論点2）、
方法がワーカーごとに違う wave は、**「全部通った」の意味が run ごとに変わる**。

#### `cmate-acceptance-test`（`acceptance_not_run`）ではなく `cmate-worktree-setup`
（`worktree_setup_unavailable`）と同じ側に倒す理由

#103 は「`acceptance_not_run` の型」を要求している。踏襲するのは
**「黙って劣化しない」という型**であって、「limitations に書いて続行する」という挙動ではない
——これは [adr-worktree-preparation.md](./adr-worktree-preparation.md) 第5節が既に書いている
区別であり、本 ADR も同じ結論に落ちる。

- 意味ゲートは、未導入でも **機械ゲートだけで裁定できる**。判定の質は落ちるが run は意味を持つ。
  だから続行して記録する。
- 方法論は違う。operator が `--worker-method` を指定した run は、
  **「方法が揃っていること」を前提にした run** である。揃わないまま走らせると、
  その前提が偽のまま wave が進み、しかも report には「揃っていなかった」としか書けない。
  それは #93 が「準備できなければ dispatch 対象が存在しない」と言ったのと同じ構造である
  ——方法が揃わなければ、**この run は operator が起動したかった run ではない**。
- 停止のコストが極端に低い。`commandmate skill install <id>` を打って同じコマンドを
  再実行すればよく、`--out` は消費されていない。

### 3.5 何が証明でき、何が証明できないか

dispatch が証明できるのは次の3つだけである。**これを超えて主張しない。**

| 事実 | 測り方 |
|---|---|
| 方法論つきで走ると**宣言した** | operator の `--worker-method`（`worker_method_declared`） |
| その skill が対象 worktree に**在った** | worktree 内の file の実測（`worker_method_applied`） |
| 参照が契約に**書かれた** | 生成した goal に `## Method` 節が在ること（同上） |

**「ワーカーが実際に方法論に従ったか」は dispatch から測れない。** 測れないものを測ったふりを
しない（#95 第4節が monitor の側面経路について採ったのと同じ姿勢）。遵守の証拠は
**F 段の成果物**（第7節）であり、機械で測りたいなら #100 の受入ゲート
（`require:` / `gates:`）が正しい場所である。ADR / SKILL.md にも
**「適用されたこと」と「守られたこと」は別の事実である**と明記する
——[cmate-verify SKILL.md](../../cmate-verify/SKILL.md) の
「**PASS は「宣言したゲートが通った」以上のことを意味しない**」と同じ規律である。

---

## 4. 論点2 — 導入形態

### 4.1 名称

**`cmate-worker-development`** とする（Issue #103 の名称案 `cmate-issue-to-dev` から変える）。理由:

1. `worker` は本 package で既に確立した役割語である（`worker_state` / `worker_failed` /
   `buildWorkerPrompt()` / dispatch-contract 第2.1節の「worker completion」）。
   新しい語を作らずに済む。
2. `issue-to-dev` は `/pm-auto-issue2dev` の綴りを引き写しており、
   **「あのスラッシュコマンドの移植である」と読める**。本 ADR はコマンド名に依存しないことを
   要件にしている（第1.5節）ので、名前が依存を示唆するのは避ける。
3. `cmate-issue-*` の接頭辞は上流側（`cmate-issue-authoring` / `cmate-issue-refinement`）が
   既に占めており、そちらは **Issue という文書**を扱う。本 skill が扱うのは**作業**である。

名前はディレクトリ名であり、実装前なら覆すコストがほぼゼロである。レビューで
`cmate-issue-to-dev` を採るなら、本 ADR の他の裁定は 1 つも変わらない。

### 4.2 独立 package とし、`cmate-orchestrate` からは条件付き依存として宣言する

**独立した package として出す。** 理由:

- **単独で成立する。** 入力は「Issue（または契約 goal）と制約」であって、
  `cmate-orchestrate` の plan / report ではない。オーケストレーションを使わない人が
  1 Issue を手で開発するときにも、そのまま使える。
- **リリース単位が別である。** 方法論は運用で最も頻繁に育つ。4 runner と 5 schema を抱える
  `cmate-orchestrate` に同梱すると、方法論の1行修正が runner の minor bump を引き起こす
  （#100 第5節の「リリース単位が別である」と同じ理由）。
- **catalog は package ごとの release 生成物**であり、新 package は release 経由で公開する。

そのうえで `cmate-orchestrate` の [SKILL.md](../SKILL.md) 第2節「条件付き依存の Skill」の表に
**1行追加する**。既存2行と同じ形式である。

| Skill | いつ要るか | 未導入だとどうなるか |
|---|---|---|
| `cmate-worker-development` | dispatch の **`--worker-method`** を使うとき | **停止する**（`limitations` ではなく `blocking_reasons` の `worker_method_unavailable`）。最初の Wave なら1人も dispatch せず `--out` も作らない |

### 4.3 本 skill 自身の条件付き依存（B 段 / E 段）

B（調査）と E（検証）は既存 skill への**委譲**であり、本 skill で再実装しない。
これは dispatch が `cmate-worktree-setup` に対して取っている分界（#93 第2節）と同じ型である。

| 段 | 委譲先 | 呼び出し規約 | 未導入時 |
|---|---|---|---|
| B. 調査 | [cmate-repository-analysis](../../cmate-repository-analysis/) | 入力は同 SKILL.md 第2節の名前だけ（`objective` / `roots` / `focus` / `budget`）。**呼び出し側が引数名を発明しない** | **続行して記録**。同じ6つの問いに、同じ evidence 規律（file/line を付けられない主張は書かない）で自力で答える |
| E. 検証 | [cmate-verify](../../cmate-verify/) | `verify-run.sh --cwd <worktree> [--gates …]`。判定は exit code 表（0 passed / 2 設定エラー / 20 failed / 21 not_started / 22 skipped）。**`skipped` を `passed` と読まない** | **続行して記録**。契約経路なら裁定は `wait --verify`、それも無ければ契約 / profile baseline のコマンドを実 exit code で回す |

**なぜ委譲先の未導入では停止しないのか（第3.4節との非対称）。** 本 skill が未導入なら、
「方法論つきで走る」という宣言そのものが空文になる。委譲先が未導入でも、
B / E の**問い**は消えず、劣化した形で答えられる。**失われるのは質であって存在ではない。**
劣化したことは成果物に明記する（第7節）——黙って質を落とさない。

**E 段について1つ規約を足す。** 裁定機構が2つある（契約の `wait --verify` と `verify-run.sh`）
状況では、[dispatch-contract.md](./dispatch-contract.md) 第2.7節の規約に従い、
**どちらで測ったかを必ず証拠に書く**。worker が回すのは自己検証であって裁定ではない、
という区別も併せて書く（裁定は supervisor が取る）。

---

## 5. 論点3 — 方法の可変性（TDD を強制するか）

### 裁定

**TDD（テストを先に書く）を強制しない。強制するのは順序ではなく、次の不変条件である。**

> **機械で検証できる変更については、その検証が当の変更を判定できることを、
> 「変異して赤になる」の実測で示さなければならない。**

test-first はこの実測を得る**最も安い方法**である（実装が無い時点で赤が無料で手に入る）。
だが唯一の方法ではない。後からテストを書き、**実装を戻して赤を観測する**のは同じ測定であり、
2026-08-07 の実運用はまさにそれを行った（PR #104 の「実装を `origin/main` へ戻すと 22 assertion が
落ちる」表、PR #101 の両方向注入表。第1.4節）。

したがって skill は **test-first を推奨し、赤の実測を要求する**。
これは #100 第4節の空振り防止規約を、受入ゲートからワーカーの作業一般へ**適用範囲を広げる**
ものであって、新しい規約の新設ではない（#100 第5節が生産側について採ったのと同じ言い方）。
第4節の条件のうち、ワーカーの作業に効くのは次の3つである。

1. **二点測定**（適合状態で緑・変異状態で赤の両方を実測する）。緑だけの報告は証拠にならない。
2. **赤の理由を固定する**（`RESULT failed` / exit 20 であり、失敗ゲートに当の id が名指しで
   含まれること）。exit 2 / 21 / 22 / 127 の赤は**判定に到達していない**ので証拠にならない。
3. **変異は成果物側に入れる。** ゲートやランナーを壊す変異は harness が動くことの証明であって、
   ゲートが変更を測っていることの証明ではない。

### リポジトリごとに方法を選べるようにするか

**profile には持たせない。** 3つの理由がある。

1. **profile は未知 field を拒否する。** `orchestrate.mjs` 398〜400行が
   `profile has an unknown field "<key>"` を `load_error`（exit 6）で投げる。方法を profile に足すと、
   **古い `cmate-orchestrate` は新しい profile で plan すら作れない**。方法論の宣言のために
   planner の入力互換を壊すのは、代償が釣り合わない。
2. **方法はリポジトリの属性ではない。** 同じリポジトリでも、実装 Issue と ADR のみの Issue では
   成立する方法が違う（本リポジトリの #95 / #100 / #103 がその実例）。profile は
   「対象リポジトリごとに変わる値」を持つ場所であり（[profile-contract.md](./profile-contract.md) 冒頭）、
   Issue ごとに変わるものを置く場所ではない。
3. **plan の決定性を汚さない。** plan は入力の純粋関数であることが Claude/Codex parity の根拠である
   （[plan-contract.md](./plan-contract.md) 第1節）。方法の宣言は plan を変える必要が無く、
   変えないほうが安全である。

**代わりに、方法は skill 側の既定として持ち、変更の性質から skill 自身が選ぶ。**
dispatch は方法を選ばない（選べるだけの情報を持っていない）。
リポジトリ固有の作法を上書きしたい場合は、**リポジトリの `AGENTS.md` / `CLAUDE.md` /
`CONTRIBUTING.md` が正本**である——本 skill の B 段は `cmate-repository-analysis` 経由で
それらを読む段を既に持っている（同 SKILL.md Step 2）。規約の置き場所を新設しない。

### 「テストを先に書く」が成立しない変更

**文書のみ・ADR のみの変更では、テストの不在を自己申告で済ませず、
「何がこの変更を判定しているか」を名指しする。**

規約は3つである。

1. **ゲート外を明示する。** 機械ゲートで担保されない受入条件は、消さずに「ゲート外」として
   列挙し、UAT / 人間の確認へ残す。これは [cmate-verify SKILL.md](../../cmate-verify/SKILL.md) の
   「受入条件との対応付け」（#47 / CommandMate #1678 B-5）と #100 第5節の規律であり、
   本 skill はそれを**適用する側**である。新語彙を作らない。
2. **文書変更の証拠は「主張 → 実測」の対応表である。** 本文が述べた事実主張それぞれについて、
   file:line またはコマンド出力を対置する。実例は PR #102（#100 の ADR）であり、
   `extractTestExpectations()` の実在（872行）・`dispatch.mjs` が `test_expectations` を
   一度も参照しないこと（grep 0 件）・fence 正規表現の実物を表にして示した。
   **本 ADR 自身も第1.3節でその形式を取っている。**
3. **「テストの余地が無い」は機械で示せる範囲で示す。** 変更集合が文書・生成物だけであることは
   `git diff --name-only` で示せる。示せるものを自己申告に落とさない。

---

## 6. 論点4 — PR 作成の担当

### 裁定

**本 skill は PR を作らない。push もしない。単独利用時とオーケストレーション配下で
挙動を変えない。** ビジョンの7段のうち6段目（PR 作成）は、本 skill の責務ではない。

### 理由

1. **オーケストレーション配下では二重になる。** `cmate-orchestrate` の merge runner は
   dispatch report で verification pass した Issue **だけ**を PR にする
   （[merge-contract.md](./merge-contract.md)）。ワーカーが先に PR を作ると、
   「検証を通っていないものが PR になっている」状態が生まれ、merge runner の 2 gate
   （承認 + CI）の前提が崩れる。
2. **文脈を推測して外部操作の可否を変えるのは、この package が一貫して禁じてきた形である。**
   push と PR 作成は **外部に出る**操作であり、取り消せるのはリポジトリの状態であって
   送られた通知ではない（[adr-unattended-mode.md](./adr-unattended-mode.md) 第7.1節）。
   確信の持てない破壊をしない（#93 第4節）の裏返しとして、
   **確信の持てない外部発信もしない**。
3. **文脈判定は構造的に外れる。** 「契約 yaml が在れば dispatch 配下、無ければ単独利用」は
   **偽**である。`--contract-mode off` と契約非対応 CLI のフォールバック経路では、
   dispatch 配下でも契約は存在しない（[dispatch-contract.md](./dispatch-contract.md) 第2.7節・
   [adr-unattended-mode.md](./adr-unattended-mode.md) 第1.4節）。
   最も危険な操作の可否を、**構造的に外れる推測**で決めることになる。
4. **現行契約と整合する。** goal の Rules は「単一 commit を作れ。それが作業の終わりである」
   と書いており（1449〜1451行）、PR には言及していない。skill が PR を作れば、
   契約と skill が別のことを言う（第2節の不変条件3に反する）。
5. **実運用がそれを裏づけている。** 2026-08-07 の run では、契約に「PR を作らない・push しない」を
   **手書きで**明示して二重 PR を回避した（Issue #103 第3.4節の申告。第1.4節）。
   **その手書きが不要になることが、本 skill の効果の1つである。**

### 「作らない」は「出せない」ではない

7段目（実装結果と検証証拠の提出）は**残す**。本 skill は PR に必要な素材を
**#97 の PR 本文と同じ語彙で**成果物として残す（第7節）。単独利用者は人間がそれを貼って
PR を作る。オーケストレーション配下では merge runner が自分の測定で PR 本文を作る
（`buildPrBody()` 602〜619行）ので、ワーカーの証拠は**レビュー時の突き合わせ材料**になる。

---

## 7. 論点5 — 証拠の語彙

### 裁定

**新語彙を作らない。F 段（証拠）の出力は、#97 が PR 本文で確立した節構成と
#100 が決めた由来語彙をそのまま使う。**

| 何を書くか | 語彙の出所（実装） |
|---|---|
| Verdict（`pass` / `fail` / `not_run`）と、判定が走らなかった事実 | dispatch report の `verification.outcome` / `verification.ran`。`ran: false` を pass に匂わせない（`merge.mjs` 379〜386行） |
| Gates 表 — `id` / `verdict` / `exit` の3列 | `verificationLines()`（`merge.mjs` 395〜401行） |
| Checks — 記録どおりの行と exit code | 同 415〜419行 |
| 宣言 scope と実変更の対比、out-of-scope 件数、diff 規模 | `scopeLines()`（`merge.mjs` 527〜581行） |
| gate の由来（`repo` / `issue`） | #100 第8.2節の `origin`。**欠落を `repo` と読まない**（由来未記録は第3のバケット） |
| 受入条件とゲートの対応、担保されない条件の「ゲート外」明示 | [cmate-verify SKILL.md](../../cmate-verify/SKILL.md)（#47 / CommandMate #1678 B-5）・#100 第5節 |
| 読めなかった事実 | #97 の文体（「読めなかった」を「scope 内だった」と読ませない。`merge.mjs` 531〜534行） |

規律も引き継ぐ。

- **証拠は転記であって主張ではない。** 「検証した」と書くのではなく、
  何がどの exit code で終わったかを写す。
- **打ち切ったら打ち切ったと書く**（#97 が `capped()` / `droppedNote()` で確立した形）。
- **緑の意味を広げない。** `RESULT passed` は「宣言したゲートが通った」以上を意味しない。

### schema を作らない（今は）

主成果物は **人が読む markdown** とし、機械可読 JSON の schema は**定義しない**。理由は
#100 第5節の「消費側が先である」と同じで、**今この文書を機械で読む consumer が存在しない**
からである。dispatch は worker の出力 file を読まないし、merge runner は自分で測る
（`buildPrBody()` は plan と dispatch report から作る）。消費者の居ない schema は、
守られているかを誰も測らない。

これは `cmate-repository-analysis` が取った形と同じである（同 SKILL.md 冒頭:
「主成果物は人が読む `summary_markdown` であり、構造化した result JSON は任意の副産物である」）。
#97 がワーカーの証拠を PR 本文へ転記したくなった時点で、**そのときに**形式を決める（第13節）。

---

## 8. 作業規律 — 破ると何が起きるか

Issue #103 第2節の8項目を、根拠つきで skill の正本に落とす。
「そういうものだから」ではなく、**破ると何が起きるか**を書く。

### 8.1 緑は「効いた」と「空振り」の両方と整合する

追加したテスト・ゲートは、実装を戻して **赤になることを実測**してから完了とする。

**破ると:** 何も測っていないゲートが緑を出し、`verification.outcome: pass` が
**何を測ったのか誰にも分からない緑**になる。本リポジトリの `.commandmate/verify.yaml` 冒頭が
書いているとおり **「A test nobody runs is not a gate」** であり、その裏返しとして
何を測っているか誰も知らないゲートは緑の証拠能力を持たない（#100 第2.3節）。
**実測根拠:** PR #101（#92）は両方向の不一致注入で exit 1 を確認し、
PR #104（#90）は実装を戻して 22 assertion が落ちることを確認した。
赤の理由も固定する（exit 20 かつ当該 gate が名指しで失敗。127 の赤は
**コマンドが起動できていない**のであって、ゲートが効いた証拠ではない。#100 第4節）。

### 8.2 既存テストの期待値を、実装を通すために書き換えない

落ちたらまず自分の実装を疑う。

**破ると:** 後方互換の破壊が「テストを直した」に化けて消える。
本リポジトリは既にこれを規律として明文化している——
「**既存 fixture の期待値を1つも緩めないこと。緩めなければならないなら、それは実装が
後方互換を壊した合図である**」（#93 第8節・#95 第11節の同文）。
期待値を書き換えた PR は、壊れたことを誰も知らないまま merge される。

### 8.3 「既存から赤だった」を自己申告しない

着手前に clean な base でベースラインを実測し、切り分けておく。

**破ると:** 自分が壊した赤を「元から」と報告し、10 ゲートのうち1つが恒久的に赤のまま
放置される。**実測根拠:** 本リポジトリは clean main で **12 ゲート**
（work-evidence + scope + `.commandmate/verify.yaml` の 10 ゲート）が緑であることが、
2026-08-07 の3本の PR の Verification 節で独立に実測されている。
したがって「元から赤」は原則として偽であり、主張するなら実測を添える必要がある。

### 8.4 Issue 本文の前提・行番号をコードで裏取りする。食い違ったら実測を正とする

**破ると:** 人が書いた仮説の上に実装が積まれ、ずれたまま完成する。
Issue は実装より粗く、書いた瞬間から腐り始める。

**実測根拠2件。**

1. **行番号は commit に紐づく。** Issue #103 本文は `buildContractGoal()` を
   「631〜665行（main = c261475 時点）」と書いており、**その commit では正しい**
   （`git show c261475:…/dispatch.mjs` で 631行を実測）。だが main = `ced8f78` の現在は
   **1425〜1459行**である。裏取りせずに 631行を読みに行けば、別の関数を読むことになる。
   → 行番号を書くなら **どの commit の実測か**を必ず添える（先行3 ADR はすべてそうしている:
   `15f33e0` / `c261475` / `3105722`）。
2. **Issue が知らない既存経路が在りうる。** #100 のワーカーは、Issue 本文が想定していなかった
   既存の推測抽出経路（`extractTestExpectations()`、`orchestrate.mjs` 872行）を発見し、
   「散文から推測しない」という ADR の裁定をそこに接続した（PR #102 の裏取り表）。
   発見しなければ、既に下されていた判断を知らないまま重複した機構を作っていた。

### 8.5 曖昧・破壊的・ブロックのときは推測で進めず止まる（fail-closed）

**破ると:** 誰も承認していない決定が成果物に入る。この package は同じ結論に
少なくとも3度到達している——推測ゲートは「承認した人が読んでいない条件で worker を落とす」
（#100 第2.3節）、推測 scope は「誰も承認していない書き込み権限を配る」
（#95 却下案 B / #54）、そして契約の Rules 自身が既に
「破壊的・曖昧・ブロックなら止まって訊け」と書いている（1452行）。
**ゲートが無いことは、間違ったゲートが在ることより安全である**（#100 第2.3節）。

### 8.6 スコープ外のファイルを触らない

契約の `scope.allow` は境界の宣言である。

**破ると:** 2つ起きる。(1) 契約ゲート `requireScopeClean` が不合格を返し、
**正しい実装が「不合格」として返ってくる**（`suspected_files` はそのまま `scope.allow` になる。
CommandMate #1678 B-2 の lockfile はこれで構造的に不合格だった）。
(2) 並列 wave では、他 Issue の worker と同じ file を編集して**双方の変更が壊れる**
——planner が file 衝突のある Issue を同じ wave に置かないのは、まさにこれを避けるためである。
スコープを広げたいなら、広げるのではなく **止まって訊く**（8.5）。

### 8.7 生成物は再生成コマンドで作る

digest・manifest・生成コードを手で書かない。

**破ると:** 手書きの値が実体とずれる。`scripts/validate.py` は宣言された file 集合を
**path / digest / size** で突き合わせ、`scripts/lib.mjs` の `SKILL_VERSION` が manifest の
version と食い違えば `SKILLS_VERSION_CONSTANT_MISMATCH` で hard fail する（#92）。
ずれが CI で止まればまだよく、止まらなければ**壊れた配布物が出る**——
実際 `SKILL_VERSION` は 0.13.0 のまま 0.15.0 / 0.16.0 / 0.17.0 が公開され、
report の `skill_version` が install した版と食い違っていた。
本 Issue の作業自体も同じ規律に従う: references に file を足したら
`python3 scripts/manifest_files.py skills/cmate-orchestrate` で manifest を再生成する。

### 8.8 完了の定義は「証明できる状態」であって「できたと報告すること」ではない

**破ると:** 「できた」と報告した run が下流で落ちる。この package は
**worker completion と verification success を別々の事実として報告する**設計であり
（dispatch-report schema の description・[dispatch-contract.md](./dispatch-contract.md) 第2.1節）、
両者を混ぜないことが設計の中核である。具体的には——
commit が無ければ work-evidence は exit 21（`not_started`）を返し、
コマンド系ゲートが0件なら exit 22（`skipped`）を返す。
**`skipped` を `passed` と読まない**（[cmate-verify SKILL.md](../../cmate-verify/SKILL.md)）。
判定に到達していない緑は、緑ではない。

---

## 9. 証跡（dispatch report に何を残すか）

`dispatch_schema_version` は **1 のまま**とし、**field を足さない**。理由は #93 第7節・
#95 第11節と同じである。[dispatch-contract.md](./dispatch-contract.md) 冒頭が書いているとおり、
merge runner と uat runner は dispatch report から
`worker_state === 'completed'` と `verification.outcome === 'pass'` の **2 field しか読まない**。
方法論の事実はそのどちらでもないので、report の field 集合を触る理由が無い
（触れば、何も変わっていないのに version を上げることになる）。

事実は `limitations[].code`（自由文字列。`$defs/entry` は `code` / `detail` の2 key）で運ぶ。

| 何を | どこに |
|---|---|
| 方法論つきで走ると宣言した（skill id・解決した install path の種別） | `limitations[]` の `worker_method_declared`（**run 全体で1件**） |
| skill が在り、契約に `## Method` を書いた（Issue・skill id・読めたなら version） | `limitations[]` の `worker_method_applied`（**Issue ごとに1件**） |
| 指定したのに skill が無い | `blocking_reasons[]` の `worker_method_unavailable`（**Issue ごとに1件**。`stop_reason` は `dispatch_error`、status は `failure`） |
| 人が読む要約 | `summary_markdown` の「方法論」節 |

**`stop_reason` の enum に値を足さない。** 対処が既存と同型（「install して同じコマンドを
再実行する」）だからであり、#95 第6節が unattended について採ったのと同じ判断である。

`status.mjs` の hint map（359行付近）に `worker_method_unavailable` の対処を足す。
追随できなければ「detail を読む」に落ちるだけで、停止の意味は変わらない（#93 と同じ扱い）。

---

## 10. 却下した案

| 案 | 却下理由 |
|---|---|
| **A. `buildContractGoal()` が方法論の要約を埋め込む**（#103 の案 (b)） | 第3.2節。正本が2つになり、方法の更新が `cmate-orchestrate` の再リリースを要求し、**委譲先の未 install を検査できない**（同じ穴が1段下で再発する）。分量では入る（第1.3節の実測）ので、分量は却下理由ではない |
| **B. ワーカーが自分で判断して invoke する**（#103 の案 (c)） | 第3.1節。report から「適用されたか」が読めず、worker ごとに方法が揺れる。並列開発の再現性という前提そのものを壊す |
| **C. 未 install でも limitation に記録して続行する** | 第3.4節。`--worker-method` を指定した run は「方法が揃っていること」を前提にした run であり、揃わないまま走らせるとその前提が偽のまま wave が進む。停止コストは `skill install` + 再実行（`--out` 未消費）で極めて低い |
| **D. install されている worker だけ方法論つきで走らせる（部分適用）** | wave の barrier は「この集合を並列に走らせる」約束の上に立つ（#93 論点2 / #95 却下案 C）。方法がワーカーごとに違う wave では「全部通った」の意味が run ごとに変わる |
| **E. profile に方法を持たせる** | 第5節。`orchestrate.mjs` 398〜400行が未知 field を `load_error` で拒否するため、**古い runner が新しい profile で plan すら作れなくなる**。加えて方法はリポジトリの属性ではなく変更の性質の属性である |
| **F. 方法論を `cmate-orchestrate` に同梱する** | 第4.2節。単独利用（オーケストレーションを使わない1 Issue の開発）ができなくなり、方法論の1行修正が 4 runner を抱える package の bump を引き起こす |
| **G. TDD を無条件に強制する** | 第5節。文書のみ・ADR のみの変更で成立しない（本リポジトリの #95 / #100 / #103 自身が実例）。強制すべきは順序ではなく「赤の実測」であり、実装を戻して赤を観測するのは同じ測定である |
| **H. 単独利用時だけ PR を作る** | 第6節。「契約が無い＝単独利用」は偽である（フォールバック経路では dispatch 配下でも契約が無い）。最も危険な操作の可否を構造的に外れる推測で決めることになる |
| **I. ワーカーの証拠に専用 schema を定義する** | 第7節。今この文書を機械で読む consumer が居ない。消費者の居ない schema は守られているかを誰も測らない（#100 第5節「消費側が先である」） |
| **J. スラッシュコマンド（`/pm-auto-issue2dev` 等）を契約から呼ばせる** | 第1.5節。リポジトリスコープなので外部リポジトリでは `Unknown command` になり、しかも `send` が exit 0 を返すので**失敗として観測できない**。#103 の受入条件が明示的に禁じている |
| **K. `commandmate skill status` で install を確認する** | 許可された CLI 表面（`commandmate-cli-contract.json`）に `skill` サブコマンドが無い。存在しない flag に手を伸ばした runner は contract-parity テストで落ちる（#1467 の再発防止機構）。実測は worktree 内の file で行う（第1.6節） |

---

## 11. 後方互換性

**`--worker-method` を渡さない run は 1 bit も変わらない。** これは努力目標ではなく、
実装フェーズで fixture 化する要件である（第12節 段4）。

- **契約 yaml が byte 一致する。** `d13` / `d14` / `d15` / `d16` / `d17` の golden contract
  （`contracts/issue-*.yaml`）は現行のまま。`## Method` 節はフラグを渡したときにだけ現れる。
- **フォールバック経路も変わらない。** `buildWorkerPrompt()` の出力は、フラグ無しでは現行のまま。
- **schema を変えない。** `dispatch_schema_version` は 1、field も enum 値も足さない（第9節）。
- **plan を変えない。** `plan_schema_version` も planner の出力も変わらない。
  方法は plan に載らないので、Claude/Codex parity の根拠に触れない。
- **既存 fixture の期待値を1つも緩めない。** 緩めなければならないなら、それは実装が
  後方互換を壊した合図である（#93 第8節と同じ規律。第8.2節）。
- **`cmate-orchestrate` の `version:` は、新 package の追加だけでは上げない。**
  dispatch にフラグが入る段（第12節 段3）で minor bump する。
- 新 package の catalog 公開は release 経由であり、`catalog/` を直接編集しない。

---

## 12. 実装フェーズの段取り

この ADR が承認されてから、次の順で実装する。**各段は単独でリリース可能である。**

| # | 内容 | 出荷単位 |
|---|---|---|
| 0 | 本 ADR のレビューと承認 | （この PR） |
| 1 | 新 package `skills/cmate-worker-development/` — `SKILL.md`（A〜F の6段・第4.3節の委譲・第6節の PR 非作成）と `commandmate.skill.yaml`。**`cmate-orchestrate` には一切触らない** | 新 package の初回リリース |
| 2 | 同 package の `references/` — 作業規律の正本（第8節の8項目、根拠つき）と証拠の語彙（第7節。#97 / #100 のミラーであることを明記） | 1 と同一リリース |
| 3 | dispatch: `--worker-method <skill-id>` の受理、pre-flight での install 実測、`worker_method_unavailable` の blocking、`## Method` 節の生成（**契約 goal と worker prompt の両方**）、第9節の limitation 記録 | `cmate-orchestrate` の minor bump |
| 4 | fixtures: **二点測定**（同じ plan を フラグ有り / 無し で走らせ、report で区別できること）・未 install 停止（`--out` 未消費・1人も dispatch しない）・**非回帰**（フラグ無しの golden contract が byte 一致） | 3 と同一リリース |
| 5 | docs: [../SKILL.md](../SKILL.md) 第2節の条件付き依存表・第3.2節の flag 表・第4節の limitation code 表・第5節の対処表、[dispatch-contract.md](./dispatch-contract.md) 第1節と第3.0節、`status.mjs` の hint map | 3〜4 と同一リリース |
| 6 | **後続 Issue**: #97 がワーカーの証拠 artifact を PR 本文へ転記するか。転記するなら、そのとき初めて形式を決める（第7節） | 別リリース |
| 7 | **後続 Issue**: `--worker-method` の既定を on にするか。運用実績を見て判断する | 別リリース |

段1〜2 だけで **単独利用は成立する**（外部リポジトリで `commandmate skill install` して
手で使える）。段3 以降はオーケストレーションとの結線であり、**段1〜2 を出した時点で
Issue #103 のビジョン上の穴は埋まり始める**。この順序は #100 が
「記法リファレンスを先に正本として置く」を段1 に置いたのと同じ考え方である。

---

## 13. 未決事項（実装前に実測で確定すること）

推測で実装しない。いずれも fixture か実機で確かめてから進む。

1. **install の判定条件。** `.claude/skills/<id>/` と `.agents/skills/<id>/` の**両方**を
   要求するか、片方で足りるか。README は両置きが load-bearing だと実測している一方、
   **dispatch は worker がどの Agent かを知らない**（`send` に `--agent` を渡していないことを
   grep で確認済み。`buildWorkerPrompt()` 1534行のコメントも「deliberately Agent-agnostic」と
   書いている）。片方だけ在る worktree を「入っている」と読むかを決めること。
2. **probe の対象 path。** `ls --json` が返す worktree path 配下に install されるのか、
   リポジトリ root なのかを実機で確認する。手で配置した（receipt の付かない）package でも
   同じ path に在るかも併せて確認する。
3. **version の読み取り。** `<worktree>/.claude/skills/<id>/commandmate.skill.yaml` の
   `version:` を dispatch が読んでよいか。読むなら YAML subset の parser が要る。
   **持たないなら version は記録しない**（推測で埋めない。`worker_method_applied` の detail から
   version を落とすだけで済む）。
4. **`## Method` 節を入れた goal の実長と、切り詰めの発火条件。** 第1.3節は節を入れない状態の
   実測である。`suspected_files` が多い Issue（上限は 200 件 × 200 字）で 8000 字に到達する
   閾値が、節の追加でどれだけ手前に動くかを実測する。到達しうるなら、
   **切り詰めが `## Method` を消さない**ことをどう保証するかを先に決めること。
5. **方法論の遵守を機械で測れる範囲。** #100 の `require:` で「計画文書が存在すること」を
   要求するのは可能だが、それは**成果物の存在検査**であって方法の遵守検査ではない。
   どこまでが測れてどこからが測れないかを実測で線引きし、
   測れない部分は「測っていない」と書く（第3.5節）。
6. **`--unattended`（#95）との関係。** 無人運転で方法論を必須にするか。
   #95 の不変条件1（unattended は締め付けだけを含意する）に照らせば
   「unattended は `--worker-method` を含意する」は筋が通るが、
   それは **#95 の段階 A の scope を広げる**変更なので、#95 の ADR 側で裁定する。
   本 ADR は要求可能性だけを保証する（#100 第8.1節が #95 に対して取ったのと同じ形）。
7. **B 段の委譲の呼び出し形態。** `cmate-repository-analysis` は runner を持たない
   手順スキルであり、`cmate-worktree-setup` のような launcher 注入（#93 第2節）が使えない。
   ワーカーが skill として読む形でよいか、それとも呼び出し規約を新設する必要があるかを、
   実機で1件通してから決める。

---

## 14. 段3〜5 の実測と、実装で変わった形（[#128](https://github.com/Kewton/commandmate-skills/issues/128)）

第12節の段3〜5（オーケストレーションとの結線）を実装した。本節はその記録であり、
冒頭の運用規律（「ここに書いた形が実装で変わったなら、正本を直したうえでこの文書に
『なぜ変えたか』を追記する」）に従う。**正本は
[dispatch-contract.md](./dispatch-contract.md) 第1節・第3.0.2節と
[../SKILL.md](../SKILL.md) 第2節・第3.2節・第4節・第5節にある。**

### 14.1 第13節の未決事項1〜4 の実測結果

**推測で実装しないという規律に従い、実装前に4点を測った。**
測った結果、**第13節の裁定はどれも成り立った**（実装を強行して破ったものは無い）。

#### 実測1 — install の判定条件は「**両 root**」である

第13節1が対立させていた2つの事実を、両方ともコードで裏取りした。

| 主張 | 測り方 | 結果 |
|---|---|---|
| dispatch は worker がどの Agent かを知らない | 4 runner すべてで `'--agent'` の出現数を数える | **0 件**（`dispatch` / `merge` / `uat` / `status` / `orchestrate` すべて 0） |
| 同上 | `lookupWorktree()` が `ls --json` の row から読む key | `id` / `branch` / `name` / `path` のみ。**agent を表す field は読んでいない** |
| CLI 表面には `--agent` が在る | `commandmate-cli-contract.json` の `send.flags` | `--agent` は**存在する**。使っていないのは能力の不足ではなく設計判断である |

したがって「片方だけ在る worktree を『入っている』と読む」ことはできない。読むと、
**Codex が読む root に無い契約に「この worktree の Skill を読め」と書く**ことになり、
それは dispatch が測れない主張になる（第3.5節が禁じた形そのもの）。

両方を要求する代償も測った。開発機の 21 の worktree root を走査した実測:

| 母集団 | both | 片側のみ |
|---|---|---|
| 全 (worktree, skill-id) 対 144 件 | 54 | 90 |
| うち **`cmate-*` の 45 件**（`--worker-method` が名指しする対象） | **45** | **0** |

**`commandmate skill install` が入れた package は、実測 45/45 が両置きである。**
片側のみだったのは手書きの `source-command-*` 等、catalog 外の package だけであり、
[verify-install.md](../../../docs/runbooks/verify-install.md) 第3.1節も手で置く場合は
両 root へ置けと書いている。**両方を要求しても、実在の install は1件も落ちない。**

→ **裁定: 両 root の `SKILL.md` を要求する。** 片側だけ在る場合は「無い」ではなく
「**半分ある**」と detail に書く（operator にとって別の情報である）。
fixture は `d48-worker-method-half-installed` で固定した。

#### 実測2 — probe の対象 path は「`ls --json` が返した worktree path 配下」である

同一リポジトリの sibling worktree（`BorderFreeKidsMap-develop` / `-stg` / `-issue-34`。
`git rev-parse --git-common-dir` が同じ `.git` を指す）が、**それぞれ自分の
`.claude/skills` / `.agents/skills` を持っている**ことを実測した。install は
リポジトリ単位ではなく **worktree 単位**である。

これは dispatch が既に `<worktree>/.commandmate/verify.yaml` を読む経路（#114）と同じ base で
あり、新しい能力を要さない（第1.6節の裁定どおり）。手で配置した receipt の付かない package も、
runbook の手順が `cd <worktree path>` から始まるので同じ path に在る。

#### 実測3 — version は**記録しない**

`commandmate.skill.yaml` を、dispatch が持つ唯一の YAML reader
（`readWorktreeGateIds()`。`.commandmate/verify.yaml` 用の閉じた subset parser）に
実際に食わせた。

```
readWorktreeGateIds(commandmate.skill.yaml)
  => {"ok":false,"reason":".commandmate/verify.yaml: unknown top-level key \"schema_version\""}
```

**先頭の key で拒否される。** 公開済み 12 package の manifest はすべて block scalar（`>-`）と
入れ子リストを持っており、この subset には構造的に入らない。読むには**新しい parser が要る**。

→ **裁定: 第13節3 が事前に許可したとおり、version は記録しない。**
`worker_method_applied` の detail から version を落とすだけで、他は何も変わらない。
推測で埋めない。

#### 実測4 — `## Method` は切り詰めに**到達しない**

節を入れた goal の実長を、実際の生成器（`buildContractGoal()`）に本リポジトリの
Issue 本文を通して測った（第1.3節と同じ方法。`## Method` 節は **586 字**）。

| Issue | 受入条件 | 対象 file | goal（現行） | goal（+Method） | 余裕 |
|---|---|---|---|---|---|
| #90 | 6 | 6 | 1899 | 2485 | 5515 |
| #93 | 7 | 2 | 1584 | 2170 | 5830 |
| #95 | 5 | 0 | 1410 | 1996 | 6004 |
| #97 | 6 | 3 | 1659 | 2245 | 5755 |
| #98 | 7 | 3 | 1739 | 2325 | 5675 |
| #100 | 7 | 2 | 1614 | 2200 | 5800 |
| #103 | 9 | 5 | 1773 | 2359 | 5641 |
| #128 | 10 | 4 | 2017 | 2603 | 5397 |

切り詰め（8000 字）の発火閾値は、第13節4 が懸念したとおり**手前へ動く**:

| `suspected_files` の path 長 | 現行の発火閾値 | +Method の発火閾値 | 手前へ動いた分 |
|---|---|---|---|
| 40 字 | 151 件 | 137 件 | 14 件 |
| 100 字 | 62 件 | 57 件 | 5 件 |
| 200 字（上限） | 32 件 | 29 件 | 3 件 |

**だが `## Method` 自身が切られることは無い。** 第13節4 が「切り詰めが `## Method` を
消さないことをどう保証するか」と問うたことへの答えは、**節の位置**である。
節の挿入点（`## Objective` の直前）の offset を測ると:

| 条件 | `## Objective` の offset |
|---|---|
| 典型（#90 そのまま） | 365 |
| `suspected_files` 200 件 × 200 字 | **365** |
| `acceptance_criteria` 200 件 × 200 字 | **365** |
| `objective` 5万字 | **365** |

**節より後ろに何を積んでも offset は 365 のまま**であり、切り詰めは末尾から起きるので
8000 字の境界がここに届くことはない。唯一の例外は planner が上限を持たない `title`
（5万字にすると offset は 50238 になる）だが、それは **今日でも `## Objective` 以下すべてが
消える**既存のハザードであって本変更が作ったものではなく、しかも `## Method` は
その中で**最後まで残る側**である（先頭の節なので）。

→ **裁定: 第1.3節・第3.3節の裁定はそのまま成り立つ。** 追加の保護機構は要らない。

### 14.2 実装で ADR の形から変わった点

**1点だけある。第3.3節の節の文面である。**

第3.3節の例は、参照先を `.claude/skills/cmate-worker-development/SKILL.md` の**1本だけ**
書いていた。実装は**両 path を列挙する**。理由は実測1 と同じで、`.claude` だけを書くと
**Codex の worker に、自分が読む root ではない path を指す**ことになるからである
（dispatch はどちらの Agent かを知らない）。実際に書いている節は次のとおり:

```
## Method
Follow the `cmate-worker-development` Skill installed in this worktree. Read it before you
start, and follow it for the whole task:
- .claude/skills/cmate-worker-development/SKILL.md
- .agents/skills/cmate-worker-development/SKILL.md
The two copies are byte-identical; read whichever one your agent can see.
The Skill supplies METHOD only. It does not widen the files you may change,
does not relax any gate, and does not authorise a push or a pull request.
Where the Skill and this task disagree, THIS TASK WINS.
If the Skill is not there, STOP and report it — do not improvise a method.
```

併せて、第2節の不変条件3（**契約と食い違ったら契約が勝つ**）を節自身に1行として書いた。
ADR の例には無かったが、これは新しい裁定ではなく既存の裁定を**worker に見える場所へ
持ってきた**ものである——不変条件が ADR にしか書かれていなければ、それを読むのは
実装者だけで、拘束される当人（worker）は読まない。

**それ以外は ADR のとおりである。** 呼び出し口は `--worker-method <skill-id>`（第3.2節）、
節の位置は `## Objective` の直前（第3.3節）、未 install は停止（第3.4節）、
all-or-nothing（同）、`dispatch_schema_version` は 1 のまま・`stop_reason` の enum も不変で
証跡は `limitations[].code` / `blocking_reasons[]`（第9節）、
既定では 1 bit も変わらない（第11節）。

### 14.3 何を fixture で固定したか（段4）

dispatch case を 43 → 48 に増やした。**追加した5件が空振りでないことは、変異注入で実測した。**

| case | 何を固定するか |
|---|---|
| `d44-worker-method-applied` | 適合側（緑）。契約 goal に `## Method` が入り、`worker_method_declared` が 1 件・`worker_method_applied` が 1 件・節の順序が Method → Objective → … であること |
| `d45-worker-method-absent-non-regression` | **非回帰。** 同じ plan・同じ scenario（skill は install 済み）をフラグ**無し**で走らせ、golden contract が**実装前の bytes と byte 一致**すること。golden は #128 の実装前の `dispatch.mjs` が生成したものを凍結してある |
| `d46-worker-method-fallback-prompt` | **両経路。** `--contract-mode off` のフォールバックで、節が**実際に send された message** に入っていること |
| `d47-worker-method-unavailable` | 未 install の停止。`--out` を作らず・1人も dispatch せず・`dispatch_error` / failure で止まり、**install 後に同じコマンドを再実行すると success まで通る**こと |
| `d48-worker-method-half-installed` | 実測1 の裁定。片側だけの install を「入っている」と読まないこと |

**二点測定**は d44 と d45 が担う（同じ plan・同じ scenario をフラグ有り／無しで走らせる）。
2つの golden contract の差分は `## Method` 節ちょうど 11 行であり、それ以外の byte は一致する。

変異注入の実測（それぞれ実装を戻して赤を観測し、戻した）:

| 変異 | 落ちた assertion | 落ちた case |
|---|---|---|
| `dispatch.mjs` を `origin/main` へ戻す | **52** | d44 / d45 / d46 / d47 / d48 |
| `buildWorkerPrompt()` からだけ節を外す（**片経路実装**） | **2** | d46 のみ（d44 は緑のまま＝case が第2の生成器を本当に測っている） |
| install 判定を「片方でよい」に緩める | **12** | d48 |
| 既定を on にする（flag 無しでも節を書く） | **16** | d13 / d20 / d21 / d45 ほかの golden contract |

**片経路変異が d46 だけを落とし d44 を落とさなかったこと**が、第1.2節の穴
（`--contract-mode auto` のフォールバックで方法論が黙って消える）を本当に塞いだ証拠である。

### 14.4 実装しなかったこと

- **`--worker-method` の既定 on 化**（第12節 段7）。運用実績を見て別 Issue で判断する。
- **version の記録**（実測3）。読める parser を持たないので記録しない。
- **`cmate-worker-development` 側の変更**。段1〜2 は #123 で公開済みであり、本段は
  `cmate-orchestrate` 側の結線だけを扱う。
