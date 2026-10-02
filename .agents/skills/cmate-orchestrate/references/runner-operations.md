# runner の運転ノート（SKILL.md から移送した機構の細部）

この文書は [SKILL.md](../SKILL.md) から**そのまま移送した**説明である。**削っていない。**

- 何をどう呼ぶか（いつ使うか / 呼び出し方と順序 / 出力の読み方 / 停止時に人間が何をするか）
  → [SKILL.md](../SKILL.md)
- どう振る舞うと約束しているか → `*-contract.md`（正本）
- なぜその約束になったか → [release-notes.md](./release-notes.md)
- **その約束を運転するとき、SKILL.md の4点に収まらない細部** → この文書

0.14.0 は SKILL.md を上の4点に絞り、機構の詳細を正本への一方向参照に変えた。0.20.0 はその方針
から外れて SKILL.md が肥大し、**CommandMate のスラッシュコマンドパレットが読み込みを諦める
64KB を超えた**（[#135](https://github.com/Kewton/commandmate-skills/issues/135)）。方針へ戻す
ための移送先がここである。**この文書は契約の正本ではない** —— 各節の末尾が名指しする
`*-contract.md` と食い違ったら、正本が勝つ。

| SKILL.md での位置 | ここでの節 |
|---|---|
| 冒頭のランチャー表記 | 第1節 |
| 第2節 前提条件（worktree） | 第2節 |
| 第2節 前提条件（条件付き依存の Skill） | 第3節 |
| 第3.2節 dispatch（`--prepare-worktrees`） | 第4節 |
| 第3.2節 dispatch（`--worker-method`） | 第5節 |
| 第3.2節 dispatch（`acceptance-gates` ブロック） | 第6節 |
| 第3.2節 dispatch（`--resume`） | 第7節 |
| 第3.2節 dispatch（`--reverify`） | 第8節 |
| 第3.2節 dispatch（契約経路とフォールバック） | 第9節 |
| 第3.2節 dispatch（`--unattended`） | 第10節 |
| 第3.2節 dispatch（monitor との境界） | 第11節 |
| 第3.3節 merge（PR 本文） | 第12節 |
| 第3.5節 profile-init（押さえるべき3点・`--check`） | 第13節 |
| 第3.6節 inspect（`--check-references` の判定範囲と境界） | 第15節 |
| 第3.7節 status（read-only の契約と表示規則） | 第14節 |

---


## 1. ランチャー表記

> **ランチャー表記** — 本文中の `commandmate …` は**読み替え可能**である。グローバル導入をしない
> npx 運用では `npx commandmate@latest …` と読む。同梱 runner（dispatch / uat）は `--cli <launcher>`
> または環境変数 `CM` で解決する（既定 `commandmate`、`npx commandmate@latest` のようなスペース
> 区切りの複数トークンも可。シェルは経由しないので、パイプ・リダイレクト・変数展開・引用符は
> 助言つきで拒否する）。ランチャー解決は実行時の話であり、**plan.json には混入しない**。呼び出し
> 頻度が高い経路では npx の起動コスト（1 回あたり 0.5〜0.9 秒）を避けるため、
> `~/.local/bin/commandmate` に `exec npx --yes commandmate@latest "$@"` の薄いラッパを置く導入
> 形態を推奨する（README の「CommandMate CLI の導入形態」）。


## 2. worktree の前提（dispatch は worktree を作らない）

**worktree**: dispatch は worktree を**作らない**。dispatch 対象 Issue の worktree が事前に存在し、
`commandmate ls` で解決できること。無ければ
[cmate-worktree-setup](../../cmate-worktree-setup/) で作成する。branch 名を一致させるため、
**cmate-worktree-setup と本 skill には同じ profile（同じ `branch_template`）を渡す**こと
（片方だけ既定 profile で走らせると branch がずれ、`commandmate ls` の branch 一致で解決できない）。
解決できない Issue があると、dispatch は**最初の Wave の前に停止する**: `worktree_unresolved` で
1人も dispatch せず、`--out` も作らない（[SKILL.md](../SKILL.md) 第5節。worktree を作って同じコマンドを再実行すればよい）。
1つのコマンドで通したいなら `--prepare-worktrees --worktree-setup <launcher>` を渡す（[SKILL.md](../SKILL.md) 第3.2節）。
**その場合も worktree を作るのは `cmate-worktree-setup` であって dispatch ではない**（合成であって
再実装ではない）。profile は plan のものが provider にそのまま渡り、二重指定は拒否される。
なお `commandmate ls` が解決できなかったとき、dispatch は run 全体で1度だけ
`commandmate sync`（CommandMate 0.21.0+ の server 側 worktree 再スキャン）を試して `ls` を読み直す。
**sync は worktree を作らない**ので「未作成」は解決しないが、「**disk には在るが server 未登録**」
（server 起動後に `git worktree add` した等）はこれで解決する。試行結果は `limitations` に残り、
それでも未解決なら上記の停止になる。


## 3. 条件付き依存の Skill —— 3つの「黙って劣化しない」の結果の違い

3つとも**黙って劣化しない**という型は同じだが、結果は違う。意味ゲートは未導入でも機械ゲートで
裁定できるので**続行して記録**する。worktree 準備は、準備できなければ **dispatch する対象が
存在しない**（続行しても全 Issue が「worker を起動できないまま failed」になるだけ）なので**停止**する。
理由は [references/adr-worktree-preparation.md](./adr-worktree-preparation.md) 第5節。

方法論も**停止**する側である。`--worker-method` を指定した run は「**方法が揃っていること**」を
前提にした run であり、揃わないまま走らせればその前提が偽のまま wave が進む。停止のコストは
`commandmate skill install <id>` と**同じコマンドの再実行**だけで、`--out` は消費していない。
理由は [references/adr-worker-development-skill.md](./adr-worker-development-skill.md) 第3.4節。

**`--worker-method` の判定は「両 root に在ること」である。** CommandMate は Skill を
`.claude/skills/<id>/`（Claude が読む）と `.agents/skills/<id>/`（Codex が読む）の両方へ
byte-identical に配備し、**dispatch はどちらの Agent が worker になるかを知らない**
（`send --agent` を一度も渡さず、`ls --json` の row も agent を持たない）。片側だけの worktree を
「入っている」と読むと、worker が構造的に開けない file を「これを読め」と契約に書くことになる。
片側だけ在る場合はその旨が blocking reason の detail に出る（「無い」と「半分ある」は別の情報である）。

未導入の環境では SKILL.md と本書中の `../../cmate-acceptance-test/...` /
`../../cmate-worktree-setup/...` / `../../cmate-worker-development/...` への相対リンクが
解決しない。
**リンク切れ自体が「まだ入れていない」ことのサイン**である。
plan / merge はどの Skill にも依存しない。dispatch が `cmate-worktree-setup` /
`cmate-worker-development` に依存するのは、それぞれ `--prepare-worktrees` /
`--worker-method` を指定したときだけである（どちらも既定 off）。


## 4. dispatch: worktree 準備段（`--prepare-worktrees`。既定 off）

**worktree 準備段（`--prepare-worktrees`。既定 off）** — pre-flight が `worktree_unresolved` だけを
理由に止まるとき、`--worktree-setup <launcher>` で渡した
[cmate-worktree-setup](../../cmate-worktree-setup/) provider を **plan と同じ profile / base で1回だけ**
呼び、`commandmate sync` で registry を再スキャンしてから pre-flight をやり直す。

- **dispatch は `git worktree add` を実行しない。** 作成・collision 検査・base SHA 再確認・
  baseline は provider の責務で、この runner は結果（`worktree-setup.result.v1`）を検証するだけである。
- **一部しか作れなければ、作れた分だけを dispatch しない。** 未解決 Issue について従来どおり停止する。
- **失敗しても、作ってしまった worktree を消さない。** 後始末は human と
  [cmate-worktree-cleanup](../../cmate-worktree-cleanup/) の担当である。
- **未導入・呼び出し不能なら停止する**（`worktree_setup_unavailable`）。黙って既定の fail-fast に
  戻ることもしない。対象は**最初の Wave の Issue だけ**で、2つ目以降の Wave の worktree が無い場合は
  従来どおりその Wave で止まる。

規則の正本は [dispatch-contract.md](./dispatch-contract.md) 第3.0.1節、
裁定の記録は [adr-worktree-preparation.md](./adr-worktree-preparation.md)。


## 5. dispatch: ワーカー側の方法論（`--worker-method`。既定 off）

**ワーカー側の方法論（`--worker-method`。既定 off）** — 契約が worker へ渡すのは、これまで
**WHAT（目的・受入条件・境界）と制約だけ**で、**HOW を渡す口が無かった**。
`--worker-method <skill-id>` はその口である。渡すと、task text の `## Objective` の直前に
`## Method` 節が1つ入り、**どの Skill を読むか・どこに在るか・無ければ止まれ**の3つだけを書く。

- **足すのは「方法」であって「権限」ではない。** ゲートを緩めず、`scope.allow` を広げず、
  push / PR の権限を与えない。**方法論と契約が食い違ったら契約が勝つ**と節自身が明記する。
- **install を実測してから dispatch する。** 対象 worktree の
  `.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**を読み、
  在ることを確かめる。無ければ `worker_method_unavailable` で**停止**する（[SKILL.md](../SKILL.md) 第2節）。
  最初の Wave なら `--out` を作る前なので、**install して同じコマンドを再実行**すればよい。
- **all-or-nothing である。** install 済みの worker だけ方法論つきで走らせ、残りを素通りさせない。
  方法が worker ごとに違う wave では「全部通った」の意味が run ごとに変わる。
- **契約 goal と worker prompt の両方に入る。** 片方だけだと `--contract-mode auto` が
  契約非対応 CLI にぶつかったときに方法論だけが黙って消える。
- **方法論の要約は runner に持たせない。** 節が書くのは skill 名と path だけなので、
  方法が変わっても `cmate-orchestrate` を再リリースしなくてよい。
- **既定では何も起きない。** 指定しない run は、この機能が存在しなかった頃と **byte 一致**する
  （Skill が install 済みの worktree であっても、勝手に on にはならない）。
- 証跡は `dispatch_schema_version` を上げずに `limitations[]` で運ぶ:
  `worker_method_declared`（run 全体で1件）と `worker_method_applied`（Issue ごとに1件）。
- **「適用された」と「守られた」は別の事実である。** dispatch が測れるのは
  ①宣言した ②skill が worktree に在った ③契約に書いた の3つだけで、
  **worker が実際に方法論に従ったかは測っていない**。遵守の証拠は worker の成果物側にあり、
  機械で測りたいなら Issue の `acceptance-gates` が正しい場所である。

規約の正本は [dispatch-contract.md](./dispatch-contract.md) 第1節・第3.0節、
裁定の記録と実測は
[adr-worker-development-skill.md](./adr-worker-development-skill.md)。


## 6. dispatch: Issue が名指しした受入ゲート（`acceptance-gates` ブロック）

**Issue が名指しした受入ゲート（`acceptance-gates` ブロック）** — Issue 本文に置かれた
`` ```acceptance-gates `` ブロックの `require:` は、その Issue の裁定に**必ず参加しなければならない**
gate id の宣言である。ここまで `verify.gates` は operator の run 単位フラグでしか動かせず、
Issue ごとに違うゲート集合を要求する方法が無かった。

- **明示ブロックだけを運ぶ。散文からは何も生成しない。** `test_expectations`（Issue 本文の
  backtick から拾ったコマンド）は従来どおり**助言的**で、裁定には使われない。引用は指示ではなく、
  抽出結果は profile にも依存するので、裁定の根拠にできない。
- **planner は構文と Issue 番号スコープしか見ない。** id が実在するかは dispatch が worktree の
  `.commandmate/verify.yaml` に突き合わせ、**`send` する前に**拒否する
  （`acceptance_gate_id_unknown`）。`send --contract` の exit 2 には落とさない。
- **`require:` だけでは `verify.gates` を書かない。** 書くと「そのゲートだけ走らせる」になり、
  lint も test も走らなくなる — 受入条件を足したつもりで判定が弱くなる。キーを省略したまま
  全ゲートを走らせるほうが厳しい。
- **`gates:`（新規コマンドの定義）は実行契約が運ぶ**（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）。
  定義は契約の `verify.gateDefinitions` に載り、**`.commandmate/verify.yaml` には 1 バイトも
  書かない**。id は `issue-<番号>-<何を測るか>` でなければならず、worktree の既存 gate id と
  衝突すれば dispatch が `send` の前に止める（`acceptance_gate_id_conflict`）。
- **壊れたブロックは「無かったこと」にしない**（`acceptance_gate_block_invalid`）。
  32 件の上限を超えたブロックも**切らずに拒否する**。
- report の `verification.gates[].origin` に由来（`repo` / `issue`）が残る。**欠落は
  「記録されていない」であり `repo` ではない。**

記法の正本は [acceptance-gates-notation.md](./acceptance-gates-notation.md)、
dispatch 側の規約は [dispatch-contract.md](./dispatch-contract.md) 第2.9節、
裁定の記録と実測は [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md)。


## 7. dispatch: 部分失敗からの再開（`--resume`）

**部分失敗からの再開（`--resume <前回の --out>`）** — 並列開発では Wave 途中の1 Issue だけが
落ちるのが常態である。`--resume` は前回 run の**最新 report** を読み、次のように分ける。

- **引き継ぐ**: `worker_state: completed` **かつ** `verification.outcome: pass` の Issue。
  **再 dispatch しない。** その verification 記録（`ran` / `gates` / `checks`）を新 report に
  **転記する**（ここで再判定はしない）。merge / uat はこの2 field しか読まないので、
  引き継いだ Issue はそのまま eligible のままである。
- **再実行する**: それ以外（`failed` / `timeout` / `prompt` / `not_dispatched` / pass でない
  verdict / 記録が無い）。
- **Wave barrier は再計算する。** 全員引き継ぎの Wave は 1件も dispatch せず即座に advance する
  ので、**依存元が pass 済みの Issue は待たされない**。引き継ぎ Issue の worktree は解決を要求
  されない（merge 済みで消えていてよい）。
- **停止条件・裁定規則は通常 dispatch と完全に同一である。** exit 0/7/1、Auto-Yes 既定 off、
  mutating wave 前の drift 再確認、verification gate — どれも緩めない。
- **artifact は上書きしない。** attempt 1 は `<out>/dispatch-report.json` のまま、attempt N は
  `<out>/resume-attempt-N/dispatch-report.json` に append される。`<out>/attempt-history.jsonl`
  に attempt 1行ずつの台帳が残る。**merge / uat / status には最新 attempt の report を渡す**
  （引き継ぎ分も再実行分も、その1本に揃っている）。
- **別 plan の report では resume させない。** `run_id` / repository / base が `--plan` と
  一致しなければ `resume_plan_mismatch`、report が `dispatch-report.v1` として読めなければ
  `resume_invalid` で、どちらも**何も dispatch せず・何も書かずに**拒否する。
- 再実行対象が1件も無ければ、`resume_no_work` を明示して **CLI を1回も叩かずに** exit 0 で終わる。

規則の正本は [dispatch-contract.md](./dispatch-contract.md) 第8節。


## 8. dispatch: 送らずに裁定だけ取り直す（`--reverify`）

**送らずに裁定だけ取り直す（`--reverify <前回の --out>`）** — `wait --verify` が timeout すると、
その時点の裁定が report に凍る。worker がその後に完走して commit しても report は更新されないので、
**検証に通る成果物が merge の eligible から外れたまま**になる。`--resume` はここから回復できるが、
回復の手段が**再 dispatch** である —— 作業が既に終わっていると分かっている worker のターンを1つ消費し、
契約を再送するので余計な差分が生まれる余地も残る。`--reverify` は同じ分割を行い、後半に対して
**送らずに裁定だけを取り直す**。

**重いゲートを並べると負荷で落ちる repo は `--verify-concurrency <n>`**（[#274](https://github.com/Kewton/commandmate-skills/issues/274)）。
`--reverify` は対象 Issue を既定で**同時に**判定する。`cargo test --all-targets` のように実行時間に依存するテストを
含むゲートを2件並べると、1件ずつなら通るのに負荷で timeout して `verification_failed` になる。
`--reverify <dir> --verify-concurrency 1` で1件ずつ判定する。これは plan の値ではなく run の引数なので、
`--max-parallel` と違って run id にも前回 report との突き合わせにも入らず、付け外しで `--reverify` が拒否されない。
使った値は limitation `verify_concurrency_limited` に残り、report の並びと verdict は値で変わらない。

**どちらの timeout だったかは、report が言う**（[#179](https://github.com/Kewton/commandmate-skills/issues/179)）。
runner は wait が timeout した時点で `capture --json` を1回だけ叩き、当該 worker の `worker_liveness`
（`isRunning` / `isGenerating` / `isPromptWaiting` / `sessionStatus` / 経過秒）と blocking code を書く ——
`wait_window_exhausted`（**稼働中。この flag の出番**）/ `worker_stalled`（稼働の証拠なし。要るのは
裁定ではなく worker なので `--resume`）/ `worker_liveness_unreadable`（**測れていない**ので、どちらとも
読み替えず手で `capture` を確かめる）。`capture --json` を人間が手で叩いて見分ける必要はもう無い。
規範は [dispatch-contract.md](./dispatch-contract.md) 第2.11節。

- **`send` を1回も呼ばない。** 実行契約も書かず、worker のターンも1つも消費しない。これがこの
  flag の存在理由である（fixture が `sent: []` で固定している）。
- **引き継ぎ規則は `--resume` と同一である**（`completed` かつ `pass`）。同じ関数を使っている。
  引き継いだ Issue は**再判定もしない**。
- **再判定するのは「worktree に作業が在る」Issue だけである。** 「作業が在る」は work-evidence
  ゲートと同じ2つの事実 —— **work ブランチの commit / worktree の未 commit の変更** —— であり、
  `git rev-list --count <base>..HEAD` と `git status --porcelain` で**判定の前に**測る。
  推測しない。前回 report の `worker_state` からは読み取らない（timeout の record は
  `not_run` であって、測定結果を1つも持っていない）。
- **作業が無い Issue は判定にかけない。** かければ exit 21（work-evidence がゼロ）が `fail` として
  記録され、誰も作業していない Issue の記録を**格下げ**することになる。前回 record をそのまま転記し、
  `reverify_no_work_evidence` で理由を書く。読めなかった場合は `reverify_evidence_unreadable`
  （「見られなかった」は「無い」ではない）。prompt 保留中の Issue も対象外である
  （`reverify_prompt_pending`。人間が握っているターンの途中を裁定しない）。
- **完了の定義は変えない。** `completed` に上がるのは work ブランチに commit が在るときだけである。
  未 commit の作業しか無い Issue は納品できないし、この経路は commit を要求できない（要求は send である）。
- **裁定機構も変えない。** 契約経路なら `commandmate verify <worktree-id> --json` の exit code
  （0 / 20 / 21 / 99 の意味は通常経路と同一）、契約非対応なら profile baseline の再実行。
  **新しい CLI 表面は要求しない。**
- **artifact の作法・整合性ガードは `--resume` と同一である。** attempt N は
  `<out>/resume-attempt-N/` に append し、既存 artifact を上書きしない。別 plan の report は
  `resume_plan_mismatch`、読めない report は `resume_invalid` で拒否する（code も共有する）。
  台帳の行は `kind: "reverify"` で、`dispatched` は空、`reverified` に再判定候補が載る。
- **`--unattended` の排他 lock は取る。** 送らないが、`commandmate verify` は **worktree の中で
  ゲートを実行する**し、その裁定は merge が eligible として読む report に書き込まれる。別の run の
  worker が書き換えている最中の木を裁定すると、**誰も納品していない状態についての合格**を作って
  そのまま届けてしまう。

規則の正本は [dispatch-contract.md](./dispatch-contract.md) 第8.5節。


## 8.5 dispatch: plan の一部だけ dispatch する（`--only`）

**条件の揃った Issue だけ先に走らせる（`--only 12,14,15`）** — 5 本の plan のうち 2 本が宣言の不備で
止まっているとき、plan を組み直さずに残り 3 本を dispatch できる。

1. `--only` には plan にある番号だけを書く。無い番号は `invalid_input`。
2. 選んだ Issue が依存する Issue も一緒に選ぶ（前回 attempt が pass させた依存を `--resume` で引き継ぐ場合は
   不要）。選ばないと `invalid_input`（何も dispatch せず、`--out` も作らない。detail の
   「#N depends on #M」を見て足すか外す）。
3. 走った結果は report の `plan_scope` で読む。`deselected` の Issue は worker_state `not_dispatched`
   （note `excluded by --only`）で、失敗ではなく**未着手**である。選んだ Issue がすべて pass なら `success`。
4. 残りは、条件を直したあとに `--resume <前回の --out> --only <残り>`（部分集合を広げる）か、
   `--only` を付けずに `--resume`（前回の部分集合を引き継ぐ）で進める。

正本: [dispatch-contract.md](./dispatch-contract.md) 第3.0.5節。

## 9. dispatch: 契約経路とフォールバック

契約経路では plan だけから **実行契約 yaml** を決定的に生成して worktree に置き、
`commandmate send <worktree-id> --contract <path>` で dispatch する（**同一 plan → byte-identical
な契約**）。契約非対応の CLI では明示メッセージつきで profile baseline 再実行に落ちるか、
`--contract-mode require` なら停止する。**どちらの裁定機構で判定したかは常に report と summary に
明示される**（黙って劣化しない）。


## 10. dispatch: 無人運転（`--unattended`。既定 off）

**無人運転（`--unattended`。既定 off）** — CI / cron から人間の居ない環境で dispatch を回すための
**入力の宣言**である。**mutation の権限を与えるフラグではない。**

- **含意するのは締め付けだけである。** ゲートを1つも無効化せず、blocking を limitation に格下げせず、
  status を1段も上げない。停止理由・status・exit の写像（[SKILL.md](../SKILL.md) 第4節）は1文字も変わらない。
  全 gate が pass する世界では、**フラグ無しの run と同じ `status` / `stop_reason` / `waves[]` になり、
  差分は下の2つの limitation だけ**である（fixture で機械的に固定してある）。
- **`--approve` を含意しない。** merge / uat を無人で回す CI は**両方**書く。
  「無人だから安全側に倒したい」つもりで付けたフラグに mutation 権限が付いてくることは無い。
- **緩和フラグとの併用は `invalid_input`（exit 3）で拒否する。** `--auto-yes`（prompt 停止が
  構造的に到達不能になる）・`--allow-questions`（引き受ける主体が居ないときに立てられる旗ではない）・
  `--contract-mode off｜auto`。**黙って上書きしない** —— どちらの宣言が勝ったかを、report の読み手
  （無人運転では次の job）が判定できなくなる。
- 含意する締め付けは6つ: **①`--contract-mode require`**（フォールバック経路には scope ゲートが
  存在しないので、scope 必須化と契約必須化は同義である）／**②pre-flight で plan 全 Issue の scope 宣言を
  all-or-nothing 検査**（1件でも欠ければ **1人も dispatch せず・`--out` も作らずに**停止。未回答 question も
  同じ pre-flight で報告する）／**③worktree 単位の排他 lock**（2本目の run を拒否する。`--out` は
  mutex にならない）／**④`--wall-clock-budget` の明示必須**（回数は有界でも時計は有界でない）／
  **⑤`unattended_baseline` の記録**（各 worktree の開始時 HEAD を branch 名と短縮 SHA で残す）／
  **⑥裁定の根拠の要求**（段階 C。`verification_gates_unrecorded` を blocking として扱い、
  `GATE` 行を1本も読めなかった pass が在れば **次の wave を dispatch せずに停止**する。
  **裁定そのものは書き換えない** —— exit code の pass はそのまま残り、変わるのは run が先へ進むかだけ）。
- **runner は次の phase を始めない。** 無人運転の driver は **CI の job 定義（cron script）**であって
  runner ではない。plan → dispatch → merge → uat を1コマンドで回す5つ目の runner は作らない。
- **job 定義側で置くべき環境変数が2つある。** `GH_TOKEN`（または `GH_ENTERPRISE_TOKEN`）と
  **`GIT_TERMINAL_PROMPT=0`**。実測（[#115](https://github.com/Kewton/commandmate-skills/issues/115)）に
  よれば `gh` は TTY が無いことを自分で判定して待たずに落ちるので停止を足す必要は無いが、
  **`git push` の資格情報プロンプトだけは別**で、制御端末を持つ起動元（tmux ペインから起動した cron 等）
  では「止まる」ではなく**無言で待つ**に化ける。runner はこれを検査しない（別プロセスの環境を
  runner は保証できない）。
- 証跡は `dispatch_schema_version` を上げずに `limitations[]` で運ぶ: `unattended_mode`（run 全体で1件。
  停止した run にも残る）と `unattended_baseline`（Issue ごとに1件）。

規約の正本は [dispatch-contract.md](./dispatch-contract.md) 第3.0.3節・第3.0.4節、
裁定の記録と実測は [adr-unattended-mode.md](./adr-unattended-mode.md)（特に第2節の裁定 0、
実測の第14節、実装差分の第15節・第16節・第17節）。段階 A は dispatch のみ、段階 B で
merge `--create-prs`、**段階 C（[#142](https://github.com/Kewton/commandmate-skills/issues/142)）で
merge `--merge-prs` と uat** が加わり、**3 runner すべてが受け付ける**。
各 runner が何を含意するかは [merge-contract.md](./merge-contract.md) 第5.3節と
[uat-contract.md](./uat-contract.md) 第5.2節にある。**フラグは runner ごとに独立の宣言であり、
runner 間で伝播しない。**


## 11. dispatch: monitor との境界

**監視の一次はこの `wait` ループである**（[cmate-orchestrate-monitor](../../cmate-orchestrate-monitor/)
との境界）。契約付き dispatch の裁定と nudge はこの runner が行う: ブロッキングな
`wait --on-prompt agent --verify` の **exit code 分岐**（0 / 10 / 20 / 21 / 99 / 124）で判定し、
`send` / `respond` でサーバ経由で促す。**マージ可否の裁定もここである。** monitor は別機構
（`capture --json` のポーリング分類 + tmux 直接介入）の**サイドカー**で、`wait` に見えない事象
——rate limit / credits バナーからの復帰、リトライ枯渇死の再送、製品の prompt 検出に載らない
プロンプト、契約なし委任や他所から投げた worker、`wait` がブロックしている間の可観測性——の
回収に使う。**統合も廃止もしない。** 併用するなら monitor 側に `--no-auto-approve` を付ける
（prompt に答えてよいかを決めるのは契約の autoYes ポリシーであって監視ループではない）。

**`--unattended` と monitor を併用するなら、monitor 側の `--no-auto-approve` は推奨ではなく要件である。**
[#115](https://github.com/Kewton/commandmate-skills/issues/115) が実測した理由による: 契約の
`autoYes: mode: off` は**サーバ自身の**自動応答を確かに止めるが、monitor の Enter は `tmux send-keys` で
ペインへ直接届くのでその方針の外側にある。しかも monitor がその方針を読んで手を止められるのは
`capture --json` に `autoYes.lastSuppression` が在るときだけで、それが書かれるのは**サーバ側 Auto-Yes が
有効なとき** —— すなわち **unattended が禁じているまさにその状態のとき**だけである。
unattended dispatch が実際に作る payload（`autoYes.enabled: false`）に対する monitor の判定は
**`approve`**（＝ `rm -rf` の確認プロンプトにも Enter を送る）になることが実測されている。
**「サーバ側が最後の砦になる」という緩和はできない。** dispatch runner はこれを検出しない
（別プロセス・別 Skill・別 install であり、検出できないものを検出したふりをしない）。


## 12. merge: PR 本文は「検証証拠の提出」である

`create_prs` が書く PR 本文（`<out>/pr-bodies/issue-<n>.md`）の Verification 節は、
**定型文ではなくこの Issue の実測値**である。人間が見るのは PR だけなので、証拠が
run ディレクトリの JSON の中にしか無い状態を残さない。

| 載せるもの | 出どころ |
|---|---|
| verdict（`verification.outcome`）と、走っていない場合（`ran: false`）の明示 | dispatch report の当該 worker |
| gate 名・合否・exit code の表 | 同 `verification.gates` / `checks`（`gate <id>: … (exit n)` から exit を拾う）。合否は `pass` / `fail` / `flaky` の 3 値（[#224](https://github.com/Kewton/commandmate-skills/issues/224)） |
| 宣言 scope（`scope.allow` = plan の対象 file）と実変更 file の対比表、**scope 外変更の件数** | plan の `suspected_files` と、worktree で実行した `git diff --name-only -z <base>...<branch>` |
| diff 規模（file 数・追加/削除行数）1行 | 同 worktree の `git diff --numstat -z` |

規則:

- **転記であって主張ではない。** 値は全て `redact()` を通す（dispatch report は入力であり、
  redact 済みだと仮定しない）。
- **読めなかったものを pass に丸めない。** worktree が既に片付いていて diff が読めなければ
  「読めなかった」と本文に書き、limitation `change_evidence_unavailable` を記録する。
  `ran: false` の verdict も同様に「検証は走っていない」と明示する。
- **`flaky` を pass にも fail にも丸めない**（[#224](https://github.com/Kewton/commandmate-skills/issues/224)
  / CommandMate #1772）。1 回目 fail → 同一 tree の 2 回目 pass であって、どちらの語もその gate に
  ついて真ではない。丸めればレビュアが最も見るべき事実が消え、「本当に 2 回落ちた run」とも
  区別できなくなる。`flaky` の行が 1 つでも在れば、その語の意味を表の隣に 1 文で書く ——
  `| unit | flaky | 1 |` だけを見た人は pass の一種か fail の一種かを判断できず、判断しようと
  すれば間違える。決めているのは verify.yaml の `flakyIsPass` であり、それは PR 本文にも
  dispatch report にも載っていない。**注記は「どう数えたか」を言わず、`Verdict` 行
  （runner の exit code）を指す** —— 語から裁定を再計算する実装は両方向に間違える。
- **黙って切り詰めない。** gh の本文上限（65536 字）に収めるため gates/checks/path の一覧は
  上限件数で打ち切るが、**打ち切った件数を本文に明記する**。
- 実変更が宣言 scope の外に出ていれば本文でその path を名指しし、limitation
  `branch_changed_outside_declared_scope` を記録する（契約ゲート `requireScopeClean` の
  人間可読版。phase は止めない）。

merge-report.json / merge-summary.md の構造は変わらない。


## 13. profile-init: 押さえるべき3点、と `--check`

profile-init には mode が2つあり、**どちらも read-only** である。

| mode | 何をするか | 正本 |
|---|---|---|
| 起案（既定） | tree の宣言から profile draft を起案する | [profile-contract.md](./profile-contract.md) 第7節 |
| `--check <profile.json>` | 既にある profile の `scope_companions` を tree に突き合わせる | [profile-contract.md](./profile-contract.md) 第9.7節 |

### 13.1 起案（既定 mode）: 押さえるべき3点

押さえるべき点は3つである（正本は
[profile-contract.md](./profile-contract.md) 第7節）。

1. **出力は draft であって profile ではない。** `verified` は常に `false` で、この runner が
   それを変えることはない。plan に渡すには `--allow-unverified` が要り、risk に
   `unverified_profile` が載る。**何を確認したら `verified: true` にしてよいかは
   [profile-contract.md](./profile-contract.md) 第8節の7項目**である。
2. **「読み取った」と「材料が無かった」が出力上で区別される。** stdout の envelope は
   field ごとに `provenance[]`（`source` と、file・行番号・行本文の `evidence[]`）を持ち、
   材料が無かった field は安全側の雛形 + `todos[]` の明示項目になる。**黙って埋めない。**
   provenance を profile JSON 側に入れないのは、planner が契約外の field を `load_error` で
   拒否するからである（注釈入り profile は使えない）。
3. **推定できなかった baseline は fail-closed の placeholder になる。** 空配列にすると
   「検証すべき gate が無いから pass」に化けうるので、必ず落ちる command を置く。
   **埋めずに dispatch すれば止まる**、が正しい壊れ方である。

### 13.2 `--check`: 宣言を tree に突き合わせる（[#197](https://github.com/Kewton/commandmate-skills/issues/197)）

```bash
node scripts/profile-init.mjs --check .commandmate/profile.json --repo-root .
```

`scope_companions` の規則ごとに1行、`when` が実ファイル何件に一致したか、`add` が展開した
path のうち何件が実在するかを出す。**構文として正しいまま何にも一致しない規則**——
`scripts/{base}.mjs` は `scripts/adapters/human-review.mjs` に届かない —— を、plan を回す前に
見るための mode である。押さえるべき点は4つ。

1. **裁定しない。** 0 件一致は誤りではない（これから作る file を見越した宣言はありうる）ので
   **warning であって error ではない**。`companion_when_unmatched` /
   `companion_add_missing` が出て status は `partial` になるが、**exit は 0** である。
   契約適合の裁定は planner 側（`orchestrate.mjs --profile-json` の `load_error`）にある。
2. **read-only。** tree と profile を読むだけで何も書かない。`--out` / `--emit` / `--repo` /
   `--id` は併用できず `invalid_input`（exit 3）になる —— 起案しない mode であることを、
   flag の無視ではなく拒否で言う。
3. **planner は対象リポジトリを開かない**（[profile-contract.md](./profile-contract.md)
   第9.1節）は不変。これは planner ではなく、**人間が profile をレビューするときに使う別
   runner** であり、plan の純関数性には触れない。
4. **一致判定は planner と同じ関数**（`scripts/lib.mjs`）である。「`--check` は通るが planner
   は一致しない」を作らないための固定事項で、fixture がその一致を両方向から測っている
   （`tests/fixtures/cmate-orchestrate/README.md` の `--check` の節）。

走査から外すのは `.git` / `node_modules` / `.venv` / `__pycache__` で、report がその一覧を
載せる。走査上限に達したら warning `tree_scan_truncated` が出て、件数は**下界**として読む。


## 14. status: read-only の契約と表示規則

**どの phase でも、いつでも呼べる。** plan → dispatch → merge / uat が残す artifact は
`plan.json` / `dispatch/dispatch-report.json` / `<phase>/merge-report.json` /
`<phase>/uat-report.json` に分かれており、各 `summary_markdown` は**単一 phase の要約**である。
「この run は今どの phase で、どの Issue が何待ちか」に答えるには複数の JSON を突き合わせる
必要があった。それをやるのがこの runner で、**それ以外は何もしない。**

**完全 read-only である。** run directory 配下の file を読むだけで、`commandmate` / `git` / `gh`
を一度も呼ばず、network も使わない。生きた状態を取りに行かないのは制約ではなく**契約**である
（証跡が証明していない状態を表示しないため）。何も書かないので、走っている run に向けても安全である。

出す内容は Issue ごとに:

- **plan**: Wave 番号・依存（`kind` つき）・branch・未回答 question 数
- **dispatch**: `worker_state` / `verification.outcome` / 判定した gate / task id
- **merge**: PR 番号・URL・CI verdict・merge 状態（`create_prs` と `merge_prs` の両 artifact を畳む）
- **uat**: verdict（と `outcome`）・fix attempt 数・意味ゲートの state
- **次にやること**: 各 report の `stop_reason` / `blocking_reasons` / `limitations` / plan の
  `warnings` の code を**[codes-and-recovery.md](./codes-and-recovery.md) 第4節の対処表の語彙にマップした1行**（例: `worker_failed` →
  「prompt / worker ログを読む。指示が過大なら Issue を分割して re-plan する」）。
  detail が Issue を名指ししている reason（runner は `#<n> …` と書く）はその Issue 行に、
  名指ししないものは run 全体の欄に出る

**証跡に無い状態は推測しない。** artifact が無い phase は **`未実行`**（`dispatch/` が無ければ
「plan 承認待ち or dispatch 未実行」）、artifact が JSON として読めない、または schema version が
未対応なら **`読取不能`** として**その phase だけ**落ち、他 phase は表示される。report は読めたが
その Issue の記録が無い場合は **`記録なし`**（例: verification pass していないので merge の
`eligible_issues` に入っていない）。`partial` / `blocked` / `failure` はそのまま見せ、success に
丸めない。表示値は他 runner と同じ redaction を通る。

**exit code は「view を出せたか」だけを表す。** run が blocked でも読取不能があっても **0** で、
非 0 は入力エラー（`invalid_input` 3 / `load_error` 6 — `--run` が run directory でない）に限る。
**run の状態は exit code ではなく view の中で読むこと。** plan runner と同じ約束である。

`--json` は決定的で（同一入力 → byte 一致）、`run` / `latest_phase_with_evidence` /
`phases.<phase>.state` / `issues[].{plan,dispatch,merge,uat}.state` /
`issues[].next_actions[]` / `next_actions[]` / `unreadable[]` / `redactions[]` を持つ。
`state` の語彙は `ok` / `not_run` / `unreadable` / `no_record`（phase 単位ではさらに
`partial_read`）である。
---


## 15. inspect: 本文の主張を base の tree に突き合わせる（`--check-references`）

planner の入力は Issue の number / title / body / labels だけで、**対象リポジトリを開かない**
（[profile-contract.md](./profile-contract.md) 第9.1節）。これは設計上の不変条件であり、
この runner はそこに触れない。閉じるのは**その不変条件が残す穴**である ——
本文が主張する事実が古くなっていることを、dispatch までの経路で誰も機械的に検知しない。

実測（CommandMate #1831 / Kewton/BorderFreeKidsMap）では、epic 配下 16 Issue を 1 日で連続
dispatch して **16 件中 11 件**で本文が実物とずれていた（前日に起票し、その間に先行 Issue が
同じ file を動かした）。`repository.ts` は本文 1,070 行に対し実測 1,129 行、根拠の行番号 5 点
すべてがずれ（`:979` → `:1038` 等）、e2e の test 件数を「着手前と同じ 130」と書いた受入条件は
実測 136 に対して**「先行 Issue が足した 6 件を消す」が正解**になっていた。回避策は人間が
16 件ぶん手で照合することだった。

### 15.1 何を突き合わせるか

**機械的に判定できるものに限る。**

1. **`path:line` 参照** —— planner と**同じ候補抽出**（`orchestrate.mjs` の
   `extractFileCandidates` を import する。2つ目の読み口を作らない）で拾った path に `:N`
   （`:N-M` も可）が続くもの。判定は3点 ——
   (a) file が無い / (b) N が実測行数を超える /
   (c) **同じ行**の backtick 内トークン（識別子）が N 行目に無い。(c) は file 内でその識別子が
   **最初に現れる行**を `found_at` で返す。**完全一致は要求しない**（識別子が近傍へ移っただけでも出る）。
2. **行数の主張** —— `<path>（N 行）` / `<path> N 行` / `<path> は N 行` の3形。
   **数え方は固定してある**: 末尾改行のある file は `wc -l` と同じ、**末尾改行の無い最終行も
   1 行として数える**（`wc -l` より 1 多くなる）。空 file は 0 行。
3. **本文内の不一致（機械的な部分集合のみ）** —— 同一 path について異なる行数の主張が併存する、
   または同一 `path:line` が異なる識別子と結び付いている。

### 15.2 何を突き合わせないか

**本文の意味的な矛盾は対象外である。**「決定事項 対 受入条件」のような矛盾は
`cmate-issue-refinement` Step 4（仮定を `path:line` で confirmed/refuted 判定する LLM 手順）の
仕事であり、ここで真似ると「読めていないものを読んだことにした報告」になる。

**表記ゆれの検出もしない。** `web/src/lib/filter.ts` と `src/lib/filter.ts` が併存する形は
planner の `ambiguous_file_candidate`（[plan-contract.md](./plan-contract.md) 第5.4節）が
著者に訊く。この runner は**そう判定された候補を点検せず**、`ambiguous[]` として件数と綴りを
名乗る —— どちらが対象かは著者しか決められないからである。

**`--repo-root` の外は読まない。** `..` / 絶対 path / system root / URL host は planner と
同じ規則（`isSafeRepoPath`）で候補になる前に落ち、落としたことを `dropped[]` に出す。
**黙って無視はしない。**

### 15.3 出力と exit

`--out` 未指定なら stdout に JSON envelope、指定すればそこにも**同じ byte**を書く
（既存なら `out_exists` / exit 4）。**plan.json には何も書かない。**

envelope は `--check` と同じ規約で、`status` / `warnings[]` / `summary_markdown` と、
対象ごとの `references[]` / `line_claims[]` / `ambiguous[]` / `dropped[]` を持つ。
`inspection.source` は `worktree` か `ref`、`--ref` 省略時は working tree を読み
`git rev-parse HEAD` を `inspection.head` に記録する。

**所見は5つの warning code**（[codes-and-recovery.md](./codes-and-recovery.md) 第6.2節）で、
1件でも出れば `status: partial`、無ければ `success`、**どちらも exit 0** である。
warning にならない verdict が2つある —— 照合できる識別子が同じ行に無い citation
（`unchecked`）と、識別子が file 内に1度も現れない citation（`identifier_absent`）。
後者で「移動した」と言うのは、その語がこの file の識別子だという**前提そのものが
測れていない**まま下す裁定である。

**読めない入力は点検しない**（無視ではなく拒否）。`--repo-root` が無い / Issue が取れない /
`--ref` が解決しないは `load_error`（exit 6）、引数が読めないものは `invalid_input`（exit 3）で
止まり、envelope の `inspection` は **`null`** になる。「見て何も無かった」と「見られなかった」を
同じ形にしないためである。

### 15.4 なぜ `profile-init.mjs --check` に相乗りさせないか

`--check` は「**subprocess も network も使わない**」を性質として掲げている（第9.7節）。
この runner は `--ref` 指定時に `git -C <repo-root> show <ref>:<path>` を呼ぶので、
相乗りさせるとその性質が**黙って**変わる。第16節の `--evaluate-gates` は**コマンドそのものを
実行する**ので、なおさらである。

## 16. inspect: 宣言済み受入ゲートを base で先行評価する（`--evaluate-gates`）

```
inspect.mjs --evaluate-gates [--repo-root <path>] [--repeat <n>] [--base <rev>] <issue>...
```

`cmate-worker-development` は実装に**二点測定**を課す（適合状態で緑・変異状態で赤。
`references/work-discipline.md` 規律2）。ところが**受入条件そのものには誰も同じことをしない。**
受入条件は「**着手前に落ち、着手後に通る**」ものでなければゲートとして働かないが、その性質は
dispatch まで一度も確かめられなかった —— dispatch は send 前に `require:` の id が worktree の
`.commandmate/verify.yaml` に在ることを確認するだけで（第6節）、base で実行はしない。

実測（CommandMate #1832 / Kewton/BorderFreeKidsMap）: 1 日で機能しない受入条件が3つ書かれ、
いずれも dispatch まで誰も止めなかった。

| 書いた条件 | 実際 |
|---|---|
| 候補 2,000 件で 100ms 未満 | 着手前の O(n²) 実装でも 0.4ms。直しても直らなくても緑 |
| 出力の sha256 が着手前と一致 | 出力に `判定時刻 : <ISO8601>` を含み、実行のたびに必ず不一致 |
| `wc -l` が 860 以下 | 移せる量を測らずに決めた閾値で到達不能（993 行で着地） |

**どれも「着手前に1回（非決定性は2回）走らせる」だけで dispatch 前に分かる。**

### 16.1 何を実行するか —— 宣言済み gate だけ

対象は Issue 本文の ```acceptance-gates ブロックが宣言した gate**だけ**である。
読み取りは **planner と同じ関数**（`orchestrate.mjs` の `readIssueAcceptanceGates`）で、
32 件上限も `issue-<番号>-` 接頭辞も同じ判定を通る。**独自 parse を持たない。**

- **`require: [lint, unit]`** —— `<repo-root>/.commandmate/verify.yaml` の同 id の `command` を
  解決して実行する。解決は dispatch と**同じ関数**（`lib.mjs` の `readVerifyConfigGates`）である。
- **`gates: [{id, command, timeoutSec}]`** —— その `command` をそのまま実行する。

**散文の受入条件は対象外である。**「`grep -c X` が N である」のような文からコマンドを
導出しない —— [acceptance-gates-notation.md](./acceptance-gates-notation.md) 第5節・第5.1節の
fail-closed をこの runner も覆さない。閾値を測らせたいなら `gates:` に
`test $(wc -l < path) -le 860` と書く（gate は exit 0 だけを pass とするので閾値は `test` で表す）。

### 16.2 4つの outcome

各 gate を `--repeat`（既定 **2**）回実行し、次のように分類する。

| outcome | 条件 | severity |
|---|---|---|
| `already_satisfied` | 全回 exit 0 | **warning** —— 「着手前は不合格」のはずの条件が満たされている＝書き手の誤り |
| `failing_at_base` | 全回 同じ非 0 | 期待どおり。**notice ですらない**（記録のみ） |
| `nondeterministic` | 回ごとに判定が変わる、または非 0 のまま exit code が揺れる | **warning** |
| `not_evaluable` | 実行できなかった（`reason` 付き） | **notice** |

**`not_evaluable` は「通った」にも「落ちた」にも丸めない。** `reason` は6つあり、
正本は [codes-and-recovery.md](./codes-and-recovery.md) 第6.3節である。

判定順は **verdict の反転が先**である。Issue 本文は `failing_at_base` を「全回 非 0」、
`nondeterministic` を「回ごとに exit code が違う」と定義していて、exit 1 → exit 2 の gate で
2つが重なる。反転（0 と非 0 が混在）を先に見て、残った「安定して落ちるが code が揺れる」も
`nondeterministic` と呼ぶ —— 1回目 127（binary 不在）で2回目 1 のコマンドは、著者が思っている
ものを測っていない。

**`--repeat 1` では `nondeterministic` に到達できない。** その run の `summary_markdown` は
そう明記する（黙って「非決定性は無かった」に見せない）。

### 16.3 実行の前提 —— clean な base で in-place

**実行前に `--repo-root` が clean であることを確かめ、汚れていれば `invalid_input`（exit 3）で
コマンドを1回も実行しない。** 汚れた tree での実測は双方向に無意味である（緑は誰かの未 commit の
編集が緑なのかもしれず、赤も同じである）。git checkout でない `--repo-root`、commit の無い
`--repo-root` も同じ理由で拒否する。`git rev-parse HEAD` を `evaluation.base_sha` に記録する。

> Issue #218 本文はここを「`invalid_input` / exit 2」と書いているが、本 package では exit 2 は
> `not_implemented` が取っており `invalid_input` は exit 3 である。**実装済みの規約を正とした。**

`--base <rev>` は「この checkout はこの revision のはずだ」という宣言である。HEAD が違えば
**全 gate を `not_evaluable`（`repo_root_not_base`）にし、1つも実行しない** —— 別の場所で
取った実測は「着手前」の実測ではない。

実行は **`--repo-root` で in-place** である。使い捨て worktree（`merge.mjs --integration-verify`
が作る形）にしないのは、依存導入（`npm ci` 等）が要り重いからで、必要になったら `--isolated` を
後から足す。コマンドは `sh -c` で、cwd は `--repo-root`、**stdout / stderr は捨てる** ——
gate の判定は exit code であり（[acceptance-gates-notation.md](./acceptance-gates-notation.md)
第4節）、出力を読み始めた瞬間に「ゲートが通った」と「出力が良さそうだった」が分岐する。

`timeoutSec` は宣言どおりに守る。宣言が無ければ CommandMate 自身の既定（600 秒）である。
**timeout した回でその gate の repeat を打ち切る** —— 分類は `not_evaluable` で確定しており、
同じ待ち時間をもう一度払っても何も分からない。実行した回はすべて `runs[]` に残る。

### 16.4 出力と exit

envelope は `--check-references` と同じ規約で、`inspection` の代わりに `evaluation` を持つ
（**両方を同時に持つことは無い**。片方は必ず `null` である）。

```json
"evaluation": {
  "base_sha": "…", "repeat": 2, "verify_config": ".commandmate/verify.yaml",
  "issues": [{ "number": 280, "declared": "yes", "gates": 1 }],
  "gates": [{
    "issue": 280, "gate_id": "issue-280-under-100ms", "source": "gates",
    "command": "…", "timeout_sec": 60,
    "runs": [{ "exit_code": 0, "duration_ms": 4, "timed_out": false, "spawn_error": null },
             { "exit_code": 0, "duration_ms": 3, "timed_out": false, "spawn_error": null }],
    "outcome": "already_satisfied", "reason": null, "detail": "…"
  }]
}
```

`runs[]` には**全回の exit code と所要時間**が残る（中央値にも1回目にも丸めない）。
`summary_markdown` は同じ内容を表で出す。

warning が1件でもあれば `status: partial`、notice だけなら `success`、**どちらも exit 0** である。
`declared` は `yes` / `none` / `invalid` の3値で、**`none`（ブロックが無い）は所見ではない**
——「宣言が無い」と「測れなかった」を混ぜないためである（同 notation 第7節）。

**plan.json には1バイトも書かない。** 結果はこの runner の artifact（`--out`、既存なら
`out_exists` / exit 4）と stdout にだけある。plan は Issue 本文と profile の純関数であり、
`acceptance_criteria` は `string[]` のままである。後続の「merge 後の観測 runner」は、この
artifact の値を「着手前」として読む。
