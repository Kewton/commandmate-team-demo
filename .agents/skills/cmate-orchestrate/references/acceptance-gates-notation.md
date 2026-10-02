# 受入ゲート記法 v1（`acceptance-gates` ブロック）

**この文書が記法の正本である。** [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md)
は裁定の記録であり、記法そのものはここに固定する。ADR と本書が食い違ったら本書が正しい
（ADR 冒頭の運用規約: 実装で形が変わったら正本を直し、ADR に「なぜ変えたか」を追記する）。

読む側の実装は 2 つあり、**同じ commit で変える**こと。

| 実装 | 役割 |
|---|---|
| `scripts/orchestrate.mjs`（planner） | ブロックを **構文と Issue 番号スコープだけ** parse し `plan.issues[].acceptance_gates` に載せる |
| `scripts/dispatch.mjs` | `require` の id を worktree の `.commandmate/verify.yaml` に突き合わせ、`gates:` の id が衝突しないことを確かめ、契約に反映する |

生産側（`cmate-issue-authoring` / `cmate-issue-refinement`）はこの記法を**ミラーする側**であり、
独自に拡張しない（ADR 第5節。後続 Issue）。

**同型の別記法**が1つある: [open-questions-notation.md](./open-questions-notation.md)
（```open-questions ブロック、[#178](https://github.com/Kewton/commandmate-skills/issues/178)）。
本書の第3節（YAML subset）・第7節（記法違反の扱い）・第10節（変更規約）を**そのまま継承**し、
key と意味だけが違う。**本書を変えるときはあちらも読むこと** —— 「同じ subset である」ことが
あの記法の前提であり、著者が片方を書けたならもう片方も書ける、という設計になっている。

---

## 1. 何のための記法か

Issue は「何をもって完了とするのか」を散文で書く。裁定を下すのは
`commandmate wait --verify` の exit code であり、それが走らせるのは対象リポジトリの
`.commandmate/verify.yaml` のゲートである。**この 2 つは別のものである。**
「repo 共通ゲートが緑」と「この Issue が完成した」は同じ命題ではない。

本記法は、その差のうち**機械で測れる部分だけ**を Issue から裁定へ運ぶ。
測れない部分は運ばない — UAT と人間の確認に残す。

---

## 2. ブロックの形

Issue 本文に、info string が `acceptance-gates` の fenced code block を**ちょうど 1 つ**置く。

````markdown
```acceptance-gates
version: 1
require:
  - verify-selftest
  - orchestrate-fixtures
```
````

- **`require:`** — `.commandmate/verify.yaml` に**実在する** gate id の列挙。
  「この Issue では必ずこのゲートが判定に参加すること」の宣言。**選択**である。
- **`gates:`** — **新規コマンドの定義**（第 6 節）。実行契約の `verify.gateDefinitions` に載り、
  その Issue の裁定にだけ参加する。**`.commandmate/verify.yaml` には 1 バイトも書かない。**

どちらか一方でも、両方でもよい。両方空なら syntax error である。

`require` の id は verify.yaml をそのまま指す。翻訳を挟まないのは、記法から verify.yaml への
変換が「再エンコード」になった瞬間に「Issue が書いた条件」と「実際に走ったコマンド」が
ずれる余地が生まれるからである。コピーであれば、ずれは構造的に存在しない。
**`gates:` の entry も同じ理由で verify.yaml の gate entry と同じ key・同じ型・同じ制約**
であり、runner は id を書き換えない（第 6.1 節）。

---

## 3. 規則

| 規則 | 内容 |
|---|---|
| 個数 | 本文中にちょうど 0 個か 1 個。**2 個以上は syntax error**（マージも先勝ちもしない） |
| `version` | 必須・**先頭 key**・値は `1`。未知の version は syntax error（前方互換に丸めない） |
| 構文 | `.commandmate/verify.yaml` と同じ YAML subset。**best-effort 解釈をしない** |
| インデント | list item は**厳密に 2 スペース**、`gates:` entry の field は**厳密に 4 スペース**。tab は禁止 |
| コメント | **行頭 `#` の行だけ**。行末の `# ...` は値の一部であり syntax error になる |
| 禁止 | anchor / alias（`&` `*`）・flow collection（`[` `{`）・block scalar（`|` `>`）・複数行文字列・`---` / `...` |
| gate id | `^[a-z0-9][a-z0-9-]{0,31}$`。CommandMate の `GATE_ID_PATTERN` と同一。**引用符は付けない**（付けたら値の一部） |
| `gates[].id` | 上記に加えて **`issue-<Issue 番号>-` で始まる**こと（第 6.1 節）。予約 id（`work-evidence` / `scope` / `env-clean`）は不可 |
| `gates[]` の key | `id`（**entry の先頭**）・`command`（必須・非空）・`timeoutSec`（任意・整数・1..7200）・`mutex`（任意・`^[A-Za-z0-9_.-]+$` / 64 文字以内）・`retryOnFail`（任意・**`0` か `1` のみ**）・`flakyIsPass`（任意・`true` / `false`）。**閉じた集合** |
| `gates[].flakyIsPass` | `true` は **`retryOnFail: 1` を同じ entry に伴わなければ syntax error**（entry 内の記述順は問わない）。再実行が無ければ FLAKY は発生しないので、その宣言は「ここでは flake を許す」と読めて何も変えない |
| `gates[].command` | 単一行。`"` / `'` で囲ってよい（囲えば外側の引用符は値に含まれない）。verify.yaml の書き方と同じ |
| 個数上限 | `require` と `gates[].id` を合わせて最大 32 件。重複は error（2 つのリストは**同じ id 空間**である） |
| 空ブロック | `require` も `gates` も空なら syntax error |
| 期待 exit code | **0 に固定する。宣言しない**（第 4 節） |

