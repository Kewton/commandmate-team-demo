# ADR: 全自動モード（unattended）の契約改版（[#95](https://github.com/Kewton/commandmate-skills/issues/95)）

status: **accepted / 段階 A〜C 実装済み**（Issue [#122](https://github.com/Kewton/commandmate-skills/issues/122) / [#134](https://github.com/Kewton/commandmate-skills/issues/134) / [#142](https://github.com/Kewton/commandmate-skills/issues/142)、0.22.0）。
第14節は #115 の実測による訂正、第15〜17節は実装で変えた点である。

ロードマップ Phase 4（エピック [#96](https://github.com/Kewton/commandmate-skills/issues/96)）である。
ビジョンは「承認つき運転（plan → **人間の承認** → dispatch）を**既定として維持したまま**、
明示 opt-in の全自動モード（CI / cron 起動等の無人運転）も選べるようにする」と定めている。
本 ADR は、その opt-in が**何を変え、何を絶対に変えないか**の 7 論点を裁定する。

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[dispatch-contract.md](./dispatch-contract.md)（第1節の入力・第3節の停止・第5節の status/exit）・
[merge-contract.md](./merge-contract.md)（第4節の2 gate）・[uat-contract.md](./uat-contract.md)
（第5節の修正ループ）と [../SKILL.md](../SKILL.md)（第3節の設計思想・第5節の対処表）にある。
ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に「なぜ変えたか」を追記する**
（[release-notes.md](./release-notes.md) と同じ運用）。

本文中の行番号は **main = `3105722` 時点**の実測値である。

---

## 1. 現状（実測）

### 1.1 「人間の承認」は 1 つではなく 2 つの別物である

[SKILL.md](../SKILL.md) 第3節は「**plan →（人間の承認）→ dispatch → merge / uat** の順に、
別々の invocation で呼ぶ。1つの runner が次の phase を勝手に始めることはない」と述べる。
この文の中に、実装形態の異なる承認が 2 つ入っている。

| 承認 | どこに実装されているか | 破り方 |
|---|---|---|
| plan → dispatch の承認 | **どこにも無い。** 人間が plan を読んでから `dispatch.mjs` を叩く、という**運用**でのみ表現される | `orchestrate.mjs` の直後に `dispatch.mjs` を書いた shell script を1本置けば、今日でも承認は消える |
| merge / uat の承認 | **フラグとして在る。** `--approve` が無ければ mutation しない preview（`merge.mjs` 839 / 945行、`uat.mjs` 708 / 1113行）。`approval_enforced` completion check が `mutated ⟹ approved` を自己申告する | `--approve` を渡す |

**この非対称が本 ADR の出発点である。** dispatch には外すべき承認フラグが存在しない。
したがって「dispatch を無人化する」は、機能の追加ではありえない。

### 1.2 無人で困る停止点は、既にひととおり在る

dispatch runner は既に、人間の介在を前提とした停止をいくつも持っている。

- **prompt 検出（exit 10）** — `capture` で内容を取り、**自動応答せず**停止する
  （[dispatch-contract.md](./dispatch-contract.md) 第3.1節）。`human_required` が true になる。
- **裁定不能（exit 99）** — 「どのゲートもこの作業を判定していない」。pass に丸めず、
  再指示ループにも流さず、`human_required` で上げる（同 第2.6節）。
- **`open_questions`** — 未回答の planner question を持つ Issue が1件でもあれば
  **1人も dispatch せずに停止**する（`dispatch.mjs` 2047〜2056行）。
- **`worktree_unresolved`**（[#90](https://github.com/Kewton/commandmate-skills/issues/90)）・
  **`worktree_setup_*`**（[#93](https://github.com/Kewton/commandmate-skills/issues/93)）・
  **`drift_<check>`** — いずれも pre-flight の blocking である。

merge / uat 側も同様に、CI pass・conflict・上限到達で止まる（第6節に全列挙する）。
**無人運転のために新しく作らなければならない停止は、実のところ多くない。**

### 1.3 Auto-Yes は既定 off で、契約にもそう書かれる

`--auto-yes` の既定は off（`dispatch.mjs` 366行）。指定時のみ exit 10 で `respond yes` を送る
（同 1672行・1808行）。生成する実行契約にも `autoYes: mode: off`（指定時は `safe`）を書き出す
（同 1158〜1159行）。コメントが理由を記録している —
「契約は runner 自身と同じ Auto-Yes 姿勢を宣言するので、サーバ側の方針と監督ループが食い違えない。
`off` は能動的な禁止であり、ブロックの省略（何も言わない）とは違う」。

ただし **2 つは同じものではない。** 契約の `safe` は製品側の分類つき方針であり、
runner の `respond yes` は **prompt の種類を見ない無条件の yes** である。

### 1.4 空 scope の拒否は、契約経路の**内側にしかない**

Issue [#50](https://github.com/Kewton/commandmate-skills/issues/50) の裁定により、
plan が対象 file を1つも挙げていない Issue は dispatch されず、`contract_scope_unknown` を
limitation に記録して `not_dispatched` のまま残る。

**この判定は `if (contractMode)` の内側にある**（`dispatch.mjs` 2190〜2206行）。すなわち:

1. **フォールバック経路（`--contract-mode off`、または契約非対応 CLI での `auto`）では、
   空 scope の Issue も dispatch される。** そこには `success.requireScopeClean` が無い
   ——契約が無いのだから scope ゲートという概念自体が無い。
2. 契約経路でも、この判定は **wave の worker ループの中**にある。同じ wave の他の worker は
   **その前に既に `send` 済み**である。つまり「scope 未宣言で止まった」run は、
   **止まった時点で他 Issue の mutation が始まっている**。

`--contract-mode auto`（既定）は、契約非対応 CLI を見つけると `contract_unsupported` を
limitation に記録して**続行**する（同 第2.7節）。人間が居れば summary の冒頭でそれを読む。

### 1.5 上限は既にすべて有界である

| 上限 | 値 | 到達時 |
|---|---|---|
| dispatch `--max-turns` | 既定 8 | 未 commit なら当該 worker を `failed` |
| uat `--max-attempts` | 既定 2・**ceiling 5**（`uat.mjs` 114〜115行、`positiveInt` で範囲外は拒否） | `blocked`（exit 8）で停止。`max_attempts_reached`。**成功に丸めない** |
| wave 幅 | plan の `max_parallel`（1〜3） | 超える plan は `plan_invalid` |

**回数の無限ループは構造的に存在しない。** 一方で **時計の上限は無い**。

> **訂正（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測。第14.2節）。**
> 初版はここに「wall-clock は `--wait-timeout` × ターン数で暗黙に決まるだけ」と書いていた。
> **暗黙にすら決まらない部分がある。** その式が支配するのは worker の監督ループだけで、
> profile baseline（契約なし経路の検証・UAT の機械ゲート）は `runCli` が `execFileSync` に
> `timeout` を渡さないまま実行される。`baseline: ["sleep 6"]` の profile を
> `--wait-timeout 1 --max-turns 1` で回すと run は 12.9 秒かかる —— `--wait-timeout` は
> この時間に一切効かない。

### 1.6 したがって、欠けているのはフラグではなく宣言である

今日でも CI から `--approve` を渡せば merge / uat は無人で動く。#95 が足すべきものは
「動くこと」ではなく「**無人であると runner が知っていること**」である。知らないために、
人間が居る前提の劣化——黙って弱い裁定機構に落ちる（1.4）・prompt を提示して待つ（1.2）・
証拠が読めなくても続ける（第6.3節）・意味ゲート無しのまま pass にする（第6.4節）——が、
誰も読まない run でそのまま起きる。

---

## 2. 裁定 0 — unattended が外すのは「人間の待ち」であって、ゲートではない

**`--unattended` は「この invocation に人間は居ない」という入力の宣言である。**
mutation の権限を与えるフラグではない。次の 4 つを不変条件とする。

1. **緩めない。** unattended はどのゲートも無効化せず、どの blocking も limitation に格下げせず、
   どの status も1段上げない。**含意するのは締め付けだけである。**
2. **緩和フラグとの併用を拒否する。** `--auto-yes` / `--allow-questions` /
   `--contract-mode off|auto` との併用は `invalid_input`（exit 3）で拒否する（第3・4節）。
   **黙って上書きしない** ——指定した値が効かない状態を作らない
   （#93 が `--worktree-setup` の二重指定を拒否したのと同じ型）。
3. **mutation の許可は `--approve` のままである。** `--unattended` は `--approve` を含意しない。
   merge / uat を無人で動かす CI は**両方**を書く。こうすれば report の `approved: true` は
   従来どおり「この mutation は明示的に承認された」を意味し続け、schema の description を
   変えずに済む。**「無人だから安全側に倒したい」つもりで `--unattended` を付けた operator に、
   mutation 権限が付いてくることは無い。**
4. **runner は次の phase を始めない。** 無人運転の driver は **CI の job 定義（または cron
   script）**であって runner ではない。[SKILL.md](../SKILL.md) 第3節の
   「1つの runner が次の phase を勝手に始めることはない」は unattended でも**そのまま維持する**。

不変条件 4 が重要である。これを崩すと「plan → dispatch → merge → uat を1コマンドで回す
新しい runner」が要り、それは4 runner が別々に持っている停止・artifact・再実行性
（`out_exists` / `run_exists` / `--out` 未消費）を1つに畳む変更になる。#95 が求めているのは
運転モードであって、5つ目の runner ではない。

### 2.1 この裁定で #95 の「契約の根幹に例外を作る」に答えたことになるか

なる。**例外を作らない、が本 ADR の答えである。** 承認つき運転が守っていたものは
「人間が読む」ことそのものではなく、**人間が読むまで壊れた状態が下流へ流れないこと**である。
無人でその保証を維持する方法は、承認を機械に代行させることではなく、
**人間に提示して待つ経路を、その場で止まる経路に変換すること**である。

---

## 3. 論点1 — `scope.allow` の必須化

### 裁定

**unattended では、次の 2 つを両方行う。片方だけでは意味を持たない。**

1. **pre-flight で全 Issue の scope 非空を検査し、all-or-nothing で停止する。**
   plan の全 Wave の全 Issue について `suspected_files` が空でないことを、
   **`--out` を作る前**（[dispatch-contract.md](./dispatch-contract.md) 第3.0節）に確かめる。
   1件でも空なら **1人も dispatch せず** exit 1 で止まる。
2. **契約経路を必須にする。`--unattended` は `--contract-mode require` を含意する。**

### 理由

(1) は「拒否を足す」のではなく「**拒否する時点を早める**」変更である。現行の拒否は wave の
worker ループの中にあり、同じ wave の他の worker は既に `send` 済みである（第1.4節）。
人間が居る運転ではこれで足りる——止まった report を人間が読み、走ってしまった worker を
自分で始末できる。無人ではその読み手が居ないので、**mutation を1つも始めていない状態で
止まる**ことに意味がある。#90 が `--out` を消費せずに止まることを選んだのと同じ理由であり、
#93 が部分成功を all-or-nothing にしたのと同じ理由である。

(2) が無いと (1) は空文になる。フォールバック経路には `requireScopeClean` が存在せず
（第1.4節）、**scope.allow を必須にするとは、契約経路を必須にすることと同義**だからである。
`--contract-mode auto` の既定は「契約が無ければ弱い裁定に落ちて続行する」であり、
人間が summary 冒頭でそれを読むことを前提にした劣化である。無人では読み手が居ない。

### code と停止形

停止は `blocking_reasons` に **`contract_scope_unknown` を Issue ごとに1件**
（#90 が `worktree_unresolved` で採った形）、`stop_reason` は `dispatch_error`、
status は `failure`（exit 1）である。**新しい code を作らない。** 対処が現行と同一
（「Issue 本文に対象 file を書いて re-plan する」）だからである。#90 が専用 code を新設したのは
対処が正反対だった（worker を調べる vs worktree を作る）からであって、検出時点が早まっただけの
ここには当てはまらない。

この経路で止まったときは **`limitations` に `contract_scope_unknown` を二重に書かない**
（`worktree_unresolved` が `drift_worktrees_present` を limitations に残さないのと同じ、
blocking_reasons への一本化）。

### plan の warning 一般では止めない

plan の `no_suspected_files` warning と dispatch の `contract_scope_unknown` は同じ事実の
両側である。unattended はこの事実を pre-flight で拒否するが、**plan の warning が1件でもあれば
拒否する、にはしない。** `profile_repository_override` のように operator が意図して作る warning が
あり、一律 blocking にすると unattended は「plan を完全に綺麗にできない限り使えないモード」になる。
`no_acceptance_criteria` だけは別枠で、第9節（#100 依存）で段階 C の前提として扱う。

### 検討した案と却下理由

| 案 | 内容 | 裁定 |
|---|---|---|
| A | 現行のまま（wave 内で1人ずつ拒否） | **却下。** 無人では、止まった時点で他 Issue の worker が走っている状態を誰も始末しない |
| B | scope が空なら unattended が scope を推定して補う | **却下。** 推測した scope は誰も承認していない。#100 第2.3節「ゲートが無いことは、間違ったゲートが在ることより安全である」の scope 版であり、しかも scope は**書き込み権限**なので害はゲートより大きい（Issue #54） |
| C | scope が空の Issue だけ除外して残りを dispatch する | **却下。** wave の barrier は「この集合を並列に走らせる」約束の上に立つ（#93 論点2）。無人で集合を黙って縮めると、「全部通った」の意味が run ごとに変わる |
| D | pre-flight で all-or-nothing に止め、契約経路を必須にする | **採用** |

---

## 4. 論点2 — Auto-Yes の扱い

### 裁定

**既定 off を維持する。`--unattended` は `--auto-yes` を含意しない。
そして `--unattended --auto-yes` の併用を `invalid_input`（exit 3）で拒否する。**

契約に書き出す `autoYes` も **`mode: off` のまま**である。

### 理由

**#95 の要件4（human_required 相当は無人でも必ず停止する）と `--auto-yes` は、
同じ run の中で両立しない。** `--auto-yes` は exit 10 を `respond yes` で消費して同ターンを
続行する（`dispatch.mjs` 1672行）。すると prompt 停止という human_required 経路が
**構造的に到達不能**になる。「無人でも prompt では止まる」と宣言した run が、
「prompt には全部 yes と答える」と宣言することはできない。

「限定的な auto-yes（安全な prompt だけ答える）」を作らないのも同じ理由である。
runner の `respond yes` は prompt の種類を見ない（第1.3節）。分類を runner 側に実装すれば、
**それは製品側の autoYes ポリシーの二重実装**になり、契約が `off` と宣言している方針を
呼び出し元が上書きする形になる。契約の `safe` モードは製品側の分類であって、
runner の無条件 yes とは別物である——この区別を消さない。

拒否を「limitation に記録して続行」にしないのは、limitation が停止しないからである。
自己矛盾した2つの宣言のうち片方を黙って勝たせる実装は、どちらが勝ったかを report の
読み手（＝無人運転では次の job）が判定できない。

### 併せて閉じる: `--allow-questions`

`--unattended --allow-questions` も同じ理由で `invalid_input` とする。
`--allow-questions` は「未回答の question を**引き受けて**進む」宣言であり、
引き受ける主体が居ないときに立てられる旗ではない。

### 塞げない穴を明示する: monitor という側面経路

[cmate-orchestrate-monitor](../../cmate-orchestrate-monitor/) は既定で prompt に Enter を送る
（`--no-auto-approve` は off が既定。同 [monitor-contract.md](../../cmate-orchestrate-monitor/references/monitor-contract.md) 第3節）。
同じ worktree に monitor を当てながら unattended dispatch を走らせると、
**dispatch が止まるはずの prompt に monitor が答えうる**。

これは dispatch runner が機械的に強制できない（別プロセス・別 Skill・別 install）。
したがって:

- ~~**契約の `autoYes: mode: off` がサーバ側の最後の砦である。**~~
  **訂正（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測。第14.6節）:
  砦は無い。** 契約の `mode: off` はサーバ**自身**の自動応答を確かに止めるが、monitor の Enter は
  `tmux send-keys` でペインへ直接届くので、その方針の外側にある。さらに、monitor がその方針を
  読んで手を止められるのは `capture --json` の `autoYes.lastSuppression` が在るときだけで、
  それが書かれるのは**サーバ側 Auto-Yes が有効なとき**、すなわち unattended が禁じている状態の
  ときだけである。unattended dispatch が実際に作る payload（`autoYes.enabled: false`）に対して
  monitor の判定は **`approve`** になることを実測した。
- **unattended 運転で monitor を併用するなら `--no-auto-approve` は必須**である旨を、
  実装フェーズで [SKILL.md](../SKILL.md) 第3.2節の monitor 境界の記述に足す。
  現在の記述（「併用するなら monitor 側に `--no-auto-approve` を付ける」）を、
  unattended では推奨ではなく要件に格上げする。
- **runner はこれを検出しない。** 検出できないものを検出したふりをしない
  （プロセス一覧を覗く実装は、環境依存で false negative を出しながら「確認した」と report する）。

---

## 5. 論点3 — 修正ループの上限（uat `--max-attempts`）

### 裁定

**上限機構も既定値も ceiling も変えない。** 変えるのは 1 点だけ:
**unattended で `fix_uat` を回すときは `--max-attempts` の明示を必須にする**
（未指定は `invalid_input`）。

| 項目 | unattended での扱い |
|---|---|
| ceiling（5） | **据え置き。** 無人だから緩める、は逆である。読み手が居ないほうが暴走の被害半径は大きい |
| 既定（2） | **据え置き。ただし unattended では既定に落ちない**（明示必須） |
| 上限到達 | `blocked`（exit 8）・`max_attempts_reached`。**無人でも成功に丸めない**（第6節） |
| dispatch `--max-turns`（8） | 据え置き。明示も要求しない（worker 1人あたりのターン数であり、mutation の反復回数ではない） |
| 新しい上限 | **作らない**（下記） |

### 理由

回数の上限は既にすべて有界であり（第1.5節）、無限ループは構造的に存在しない。
無人化が壊すのはその有界性ではなく、**「何回まで機械に直させてよいか」を誰かが決めた、という
事実**である。人間が居る運転では、`--approve` を打つ人が既定 2 を黙認したことがその決定になる。
無人ではその瞬間が無いので、**job 定義を書く時点でしか決められない**。明示必須はそのための、
最も安い装置である。

**時計の上限（wall-clock budget）を本 ADR では作らない。** 作るなら「打ち切ったときの status を
何にするか」「打ち切りの途中で mutation がどこまで進んだか」を全 runner で定義する必要があり、
それは回数上限とは別の契約である。cron 二重起動と併せて第13節の未決事項に置く。

> **[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測（第14.2節）。**
> 測った結論は「**budget は要る**」である。既定値では dispatch だけで
> `waves × --max-turns(8) × --wait-timeout(300s)` ＝ wave あたり 40 分（wave 幅は時計に掛からない
> ことも実測した）だが、決め手はその長さではなく、**profile baseline に時計の上限が
> 構造的に存在しない**ことである。status / stop_reason / 記録方法の候補は第14.2節にある
> （要点: `partial` ＋ 既存 enum の `timeout` を再利用し、`blocking_reasons` の自由文字列
> `wall_clock_budget_exhausted` で名指す ＝ **schema version を上げずに済む**）。
> **本 ADR の裁定（budget をここで作らない）は変えない** —— 作るのは段階 A の実装 Issue である。

---

## 6. 論点4 — 無人でも必ず停止するもの（網羅列挙）

### 6.1 規律

**unattended は、停止理由・status・exit code の写像を1つも変えない。**

| status | exit | unattended での意味 |
|---|---|---|
| `success` | 0 | 全部通った。**CI が成功と読んでよい唯一の値** |
| `partial` | 7 | 途中停止。**成功ではない** |
| `blocked` | 8 | uat の上限到達。**正当な停止であって成功ではない** |
| `failure` | 1 | 何も試せなかった |
| `invalid_input` | 3 | 呼び出しが矛盾している（第2節の不変条件 2） |

**`human_required` の意味も変えない。無人でも true にする。** この field が意味するのは
「人間が今そこに居る」ではなく「**人間の介入なしには解けない**」である
（schema の description が既にそう書いている: "None of the three is resolvable by
re-dispatching"）。CI はこれを「再実行しても無駄である」の signal として読む。
無人だからといって false にすれば、CI は再実行し続ける。

### 6.2 dispatch — 無人でも止まる停止（[dispatch-contract.md](./dispatch-contract.md) 第5節の語彙）

| stop_reason | code | なぜ無人でも止まるか |
|---|---|---|
| `human_required` | `human_input_required` | **prompt 検出（exit 10）。** 自動応答しない（第4節） |
| `dispatch_error` | `verification_not_judged` | **exit 99。** 何も判定していない。再 dispatch で解けない |
| `dispatch_error` | `open_questions` | 未回答 question。Issue 本文の編集でしか解けない。`--allow-questions` は unattended では拒否される（第4節） |
| `dispatch_error` | `contract_unsupported` | unattended は `--contract-mode require` を含意する（第3節）ので、契約非対応 CLI は**必ず**停止になる |
| `dispatch_error` | `contract_scope_unknown` | scope 未宣言。**pre-flight で全 Issue 分**（第3節） |
| `dispatch_error` | `not_dispatched` | runner が起動を拒否した（unsafe worktree target 等） |
| `dispatch_error` | `worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` | #93 の準備段の失敗。準備できなければ dispatch 対象が存在しない |
| `dispatch_error` | `wave_not_advanced` | 上のどれでもない理由で wave が advance しなかった（防御的な既定） |
| `drift` | `worktree_unresolved` | 送る先が無い（#90）。**未解決 Issue ごとに1件** |
| `drift` | `drift_cli_available` / `drift_repo_access` / `drift_base_resolvable` / `drift_branch_matches` | plan 承認後に世界が動いた。**drift の上に dispatch しない** |
| `worker_failed` | `worker_failed` | `--max-turns` 到達で未 commit |
| `timeout` | `worker_timeout` | `wait` の timeout |
| `verification_failed` | `verification_failed` | completed した worker の裁定が pass でない |

**この表に「unattended だけの停止」は1つも無い。** 第3節が足したのは検出時点であって、
停止理由ではない。

### 6.3 merge — 無人でも止まる停止（[merge-contract.md](./merge-contract.md) 第6節の語彙）

| stop_reason | なぜ無人でも止まるか |
|---|---|
| `ci_failed` / `ci_pending` | **CI green 無しに merge しない。** check 0 件も green にしない |
| `merge_failed` | **merge conflict。** 無人で解消しない（解消は人間の判断である） |
| `pr_missing` / `pr_closed` / `pr_create_failed` | 納品対象の PR が想定した状態に無い |
| `preflight_failed` / `runner_error` | gh / git / repo 到達性 |

### 6.4 uat — 無人でも止まる停止（[uat-contract.md](./uat-contract.md) 第7節の語彙）

| stop_reason | なぜ無人でも止まるか |
|---|---|
| `acceptance_conditional` | **`conditional_go` は human 判断であって自動修正の対象ではない**（同 第4.2節）。無人でも条件を自動で閉じない |
| `max_attempts_reached` | 上限到達（`blocked` / exit 8）。**成功に丸めない** |
| `remerge_failed` | 再merge の conflict |
| `uat_failed` / `worktree_failed` / `fix_failed` | 判定不合格・fix worktree 不成立・fix worker の失敗（fix loop も prompt に自動応答しない） |

### 6.5 段階 C でだけ blocking に昇格するもの

無人 merge（第8節の段階 C）は「証拠が読めなかった」を許容できない。人間が居る運転では
report を読む人が補える欠落が、無人では**そのまま merge の根拠**になるからである。

| 現行 | 段階 C での扱い | 理由 |
|---|---|---|
| `verification_gates_unrecorded`（limitation・dispatch） | **blocking** | pass の根拠となった gate を report が名指しできない。#100 第2.3節「何を測っているか誰も知らないゲートは、緑の証拠能力を持たない」 |
| `change_evidence_unavailable`（limitation・merge） | **blocking** | 宣言 scope と実変更を対比できない。「読めなかった」を「scope 内だった」と読ませない（同 第5.2節 規則2） |
| `acceptance_not_run`（limitation・uat） | **起こさない** | 段階 C の uat 無人化は `--require-acceptance` を含意する（第8節）。意味ゲート無しの無人 UAT は baseline 再実行にすぎず、「受入を確認した」という主張ができない |

段階 A / B ではいずれも limitation のままである。昇格は**無人で不可逆な操作をするとき**にだけ
正当化される。実装は[#142](https://github.com/Kewton/commandmate-skills/issues/142)（第17節）——
`verification_gates_unrecorded` の二点測定を何と何で測ったかは第17.1節、裁定そのものを書き換えない
ことは第17.2節、`acceptance_not_run` の「起こさない」を構造で保証したことは第17.6節にある。

> **訂正（[#134](https://github.com/Kewton/commandmate-skills/issues/134) 実装時。第16節）。**
> 直前の1文と本節の見出しは、`change_evidence_unavailable` について**第8節の段階表と矛盾していた**
> —— 段階表は最初からこの昇格を**段階 B** に割り当てている（「+ `merge.mjs --create-prs`」の行の
> 「追加で含意するもの」）。**第8節が正しく、段階 B で昇格済みである。**
> 段階 C に残るのは `verification_gates_unrecorded`（dispatch）だけであり、`acceptance_not_run` は
> 昇格ではなく「起こさない」なので、この表の3行目は段階 C のままである。
> 昇格の正当化も「不可逆な操作」ではなく「**人間が読む前提の劣化を、読み手が居ない運転で止める**」
> である（第8節）—— PR 作成は revert 可能だが、証拠の無い PR が黙って積まれることは、
> それを読んで補う人が居ない運転では劣化のまま下流へ流れる。実装がこれをどう解いたかは第16節。

**`branch_changed_outside_declared_scope`（merge）は昇格しない。** 契約ゲート
`requireScopeClean` が上流で既に判定しており、unattended は契約経路を必須にしている（第3節）ので、
この limitation は「機械ゲートが通ったうえでの人間可読版」であることが保証される。
第3節の裁定がここで効いている。

### 6.6 #100 の予約席

[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第8.1節が本 ADR へ引き渡した
fail-closed 停止を、実装されしだい第6.2節の表に加える。いずれも**再 dispatch では解けない**ので
exit 99 と同じ扱い（`human_required` = true）である。

| code | 意味 |
|---|---|
| `acceptance_gate_block_invalid` | 受入ゲートの記法違反（書いたはずの条件が黙って消えた run を緑にしない） |
| `acceptance_gate_id_unknown` | 宣言したゲートが verify.yaml に存在しない |
| `acceptance_gates_tampered` | judge が書き換えられた（#100 段階 2） |

---

## 7. 論点5 — 失敗時の被害半径と取り消し手順

### 7.1 何が mutate されるか

| 段 | mutation | 可逆性 | 取り消し |
|---|---|---|---|
| dispatch 準備段（`--prepare-worktrees`） | ローカル worktree / branch の作成 | 可逆 | `cmate-worktree-cleanup`。**runner は消さない**（#93 論点3） |
| dispatch | worktree の `.commandmate/tasks/*.yaml` に契約を置く | 可逆 | 放置してよい（work-evidence と scope の計数から除外される。#1580） |
| dispatch | **worker が worktree の branch に commit する** | ローカル可逆 | `git reset --hard <開始時 SHA>`（7.2） |
| merge `--create-prs` | `git push --set-upstream origin <branch>`（`merge.mjs` 695行）→ **remote に branch が出る**。`gh pr create`（同 702行）→ **PR が立つ** | 可逆だが**外部に出る** | `gh pr close <n>` → `git push --delete origin <branch>`。**PR は close であって削除ではない**（履歴・通知は残る） |
| merge `--merge-prs` | `gh pr merge`（同 743行）→ **base branch が進む** | **実質不可逆** | revert PR を立てる（squash なら `git revert <sha>`、merge commit なら `-m 1`）。**force push で消さない** |
| uat `fix_uat` | fix worktree / fix branch の作成、fix worker の commit | ローカル可逆 | `cmate-worktree-cleanup` |
| uat `fix_uat` | `git merge --no-ff --no-edit <fix-branch>`（`uat.mjs` 922行）。**cwd 指定が無い**ので、**invocation cwd の現在の branch** へ merge される | **cwd 次第**（下記）| `git reset --hard <merge 前の SHA>` |

**最後の行の可逆性は cwd の上にしか立たない（[#115](https://github.com/Kewton/commandmate-skills/issues/115)
の実測。第14.3節）。** 初版はここを「ローカル可逆」と書いていたが、それが正しいのは cwd が
integration worktree のときだけである。実測した 2 つの例外:

- **cwd が `main`（branch push を受けた CI の既定）なら `main` が進む。** その `main` が push 済みなら
  **不可逆**であり、この行は 1 つ上の `--merge-prs` の行と同じ危険度になる。PR も CI も review も
  経ていない点でむしろ悪い。
- **cwd が detached HEAD（`actions/checkout` が SHA を取った状態）なら merge は exit 0 で成功し、
  uat は `outcome: merged` と報告するが、merge commit はどの branch からも到達できない。**
  `remerge_failed` は出ない —— 第6.4節の語彙で捕まらない静かな false success である。

段階 C の前提として invocation cwd を pre-flight で検査することを第8節に足した。

**副作用は git だけではない。** push は対象リポジトリの CI を起動する（実行時間・課金・通知）。
PR 作成は reviewer に通知を出す。**取り消せるのはリポジトリの状態であって、送られた通知ではない。**

### 7.2 取り消しを実行可能にする（`unattended_baseline`）

`git reset --hard <開始時 SHA>` と書けても、**その SHA が report に無い。** dispatch は
worktree の HEAD を dispatch 前に読んでいるが（`dispatch.mjs` 1405〜1411行 `worktreeHeadSha`）、
これはメモリ上の比較にしか使われておらず、report には残らない。

**裁定: unattended の run は、dispatch 開始時の各 worktree HEAD を短縮 SHA で
`limitations` に記録する（`unattended_baseline`。Issue ごとに1件）。**

- `dispatch_schema_version` は **1 のまま**、**field を足さない**。#93 が `worktree_prepared` で
  base SHA を limitations に載せたのと同じ経路である（同 第7節）。
- **branch 名と短縮 SHA で書く。絶対 path は書かない**（redaction が絶対 path を残さない。
  同 第4節）。取り消し手順が絶対 path を要求する形だと、report からは実行できない。
- 併せて run 全体で1件の `unattended_mode` を記録する（段階・含意した締め付け・
  拒否した緩和フラグ）。**何を宣言して走ったかが report 単体で読める**ようにするためであり、
  #47 / CommandMate #1678 B-5 の「report 単体で根拠が読める」と同じ規律である。

**但し書き（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測。第14.4節）。**
「branch 名と短縮 SHA で書く。絶対 path は書かない」という上の裁定は実測で裏付けられた ——
worktree が既に片付いていると `git reset --hard` は exit 128 で使えず、使えるのは
`git branch -f <branch> <baseline>` だけであり、それには **path ではなく branch 名**が要るからである。
一方で **baseline が担保するのは worktree branch の 1 段だけ**であり、次の 4 つでは足りない。
実装段（第12節 段 2）で [SKILL.md](../SKILL.md) 第5節の取り消し手順に持ち込むこと。

1. **untracked file は `git reset --hard` で戻らない**（実測。`.commandmate/tasks/*.yaml` を含む）。
   完全に戻すには `git clean -fdx` が要るが、それは worker の成果物も消すので別の判断である。
2. **既に merge / push されていたら戻らない。** 取り消しは上流から順に行う。
3. **worktree が片付いていたら `git reset` は使えない**（上記）。
4. **branch も消えて `git gc --prune=now` が走ると object ごと消える。** baseline が base branch から
   到達可能なら生き残るので、危険なのは **baseline が base から到達できないとき** ——
   `--prepare-worktrees`（#93）が既存 worktree を再利用した場合などである。

### 7.3 段階ごとの被害半径

| 段階 | 無人で到達する最遠点 | 外部に出るか | 不可逆か |
|---|---|---|---|
| A | worktree branch の commit | **出ない** | いいえ |
| B | remote branch + PR | 出る | いいえ（close + delete で戻る） |
| C | base branch の merge / 再merge | 出る | **はい** |

この表が第8節の段階分けの根拠である。**不可逆点は段階 C にしか無く、段階 C だけが #100 を
前提とする。**

---

## 8. 論点6 — 貫通範囲（段階導入）

### 裁定

**`--unattended` は runner ごとに独立のフラグとし、受け付ける runner を段階的に広げる。**
未実装の段に渡された `--unattended` は **`invalid_input` で拒否する**（黙って無視しない）。

| 段階 | 受け付ける runner | 追加で含意するもの | 前提 |
|---|---|---|---|
| **A** | `dispatch.mjs` | `--contract-mode require`、pre-flight の scope 検査、`unattended_baseline` の記録 | 無し。**本 Issue の実装範囲** |
| **B** | + `merge.mjs --create-prs` | `change_evidence_unavailable` の blocking 昇格 | A |
| **C** | + `merge.mjs --merge-prs`、`uat.mjs --create-uat-fix-worktrees` | `verification_gates_unrecorded` の blocking 昇格、uat は `--require-acceptance` と `--max-attempts` の明示、**invocation cwd の pre-flight 検査**（下記） | B ＋ **#100 段階1**（第9節）|

**段階 C は invocation cwd を pre-flight で検査する**
（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測で追加した前提。第14.3節）。
`uat.mjs` の再merge は cwd 指定を持たないので、CI が `main` を checkout していれば **UAT の fix が
レビューを経ずに main に入り**、detached HEAD なら **「merged」と報告しながらどの branch にも
残らない**（どちらも実測）。したがって段階 C の uat は、fix worktree を作る前に

- `git symbolic-ref -q HEAD` が空でないこと（**detached でない**）
- HEAD が期待する integration branch と一致すること

を確かめ、外れていれば **1 つも fix worktree を作らずに停止する**。dispatch が
`branch_matches` drift check で既に持っている形をそのまま置けばよく、新しい停止語彙は要らない
（`preflight_failed` 相当で足りる）。**実装は第17節**（比較対象の branch をどこから取るかは
本節が書いていなかった —— `--expect-branch` を足した。第17.4節）。

### 段階 A で dispatch の `--unattended` は何を足すのか

**権限は1つも足さない。締め付けだけを足す。** dispatch には外すべき承認フラグが無いのだから
（第1.1節）、これが唯一ありうる形である。具体的には第3節の 2 つ（pre-flight の scope 検査・
契約経路の必須化）と、緩和フラグの拒否（第4節）と、`unattended_baseline` の記録（第7.2節）である。

「それなら段階 A は unattended ではなく strict モードではないか」という問いには、そのとおりだと
答える。**dispatch における無人化とは strict 化のことである**、が本 ADR の裁定であり、
第1.6節の観察の帰結である。名前を `--strict` にしない理由は 2 つある: (a) 段階 B / C で
同じフラグが merge / uat に渡り、そこでは「人間が読む前提の劣化を止める」という同じ意味を持つ。
(b) `--unattended` は**なぜ厳しくするのか**を宣言する——strict は程度を、unattended は理由を言う。

### 未実装の段を黙って無視しない

段階 A の実装に対して `merge.mjs --create-prs --approve --unattended` を渡すと
`invalid_input` で落ちる。**受理して無視すると、CI は自分が守られていると誤解する。**
`--prepare-worktrees` 無しの `--worktree-setup` を `invalid_input` で拒否するのと同じ型である。

### runner 間で unattended を伝播させない

merge / uat は「上流の dispatch が unattended だったか」を検査**しない**。

- 各 runner の `--unattended` は独立の宣言である。伝播させると、部分再実行
  （[#98](https://github.com/Kewton/commandmate-skills/issues/98) の `--resume`）や、
  「dispatch は人間が見ていたが merge は夜間に回す」という正当な運用が組めなくなる。
- merge / uat が dispatch report から読むのは、従来どおり `worker_state` と
  `verification.outcome` の **2 field だけ**である（[dispatch-contract.md](./dispatch-contract.md)
  第7節）。ここに 3 つ目を足すと、version 据え置きの根拠そのものが崩れる。

---

## 9. 論点7 — [#100](https://github.com/Kewton/commandmate-skills/issues/100)（受入条件の機械ゲート化）との関係

### 裁定

**段階 A / B は #100 を前提としない。段階 C は #100 の段階1（`require:`）の実装を
明示的な依存とする。**

[adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第8.1節の主張をそのまま引き取る:

> 無人運転の安全性は、機械ゲートの充実度にそのまま比例する。〔…〕本 ADR が実装されていない
> 状態の unattended は、「lint と test が通った」を「Issue が完成した」と読み替えて
> merge まで進む機構である。

この主張は**不可逆な操作にだけ効く**。段階 A / B が到達する最遠点は PR であり（第7.3節）、
PR は人間が読む場所である——#97 が PR 本文に検証証拠を載せたのは、まさにそのためである。
**「lint と test が通った」を「Issue が完成した」と読み替えた成果物が PR として立つことは、
害ではなく本来の姿である**（レビュアーが読み、必要なら close する）。段階 C は違う。
そこで読み替えが起きると、誰も読まないまま base branch に入る。

### 段階 C が #100 に要求すること

1. **`require:` が契約に載る経路が実装されていること**（#100 段階1・同 第3.3〜3.4節）。
2. **対象 Issue が受入ゲートブロックを持つことを、段階 C の unattended が要求できること。**
   #100 第8.1節は「要求可能性だけを保証する」と書いている。**本 ADR はそれを要求する側に倒す**:
   段階 C では、ブロックを持たない Issue（および plan の `no_acceptance_criteria` に該当する
   Issue）を **無人 merge の対象にしない**。除外ではなく停止とし、対象集合を黙って縮めない
   （第3節・却下案 C と同じ理由）。
3. **#100 の fail-closed 停止が第6.6節の表に入っていること。**

段階 C の着手条件はこの 3 つであり、実装フェーズの表（第12節）でもそう書く。
**#100 が承認されないまま段階 C を出さない。**
条件 2 を実装がどう解いたか（plan だけを読む・id の実在は問わない・停止であって除外ではない）は
第17.7節にある。

---

## 10. 却下した案

| 案 | 却下理由 |
|---|---|
| **A. `--unattended` を `--approve` の別名にする** | report の `approved` が「人間が承認した」を意味しなくなる。merge / uat の schema description を書き換えることになり、既に世に出た report の読み方が変わる（[merge-contract.md](./merge-contract.md) 第10節の version 規律に反する）。加えて第2節の不変条件 3 のとおり、締め付けのつもりのフラグに mutation 権限が付いてくる |
| **B. plan → dispatch → merge → uat を通す 5 つ目の runner を作る** | [SKILL.md](../SKILL.md) 第3節の「1つの runner が次の phase を勝手に始めることはない」を壊す。4 runner が別々に持つ停止・artifact・再実行性（`out_exists` / `run_exists` / `--out` 未消費）を1つに畳む変更であり、#95 が求めているのは運転モードであって新しい runner ではない。無人運転の driver は CI の job 定義である |
| **C. unattended では prompt に自動応答する** | 第4節。#95 の要件4 と両立しない。prompt 停止が構造的に到達不能になる |
| **D. unattended では「安全な prompt」だけ自動応答する** | 製品側 autoYes ポリシーの二重実装になり、契約が `off` と宣言した方針を呼び出し元が上書きする形になる。runner の `respond yes` は prompt の種類を見ない（第1.3節） |
| **E. unattended では `--max-attempts` の ceiling を上げる** | 第5節。読み手が居ないほうが暴走の被害半径は大きい。緩める方向の変更は第2節の不変条件 1 に反する |
| **F. 停止したら unattended は自動で re-dispatch する（自己回復）** | 第6.2節の停止のうち大半は**再 dispatch では解けない**（exit 99・`open_questions`・`contract_scope_unknown`・`worktree_unresolved`）。解ける停止と解けない停止を runner が区別して再実行する機構は、`--resume`（#98）が扱う問題であり、運転モードの問題ではない |
| **G. unattended は blocking を limitation に落として最後まで走り切り、まとめて報告する** | 「無人でも成功に丸めない」の正反対である。壊れた状態を下流へ流さないことが、承認つき運転が守っていた唯一のものである（第2.1節） |
| **H. `--unattended` を環境変数（`CI=true` の検出等）で暗黙に有効化する** | 明示 opt-in でなくなる。#95 要件2 に反する。加えて、同じコマンドが環境によって別の契約で走ることになり、plan の決定性と同じ理由で受け入れられない |
| **I. dispatch report に `unattended` boolean field を足す** | additive ではあるが（[dispatch-contract.md](./dispatch-contract.md) 第7節）、#93 が `worktree_setup_*` で確立した「事実は `limitations` の code で運ぶ」経路が既にある。merge / uat が dispatch report から読む field を 2 つに保つ根拠（同 第7節）を、運転モードのために崩さない |

---

## 11. 後方互換性

**`--unattended` を渡さない run は、1 bit も変わらない。** これは努力目標ではなく、
実装フェーズで fixture 化する要件である（第12節 段5）。

- **dispatch**: 既定の `--contract-mode auto` はフォールバックに落ちて続行する。空 scope の Issue は
  従来どおり wave の中で1人ずつ拒否される（`contract_scope_unknown` は **limitation** のまま）。
  `--auto-yes` / `--allow-questions` は従来どおり受理される。
- **merge / uat**: `--approve` の意味も、`approved` field の意味も、既定値も変わらない。
  `--max-attempts` の既定 2 は据え置き（明示必須になるのは unattended のときだけ）。
- **schema**: `dispatch_schema_version` / `merge_schema_version` / `uat_schema_version` は
  **すべて 1 のまま**。field を足さず、enum に値を足さない。unattended の事実は
  `limitations[].code`（自由文字列。`$defs/entry` は `code` / `detail` の 2 key）で運ぶ。
  **`stop_reason` の enum に値を足さない**——第6節が示したとおり、unattended 固有の停止理由は
  1 つも無いからである。
- **Skill の `version`**: 契約文書（[dispatch-contract.md](./dispatch-contract.md) と
  [SKILL.md](../SKILL.md)）が変わるので **minor bump 以上**（#95 要件3）。schema が据え置きでも、
  入力フラグの追加は挙動の変更である。

既存 fixture の期待値を1つも緩めないこと。**緩めなければならないなら、それは実装が後方互換を
壊した合図である**（#93 第8節と同じ規律）。

---

## 12. 実装フェーズの段取り

この ADR が承認されてから、次の順で実装する。**段 1〜6 が段階 A（本 Issue の実装範囲）である。**

| # | 内容 | 出荷単位 |
|---|---|---|
| 0 | 本 ADR のレビューと承認 | （この PR） |
| 1 | [dispatch-contract.md](./dispatch-contract.md) の改版 — 第1節に `--unattended`、第3.0節に pre-flight の scope 検査、第5節の対処に unattended 行、第2.7節に「unattended は `require` を含意する」 | docs のみ |
| 2 | [SKILL.md](../SKILL.md) 第3節の設計思想節の改版 — 承認つき運転が既定であること、unattended が**緩めない**こと、driver は CI の job であること、第3.2節の flag 表と monitor 境界（`--no-auto-approve` の要件化） | docs のみ |
| 3 | dispatch: `--unattended` の受理、緩和フラグとの併用拒否（`invalid_input`）、`--contract-mode require` の含意 | minor bump |
| 4 | dispatch: pre-flight の scope 検査（all-or-nothing・`--out` 未消費）、`unattended_mode` / `unattended_baseline` の記録 | 3 と同一リリース |
| 5 | fixtures（第12.1節） | 3〜4 と同一リリース |
| 6 | `status.mjs` の hint map に unattended の停止を追加 | 同上（追随できなければ「detail を読む」に落ちる。#93 と同じ扱い） |
| 7 | **段階 B（別 Issue）**: `merge.mjs --create-prs --unattended`、`change_evidence_unavailable` の昇格 | 別リリース |
| 8 | **段階 C**（[#142](https://github.com/Kewton/commandmate-skills/issues/142)。**着地済み**。第17節）: `merge.mjs --merge-prs` と `uat.mjs`。**#100 段階1 の実装後**（第9節の 3 条件） | 別リリース |

### 12.1 fixture に要求すること

#95 の受入条件（完走系と停止系の両方）を、次の形で満たす。

1. **非回帰（最重要）** — `--unattended` を渡さない既存 fixture の期待値を **1つも変えない**。
2. **完走系** — 全 gate pass の世界で `--unattended` を渡し、**フラグ無しの run と同じ
   `status` / `stop_reason` / `waves[]` になる**こと。差分は `limitations` の
   `unattended_mode` / `unattended_baseline` **だけ**であることを assert する。
   これが「緩めない」の機械的証明であり、self-report の boolean より強い
   （runner が自分で「緩めていない」と主張する check は、緩めた実装でも true を書ける）。
3. **停止系** — 少なくとも次の 4 つ。いずれも `status` が `success` **でない**ことと、
   停止 code が名指しされることを assert する。
   - prompt 検出（exit 10）→ `human_required` / `human_input_required`、`human_required: true`
   - 裁定不能（exit 99）→ `verification_not_judged`、`human_required: true`
   - `open_questions` → 1人も dispatch していないこと
   - verification 不合格（exit 20 が上限まで残る）→ `verification_failed`
4. **unattended 固有の停止** — scope 未宣言の Issue を含む plan で、**`--out` が作られず
   （`out_dir: null`）、1人も dispatch されない**こと。フラグ無しの同じ plan では
   従来どおり他 Issue が dispatch されることを、同じ fixture 対で示す（**二点測定**。
   #100 第4節 (1) と同じ規律）。
5. **併用拒否** — `--unattended --auto-yes` / `--unattended --allow-questions` /
   `--unattended --contract-mode off` が **exit 3** で落ち、**何も mutate しない**こと。
6. **契約経路の必須化** — 契約非対応 CLI の fixture で、`--unattended` が
   `contract_unsupported` の **blocking**（`auto` の limitation ではない）になること。

---

## 13. 未決事項（実装前に実測で確定すること）

推測で実装しない。いずれも fixture か実機で確かめてから進む。

1. **cron の二重起動（再入）。** 前の run がまだ走っているときに次の cron が発火したらどうなるか。
   `--out` の `out_exists` は事実上の mutex になるが、**pre-flight で停止した run は `--out` を
   作らない**（#90）ので、その経路では mutex にならない。同じ worktree に 2 つの supervisor が
   `send` する状態を作れるかを実測し、作れるなら排他の owner（runner か job 定義か）を決める。
   **本 ADR は排他機構を裁定していない。**
2. **wall-clock budget が要るか。** 回数は有界だが時計は有界でない（第5節）。
   `--wait-timeout` × `--max-turns` × wave 数の実測から、無人運転で許容できる最大滞留時間を
   出す。要るなら、打ち切り時の status（`partial` か新値か）と、打ち切り時点の mutation の
   記録方法を先に決めること。**新しい `stop_reason` 値は schema version を上げる**（第11節）。
3. **uat の再merge 先。** `git merge --no-ff` は cwd 指定を持たない（`uat.mjs` 922行）ので、
   **invocation cwd の現在の branch** に merge される。CI が main を checkout した状態で
   段階 C を回すと何が起きるかを実測し、必要なら段階 C の前提として
   「integration branch に居ること」を pre-flight で検査する。
4. **`unattended_baseline` の SHA は取り消しに十分か。** worker が複数 commit を積んだ場合・
   worktree が既に片付いていた場合に `git reset --hard` が意図どおり効くかを実機で確かめる。
   効かない条件があるなら、それを取り消し手順の但し書きとして
   [SKILL.md](../SKILL.md) 第5節に書く。
5. **段階 B / C の PR / merge を無人で回したときの `gh` の対話性。** `gh pr create` /
   `gh pr merge` が TTY 非依存で完結するか（認証切れ・確認プロンプト）を CI 環境で実測する。
   対話に落ちる経路があれば、それは第6.3節に足すべき停止である。
6. **monitor 併用の実測。** `--no-auto-approve` 無しの monitor が unattended dispatch の
   prompt を実際に消費できるか（契約の `autoYes: mode: off` がサーバ側で止めるか）を
   実機で確かめる。止まるなら第4節の「塞げない穴」は穴ではなく、要件ではなく推奨に留められる。

**この 6 点は [#115](https://github.com/Kewton/commandmate-skills/issues/115) で測った。結果は第14節にある。**

---

## 14. Phase 0 の実測結果（Issue [#115](https://github.com/Kewton/commandmate-skills/issues/115)）

第13節の未決事項 6 点を、実装に入る前に測った。**本節は spike の記録である。`scripts/` は 1 行も
変えていない。**

測定環境: 本リポジトリ `37914e4` ／ macOS 26.6 ／ node v24.1.0 ／ git 2.49.0 ／ gh 2.86.0 ／
CommandMate 0.22.0（`/opt/homebrew/lib/node_modules/commandmate` の bundle を**読むだけ**。
#114 が第11節でやったのと同じやり方である）。**本節の行番号は `37914e4` 時点の実測値**であり、
第1〜13節の行番号（main = `3105722` 時点）とは別に取り直している。

測り方の原則を 3 つ置いた。
- runner を動かす測定は `tests/fixtures/cmate-orchestrate/fake-cli.mjs` を `--cli` / `--git` /
  `--gh` に渡して行い、**実 CommandMate のサーバを 1 度も呼んでいない**。
- git を要する測定は `mktemp -d` 配下に `git init` した使い捨てリポジトリだけで行い、
  既存の worktree・branch・remote に触れていない。
- `gh` は **非破壊**でだけ調べた。PR は 1 つも作っておらず、merge も push もしていない。

稼働中の他ワーカーへの副作用が無いことは tmux セッション数で確認した:
作業前 `tmux ls | grep -c mcbd-` = **21**、作業後 = **21**（`-L` 付きの専用 socket も含め、
tmux を触る実験そのものが不要だった。第14.6節は fixture と bundle の読みで足りた）。

各項は **測り方 → 実測値 → 結論** の順で書く。**測っていないことは「未測定」と明記する。**

### 14.0 結論の要約

| # | 未決事項 | 結論 | ADR への影響 |
|---|---|---|---|
| 1 | cron の二重起動 | **排他が要る。** 同じ worktree に 2 つの supervisor が交互に `send` する状態を fixture で再現した | 裁定の変更は無い（第13節が「裁定していない」と書いた穴が実在すると確定した）。owner の候補は 14.1 |
| 2 | wall-clock budget | **要る。** 既定で dispatch だけ wave 数 × 40 分、かつ**時計の上限が構造的に無い経路**が在る | 第1.5節の記述を訂正。第5節に測定への参照を追記 |
| 3 | uat の再merge 先 | **invocation cwd の branch。main を checkout した CI では main が進む。detached HEAD では「merged」と報告して**どこにも残らない | 第7.1節を訂正。**第8節 段階 C の前提に pre-flight 検査を追加** |
| 4 | `unattended_baseline` | **不十分。効かない条件が 4 つある**（うち 1 つは第7.2節の裁定が正しかったことの裏付け） | 第7.2節に但し書きを追記 |
| 5 | `gh` の対話性 | **`gh` は対話に落ちない。** 落ちうるのは `git push` の資格情報プロンプトである | 第6.3節に足すべき停止は**無い**。要求は停止ではなく job 定義側の環境変数 |
| 6 | monitor 併用 | **契約の `autoYes: mode: off` は monitor を止めない。** 穴は穴のままである | 第4節の「サーバ側の最後の砦」を訂正。`--no-auto-approve` は**要件のまま** |

### 14.1 (1) cron の二重起動 — **排他が要る。穴は第13節の想定より広い**

#### 測り方

`dispatch.mjs` の入口は、`out_exists` を投げる `existsSync(outDir)`（3359〜3360行）と、
実際にディレクトリを作る `mkdirSync(attemptDir, { recursive: true })`（3402行）が**離れている**。
あいだに pre-flight（3380行 `preflightDispatch`）と `--prepare-worktrees` の準備段
（3391〜3393行）が入る。この区間が排他の穴になるかを、2 プロセス同時起動で確かめた。

再現手順（次の実装者が組み直せる形で書く。専用のテストは追加していない）:

1. plan を作る。
   `node skills/cmate-orchestrate/scripts/orchestrate.mjs 200 201 --max-parallel 3 --run-id plan
   --profile-json tests/fixtures/cmate-orchestrate/profiles/node-fake.json
   --issue-json tests/fixtures/cmate-orchestrate/cases/02-explicit-dependency/issues.json
   --runs-dir <tmp>`
2. plan の各 issue の `worktree` path にディレクトリを作り、`cmate-verify-ok` を置く
   （node-fake profile の baseline は `cat cmate-verify-ok` なので、これが「検証 pass」になる）。
   `run_tests.mjs` の `setupWorktrees()` と同じ世界である。
3. scenario JSON（`cli_available` / `git.branch` / `gh.repo_access` / `workers` / `worktrees`）を
   書き、`CMATE_FAKE_SCENARIO` と `CMATE_FAKE_LOG` を渡す。
4. `dispatch.mjs --plan <plan> --cli <shim> --git <fake-cli> --gh <fake-cli> --out <同じ path>` を
   **2 本**、700 ms ずらして起動する。
5. `<shim>` は `fake-cli.mjs` へ素通しするだけの wrapper で、**最初の `ls` と毎回の `wait` に
   固定の sleep を挟む**。実 CommandMate の `ls` はサーバ往復、`wait` は worker の 1 ターンで、
   どちらもローカル fake では 0 秒に潰れてしまうためである。`CMATE_FAKE_LOG` は 1 行 1 JSON なので、
   どちらの run がどの worktree id へ `send` したかが読める。

#### 実測値

| 形 | 結果 |
|---|---|
| (a) 逐次（A 完走 → 同じ `--out` で B）| B は **exit 4 / `out_exists` / `out_dir: null`**。**mutex は効く** |
| (b) 同時（A の pre-flight を 2.5 s 遅らせ、B を +700 ms、同じ `--out`）| **両方 exit 0 / `status: success`。両方が同じ 2 つの worktree id に `send` した** |
| (c) 同時（`--out` を run ごとに変える。timestamp 付き出力先を使う cron の書き方）| **両方完走。`out_exists` は最初から関与しない** |
| (d) 窓の長さ | fake CLI（応答 0 秒）で process 起動から `--out` 作成まで **232 / 241 / 237 ms** |
| (e) `--prepare-worktrees` 付き | **2 本とも `worktree-setup` provider を 1 回ずつ呼んだ**（窓の中で worktree と branch が二重に作られる） |
| (f) `--resume`（[#98](https://github.com/Kewton/commandmate-skills/issues/98)）| **両方が attempt 2 を取り**、`resume-attempt-2/` に両方が書き、append-only の `attempt-history.jsonl` に `attempt: 2` の行が **2 本**並んだ。worker #200 には 8 + 8 = **16 回** `send` された |

(b) の `send` タイムライン（1 つの時計上に両 run を並べたもの。**交互に届いている**）:

```
+    0ms B send …-issue-201-…
+  832ms B send …-issue-201-…
+ 1667ms B send …-issue-201-…
+ 1722ms A send …-issue-201-…      ← A が同じ worktree に入ってくる
+ 2518ms A send …-issue-201-…
+ 2730ms B send …-issue-200-…
+ 3349ms A send …-issue-201-…
+ 3516ms B send …-issue-200-…
+ 4306ms B send …-issue-200-…
+ 4413ms A send …-issue-200-…
+ 5199ms A send …-issue-200-…
+ 6030ms A send …-issue-200-…
```

証跡も失われる: `dispatch-report.json` は同じ path に 2 度書かれ、**後の run が前の run の
report を上書きする**。(f) では append-only を設計思想にしている ledger（`nextAttemptNumber` は
「ディレクトリが無い最初の番号」で決める。541〜548行）に、同じ attempt 番号の行が 2 本並んだ。

#### 結論

**排他が要る。** `out_exists` が mutex になるのは「先行 run が既に `--out` を作り終えている」
場合だけで、**pre-flight 実行中・`--out` 可変・`--resume`** の 3 経路では成立しない。

第13節は「pre-flight で**停止した** run は `--out` を作らないので、その経路では mutex にならない」
と書いていた。実測はそれより広い: **停止しなかった run でも、pre-flight を走っているあいだは
`--out` が未作成なので窓が開いている。** しかもその窓には `--prepare-worktrees` の準備段
（worktree と branch を作る mutation）が入っている。

排他の owner の候補（**本 spike は裁定しない**。決めるのは段階 A の実装 Issue である）:

| 候補 | 形 | 効く範囲 | 弱点 |
|---|---|---|---|
| **A. runner** | worktree id ごとの lock を **pre-flight の前**に取り、プロセス終了で外す。`mkdirSync` を `recursive` 無しで呼ぶ／`openSync(…, 'wx')` はどちらも EEXIST で原子的に失敗するので、TOCTOU にならない | 同じ機械のすべての起動元（cron・人間・別 job）| kill -9 された run の stale lock の回収規則を決める必要がある。**`--out` を lock に流用してはいけない**（#90 は「pre-flight で止まった run は `--out` を消費しない」と決めている）|
| **B. job 定義** | GitHub Actions の `concurrency: group:`、cron 側の `flock` | 同じ job から出た run | **人間がローカルで叩いた run と cron の衝突を防げない。** 上の (b) はまさにその形である |
| **C. サーバ** | CommandMate が live な task を持つ worktree への 2 本目の `send` を拒否する | 全経路 | 上流の変更であり、本リポジトリでは決められない |

粒度は **worktree 単位**が正しい。害は「同じ worktree に 2 人の supervisor」であって
「同じ plan が 2 回」ではない —— 別の plan が同じ worktree を名指すことは起こりうる。

**未測定:** 実 CommandMate のサーバが、同じ worktree への 2 本目の `send` をどう扱うか
（候補 C が既に部分的に成立しているか）は測っていない。fixture の fake CLI は素直に受理する。

### 14.2 (2) wall-clock budget — **要る。理由は「長い」ことではなく「上限が無い経路が在る」こと**

#### 測り方

既定値はコードから読み、scaling は fake CLI で測った。

- `dispatch.mjs`: `DEFAULT_WAIT_TIMEOUT_SECONDS = 300`（150行）、`DEFAULT_MAX_TURNS = 8`（157行）、
  `hardIterations = maxTurns * 4 + 8`（2214行）。`DEFAULT_POLL_LIMIT = 120`（151行）は**死んでいる**
  （usage 自身が "Retained for compatibility; wait now blocks" と書いている。256行）。
- `uat.mjs`: 同じ 300 / 8 に加えて `DEFAULT_MAX_ATTEMPTS = 2` / `MAX_ATTEMPTS_CEILING = 5`
  （114〜115行）。
- `merge.mjs`: **待ち合わせループを持たない。** `gh pr checks` を 1 回読み、pending なら止まる
  （936〜939行）。無人 merge に時計の問題は無い。
- scaling: worker が `--max-turns` 目のターンでしか commit しない scenario を組み、shim が
  **すべての `wait` で `--wait-timeout` ぶん sleep する**ようにして、
  `waves × --max-turns × --wait-timeout` と実測を突き合わせた。

#### 実測値

| waves | `--max-turns` | `--wait-timeout` | 式の値 | 実測 | `send` 回数 |
|---|---|---|---|---|---|
| 2 | 8 | 1 s | 16 s | **21.2 s** | 16 |
| 2 | 8 | 2 s | 32 s | **38.3 s** | 16 |
| 2 | 4 | 1 s | 8 s | **11.4 s** | 8 |
| 1（**幅 3・並列**）| 8 | 1 s | 8 s | **11.5 s** | 24 |

最後の行が要点である: 1 つの wave に 3 issue を入れると `send` は 24 回に増えるのに、
**壁時計は 1 人のときと変わらない**（`runCmAsync` で wave 内は同時に監督されるため）。
**wave 幅は時計に掛からない。** したがって上限は

```
waves × --max-turns × --wait-timeout  +  ターンあたりのオーバーヘッド（fake CLI で 0.3〜0.4 s。実サーバではもっと大きい）
```

既定値に入れると: worker 1 人あたり **8 × 300 s = 40 分**、3 wave の plan で **2 時間**、
`max_parallel 1` の 10 issue plan で **6 時間 40 分**。uat は ceiling 5 を使うと fix worker の
監督だけで **3 時間 20 分**。

**ただしこの式に入らない経路が在る。** profile baseline（契約なし経路の検証・UAT の機械ゲート・
準備段の baseline）は `runCli` 経由で `execFileSync` に渡されるが、**`runCli` は `timeout` を
渡していない**（`dispatch.mjs` 783〜790行 ／ `merge.mjs` 242〜249行 ／ `uat.mjs` 343〜350行 の
いずれにも `timeout:` が無い。3 runner 通して `timeout:` は 1 箇所も存在しない）。

実測: baseline を `["sleep 6"]` にした profile で `--wait-timeout 1 --max-turns 1
--contract-mode off` を回すと、run は **12.9 秒**かかった（2 wave × 6 s）。
**`--wait-timeout` はこの時間に一切効かない。**

#### 結論

**wall-clock budget は要る。** 決め手は「40 分 × wave 数が長すぎる」ことではなく、
**時計の上限が構造的に存在しない経路（baseline / acceptance コマンド）が在る**ことである。
第1.5節の「wall-clock は `--wait-timeout` × ターン数で暗黙に決まるだけ」は正しくない ——
暗黙にすら決まらない部分がある。**該当節を訂正した。**

打ち切り時の扱いの候補（**本 spike は裁定しない**）:

| 論点 | 候補 | 根拠 |
|---|---|---|
| status | **`partial`（exit 7）** | 第6.1節の写像を変えない。「途中停止。成功ではない」がそのまま当てはまる |
| stop_reason | **`timeout` を再利用する。新値を作らない** | enum に既に在る（第6.2節の `worker_timeout` 行）。**新値は schema version を上げる**（第11節）ので、上げずに済むならそうする |
| 何が起きたかの名指し | `blocking_reasons` に **`wall_clock_budget_exhausted`** を 1 件。`$defs/entry` は `code` / `detail` の 2 key の自由文字列なので additive ですらない | #93 が `worktree_setup_*` で確立した経路（第10節 案 I）と同じ |
| 打ち切り時点の mutation の記録 | **新しい機構は要らない。** 第7.2節の `unattended_baseline`（開始時 SHA）と、report に既に在る `waves[].workers[].state` が「どこまで進んだか」を持っている | 打ち切りは worker ループの外側で判定できるので、report は通常経路と同じ組み立てで書ける |
| どの runner が持つか | **dispatch と uat のみ。** merge は待ち合わせループを持たない | 上記の実測 |
| baseline の無制限 | **budget とは別の穴である。** `runCli` に `timeout` を渡すかどうかは 3 runner 共通の変更で、budget より先に決める必要がある | budget だけ足しても、baseline が固まった run は budget の判定点に到達しない |

最後の行が重要である。**budget を worker ループの回数境界にだけ置くと、無限に走る baseline は
budget を越えたことにすら気づかれない。** 順序は「まず `runCli` の timeout、次に budget」である。

### 14.3 (3) uat の再merge 先 — **cwd の branch。detached HEAD では「成功」と報告して消える**

#### 測り方

`uat.mjs` **922行**（`grep -n "merge', '--no-ff'" skills/cmate-orchestrate/scripts/uat.mjs` で確認。
第7.1節・第13節が書いている行番号は `37914e4` 時点でも正しい）は

```js
const merged = runCli(inputs.git, ['merge', '--no-ff', '--no-edit', branch]);
```

で、`extra` を渡していないので **cwd は uat プロセスのそれ**である。使い捨てリポジトリ
（`mktemp -d` + `git init -b main`）に base commit・`integration` branch・
`feature/issue-1-uat-fix-1` を作り、CI が取りうる 4 つの cwd / HEAD で同じコマンドを撃った。

#### 実測値

| cwd / HEAD | merge exit | 何が起きたか |
|---|---|---|
| **`main` を checkout**（branch push を受けた CI の既定）| **0** | **`main` が進んだ。** merge commit が main に載り、`integration` は動かない。PR も CI も review も経ていない |
| **detached HEAD**（`actions/checkout` が SHA を取ったとき）| **0** | merge commit はできるが**どの branch からも到達できない**。`main` も動かない。`merged.ok` は true なので **uat は `outcome: merged` と報告する** |
| fix branch がこの checkout に存在しない | 1 | `merge: … - not something we can merge` → `remerge_failed`（**正しい停止**）|
| cwd が別 branch の linked worktree | 0 | その worktree の branch が進む |

#### 結論

第13節の推測どおり **invocation cwd の現在の branch に入る**。危険は 2 つあり、
**片方は本 ADR が想定していなかった**。

1. **CI が `main` を checkout した状態で段階 C を回すと、UAT の fix が誰のレビューも経ずに
   main に入る。** 第7.1節はこの mutation を「ローカル可逆」と評価していたが、その評価は
   「cwd が integration worktree である」という前提の上にしか立たない。cwd が `main` で、
   その `main` が push 済みなら**不可逆**である。**第7.1節を訂正した。**
2. **detached HEAD では「再merge した」と報告しながら、成果物がどの ref にも残らない。**
   `remerge_failed` は出ない。第6.4節の停止語彙では捕まらない**静かな false success** である。
   無人運転では、これは「UAT を通した」と報告された run の成果が消えることを意味する。

したがって段階 C の前提として、**invocation cwd が integration branch に居ることの
pre-flight 検査**が要る。**第8節の段階 C の前提にこれを足した。** 検査は 2 つでよく、
どちらも dispatch が `branch_matches` drift check（`dispatch.mjs` 876〜881行）で
既に持っている形をそのまま置ける:

- `git symbolic-ref -q HEAD` が空でないこと（**detached でない**こと）
- HEAD が期待する integration branch と一致すること

**未測定:** 実際の CI（GitHub Actions）で `actions/checkout` がどちらの形を作るかは、
リポジトリと trigger の設定次第であり、本 spike では確かめていない。上の裁定はそれに依らない ——
**どちらの形でも壊れる**ので、検査する側に倒すのが答えである。

**実装は [#142](https://github.com/Kewton/commandmate-skills/issues/142)（第17.4〜17.5節）。**
`git symbolic-ref -q HEAD` 1回で両方を答え、比較対象は新設の `--expect-branch` である。

### 14.4 (4) `unattended_baseline` — **効かない条件が 4 つある**

#### 測り方

使い捨てリポジトリに worktree を 1 つ作り、`git rev-parse --short HEAD` を baseline として
控えたうえで、次の 4 条件で `git reset --hard <baseline>` を試した。

(a) worker が 3 commit を積み、untracked file と未 commit の変更を残した ／
(b) その work が既に integration branch へ merge されている ／
(c) worktree が既に片付いている（`git worktree remove --force` 済み）／
(d) worktree も branch も消えたあと `git reflog expire --expire-unreachable=now --all` と
`git gc --prune=now` が走った。

#### 実測値

| 条件 | `git reset --hard <baseline>` | 残るもの |
|---|---|---|
| (a) 複数 commit ＋ 未 commit の変更 | exit 0。HEAD は baseline に戻り、tracked file の変更も消える | **untracked file は残る。** 実測 2 件: `untracked.log` と `.commandmate/tasks/issue-1.yaml` |
| (b) work が integration に merge 済み | exit 0（worktree の branch は戻る）| **integration 側の commit はそのまま残る** |
| (c) worktree が片付いている | **exit 128** `cannot change to '…': No such file or directory` | branch は生きている。**`git branch -f <branch> <baseline>` なら exit 0 で戻せる** |
| (d) worktree も branch も消えて gc 済み | 実行不能 | gc 前は `rev-parse` が解決する。gc 後は **object ごと消える**（`rev-parse` が失敗）|

短縮 SHA そのものについて: git は 4 文字未満の prefix を object 名として扱わない
（2 文字では `ambiguous argument …: unknown revision`）。4 文字で衝突を作れば
`error: short object ID 02b0 is ambiguous` になる。`--short` は**記録した時点で一意**な長さを
選ぶだけで、**記録した文字列は後から伸びない。**

#### 結論

**短縮 SHA だけでは取り消しに十分ではない。効かない条件は 4 つある。**

1. **untracked file は戻らない。** 完全に戻すには `git clean -fdx` が要るが、それは worker が
   作った成果物も消す —— 取り消し手順としては別の判断であり、無人で機械にやらせるものではない。
2. **下流に流れた後は戻らない。** merge / push 済みなら worktree の branch を戻しても意味がない
   （第7.1節の merge 行が既にそう言っている）。**baseline が担保するのは最下流の 1 段だけ**であり、
   取り消しは上流から順に行う。
3. **worktree が消えていると `git reset` は使えない。** 使えるのは
   `git branch -f <branch> <baseline>` である。**第7.2節が「branch 名と短縮 SHA で書く。
   絶対 path は書かない」と決めたのは、この経路で正しかった** —— path ではなく branch 名だから、
   worktree が無くても手が届く。実測が裁定を裏付けた例である。
4. **branch も消えて gc が走ると復元できない。** 常に危険なわけではない: baseline が base branch
   から到達可能なら object は生き続ける。危険なのは **baseline が base から到達できないとき**、
   すなわち `--prepare-worktrees` が既存 worktree を再利用した場合（#93）や、
   前の run の commit の上に baseline が乗っている場合である。

**第7.2節にこの但し書きを追記した。** 第13節は「取り消し手順の但し書きとして SKILL.md 第5節に
書く」としているが、**SKILL.md は本 spike の変更範囲外**なので、実装段（第12節 段 2）で持ち込むこと。

### 14.5 (5) `gh` の対話性 — **`gh` は対話に落ちない。落ちうるのは `git push` である**

#### 測り方

**すべて非破壊で調べた。PR は 1 つも作っておらず、merge も push もしていない。**

1. 対話に落ちる条件を `gh help environment` ／ `gh pr create --help` ／ `gh pr merge --help` から読む。
2. runner が実際に何を渡しているかをコードから読む（`merge.mjs` 695行 push ／ 699〜712行
   `pr create` ／ 743行 `pr merge`）。
3. **認証切れ**: `GH_TOKEN=<不正な値> gh pr list --repo …`（read-only）と `gh auth status`。
   `GH_TOKEN` は保存済み資格情報より優先されるので、keyring には触らない。
4. **非対話の拒否**: **`--title` を渡さない** `gh pr create` を stdin を閉じて実行する
   （title 無しでは PR を作れないので、成功しえない）。
5. **`git push` 側**: 実在しない repo への `git ls-remote`（read-only）を
   `-c credential.helper=` で helper を無効化して実行し、資格情報プロンプトが出るかを見る。
   pty の有無で 2 度測る。

#### 実測値

- `gh help environment` は **`GH_PROMPT_DISABLED`**（"set to any value to disable interactive
  prompting in the terminal"）を持つ。`gh config get prompt` は既定で `enabled`。
- **認証切れ**: `GH_TOKEN=bogus… gh pr list …` → `HTTP 401: Bad credentials` と
  `Try authenticating with: gh auth login` を**表示して即座に非ゼロ終了**。
  ログインプロンプトは出ない。`gh auth status` も同様に「invalid」と表示して終わる。
- **非対話の拒否**: `--title` 無しの `gh pr create` は **exit 1** で
  ``must provide `--title` and `--body` (or `--fill` …) when not running interactively``。
  ネットワークに出る前に落ちた。**gh は TTY が無いことを自分で判定し、待たずに落ちる。**
- **runner の渡し方**: `pr create` には `--repo --base --head --title --body-file` が揃っている
  （699〜712行）ので、gh が尋ねる 3 つ（push 先・title・body）はすべて塞がっている。
  `--head` を明示するのは gh の help が
  "Use `--head` to explicitly skip any forking or pushing behavior" と書く経路そのものである。
  `pr merge` には `--repo` と `--merge|--squash|--rebase` のいずれかが**必ず**付く（743行）ので、
  merge 方式の選択プロンプトに落ちる余地が無い。`--delete-branch` は渡していないので、
  branch 削除の確認も出ない。
- 3 runner とも `runCli` は **`stdio: ['ignore', 'pipe', 'pipe']`** で子を起動する
  （`dispatch.mjs` 787行 ／ `merge.mjs` 246行 ／ `uat.mjs` 347行）。**stdin は常に閉じ、
  stdout は pipe** なので、gh の `CanPrompt()` は必ず false になる。
- **落ちうるのは `gh` ではなく `git push` である。** git の資格情報プロンプトは stdin ではなく
  **`/dev/tty`** を読む。制御端末を持たないプロセス（＝CI の runner。本測定の実行環境もそうだった）
  では `fatal: could not read Username for 'https://github.com': Device not configured` で落ちる。
  `GIT_TERMINAL_PROMPT=0` を置くと `terminal prompts disabled` という明示的な失敗になる。
  一方、**同じコマンドを pty の下（`script -q /dev/null …`）で走らせると、git は
  `Username for 'https://github.com':` を実際に印字した。** すなわち
  **制御端末を持つ起動元（tmux ペインから起動した cron、人間の shell）では、
  `stdio: ['ignore', …]` はプロンプトを止めない。**

#### 結論

**`gh pr create` / `gh pr merge` は TTY 非依存で完結する。第6.3節に足すべき停止は無い。**
認証切れも確認プロンプトも、gh は**待たずに非ゼロで落ち**、既存の `pr_create_failed` /
`merge_failed` / `preflight_failed` がそれを受ける。第13節が言う「対話に落ちる経路」は
gh 側には見つからなかった。

足すべきは停止ではなく**入力の衛生**である。無人運転では job 定義側で

- `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）
- `GIT_TERMINAL_PROMPT=0`

を置くこと。runner がこれを検査しないのは第4節の monitor と同じ理由（別プロセスの環境を
runner は保証できない）だが、**プロンプトが「止まる」ではなく「無言で待つ」に化ける唯一の経路**
なので、段階 B の実装時に契約文書へ書き残すこと。

**未測定:**
- 本当の対話端末（入力側が生きた pty）で `git push` が**無限に待つ**ことは確かめていない。
  測ったのはプロンプトが**印字される**ところまでで、そこでは stdin が EOF だったため失敗した。
- `gh pr merge` 自身の
  ``--merge, --rebase or --squash required when not running interactively`` は出していない。
  実在の PR が要るためである。方式フラグを必ず渡すのでこの分岐に到達しない、というのは
  **コードの読み**であって実測ではない。なお `gh pr merge` は**repo の解決を先に行う**ことは
  実測した（存在しない repo を指すと GraphQL の解決エラーで落ちる)。

### 14.6 (6) monitor 併用 — **契約の `mode: off` は monitor を止めない。穴は穴のままである**

#### 測り方

**実 CommandMate のサーバにも `mcbd-*` セッションにも触れていない。**

1. monitor が prompt に Enter を送るかどうかの判定をコードから読む:
   `monitor.sh` 501〜517行（`AUTO_APPROVE` → `ml_prompt_enter_verdict` → `send_to_pane`）、
   `monitor-lib.sh` 267〜299行（判定本体）と 204〜206行（`ml_autoyes_suppressed`）。
   `send_to_pane` の実体は **`tmux send-keys -t mcbd-<cliToolId>-<worktreeId> Enter`**
   （`monitor.sh` 271〜292行）である。
2. 判定の入力である `autoYes.lastSuppression` を**誰が書くか**を、インストール済み
   CommandMate 0.22.0 の bundle を**読んで**確かめた（#114 が第11節でやったのと同じ手）。
3. `ml_prompt_enter_verdict` を、`tests/fixtures/cmate-orchestrate-monitor/fixtures/
   prompt-yes-no.json` の `autoYes` ブロックだけ差し替えた 2 つの payload に対して実行した
   （`bash -c '. skills/cmate-orchestrate-monitor/scripts/monitor-lib.sh;
   ml_prompt_enter_verdict <file>'`。**fixture 本体は変更していない**）。

#### 実測値

契約の `mode: 'off'` は**サーバ側で確かに効く**。`dist/server/src/lib/polling/auto-yes-resolver.js`
の `evaluatePolicyAgainstTexts` は `policy.mode === 'off'` なら `{ reason: 'mode-off' }` を返す
（＝サーバは自動応答しない）。第1.3節のコメントが書いている性質はここまでは正しい。

**しかし、その事実が `capture --json` に出るのは、サーバの Auto-Yes poller が回っているときだけ
である。** bundle の 3 点をつなぐと:

- `lastSuppression` を記録する `recordPolicySuppression` は
  `dist/server/src/lib/auto-yes-poller.js` の `detectAndRespondToPrompt` の中に**しか無い**。
- その poller を起動する `startAutoYesPolling` は
  `if (!autoYesState?.enabled) return { started: false, reason: 'auto-yes not enabled' }` で始まる。
- `dist/server/src/lib/session/current-output-builder.js` が payload に載せる
  `autoYes.lastSuppression` は `getLastPolicySuppression(worktreeId, cliToolId, instanceId)` の
  戻り値そのものである。

したがって **unattended dispatch が作る世界では `autoYes.lastSuppression` は存在しない**:
runner は `auto-yes on` を打たず、`--unattended --auto-yes` は第4節で拒否されるので、
その worktree で Auto-Yes が enabled になることが無い。

monitor の判定（実測）:

| payload の `autoYes` | `ml_prompt_enter_verdict` |
|---|---|
| `{ enabled: false }` ＝ **unattended dispatch 中の実際の姿** | **`approve`** |
| `{ enabled: true, lastSuppression: { reason: 'mode-off', … } }` | `hold:policy`（理由 `mode-off`）|

1 行目の payload は fixture の `realtimeSnippet` が
`⏺ Bash(rm -rf build/)` / `Do you want to proceed?` であるもの、つまり
**`rm -rf` の承認プロンプトに Enter を送る**という判定である。

#### 結論

**契約の `autoYes: mode: off` は monitor を止めない。第4節の「塞げない穴」は穴のままである。**

しかも止まる条件が逆立ちしている: monitor が `hold:policy` に落ちるのは `lastSuppression` が
記録されているときだけで、それが記録されるのは**サーバ側 Auto-Yes が有効なとき**、
すなわち **unattended が禁じているまさにその状態のとき**だけである。

第4節の「**契約の `autoYes: mode: off` がサーバ側の最後の砦である**」は成り立たないので
**訂正した**。同節の残り 2 つの帰結（unattended で monitor を併用するなら `--no-auto-approve` は
**要件**である／runner はこれを検出しない）は**変更しない** —— 実測はむしろ両方を強めている。
第13節が置いた条件「止まるなら…要件ではなく推奨に留められる」は**満たされなかった。**

**未測定:** 実機で monitor と unattended dispatch を同時に走らせ、monitor の Enter が
dispatch の `wait --on-prompt agent`（exit 10）より先に届くかという**競争そのもの**は測っていない。
上の結論はそれに依らない —— **monitor が「Enter を送る」と判定すること自体**が示せれば、
`--no-auto-approve` を要件に据える根拠として十分だからである。どちらが勝つかは実機が要る。

### 14.7 この spike が測らなかったこと

推測で埋めないために、明示的に残す。

| 未測定 | 何が要るか |
|---|---|
| 実 CommandMate サーバが同じ worktree への 2 本目の `send` をどう扱うか（14.1 候補 C）| 実機。稼働中の worker を巻き込まずに測る手順が別途要る |
| 実 CI（GitHub Actions）の `actions/checkout` がどちらの HEAD を作るか（14.3）| 実 CI。ただし裁定はこれに依らない |
| 対話端末つきで `git push` が無限に待つこと（14.5）| 入力側が生きた pty。本 spike の実行環境には制御端末が無かった |
| `gh pr merge` の非対話拒否メッセージ（14.5）| 実在する PR。方式フラグを必ず渡すので到達しない、はコードの読みである |
| monitor の Enter と dispatch の exit 10 の競争（14.6）| 実機 |

---

## 15. 実装で変えたこと（Issue [#122](https://github.com/Kewton/commandmate-skills/issues/122)。第12節 段 1〜6）

本 ADR の運用規約（冒頭）に従い、**段階 A の実装で形が変わった点と、本 ADR が裁定を委ねていた
点をどう裁定したか**を記録する。正本は [dispatch-contract.md](./dispatch-contract.md)
第1節・第2.7節・第3.0節・第3.0.3節・第3.0.4節・第5節、[../SKILL.md](../SKILL.md) 第3節・第4節・第5節、
段階 C の前提は [uat-contract.md](./uat-contract.md) 第5.1節である。

**裁定 0（第2節）と第6.1節の写像は1文字も変えていない。** 以下はすべて「締め付けの形」の話である。

### 15.1 排他は **runner が持つ**（第14.1節が委ねた裁定）

候補 **A（runner の lock）** を採った。B（job 定義）は「人間がローカルで叩いた run と cron の衝突を
防げない」という第14.1節の弱点がそのまま残り、C（サーバ）は上流の変更で本リポジトリでは決められない。

決めた形（正本は dispatch-contract 第3.0.3節）:

| 論点 | 裁定 |
|---|---|
| 粒度 | **worktree 単位。** key は `(repository, branch)` から導く —— CommandMate が worktree id を導くのと同じ組で、`commandmate ls` を叩く前（＝ pre-flight の前）に決まる唯一の識別子である。**サーバの id と一致する必要は無い**（誰も突き合わせない）。要るのは安定と一意だけである |
| 取る時点 | **pre-flight の前。** 第14.1節が測った窓（process 起動〜`--out` 作成、その内側に `--prepare-worktrees` の mutation）を閉じるには、pre-flight の後では遅い |
| 対象 | **この attempt が dispatch しうる Issue 全部**（`--resume` では引き継がない分だけ）。**all-or-nothing** |
| 原子性 | `mkdirSync`（`recursive` 無し）の **EEXIST**。所有者情報は取得の**後**に書く（TOCTOU を作らない）。回収後の取り直しは**1回だけ**（ここでループすると自分で TOCTOU を作る） |
| stale の回収 | **4規則**（この host の生きた pid → 拒否 ／ この host の死んだ pid → **回収**（`kill -9` の経路）／ 別 host → 拒否 ／ 所有者情報が読めない → 60 秒の猶予つきで回収）。**拒否は常に安全側の誤り**である |
| 置き場所 | `$CMATE_ORCHESTRATE_LOCK_DIR`、既定は `$TMPDIR/cmate-orchestrate-locks/<key>`。**`--out` は流用しない**（#90 の決定を壊すため） |
| 停止形 | `blocking_reasons` の **`unattended_locked`** ／ `dispatch_error` ／ `failure`（exit 1）／ `--out` 未作成 ／ **`human_required: false`**（人間の判断ではなく時間で解ける停止であり、CI が読むべき signal もそれである） |

**本 ADR から形が変わった点が1つある: lock を取るのは `--unattended` の run だけである。**
第14.1節の候補 A は「同じ機械のすべての起動元」に効くと書いていたが、それを満たすには
フラグ無しの run も lock を取る必要があり、**第11節の「`--unattended` を渡さない run は 1 bit も
変わらない」と両立しない**（lock file の生成も、2本目の拒否も、観測できる挙動の変化である）。
第11節は努力目標ではなく fixture 化された要件なので、そちらを優先した。

**結果として残る穴を明示する:** 人間がローカルで叩いた素の run と cron の unattended run の衝突は
runner 側では防げない。第14.1節の (b) がまさにその形である。閉じたい運用は job 定義側
（`flock` / `concurrency:`）を併用するか、候補 C（サーバ側）を上流に起こすこと。
**測っていないものを「防いだ」とは書かない**という本 ADR の規律に従い、契約文書にもそう書いてある。

### 15.2 wall-clock budget は `--wall-clock-budget`、**unattended では明示必須**（第14.2節）

status は `partial`（exit 7）、`stop_reason` は既存 enum の **`timeout` を再利用**、名指しは
`blocking_reasons` の **`wall_clock_budget_exhausted`** —— ここは第14.2節の候補表そのままで、
**`stop_reason` の enum にも field にも1つも足していない**（`dispatch_schema_version` は 1 のまま）。

第14.2節から**変えた**のは2点である。

1. **「まず `runCli` の timeout、次に budget」を、2段ではなく1つの規則にした。**
   第14.2節は「budget を worker ループの回数境界にだけ置くと、無限に走る baseline は budget を
   越えたことにすら気づかれない」と警告している。そこで **残り budget を、この run が起動する
   子プロセスすべての timeout にした**（呼び出し側が自分で `timeout` を決めている子はそのまま）。
   `runCli` に無条件の timeout を足す案は採らなかった —— それは3 runner 共通の挙動変更で、
   `--unattended` を渡さない run を変えてしまう（第11節）。budget が無い run では、この規則は
   何も足さない。
2. **判定点を「ターン境界の前」だけでなく「`wait` の後」にも置いた。** budget 自身の timeout で
   殺された `wait` を「worker の失敗」と読み替えないためである。時計を止めたのは runner であって
   worker ではなく、`worker_failed` と報告すると operator は worker のログを読みに行かされる。

**明示必須にしたのは本 ADR に無い判断である。** 第5節が uat の `--max-attempts` について書いた理由
（「何回まで機械に直させてよいかを誰かが決めた、という事実は、無人では job 定義を書く時点でしか
決められない」）が、時計にはそのまま当てはまる。既定値を黙って入れると、その決定が
「誰も決めていない」に戻る。したがって `--unattended` かつ `--wall-clock-budget` 無しは
`invalid_input`（exit 3）である。

### 15.3 pre-flight は scope と open question を**同時に**報告する（第3節の実装形）

第3節は scope 検査だけを pre-flight に置くと書いていた。実装では **plan だけで決まる門を1箇所に
まとめ**、`open_questions` と `contract_scope_unknown` を**同じ refusal で**報告する。

理由: **scope を宣言できない Issue は、ほぼ必ず planner の `no_suspected_files` question も持つ**
（planner は `suspected_files` が空なら必ず question を書く）。片方だけを報告すると、直し方の半分が
消える。加えて `--unattended` では `--allow-questions` が拒否されるので、open question の停止は
どのみち避けられない —— それを `--out` を作ってから報告する意味が無い。**副作用として
`open_questions` の停止も unattended では `--out` を消費しなくなった**（フラグ無しの run では
従来どおり `--out` を作って artifact も書く。第11節の互換は保たれる）。

**判定条件も第3節の字面から変えた。** 検査するのは plan の `suspected_files` が空かどうかではなく、
**その Issue の実行契約が `scope.allow` を宣言できるか**である（絶対 path・`..` 脱出・長すぎる pattern
などは契約 parser が拒否するので runner 側で落としている）。wave の中の拒否がまさにその条件で
動いているので、pre-flight で別の条件を使うと**二重の基準**になる。

`human_required` は **true** にした。第6.2節の表はこの停止に印を付けていないが、`human_required` の
定義（schema の "None of the three is resolvable by re-dispatching"）にそのまま当てはまる ——
直し方は Issue 本文の編集と re-plan であって、再 dispatch では絶対に解けない。CI が同じ plan を
再実行し続けるのを止めるのが、この field の役目である。

### 15.4 `gh` には停止を足していない（第14.5節どおり）

**第6.3節に足した停止は無い。** 代わりに job 定義側の環境変数（`GH_TOKEN` /
`GIT_TERMINAL_PROMPT=0`）を [runner-operations.md](./runner-operations.md) 第10節に書いた
（#135 の移送前は [../SKILL.md](../SKILL.md) 第3.2節）。第14.5節の実測どおり、
無人運転を実際に止めるのは `gh` ではなく **`git push` の資格情報プロンプト**であり、
それは「止まる」ではなく**無言で待つ**に化ける唯一の経路である。**runner はこれを検査しない**
（別プロセスの環境を runner は保証できない。第4節の monitor と同じ理由）。

### 15.5 `--no-auto-approve` は要件として SKILL.md に書いた（第14.6節どおり）

第4節の「サーバ側の最後の砦」は第14.6節が訂正済みで、砦は無い。
[runner-operations.md](./runner-operations.md) 第11節の monitor 境界に（#135 の移送前は
SKILL.md 第3.2節）、
**unattended と併用するなら monitor 側の `--no-auto-approve` は要件である**ことと、その理由
（`autoYes.lastSuppression` はサーバ側 Auto-Yes が有効なときしか書かれず、unattended はまさにその状態を
禁じているので、monitor の判定は `approve` になる）を書いた。**runner は検出しない。**

### 15.6 段階 C の前提は uat 契約に書いた（第14.3節どおり、実装はしていない）

[uat-contract.md](./uat-contract.md) に第5.1節を新設し、再merge が invocation cwd の branch に入ること・
`main` checkout と detached HEAD の実測結果・**段階 C では fix worktree を作る前に
`git symbolic-ref -q HEAD` と integration branch 一致を検査して停止すること**を前提として記録した。
**本 Issue では実装していない**（uat runner は `--unattended` を受け付けない）。

### 15.7 未実装の段の拒否は、既存の挙動で満たされている（第8節）

`merge.mjs` / `uat.mjs` に `--unattended` を渡すと、両者の `parseArgs` が未知の option を拒否し、
既存の変換で `invalid_input`（exit 3）になる。**コードを1行も足さずに第8節の要求
（受理して無視しない）を満たしている**ので、そのまま採った。**そのうえで fixture で固定した** ——
後の段階がこの拒否を黙って外せないようにするためである。

### 15.8 version は上げていない（本 Issue の実行契約による）

第11節と #95 要件3 は minor bump を求めており、`commandmate.skill.yaml` の `version:` と
`scripts/lib.mjs` の `SKILL_VERSION` を同時に上げるのが本リポジトリの作法である
（`scripts/validate.py` の `check_version_constant` が両者の一致を強制する）。
**本 Issue の実行契約は `scripts/lib.mjs` を変更対象に含めておらず、`version:` 行の変更も禁じている**
ため、bump は行っていない。**リリース時に両方を同一 commit で上げること。**

---

## 16. 実装で変えたこと（Issue [#134](https://github.com/Kewton/commandmate-skills/issues/134)。第12節 段 7 ＝ 段階 B）

段階 B は **`merge.mjs --create-prs --unattended`** だけである。正本は
[merge-contract.md](./merge-contract.md) 第2節・第5.3節・第6節・第9節と
[../SKILL.md](../SKILL.md) 第3.3節・第5節。**裁定 0（第2節）と第6.1節の写像は1文字も変えていない。**

第8節の段階表が段階 B に割り当てた締め付けは1つ（`change_evidence_unavailable` の昇格）で、
実装もその1つだけである。**`merge_schema_version` は 1 のまま、`stop_reason` の enum にも
target `outcome` の enum にも値を足していない。** 昇格した停止は既存の `pr_create_failed`
（target は `pr_failed`）で受け、何が起きたかを名指しするのは `blocking_reasons[]` の code である
—— 第15.2節が `wall_clock_budget_exhausted` に採ったのと同じ形である。

以下は本 ADR から**形が変わった点**と、ADR が明示していなかった点をどう裁定したかである。

### 16.0 第6.5節の見出しと第8節の段階表が矛盾していた（訂正済み）

第8節の段階表は `change_evidence_unavailable` の昇格を**段階 B** に割り当てているのに、
第6.5節は見出しを「段階 C でだけ blocking に昇格するもの」とし、本文にも
「段階 A / B ではいずれも limitation のままである」と書いていた。**第8節が正しい**
（#134 の Issue 本文も段階表を引いている）。第6.5節に訂正の但し書きを足した。
段階 C に残るのは `verification_gates_unrecorded`（dispatch）だけである。

### 16.1 昇格は `--approve` ではなく `--unattended` に紐づく（本 ADR に無い判断）

第6.5節は昇格の理由を「無人で不可逆な操作をするとき」と書いており、字面どおりなら
`--approve` が無い preview では昇格しないことになる。**実装では `--unattended` だけを条件にした。**

理由は2つある。

1. **preview は無人運転では「読まれる出力」ではなく「次の job の入力」である。** 人間が居る運転の
   preview は人が読んで判断するための出力だが、無人運転で preview → `--approve` と2段に分ける
   job 定義にとって、preview の `status` は「この先へ進んでよいか」の signal そのものである。
   証拠を読めない Issue が在ることを preview が `success` と報告すれば、次の job はそのまま
   mutation 段に進む。**昇格を preview に効かせないと、昇格は1段ずれて無意味になる。**
2. **`--unattended` は invocation の性質の宣言であって、mutation の有無の宣言ではない**（裁定 0）。
   昇格の条件に `--approve` を混ぜると、「この宣言が何を意味するか」が別のフラグに依存し始める。

これは締め付けの側の拡張なので、裁定 0 の「含意するのは締め付けだけである」に反しない。

### 16.2 昇格した Issue の PR 本文は書かない（ADR が触れていなかった点）

`--unattended` で昇格した Issue については、`pr-bodies/issue-<n>.md` を**書かずに**停止する。
本文を書いてから停止すると、artifact だけを見た読み手には「PR は作られたが本文が残っている」と
「PR を作らずに本文だけ残した」の区別が付かない。**作らない PR の本文を残さない。**

### 16.3 `branch_changed_outside_declared_scope` を昇格しないことを fixture で固定した

第6.5節は「昇格しない」と裁定しているが、**裁定は「足さなかった」という形でしか実装に現れない**
ので、後から「ついでに」昇格されても誰も気づかない。そこで twin fixture の世界を
**scope 外変更を1件持つ**ものにした —— フラグの有無にかかわらず両 run が
`branch_changed_outside_declared_scope` を limitation として持ち、unattended 側の差分が
`unattended_mode` の1件だけであることを assert する。limitation が空の世界で比較すると、
「保たれた limitation」と「消えた limitation」を区別できない。

### 16.4 `gh` には停止を足していない（第14.5節どおり。第15.4節と同じ）

**第6.3節に足した停止は無い。** 代わりに job 定義側の環境変数（`GH_TOKEN` /
`GIT_TERMINAL_PROMPT=0`）を merge 契約 第5.3節と [../SKILL.md](../SKILL.md) 第3.3節に書いた
（段階 A で dispatch について書いた記述と同じ内容である）。無人運転を実際に止めるのは `gh` では
なく **`git push` の資格情報プロンプト**であり、それは「止まる」ではなく**無言で待つ**に化ける
唯一の経路である。**runner はこれを検査しない。**

### 16.5 未実装の段の拒否は、merge では runner が自分で行う（第15.7節からの変化）

第15.7節は「`merge.mjs` / `uat.mjs` の `parseArgs` が未知 option を拒否するので、コードを1行も
足さずに第8節の要求を満たしている」と記録した。段階 B で `merge.mjs` は `--unattended` を
**知っている** option にしたので、その道は `--merge-prs` については塞がった。したがって
**`--merge-prs --unattended` の拒否は runner が明示的に行う**（`invalid_input` / exit 3、
理由を detail に書く）。`uat.mjs` は依然として `parseArgs` の拒否のままで、そちらも fixture で
固定してある。

dispatch の緩和フラグ（`--auto-yes` / `--allow-questions` / `--contract-mode`）は `merge.mjs` に
存在しないので、引き続き `parseArgs` が同じ `invalid_input`（exit 3）で拒否する。**同じ exit で
同じ意味なので、再実装はしていない。** これも fixture で固定してある（後の段階が黙って
受理し始めないようにするため）。

### 16.6 status runner の hint は追随できていない（既知の欠落）

[../SKILL.md](../SKILL.md) 第5節の対処表には merge `change_evidence_unavailable` の行を足したが、
`scripts/status.mjs` の `NEXT_ACTION_HINTS` には足していない —— **本 Issue の実行契約が
`scripts/status.mjs` を変更対象に含めていない**ためである。追随するまでこの code は
`UNKNOWN_CODE_HINT`（「detail と `summary_markdown` を読む」）に落ちる。#93 と第12節 段 6 が
定めた扱いと同じで、**status が黙って別の対処を提案することはない。** 次に status を触る Issue で
表の行をそのまま写すこと。

### 16.7 version は上げていない（第15.8節と同じ理由）

#134 の受入条件は minor bump（`commandmate.skill.yaml` と `scripts/lib.mjs` の**両方**）を求めて
いるが、**本 Issue の実行契約は `scripts/lib.mjs` を変更対象に含めておらず、`version:` 行の変更も
禁じている**ため、bump は行っていない。**リリース時に両方を同一 commit で上げること。**

---

## 17. 実装で変えたこと（Issue [#142](https://github.com/Kewton/commandmate-skills/issues/142)。第12節 段 8 ＝ 段階 C）

段階 C は **`merge.mjs --merge-prs --unattended`** と **`uat.mjs --unattended`** である。正本は
[merge-contract.md](./merge-contract.md) 第5.3節、[uat-contract.md](./uat-contract.md) 第5.1〜5.2節、
[dispatch-contract.md](./dispatch-contract.md) 第2.1.1節・第3.0.3節、
[codes-and-recovery.md](./codes-and-recovery.md) 第3〜4節、[../SKILL.md](../SKILL.md) 第3.3節・第5節。
**裁定 0（第2節）と第6.1節の写像は1文字も変えていない。**

第8節の段階表が段階 C に割り当てたものは4つで、実装もその4つだけである。

1. `verification_gates_unrecorded` の blocking 昇格（dispatch）
2. uat の `--require-acceptance` と `--max-attempts` の明示
3. invocation cwd の pre-flight 検査（uat）
4. 受入ゲートブロックを持たない Issue を無人 merge の対象にしない（第9節 条件2）

**`dispatch_schema_version` / `merge_schema_version` / `uat_schema_version` はすべて 1 のまま、
どの `stop_reason` enum にも値を足していない。** 昇格した停止は既存の `dispatch_error` /
`preflight_failed` で受け、何が起きたかを名指しするのは `blocking_reasons[]` の code である
（第15.2節が `wall_clock_budget_exhausted` に、第16節が段階 B に採ったのと同じ形）。

**`change_evidence_unavailable` は二重に昇格させていない。** 第6.5節の訂正どおり段階 B で
昇格済みであり、本 Issue は触れていない。dispatch 側にこの code は存在せず、merge 側では昇格が
1件だけであることを fixture が数えている。

以下は本 ADR から**形が変わった点**と、ADR が明示していなかった点をどう裁定したかである。

### 17.1 「段階 A / B では limitation のまま」の二点測定は、フラグ無しの twin で測る

第6.5節は昇格を「段階 C でだけ」と書き、Issue の受入条件は二点測定を求めている。ところが
**段階は release であって invocation 単位の selector ではない** —— dispatch に「段階 A として振る舞え」
と言う入力は無いし、あってはならない（あれば締め付けを外す入力になる）。したがって測れる二点は

- **フラグ無しの run** — `verification_gates_unrecorded` は limitation で、run は完走する。
  これは段階 A / B が出荷した読み方**そのもの**である（両段階とも、この昇格を持たない）。
- **`--unattended` の run** — blocking で、次の wave を dispatch せずに停止する。

の 2 つであり、fixture はこの対で固定した。第16.1節の裁定（昇格は `--unattended` に紐づく。
別の job が後で何をするかで宣言の意味が変わってはならない）を dispatch にも適用した結果でもある。
**`--unattended` を渡さない run は、この機能が存在しなかった頃と 1 bit も変わらない**（第11節）ので、
段階 A / B の読み方は「過去の release でしか観測できないもの」ではなく、**今も観測できる**。

### 17.2 裁定は書き換えず、「先へ進むか」だけを変える（ADR が明示していなかった点）

`verification_gates_unrecorded` の昇格で **`verification.outcome` を `pass` から動かしていない。**
Issue #83 が「裁定そのものは exit code なので pass のまま」と決めており、昇格はその決定を
覆すものではない。wave barrier の `all_verifications_passed` / `advanced` も true のままである
（barrier が測っているのは completion と verification であって、report が何を示せるかではない）。
停止は barrier の**外側**に置いた: 既存の停止ランキング（prompt → exit 99 → wall-clock → …）を
1行も動かさず、その後ろに1つ足してある。**wave が失敗した run では worker 側の原因が先に採られ、
昇格した reason は `blocking_reasons[]` に残る**（`recordVerification` が起きた時点で書くため、
ランキングで負けても消えない）。

### 17.3 `human_required` は false（第6.2節の表に足していない）

昇格した停止は **`human_required` を true にしない。** この field が意味するのは
「**再実行では解けない**」であり（第6.1節）、**読めなかった原因を潰せば解ける** ——
人間の判断を要する停止ではない。結論はこのままだが、**理由は当初の記述から差し替えてある**
（Issue #170）。当初は「`GATE` 行を出す CommandMate で回せば解ける」と書いていたが、
#160 がこれを反証した: `GATE` 行は CommandMate 0.22.2 の時点で既に出ており（verify-runner の
`reportGates`）、しかも **stderr** に出ていた。読み落としていたのは **runner 側**（0.26.0 までの
dispatch は stdout しか読んでいない）である。**潰す対象は CommandMate の版ではなく runner の版**
であり、#160 で両方の stream を読むよう修正した。

`contract_unsupported` とは**扱いが違う。** あちらは CLI 側の能力不足で、CommandMate を
0.17.0 以上へ更新すれば **runner はそのまま**解ける —— CI が「再実行に意味がある」と読んで
差し支えない。こちらは **runner 自身の更新**が要る停止であり、**0.26.0 までの runner で起きた
この停止は、同じ runner のまま再実行しても必ず同じ所で止まる。** したがって CI が読むべき
signal は「再実行に意味がある」ではなく、**「runner を上げれば解ける（人間の判断は要らない）」**
である。`human_required` = false はこの理由で擁護できる。

### 17.4 uat の cwd 検査は `--expect-branch` を要求する（ADR に無いフラグ）

第8節・第14.3節は「HEAD が**期待する integration branch**と一致すること」と書いているが、
**その branch の出どころを書いていない。** plan には無い —— `profile.base` は **base** であり、
fix を base に入れることこそこの検査が防ぐ事故である。したがって
`uat.mjs` に **`--expect-branch <name>` を足し、`--unattended --create-uat-fix-worktrees` では必須**にした
（欠ければ `invalid_input` / exit 3）。名前も意味も dispatch の同名フラグ（drift check
`branch_matches`）と同一で、「dispatch が既に持っている形をそのまま置く」という第14.3節の指示に
沿っている。

検査は `git symbolic-ref -q HEAD` 1回だけで両方を答える: 出力が空なら detached
（`unattended_cwd_detached`）、`refs/heads/` を剥いだ名前が `--expect-branch` と違えば
`unattended_cwd_branch_mismatch`。`rev-parse --abbrev-ref HEAD` を使わなかったのは、
detached のとき文字列 `"HEAD"` を返すため、**magic value との比較**になるからである。

### 17.5 cwd 検査は `fix_uat` だけに掛ける（ADR が phase を名指ししていた点の実装）

第8節の段階表は `uat.mjs --create-uat-fix-worktrees` と phase を名指ししている。実装では
**`--unattended` は runner として両 phase で受理し、cwd 検査だけを `fix_uat` に掛けた。**

- `--write-uat` は read-only である。worktree を作らず、fix worker を送らず、**再merge をしない**ので、
  守るべき cwd が無い。そこで止めるゲートは**何も安全にしないまま run を拒否する**。
- 一方、含意する2つの明示（`--require-acceptance` / `--max-attempts`）は両 phase に掛けた。
  これは「裁定が何を意味するか」の問題であり、phase に依らない —— 意味ゲート無しの
  `--write-uat --unattended` も、baseline 再実行を「受入を確認した」と報告する run である。

### 17.6 `acceptance_not_run` は「起こさない」を実装が構造的に保証する

第6.5節の3行目は昇格ではなく「起こさない」である。実装は**専用のコードを1行も書いていない**:
`--unattended` が `--require-acceptance` を必須にした帰結として、劣化した acceptance document は
`composeVerdict` で **fail**（`verdict_source: acceptance_required`）になり、
`acceptance_not_run` を積む `acceptanceDegraded()` が真になる経路が消える。
fixture は「同じ世界をフラグ無しで読むと limitation が出る」ことと対にして固定している
（消えたことと、そもそも起きなかったことを区別できない測り方をしない）。

### 17.7 受入条件の検査は plan だけを読み、id の実在は問わない（第9節 条件2 の実装形）

第9節 条件2 は「受入ゲートブロックを持つことを要求する」とだけ書いている。実装は
**plan の `issues[].acceptance_gates.require`（空・欠落なら `acceptance_gates_required`）と
`issues[].acceptance_criteria`（空なら planner と同じ code `no_acceptance_criteria`）** の2つを読む。
**ゲート id が worktree の `verify.yaml` に実在するかは問わない** —— それは worktree を保持している
dispatch の問い（`acceptance_gate_id_unknown`。第6.6節）であり、merge 段で再判定すると、
merge 済みで既に消えているかもしれない worktree について**二番目に悪い意見**を出すことになる。

**停止であって除外ではない**ことは fixture の中心に置いた: 条件を満たす Issue も merge されない
ことを assert している。除外実装は「条件を満たす方だけ merge して success」を返すので、
停止の assert だけでは区別できない（変異注入で実測した）。

### 17.8 `--create-prs` には掛けていない（段階 B の意味を後から変えない）

段階 B の締め付けリストは1件（`change_evidence_unavailable`）であり、そのままにした。
同じ受入条件検査を `--create-prs` にも掛けると、**既に出荷した段階 B の意味が後から変わる**。
PR は人間が読む場所であり、そこに「受入条件が書かれていない Issue の PR」が立つことは
第9節が明示的に「害ではなく本来の姿」と裁定している。fixture は両方向に固定してある
（block を持たない plan が `--create-prs --unattended` では PR まで到達すること）。

### 17.9 `preflight[]` には載せていない（schema を上げないことの帰結）

merge / uat の `preflight[]` は `code` が閉じた enum（`cli_available` / `repo_access` /
`base_resolvable`）である。段階 C の2つの検査（受入条件・cwd）はどちらも pre-flight の性質を持つが、
**schema version を上げない**という制約が優先するので、`preflight[]` には行を足さず、
`stop_reason: preflight_failed` ＋ `blocking_reasons[].code` で表している。
`report.preflight` の3行が ok のまま `stop_reason: preflight_failed` になる report はこの経路である。

### 17.10 status runner の hint は追随させた（第16.6節の欠落を閉じた）

第16.6節が「次に status を触る Issue で表の行をそのまま写すこと」と残した
merge `change_evidence_unavailable` を `NEXT_ACTION_HINTS` に写し、段階 C の3 code
（`acceptance_gates_required` / `unattended_cwd_detached` / `unattended_cwd_branch_mismatch`）も
併せて足した。`no_acceptance_criteria` は planner の code をそのまま再利用しているので、
**hint は既に在るものがそのまま引かれる**（同じ対処だからこそ同じ code にした）。

### 17.11 version は上げていない（第15.8節・第16.7節と同じ理由）

#142 の受入条件は minor bump（`commandmate.skill.yaml` と `scripts/lib.mjs` の**両方**）を求めて
いるが、**本 Issue の実行契約は `scripts/lib.mjs` を変更対象に含めておらず、`version:` 行の変更も
禁じている**ため、bump は行っていない。**リリース時に両方を同一 commit で上げること。**
