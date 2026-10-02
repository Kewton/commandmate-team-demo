# ADR: scope の導出 — 宣言から認可境界へ（[#145](https://github.com/Kewton/commandmate-skills/issues/145) を含むクラス）

status: **accepted / 段1（L1）・段2（L4）・段3（L3）・段4（L2）すべて実装済み**（2026-08-09 承認）。裁定 0 と4層の分割、
契約 schema を分けない判断、L3 を question とする判断が承認された。
実装は本 ADR の裁定に従い、実装で形が変わったら**正本を直したうえでこの文書に追記する**。

本 ADR は個別の不具合ではなく、**同型の障害が3回出たクラス**を裁定する。

> 正しく実装した worker が、**Issue が書き忘れたファイルに触れた**というだけで不合格になる。
> scope を決めるのは Issue なので、**worker 側からは直せない。**

この文書は **裁定の記録**であり、契約の正本ではない。実装後の正本は
[plan-contract.md](./plan-contract.md)（`scope_defaults`）・
[dispatch-contract.md](./dispatch-contract.md)（契約の `scope`）・
[profile-contract.md](./profile-contract.md)（`scope_companions`）・
[codes-and-recovery.md](./codes-and-recovery.md)（対処表）にある。
ここに書いた形が実装で変わったなら、**正本を直したうえでこの文書に「なぜ変えたか」を追記する**。

本文中の行番号は **main = `fb660cb`（`cmate-orchestrate` 0.22.0）時点**の実測値である。

---

## 1. 現状（実測）

### 1.1 「推測」がそのまま「権限」になっている

```js
// dispatch.mjs:2219  contractScopeAllow(issue)
const files = Array.isArray(issue.suspected_files) ? issue.suspected_files : [];
// … path として不正なものを落とすだけで、中身は変換しない
```

```js
// dispatch.mjs:2450
lines.push('  requireScopeClean: true');   // 無条件（#50）
```

`suspected_files` は名前のとおり**推測**である —— Issue 本文から `FILE_EXT`
（orchestrate.mjs:574）で path を正規表現抽出した結果にすぎない。それを**1バイトも変換せず**
`scope.allow` へ渡し、`requireScopeClean: true` で厳格に強制している。

**本クラスの障害はすべてこの昇格から出ている。**

### 1.2 同じクラスが3回出た

| # | 症状 | 出所 |
|---|---|---|
| **#56** | `wrangler.jsonc` が抽出されず、指示どおり編集した瞬間に不合格 | `FILE_EXT` に `jsonc` が無い |
| **CommandMate #1678 B-2 / #44** | lockfile が scope 外で、`npm install` した時点で不合格確定 | Issue が manifest しか書かない |
| **#145** | test file が scope 外で、テストを書いた時点で不合格確定 | Issue が実装ファイルしか書かない |

3件とも「**worker がやるべきことをやると落ちる**」であり、3件とも worker 側に回復手段が無い
（契約の scope は send 時に `tasks.contract_json` へ snapshot される）。

### 1.3 過去2回は「planner の出力を正す」ことで解いた

`SCOPE_DEFAULT_COMPANIONS`（orchestrate.mjs:833）のコメントは #145 の主張とほぼ同一の文である。

> a lockfile missing from suspected_files — the worker's future scope.allow —
> **fails the scope gate in a way the worker cannot resolve**. When an issue names a manifest,
> its same-directory lockfiles are therefore **allowed by default**, and reported in the plan's
> `scope_defaults` so a reviewer sees which entries the planner added on the issue's behalf.

- **#56** → 抽出を広げた（`FILE_EXT`）
- **#44** → planner が既定許可として足し、`scope_defaults` に明示した（`scopeDefaultsFor`、
  orchestrate.mjs:841）

**どちらも「人間に Issue を直させる」ではない。** 本 ADR はこの前例を一般化する。

### 1.4 #50 は「導出の禁止」ではない

#145 は `requireScopeClean` を無条件にした #50 のコメントを引き、
「runner が scope を広げてはならない」と結論している。しかし #50 が裁定したのは

- **#50** = *ゲートの適用条件*（空 scope が最広権限になるのを止めた）
- **#44** = *scope の中身*（宣言から機械的に導ける伴走を足す）

の**別々の論点**であり、**両者は 0.22.0 に同居している**。禁じられているのは「**黙って**広げる」
ことで、#44 は `scope_defaults` という可視フィールドを対にすることでそれを回避している。

### 1.5 収束しない再指示が turn を焼く

再指示文（dispatch.mjs:3177）は既によくできていて、違反 path を転記し

> この変更が受入条件の達成に不可避なら worker 側では解決できません — 停止してその旨を報告してください。

とまで書いている。しかし **dispatch は turn 数しか見ずに再送し続ける**。worker は
「テストを消す＝受入条件を落とす」というジレンマに置かれ、実測（Kewton/BorderFreeKidsMap #35）では

```
note: supervision exceeded its hard iteration bound; verification failed (scope)
```

**1回落ちたのではなく、上限まで回っている。** 失ったのは worker 1人分の run
（dispatch 約25分＋検証1周）である。

---

## 2. 裁定 0 — 認可境界は宣言の閉包である

> **`allow = declared ∪ companions(declared)`**
> `companions` は「**宣言されたファイルを編集すれば機械的に付いてくる変更**」に限る。

`scope.allow` は今、**役割が2つ**あり失敗方向が逆である。

| 役割 | 狭すぎると | 広すぎると |
|---|---|---|
| **意図の宣言**（記述） | — | レビューの手がかりが消える |
| **認可境界**（権限） | **正しく実装した worker が不合格**（第1.2節） | scope ゲートが無意味（#50 が塞いだ穴） |

裁定 0 は、**宣言は Issue のものに保ったまま、認可境界だけを閉包へ広げる**。
広げてよい範囲を宣言の関数に縛ることで、#50 の穴（宣言と無関係な広い許可）は開かない。

### 不変条件（3件。すべての段が守る）

1. **導出元は必ず宣言済みファイルである。** 単独の glob を足さない。
   したがって `|closure| ≤ k × |declared|` であり、**影響範囲は宣言に比例する**。
   宣言が空なら閉包も空 —— #50 の「宣言しない plan が最広権限を得る」は起こらない。
2. **足した分は必ず可視である。** plan の `scope_defaults` に列挙する（#44 が確立した安全弁）。
   **黙って広げない。**
3. **契約は plan の純関数のままである。** 導出の入力は plan の中（profile を含む）だけから採る。
   dispatch-contract.md:212 の「**同一 plan → byte-identical な契約**」を壊さない。

---

## 3. 論点1 — 導出をどこに置くか

### 裁定: 4層に分ける

| 層 | 置き場所 | 何を解くか | 設定 |
|---|---|---|---|
| **L1 普遍の導出** | `orchestrate.mjs` | path から確実に導ける伴走。lockfile（**実装済**）、**テスト伴走**、`.d.ts` 等 | **不要** |
| **L2 repo 規約** | **profile** | L1 が知りようのない規約。独自テスト配置、生成物、repo が要求する docs 更新 | profile に記述 |
| **L3 残余の検出** | `orchestrate.mjs` | L1+L2 でも埋まらない矛盾を **dispatch 前に**止める（#145 の警告） | 不要 |
| **L4 ループ遮断** | `dispatch.mjs` | 収束しない再指示で turn を焼き切るのを止める | 不要 |

**L1 は設定ゼロで効かなければならない。** 本クラスを踏む repo は「profile を丁寧に書いていない
repo」と強く相関する（#145 の被害元 Kewton/BorderFreeKidsMap は `verified: false` の独自 profile
である）。**設定を要求する解は、効かせたい相手に効かない。**

### なぜ dispatch が worktree を観測しないのか

dispatch は worktree を持っているので、`git ls-files '*.test.*'` で repo の実際の規約を
**観測**できる。精度は最も高い。**しかし採らない。**

契約が worktree の状態に依存すると、**同じ plan が worktree ごとに違う契約を生む**。
dispatch-contract.md:212 が保証している byte-identical 性（Claude / Codex parity と再現性の根拠）が
失われる。**精度のために再現性を捨てる取引は、この Skill の他のどの裁定とも整合しない。**

### なぜ L2 は profile なのか

「repo を開いて分かったことを書き留める」役目の runner は**既にある** ——
`profile-init.mjs`（#94）である。しかも `flag` / `detected` / `derived` / `default` の provenance と
`evidence[]` を持っており（profile-contract.md 第148〜175行）、`scope_companions` の検出も
**同じ機構にそのまま載る**。

そして **profile は plan の一部**なので、そこに置けば

- **planner は repo を開かない**（orchestrate.mjs:897 が明文化している設計）
- **契約は plan の純関数**（不変条件3）

の両方が保たれる。**repo 知識の唯一正しい入口は profile である。**

### 却下した案

- **Issue 本文に書かせる（#145 の原案の実質）** —— 第1.3節のとおり、同クラスを過去2回は
  planner 側で解いている。3回目だけ人間に差し戻す理由が無い。加えて**恒久的に毎回**
  re-plan 1周のコストが乗り、4件目・5件目（生成物・docs 規約・呼び出し元）ごとに
  同じ検出器を書き足すことになる。**L3 として残すが、第一手にはしない。**
- **`scope.allow` に広い glob（`**/*.test.*` 等）を足す** —— 不変条件1に反する。
  宣言と無関係な許可であり、#50 の穴を別の形で開ける。

---

## 4. 論点2 — 契約 schema で「宣言 scope」と「派生 scope」を分けるか

### 裁定: 分けない。区別は plan 側（`scope_defaults`）だけで持ち、契約へは合流させて渡す