`require` と `gates` の順序は**著者が書いた順のまま** plan に載り、契約に載る。契約は Issue の
写しであって再エンコードではない、という第 2 節の原則の帰結である。

**上限を超えたら切らない。** 33 件を宣言したブロックは 32 件に丸めずに拒否し、件数を名乗る。
黙って 1 件落として dispatch すると、宣言された受入条件が消えた run が緑で終わる —— この機能が
存在する理由そのものである。

`timeoutSec` を書かなかった entry は**契約でも書かれない**。CommandMate 自身の既定
（`DEFAULT_TIMEOUT_SEC` = 600 秒）が効き、runner が勝手に決めた数が混ざらない。
`mutex` / `retryOnFail` / `flakyIsPass`（[#223](https://github.com/Kewton/commandmate-skills/issues/223) /
[#224](https://github.com/Kewton/commandmate-skills/issues/224)、CommandMate #1771 / #1772）も同じで、
**宣言した entry にだけ書かれる** —— 使っていない Issue の契約は、これらの key が存在しなかった頃と
byte 一致する。上流は verify.yaml の `gates[]` と契約の `verify.gateDefinitions` を**同じ validator**
（`verify-config.ts` の `validateGateEntries`）で検査するので、受理集合はここでも同一である。
意味（マシン全体の排他 / 同一 tree の 1 回だけの再実行 / FLAKY の裁定）は
[cmate-verify の SKILL.md](../../cmate-verify/SKILL.md) が正本。

---

## 4. 期待 exit code を宣言しない理由

verify.yaml のゲートは定義上「exit 0 が pass」であり、ランナーは `sh -c "$cmd"` の `$?` を
直接読む。非 0 を期待値にすると、記法から verify.yaml への変換にラッパが要る。
**そのラッパこそが偽ゲートの生まれる場所**である — `cmd; test $? -eq 1` は、binary 不在の
127 も、シグナル死の 137 も、期待外の 1 も、等しく飲み込みうる。

「非 0 で終わること」を要求する受入条件は、`! cmd` あるいは `test "$(cmd)" = ...` として
**exit 0 が正である形に書き直せる**。書き直しは Issue 著者が行い、レビュアーが読む。
ラッパを生成器が黙って足すよりも、条件が読める形になる。

---

## 5. 散文からは何も生成しない（fail-closed）

**明示マークされたブロックに書かれた条件だけを契約へ運ぶ。散文・箇条書き・表からは
何も生成しない。**

`plan.issues[].test_expectations` は Issue 本文の backtick / code fence から
「既知 binary で始まる行」を拾った**助言的**な一覧であり、**裁定には使われない**
（`dispatch.mjs` はこの field を一度も参照しない）。この境界は意図的である。

1. **引用は指示ではない。** バグ報告は「今これが落ちる」コマンドを backtick で書く。
   そこから生成したゲートは、**バグが残っている間だけ緑になる**。
2. **抽出の binary 集合は profile の baseline に依存する。** 同じ Issue 本文が、profile を
   変えるだけで別のコマンド集合を生む。裁定の根拠が Issue の外側の設定に依存してしまう。
3. **planner は決定的でなければならない。** plan は入力の純粋関数であり、Claude と Codex で
   byte 一致することが parity の根拠である（[plan-contract.md](./plan-contract.md) 第1節）。
4. **推測ゲートは誰にも承認されていない。** 明示ブロックは Issue 著者が書きレビュアーが
   読むので、Issue の承認がゲートの承認になる。

**ゲートが無いことは、間違ったゲートが在ることより安全である。**
`.commandmate/verify.yaml` 冒頭の言い方を借りれば「A test nobody runs is not a gate」であり、
その裏返しとして**何を測っているか誰も知らないゲートは、緑の証拠能力を持たない**。

### 5.1 base 先行評価の対象は宣言済み gate のみ（[#218](https://github.com/Kewton/commandmate-skills/issues/218)）

`inspect.mjs --evaluate-gates` は、**このブロックが宣言した gate だけ**を dispatch の前に
base で実行し、`already_satisfied` / `failing_at_base` / `nondeterministic` / `not_evaluable` に
分類する（[codes-and-recovery.md](./codes-and-recovery.md) 第6.3節、
[runner-operations.md](./runner-operations.md) 第16節）。**第5節の裁定はこれで一切変わらない** ——
散文・箇条書き・表からコマンドは導出しない。`plan.issues[].test_expectations` も読まない。

理由は第5節の4点そのままである。とくに (1) と (4) は、**実行を伴う**この runner では
一段強く効く: 散文から導出したコマンドを base で走らせるのは、誰も承認していないコマンドを
他人のリポジトリで実行することである。

したがって**「着手前に落ちること」を機械に確かめさせたい条件は、`gates:` に書く。**
gate は exit 0 だけを pass とするので（第4節）、閾値は `test` で表す。

````markdown
```acceptance-gates
version: 1
gates:
  - id: issue-231-line-ceiling
    command: "test $(wc -l < web/src/lib/repository.ts) -le 860"
    timeoutSec: 60
```
````

散文に「`wc -l` が 860 以下」と書いてあるだけの条件は、この runner の対象にならない
（実測 [CommandMate#1832](https://github.com/Kewton/CommandMate/issues/1832): 到達不能な閾値が
dispatch まで誰にも止められず、993 行で着地した）。**ゲートとして測ってほしいなら、
ブロックに書くのが唯一の道である。**

生産側の手引きは
[cmate-issue-authoring の acceptance-gates.md](../../cmate-issue-authoring/references/acceptance-gates.md)
第8節にミラーしてある。

---

## 6. `gates:`（新規コマンドゲート）— 契約が定義を運ぶ

**実装済み**（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）。
`gates:` は「この Issue の裁定にだけ参加する新しいコマンド」を定義する。

````markdown
```acceptance-gates
version: 1
gates:
  - id: issue-125-adr-updated
    command: "grep -aq 'gateDefinitions' skills/cmate-orchestrate/references/adr-issue-acceptance-gates.md"
    timeoutSec: 120
```
````

定義は **実行契約の `verify.gateDefinitions`** に載る（CommandMate
[#1791](https://github.com/Kewton/CommandMate/issues/1791) / `docs/design/task-contract.md` 第2.3.1節）。
**`.commandmate/verify.yaml` には 1 バイトも書かない。**

### なぜ verify.yaml に書かないのか

当初の設計（ADR 第3.5節）は「dispatch が worktree の `.commandmate/verify.yaml` に未 commit で
追記する」だった。それは 2 つの理由で採れない。

1. 未 commit の `.commandmate/verify.yaml` は **work-evidence の `uncommitted` に計上される**
   （除外は `.commandmate/tasks/` だけ）。契約を置いただけの worktree が「作業済み」に見え、
   exit 21 が意味を失う（[ADR 第11.2節](./adr-issue-acceptance-gates.md)の実測）。
2. その除外を広げるのは**上流が意図的に拒んでいる**。verify.yaml は毎ラン読み直され snapshot が
   無いので、変更集合に残っていること自体が「エージェントが自分を裁くゲートを弱めた」ことの
   検出面である。

実行契約は既に `tasks.contract_json` へ snapshot され、変更集合からも除外済みなので、
**そちらに載せれば新しい改竄面が増えない**。これが上流 #1791 の裁定である。

### 6.1 id は Issue に紐付ける（`issue-<番号>-<何を測るか>`）

`gates[].id` は **`issue-<Issue 番号>-` で始まらなければならない**。planner が**確かめる**のであって、
書き換えはしない —— 書き換えは第 2 節が禁じる再エンコードであり、Issue に書いた id と report に
出る id が違う状態を作る。

3 つのことを同時に果たす。

1. **衝突が構造的に起きない。** 契約の定義 id が verify.yaml の既存 gate id や予約 id
   （`work-evidence` / `scope` / `env-clean`）と衝突すると、上流は送信時に **exit 2** で拒否する。
   リポジトリ共通ゲートは測る対象で名付けられる（`lint` / `selftest`）ので、Issue 番号を含む id が
   そこに在ることはまず無い。それでも残る場合のために dispatch が突き合わせる（第 7 節）。
2. **裁定の行が由来を名乗る。** `GATE issue-125-adr-updated FAIL` は、それだけで
   「repo 共通ゲートではない」と読める。CLI の GATE 行は由来を出さない
   （[ADR 第11.4節](./adr-issue-acceptance-gates.md)）ので、id 自身が持つのが唯一の手段である。
3. **寿命を偽らない。** 契約ゲートは 1 Issue の 1 委任のあいだだけ存在する。repo 共通ゲートに
   見える名前は「ついでに verify.yaml に足しておこう」を誘い、ADR 第3.5節 (1) が拒んだ蓄積を招く。

### 6.2 それでもゲートに落とせない条件

**ゲート外として明示**し UAT / 人間の確認に残すこと。第 5 節の裁定は変わっていない ——
散文から `gates:` を生成することは無い。書くのは著者であり、読むのはレビュアーである。

### 6.3 生産側（`cmate-issue-authoring` / `cmate-issue-refinement`）はまだ出さない

記法をミラーする 2 package は `require:` だけを出し、`gates:` は出さない（ADR 第5節の後続 Issue）。
**consumer が読めることと producer が書けることは別に進む。** 現状の producer は `gates:` を
`acceptance_gate_block_unsupported` で拒否する —— 「自分が出せない記法」を出さないための
producer 側の判断であって、consumer の状態を述べたものではない。
conformance テスト（`tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs`）が
この差を**明示的な 1 件の乖離として固定**しているので、producer が追いつく Issue はそこを見ればよい。

---

## 7. 記法違反の扱い

**「ブロックが無い」と「ブロックが壊れている」を絶対に混ぜない。**

| 状態 | 扱い |
|---|---|
| ブロックが 0 個 | **従来挙動**。受入ゲートは載らない。契約は byte 単位で従来どおり |
| ブロックが 1 個・構文 OK | `plan.issues[].acceptance_gates` に載り、契約へ運ばれる |
| ブロックが 2 個以上 / 構文違反 / 未知 version / id 不正 / 空 | planner が open question + warning `acceptance_gate_block_invalid`。**推測で復旧しない** |
| `gates[].id` が予約 id / `issue-<番号>-` 始まりでない / command 無し / timeout 範囲外 / 重複 / 上限超過 | 同上（`acceptance_gate_block_invalid`）。**上限超過は切らずに拒否する**（第 3 節） |
| `require` の id が worktree の verify.yaml に無い | dispatch が `acceptance_gate_id_unknown` で **`send` する前に**当該 Issue を止める |
| `gates[].id` が worktree の verify.yaml の既存 id と衝突 | dispatch が `acceptance_gate_id_conflict` で **`send` する前に**止める（第 8 節）。上流の exit 2 には到達させない |
| 実行契約が無い run で `require` / `gates` がある | dispatch が `acceptance_gates_not_enforceable` で止める（第 8 節） |

いずれも `plan.issues[].acceptance_gates` は `null` になる。**`null` は「ブロックが無かった」を
意味しない** — 区別は warning が持つ。

構文違反を「ブロックが無かったこと」に丸めると、**書いたはずの受入条件が黙って消えた run**が
緑で終わる。planner の `unrecognized_file_extension`（Issue #43）と同じ結論である: 黙って捨てない。

---

## 8. 契約への反映（dispatch 側）

id の実在確認は **planner ではなく dispatch** が行う。planner は対象リポジトリの worktree を
持たない read-only の分析器であり、`verify.yaml` を読まない。dispatch は `commandmate ls` で
解決した実 worktree path を持つので、`<worktree>/.commandmate/verify.yaml` を読んで
突き合わせられる。

**解決可能な id の集合** = `work-evidence` + `scope` + verify.yaml が宣言した全 gate id。
これは CommandMate 自身が契約の `verify.gates` を検証するときの集合と同一である
（`env-clean` は built-in ゲートだが**この集合に入らない**ので、`require: [env-clean]` は拒否される）。

`gates:` の定義 id には**逆向き**の判定が要る: **この集合に在ってはならない**。
在れば `acceptance_gate_id_conflict` で止める。契約は**足せるだけで上書きできない**（上流の裁定）
—— 同じ id を契約が再定義できると、リポジトリ自身が宣言した「合格の定義」を委任単位で
差し替えられることになり、しかも report 上は同じ id なので**差し替えたことが読み取れない**。
verify.yaml が読めないときも止める。`gateDefinitions` を宣言した契約は、verify.yaml が無ければ
上流が送信時に拒否する（config 無しでは run が起動せず、評価され得ない完了条件になる）。

### 8.1 `verify.gates` の書き出し規則 — **絞り込みを禁ずる**

契約の `verify` key の省略は「全ゲートを走らせる」であり、明示は「そのゲートだけを走らせる」
である。したがって `require: [adr-present]` を素朴に `verify.gates: [adr-present]` と書き出すと、
lint も test も走らない契約になる。**受入条件を足したつもりで、判定が弱くなる。**

| operator の `--verify-gates` | Issue の `require:` / `gates:` | 契約の `verify.gates` |
|---|---|---|
| 無し | 無し | **key を書かない**（＝全ゲート） |
| 無し | 有り | **key を書かない**。全ゲートに `require` の id は必ず含まれ（実在確認済み）、`gates:` の定義も「全ゲート」に含まれる |
| 有り | 無し | operator の列挙を、operator の順序のまま |
| 有り | 有り | **和集合**（sort + 重複除去）。`gates:` の id も**必ず**入る |

最後の行は選択ではなく**上流の要求**である: `verify.gates` を書いた契約が `verify.gateDefinitions`
の id を列挙しないのは「定義したのに誰も走らせない」であり、契約エラーになる。その契約が唯一の
宣言元なので、選ばれなければ**永久に走らない**。

`verify.gateDefinitions` は `verify.gates` とは独立に、**Issue が定義したときは必ず**書かれる。
2 つは別の問いに答えている（何が走るか／ゲートとは何か）。

和集合が 32 件を超える場合は dispatch しない。片側を落とす縮約は、どちらを落としても
「宣言された要求を黙って捨てる」ことになるので採らない。

### 8.2 goal への転記

`require` が空でないときだけ、契約 `goal` に `## Acceptance gates this issue declared` 節が
足される。`gates:` が空でないときは `## Acceptance gates this issue defined` 節が足され、
**id だけでなく command も書く** —— 契約にしか存在しないゲートは worktree のどこを探しても
見つからないので、id だけ渡された worker は何が走るのか判定できない（上流の前文が
`gateDefinitions[].command` を実コマンドに展開するのと同じ理由）。
ブロックを持たない Issue の goal は **byte 単位で従来どおり**である。

### 8.3 report の `origin`

`verification.gates[]` に optional field `origin`（`repo` / `issue`）が載る。

- `issue` — その Issue の `require:` が名指しした id、およびその Issue の `gates:` が定義した id
  （定義ゲートは定義上 issue 由来である。契約以外にそれを知っている場所が無い）
- `repo` — repo 共通ゲート（verify.yaml に在るが `require` されていないものを含む）
- **欠落は「由来が記録されていない」であり、`repo` と読んではならない**

実測（[ADR 第11節](./adr-issue-acceptance-gates.md)）: `commandmate wait --verify` が印字する
`GATE <id> PASS|FAIL (<detail>)` 行に**由来は出ない**。したがって `origin` は読み取るものでは
なく、dispatch が「自分が契約に運んだ id か」から**決める**ものである。

---

## 9. 完全な例

`.commandmate/verify.yaml`（対象リポジトリ側）:

```yaml
version: 1
gates:
  - id: validate
    command: "python3 scripts/validate.py"
    timeoutSec: 60
  - id: orchestrate-fixtures
    command: "node tests/fixtures/cmate-orchestrate/run_tests.mjs"
    timeoutSec: 300
```

Issue 本文（抜粋）:

````markdown
## 受入条件

- [ ] planner がブロックを parse する
- [ ] 記法違反は open question になる

```acceptance-gates
version: 1
require:
  - orchestrate-fixtures
```

`orchestrate-fixtures` は既存の 27 case を含むので、非回帰もこのゲートが見る。
````

plan:

```json
"acceptance_gates": { "version": 1, "require": ["orchestrate-fixtures"] }
```

契約: `verify` key は**書かれない**（operator が `--verify-gates` を渡していないため、
全ゲートが走り、その中に `orchestrate-fixtures` は必ず含まれる）。`goal` に受入ゲート節が載る。

report:

```json
"gates": [
  { "id": "work-evidence",        "verdict": "pass", "origin": "repo" },
  { "id": "validate",             "verdict": "pass", "origin": "repo" },
  { "id": "orchestrate-fixtures", "verdict": "pass", "origin": "issue" }
]
```

### 9.1 新規コマンドを足す例（Issue #125 が実装した側）

同じ `.commandmate/verify.yaml` に対し、Issue #125 の本文が次を書いたとする。

````markdown
```acceptance-gates
version: 1
require:
  - orchestrate-fixtures
gates:
  - id: issue-125-no-verify-yaml-write
    command: "! grep -aq 'verify.yaml' skills/cmate-orchestrate/scripts/dispatch.mjs"
    timeoutSec: 120
```
````

plan:

```json
"acceptance_gates": {
  "version": 1,
  "require": ["orchestrate-fixtures"],
  "gates": [
    {
      "id": "issue-125-no-verify-yaml-write",
      "command": "! grep -aq 'verify.yaml' skills/cmate-orchestrate/scripts/dispatch.mjs",
      "timeoutSec": 120
    }
  ]
}
```

契約（operator が `--verify-gates` を渡していない場合）:

```yaml
verify:
  gateDefinitions:
    - id: "issue-125-no-verify-yaml-write"
      command: "! grep -aq 'verify.yaml' skills/cmate-orchestrate/scripts/dispatch.mjs"
      timeoutSec: 120
```

`verify.gates` は**書かれない**。走るのは「verify.yaml の全ゲート ＋ この定義」であり、
これが最も強い読みである。`--verify-gates validate` を渡した場合だけ
`gates: ["issue-125-no-verify-yaml-write", "validate"]` が加わる（定義 id の列挙は必須）。

`.commandmate/verify.yaml` は**この間ずっと 1 バイトも変わらない**。

---

## 10. 変更するときの規約

- 記法を変えるなら、**本書・planner・dispatch・fixture を同じ commit で**変える。
- fixture は ADR 第4節の 6 条を満たすこと。とくに **二点測定**（適合で緑・**成果物側の変異**で赤）と
  **赤の理由の固定**（exit 20 であり、失敗ゲート集合に当該 id が名指しで含まれること）。
  緑だけの fixture は「ゲートが効いている証拠」として採用しない。
- 生産側 2 package にミラーするときは、`FILE_EXT` と同じ形で conformance テストを置くこと。
