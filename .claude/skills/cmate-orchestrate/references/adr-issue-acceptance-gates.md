# ADR: Issue 受入条件の機械ゲート化（[#100](https://github.com/Kewton/commandmate-skills/issues/100)）

status: **accepted / 段 1〜6 実装済み**（Issue [#114](https://github.com/Kewton/commandmate-skills/issues/114)）。
**段階 2（`gates:` ＝新規コマンドゲート）も実装済み**（Issue
[#125](https://github.com/Kewton/commandmate-skills/issues/125)）—— ただし本書 第 3.5 節が
前提していた「worktree の `.commandmate/verify.yaml` に追記する」経路**ではない**。
何がどう変わったかは**第 3.5.1 節**を先に読むこと。生産側のミラーは未着手で、別 Issue である。

**記法の正本は [acceptance-gates-notation.md](./acceptance-gates-notation.md) に移った。**
本書は裁定の記録として読むこと。実装前に測った未決事項の結果は第 11 節、
実装で本書と形が変わった点とその理由は第 12 節にある。

ビジョンは Issue を「何をもって完了とするのか・どのように検証するのか」まで含む
**実行可能な開発契約**と定義する。本 ADR は、その「どのように検証するのか」を
Issue 本文から実行契約の機械ゲートまで運ぶための 4 論点を裁定する。

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[dispatch-contract.md](./dispatch-contract.md)（契約生成）・[plan-contract.md](./plan-contract.md)（plan）と、
実装フェーズで新設する記法リファレンスに置く。ここに書いた形が実装で変わったなら、
**正本を直したうえでこの文書に「なぜ変えたか」を追記する**（[release-notes.md](./release-notes.md) と同じ運用）。

本文中の行番号は **main = c261475 時点**のものであり、実測して書いている。

---

## 1. 現状（実測）

### 1.1 受入条件は契約に載っている。誰も測っていない

`scripts/dispatch.mjs` の `buildContractGoal()`（631〜665行）は、plan の
`acceptance_criteria` を契約 `goal` の `## Acceptance criteria` 節にそのまま書き出す
（643〜644行）。さらに `## Rules` に次を書く（651〜653行）。

> The completion criterion above is the contract's, not a suggestion: run those
> commands yourself and make them pass before reporting done. Do not report done
> on a failing gate — **the same gates decide the verdict.**

**この最後の一文が成り立っていない。** 裁定を下すのは `commandmate wait --verify` の
exit code であり、それが走らせるのは契約の `verify.gates`（省略時は対象リポジトリの
`verify.yaml` の全ゲート）である。直前に引用した受入条件とは**別のもの**である。
契約は受入条件と裁定ゲートの同一性を宣言しているが、生成器はその同一性を作っていない。

worker から見ると、指示（散文の受入条件）と裁定（repo 共通ゲート）が食い違う。
[dispatch-contract.md](./dispatch-contract.md) 第 2.1 節が
「worker completion と verification success は別物」を守っているのと同じ厳密さで、
**「repo 共通ゲートが緑」と「この Issue が完成した」も別物**である。今それを分けているものは無い。

### 1.2 `verify.gates` は operator の run 単位フラグでしか動かない

契約 yaml を作るのは `buildTaskContract()`（668〜709行）である。検証に関して運ぶのは
`verify.gates` だけで、しかも書かれるのは `inputs.verifyGates.length > 0` のとき、
すなわち operator が `--verify-gates` を渡したときだけである（688〜692行）。
省略時の挙動と理由は生成器のコメントが既に記録している（684〜687行）。

> `verify` is omitted unless the operator named gates: this runner cannot know
> a repository's verify.yaml, and an id that does not exist there makes
> `send --contract` exit 2. Omitting the key means "run every declared gate",
> which is the stricter reading, never the looser one.

`inputs` は起動時に 1 回だけ解析される（313行 `resolveVerifyGates`）ので、
`--verify-gates` は **run 全体に 1 つ**である。`buildTaskContract` は全 Issue に同じ
`inputs` を渡すため、**Issue ごとに違うゲート集合を指定する方法が存在しない**。
Issue 固有の受入条件を今の機構で表現しようとすると、run 内の全 Issue に同じ条件が付く。

### 1.3 コマンドの推測抽出は既に在り、意図的に advisory である

planner は Issue 本文から検証コマンドらしきものを既に抜いている。
`extractTestExpectations()`（`scripts/orchestrate.mjs` 872〜889行）は、backtick と code fence の
中身のうち先頭語が既知 binary（汎用集合 + profile baseline の先頭語）であるものを集める。
結果は plan の `issues[].test_expectations` に載り（1424行）、worker prompt にも載る（1582行）。

**そして契約には載らない。** `test_expectations` を読むのは planner と prompt だけで、
`dispatch.mjs` はこの field を一度も参照しない。つまり「散文からコマンドを推測する経路」は
既に実装されており、**裁定に使わないという判断が既に下されている**。本 ADR はその判断を
覆さず、明文化して境界を引く（第 2.3 節）。

### 1.4 意味的な判定は UAT まで遅延し、しかも任意である

受入条件の意味的な充足を判定するのは UAT の二層裁定のうち意味ゲート
（[uat-contract.md](./uat-contract.md) 第 4 節）であり、その入力は `cmate-acceptance-test` が
出す `acceptance-result.v1` document である。この Skill は **cmate-orchestrate の install に
含まれない**（別途 install）。未導入なら `--acceptance-dir` を渡せず、裁定は機械ゲート
（＝ repo 共通ゲート）だけになる。

さらに UAT は **merge の後**に走る（dispatch → merge → uat）。したがって現状、
「受入条件を満たしているか」の最初の問いは、任意 install の Skill が導入されている場合に限り、
**納品後**に発される。

### 1.5 planner は受入条件の不在だけは検出する

`analyzeIssue()`（930〜935行）は、受入条件の抽出結果が 0 件なら open question
`no_acceptance_criteria` を立て、`warnings` に積んで run を `partial` に落とす（Issue #52）。
**在るか無いかは既に機械が見ている。中身が機械で測れるかは誰も見ていない。**
本 ADR が埋めるのはこの差である。

---

## 2. 裁定 1 — 機械可読な受入条件の記法

### 2.1 ブロックの形

Issue 本文に、info string が `acceptance-gates` の fenced code block を **1 つだけ**置く。

````markdown
```acceptance-gates
version: 1
require:
  - verify-selftest
  - orchestrate-fixtures
gates:
  - id: adr-present
    command: "test -f skills/cmate-orchestrate/references/adr-issue-acceptance-gates.md"
    timeoutSec: 120
```
````

- `require:` — **verify.yaml に実在する gate id** の列挙。「この Issue では必ずこのゲートが
  判定に参加すること」を宣言する。
- `gates:` — **新規コマンドの宣言**。`.commandmate/verify.yaml` の gate entry と
  **同じ key・同じ型・同じ制約**で書く（第 3 節。段階 2 で有効化する）。

> **2026-08-15 注（#125）: 上の例の `id: adr-present` は現行の記法に適合しない。**
> 定義ゲートの id は `issue-<Issue 番号>-<何を測るか>` でなければならない（第 12.5 節）。
> 現行の例は [acceptance-gates-notation.md](./acceptance-gates-notation.md) 第 6 節に在る。

payload を verify.yaml の subset そのものにしたのは、翻訳を挟まないためである。
記法から verify.yaml への変換が「再エンコード」になった瞬間、
**「Issue が書いた条件」と「実際に走ったコマンド」がずれる余地**が生まれる。
コピーであれば、ずれは構造的に存在しない。

### 2.2 規則

| 規則 | 内容 |
|---|---|
| 個数 | 本文中にちょうど 0 個か 1 個。**2 個以上は syntax error**（マージも先勝ちもしない） |
| `version` | 必須・先頭 key・値は `1`。未知の version は syntax error（前方互換に丸めない） |
| 構文 | `.commandmate/verify.yaml` と同じ YAML subset（2 スペース固定・1 行スカラーのみ・anchor / flow / 複数行文字列を拒否・行頭 `#` のみコメント）。**best-effort 解釈をしない** |
| gate id | `^[a-z0-9][a-z0-9-]{0,31}$`（`dispatch.mjs` 140行 `GATE_ID_RE` と同一）。`require` と `gates[].id` を合わせて最大 32 件（同 139行 `MAX_GATE_IDS`）。重複は error |
| 期待 exit code | **0 に固定する。宣言しない。** |
| 空ブロック | `require` も `gates` も空なら syntax error（`verify.gates: []` を契約エラーとする本体規則と同型） |

**期待 exit code を固定したのは、Issue #100 本文の例（「コマンド＋期待 exit code」）に対する
意識的な逸脱である。** 理由は 2 つ。

1. verify.yaml のゲートは定義上「exit 0 が pass」であり、ランナーは `sh -c "$cmd"` の `$?` を
   直接読む（[cmate-verify SKILL.md](../../cmate-verify/SKILL.md)）。非 0 を期待値にすると、
   記法から verify.yaml への変換にラッパが要る。**そのラッパこそが偽ゲートの生まれる場所**で
   ある（`cmd; test $? -eq 1` は、binary 不在の 127 も、シグナル死の 137 も、期待外の 1 も、
   等しく飲み込みうる）。第 2.1 節の「翻訳を挟まない」に反する。
2. 「非 0 で終わること」を要求する受入条件は、`! cmd` あるいは `test "$(cmd)" = ...` として
   **exit 0 が正である形に書き直せる**。書き直しは Issue 著者が行い、レビュアーが読む。
   ラッパを生成器が黙って足すよりも、条件が読める形になる。

将来 `expectExit` が必要になった場合の追加は additive だが、**その際はラッパの意味論
（何を pass とし、126/127/128+n をどう扱うか）を同じ文書に固定してから**入れること。

### 2.3 なぜ散文から推測生成しないのか

**明示ブロックに書かれた条件だけを契約へ運ぶ。散文・箇条書き・表からは何も生成しない（fail-closed）。**
根拠は 4 つあり、いずれもこのリポジトリで実際に起きたことに紐付く。

1. **引用は指示ではない。** バグ報告は「今これが落ちる」コマンドを backtick で書く。
   そこから生成したゲートは、**バグが残っている間だけ緑になる**。同じ category error は
   この package で既に一度起きている: path 候補の抽出が引用と指示を区別せず、根拠として
   挙げただけの path が worker の `scope.allow`（書き込み権限）になっていた（Issue #54）。
   位置と明示マークだけが意図を決められる、というのがそのときの結論である。
2. **推測経路は既に在り、既に advisory と決まっている。** 第 1.3 節の
   `extractTestExpectations()` がそれである。しかもこの抽出の binary 集合は
   **対象 profile の baseline 先頭語を含む**（[issue-body-contract.md](../../cmate-issue-authoring/references/issue-body-contract.md)
   第 2.5 節）。すなわち **同じ Issue 本文が、profile を変えるだけで別のコマンド集合を生む**。
   裁定の根拠が Issue の外側の設定に依存することになり、plan の決定性の前提と両立しない。
3. **planner は決定的でなければならない。** plan は入力の純粋関数であり、Claude と Codex で
   byte 一致することが Claude/Codex parity の根拠である（[plan-contract.md](./plan-contract.md) 第 1 節）。
   散文→コマンドの意味的変換を LLM に行わせれば純粋関数ではなくなり、正規表現に行わせれば
   それは (2) である。**どちらも裁定の生成源にできない。**
4. **推測ゲートは誰にも承認されていない。** plan は人間が承認してから dispatch する。
   明示ブロックは Issue 著者が書きレビュアーが読むので、Issue の承認がゲートの承認になる。
   推測ゲートは、承認した人が読んでいない条件で worker を落とす（あるいは落とさない）。

**ゲートが無いことは、間違ったゲートが在ることより安全である。** 受入条件が機械化されて
いない Issue は、従来どおり repo 共通ゲートで判定され、機械化されていない事実が report に
残る（第 7 節）。一方、推測ゲートが緑になったときの `verification.outcome: pass` は、
何を測ったのか誰にも分からない緑である。このリポジトリの `.commandmate/verify.yaml` 冒頭が
書いているとおり、**「A test nobody runs is not a gate」** であり、その裏返しとして
**何を測っているか誰も知らないゲートは、緑の証拠能力を持たない**。

### 2.4 記法違反の扱い（fail-closed）

**「ブロックが無い」と「ブロックが壊れている」を絶対に混ぜない。**

| 状態 | 扱い |
|---|---|
| ブロックが 0 個 | **従来挙動**。受入ゲートは載らない（第 7 節） |
| ブロックが 1 個・構文 OK | 契約へ運ぶ |
| ブロックが 2 個以上 / 構文違反 / 未知 version / id 不正 | planner が open question + warning `acceptance_gate_block_invalid`。**推測で復旧しない** |
| `require:` の id が worktree の verify.yaml に無い | dispatch が `acceptance_gate_id_unknown` で当該 Issue を dispatch しない（第 3.4 節） |

構文違反を「ブロックが無かったこと」に丸めると、**書いたはずの受入条件が黙って消えた run**が
緑で終わる。planner の `unrecognized_file_extension`（Issue #43）と同じ結論である:
黙って捨てない。

---

## 3. 裁定 2 — ゲートの実行場所

### 3.1 選択肢

- **(a)** worktree の `.commandmate/verify.yaml` へ追記し、既存の検証機構にそのまま乗せる。
- **(b)** CommandMate 本体に per-issue gate 機能（契約 yaml が gate 定義そのものを運ぶ）を
  提案し、cross-repo 依存として待つ。

| 観点 | (a) verify.yaml 追記 | (b) 本体の per-issue gate |
|---|---|---|
| 出荷可能性 | 本 repo 単独で出せる | 上流のリリースを待つ。待つ間は機能ゼロ |
| 2 実装の一致 | `commandmate verify` と `cmate-verify` の `verify-run.sh` の**両方が同じ file を読む** | `verify-run.sh` は契約を読まない。**Issue 固有ゲートは片方の judge にしか見えない** |
| 契約 schema | 変更不要 | 閉じた key 集合に新 key ＝ 契約 v2。全 consumer が追随 |
| 人間の再現性 | worktree で `verify-run.sh --gates <id>` を叩けば同じ判定が出る | 契約を送った server の中でしか走らない |
| 旧 version での劣化 | 起きない | **契約非対応 CLI では Issue 固有ゲートが消える**（version gate は `--contract`/`--verify` の有無しか見ていない） |
| worktree の mutation | **在る**（第 3.5 節の前提条件） | 無い |
| scope / work-evidence との干渉 | **在る**（第 3.5 節） | 無い |

(b) の利点は本物である。worktree を一切汚さず、scope 判定とも干渉せず、per-issue の timeout
予算も本体側で持てる。

### 3.2 裁定

**(a) を採る。ただし段階を切り、段階 1 だけを本 Issue の実装範囲とする。**

決め手は「2 実装の一致」である。[cmate-verify SKILL.md](../../cmate-verify/SKILL.md) が既に
裁定を書いている:

> **このランナーは実行契約を読まない。**〔…〕**両方のランナーで効かせたい要求は verify.yaml に書く**。
> それが 2 実装が共に読む唯一のファイルである。

(b) は「契約にしか存在しないゲート」を作る。すると、worker が自己検証に `cmate-verify` を
使えば緑、契約の judge は赤、という状態が構造的に生まれる。しかもその差は
「どちらのランナーで測ったか」に依存するので、report を見ても原因が分からない。
このリポジトリは、裁定機構が 2 つあるときは**どちらを使ったか必ず report に書く**という
規約で凌いできた（[dispatch-contract.md](./dispatch-contract.md) 第 2.7 節）が、
(b) は 2 つの機構が**違うゲート集合**を持つという、その規約では表現できない差を作る。

副次的な理由として、移行の非対称性がある。上流が独立に per-issue gate を出荷した場合、
(a) から (b) への移行は **記法を変えずに配置だけを変える**変更で済む。逆向き（(b) を待って
何も出さない → やはり (a) にする）は、待った期間がまるごと損失になる。

### 3.3 段階 1 — `require:` のみ（本 Issue の実装範囲）

`require:` は verify.yaml に**実在する** gate id を選ぶだけなので、**worktree を一切変更しない**。
cross-repo 依存も無い。これだけで、第 1.1 節の乖離のうち最も多い部分
（「この Issue では最低限このゲートが判定に参加しなければならない」）が機械化される。

「実在するゲートを選ぶだけなら repo 共通ゲートと同じでは」という問いには、
report の観点で答えが出る: `require:` された gate は **Issue が名指しした**ゲートであり、
repo 共通集合にたまたま含まれていたゲートではない。この由来の差が #97 の PR 証拠で
「repo 共通ゲート」と「Issue 固有ゲート」を分ける根拠になる（第 8.2 節）。

### 3.4 契約への書き出し規則 — **絞り込みを禁ずる**

ここが最も間違えやすい。`buildTaskContract()` の 684〜687行が記録しているとおり、
**`verify` key の省略は「全ゲートを走らせる」であり、明示は「そのゲートだけを走らせる」である。**
したがって `require: [adr-present]` を素朴に `verify.gates: [adr-present]` と書き出すと、
lint も test も走らない契約になる。**受入条件を足したつもりで、判定が弱くなる。**

裁定:

| operator の `--verify-gates` | Issue の `require:` | 契約の `verify` |
|---|---|---|
| 無し | 無し | **key を書かない**（現状どおり＝全ゲート） |
| 無し | 有り | **key を書かない**。全ゲートに `require` の id は必ず含まれる |
| 有り | 無し | operator の列挙（現状どおり） |
| 有り | 有り | **和集合**（sort + 重複除去） |

`require` が単独で `verify.gates` を作らないのは、それが「走る全ゲート」ではなく
「**必ず走らなければならないゲート**」の宣言だからである。和集合を採るのは、
operator の絞り込みが Issue 固有の要求を落とすことを許さないためであり、
「緩い側ではなく厳しい側の既定」という既存規則の延長である。

**id の実在確認は planner ではなく dispatch が行う。** planner は対象リポジトリの
worktree を持たない（read-only の分析器であり、`verify.yaml` を読まない）。dispatch は
`ls` で解決した実 worktree path を持つ（[dispatch-contract.md](./dispatch-contract.md) 第 2 節）ので、
`<worktree>/.commandmate/verify.yaml` を読んで id を突き合わせられる。解決できない id が
あれば **`send` する前に**当該 Issue の dispatch を拒否し、`acceptance_gate_id_unknown` を
limitation に記録する。`send --contract` の exit 2 に頼らないのは、
`contract_scope_unknown` と同じ理由である: 走っていない worker を「契約が不正だった」と
報告するより、**何が足りないかを名指しして止める**ほうが解ける。

### 3.5 段階 2 — 新規コマンドゲートの前提条件

> **2026-08-15 追記（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）: 本節の前提は
> 4 つのうち 3 つが消滅し、1 つは別の形で解決した。** 以下の原文は当時の裁定として残す。
> **何がどうなったかは第 3.5.1 節を読むこと。** 一行で言えば、`gates:` は
> **`.commandmate/verify.yaml` に 1 バイトも書かずに**実装され、その経路は本節が前提していた
> 「追記する」という設計そのものを不要にした。

`gates:`（新規コマンド）を有効化するには、dispatch が worktree の `.commandmate/verify.yaml`
に追記する必要がある。**着手前に次を解決すること。解決前に実装しない。**

1. **追記を commit してはならない。** commit すると Issue 固有ゲートが PR に載り、
   merge されて repo 共通ゲート集合に恒久的に積み上がる。50 Issue 後の verify.yaml は
   50 個の死んだゲートを毎回走らせることになり、#97 が分けようとしている
   「repo 共通 / Issue 固有」の境界が main 上で溶ける。
2. **未 commit の追記が scope / work-evidence の計数から除外される必要がある。**
   現状の除外は `.commandmate/tasks/` **だけ**であり（#1580。同 第 2.4 節）、
   `.commandmate/verify.yaml` は含まれない。除外が無いと `success.requireScopeClean: true`
   が **orchestrator 自身が書いた変更で worker を落とす**。
3. **`.commandmate/verify.yaml` を `scope.allow` に入れる回避は却下する。**
   それは worker に「自分を裁くゲート定義への書き込み権限」を渡すことである。
   **自分の judge を編集できる worker は、裁かれていない。** 空 scope が
   「worktree 内の何を書いても clean」を意味していた Issue #50 と同じ穴を、
   今度は judge 側に開けることになる。
4. **除外は監視の穴でもある。** (2) が実現すると、worker が verify.yaml を書き換えても
   scope 判定に出なくなる。したがって dispatch は、書き出した追記の SHA-256 と、
   裁定取得後のファイルの SHA-256 を突き合わせ、不一致なら limitation
   `acceptance_gates_tampered` を記録して **その裁定を pass として扱わない**。
   これは runner 側だけで実装でき、上流変更を要さない。

(2) は上流への依頼になるが、**既にある除外を 1 path 拡張する**依頼であって、
(b) が要求する「契約 schema の新 key ＋ gate 実行機構 ＋ report 配線」より小さく、
動機も既存（#1580）と同一である。

**実測で確定すべき未決事項**（第 10 節にも再掲）: CommandMate の scope 判定の基準点が
「task 開始時 SHA」なのか「merge-base」なのか。前者なら dispatch 前に追記を置くだけで
(2) は不要になる。**推測で実装しないこと。**

#### 3.5.1 その後どうなったか（#125 / 上流 CommandMate #1791）

上の見積もり「(2) は既にある除外を 1 path 拡張するだけ」は**誤りだった**。上流のソースに
理由が書かれていた（`src/lib/verification/scope-gate.ts` の doc comment、2026-08-08 に確認）:

> Dropping it is tamper-safe because the contract is snapshotted into `tasks.contract_json`
> at send time, so editing the file afterwards cannot change what the run is judged against.
> **`.commandmate/verify.yaml` has no such snapshot — the gates are re-read from the file on
> every run — so it stays in the change set, where a contract's explicit `deny` can still catch
> an agent weakening its own gates.**

つまり `.commandmate/verify.yaml` が work-evidence の変更集合に残っているのは**仕様であり、
検出面である**。除外を広げると、第 4 項がわざわざ足そうとしていた
`acceptance_gates_tampered` 相当の監視を、上流が既に持っている形で壊すことになる。
「1 path 広げるだけ」の依頼は、実際には snapshot 機構の新設を要求していた。

そこで上流に設計相談として [#1756](https://github.com/Kewton/CommandMate/issues/1756) を起こし、
**案 B（実行契約がゲート定義そのものを運ぶ）**が採られた
（[#1791](https://github.com/Kewton/CommandMate/issues/1791) / PR #1793、develop へ着地）。
契約 v1 の `verify` に `gateDefinitions`（`{id, command, timeoutSec}` の list、最大 32 件）が入り、
検証ランは **verify.yaml のゲート集合と契約の定義をマージ**して走らせる
（`docs/design/task-contract.md` 第2.3.1節・第6節）。契約は送信時に `tasks.contract_json` へ
snapshot され、`.commandmate/tasks/**` は変更集合から除外済みなので、**新しい改竄面が増えない**。

前提表の読み替え:

| 当時の前提 | 現在 |
|---|---|
| (1) 追記を commit してはならない | **消滅。** verify.yaml に追記しないので commit する対象が無い |
| (2) 未 commit の追記が scope / work-evidence から除外される必要がある | **消滅（scope 側）／別解決（work-evidence 側）。** 除外は 1 バイトも広げず、追記自体をやめた。`.commandmate/verify.yaml` 単独変更が work-evidence を通す挙動は**意図的に残っている**（上記の doc comment）ので、直さない |
| (3) `verify.yaml` を `scope.allow` に入れる回避は却下 | **裁定は生きている。** allow に入れない。#125 の実装は worker に verify.yaml への書き込み権限を渡さないし、runner 自身も書かない |
| (4) 追記の SHA-256 を裁定後に突き合わせ `acceptance_gates_tampered` | **原則として消滅。** 判定に使う定義は契約 snapshot 側に在り、ファイルを書かないので突き合わせる対象が無い。`acceptance_gates_tampered` は**実装しなかった**。「worker が verify.yaml を書き換えて既存ゲートを弱める」経路は残るが、それが**検出可能であること**が上流の設計意図であり、塞ぐのは本 Issue の仕事ではない |

第 10 節 (1) / 第 11.1〜11.2 節の実測は**取り消していない**。merge-base 基準であることも、
未 commit の `.commandmate/verify.yaml` が `uncommitted` に計上されることも、今も真である。
変わったのは「だから追記経路は採れない」という結論の使い道であり、
**その測定こそが上流 #1756 を起こす根拠になった**。

新しい経路で残った規律は 2 つだけである。

- **id は Issue に紐付ける**（`issue-<番号>-<何を測るか>`）。planner が確かめ、書き換えない。
  第 (1) 項が案じた「repo 共通ゲート集合への蓄積」は、契約が運ぶようになった時点で
  構造的に起きなくなったが、**誰かが手で verify.yaml に足す**経路は残る。id が Issue 番号を
  名乗っていれば、それが起きたときに読める。
- **衝突は runner が先に止める。** 定義 id が verify.yaml の既存 id または予約 id
  （`work-evidence` / `scope` / `env-clean`）と衝突すると上流は送信時 exit 2 で拒否する。
  planner（予約 id・記法）と dispatch（worktree の既存 id）が**その手前で**名指しして止める ——
  `acceptance_gate_id_unknown` と同じ理由で、走っていない worker を「契約が不正だった」と
  報告するより解ける。

### 3.6 失敗様態の対比

| 失敗 | (a) での見え方 | (b) での見え方 |
|---|---|---|
| gate id の打ち間違い | dispatch が `send` 前に名指しで停止（第 3.4 節） | 契約 exit 2、または本体側の未知 gate 扱い |
| 旧 CommandMate | `require` は効く（verify.yaml は本体 version に依存しない） | **Issue 固有ゲートが黙って消える** |
| 記法違反 | planner が open question（第 2.4 節） | 同左 |
| worker が judge を書き換えた | `acceptance_gates_tampered`（第 3.5 節 (4)） | 起きない（(b) の唯一の明確な優位） |

---

## 4. 裁定 3 — 空振り防止の検証規約

**緑の確認は、ゲートが効いたことの証拠にならない。** 緑は「条件を満たした」と
「ゲートが何も測らなかった」を区別しない。この package が `skipped` を `passed` と読むことを
禁じ（[cmate-verify SKILL.md](../../cmate-verify/SKILL.md)）、exit 99 を pass に丸めることを
禁じている（[dispatch-contract.md](./dispatch-contract.md) 第 2.6 節）のと同じ理由である。

受入ゲートの fixture は、次の 6 条を**すべて**満たさなければならない。1 つでも欠けた
fixture は「ゲートが効いている証拠」として採用しない。

1. **二点測定。** 同一の記法ブロックについて、**適合状態で緑**・**変異状態で赤**の
   2 つの run を assert する。緑だけの fixture は不可。
2. **変異は成果物側に入れる。** 削除・差し戻し・条件を破る変更を **judge 対象**に加える。
   ゲート定義やランナーを壊す変異（既存の
   [`tests/fixtures/cmate-verify/README.md`](../../../tests/fixtures/cmate-verify/README.md)
   の「変異による健全性確認」）は harness が動くことの証明であって、
   **ゲートが受入条件を測っていることの証明ではない**。両方要るが、後者が本条の対象である。
3. **赤の理由を固定する。** 変異 run は「何かで赤」では不可。
   **exit 20（判定して不合格）** であり、かつ失敗ゲート集合に **当該 gate id が名指しで含まれる**
   ことを assert する。exit 21 / 99 / 124 / 2 での赤は、**ゲートが判定に到達していない**ので
   証拠にならない（同 第 2.1 節の exit code 表）。コマンドを打ち間違えた偽ゲートは
   127 で赤くなる — 二点測定だけならこれを「効いている」と誤読する。
4. **起動不能を証拠に数えない。** ゲートのコマンドが存在しない場合の fixture を別に置き、
   赤になることと、report がその事実を名指しすることを assert する。この case は
   **条 (1) の変異 run として流用してはならない**。
5. **契約に載った id が実在することの fixture。** `require:` が verify.yaml に無い id を
   指す Issue は、`send` に到達せず `acceptance_gate_id_unknown` で止まること。
   段階 2 では `acceptance_gates_tampered` の fixture も同じ枠で要る。
6. **非回帰。** ブロックを持たない Issue の契約が、現行 golden と **byte 一致**すること
   （第 7 節）。

補助規約: **緑 run と赤 run で `verification.gates` の中身が同一なら、転記が壊れている。**
その状態は `verification_gates_unrecorded`（Issue #83）と同じく、
「拾えなかったこと自体」を記録して黙って通さない。

---

## 5. 裁定 4 — 記法の生産側の範囲

`cmate-issue-authoring`（Issue を書いて登録する）と `cmate-issue-refinement`（既存 Issue を
精錬して節を提案する）が、同じ記法で受入条件を出力するようにする。

**裁定: 本 Issue には含めない。後続 Issue に切る。ただし次の 2 点は本 ADR で先に決める。**

理由:

1. **消費側が先である。** `cmate-issue-authoring` の
   [`references/issue-body-contract.md`](../../cmate-issue-authoring/references/issue-body-contract.md)
   は「planner が実際に何を読むかを**実測して**決めた」型であり、planner の抽出定数を
   **byte 単位でミラー**し（`scripts/validate-plan.mjs`）、
   `tests/fixtures/cmate-issue-authoring/run_tests.sh` が両者の一致を機械で固定している。
   実装されていない記法を先にミラーすることは、この package の規律
   （「planner 側の抽出が変われば、この文書と validator の写しも**同じ commit で**変える」）の
   反転であり、ミラーが仕様を先取りした瞬間に一致テストの意味が失われる。
2. **リリース単位が別である。** 3 package を 1 PR で動かすと version bump が 3 つ同時に走る。
   catalog は package ごとの release 生成物であり、消費側が出てから生産側を出すほうが
   小さく安全に出せる。

先に決めておくこと:

- **記法の正本は `cmate-orchestrate` に置く**（実装フェーズで `references/` に新設する記法
  リファレンス）。生産側 2 package はそれを**ミラーする側**であり、記法を独自に拡張しない。
  ミラー義務は `FILE_EXT` と同じ形で果たす: 生産側の validator に
  `acceptance_gate_block_valid` 相当の rule を持たせ、conformance テストで両実装を突き合わせる。
- **推測禁止は生産側にも適用する。** refinement / authoring が、散文の受入条件から
  コマンドを**発明して**ブロックに書くことを禁ずる。禁止を消費側だけに置くと、
  「planner は推測しないが、Issue を書く Skill が推測して書き込む」という迂回で
  第 2.3 節が空文化する。ゲートに落とせない条件は、**ゲート外として明示**し
  UAT / 人間の確認に残す — これは `cmate-verify` の
  「受入条件との対応付け（ゲートで担保されないものを明示する）」（Issue #47 /
  CommandMate #1678 B-5）と同じ規律であり、新設ではなく適用範囲の拡大である。
- 2 package の役割分担は既存境界のまま: **refinement はブロックを節として提案する**
  （GitHub には書かない）、**authoring は登録する本文にブロックを含める**。

---

## 6. 却下した案

| 案 | 却下理由 |
|---|---|
| **A. 散文からの推測生成**（LLM または正規表現） | 第 2.3 節。引用と指示を区別できない／planner の決定性を壊す／誰も承認していないゲートを作る |
| **B. `test_expectations` をそのまま `verify.gates` に昇格** | A の正規表現版そのもの。加えて抽出の binary 集合が **profile の baseline 先頭語に依存**するため、同じ Issue 本文が profile を変えるだけで別ゲート集合を生む。裁定の根拠が Issue の外に漏れる |
| **C. 受入条件は UAT の意味ゲートに一本化する** | 任意 install であり、判定が **merge の後**に来る（第 1.4 節）。#97 の PR 証拠にも載らない。加えて agent 判定は決定的でない。**併存**が正しい: 機械化できる条件は契約ゲートへ、できない条件は UAT へ |
| **D. 契約の `goal` に受入条件を書くだけ（＝現状）** | 既に `buildContractGoal` が行っており（643〜644行）、それが第 1.1 節の乖離そのものである |
| **E. operator が `--verify-gates` を Issue ごとに指定する** | 不可能。`--verify-gates` は run 単位に 1 つで（313行）、全 Issue の契約に同じ列挙が載る（688〜692行） |
| **F. 受入ゲートを plan.json ではなく run directory の sibling artifact に置く**（`--acceptance-dir` 型） | plan_schema_version を上げずに済むが、**人間が承認する文書にゲートが載らない**。契約は「承認済み plan **だけ**から決定的に生成する」（第 2.4 節）のが規律であり、承認外の入力を契約生成に足すことはその規律を崩す |
| **G. gate の由来を id の命名規約（`issue-100-*` 等）で表す** | 規約は強制できない。#97 の PR 本文が id の文字列解析に依存することになり、規約を守らない 1 件で表示が崩れる。由来は field で持つ（第 8.2 節） |

---

## 7. 後方互換性

**機械可読ブロックを持たない Issue は、従来どおり repo 共通ゲートだけで動く。**
これは努力目標ではなく、第 4 節 (6) で fixture 化する要件である。

- ブロック 0 個の Issue から生成される契約は、現行の golden と **byte 一致**する
  （`verify` key は書かれない）。
- `--verify-gates` の既存の意味は変わらない。Issue 側の宣言はそれを**狭めない**（第 3.4 節）。
- 記法違反は「ブロック無し」に丸めない（第 2.4 節）。丸めると、書いたはずの受入条件が
  黙って消えた run が緑で終わる。

`plan.issues[]` に受入ゲートを載せるには **`plan_schema_version` を 2 に上げる**必要がある
（[plan-contract.md](./plan-contract.md) 第 9 節: field の追加は version を上げる）。
plan を読む 3 runner はいずれも**厳密等価**で 1 を要求している
（`dispatch.mjs` 74 / 348行・`merge.mjs` 54 / 182行・`uat.mjs` 92 / 300行）ので、
3 runner は同一リリースで動く。旧 version の cmate-orchestrate は v2 plan を
`plan_invalid` で拒否する — これは **fail-closed であり許容する**。
optional field として黙って無視される設計より安全である（受入ゲートを載せた plan が、
ゲートを読まない runner で「載っていない」ものとして dispatch される事故が起きない）。

---

## 8. 隣接 Issue との関係

### 8.1 [#95](https://github.com/Kewton/commandmate-skills/issues/95)（unattended）— 本 ADR は前提条件である

**無人運転の安全性は、機械ゲートの充実度にそのまま比例する。** 承認つき運転では、
「repo 共通ゲートは緑だが、この Issue が求めたものは出来ていない」を人間が捕まえる。
unattended はその人間を外す運転モードなので、**残る判別器はゲート集合だけ**になる。
本 ADR が実装されていない状態の unattended は、「lint と test が通った」を
「Issue が完成した」と読み替えて merge まで進む機構である。

#95 の ADR へ引き渡す具体項目:

- unattended を有効化できる条件として **「対象 Issue が受入ゲートブロックを持つこと」を
  要求できる**（要求するか否かは #95 の裁定であり、本 ADR は要求可能性だけを保証する）。
- #95 が列挙する「unattended でも必ず停止する human_required 相当」に、本 ADR の
  fail-closed 停止を**追加する**: `acceptance_gate_block_invalid`（記法違反）・
  `acceptance_gate_id_unknown`（宣言したゲートが存在しない）・
  段階 2 では `acceptance_gates_tampered`（judge が書き換えられた）。
  いずれも**再 dispatch では解けない**ので、exit 99 と同じ扱いになる。

### 8.2 [#97](https://github.com/Kewton/commandmate-skills/issues/97)（PR への証拠提出）— report 語彙で接続する

#97 は dispatch report の `verification.gates` / `checks` を PR 本文へ転記する。
そこで **repo 共通ゲートと Issue 固有ゲートが区別できなければならない**。
区別できないと、PR の Verification 節は「10 個のゲートが緑」としか言えず、
**そのうち何個がこの Issue のために走ったのか**が読めない。これは #100 が閉じようとしている
「動いた」と「完成した」の混同を、証拠の側で再生産する。

現状の schema は `verification.gates[]` が `{id, verdict}` の 2 field で
`additionalProperties: false` なので、**由来を表現できない**。

裁定: **`origin` を optional field として追加する。値は `repo` / `issue`。**

- optional field の追加は additive であり、`dispatch_schema_version` は **1 のまま**、
  Skill の `version` を上げる（[dispatch-contract.md](./dispatch-contract.md) 第 7 節）。
- **`origin` の欠落を `repo` と読まない。** 欠落は「由来が記録されていない」であり、
  #97 の PR 本文は第 3 のバケット（由来未記録）として描く。
  未記録を既定値に丸めるのは、この package が `not_run` を pass にも fail にも
  丸めないのと同じ理由である。

---

## 9. 実装フェーズの段取り

この ADR が承認されてから、次の順で実装する。**各段は単独でリリース可能である。**

| # | 内容 | 出荷単位 |
|---|---|---|
| 0 | 本 ADR のレビューと承認 | （この PR） |
| 1 | 記法リファレンスを `references/` に新設し、**正本**とする | docs のみ |
| 2 | planner: ブロックの parse（**構文のみ**）・`plan.issues[].acceptance_gates`・`plan_schema_version: 2`・記法違反の open question / warning。3 runner の version pin を同時に上げる | minor bump |
| 3 | dispatch: worktree の verify.yaml 読解・`require` id の解決・`send` 前の拒否・第 3.4 節の和集合規則で `verify.gates` を書き出し | 2 と同一リリース（plan v2 のため） |
| 4 | report: `verification.gates[].origin` の記録（#97 と語彙を合わせる） | additive |
| 5 | fixtures: 第 4 節の 6 条をすべて満たす case 群（緑・変異で赤・記法違反・id 不在・非回帰・起動不能） | 2〜4 と同一リリース |
| 6 | docs: `SKILL.md`・[dispatch-contract.md](./dispatch-contract.md)・[plan-contract.md](./plan-contract.md) を改版し、本 ADR からリンクする | 同上 |
| 7 | **後続 Issue**: 生産側（`cmate-issue-authoring` / `cmate-issue-refinement`）の記法ミラーと conformance テスト（第 5 節） | 別 package・別リリース |
| 8 | **段階 2（別 Issue）**: `gates:`（新規コマンド）。第 3.5 節の前提条件（1)〜(4) と第 10 節の実測が済んでから着手する | 別リリース |

段 2〜6 が「本 Issue の実装スコープ」であり、Issue #100 本文の実装スコープ 1〜4 に対応する。
`gates:`（新規コマンド）は **本 Issue に含めない** — 第 3.5 節の未決事項を残したまま
worktree を mutate する実装を出すと、`requireScopeClean` が orchestrator 自身の書き込みで
worker を落とす形で表面化する。

---

## 10. 未決事項（実装前に実測で確定すること）

推測で実装しない。いずれも fixture か実機で確かめてから進む。

1. **CommandMate の scope 判定の基準点**（task 開始時 SHA か merge-base か）。
   前者なら第 3.5 節 (2) の上流依頼が不要になる。
2. **`.commandmate/verify.yaml` の未 commit 変更が work-evidence の計数に入るか。**
   入るなら、契約を置いただけの worktree が「作業済み」に見え、exit 21 が意味を失う
   （#1580 が `.commandmate/tasks/` で解いたのと同じ問題）。
3. **fence 抽出との干渉。** `extractTestExpectations()` の fence 正規表現は
   ``/```[a-zA-Z]*\n([\s\S]*?)```/g``（`orchestrate.mjs` 877行）である。
   `acceptance-gates` はハイフンを含むので開始 fence には一致しないが、
   **本ブロックの終了 fence が後続 fence の開始として拾われうる**。
   `acceptance-gates` ブロックと `bash` ブロックを併せ持つ本文で
   `test_expectations` が変化しないことを fixture で固定すること。
4. **`GATE <id> PASS|FAIL` 行に由来が出るか。** 出ないなら `origin` は
   dispatch 側が「自分が契約に書いた id か」で決めるしかない（決定的に決まるので実装可能だが、
   `require` されていないが verify.yaml に在るゲートは `repo` になる — その扱いを固定すること）。

---

## 11. Phase 0 の実測結果（Issue [#114](https://github.com/Kewton/commandmate-skills/issues/114)）

第 10 節の未決事項 4 点を、実装に入る前に測った。測定環境: **CommandMate 0.22.0**
（`/opt/homebrew/lib/node_modules/commandmate`。gate-runner と verify-config は
`.next/server/chunks/` の bundle を読み、git 側は実リポジトリで同じコマンド列を再現した）。

**結論: 段階 1（`require:` のみ）の裁定は 4 点とも成り立つ。** 段階 2 を本 Issue から
外した判断も、(2) の実測によって裏付けられた。

### 11.1 (1) scope 判定の基準点 — **merge-base**。ただし `.commandmate/` は元から除外

scope ゲートは

```
git merge-base <baseRef> HEAD                       → base
git diff --name-only -z --no-renames <base> HEAD    ∪  git status --porcelain -z --untracked-files=all
```

の和集合を判定対象にする。**基準点は task 開始時 SHA ではなく merge-base である。**
したがって「dispatch 前に追記を置くだけ」では第 3.5 節 (2) の問題は回避できない。

一方で、違反判定そのものが次の形をしている（`ScopeMatcher.isViolation`）:

```
deny にマッチ → 違反
それ以外 → path が ".commandmate/" で始まらず、契約 path でもなく、allow にマッチしないとき違反
```

**`.commandmate/` 配下は `deny:` に書かれない限り scope 違反にならない。**
よって `.commandmate/verify.yaml` への追記が scope ゲートで worker を落とすことはない。
第 3.5 節 (2) は scope と work-evidence を一括りにしていたが、**両者の扱いは違う**。
上流依頼が要るのは work-evidence 側だけである。

> **2026-08-15 追記（#125）: 本節の測定は取り消していない。今も真である。**
> 変わったのは 11.2 の結論の使い道だけで、「だから段階 2 は上流の除外拡張を待つ」ではなく
> 「だから **verify.yaml を書かない経路**を上流に作ってもらう」になった（第 3.5.1 節）。
> 11.1 / 11.3 / 11.4 は結論もそのまま生きている。

### 11.2 (2) work-evidence の計数 — **`.commandmate/verify.yaml` は計上される**

work-evidence ゲートの除外は `.commandmate/tasks/` **だけ**である。

```
commits      = git rev-list --count <merge-base>..HEAD -- :(top) :(exclude,top).commandmate/tasks/
uncommitted  = git status --porcelain -z --untracked-files=all のエントリのうち、
               「全 path が .commandmate/tasks/ 配下」でないものの件数
```

実測（新規 repo・作業ゼロの worktree に契約と verify.yaml だけを置いた状態）:

```
mergeBase=0aa6b16…
commits (tasks 除外)      → 0
status --porcelain        → ?? .commandmate/tasks/issue-1.yaml
                             ?? .commandmate/verify.yaml
計上される uncommitted     → 1  （.commandmate/verify.yaml）
```

**第 3.5 節 (2) の懸念はそのまま成立する。** 契約を置いただけの worktree が `uncommitted=1` に
なり、exit 21（NOT_STARTED）が「worker は何もしていない」を意味しなくなる。
`gates:` を本 Issue から外した判断は妥当であり、着手前に上流の除外拡張が要る。

> **2026-08-15 追記（#125）: 「上流の除外拡張」は要らなくなった —— 要らなくなったのであって、
> 実現したのではない。** 除外は 1 バイトも広がっていない。上の測定が示した挙動は今も同じで、
> それが**意図された検出面**であることが後で分かった（第 3.5.1 節）。段階 2 は
> verify.yaml を書かない経路（契約の `verify.gateDefinitions`）で実装され、
> **本節が測った問題に触れずに済ませた**。
>
> なお、CommandMate **0.22.1** で取り直した再実測（2026-08-08、Issue #125 のコメント）でも
> 結論は同じだった: 除外は `.commandmate/tasks/` だけで、commit 側の `:(exclude,top)` pathspec と
> 未 commit 側の判定の**両方**がそうなっている。

### 11.3 (3) fence 抽出との干渉 — **実在する。strip で解消**

`extractTestExpectations()` の fence 正規表現 ``/```[a-zA-Z]*\n([\s\S]*?)```/g`` に対し、
`acceptance-gates` ブロック → 空行 → ```` ```bash ```` ブロックの本文で測った:

| 本文 | `test_expectations` |
|---|---|
| ブロック無し | `["pytest -q", "python3 scripts/validate.py", "node tests/…/run_tests.mjs"]` |
| ブロック有り | `["pytest -q"]` |
| ブロックを strip | ブロック無しと **byte 一致** |

原因は第 10 節 (3) の推測どおり: 開始 fence には一致しないが、**本ブロックの終了 fence が
後続 fence の開始として拾われ**、`bash` ブロックを丸ごと飲み込む。

対処は「ブロックを取り除いた本文を散文抽出に渡す」。同じ strip を
`extractAcceptanceCriteria` / `extractFileCandidates` / topic token にも適用した —
ブロック内の `  - verify-selftest` が受入条件の箇条書きや path 候補として読まれるのは、
Issue #54（位置と明示マークだけが意図を決める）を裏返しにした同じ category error である。
fixture: `cases/28-acceptance-gates-block`（ブロック有無の双子で全 field を突き合わせる）。

### 11.4 (4) `GATE` 行の由来 — **出ない。dispatch 側で決める**

`verify-runner` の `formatGateLine` が印字するのは

```
GATE <id> <LABEL>            … detail が空のとき
GATE <id> <LABEL> (<detail>) … detail は exit=/経過秒、work-evidence だけ commits=/uncommitted=
```

だけで、**由来は含まれない**。よって `origin` は読み取れない。第 10 節 (4) の代替どおり
dispatch が「自分が契約に運んだ id か」で決める。固定した扱い:

- `require` された id → `issue`
- verify.yaml に在るが `require` されていない id → `repo`
- 記録が無い（旧 runner / fallback baseline 経路）→ **field 欠落**。`repo` に丸めない

---

## 12. 実装で変えたこと（Issue #114。第 9 節 段 1〜6）

本 ADR の運用規約に従い、実装で形が変わった点と理由を記録する。正本は
[acceptance-gates-notation.md](./acceptance-gates-notation.md)（記法）・
[plan-contract.md](./plan-contract.md)（plan）・[dispatch-contract.md](./dispatch-contract.md)（契約）である。

### 12.1 `plan_schema_version` は **1 のまま**（第 7 節からの逸脱）

第 7 節は「`plan.issues[]` に受入ゲートを載せるには `plan_schema_version` を 2 に上げる」と
裁定していた。**この実装では 1 のままとし、`acceptance_gates` を closed schema の required
field として追加した。**

理由は実装の scope 制約である。plan を読むランナーは ADR が数えた 3 つ（dispatch / merge / uat）
ではなく **4 つ**で、`status.mjs` も `plan_schema_version === 1` を厳密等価で要求している
（実測）。version を 2 に上げるには 4 runner の pin を同時に上げる必要があるが、本 Issue の
実行契約は `orchestrate.mjs` と `dispatch.mjs` の 2 本しか変更を許していない。
merge / uat / status を触ると scope ゲートに落ち、触らなければ 46 件の既存 fixture が
`plan_invalid` で赤になる。

**残る差分と、それが何を意味するか:**

- 意図した fail-closed（v2 plan を旧 runner が `plan_invalid` で拒否する）が効かない。
  受入ゲートを載せた plan を **0.18.0 以前の dispatch** が読むと、ゲートは黙って無視される。
- 本リリース内では問題にならない（plan を作る runner と読む runner が同一版で出荷される）。
  危険なのは **版をまたいだ plan の再利用**だけである。

**後続作業（別 Issue / 統合時）:** 4 runner の pin と `PLAN_SCHEMA_VERSION` を同一 commit で 2 に
上げる。差分は 5 行で、fixture の追随は不要（plan は毎回生成される）。

### 12.2 `gates:` は「無視」ではなく **停止**（#114）→ **実装**（#125）

第 2.1 節は `gates:` を記法に含め「段階 2 で有効化する」とだけ書いていた。planner が
これを受理して dispatch が実行しないと、**宣言された条件が黙って消えた緑の run** になる —
第 2.4 節がまさに禁じている状態である。そこで新コード `acceptance_gate_block_unsupported` を
足し、open question + warning で停止させる。第 8.1 節の human_required 相当リストに、
`acceptance_gate_block_invalid` / `acceptance_gate_id_unknown` と並べてこれも加えること。

> **2026-08-15 追記（#125）: この停止は解除した。** planner はブロックを読み、dispatch が
> 定義を契約の `verify.gateDefinitions` に載せる（第 3.5.1 節）。
> **`acceptance_gate_block_unsupported` は planner からは出なくなった** ——
> 記法違反は `acceptance_gate_block_invalid` に一本化され、
> worktree の既存 id との衝突だけが新しい code `acceptance_gate_id_conflict`（dispatch）になる。
> 停止そのものを取り消したのではないことに注意する: 読めない `gates:` ブロックは今も止まるし、
> 契約の無い run で `gates:` を宣言した Issue も `acceptance_gates_not_enforceable` で止まる
> （第 12.3 節はそのまま `gates:` にも適用される）。変わったのは
> 「読めているのに強制できない」という状態が**無くなった**ことだけである。
>
> なお生産側 2 package（`cmate-issue-authoring` / `cmate-issue-refinement`）は
> **まだ `acceptance_gate_block_unsupported` を出す**。第 5 節の裁定どおりミラーは後続 Issue で、
> 「自分が出せない記法を出さない」という producer 側の判断としては今も正しい。
> conformance テストがこの 1 件の乖離を明示的に固定している。

### 12.3 実行契約が無い run の扱い（ADR に無かった穴）

`--contract-mode off`、あるいは契約非対応 CLI で fallback した run には `verify.gates` も
`wait --verify` も無く、裁定は profile baseline の再実行になる。**そこに gate id を伝える口が無い。**
本 ADR はこの組み合わせを裁定していなかった。fail-closed の一貫した読みとして、
`require:` を宣言した Issue はこの経路では **dispatch しない**（`acceptance_gates_not_enforceable`）。
`contract_scope_unknown` と同じ形である: 境界（ここでは裁定条件）が宣言できないなら、
その Issue に対しては何も走らせない。

### 12.4 `env-clean` は `require` できない

`require` の解決集合を CommandMate 自身の契約検証と同一にした結果
（`{work-evidence, scope} ∪ verify.yaml の宣言 id`）、built-in ゲートのうち `env-clean` だけは
`require` できない。上流の契約パーサがその id を `verify.gates` に受け付けないためであり、
受理して `send --contract` の exit 2 に落とすより、`send` 前に名指しで止めるほうが解ける。

### 12.5 `gates:` の id は Issue 番号に紐付ける（#125）

第 2.1 節の例は `id: adr-present` と書いていた。実装では
**`issue-<Issue 番号>-<何を測るか>` を要求する**（planner が確かめ、書き換えはしない）。
第 3.5.1 節に理由を 3 つ書いた。ADR の当時の例は `issue-<番号>-` を持たないので、
**本書の第 2.1 節の例はもう記法に適合しない** —— 正本は
[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第 6 節であり、そこの例が現行である。

書き換え（runner が id を採番する）ではなく検査にしたのは、第 2 節の
「契約は Issue の写しであって再エンコードではない」を守るためである。runner が
`adr-present` を `issue-125-adr-present` に直すと、Issue に書かれた id と report に出る id が
違うものになり、両方を読む人間がその対応を頭の中で維持することになる。

### 12.6 `acceptance_gates_tampered` は実装しなかった（#125）

第 3.5 節 (4) が予定していた「追記の SHA-256 を裁定後に突き合わせる」検査は、
**そもそも追記しない**設計になったので対象が無い。第 3.6 節の失敗様態の表で
「(a) の唯一の明確な優位」とされていた「worker が judge を書き換えた」の検出は、
上流が `.commandmate/verify.yaml` を変更集合に残すことで既に持っている
（契約の `deny` で捕まえられる状態を保っている）。runner 側で二重に持つ理由が無い。