契約 v1 の `scope` は `allow` / `deny` の2キーである。理屈としては

```yaml
scope:
  declared: [...]     # Issue が書いた
  derived:  [...]     # planner が導いた
```

と分けるほうが綺麗で、scope ゲートが「宣言違反だが派生許可内」を報告できるようにもなる。

**しかしこれは上流（CommandMate）の schema 変更である。**
[#125](https://github.com/Kewton/commandmate-skills/issues/125) が既に上流
[Kewton/CommandMate#1756](https://github.com/Kewton/CommandMate/issues/1756) の裁定待ちで
止まっている。**同じ待ちを2本作るのは、本 ADR が解こうとしている実害の解決を遠ざけるだけである。**

区別は plan の `scope_defaults` に残るので**情報は失われない**。
**本 ADR の全段は CommandMate を1バイトも変えずに実装できる。**

### 見直す条件

上流 #1756 が案B（実行契約がゲート定義そのものを運ぶ）で決着し、契約 schema に手が入る機会が
できたなら、そのときに `scope.derived` を同じ波で入れるかを再検討する。

---

## 5. 論点3 — テスト伴走の導出規則（L1）

### 裁定: in-scope のソースファイルごとに、慣習的なテスト path を導出する

```
<dir>/<base>.test.<ext>      <dir>/<base>.spec.<ext>
<dir>/__tests__/<base>.<ext> <dir>/__tests__/<base>.test.<ext>
<dir>/<base>_test.go                          （Go）
<dir>/test_<base>.py         tests/test_<base>.py   （Python）
<dir>/<base>_spec.rb                          （Ruby）
```

`FILE_EXT` が `go|py|java|kt|rb` を含む（orchestrate.mjs:574）以上、**JS だけの規則は
planner の他の部分と非対称になる**。ハードコードは逸脱ではなく既定路線である ——
`FILE_EXT` / `SYSTEM_ROOTS` / `GENERIC_VERIFY_BINARIES` / `SCOPE_DEFAULT_COMPANIONS` は
すべてこの形で持たれている。

### 「使われなかった許可はコストがゼロ」という非対称

lockfile は manifest 名と directory から**決定的**に導けるが、テスト path は規約に依存する。
導出は当たらないことがある。**それでも成立するのは、`scope.allow` が指示ではなく権限だからである。**

`session.test.ts` / `session.spec.ts` / `__tests__/session.ts` を許可して1つしか使われなくても、
**使われなかった2つは何も起こさない。** 一方、導出しなければ worker 1人分の run が失われる。
しかも導出元は in-scope のソースファイルに限られるので、影響範囲は宣言に比例したままである
（不変条件1）。

### 却下: profile 必須にする

第3節のとおり、**設定を要求すると効かせたい相手に効かない。**
profile による上書き・追加は L2 として後から**足す**（`verifyBinaries` が
`GENERIC_VERIFY_BINARIES` を profile の `baseline` で拡張しているのと同じ形）。
**逆順（先に profile を要求する）は戻せない。**

---

## 6. 論点4 — 収束しない再指示をどう止めるか（L4）

### 裁定: 違反 path 集合が前ターンと同一なら、そのループは収束しない。即停止する

「その変更が不可避か」は一般には判定できない。しかし**収束しているか**は判定できる。

```
turn N   : scope 違反 = {A, B}  → 再指示
turn N+1 : scope 違反 = {A, B}  → 同一。worker は同じ結論に到達している
```

このとき再送を続けても結果は変わらない。**停止して `scope_unsatisfiable` を上げる**
（新しい `stop_reason` 値は足さない。既存の裁定不合格の経路に載せ、`blocking_reasons` の code で
名指しする —— #142 が `preflight_failed` に対して採った形と同じ）。

**worker が違反を1つ減らした（＝収束している）なら従来どおり再指示を続ける。**
遮断するのは「同じ答えを繰り返している」場合だけである。

report には**違反 path をそのまま**残す。これは L2 の profile へ書くべき規約そのものであり、
運用者が次に何を宣言すればよいかが report から読める。

### 追記（実装。[#148](https://github.com/Kewton/commandmate-skills/issues/148) / 段2）

裁定どおりに実装した。**形は変えていない** —— `stop_reason` の enum に値は増えず、
停止は既存の裁定不合格の経路（commit があれば `verification_failed`、無ければ `worker_failed`）に
載り、`verification.outcome` は書き換えていない。正本は
[dispatch-contract.md](./dispatch-contract.md) 第2.3.1節（判定と表現）と
[codes-and-recovery.md](./codes-and-recovery.md) 第4節（対処）である。

裁定が決めていなかった3点は、**いずれも遮断が狭くなる側**に倒した。過剰な遮断は
「収束していた worker を殺す」であり、この段が防ごうとしている損失（run 1本）と同じものを
自分で作ることになる。

1. **`--max-turns` 到達の判定を先に見る。** 上限に達した run は従来どおりの note で終わる
   （第10節「既存の期待値を1つも緩めない」）。
2. **比較は連続する2ターンに限る。** あいだに別の結果（exit 0 / 21）が挟まれば比較をリセットする
   —— 裁定文の「前ターン」の文字どおりの読みであり、より狭い。
3. **違反 path を読み取れなかったターンは比較しない。** 「2回とも読めなかった」は
   「同じ path だ」の証拠ではない（`scopeViolationLines` は format 変更に対して逐語引用へ
   劣化する設計なので、空になりうる）。

fixture は5件（`d61` 遮断・`d62` 収束は従来どおり継続・`d63` scope 以外では遮断しない・
`d64` 別の結果が挟まれば比較はリセットする・`d65` 違反 path を読めないターンは比較しない）。
**遮断は fake CLI の send 回数で測っている** —— status だけで見ると「再送してから止まった」を
見逃すからである。

### 追記（[#164](https://github.com/Kewton/commandmate-skills/issues/164)。比較集合は表示上限より前にある）

「違反 path 集合」は **logTail の全違反行**から作る。0.26.0 まではこれが成立していなかった ——
再指示文の表示上限（20 行）が転記の時点で掛かっており、重複除去＋ソートより**前**だったので、
L4 が比べていたのは logTail 先頭 20 行の集合だった。違反が 21 件以上あると、窓の外だけが変わった
2ターン（＝ worker は前進している）が「同一の答え」と読まれ、**この段が防ごうとしている損失を
この段自身が作っていた**（第6節が採った「遮断は狭く」の3判断と同じ理由で、これは誤りである）。

上限は report サイズ抑制として残す。**判定と表示を分ける**のが結論であり、打ち切った事実は
再指示文・`blocking_reasons[].detail`・worker record の `note` の3箇所で数えて名指す
（`merge.mjs` の `capped()` / `droppedNote()` と同じ）。正本は
[dispatch-contract.md](./dispatch-contract.md) 第2.3.1節。fixture は2件追加（`d67` 窓の外だけが
異なる2ターンは前進として再指示が続く・`d68` 21 件以上でも本当に同一なら従来どおり遮断し、
切った行数を必ず名乗る）。

---

## 7. 論点5 — L3（残余の検出）は question か warning か

### 裁定: question（dispatch を停止させる）

`warnings` だけでは **dispatch は `plan.status` を読まない**ので何も止まらない。
無人運転では warning は誰にも届かず、**最も高くつく場所で見逃しがそのまま残る。**

偽陽性のコストが低いことが決め手である。`--unattended` の open-questions ゲートは
`--out` を作る**前**に走る（dispatch.mjs:1762 の `unattendedPlanReasons`）。

> Both are pure functions of the plan, so evaluating them here costs nothing and buys the
> property #90 established for missing worktrees: **the run stops without consuming `--out`**,
> so the same command can be re-run after the issue bodies are fixed and re-planned.

| | 偽陽性（誤って止める） | 見逃し（通してしまう） |
|---|---|---|
| 失うもの | **ゼロ**（`--out` 未消費・再実行可） | worker 1人分の run |
| 人間の手数 | Issue 本文を直して re-plan | Issue 本文を直して re-plan（**同じ**） |

**偽陽性は、それが防ぐ真陽性より厳密に安い。** 非対称がこれだけ明確なら停止側を採る。

### ただし精度は作り込む

既存の question（`no_suspected_files` / `no_acceptance_criteria`）は `length === 0` という
**構造的**判定であり解釈が入らない。L3 は**推論**である。同じ channel に入れる以上、精度で
差を埋める。

- **採る**: 能動的な作成要求のみ（「unit test がそれを判定する」「テストを追加」
  「〜のテストで固定する」、散文中の `*.test.*` 形の path 言及）
- **除外**: 「テストは不要」「既存の…テストが緑のまま」「手動テストで確認」「テストは変更しない」
- **走査対象は `acceptance_criteria` に限定**する（本文全体に広げない）
- **question 本文にマッチした原文を載せる** —— 「なぜ止まったか」が読めれば偽陽性の確認は
  数秒で済む

除外を作らないと、この検出は自分の存在意義を壊す。「テストは不要」と書いた Issue が
「テストが要るのに scope に無い」で止まるのは、**警告が読み手の信用を失う典型**である。
そうなると運用者は `--allow-questions` を常用し始め、**plan 全体に効く**このフラグは
本物の `no_acceptance_criteria` まで一緒に黙らせる。

**除外分岐は変異注入で赤になることを実測する。** 除外を1つ外して緑のままなら、その分岐は
空振りである。

---

## 8. 裁定 A — 推論は機械を止めてよいが、機械に指示してはならない

`extractTestExpectations`（orchestrate.mjs:872）が advisory なのは、その出力が**契約に入る**
からである（同 897行「the planner never opens the target repository」に続く一連の設計）。

L3 は `acceptance_gates` にも `scope.allow` にも**1バイトも書かない**。出力先は人間だけである。
ただし `questions` は dispatch を停止させるので「機械への影響ゼロ」ではない。正確な線は

> **止めることはするが、何をせよとは言わない。**

L1 / L2 は推論ではなく**規則の適用**（宣言済みファイルの関数）なので、契約に入ってよい。
この非対称が、L1・L2 と L3 を別の層に置く理由である。

---

## 9. 証跡（plan / report に何を残すか）

- **plan**: L1 / L2 が足した path は `scope_defaults` に列挙する（既存フィールドを拡張。
  出所を区別したいなら `scope_defaults` を `{path, origin}` 形へ広げるかを実装時に裁定する）。
  L3 は `warnings` と `questions` の両方に出す（既存 question と同じ運用）。
- **dispatch report**: L4 の遮断は `blocking_reasons` に違反 path を添えて記録する。
- **schema version は上げない。** `scope_defaults` は既存フィールドであり、L3 の code は
  既存の question 機構に載り、L4 は既存の停止経路に載る。上げる必要が出たなら、それは
  実装が本 ADR の裁定から外れた合図である。

## 10. 影響しないと決めたこと

- **`requireScopeClean` を緩めない。** #50 の裁定はそのままである。本 ADR が変えるのは
  `allow` の**中身**であって、ゲートの**適用条件**ではない。
- **CommandMate を変えない**（第4節）。上流の裁定を待つ段を1つも作らない。
- **既定の挙動を壊さない。** L1 の導出は `scope_defaults` を増やすだけで、
  既存の d21（scope 再指示）/ d27〜d30 の期待値を1つも緩めない。緩めなければならないなら、
  それは実装が後方互換を壊した合図である。
- **planner が repo を開くようにしない**（orchestrate.mjs:897）。
- **worker 側の回復手段を作らない。** 契約の scope は send 時 snapshot であり、
  それは tamper-safety の根拠である。ここは触らない。

## 11. 実装順（段）

| 段 | 内容 | 効果 |
|---|---|---|
| **1** | L1 にテスト伴走を追加 | **#145 の事象が人手ゼロで消える** |
| **2** | L4 ループ遮断 | 焼損が run 1本 → 1ターン |
| **3** | L3 残余の検出（#145 の中身） | L1 が外した規約を dispatch 前に返す |
| **4** | L2 `scope_companions` ＋ `profile-init` の検出 | 独自規約 repo が段1と同じ状態になる |

**段1と段2だけで、観測された障害は消える**（片方は発生させず、片方は損失を大幅に減らす）。
段3・4 は残余を潰す仕上げである。**段1は本 ADR の他の段に依存しない**ので、
レビューと並行して着手できる。

## 12. 見直す条件

- **4件目が出たとき** —— 生成物・docs 規約・呼び出し元・snapshot のどれで出たかを見て、
  L1 の規則で足りるのか L2 の宣言が要るのかを、その事例とともに判断する。
  **個別の検出器を足す前に、この ADR に戻ること。**
- **L1 の導出が外れる repo が繰り返し出るとき** —— 段4（L2）の優先度を上げる。
- **上流 #1756 が案B で決着したとき** —— 第4節（契約 schema で宣言/派生を分ける）を再検討する。
- **`scope_defaults` が読めない量になったとき** —— 1 Issue あたりの導出数に上限を設けるか、
  `{path, origin}` へ広げて出所で畳むかを裁定する。

---

## 13. 実装時の追記（段1・[#147](https://github.com/Kewton/commandmate-skills/issues/147)）

段1（L1 テスト伴走）を `orchestrate.mjs` の `testScopeDefaultsFor` として実装した。
正本は [plan-contract.md](./plan-contract.md) 第 5.1 節である。第2節の不変条件3件、
第3節の「L1 は設定ゼロ」、第5節の導出規則は**そのまま実装されている**。
第9節のとおり `scope_defaults` は list のまま（`{path, origin}` へは広げていない）で、
`plan_schema_version` も上げていない。

第5節の表から**変えた点が2つ**あるので、第0節の約束に従って記録する。

### 13.1 java / kt を足した

第5節の表は `go|py|rb` までしか挙げていないが、`FILE_EXT` は `java|kt` も受理する。
表のとおりに実装すると、まさに第5節が「JS だけの規則は非対称である」として却下した形が
JVM に対して残る。そこで

```
<dir>/<Base>Test.<ext>                         （単一 module / Android 形式）
src/test/<lang>/…/<Base>Test.<ext>             （src/main/ を持つ path のみ。Maven / Gradle）
```

を足した。`src/main/` → `src/test/` の対応は Maven と Gradle が両方要求する規約であり、
**Go の `_test.go` と同じく path だけから決まる**ので、L1（規則の適用）の範囲に収まる。
`src/main/` segment を持たない path には mirror を出さない。

### 13.2 導出しない拡張子を明示した

`rs` / `sh` / `c` / `h` / `cpp` / `sql` / `css` / `html` は `FILE_EXT` にあるが**規則を持たない**。
Rust の unit test はソースファイルの中（`#[cfg(test)] mod tests`）にあり、それは既に scope 内
である。integration test（`tests/<name>.rs`）と shell / C 系（`*.bats` / `test_*.sh` /
`*_test.c` / `check_*.c`）は**意図に応じて名前が付く**ので path からは決まらない。
第5節の「使われなかった許可はコストがゼロ」は、当たる見込みのある形にだけ効く議論であり、
どの repo にも無い path を作ることまでは正当化しない。**4件目の見直し条件（第12節）に従い、
実際の Issue が形を示したときに足す。**

### 13.3 上限

第12節が予告した上限は、可読性ではなく**正しさ**の理由で先に必要だった。
`dispatch.mjs` は `scope.allow` を **sort してから** `MAX_SCOPE_PATTERNS`(=200) で切り詰めるので、
上限を超えた list は導出済み path が宣言済み path を押し出す —— 本 ADR が消そうとしている
障害そのものである。したがって導出は、issue の重複除去後の合計が 200 に達する前に
**source file 単位で打ち切る**。fixture の実測はどれも1桁である。

---

## 14. 実装時の追記（段3・[#145](https://github.com/Kewton/commandmate-skills/issues/145)）

段3（L3・残余の検出）を `orchestrate.mjs` の `testCreationDemand` / `testDemandExcluded` /
`mentionsTestPath` と `analyzeIssue` の1分岐として実装した。code は
`acceptance_requires_tests_but_scope_has_none`、正本は
[plan-contract.md](./plan-contract.md) 第5.2節、対処は
[codes-and-recovery.md](./codes-and-recovery.md) 第2節・第4節である。
第7節の裁定（question にする）・第8節の裁定 A・第9節（`warnings` と `questions` の両方に出す、
`plan_schema_version` は上げない）は**そのまま実装されている**。新しい field は1つも作っていない。

### 14.1 「テストらしき path」は L1 と同じ述語を使う

第2の条件（`suspected_files` にテストらしき path が1件も無い）の判定には、L1 が
「この path は既にテストだから導出しない」に使っている `isTestPath` を**そのまま**使った。
別の述語を書けば、L1 が「テストだ」と見た path を L3 が「テストでない」と読む余地が生まれ、
**二重発火しないことが実装の偶然になる**。同じ関数を通す限り、両者は同じ path 集合について
同じことを言う。

### 14.2 残余の実体は「L1 に規則が無い ecosystem」だった

第7節と #145 本文は残余を「段1 の形と実際の配置が違う repo」と述べていた。**実装してみると
そこは掴めない。** 第2の条件が「**導出結果を含めて**テスト path が1件も無い」である以上、
`.ts` / `.go` / `.py` / `.rb` / JVM のソースを宣言した Issue は **L1 が形を1つでも出した時点で
沈黙する** —— その形が当たっているかどうかを planner は知らない（対象リポジトリを開かない。
第10節）。したがって L3 が実際に話すのは次の3つである。

- 第13.2節が「規則を持たない」と明示した ecosystem（`rs` / `sh` / `c` / `h` / `cpp` /
  `sql` / `css` / `html`）だけを宣言した Issue
- ソースでない file（`.md` / `.json` / `.yaml` / lockfile / `Makefile`）だけを宣言した Issue
- 宣言が空の Issue（このときは `no_suspected_files` も同時に出る）

**第13.2節が「導出しない」と決めた集合とちょうど一致する。** 条件を「導出結果を含めない」に
変えれば「配置が違う repo」も掴めるが、それは **L1 が直した Issue すべてで発火する** ので
採らない（第11節の「段1と段2だけで観測された障害は消える」を壊す）。条件は #145 本文が
指定したとおりに実装し、掴める範囲がそこで決まる、というのが実装の結論である。

**JS / Go / Python / Ruby / JVM の repo で「L1 の形が当たらずに run を失う」事例が実際に出たら、
それが第12節の4件目である。** 個別の検出器を足す前に本 ADR に戻り、L2（段4・#149）の
`scope_companions` に宣言させるのか L1 の形を増やすのかを、その事例とともに裁定する。

### 14.3 精度で引いた線（第7節「ただし精度は作り込む」の実装）

第7節の採用/除外リストに対して、実装で**線を2つ足した**。

- **`spec` 単独は「テスト」と読まない。** 受入条件の "the spec" は RSpec の spec file と
  同じ頻度で「仕様」を指す。`*_spec.rb` / `*.spec.ts` は path 規則（`isTestPath`）が拾うので
  取りこぼしは無い。`rspec` / `jest` / `vitest` / `pytest` は曖昧でないので noun に入れた。
- **`既存` / `existing` 単独では除外しない。** 「既存のテストに1件追加する」は本物の要求である。
  除外2（「既存の…が緑のまま」）は「そのままである」側の語を**同じ節の中**（`。` / `.` を
  跨がない範囲）に要求する。

**除外は4本の独立した文にした。** 1本ずつ外して赤になることを実測するためであり、
融合した1本の正規表現ではどの線が効いているかを測れない（第14.4節）。

`questions` の**語順**は dispatch の実装に合わせた。`dispatch.mjs` の `excerpt(…, 200)` は
**末尾 200 文字を残す**ので、原文を先頭に置いた question は**無人運転でちょうど原文を失う**
（原文が読めることが偽陽性を数秒で確認できる根拠だったので、失ってはいけない部分である）。
そこで原文を最後に置き、前置きを 140 文字以内に収めた。

### 14.4 変異注入の実測

第7節が要求した「除外分岐を1つずつ外して赤になることの実測」を、`orchestrate.mjs` を
1箇所ずつ書き換えて fixture 全体（`node tests/fixtures/cmate-orchestrate/run_tests.mjs`）を
回すことで行った。**9件すべてが赤になった。** 空振りの分岐は無い。

| 変異 | 結果（赤になった case） |
|---|---|
| 除外1（テストは不要 / no new tests）を外す | 赤 5件 —— `40-acceptance-tests-not-required` |
| 除外2（既存のテストが緑のまま / existing still pass）を外す | 赤 5件 —— `41-acceptance-tests-stay-green` |
| 除外3（手動テストで確認 / manual）を外す | 赤 5件 —— `42-acceptance-tests-manual` |
| 除外4（テストは変更しない / tests unchanged）を外す | 赤 5件 —— `43-acceptance-tests-unchanged` |
| 散文中の test path 分岐を外す | 赤 4件 —— `37-…-other-shapes`（#452 だけが落ちる。#451 は noun 分岐で残る） |
| noun + 能動語 分岐を外す | 赤 32件 —— `36-…-no-scope`, `37-…-other-shapes`, `d66-…-refused`, 裁定 A の不変条件テスト |
| 第2条件を **L1 導出前**の `suspected_files` で見る | 赤 15件 —— `38-…-derived-covers` と `31` / `34` / `35`（段1 との二重発火） |
| 能動的要求の判定をやめる（受入条件があれば発火） | 赤 52件 —— `39`〜`43`, `20-markdown-deliverable`, `21-open-questions`, `33-test-companions-non-source`, `d37` / `d38`（偽陽性が既存 case を巻き込む） |
| 検出そのものを外す | 赤 37件 —— `36`, `37`, `d66`, 裁定 A の不変条件テスト |

除外1〜4 が**それぞれ自分の case だけを落とす**（他の8 case は緑のまま）のが、4本を独立した文に
した理由の実測である。融合していれば1本外すだけで4 case が落ち、どの線が効いているかは読めない。

### 14.5 status runner の hint は入れていない

`status.mjs` の `NEXT_ACTION_HINTS` は plan の warning code を1つ残らず持っていたが、本 code は
**入っていない**（`status.mjs` は本変更の宣言 scope の外だった）。したがって `status.mjs` は
この warning について「detail と `summary_markdown` を読む」の既定に落ちる。運転で人間が出会う
停止は dispatch 側の `open_questions` であり、そちらは hint を持ち、質問の本文（＝受入条件の
原文）をそのまま出す。**hint を足すのは次の変更の仕事である。**

---

## 15. 実装時の追記（段4・[#149](https://github.com/Kewton/commandmate-skills/issues/149)）

段4（L2・repo 規約の宣言）を profile の任意 field `scope_companions` として実装した。
正本は [profile-contract.md](./profile-contract.md) 第9節（形と拒否規則）と
[plan-contract.md](./plan-contract.md) 第5.1節（3つ目の導出元）である。
第2節の不変条件3件・第3節の「なぜ L2 は profile なのか」・第9節（`scope_defaults` に出す、
`plan_schema_version` は上げない）は**そのまま実装されている**。第4節のとおり CommandMate は
1バイトも変えていない。

**この段には実運用の観測データが無い。** 0.23.0 / 0.24.0 は出たばかりで、L1 の導出が実際に
どれだけ当たるかはまだ測れていない。したがって形は「いま分かっている必要」ではなく
**「後から広げられること」**を基準に選んだ。以下はその選択の記録である。

### 15.1 採った形 —— 共通語彙の path テンプレート対

```json
"scope_companions": { "derive": [ { "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] } ] }
```

`when` が**宣言済み path** に一致して placeholder を束縛し、`add` がその束縛を書き戻す。
placeholder は `{dir}`（0個以上の segment、各々に末尾 `/`）と `{base}`（1 segment）の2つだけ。

**第2節の不変条件3件が、検査ではなく形の性質になっている**ことがこの形を採った理由である。

1. **導出元は必ず宣言済みファイル。** glob 構文が**存在しない** —— `*` `?` `[` `]` は
   両テンプレートで拒否され、wildcard は placeholder だけである。placeholder が捕まえる文字列は
   **宣言済み path の literal な部分文字列**であり、`add` は `when` が束縛した placeholder を
   最低1つ含まなければならない。したがって「宣言と無関係な許可」は**書く場所が無い**。
   `**/*_spec.rb` も裸の `docs/module-reference.md` も load 時に `load_error` で落ちる。
   `|closure| ≤ (add 総数) × |declared|` が構成上成り立つ。
2. **可視。** 導出結果は L1 と同じ1本の list に入り、`scope_defaults` と `suspected_files` へ
   同じ文で append される。
3. **plan の純関数。** 入力は profile（plan の一部）だけ。disk も clock も読まず、
   sort も Set の走査もしない。

`{dir}` を置いたのはミラーを書けるようにするためである。`app/models/user.rb` →
`spec/models/user_spec.rb` の「先頭を差し替えて残りを保つ」は、この field が解こうとしている
規約の中心にある形で、prefix を落とせない語彙では表現できない。

**top-level を object にしたのは、後から key を足すためである。** いま key は `derive` 1つだけで、
未知の key は拒否する（新しい profile が古い runner で黙って半分無視されるより、はっきり
落ちるほうがよい —— profile の未知 field を拒否する既存の判断と同じ）。将来 `derive` 以外の
概念（下記）を足すときは、list の意味を上書きするのではなく**兄弟 key として**足す。

### 15.2 入れなかったもの（と、その理由）

観測が無い段階では、**足せるものより足せないものを少なくしておく**ほうが安全である。
次はいずれも「後から互換に足せる」ことを確認したうえで、今回は入れていない。

| 入れなかったもの | 理由 |
|---|---|
| **定数の伴走 path**（「この repo は `docs/module-reference.md` の更新を要求する」）<br>**→ 段7（[#181](https://github.com/Kewton/commandmate-skills/issues/181)）で `require` として着地。第18節** | placeholder を1つも含まない `add` を許すと、不変条件1の検査が「glob でないこと」だけに痩せる。`|closure| ≤ k × |declared|` は保てるが、**「宣言と無関係な許可が書けない」という強い言明が「書けるが狭い」に落ちる。** 実例が出たら `derive` とは別の key（例: `require`）として足す —— そのとき「宣言と無関係」であることを key の名前が明示する |
| **`{ext}` placeholder** | 拡張子ごとに1規則書くほうが明示的で、当たる範囲も読んで分かる。`{ext}` は placeholder を1つ足すだけの互換な拡張である |
| **規則の除外条件**（`unless`） | 除外が要る事例をまだ1件も持っていない。規則の未知 key は拒否されるので、足すときは runner の側で解禁する |
| **profile が L1 を*上書き*すること** | 第5節の裁定どおり L2 は**足すだけ**である。上書きを許すと「設定ゼロで効く」L1 の保証が profile 次第になる |
| **`scope_defaults` を `{path, origin}` へ広げる** | 第9節が実装時裁定に委ねた点。由来を区別したい需要はまだ出ていないし、広げると plan schema の変更になる。第12節の「読めない量になったとき」に再検討する |

### 15.3 未指定は「段1 までの挙動」に literal に degrade する

既存 profile はすべてこの key を持たない。したがって「未指定＝段1 までの挙動」は
**plan の byte まで含めて**成り立たなければならない。実装は3か所でそれを保っている。

- `normalizeProfile` は**未指定を未指定のまま**残す（`{"derive": []}` へ正規化しない）
- `publicProfile` は**宣言があるときだけ**この key を plan に載せる（しかも最後に）
- 導出は規則が0件なら即 `[]` を返す

測り方は**二点測定**である。fixture `45-scope-companions-absent` の golden は
**0.24.0（本変更前）の runner が出力した plan.json をそのまま**checked-in したもので、
実装後も byte 単位で一致することを CI が検査する。`44-scope-companions-declared` は
**同一の Issue** を宣言つき profile で計画したもので、2つの case の差は profile だけである。
`{"derive": []}` が未指定と同じ導出になることも別に測っている（`plan.profile` の echo 以外に
差が出ないことを比較する）。

### 15.4 L3 との関係は「同じ list を後から読む」ことで自動的に保たれる

L3（第14節）の第2条件は `suspected` を **`scopeDefaults` の push 後に**読む。L2 の導出は
その push に合流するので、**L2 が埋めた Issue では L3 が自動的に黙る。**
第14.1節が L1 について述べた理由がそのまま効く —— `isTestPath` という同じ述語を通す限り、
L2 が「テストを足した」と言った path を L3 が「テストが無い」と読む余地は無い。

fixture `49-scope-companions-silences-l3` は `36-acceptance-requires-tests-no-scope` と
**同じ Issue**（`.sh` の deliverable ＋ テストを能動的に要求する受入条件）を bats 配置を宣言した
profile で計画したもので、warning も question も出ない。第14.2節が「L3 が実際に話すのは
L1 に規則が無い ecosystem である」と結論した、その残余をちょうど L2 が引き取っている。

### 15.5 上限は L1 と共有する（合計に対して効く）

L2 は L1 の**後**に走り、`have` には L1 の導出結果が既に入っている。したがって
`MAX_SCOPE_PATTERNS`(=200) の判定は **3つの由来の合計**に対して行われ、打ち切りは
L1 と同じく**宣言済みファイル単位**で起きる（1つのファイルの伴走は全部出るか1つも出ないか）。
第13.3節が述べたとおり、これは可読性ではなく正しさの要求である —— dispatch は
`scope.allow` を sort してから切り詰めるので、上限超過は宣言済みファイルが導出済みファイルに
押し出されることを意味する。fixture は 30 宣言 × (L1 4 + L2 2) で 200 ちょうどに当てて測っている。

### 15.6 profile-init は「対で裏が取れた配置」だけを起案する

`profile-init.mjs` の検出は **directory の存在では起案しない。** `spec/` `test/` `tests/` の下の
**実ファイル**と、それが写している `src/` `app/` `lib/` の**実ファイル**の対が揃ったときだけ
規則を1件出し、`provenance[].evidence[]` にその2つを挙げる。裏の取れない起案は、この runner が
避けるために存在している「黙った推測」そのものだからである。

**起案は最大1規則**とし、裏の取れた配置が複数あるときは走査順の先頭を出して残りを warning
`multiple_test_layouts` に載せた（`multiple_ecosystems` / `multiple_lockfiles` と同じ規律：
黙って1つを選ばない）。1件も取れなければ `{"derive": []}` を `default` として置き、対の TODO
`scope_companions_undetermined` を添える —— 第7.2節の `gaps_explicit` 検査がこれを自己検査する。
`verified` は当然 `false` のままである。

fixture `01-node-npm` に `src/` と `test/` のミラーを足したのは、**「全 field に根拠がある draft は
`success` である」という suite の性質を保つため**である。この field を常に `default` にしてしまうと、
何も欠けていない repo の draft まで恒久的に `partial` になり、`partial` が「読むべき欠落がある」の
合図でなくなる。

### 15.7 run_id には入れていない（既知の摩擦）

`scope_companions` は plan を変えるが、**run_id の入力には入れていない**（plan-contract.md 第1節の
入力集合は変えていない）。したがって「宣言を直して plan を取り直す」と `run_exists`(exit 4) になり、
`--run-id` か `--runs-dir` が要る。`baseline` を直したときと同じ摩擦であり、エラー文が2つの
回避策を名指しする。

#46 が Issue 本文について同じ摩擦を消した以上、profile の宣言についても消す価値はある。
**入れなかったのは、それが run_id の入力集合の変更であり、本 ADR のどの節も裁定していないから**である
（同じ理由で `baseline` も入っていない）。宣言の修正 → re-plan が実運用で頻出するなら、
`baseline` を含む profile 全体を run_id に入れるかを、そのとき一度に裁定する。

### 15.8 変異注入の実測

追加した検査が空振りでないことを、`orchestrate.mjs` / `profile-init.mjs` を1箇所ずつ書き換えて
fixture 全体（`node tests/fixtures/cmate-orchestrate/run_tests.mjs`）を回すことで実測した。

**14件すべてが赤になった。空振りの検査は無い。**

| 変異 | 結果（赤になった検査） |
|---|---|
| L2 の適用そのものを外す | 赤 14 —— `44` / `48` / `49` と L2 の determinism / bound test |
| L2 の分を `scope_defaults` に出さず `suspected` にだけ足す（不変条件2） | 赤 4 —— `44` / `48` / `49` / determinism（`scope_defaults` 側だけが落ちる） |
| `add` に placeholder を要求しない（不変条件1） | 赤 6 —— `47` と拒否表の "a constant add" |
| glob metacharacter の拒否を外す（不変条件1） | 赤 7 —— `46` と拒否表の "a glob beside a placeholder in add" / "a glob in when" |
| `when` が束縛していない placeholder を許す | 赤 1 —— 拒否表の該当行のみ |
| `MAX_SCOPE_PATTERNS` の打ち切りを L2 側だけ外す | 赤 3 —— bound test（200 → 210） |
| 未指定を `{"derive": []}` に正規化して plan に載せる（後方互換） | 赤 3 —— **plan 全文 golden 3件**（`02` / `31` / `45`） |
| L2 を L1 より**先**に走らせる | 赤 8 —— `44` / `48` / determinism / bound（列挙順が変わる） |
| 派生済み path からの再導出を許す（不変条件1） | 赤 5 —— `44`（`spec/models/user_spec_spec.rb` が生える）/ `48` / determinism |
| L1 との重複除去を外す | 赤 2 —— `48`（`tests/test_loader.py` が2回出る） |
| profile-init: 対の source file の実在を要求しない | 赤 5 —— `06`（裏の取れない `spec/routing_spec.rb` から起案してしまう） |
| profile-init: `default` に対の TODO を付けない | 赤 12 —— `02`〜`05`（`gaps_explicit` completion check が落ちる） |
| profile-init: 起案した profile から field を落とす | 赤 24 —— `01`〜`06`（`contract_shaped` と全 golden） |
| profile-init: 複数配置を黙って1つ選ぶ（warning を出さない） | 赤 1 —— `06` |

**「変異が緑のまま」を1件、実測で潰した。** 当初 fixture `46` は裸の glob
（`add: ["spec/**/*_spec.rb"]`）を宣言していたが、これは**2つの検査に独立に引っかかる** ——
glob 文字の検査と「placeholder が1つも無い」の検査である。glob 検査だけを外した変異では
この行は**緑のまま**で（M4 の出力で "a bare glob in add" は落ちていない）、
`46` はどちらの線が効いているかを測れていなかった。そこで宣言を
`add: ["spec/{dir}**/{base}_spec.rb"]`（placeholder を持つ glob）に変え、
拒否表にも placeholder つきの行を足した。**裸の glob の行は残してある** ——
それが塞ぎたい脅威そのものだからで、測定用の行とは役割が違う。

### 15.9 触っていない正本

`SKILL.md` 第3.5節・`runner-operations.md` 第13節・`codes-and-recovery.md` は
**本変更の宣言 scope の外**だったので、新しい code（`scope_companions_undetermined` /
`multiple_test_layouts`）と `--emit profile` の増えた field を反映していない。
第14.5節が `status.mjs` の hint について書いたのと同じで、**それは次の変更の仕事である。**

---

## 16. 実装時の追記（段5・[#161](https://github.com/Kewton/commandmate-skills/issues/161) / [#162](https://github.com/Kewton/commandmate-skills/issues/162)）

### 16.1 何が見つかったか —— guard は導出側にしか無かった

第13.3節と第15.5節は、上限を**導出側**の要求として書いた。「導出済み path が宣言済み path を
押し出す」を防ぐために、L1 と L2 は宣言済みファイル単位で打ち切る。これは実装されており、
本変更でも**一切触っていない**（fixture `50` が、205 件宣言した Issue で導出が1件も出ないことを
固定している）。

**押し出されないだけで、宣言そのものが 200 件を超えたときは切り詰められる。**
`dispatch.mjs` の `contractScopeAllow` は sort してから `slice(0, 200)` するので、
アルファベット順で後ろの宣言が契約から消える。同じ関数は、絶対 path・ドライブレター・
バックスラッシュ・`..` セグメント・200 字超・NUL のいずれかに当たるパターンも per-item で落とす。
**どちらも何も報告していなかった。** dispatch 前の pre-flight も `length > 0` しか見ておらず、
「200 件を超えて切り詰めた」は素通りしていた。

`orchestrate.mjs:1159` 付近のコメントはこの危険を正確に名指ししている。**guard は導出側にしか
実装されなかった**、というのが本件である。0.26.0 の退行ではなく、切り詰めが入った 0.9.0 からの挙動。

### 16.2 「送る前に落とす」は、ここでは成り立っていなかった

`contractScopeAllow` の doc comment は「parser が拒否するものは送る前に落とす
（a contract rejected at `send` is a dispatch that never happens）」と述べていた。
CommandMate 0.22.2 の契約 parser と突き合わせた実測は次のとおりで、**doc comment は2箇所で
実装と食い違っていた**（本変更で訂正した）。

| 落とす対象 | parser の実際 |
|---|---|
| 件数超過 | `at most 200 entries (got 250)` と**件数を名指しして拒否**する |
| 絶対 path / `..` / NUL / 200 字超 | `validateScopePattern` / `validateStringList` が**エントリ番号と理由を名指しして拒否**する（`send` は exit 2 で全違反を列挙） |
| ドライブレター（`C:`）/ バックスラッシュ | **拒否しない。** `validateScopePattern` の検査は NUL・先頭 `/`・`..` の3つだけである |

前2群では、落とさなければ**大きな声で拒否される**ところを、落とすことで**契約は受理され、
権限だけが黙って狭まった状態で dispatch が成功**していた。**大きな声の拒否が、静かな誤った成功に
化けていた。** 最後の1群は parser の判断ではなく runner の判断なので、runner が報告しなければ
どこにも残らない。ドライブレターとバックスラッシュは**落とし続ける** —— repository-relative な
path に一致しないので、送っても scope ゲートで同じ場所に落ちるだけである。

### 16.3 裁定: 上限は変えない。診断を足す。可視性の規範を対にする

上限値は CommandMate 側の hard limit なので**変えられない**。したがって足せるのは診断だけである。

1. `contractScopeReview(issue)` が `{ allow, dropped }` を返す。`dropped` は
   `{ pattern, reason }` の list で、reason は `over_bound`（件数）と6つの形の理由に分かれる。
   **理由を1つに丸めない** —— `over_bound` の直し方（Issue の分割）と形の直し方（path の書き直し）は
   正反対で、区別できない読み手は動けない。契約生成側は従来どおり配列だけを使う
   （`contractScopeAllow` は薄い view として残した）。
2. **pre-flight（`unattendedPlanReasons`）で blocking にする。** 既に全 Issue を走査しているので
   追加コストは無い。`--out` を作る前に止まるので、`contract_scope_unknown` / `open_questions` と
   同じく「Issue を直して re-plan する」に接続できる。**同じ Issue で両方立つときは
   `contract_scope_dropped` を先に積む** —— 全件落ちて scope が空になった場合、drop は
   emptiness の**説明**であり、後に読むと別の問題に見える。
3. 人間が居る run（`--unattended` 無し）では**停止しない**。wave は既に走っているからである。
   代わりに `limitation` を Issue ごとに1件積み、狭まった権限のまま dispatch する。
   **無言の切り詰めは「全部入った」と読める**ので、停止しない判断をする以上、最低でも
   ここに載っていなければならない。
4. planner（`orchestrate.mjs`）は `contract_scope_dropped` warning を出す。dispatch より前、
   **plan の review 時点**で気づける。

規範としては [plan-contract.md](./plan-contract.md) 第5.1節に**不変条件4「引いた分も必ず可視である」**を
足した。第5.1節は導出側（不変条件2「足した分は必ず可視である」）にだけ可視性を要求していて、
**足した1件は必ず名指しされるのに、消えた50件は1バイトも残らない**という非対称だった。
番号は 1〜3 を動かしていない —— 他文書がその番号で参照している。

### 16.4 却下した案

| 案 | 却下の理由 |
|---|---|
| 上限を上げる / 切り詰めをやめる | CommandMate 側の契約上限である。超えた契約は `send` が exit 2 で拒否するので、**dispatch が1人も起動しなくなる**。runner 側で選べる話ではない |
| 落とさずにそのまま送り、parser の exit 2 に語らせる | 「絶対 path 1行」で run 全体が dispatch 不能になる。**現状より悪い** —— しかも停止するのは `--out` を作った後で、pre-flight の「`--out` を消費しない」性質を失う |
| 形の理由を1つの `invalid` に丸める | 直し方が正反対の2群を同じ名前で呼ぶことになる（第16.3節 1） |
| plan / dispatch で別 code にする | 同じ1件の finding を2つの時点で読んでいるだけなので、**同じ名前**で呼ぶ。plan の warning 表と dispatch の limitation 表の両方に同名で行を足した |
| 人間が居る run でも停止する | wave は既に走っている。止めても後始末は人間の仕事で、`--out` は既に消費済み。**検出時点を早める価値は無人 run にしか無い** |

### 16.5 変異注入の実測

| 変異 | 結果 |
|---|---|
| `contractScopeReview` から `dropped` の記録を外す | 赤 —— `50` / `51` / `d69` / `d70` |
| pre-flight の drop 検査を外す（`length > 0` に戻す） | 赤 —— `d69`（`--out` が作られ、2人とも dispatch される） |
| wave loop の limitation を外す | 赤 —— `d70` |
| planner の `contractScopeWarnings` を外す | 赤 —— `50` / `51` |
| L1 / L2 の導出側 guard を外す | 赤 —— `#147` / `#149` の bound test（本変更でも触っていないことの裏） |

**修正前のコードで4 case・37 assertion が赤**であることを先に確認してから実装を入れている
（空振りする緑を作らないため）。

### 16.6 測れていないもの

絶対 path・ドライブレター・バックスラッシュ・`..`・NUL の5形は、**fixture では測れていない。**
`orchestrate.mjs` の `isSafeRepoPath` が抽出時にすべて落とすので、planner が作る plan には
到達しない —— そして dispatch の fixture harness は plan を**必ず planner に作らせる**
（`run_tests.mjs` の `generatePlan`。harness 自体は本変更の宣言 scope の外だったので、
plan を直接注入する口は足していない）。測れているのは `too_long`（`51`）と `over_bound`
（`50` / `d69` / `d70`）で、これは**形の drop と件数の drop の両方**を1つずつ通す。
dispatch 側の判定は5形も含めて完全な mirror のまま残してある —— **穴のある mirror が本件そのもの**
だからで、`isSafeRepoPath` は plan の入口の防御であって契約の防御ではない。

### 16.7 触っていない正本

`dispatch-contract.md` 第3.0.3節（pre-flight の scope 検査の説明）と `status.mjs` の hint map は
**本変更の宣言 scope の外**だったので、`contract_scope_dropped` を反映していない。
前者は「1件でも空なら」と書いたままで、**「宣言より狭ければ」も止めるようになった**ことを
述べていない。後者は第14.5節と同じ扱いで、`codes-and-recovery.md` 第5節末尾に
「hint map にまだ無い code」として名前を足してある。**それは次の変更の仕事である。**

---

## 17. 実装時の追記（段6・[#177](https://github.com/Kewton/commandmate-skills/issues/177)）

### 17.1 何が見つかったか —— 導出は「成果物」と「審判」を区別していなかった

第2節の裁定0は「認可境界は宣言の閉包である」と書いた。**閉包の入力である「宣言」が
何を含むかを、そこでは限定していなかった。** 実測（2026-08-10、Kewton/BorderFreeKidsMap）で
出たのはその穴である。受入条件に

```
- [ ] `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す
```

と書くと、この `.sh` が `suspected_files` に入り、そのまま実行契約の `scope.allow` になる。
**worker は自分を裁く verify runner を書き換えられる。** 検証を通すために検証を書き換えられる
なら、そのゲートは1つ機能していないのと同じである。

抽出の側に落ち度は無い。第1.1節が書いたとおり抽出は「拡張子を持つスラッシュ入りトークン」を
拾うだけで、**受入条件の中の path は成果物であるのと同じくらい「実行するコマンド」である。**
形では区別できない。区別できないなら、既定をどちらに倒すかという裁定の問題になる。

回避は在った ——「受入条件に path を書かない」「読ませたいが変更させたくない path は参考見出しへ
逃がす」。どちらも**著者の注意力に依存する運用ルール**である。第1.5節が turn の話で書いたのと
同じ構図で、**規約は忘れられ、忘れられた回はゲートが無い回になる。**

### 17.2 裁定: ハーネスは deny-by-default。出口は成果物見出し1つだけ

`.claude/skills/**` / `.agents/skills/**` / `.commandmate/**` を `suspected_files` の導出から
**既定で除外する。** Issue が `## 対象ファイル`（`DELIVERABLE_HEADING_RE`）配下に明示的に書いた
場合だけ入れ、`harness_path_in_scope` の warning を付けて `partial` に落とす。

出口を残すのは #50 の再発を避けるためである。自分のハーネスを in-repo で保守している
リポジトリ（**このリポジトリがそうである**）に出口が無ければ、「言われたとおりに書いて scope
ゲートで落ちる」——第1.3節が消した障害——がそのまま戻る。出口を**1つに絞り、通ったことを
必ず名乗らせる**のが、閉じることと開けることの両立点である。

落とした path は捨てず `reference_files`（「読むが `scope.allow` には入れない」）に出す。
#54 が context 見出しの引用に与えたのと同じ channel で、第5.1節の不変条件4
（「引いた分も必ず可視である」）はここでも成り立つ。**worker は満たすべき runner を読めるが、
書けない。**

### 17.3 却下: 既定除外そのものに warning を付ける

第1.3節以来この ADR は「黙って捨てない」を守ってきたので、除外にも code を付ける案を検討し、
**却下した。** 理由は精度ではなく**摩擦の向き**である。受入条件に verify runner を書くのは
**正しい書き方**であり、そこに warning を出せば**ほぼすべての実 run が `partial` になる。**
第5.2節が「除外を持たない検出は自分の存在意義を壊す」と書いたのと同じ壊れ方で、
`--allow-questions` の常用と同じ道を通る。可視性は warning ではなく `reference_files` で
担保する —— **plan artifact に構造化されて残るので、読めるが、読み飛ばしを教えない。**

### 17.4 却下: 除外パターンを profile で宣言可能にする（hardcode を採った）

Issue は「既定で除外」としか言っていないので、**hardcode か profile 宣言かはこちらの裁定である。**
hardcode を採った。3つの理由を重い順に置く。

1. **profile は対象リポジトリが供給するデータであり、この deny-list は「審判を、裁かれる側から
   守る境界」である。** `scope_companions` 型の key で緩められる境界には**静かな二つ目の扉**が
   在ることになり、穴が Issue 本文から profile へ**移動するだけ**である。しかも profile 側の扉には
   warning が付かない。
2. **この3つの root はハーネスが決めており、リポジトリが決めていない。**
   `.claude/skills/` と `.agents/skills/` は CommandMate が Skill package を置く場所、
   `.commandmate/` は `verify.yaml` の置き場である。リポジトリが改名できるものではないので、
   **per-repository に宣言すべき中身が無い。** 第5節の「却下: profile 必須にする」は逆向きの
   結論だが理由は同じ形で、あちらの主題（テスト配置）は**リポジトリしか知らない規約**である。
   知っているのがハーネス側なら hardcode、リポジトリ側なら profile。
3. **出口は既に在り、使う場所で監査できる。** Issue 自身の成果物見出しと、それに付く warning が
   それである。

したがって除外集合を広げるのは fixture つきの code 変更になる。**認可境界に対しては、それが
適切な摩擦の量である。**

なお **L2（profile の `scope_companions`）による派生はこの filter を通していない。** profile は
prose ではなく**レビュー済みの宣言**であり、その entry は全件 `scope_defaults` に名前が出る。
「client が書いた散文が審判への書き込み権限になる」という本件の脅威は、そこには無い。
結果として、ハーネス path が `scope.allow` に入る道は**明示的な宣言2つだけ**になる ——
Issue の成果物見出し（warning つき）と profile の companion 規則（`scope_defaults` に可視）。
**散文からは入らない。**

### 17.5 Kewton/CommandMate#1756 との整合

#1756 は「`.commandmate/verify.yaml` を **scope の変更集合から除外しない**」——worker が触ったら
**検出する**——のが tamper 検出のための意図的設計である、と決めた。本件はそれと矛盾しない。
**層が違い、向きが同じ**だからである。#1756 は core の **scope ゲート**（変更を検出して裁く側）、
本件は planner の **`allow` の導出**（何を許可として渡すか）で、向きは「`allow` に入れない」。
したがって #1756 の検出は**弱まらず、強くなる**: これまで許可されていた編集が、これからは
**許可されていない編集として現れる。** 両者が食い違うのは「planner が渡さない」かつ
「core が見逃す」ときだけで、そういう組み合わせは作っていない。

### 17.6 変異注入の実測

fixture は2件（`cases/52-harness-path-denied` / `cases/53-harness-path-declared`）で、
**先に赤を確認してから実装した。** 作業ツリーを戻さずに測るため、`git show HEAD:` で
修正前の `orchestrate.mjs` を別ディレクトリへ出し、同じ Issue fixture を両方に通して差分を見た。

| | 修正前（HEAD） | 修正後 |
|---|---|---|
| `52`（散文で runner を引用） | `suspected_files` に `.commandmate/verify.yaml` と `.claude/skills/cmate-verify/scripts/verify-run.sh` が**入る**。`reference_files` は空 | 両方 `reference_files` へ。`suspected_files` は `web/src/lib/filter.ts` とその派生テストのみ。`success` のまま |
| `53`（`## 対象ファイル` で宣言） | `suspected_files` に入り、**warning は0件・`success`** | `suspected_files` に入り、`harness_path_in_scope` が付いて `partial` |

`53` は「入ること」だけを見ると修正前後で同じであり、**空振りしない case にするには warning と
status を併せて固定するしかない。** 逆に `52` は「入らないこと」が主張なので、
`reference_files` を固定して**どこへ行ったか**まで書いた —— 消えたのか移したのかを
区別しない期待値は、除外が広すぎる実装も緑にする。

### 17.7 既存 golden への影響（1件だけ、意図した変化）

`cases/18-anchored-path-candidates` が変わった。この case の Issue 本文は
`` `bash .claude/skills/cmate-verify/scripts/verify-run.sh` `` を**散文で**引用しており、
成果物見出しには何も書いていない。したがって本件の既定除外に**該当する**。
`suspected_files` から落ち、`reference_files` へ移った。

**この case が測っている #49 の主張は変わっていない。** 主張は「dotfile root が**丸ごと**
抽出され、`scripts/verify-run.sh` や `claude/skills/...` のような中間一致が生まれない」ことで、
それは移動先の `reference_files` でそのまま観測できる。期待値は「消えた」ではなく
「移った」に書き換えてあり、`reference_files` に partial path が1つも無いことも同時に固定される。

`expected-plan.json` を持つ3 case（`02` / `31` / `45`）はいずれもハーネス path を宣言して
いないので、**1 byte も変わっていない。** 再生成はしていない。

### 17.8 触っていない正本

`status.mjs` の hint map は**本変更の宣言 scope の外**だったので `harness_path_in_scope` を
持っていない。第14.5節・第16.7節と同じ扱いで、`codes-and-recovery.md` 第5節末尾の
「hint map にまだ無い code」に名前を足してある。それまで `status.mjs --run` はこの warning を
「detail と `summary_markdown` を読む」に落として表示する。**推測で別の対処を出さない**のが
status runner の約束なので、これは劣化ではなく既定の振る舞いである。**hint を足すのは次の
変更の仕事である。**

`cmate-issue-authoring` の planner mirror（`scripts/validate-plan.mjs`）も宣言 scope の外である。
本件の実装を `extractFileCandidates` / `classifyFileCandidates` の**内側に置かなかった**のは
そのためでもある —— あの2つは `mirror-conformance.mjs` が byte 単位で照合する領域なので、
内側に置けば mirror が即座に drift する。除外は `isSafeRepoPath` の直後（照合領域の外）に
独立した述語として置き、`analyzeIssue` から呼んでいる。結果として validator は
「散文でハーネス path を書いた Issue」を今も planner-ready と判定する ——
**その判定は今も正しい**（他に対象 file が在れば `suspected_files` は空にならない）が、
「その path は scope に入らない」ことは言わない。**それも次の変更の仕事である。**

---

## 18. 実装時の追記（段7・[#181](https://github.com/Kewton/commandmate-skills/issues/181)）

第15.2節は「定数の伴走 path」を第1版から外し、**入れるとしたらどう入れるか**まで書いていた
——「実例が出たら `derive` とは別の key（例: `require`）として足す —— そのとき『宣言と無関係』
であることを key の名前が明示する」。本節はその**実例が出たこと**と、書いてあったとおりに
足したことの記録である。正本は [profile-contract.md](./profile-contract.md) 第9.2節
（`require` の形）・第9.3節（拒否表）・第9.6節（harness 境界）と
[plan-contract.md](./plan-contract.md) 第5.1節（4つ目の導出元）である。

### 18.1 実例は「集約テスト」だった

利用リポジトリ（Kewton/BorderFreeKidsMap）の実測。`scripts/**` と `web/src/shared/*.mjs` を
触る Issue は、毎回 `scripts/tests/shared-contract.test.mjs` —— 複数モジュールを1本で検証する
契約テスト —— を `## 対象ファイル` へ**手書きする運用ルール**になっていた。

- L1（段1）が導出するのは**ソース名規則**の配置だけである。0.26.0 実測で、L1 は5ファイルの
  宣言から18 path を導出した。集約テストはその18件に入らない
- `derive`（段4）にも書けない。`add` は `when` が束縛した placeholder を必ず含まなければ
  ならず、`shared-contract` はどの `{base}` でもない

**どのソース名とも対応しないことが集約テストの定義**なので、これは規則の抜けではなく
**規則で表現できない種類の伴走**である。残った経路は Issue 本文への手書きだけで、
書き忘れれば worker はテストを更新できないまま scope ゲートに当たる ——
第1節が3回測った、あの失敗そのものである。

### 18.2 裁定: `derive` を緩めず、`require` を足す

第15.2節の予告どおり**別 key** にした。`add` に placeholder を要求しないことを `derive` の
側で許すのが最短だが、そうすると不変条件1の検査が「glob でないこと」だけに痩せる ——
第15.2節が既に書いていた理由である。加えて #181 が名指しした劣化条件がある:
**誤記した placeholder が「リテラル path」として黙って通ってはならない。**

判別は**中身の推測ではなく key** で行う。両者は互いの形を拒否する。

| | `derive[].add` | `require[].add` |
|---|---|---|
| placeholder | **1つ以上**必須（すべて `when` が束縛） | **0個**必須 |
| 安全性 | 宣言済み path から組み立てるので抽出時に検査済み | `isSafeRepoPath` ＋ harness 拒否を **load 時に**通す |

括弧が残っている誤記（`{Base}` / `{ext}` / `{base`）は、そもそも
`parseCompanionTemplate` が**両方の key で**トークン化して拒否するので literal に化けない。
残るのは**括弧ごと落とした誤記**（`spec/{dir}{base}_spec.rb` のつもりで
`spec/dir/base_spec.rb`）で、これは `derive` に書いてある限り拒否される。合法になるのは
**key を移したとき**だけ、つまり著者が「この path は固定である」と宣言したときだけである。

不変条件1は `require` について**弱くなった**（literal は宣言済み path の関数ではない）。
弱くなったことを隠さないために key を分けている。**gate は残っている** —— `when` に一致する
宣言が1つも無ければ1件も出ないので、`|closure| ≤ (add 総数) × |declared|` も
「`suspected_files` が空なら `scope_defaults` も空」も成り立つ。不変条件2・3 は同一である
（同じ1本の list に合流し、disk も clock も読まない）。

`when` の語彙は**変えていない**。#181 の提案本文は `{ "when": "scripts/**" }` と書いているが、
glob を `when` に入れると「glob 構文が存在しない」という第15.1節の言明が消える。
`scripts/**` は `scripts/{dir}{base}` と等価に書けるので、**エラー文にこの対応を載せた**
（`**` → `{dir}{base}`、`*` → `{base}`）。本文と実装が食い違う唯一の点であり、
**本文の意図（`scripts/**` に一致する宣言で発火する）はそのまま実現されている。**

### 18.3 入れなかったもの（第15.2節の表の更新）

`{ext}` placeholder・規則の除外条件（`unless`）・profile が L1 を上書きすること・
`scope_defaults` の `{path, origin}` 化は**いずれも入れていない**。理由は第15.2節のままである。
`require` の `when` に glob を許すことも入れていない（第18.2節）。

`require[].when` が placeholder を持たないことは**許した**。束縛を書き戻さない key では
固定 `when` が完結した規則（「この file を触るならあの file も触ってよい」）であり、
`derive` で同じ形を拒否している理由（束縛が無ければ `add` を宣言の関数にできない）が
そもそも当てはまらない。

### 18.4 #177 の境界は profile 側にも引いた

[#177](https://github.com/Kewton/commandmate-skills/issues/177) 第17.4節は、ハーネスの
既定除外を hardcode した理由として「`scope_companions` 的な key で緩められる境界は、
静かな2つ目の扉を持つ境界である」と書いている。literal 伴走は**まさにその key** なので、
穴が profile 側に開き直らないよう2か所で塞いだ。

- **literal（`require[].add`）は load 時に `load_error`。** 静的に判定できるし、
  profile は人がレビューする成果物なので、その場で落とすほうが直せる。
  黙って落とせば「一致しない規則が黙って残る」ことになる
- **template（`derive[].add`）が harness に展開されたときは導出時に落とす。**
  ただし**宣言済み path 自身が harness の中にあるとき**は落とさない —— それは Issue が
  成果物見出しで名指しし `harness_path_in_scope` で記録された、#177 が認めている唯一の
  許可だからである。L1 は同じ宣言から慣習テスト path を derive しており（除外されない）、
  L2 だけを落とせば「どの層が出したか」で境界が変わることになる

`derive` 側の template 判定を load 時にしなかったのは、展開結果が束縛に依存するからである
（`{dir}` が harness の中を束縛しうる）。**判定できる所で落とし、できない所は出口で落とす。**

### 18.5 profile-init は `require` を起案しない（裁定）

第15.6節の規律 —— **対で裏が取れた配置だけを起案する** —— を literal に当てると、起案できない。
集約テストは定義上どのソース名とも対応しないので、対になる実ファイルが存在しない。
`when`（どの宣言が引き込むべきか）も「その file が何を覆っているか」という意味の言明であって、
tree からは読めない。起案すれば規則の**両側を発明して** `detected` と名乗ることになり、
それはこの runner が避けるために存在している「黙った推測」そのものである。

代わりに TODO `scope_companions_undetermined` の**文面**が `require` を名指しするようにした。
この TODO は検出が0件のときに出る、つまり人間がちょうどこの field を読んでいるときに出る。
（それまでの文面は「repo が要求する docs」を宣言せよと勧めていたが、それは `derive` では
表現できない形だった —— 助言どおりに書くと `load_error` になる文面だったことになる。）

`detected` で出る draft には TODO を足していない。第15.6節が書いたとおり、
**全 field に根拠がある draft が `success` である**という suite の性質を壊さないためである。

### 18.6 赤→緑の実測（fixture が空振りでないこと）

追加した6つの case / 15行の拒否表を、**実装前の runner**（`git show HEAD:…/orchestrate.mjs`
を別 directory へ出したもの）で回して**全件赤**を確認してから実装した。

拒否 case は `exit 6` と `load_error` だけでは**空振りになる** —— `require` を知らない runner は
その key を未知として同じ code で落とすからである。そこで harness に
`error_details_include` / `todo_details_include` を足し、**どの検査が落としたか**を
detail の部分文字列で固定した。第15.8節が case `46` について記録した
「2つの検査に引っかかる行はどちらも測れていない」と同じ規律である。

`expected-plan.json` を持つ4 case（`02` / `31` / `45` / `61`）は literal companion を
持たない profile の case なので、**1 byte も変わっていない。再生成もしていない。**

さらに、追加した検査が**空振りでない**ことを変異注入で実測した（runner の copy を作業 tree の
外に置いて回した。作業 tree は書き換えていない）。

| 変異 | 実測 |
|---|---|
| `require[].add` の `isSafeRepoPath` を外す | case `64` が赤（`exit 6` → `0`）。**ただし path は scope に出ない** —— 導出時の `isSafeRepoPath` が2枚目として落としている |
| `require[].add` の harness 拒否を外す | case `65` が赤（`exit 6` → `0`）。同じく導出時の harness 落としが2枚目として効き、path は出ない |
| 導出時の harness 落としを外す | `.claude/skills/lib/normalize.test.mjs` が **非 harness の宣言から生える**（`profileLiteralCompanionTest` が赤）。宣言済み harness path から derive した `…/run.contract.mjs` は両方で出る |
| `require[].add` の「placeholder 禁止」を外す | 拒否表 "a template in require.add" が赤。`require` が `derive` の別名に化ける |
| `derive[].add` の「placeholder 必須」を外す | **既存 case `47` が赤** —— `docs/module-reference.md` が `scope_defaults` に生える。`derive` を緩めていないことは、この case が今も緑であることで測られている |

上2行が示すとおり、literal の安全性は **load 時の拒否と導出時の落としの2枚**で守られている。
case が測っているのは**声の大きいほう**（load 時）で、静かなほうは変異注入で測った。

### 18.7 触っていない正本

`release-notes.md` は本変更の宣言 scope の外なので触っていない。`status.mjs` の hint map も
同様である（新しい code は増えていないので、追記すべきものも無い）。
`cmate-issue-authoring` の planner mirror は companion 系の関数を写していないため無関係である
——`mirror-conformance.mjs` の照合領域は `firstNonEmptyLine` から `isSafeRepoPath` の直前までで、
本変更が触った関数はすべてそれより前にある。`isSafeRepoPath` 自体は**呼んだだけで
変更していない**。

---

## 19. 実装時の追記（段8・[#219](https://github.com/Kewton/commandmate-skills/issues/219)）

### 19.1 不変条件1は「導出」の規則であって、「宣言」の規則ではない

第2節の不変条件1は「**導出元は必ず宣言済みファイルである。単独の glob を足さない。**」と
書いてある。#219 の実装中、この 1 行が「planner は glob を scope に入れない」と読めることが
問題になった。読み違いである。不変条件1が縛っているのは `companions(declared)` ——
**planner が足す側**であり、`declared` そのものではない。

| | 誰が決めたか | 不変条件1の適用 |
|---|---|---|
| `declared`（Issue 本文が成果物見出しに書いた entry） | **著者** | **適用しない。** 著者は glob を書いてよい |
| `companions(declared)`（L1 の test 伴走・L2 の profile 規則） | planner / profile | **適用する。** 宣言済み entry の純関数であり、単独 glob を足さない |

不変条件1が守っているのは「**宣言が空なら閉包も空**」（#50 が塞いだ穴 ——
宣言しない plan が最広権限を得ること）であり、その性質は著者が glob を宣言しても壊れない:
`|closure| ≤ k × |declared|` は entry の**個数**についての式であって、entry が指す file の
個数についての式ではない。もともと `src/` 直下を1つずつ 46 行書いても同じ権限になる
（実測 Kewton/BorderFreeKidsMap #243）。**46 行と 1 行の差は権限ではなく可読性である。**

その代わり、著者の宣言にも1つだけ上限を置いた: **repository 全体を意味する pattern は拒む**
（`over_broad`。全 segment が `*` / `**` の pattern と `.`）。これは不変条件1ではなく、
「scope ゲートを持つ契約」という前提そのものを守るための線である —— `allow: ["**"]` は
決して失敗しない gate であり、gate が無いのと同じである。**狭めるのではなく落とす**:
`**` が何を指すつもりだったかを planner が推測すれば、それこそ不変条件1が禁じている導出になる。

### 19.2 導出は pattern からも走る（そして走ってよい）

L1 の test 伴走は宣言 entry の**文字列関数**なので、宣言が pattern なら伴走も pattern になる
（`src/{a,b}/x.ts` → `src/{a,b}/x.test.ts`）。これは不変条件1に反しない: 導出元は宣言済み
entry であり、出力は入力の純関数である。拡張子を持たない entry（`data/geo/**`・
`data/geo/stations/`）は `testCompanionShapes` の「拡張子に規則が無ければ何も出さない」
規則にそのまま落ちるので、ディレクトリ宣言から伴走が生えることはない。

### 19.3 不変条件2（足した分は必ず可視）を pattern でどう満たすか

`scope_defaults` は「planner が足した entry」を列挙することで不変条件2を満たしている。
pattern にはこの手が効かない —— `data/geo/**` が何 file を指すかは、working tree を開かない限り
書けない（不変条件3）。**そこで列挙するのは宣言そのものにした**（`scope_pattern_declared`）。
レビュアが重さを測る対象は展開結果ではなく pattern そのものであり、これは不変条件2の
「黙って広げない」を、展開せずに満たせる唯一の形である。

展開結果を証跡に残す案は**却下**した（#219 スコープ外・CommandMate#1833 実装上の注意1）。
planner / dispatch が tree を開けば不変条件3（契約は plan の純関数）が壊れる。証跡は
**裁定を行う側**、すなわち CommandMate の scope ゲートが「変更 file ごとにどの allow pattern が
許可したか」を残すのが筋であり、上流に Issue を起票済みである（Kewton/CommandMate#1841）。

### 19.4 第12節「4件目が来たら ADR に戻る」の該当事例

#219 は scope 導出テーマの 4 件目であり、第12節の見直し条件に当たる。**層構成（L1〜L4）は
変えていない。** #219 が触ったのは層ではなく、L0 —— 「宣言」そのものの語彙 —— だからである。
著者が書ける語彙が契約の受理集合より狭かった、というのが本件の正体であって、導出を
1段も足していない。

同時に持ち込まれた「同じ識別子を参照する file の随伴」（CommandMate#1833 提案3）は
**入れていない**。静的な一覧なら profile-contract.md 第9.2節の `require` で今日書ける
（46 行の置き場が profile に移るだけ）。動的解決は tree を開くので不変条件3に触れる ——
読み取り専用の点検 runner（`--check-references`）の報告に載せる候補として、ここに記録だけ残す。
