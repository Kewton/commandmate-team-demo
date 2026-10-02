# cmate-orchestrate リリースノート（なぜ今の挙動なのか）

この文書は **経緯の記録**である。契約の正本ではない。

- 何をどう呼ぶか → [SKILL.md](../SKILL.md)
- どう振る舞うと約束しているか → `references/*-contract.md`（正本）
- **なぜその約束になったか** → この文書

各項目は「何が起きたか → だからこう変えた」の形で書く。挙動そのものの定義は正本側にあり、
ここには書かない。ある gate や warning を「もう要らないのでは」と考えたときに、それが実障害
由来なのか設計上の好みなのかを 1 分で判別できることが、この文書の唯一の役目である。

Issue 番号は、`#<数字>` がこのリポジトリ（Kewton/commandmate-skills）、
`CommandMate #<数字>` が上流（Kewton/CommandMate）を指す。

---

## planner（`scripts/orchestrate.mjs`）

### #147 — Issue が書き忘れたテストファイルで、正しく実装した worker が落ちていた

同じ形の障害が**3回目**である。#56 は `wrangler.jsonc` が抽出されず、
CommandMate #1678 B-2（#44）は lockfile が `scope.allow` の外にあり、そして本件は
テストファイルが外にあった。いずれも「**worker がやるべきことをやると落ちる**」であり、
契約の scope は send 時 snapshot なので **worker 側からは直せない**。

実測（Kewton/BorderFreeKidsMap #35）では **scope 外は `session.test.ts` の 1 件だけ**で、
worker 1人分の run（dispatch 約25分＋検証1周）を失った。Issue 本文の `## 対象ファイル` に
2行足して re-plan しただけで、**コードには一切触れずに1ターンで pass した**。

→ 宣言されたソースファイルの**慣習的なテスト path を既定許可に入れ**、
`scope_defaults` に明示する。lockfile（#44）とまったく同じ経路・同じ安全弁である。
JS/TS の3形に加え、`FILE_EXT` が受理する Go（`_test.go`）・Python（`test_*.py`）・
Ruby（`_spec.rb`）・JVM（`FooTest` と `src/main/`→`src/test/` ミラー）も出す ——
JS だけの規則は planner の他の部分と非対称になる。

**#50 の穴は開かない。** 導出は必ず宣言済み path の関数であり、単独 glob を足さないので
**宣言が空なら導出も空**である。「使われなかった許可はコストがゼロ、導出しなければ run 1本が失われる」
という非対称が、規約依存の推測を許容できる理由である。

実装で分かったこと: `dispatch.mjs` は `scope.allow` を**ソートしてから `.slice(0, 200)`** する。
導出が多すぎると**アルファベット順で早い派生 path が宣言ファイルを押し出す**——
この機能が消そうとしている失敗そのものなので、ソースファイル境界で導出を打ち切る。
裁定は [adr-scope-derivation.md](./adr-scope-derivation.md)、正本は
[plan-contract.md](./plan-contract.md)。

### #36 — 別リポジトリで profile を指定し忘れると、中身の違う Issue から plan が出た

別リポジトリの worktree 内で `--profile` を渡し忘れると、planner は既定 profile
（`node-commandmate`）の**対象リポジトリから Issue を読む**。番号だけは合っているので、
**一見きれいな plan** が別リポジトリの Issue から生成された。

→ 既定 profile に解決されたときだけ read-only の `git remote get-url origin` と照合し、
不一致なら warning `profile_repository_mismatch` を積んで `partial` にする。照合できない
（git リポジトリでない・origin が無い・正規化できない）ケースは**不明であって不一致ではない**
ので、スキップする。正本: [profile-contract.md](./profile-contract.md) 第5節。

### #43 — 既知拡張子の外にある backtick path が黙って落ちていた

`FILE_EXT` に無い拡張子（発見時は `geojson`）の backtick path は抽出から外れ、
`suspected_files` に載らないまま「対象 file はこれで全部です」という顔をしていた。

→ 落とした候補を warning `unrecognized_file_extension` に積む。**黙って捨てない。**
拡張子集合そのものは cmate-issue-authoring が byte 単位でミラーしており、
`tests/fixtures/cmate-issue-authoring/run_tests.sh` が両者の `FILE_EXT` 宣言を突き合わせる。

### #46 / CommandMate #1678 B-4 — Issue 本文を直して再 plan すると `run_exists` で弾かれた

既定の `run_id` が Issue 番号だけの hash だったため、「本文を直す → 再 plan」という最も普通の
ループが、毎回 run directory 衝突で止まっていた。

→ 既定 `run_id` の入力 hash に Issue の **title / body / labels** を含める。本文を直せば
自動的に別 run になり、本文まで同一の再実行だけが `run_exists` になる。
正本: [plan-contract.md](./plan-contract.md) 第2節。

### #49 — path の途中から一致して、実在しない path への書き込み権限を配っていた

path 候補の抽出起点が `\b` だったため、path の**途中**からも一致した。
`.claude/skills/cmate-verify/scripts/verify-run.sh` から `scripts/verify-run.sh` と
`claude/skills/…` が、`web/src/lib/filter.ts` から `src/lib/filter.ts` が生まれた。
`suspected_files` はそのまま worker の `scope.allow` になるので、これは
**実在しない path への書き込み権限**そのものだった。

→ 候補は必ず **token 先頭**から取る。加えて、他の候補の **path 境界つき suffix** になっている
候補は落とし、落とした分を warning `shadowed_file_candidate` に出す
（`unrecognized_file_extension` と同型で、黙っては捨てない）。

### #50 — 成果物が Markdown の Issue は、scope が空のまま dispatch されていた

`docs/` prefix と `.md` / `.rst` / `.txt` を一律 `reference_files` に落としていたため、
設計文書・ADR・手順書のように**成果物そのものが Markdown** の Issue は `suspected_files` が
必ず空になった。worker は指示どおり md を書き、scope ゲートに落とされた。

→ 「成果物」「対象ファイル」「変更対象」「Deliverables」等の**見出し配下**に書かれた path は
拡張子を問わず `suspected_files` に入れる。見出しの外に書かれた md は従来どおり reference である。

### #51 — 依存の向きを節見出しだけで決めていたので、逆向きに読んでいた

`## 依存` のような節見出しが行の内容を上書きしていたため、その節に書かれた
`blocks`（書いた側が先）を `depends on`（書いた側が後）と同じ向きに読んでいた。

→ **方向は行ごとに**判定する。節見出しは、方向語を持たない行の既定値を与えるだけで、
行の内容を上書きしない。1行に両方向が同居する場合は黙って選ばず
`ambiguous_dependency_direction` を warning に積む。各 edge の `reason` に
**どの方向語をどの行から読んだか**を残すので、`dependency-plan.md` だけで edge を再導出できる。
正本: [plan-contract.md](./plan-contract.md) 第3.0節。

### #52 — 受入条件ゼロの Issue が `success` として dispatch まで素通りしていた

「何をもって完了か」が本文に無い Issue でも、planner は blocking question を立てるだけで
`status` は `success` のままだった。exit code も 0 なので、自動化された経路では素通りした。

→ question は `warnings`（`no_acceptance_criteria` / `no_suspected_files`）にも積み、
warning が1件でもあれば `status` を `partial` にする。dispatch 側の open question ゲート
（下記）と**対で**効く止め具である。

### CommandMate #1678 B-2 — lockfile が scope.allow の外だと、worker は構造的に不合格だった

対象 file に依存 manifest（`package.json` 等）が含まれる Issue で lockfile が `scope.allow` の
外にあると、worker は `npm install` を実行した時点で scope ゲート不合格が確定した。
worker 側にどうしようもない失敗である。

→ 同 directory の lockfile を**既定許可**として `suspected_files` に加え、planner が加えた分を
issue の `scope_defaults` に明示する（黙って足さない）。

### #56 — `wrangler.jsonc` が抽出されず、worker は指示どおり編集した瞬間に不合格になった

`FILE_EXT` に `jsonc` が無いので `wrangler.jsonc` は `suspected_files` に入らず、
そのまま実行契約の `scope.allow` から外れる。`requireScopeClean: true` が掛かるため、
**worker が Issue に書いてあるとおり編集した瞬間に scope ゲートで不合格**になり、
worker 側では解決できない。#43（geojson）と同型だが逃げ道が2つ少ない:
(a) `wrangler.jsonc` / `deno.jsonc` は framework が決めたファイル名なので改名で回避できない、
(b) repository 直下なのでスラッシュを含まず、`extractUnrecognizedPaths` にも掛からないため
`unrecognized_file_extension` の警告すら出ない**完全な silent drop** だった。

→ `FILE_EXT` に `jsonc` を追加し、cmate-issue-authoring 側のミラーも同 commit で byte 一致させた。
`json5` / `jsonl` は**足していない**: `*.json5` や `*.jsonl` という**名前でなければ動かない**
広く使われたツールが無く、`suspected_files` は worker の `scope.allow` そのものなので、
報告されていない需要のために全 worker の書き込み許可を広げることになるからである。
固定ファイル名を示す Issue が出たときに足す。

### CommandMate #1678 B-3 — コメントに書いた決定が plan に載らなかった

契約の入力は Issue の number / title / body / labels だけで、**コメントは読まれない**
（`gh issue view --json number,title,body,labels`）。「本文は変えず、決定はコメントで追記する」
運用をしていると、コメントに記録した設計判断は plan にも実行契約の `goal` にも載らず、
worker は本文に残る古い方針を実装した。

→ 挙動は変えず（コメントは読まない）、この入力範囲を plan の `notes` に**毎回明記**する。
コメントで決めた内容は dispatch 前に本文へ畳み込む運用にする（cmate-issue-refinement が使える）。

### #161 / #162 — 宣言した対象ファイルが、契約に入らないまま dispatch が成功していた

`dispatch.mjs` の `contractScopeAllow` は、Issue が `## 対象ファイル` に書いた path を
**2 通りの経路で無言のうちに落として**いた。件数上限 200 の `slice`（宣言が 201 件以上なら
アルファベット順で後ろが消える）と、形チェックの per-item drop（絶対パス・`..`・NUL・200 字超・
ドライブレター・バックスラッシュ）である。どちらも warning も limitation も blocking reason も
残さない。

**#147 が消そうとした障害クラスそのもの**で、トリガが「Issue の書き忘れ」ではなく
「**宣言の件数と書式**」であるだけである。worker は Issue が明記したファイルを編集して scope
ゲートで落ち、契約の `scope.allow` は send 時 snapshot なので worker 側に回復手段が無い。
L4（#148）が発火しても detail は「違反 path を対象ファイルに足して re-plan せよ」と言うが、
**その path は既に書かれている**ため、運用者は指示どおり動いても何も変わらない。

落としていた理由は doc comment に書いてあった —— 「parser が拒否するものは送る前に落とす。
send で拒否される契約は、起きなかった dispatch である」。**不正な形については妥当だが、
件数上限には当てはまらない。** CommandMate の契約 parser は 200 件超過を
`at most 200 entries (got 250)` と**件数を名指しして拒否**し、絶対パスや `..` も
**エントリ番号と理由を名指しして拒否**する。つまり切り詰めなければ **send が大きな声で
拒否する**ところを、切り詰めることで**契約は受理され、権限だけが黙って狭まった状態で
dispatch が成功**していた。大きな声の拒否が、静かな誤った成功に化けていた。

実測で doc comment 自体の誤りも 1 件見つかった。**ドライブレター（`C:`）とバックスラッシュを
parser は拒否しない**（`validateScopePattern` の検査は NUL・先頭 `/`・`..` の 3 つだけ）。
記述を実装に合わせて訂正した。

→ `contractScopeReview` が `{allow, dropped}` を返し、`dropped` は理由つき
（`absolute` / `escaping` / `too_long` / `over_bound` 等）で持つ。**理由は装飾ではない** ——
shape 系は path の書き直しで直り、`over_bound` は Issue の分割が要る。直し方が逆になる。
pre-flight で `contract_scope_dropped` を blocking にし、`--out` を作る前に止める。
planner 側でも `plan.warnings` に出すので、dispatch より前、plan のレビュー時点で気づける。

**上限値そのものは変えていない**（CommandMate 側の hard limit である）。変えたのは、
引かれた事実が残るかどうかだけである。

この非対称は [plan-contract.md](./plan-contract.md) 第5.1節にも現れていた。導出側には
「**足した分は必ず可視である**」があるのに、引いた分に同じ規範が無かった。足した 1 件は必ず
名指しされるのに、消えた 50 件は 1 バイトも残らない。対の規範として明文化した。

### #177 — worker が、自分を裁く検証ランナーを書き換えられた

受入条件に

    `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す

と書くと、この `.sh` が `suspected_files` に入り、そのまま実行契約の `scope.allow` になっていた。
**worker が自分を裁く検証ランナーを変更できる**状態で、ゲートが 1 つ機能していないのと同じである。

候補抽出に落ち度は無い —— 受入条件の中の path は「成果物」であるのと同じくらい「実行するコマンド」
であり、**形では区別できない**。区別できないなら既定をどちらへ倒すかの裁定になる。これまで倒れて
いたのは「受入条件に path を書かない」という、**著者の注意力に依存する運用ルール**の側だった。

→ `.claude/skills/**` / `.agents/skills/**` / `.commandmate/**` を導出から**既定で除外**する
（deny-by-default）。落とした path は捨てず `reference_files`（読むが `scope.allow` には入れない）へ
出す —— worker は満たすべき runner を**読めるが、書けない**。Issue が `## 対象ファイル` に
**明示宣言**した場合だけ scope に入れ、`harness_path_in_scope` を付けて run を `partial` に落とす。
#50 が消した障害（言われたとおりに書いて scope ゲートで落ちる）を再発させないための唯一の出口で、
通したこと自体を必ず名乗らせる。**除外そのものには warning を付けない** —— 受入条件に verify runner を
書くのは正しい書き方であり、そこに warning を出すとほぼ全ての実 run が `partial` になって、読み手に
**読み飛ばし方を教える**。可視性は構造化された `reference_files` で担保する。

**deny-list は hardcode であって profile 宣言ではない。** 理由を重い順に:

1. profile は**対象リポジトリが供給するデータ**であり、この deny-list は「審判を、裁かれる側から
   守る境界」である。`scope_companions` 型の key で緩められる境界には**静かな二つ目の扉**が在ることに
   なり、穴が Issue 本文から profile へ**移動するだけ**になる。しかも profile 側の扉には warning が
   付かない。
2. この 3 つの root は**ハーネスが決めており、リポジトリが決めていない**。改名できるものではないので
   per-repository に宣言すべき中身が無い。ADR 第5節の「却下: profile 必須にする」は逆向きの結論だが
   理由は同じ形で、あちらの主題（テスト配置）は**リポジトリしか知らない規約**である。
   **知っているのがハーネス側なら hardcode、リポジトリ側なら profile。**
3. 出口は既に在り、**使う場所で監査できる**（成果物見出し＋warning）。

したがって除外集合を広げるのは fixture つきの code 変更になる。**認可境界に対しては、それが適切な
摩擦の量である。** 結果、ハーネス path が scope に入る道は明示宣言 2 つだけ（Issue の成果物見出し／
profile の companion 規則）で、**散文からは入らない**。

CommandMate #1756（core の scope ゲート）とは矛盾しない。あちらは変更を検出して裁く側、本件は
`allow` の導出で、向きは「`allow` に入れない」。**tamper 検出は弱まらず、強くなる** —— これまで
許可されていた編集が、これからは許可されていない編集として現れる。

### #178 — 「まだ決めていない」と本文に書いてあっても、dispatch は止まらなかった

dispatch の open question ゲートが発火するのは planner 自身が立てた question
（`no_acceptance_criteria` / `no_suspected_files` 起点）だけで、Issue 著者が本文に書いた
「まだ決めていない」は `questions: []` のまま dispatch を通過していた。止まらないまま dispatch すると
worker は本文の他節から推測するか自分で決め、どちらに転んだかは diff を読むまで分からない。
**最も強い停止理由が、機械に読まれていなかった。**

実測（2026-08-10、Kewton/BorderFreeKidsMap#63）: 「## 未決の問い」3 件を残したまま plan →
`questions: []` で dispatch は止まらない。3 件を「## 決定事項」へ書き換えて re-plan したら、worker は
コメントに理由まで書いてそのとおり実装した。**本文は最初から答えを持っていなかったのではなく、
答えが無いと書いてあった。**

→ `acceptance-gates` と同型の ```open-questions ブロックを planner が読み、1 件につき 1 件の blocking
question `open_question_declared` を per-issue に立てる。著者の原文を末尾に verbatim で転記する
（dispatch の `excerpt` は末尾を残すので、停止を確かめられる部分が無人 run で落ちない）。
**既存の open question ゲートにそのまま乗る** —— `--allow-questions` 無しには送らず、付ければ通るが
question は plan と report に残る。**新しい停止経路も新しい緩和フラグも足していない**
（`dispatch.mjs` は 1 byte も変えていない）。記法と違反の扱いは
[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第3節・第7節をそのまま継承し、
**「ブロックが無い」と「ブロックが壊れている」は混ぜない**。

question の順序は先頭に置いた。他の question はすべて「本文から X を読み取れなかった」という**不在に
ついての報告**（偽陽性がありうる推論）だが、これは「X をまだ決めていない」という、**決められる唯一の
人間による事実の申告**であり、planner が計算しても答えは出ない。

**見出し検出（`## 未決の問い` / `Open questions`）は併設していない。** 同じ形は拾えるが、採らなかった:

1. **誤検出が無いとは言えない。**「以前は未決だったが決めた」「`## Open questions（すべて解消済み）`」を
   見出し語では区別できない。偽の停止は `--allow-questions` を習慣にさせるが、**このフラグは plan 全体に
   効く**ので、1 件を黙らせるつもりで全部を黙らせることになる。
2. **散文から停止を作らない。** 受入ゲートについて第5節が引いている境界（明示マークされたブロック
   だけを運ぶ）と同じ向きである。
3. **生成と解消が機械化できる。** 見出しには「書く対象」も「消す対象」も無いが、ブロックにはある ——
   refinement が問いを出す → 著者が本文へブロックとして残す → 決めたらブロックを消して re-plan、が
   一本の線になる。**削除が「決めた」の記録**になる。

### #181 — 規則からは決して出てこない集約テストが、毎回手書きだった

L1（隣接テスト導出）も L2 の `derive` も出せない伴走が 1 つ残っていた: 複数モジュールをまとめて検証する
**集約テスト**である。`scripts/tests/shared-contract.test.mjs` は**どのソース名とも対応しないことが
定義**なので、規則からは決して出てこない。残った経路は Issue 本文への手書きだけで、書き忘れれば
worker はテストを更新できないまま scope ゲートに当たる（実測: `scripts/**` / `web/src/shared/*.mjs` を
触る Issue は毎回手書き。0.26.0 では L1 が 5 宣言から 18 path を出したが、集約テストは出ない）。

→ **`derive` を緩めず、兄弟 key `scope_companions.require` を足した。**
[adr-scope-derivation.md](./adr-scope-derivation.md) 第15.2節は「定数の伴走 path」を第1版から外した
うえで、**入れるときの形まで裁定していた** ——「実例が出たら `derive` とは別の key（例: `require`）
として足す。そのとき『宣言と無関係』であることを key の名前が明示する」。本変更はその実例が出たので、
**書いてあったとおりに足しただけ**である。`require[].when` は `derive` と同じ語彙で宣言済み path に
一致し、一致が無ければ 1 件も出ない（「宣言が空なら `scope_defaults` も空」は保たれる）。何件一致しても
literal は 1 回だけ出る。**宣言した key しか正規化されない**ので、`derive` だけの profile の plan は
1 byte も変わらない。

**判別しているのは中身の推測ではなく、著者が書いた key である。** 両 key は互いの形を拒否する ——
`derive[].add` は placeholder 1 つ以上を要求し、`require[].add` は placeholder 0 個を要求する。
括弧が残っている誤記（`{Base}` / `{base`）は**両方の key で**トークン化して拒否されるので literal に
化ける経路がそもそも無く、残る「括弧ごと落とした誤記」は `derive` に書いてある限り拒否され、
合法になるのは著者が key を移して**「この path は固定である」と宣言したとき**だけである。
`derive` を緩めていないことは**既存 case 47 が今も緑である**ことで測られている。

literal は宣言済み path から作られない唯一の伴走なので、通さなければ **profile 経由の path traversal**
になる。`require[].add` は load 時に `isSafeRepoPath` を通し、**#177 のハーネス除外は profile 側にも
引いた** —— #177 自身が hardcode の理由として「`scope_companions` 的な key で緩められる境界は、静かな
2 つ目の扉を持つ境界である」と書いており、literal 伴走はまさにその key だからである。判定できる所で
落とし、できない所は出口で落とす: literal は load 時に `load_error`（静的に判定でき、profile は人が
レビューする成果物なのでその場で落とすほうが直せる）、template がハーネスへ展開されたときは導出時に
drop。ただし**宣言済み path 自身がハーネスの中にあるとき**は落とさない —— それは #177 が認めている
唯一の許可であり、L1 も同じ宣言から導出しているので、**L2 だけ落とせば「どの層が出したか」で境界が
変わる**ことになる。

profile-init は `require` を**起案しない**。literal 伴走とソースの関係は**意味の関係**であって配置の
関係ではなく、集約テストには対になる実ファイルが無い。起案すれば規則の両側を発明して `detected` と
名乗ることになり、第15.6節の「対で裏が取れた配置だけを起案する」規律に反する。代わりに TODO
`scope_companions_undetermined` の**文面が `require` を名指しする**ようにした —— それまでの文面は
`derive` では書けない形を勧めており、**助言どおりに書くと `load_error` になる**文面だった。

### #182 — 語彙が似ているだけの Issue が 3 wave に直列化し、宣言した path の方が落ちていた

planner の抽出・推論に、**推測を推測と名乗らずに実行してしまう**箇所が 3 つあった。いずれも
「plan は成立するので、気づかなければそのまま dispatch される」形である。

1. **語彙一致だけの推論 edge が、file 衝突と同格に wave を直列化する。** 実測 2026-08-11
   （Kewton/BorderFreeKidsMap #104/#105/#106）: 相互参照ゼロの 3 Issue が
   `shared: data, page, cmate` の 3 edge で **3 wave に直列化**した。`cmate` は受入条件の散文
   「cmate-verify の全ゲート」から、`data` / `page` は互いの `## 参考` に書いた path 片から来ている。
   実 file 衝突は 1 組だけで、回避策は**推論を丸ごと切る** `--no-infer` しか無かった。
2. **CONTEXT 見出しの except が、issue 番号に効かない。** `## 根拠` は path を引用へ降格させるのに、
   その下の issue 番号は edge になっていた。実測 2026-08-07（#33/#34）: 「旧本文の depends on #31 は
   成立しない」と**否定するために**書いた行が phantom 依存を作る。番号を書き換えれば依存先が追従する
   だけで、消すにはその行ごと ——つまり**「なぜ依存しないのか」の記録ごと**—— 消すしかなかった。
3. **`shadowed_file_candidate` が、短い path（本当に書きたい方）を落とす。** `## 対象ファイル` に
   `data/demo/facilities.json` を挙げ、説明文でビルド生成物
   `web/public/dist/data/demo/facilities.json` に触れたところ、**宣言した方が落ちて、触るなと書いた
   生成物が scope に残った**。しかも warning は停止しないので、そのまま dispatch される。

→ dependency edge に **`basis`**（`declared` / `file_conflict` / `lexical`）を足した。`kind` が
「**誰が言ったか**」なのに対し `basis` は「**何を根拠にその edge が在るか**」で、2 つは別の問いである。

**共有 topic token しか無い組は edge にしない** —— 消費者側 Issue の question
（`unconfirmed_lexical_dependency`）にする。question なので dispatch は `--allow-questions` 無しには
送らず、**承認は run の command line に残る**。**共有 file が在る組は edge のまま**
（`basis: file_conflict`、`reason` に共有 file を明記）。その組はどのみち同一 wave に置けないので、
生産者を先に置く順序付けは待ち時間を増やさない —— **推論が元々やりたかったのはこれである。推論そのものは
消していない。**

(2) には `extractExplicitRefs` に `contextSpans` / `inSpans`（#54 が path に使っているもの**そのもの**）を
適用した。判定は path と同じく出現ごとではなく**番号単位**で、1 度でも CONTEXT の外で述べていれば
edge は残る（**引用は記述を取り消さない**）。

(3) は「長い方が正しい」を捨てた。長さは**どちらが対象かの証拠ではなく、2 つが重なっていることの証拠**
である。どちらも落とさず両方を `suspected_files` に入れ、どちらを意図したかを question
（`ambiguous_file_candidate`）にした。両方残す側に倒すのは **2 つの誤りの安い方**だからである ——
使われない許可は何も起こさないが、足りない許可は worker 1 人分の run を失わせ、契約 scope は send 時
snapshot なので**worker 側からは直せない**。**question は「両方が scope に入った」ときだけ出す**:
長い方が引用・doc path・#177 の deny のいずれかで reference 側へ行くなら著者は既に区別を書いているので
訊かない —— **正しく書いた本文に blocking question を出すのは、`--allow-questions` を習慣にさせる
最短路である。** `shadowed_file_candidate` は廃止した。

`dependencies[].basis` は schema の `required` に**入れていない**。required にすると 0.27.0 以前が書いた
v2 の `plan.json`（`status.mjs` が読む過去 run の artifact）が schema 違反になり、「古い run を
読めなくするのは後退である」という既存の裁定の逆になる。**absent は「区別が存在する前に書かれた」で
あって「根拠が無い」ではない。** 代わりに「planner は必ず出す」「`basis: lexical` の edge は 1 本も
無い」を**全 plan case に対する harness 不変条件**として固定した —— schema が緩い分を test で締める
配置であり、放置ではない。

### #196 — dispatch 側だけが着地した field は、宣言すると plan が通らなかった

#180 で入った `profile.dispatch_defaults` は **dispatch 側だけの着地**だった。planner の
`PROFILE_FIELDS` に無いので、宣言を書いた profile は Issue を読む前に `load_error`（exit 6）で
止まる。この field が runner に届く道は「**手で patch した plan**」しか無く、profile-contract
第10.6節がその状態を自認していた。#180 が消しに来たのは `--auto-yes` / `--wait-timeout` の
付け忘れが「遅い run」ではなく**事故**（phantom edge / 誰も答えない prompt /
`wait_window_exhausted`）になることだが、置き場は人間の記憶と CLAUDE.md のままだった。

→ `PROFILE_FIELDS` に足し、`publicProfile()` で echo する。第10.2節の型規則（未知 key・型違い・
0 以下）は planner 側にも持つが、**code / exit は planner の規約**（`load_error` / exit 6）に揃えた ——
同じ不備が dispatch では「plan ファイルについての事実」（`plan_invalid` / exit 3）、planner では
「profile ファイルについての事実」であり、**主語が違う**。ここだけ exit 3 にすると planner 側の
規約が割れる。検証ロジックは**共有しない** —— dispatch は loader を通っていない手書き plan も
受けるので、自分の検証を planner に降ろせない。

正規化は契約の key 順に組み直す。**profile は field を選ばず丸ごと `run_id` の hash に入る**（#157）
ので、素通しだと profile 内で key を並べ替えただけで `run_id` が割れる。条件付き echo の追加順は
`scope_companions` → `dispatch_defaults` → `integration_baseline`（#195）に固定した ——
**順序が plan のバイト列を決め、全文 golden に効く。**

### #199 — 「明示宣言した」ことの報告で、run 全体が partial に落ちていた

#177 の唯一の出口 —— Issue が `## 対象ファイル` にハーネス path を**明示宣言**する —— を通ると
`harness_path_in_scope` が付き、run 全体が `partial` になっていた。ハーネスを in-repo で保守する
リポジトリでは、検証ゲートを足す・skill 定義を直すのは**例外的な事象ではなく定常作業**である。
実測（2026-08-14、Kewton/BorderFreeKidsMap）では `.commandmate/verify.yaml` /
`.github/workflows/ci.yml` / `scripts/check-verify-parity.mjs` を宣言した Issue が `partial` で
返った。`suspected_files` は正しく、**裁定も正しい**。問題は、この形が毎回 `partial` で返ることが
`partial` の情報量を下げることである —— #177 自身が除外側について同じ力学（「ほぼ全ての実 run が
`partial` になって、読み手に**読み飛ばし方を教える**」）を論拠にしている。

→ 「**名乗る**」と「**`status` を落とす**」を分けた。`plan.warnings[]` に任意 field `severity` を
足し、`status` を落とすのは blocking だけにする（`status` は「blocking な warning が 1 件以上ある
とき `partial`」になった）。誤分類は「静かに `partial` でなくなる」事故を生むので fail-closed に
倒してある: **既定は blocking**（`severity` を持たない entry は従来どおり `partial` にする）、
**notice 集合は `{harness_path_in_scope}` の 1 件だけ**である。他の code を notice へ移すのは
それぞれ独立の判断で、別 Issue になる。**notice が blocking を隠すことはない。**

`severity` は **notice の entry にだけ emit する**。`blocking` を綴らないのは、綴ると notice を
含まないすべての plan のバイト列が動くからで、schema の `required` に入れていないのは
`dependencies[].basis` と同じ理由（過去 run の `plan.json` を schema 違反にしない）である。
**absent は「blocking」であって「未分類」ではない。**

自動化系は壊れない。dispatch を止めるのは `plan.questions` であって `plan.status` ではなく
（`execution-plan.v2` の `questions` の記述が「this array — not plan.status — is what stops a run」と
明言している）、`status` は人間向けの色である。**本件はその色の情報量の話である。**

### #200 — offline fixture の形式を知る唯一の方法が、runner を読むことだった

`--issue-json` は 0.28.0 の package 全体で 3 箇所に名前が出るだけで、**何を書けば読めるのか**は
どこにも無かった。`loadIssuesFromFixture()` を読んで初めて分かる状態で、利用リポジトリでは
実際にそうなった（2026-08-14、Kewton/BorderFreeKidsMap で 0.28.0 の受け取り検証を fixture で
行うために runner のソースを読んでいる）。

これは単なる欠落ではない。0.28.0 は「Issue 本文の書き方が plan を変える」経路を 3 つ増やしており
（#177 の `reference_files` / #178 の ```open-questions / #182 の question 2種）、どれも
**本文を直して re-plan する**のが正しい対処で、`codes-and-recovery.md` の対処表もそう書いている。
offline fixture はそのための最良の道具 —— 実際の Issue を編集せずに本文だけ差し替えて plan を
diff できる —— なので、**推奨している対処法の入り口が塞がっていた。**

→ [plan-contract.md](./plan-contract.md) 第1.1節（`run_id` を述べる第1節の直後）に書いた。
受け付ける 2 形（素の配列 / `{"issues": […]}`）と要素の field、`labels` の 2 形（`gh` の出力を
そのまま貼れるように、`gh` 経路と fixture 経路は同じ正規化を通る）、**`number` を整数として
読めない要素は黙って捨てられる**こと、そして **fixture は plan の入力なので `run_id` に効く**こと
（本文を変えなければ `run_exists` に阻まれる ＝「本当に本文が変わったか」の検査になる）。
正準例は散文ではなく、planner の fixture テストが既に読んでいる実在 fixture を指す ——
**散文の例は形式が変わっても古いまま残るが、テストが読む fixture への参照は腐ると赤くなる。**

**挙動は変えていない。** 非整数 `number` の黙殺は本 package の fail-closed の流儀
（#175 / #177 / #178 が一貫して「読めないものは absent 扱いにしない」側に倒してきた）と緊張が
あるが、**docs に挙動変更を同乗させない**ため、`load_error` へ締めるかどうかは別 Issue である。

---

### #223 / #224 — `mutex` / `retryOnFail` / `flakyIsPass` を宣言した Issue の block を planner が拒んでいた

上流 CommandMate は **verify.yaml の `gates[]` と実行契約の `verify.gateDefinitions` を同じ
validator**（`verify-config.ts` の `validateGateEntries`）で検査する。#1771 / #1772 がその
validator に 3 field を足したので、`gates:` に `mutex: e2e-port` と書いた Issue は
`send --contract` に受理される —— が、この planner の block reader はキーを閉じた集合として
持っており、**その block を `acceptance_gate_block_invalid` で拒んでいた**。著者は上流が受理する
受入条件を書けず、しかも planner の停止として現れるので原因が上流にあるようには見えない。

3 field を受理集合に足し、**値域も上流と同じにした**（`retryOnFail` は 0 か 1、`mutex` は path
segment として安全な名前、`flakyIsPass: true` は `retryOnFail: 1` を伴わなければエラー）。
検査だけは 1 箇所だけ形が違う: `flakyIsPass` と `retryOnFail` の対応関係は **entry を読み終えて
から**見る。この reader は行単位だが YAML の mapping に順序は無いので、行の並びを理由に拒むと
**上流が受理する block を拒む**ことになるためである（`86-acceptance-gate-definition-range` の
4 件目がその対照になっている）。

---

### #219 — 契約は glob を受け取れたのに、Issue 本文からそれを書く方法が無かった

「`scope.allow` は完全一致の path 一覧である」は**誤り**である。契約も scope ゲートも
CommandMate #1546 以来 glob 対応済みで（`src/lib/verification/scope-gate.ts` の
`globToRegExp`、設計正本は同 repository の `docs/design/task-contract.md` 第2.2節）、
この repository 側でも dispatch の `contractScopeReview` は `*` を拒まずに契約へ書き、
`skills/cmate-task-contract/SKILL.md` 第4.2節は「ディレクトリ粒度の glob で宣言する」ことを
**既に推奨していた**。

実際の制約は **planner の抽出**だった。`CANDIDATE_WITH_EXT` の文字クラス `[A-Za-z0-9_.-]` は
`* ? { } ,` を含まないので、`## 対象ファイル` に素で書いた `data/geo/landmarks/*.json` も
ディレクトリ `data/geo/landmarks/` も**警告も出さずに落ちて**いた。一方 `CANDIDATE_BACKTICK`
の `[^`\s]+` は backtick の中なら何でも通すので `` `data/geo/**/*.json` `` だけが
`scope.allow` まで届いていた —— テストも文書も無い**偶発挙動**である。
実測（Kewton/BorderFreeKidsMap #243）では、区ごとの生成物 46 file を手で列挙する羽目になった。
その 46 行に情報は無い。言いたいことは「`data/geo/{landmarks,stations}/` 配下を再生成する」
だけである。

→ 抽出に4つ目の source（`CANDIDATE_PATTERN`）を足し、**成果物見出しの配下でだけ** glob と
ディレクトリを候補にした。見出しの外のものは落とし、落としたことを `scope_pattern_dropped`
（notice）で報告する。「明示の宣言が言及に優る」は #177 がハーネスに引いた線と同じであり、
glob が「誰も列挙していない file 集合に対する権限」である以上、言及として受け取ることは
できない。宣言された pattern は `scope_pattern_declared`（notice）が**列挙**する ——
plan は展開しない（ADR 不変条件3）ので、可視にできるのは宣言そのものだからである。

**副作用の方が重い欠陥だった。** wave の衝突判定（`sharedFiles`）は `suspected_files` の
**完全一致集合の交差**だったので、`data/geo/**` を書く Issue と
`data/geo/landmarks/13101.json` を書く Issue は「重なっていない」と判定され、
**同じ file を2人の worker が同じ wave で書けて**いた。判定を上流と同じ関係
（`lib.mjs` の `scopeEntriesOverlap`）に置き換え、決められない組は「重なる」と答えるようにした
（偽陽性は wave 1本分の並列度で済むが、偽陰性は統合で壊れる —— #175 の教訓）。
この置き換えは pattern を持たない plan の判定を1つも変えない。

**1つだけ拒む形を足した**: 全 segment が `*` / `**` の pattern と `.`（`over_broad`）。
`allow: ["**"]` は決して失敗しない scope ゲート、つまりゲートが無いのと同じである。
狭めるのではなく落とす —— `**` が何を指すつもりだったかを推測すれば、それこそ ADR 不変条件1が
禁じている導出になる。

抽出定数は `cmate-issue-authoring` の `validate-plan.mjs` に byte 同一でミラーされているので
両方を同時に更新した（`mirror-conformance.mjs` が constant の byte 一致と corpus の挙動一致の
両方で守っている）。

---

### CommandMate #3002（+ #273） — 「変えるな」と書いたファイルほど scope に入っていた

planner は Issue 本文の**全体**から path を拾い、`## 対象ファイル` を持つ Issue でも地の文の
path を `scope.allow` に入れていた。実測（Kewton/Musunest）:

- 完了条件に「（依存の宣言の）ファイルの差分が 0 であること」と書いたら、そのファイルに
  **書き換えの許可が付いた**（#181）。「`ci.yml` に手を入れる必要が出たら止めて返す」でも
  `ci.yml` が scope に入った（#183）
- `/` の無い `app.spec.yaml` も拾われ、宣言外の path として dispatch できなかった（#211）
- 追記の説明文に書いた見本の短い綴りが `ambiguous_file_candidate` を立て、2 日止まった（#180）

利用側は「地の文に path を書かない」運用で補っていた。**禁じた path ほど権限になる**ので、
指示で禁じるより危ない。

→ 成果物見出しを持つ Issue では、**その範囲の外の path を `suspected_files` に入れず**
`reference_files` に回し、Issue ごとに1件の `prose_path_ignored`（notice）で名指す。
**既定で有効にした**（利用者と Issue 上で確認済み。成果物見出しを持つ Issue はすべて挙動が変わる）。
見出しの無い Issue は変えない —— そこでは散文が唯一の記述である。#219 が pattern に引いた線
（明示の宣言が言及に優る）を path 全般へ延ばした。

同じ変更に2つを含めた。どちらが欠けても、この変更が新しい穴を開ける:

- **#273: 成果物見出しの範囲を下位の `###` で切らない。** 以前は `### 新規ファイル` で範囲が
  切れ、その下の path は「地の文」として（偶然）scope に入っていた。地の文を外すだけだと、
  小見出しで整理した Issue の path がすべて scope から消える（文書 path は以前から
  `reference_files` に落ちていた。Kewton/CommandAgent #500）。
- **否定で終わる見出しを成果物見出しから除く。** `DELIVERABLE_HEADING_RE` は語が含まれていれば
  一致するので、`## 変更対象外` / `## 対象ファイル外` が成果物見出しだった。地の文を外した後では、
  「変えるな」を見出しで書くことが**権限を配る最後の書き方**になる。

受け入れた副作用: 完了条件にしか書いていないテスト path は scope に入らず、受入条件がテストを
求めていれば question で止まる（fixture 93）。短い綴りの `ambiguous_file_candidate` は
立たなくなる（fixture 57 の期待値をこの向きに改めた。question そのものは見出しの無い fixture 19 が
固定し続ける）。起票側（cmate-issue-authoring の `validate-plan.mjs`）の写しも同じ commit で揃えた。

### CommandMate #3003（+ #272） — `## 対象ファイル` に書いた `.ebnf` / `Cargo.lock` が scope に入らなかった

`## 対象ファイル` に `packages/appspec-schema/contract/expression.ebnf` を宣言したが、`FILE_EXT` に
`.ebnf` が無いので scope に入らず、利用側はファイルを `expression-grammar.md` に**改名して**回避した
（Kewton/Musunest#212）。同じ形で `Cargo.lock`・`requirements/ci.txt` も入らず、依存更新の Issue を
worker に出せなかった（#272、Kewton/CommandAgent#520）。`Cargo.lock` は `/` が無いので
`unrecognized_file_extension` すら出なかった。#43・#56 に続く同じ形の3度目である。

→ **成果物見出しの下では、backtick の file 名を拡張子によらず拾う**（案 B。拡張子の無い `Makefile`・
`.gitignore` と `/` の無い名前も含む）。backtick 無しと見出しの外は従来どおり。

**案 A（profile の欄 `planner.extra_extensions`）を採らなかった理由**: cmate-issue-authoring の
`validate-plan.mjs` は profile を読まないので、欄で足した拡張子は**起票時の検査と planner の判定を
食い違わせる**。案 B は本文だけで決まり、写しにそのまま載る。拡張子を足し続ける運用（#43・#56・#272）も
要らなくなる。`FILE_EXT` が閉じている理由（散文の token を権限にしない）は、見出しの下では
成り立たない —— #219 が glob について下したのと同じ判断である。利用者と Issue 上で確定した。

### #286 — `human-only` ラベルの Issue を、利用側が plan から手で外していた

cmate-issue-authoring 0.10.0（CommandMate #3013）で、人がやる Issue（スマホでのデモ、手で書く文書）を
`labels` の `human-only` で計画に入れられるようになった。validator は `NOTE dispatch_excluded` で
「dispatch の対象ではない」と名指すが、planner はこの印を読まなかった。渡せば「Affected files are unclear」が
立ち、dispatch されうる。利用側（Kewton/Musunest）は human-only の Issue の番号を plan から手で外していた。

→ **plan から消さず、wave から外す。** `issues` と `dependencies` には残して印 `dispatch_excluded: "human_only"` を
付け、wave・merge_order には入れず、question は立てず、notice `human_only_excluded` を出す。印の判定は
`human-only` ちょうどの名前（validator と同じ定数。mirror-conformance が byte 一致を検査する）。

判断したこと:

- **plan に残す（消さない）。** 消すと、依存の辺と人がやる作業の見通しが plan の読み手から見えなくなる。
  dispatch は plan の印を読んで外す（ラベルは読まない）。
- **依存は待たない。** dispatch には人の作業の完了を待つ手段が無い。待つ形（依存側も止める）にすると、
  依存側は「人が終わった」ことを誰も書き込めない場所で止まり続ける。だから plan の外の Issue への依存
  （`external_dependency`）と同じ扱いにし、wave も dispatch も待たずに進め、plan では blocking の
  `human_only_dependency`、report では同名の limitation で「#N depends on human-only #M」と名指す。
  blocking にしたのは、「その人の作業は終わったか」が `external_dependency` と同じく**まだ誰も決めていない**
  判断だからである。辺そのものは `dependencies` に残す。
- **`human_only_excluded` は notice。** ラベルが既に下された判断で、warning はそれを守ったことの報告である。
  blocking にすると、正しくラベルを付けた plan が毎回 `partial` になる（#199 が避けた形）。
- **question を立てない。** question は worker が要るもの（対象 file・受入条件の読み取り）を訊く。worker は来ない。
  立てなかった件数は notice に出す。
- ラベルの無い plan は byte 一致（全 golden がそのまま通る）。

正本: [plan-contract.md](./plan-contract.md) 第3.3節。

## dispatch（`scripts/dispatch.mjs`）

### #274 — `--reverify` が対象 Issue を必ず同時に検証し、重いゲートを直列にできなかった

`--reverify` は再判定の対象を全件同時に走らせていたので、`cargo test --all-targets` のような重いゲートを
2件並べると、実行時間に依存するテストが負荷で落ち、1件ずつなら通る Issue が `verification_failed` になった。
直列にする正規の手段が無かった（`--schedule dag` は併用不可、`--max-parallel` は plan の値で変えると report と
一致せず拒否される）。`--verify-concurrency <n>` を足し、`--reverify` の再判定を同時 n 件までにできる。
run の引数であり run id にも突き合わせにも入らない。渡さない run は従来どおり全件同時で、report は byte 一致。
指定した run は `verify_concurrency_limited` に値を残す。`--reverify` 無し・0・負数・非整数は `invalid_input`。

### #286 — plan に入った human-only の Issue にも worker が割り当てられえた

planner が human-only の Issue を wave から外しても（上の planner の節）、dispatch が plan の `issues` 全体を
前提にしていれば、pre-flight（question・scope・worktree）で止まるか、report にその Issue の記録が無いまま
終わる。

→ **`--only` と同じ 1 か所の絞りを、`--only` より先に置いた。** 起動直後に、印 `dispatch_excluded: "human_only"` の
Issue とそれに触れる辺を plan から外し、report の最後の waves[] entry に `not_dispatched`（note `human-only`）で
戻す。limitation `human_only_excluded` が理由を、`human_only_dependency` が待たずに送った依存を名指す。
blocking にはせず、status は動かさない。

判断したこと:

- **ラベルではなく plan の印を読む。** plan は承認された成果物であり、印の無い古い plan は書かれたとおりに
  dispatch する（黙って挙動を変えない）。
- **`--only` に human-only の Issue を書くと全体を断る**（`invalid_input`）。どの run も dispatch しない Issue を
  「選んだ」run は argv と結果が食い違う。human-only への辺は `--only` の依存検査の前に外れるので、
  human-only に依存する Issue だけを選ぶことはできる（dispatch はもともとその辺を待たない）。
- **全 Issue が human-only の plan は `plan_invalid` で断る。** wave が空の plan を「何もしない success」に
  すると、status が「dispatch した」ように読める。detail が理由を名指す。
- `dispatch_schema_version` は 1 のまま。新しい enum 値も field も足していない（`not_dispatched` と limitation は既存の語彙）。

正本: [dispatch-contract.md](./dispatch-contract.md) 第3.0.6節。

### CommandMate #3004 — 導出したテスト候補が goal に並び、見かけの本数で判断を誤った

planner は宣言した各ソースについて慣習的なテスト path（`.test` / `.spec` / `__tests__/…`）を
`scope_defaults` に導出し、dispatch はそれを契約 goal の `## Files you may change` にも全件並べていた。
`X.test.ts` を隣に置く規約の利用側では、その半分以上が実在しない。実測（Kewton/Musunest）で
列挙 55 / 実在 20（#180）、61 / 22（#182）、60 / 22（#181）。「概ね 30 本超は dispatch できない」の
判断が見かけの本数で膨らみ、利用側は「実在するファイルの数で判定する」と毎回依頼文に書いていた。
goal は 8000 文字で切られるので、実在しない候補が本文の枠も食っていた。

→ **goal には宣言した file だけを並べ**、導出分は本数を1行で述べる。plan は **宣言の本数と導出の本数を
分けて**出す（`summary_markdown` と `issue-analysis.md`）。`scope.allow` の導出（L1）は変えない。

Issue の当初案は profile の欄（`tests.layout: colocated | __tests__ | both`）で導出する形を絞るもの
だったが、それは [ADR](./adr-scope-derivation.md) 第15.2節が却下した「profile が組み込みの L1 を上書きする」
にあたる（設定ゼロで効く L1 の保証が profile 次第になる）。困っていたのは (1) 見かけの本数と (2) goal に
並ぶ実在しない候補の2つだけであり、どちらも許可を削らずに解けるので、**ADR を変えずに軽い手で解いた**
（Issue 上で利用者と確定）。使われない許可のコストはゼロ、という設計はそのままである。

### CommandMate #3008 — plan の一部だけを dispatch する方法が無く、組み直していた

5 本の plan のうち 2 本が条件（宣言外のパス・宣言が scope に入らない）を満たさなかった。dispatch は
plan 全体を走らせるので、条件の揃った 3 本だけ動かすには plan を組み直すしかなかった。

→ `dispatch.mjs --only 12,14,15` を足した。plan ファイルは触らず、起動直後に `issues` / `waves` /
`dependencies` を選んだ Issue だけに絞る（絞りを 1 か所にしたので、barrier・pre-flight・lock・report が
別々の「一部」を見ることが無い）。

判断したこと:

- **断り方は「全体を断る」にした（利用者との問答で確定）。** 選んだ Issue が選外の Issue に依存しているとき、
  その Issue だけを外して残りを走らせる案もあった。しかしそれだと、argv に書いた 3 本のうち 2 本しか走らない
  run になり、「なぜ 2 本か」を report を読まないと再構成できない。全体断り（`invalid_input`、exit 3、
  `--out` 未作成）なら、直して同じコマンドを再実行するだけで済む。code は新設せず、plan に無い番号と同じ
  `invalid_input` にした。ただし依存先が `--resume` で引き継いだ pass 済みの記録なら断らない（すでに満たされて
  いる）。main に merge 済みかは調べない。依存として数えるのはスケジューラが辿る辺だけ（`lexical` の辺と plan 外への
  辺は数えない）。
- **pre-flight は選んだ Issue だけを見る。** 絞った plan を全工程が読むので、選外の Issue の宣言不備・
  worktree 欠落は run を止めない（止めていたのが、この Issue の原因そのもの）。
- **選外の Issue は `not_dispatched`（note `excluded by --only`）で記録し、blocking にしない。** 選んだ Issue が
  すべて pass なら run は `success`。前回 attempt が pass させていたものは、その記録を転記する（最後の記録が
  勝つ読み手の上に「excluded」を上書きしないため）。
- **report は「plan 全体」と「今回の部分集合」の両方を残す。** 任意の `plan_scope` と `only_subset` limitation。
  required にしていないので既存 report は検証を通り、`--only` を使わない run は byte 一致のまま。
- **wave は plan の順序を保ったまま選外を除き、空になった wave は飛ばす。** `max_parallel` は変えない。
- **`--resume` / `--reverify` と併用できる。** `--only` を渡さない resume は前回 report の部分集合を
  引き継ぐ。引き継がないと「部分集合の run を再開したつもりが、選外まで dispatch される」矛盾が出る。

正本: [dispatch-contract.md](./dispatch-contract.md) 第3.0.5節。

### CommandMate #1447 — 公式経路は public `commandmate` である（ADR）

`commandmatedev` は使わない。explicit phase flag 設計（1 invocation で mutating phase を
ちょうど1つ）も同 ADR に由来し、merge / uat runner がこれを踏襲している。

### CommandMate #1468 — `wait` の idle を完了とみなしていた

実 Claude worker は **1メッセージ＝1ターン**で動き、各ターン後に **idle 化**する。
`commandmate wait` の exit 0 は「idle」であって「done」ではない。これを完了と読んでいたため、
1ターンで終わらない作業が「完了」として barrier を通過した。

→ **裁定の ground truth は `wait --verify` の exit code、完了の ground truth は worktree
ブランチの新規 commit** と定め、この2つを別物として扱う。未 commit のまま idle した worker には
継続 nudge を送り、`--max-turns` 到達でなお未 commit なら honest に `failed` とする。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.2節・第3節。

### CommandMate #1544 / #1545 — 実行契約と契約裁定は CommandMate 0.17.0 で入った

`send --contract` / `wait --verify` / `commandmate verify` はどれも 0.17.0 以降にしかない。
それより古い CLI では契約経路が存在しないため、**同じ `verification.outcome: pass` を、より弱い
判定（profile baseline の再実行）で出す**ことになる。

→ 最初の Wave の前に一度だけ `send --help` / `wait --help` を probe し、どちらの裁定機構で
判定したかを report と summary に**必ず明示する**。`--contract-mode require` は、弱い裁定に
落ちるくらいなら1件も dispatch せず停止する。**黙って劣化しない**ためのバージョンゲートである。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.7節。

### CommandMate #1620 — pass した task を再検証すると exit 99 になった

`wait --verify` が exit 0 を返した時点で task は `succeeded` に遷移している。そこへ
`commandmate verify` を掛け直すと、再検証は契約に束ならず **exit 99（判定に到達せず）** を返した。
「ゲートは通ったが未 commit」の worker を commit まで駆動する経路が、これで詰まっていた。

→ pass 後は `--verify` を**付けずに** wait する。`verification.gates` は `wait --verify` の
stdout の `GATE <id> PASS|FAIL` 行から転記し、pass 後の `verify` 再実行はしない。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.5節。

### exit 99 を 20 に畳んでいた（CommandMate 本体の設計に合わせた分離）

exit 20 は「判定して不合格」、exit 99 は「run が error / cancelled で **判定に到達しなかった**」
である。99 を 20 の再指示ループへ流すことは、**誰も判定していないものの修正を worker に求める**
ことに等しい。

→ 99 は verification `not_run`、`verification_not_judged` を blocking に載せて `human_required`
で停止する。`stop_reason` の優先順位で 99 を `worker_failed` / `verification_failed` より**先**に
見るのも同じ理由で、**再 dispatch では解けない**からである。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.6節・第5節。

### #50（dispatch 側） — 対象 file を誰も名指せなかった Issue が、最も広い権限を得ていた

`requireScopeClean` を `<allow が非空か>` にしていた頃、plan が対象 file を1つも挙げていない
Issue は `allow: []` の契約になり、**そこだけ scope ゲートが無効化されて worker が何でも書けた**。
対象 file を誰も名指せなかった Issue が最も広い権限を得るという反転である。

→ `requireScopeClean` は**常に真**にする（万一 allow が空の契約が作られても、緩む側ではなく
閉じる側に倒れる）。加えて、対象 file が空の Issue はそもそも **dispatch しない**：
`contract_scope_unknown` を limitation に記録し、その wave を advance させない。

### #52（dispatch 側） — open question ゲート

受入条件が読み取れない Issue は「何をもって完了か」が無いまま worker に渡る。

→ Wave に入る前に、plan の Issue が未回答の planner question を持っていないかを見る。1件でも
あれば **1人も dispatch せずに停止する**。これは世界の状態に依存しない判定なので、drift 確認や
契約 probe よりも**先**に行う。blocking reason と summary には code だけでなく **question の
本文**を出す（code だけでは運用者は Issue 本文に何を書けばよいか分からない）。
`--allow-questions` を明示したときだけ続行し、その事実を `open_questions_accepted` として
記録する（黙って引き受けない）。

### #47 / CommandMate #1678 B-5 — report 単体では「何を根拠に pass としたか」が読めなかった

→ `verification.gates`（実行されたゲート id と各 verdict の一覧）を report に加えた。
`dispatch_schema_version` は **1 のまま**である。merge / uat runner は
`worker_state === 'completed'` と `verification.outcome === 'pass'` の2つしか読まず、その enum 値と
意味は変えていないので、**両 runner は無改修で動く**。フォールバック経路（baseline 再実行）は
ゲートを持たないので `[]` とし、実行 command は従来どおり `checks` に載る。

### #83 — note は「verification passed」、構造化 field は `not_run` だった

report が自分と矛盾していた。同じ worker について `note` が
「completed after 1 follow-up message(s); verification passed and a new commit was detected」
と述べる一方で、`verification` は `{ran: false, outcome: 'not_run', gates: [], checks: []}` だった。
当該 worktree で `verify-run.sh` を回すと全ゲート PASS なので、**note の方が正しかった**。
報告者のリポジトリでは #28 / #29 / #49 の3件連続で発生した。

原因は2つで、いずれも Issue 本文の推測（「`wait --verify` の stdout から拾えていない」）とは
別であった。実測は次のとおり:

1. **記録が barrier の内側にあった。** `scripts/dispatch.mjs` の verification 転記ループが
   `if (allCompleted)` に包まれていたので、**wave に1人でも** 失敗・timeout・prompt・未 dispatch の
   worker がいると、**同じ wave の他の worker**（exit 0 で pass し commit も出した worker を含む）が
   worker record の初期値のまま出力された。`gates: []` が常に空だったのも同じ経路である
   （verdict 自体は `contractVerdicts` に入っており、gate 行の parse も正しく動いていた）。
2. **note が verification の第2の主張だった。** 監督ループが「verification passed …」という
   文字列を独立に組み立てていたので、1 と組み合わさって自己矛盾が表に出た。

merge / uat の eligible 判定は `worker_state === 'completed' && verification.outcome === 'pass'` の
2つしか見ないため、**検証に通った成果物が report の書き方だけを理由に納品経路から外れ**
（`no_eligible_issues`）、PR 作成・CI ゲート・guarded merge・UAT の二層裁定がすべて迂回された。
不合格になったのではなく、**判定される前に消えていた**。

→ (a) 裁定に到達した worker には wave の成否と無関係に必ず記録する（barrier は「次 Wave を
dispatch してよいか」だけを決める）。(b) `note` の検証文は記録した `verification` から生成する
1箇所に集約し、矛盾を表現できなくした。(c) `completed` なのに裁定が無い経路が残った場合は
completion check `verification_recorded` の失敗と limitation `verification_unrecorded` として
**黙って通さず報告する**。(d) `outcome: pass` で `gates` が空なら、拾えなかったこと自体を
`verification_gates_unrecorded` に記録する（planner の `unrecognized_file_extension` と同型）。
副次的に、exit 21（work-evidence が判定して不合格）は worker が `failed` でも `fail` として
記録されるようになった — `not_run` は「**何も判定しなかった**」のために取ってある。
`dispatch_schema_version` は **1 のまま**（additive: completion check 1件の追加。正本
[dispatch-contract.md](./dispatch-contract.md) 第7節）。

### #90 — worktree を作り忘れた run が、worker のログを読めと言ってきた

worktree を作らずに dispatch すると、`resolveWorktreeId()` が id を解けず worker は
`failed` になった。ところが `blocking_reasons` に出るのは汎用の `worker_failed` で、
SKILL.md 第5節の対処表はそれを「worker が commit まで到達しなかった」へ誘導する。
**実際には worker は1人も起動しておらず**（`task_id: null`）、読むべき prompt も worker ログも
存在しない。Issue を分割しても直らない。真の原因は `waves[].workers[].note` に埋もれていた。
さらに drift check の `worktrees_present` は正しく NG を出していたのに**非 blocking** だったので
run を消費し、`--out` が作られたせいで **worktree を用意してからの再実行が `out_exists` で弾かれた**。

→ `worktrees_present` を blocking にし、専用 code `worktree_unresolved` を未解決 Issue ごとに
出す。blocking pre-flight を `outDir` の作成より**前**へ動かしたので、停止しても `--out` を
消費せず**同じコマンドで再実行できる**。1人も dispatch しなかった run が
`completion_check.passed: true` を自己申告しないようにした。正本:
[dispatch-contract.md](./dispatch-contract.md)。上流の報告は CommandMate #1741。

### #91 — 「`commandmate sync` は存在しない」というコメントが事実誤認を再生産していた

`commandmate sync` は CommandMate v0.21.0 以降に**実在する**（CommandMate #1680）。
にもかかわらず dispatch / planner のコメントは「無い」前提のままで、CommandMate #1741 の
報告本文はそのコメントを根拠に「sync は存在しない」と誤記した。

sync は worktree を**作らない**（server の再スキャンのみ）ので「未作成」は解決しないが、
「**ディスクに実在するのに server 未登録**」（server 起動後に `git worktree add` した等）は
解決できる。`resolveWorktreeId()` は sync を呼んでいなかったため、この場合も落ちていた。

→ コメントと planner note を事実に合わせ、`ls --json` が解けないときに**一度だけ** sync して
読み直す。sync が失敗（旧 CLI 等）しても run は壊さず、#90 の停止にそのまま落ちる。

### #93 — worktree を作る段だけが手作業で、入口が1つになっていなかった

#90 の fail-fast は正しく止まるが、止まった後に人が別 Skill（`cmate-worktree-setup`）を
手で呼んで戻ってくる必要があった。plan → worktree 準備 → dispatch のうち、
**真ん中だけが自動化の外**にあった。

→ `--prepare-worktrees`（**既定 off**）を足し、pre-flight が `worktree_unresolved` だけを理由に
止まるときに `cmate-worktree-setup` provider を1回呼んでから pre-flight をやり直す。
選択肢は「dispatch 内で `git worktree add` 相当を実装する」と「別 Skill を合成する」だったが、
collision 検査・作成直前の base SHA 再確認・baseline は既に `cmate-worktree-setup` にあり、
**二重実装は片方だけが直る未来を作る**ので合成を採った。dispatch は
(a) 誰について作らせるか、(b) result（`worktree-setup.result.v1`）が plan と整合するか、
(c) registry に載ったか、の3つだけを持つ。uat の意味ゲートと同じ形である。

4つの裁定（正本は [adr-worktree-preparation.md](./adr-worktree-preparation.md)）:

- **部分成功では走らせない。** 1つの wave は「この集合を並列に走らせる」約束なので、集合を黙って
  縮めると barrier の意味が run ごとに変わる。停止は新しい形ではなく #90 のままに落とす。
- **作ってしまった worktree は消さない。** provider 自身が baseline 失敗でも保持する
  （`safety.md` 第5節）ものを呼び出し側が消すのは、呼び出し先の裁定の無効化である。破壊は
  `cmate-worktree-cleanup` の責務で、後始末の owner は human。
- **未導入なら停止する**（`worktree_setup_unavailable`）。`acceptance_not_run` と同じ
  「黙って劣化しない」型だが、結果は逆になる: 意味ゲートは無くても機械ゲートで裁定できるのに対し、
  worktree が無ければ **dispatch する対象が存在しない**ので、続行に意味が無い。
- **profile の同一性は branch で照合する。** `branch_template` の placeholder の綴りは2つの Skill で
  標準化されていないため、文字列比較は同じ branch を作る template を不一致と誤判定する。
  照合すべきは規約ではなく生成物である。

`commandmate sync` はこのとき **run 中に2回**走る（#91 の1回目は worktree が存在する前に走って
いるので、新しい worktree について何も言っていない）。2回目は `worktree_sync_rescanned` に記録する。
`dispatch_schema_version` は **1 のまま**で、証跡は `limitations` と
`<out>/worktree-setup/prepared.json` と summary が運ぶ（field を足さない）。

### #98 — 3件中1件が落ちただけで、通った2件にもう一度 worker を走らせていた

Wave 途中の部分失敗は並列開発の常態なのに、そこから進む手が **re-plan して全部やり直す** しか
なかった。verification gate が pass させた成果物にもう一度 worker を走らせるのは、gate が
何のためにあるかを捨てている。uat には回数上限つき修正ループ（attempt を既存 artifact に append
する形）があるのに、dispatch には対応物が無いという非対称でもあった。

→ `--resume <前回の --out>` を足し、前回 run の**最新 attempt の report** を読んで
「`worker_state: completed` **かつ** `verification.outcome: pass`」の Issue を**再 dispatch せず、
その verification 記録だけを転記**する。引き継ぎ条件がこの 2 field ちょうどなのは、merge と uat が
eligible を決めるときに読むのがその2つだけだからである。これより緩くすると、**merge は届けるのに
dispatch は「まだ終わっていない」と言う**状態が作れてしまう。

裁定:

- **Wave barrier は再生ではなく再計算する。** 引き継ぎ分を「完了かつ pass」として barrier に数える
  ので、全員引き継ぎの Wave は 1件も dispatch せずに advance し、**依存元が pass 済みの Issue は
  待たされない**。一方で Wave の index は plan の index のまま保つ（詰めない）: `drift_checks` の
  `wave_index` と `waves[].index` が同じ番号を指し続けるほうが、番号が 1 から詰まって見えることより
  価値が高い。
- **引き継いだ Issue の worktree は解決を要求しない。** branch が merge 済みで worktree が
  片付いていても正常であり、そこで `worktree_unresolved`（#90）を出すのは「触る予定の無いもの」を
  理由に run を拒否することになる。pre-flight が見るのは「この attempt が実際に dispatch する
  最初の Wave」の、引き継がなかった Issue だけである。
- **緩い run にはしない。** exit 0/7/1、Auto-Yes 既定 off、mutating Wave 前の drift 再確認、
  exit 99 の扱い、`--max-turns` — すべて通常 dispatch と同一である。resume は「小さい Issue 集合に
  対する同じ run」であって、別の裁定規則を持つ run ではない。
- **別 plan / 壊れた report では resume させない。** 引き継ぎは「この Issue はもう完了・検証済みだ」
  という主張の転記なので、`run_id` / repository / base の不一致は `resume_plan_mismatch`、
  `dispatch-report.v1` として読めない report は `resume_invalid` で、**何も dispatch せず何も書かずに**
  拒否する。前回 report は自分の artifact であっても、戻ってくるときは**入力**である。
- **artifact は上書きしない。** attempt 1 は `<out>/dispatch-report.json` のまま、attempt N は
  `<out>/resume-attempt-N/dispatch-report.json` に append し、`<out>/attempt-history.jsonl` に
  1 attempt 1行の台帳を残す。ディレクトリ名を `resume-attempt-` にしたのは飾りではない:
  `status.mjs` の走査は sorted 順で「後に見つかった artifact が勝つ」ので、`dispatch-report.json`
  より後にソートされる名前であることが、status の Issue 行が**最新 attempt**を指す条件である。
  merge / uat には最新 attempt の report を渡す（引き継ぎ分もそこに転記済みなので、1本で足りる）。
- **`dispatch_schema_version` は 1 のまま。** `resumed_from` と attempt 番号は新しい top-level field
  ではなく `limitations`（`resume_attempt`）・worker の `note`・`summary_markdown`・台帳に載せた。
  dispatch report は閉じた schema で、読み手（merge / uat / status）は version で固定されている。
  変わっていない 2 field を読むだけの3 runner を、変えていないのに読めなくするほうが高くつく
  （#1588 と同じ裁定。正本: [dispatch-contract.md](./dispatch-contract.md) 第7・8節）。

再実行対象が1件も無い場合は、CLI を**1回も呼ばずに** exit 0 で終わり `resume_no_work` を出す。
「何もしなかった」と「全部やり切った」は同じ exit code になるので、どちらだったかを report が言う。

### CommandMate #1678 B-2 / #1683 — scope ゲート不合格の再指示に、違反 path が載っていなかった

→ exit 20 で scope ゲートが落ちていたら、その logTail から**違反 path を転記**し、
「許可するには Issue の対象ファイルに追加して plan を作り直す。不可避なら停止して報告」という
ガイダンスを再指示に含める。CLI 表示側の対応は CommandMate #1683。

### CommandMate #1547 — 契約の `autoYes` とこの runner の `--auto-yes` は層が違う

この Skill の既定は **Auto-Yes off**（prompt は自動応答せず human へ提示）であり、契約導入後も
変えていない。関係する機構は3層ある。

| 層 | 誰が動くか | 既定 |
|---|---|---|
| `--auto-yes`（本 runner の flag） | runner 自身が exit 10 のとき `commandmate respond <wt> yes` を送る | **off** |
| 契約の `autoYes.mode` | CommandMate **サーバ側**の Auto-Yes poller が自動応答を**抑止**する（enforcement は #1547 で実装済み。ポリシーは抑止しかせず、答えを増やすことはない） | `"off"` |
| `commandmate send --auto-yes` | 送信時にセッションの Auto-Yes を有効化する | **使わない** |

生成する契約が `mode: "off"` を書くのは、**runner の既定とサーバ側ポリシーを一致させる**ため
である。`autoYes` ブロックを書かない（`mode: null`）は「契約は何も述べていない」であって `off`
とは別であり、その場合サーバ側の従来動作がそのまま残る。ここを黙って `null` にすると
「runner は答えないが、サーバは答えるかもしれない」という状態になる。

---

### #94 — 独自リポジトリで使うには profile を手書きするしかなかった

内蔵 profile（`node-commandmate` / `rust-commandagent`）以外では profile JSON を手で書いて
`--allow-unverified` で回す必要があり、これが「導入済みなら誰でも使える」への最大の初期障壁だった
（CommandMate #1741 の再現環境も手書き profile / `verified: false` だった）。

→ `scripts/profile-init.mjs` を足した。`package.json` / `Cargo.toml` / CI workflow 等を read-only で
読み、profile の **draft** を起案する。`verified` は false 固定、判定材料の無い項目は安全側の
雛形と明示 TODO を出す（黙って埋めない）。推定の根拠を provenance として残す。network も
subprocess も clock も使わないので、同じ tree からは byte 単位で同じ draft が出る。
正本: [profile-contract.md](./profile-contract.md)。

### #99 — run の状態が、JSON を読める人にしか分からなかった

plan / dispatch / merge / uat の artifact は run directory に散らばっており、「この run は今どの
phase で、どの Issue が何待ちか」に答えるには複数の JSON を突き合わせる必要があった。
各 phase の `summary_markdown` は phase 単体の要約で、**run 全体の横断ビューが無かった**。

→ `scripts/status.mjs` を足した。**mutation を一切しない read-only の view** で、network も
`commandmate` / `git` / `gh` 呼び出しも無い。**証跡が証明する範囲だけ**を見せる — artifact が
欠けている phase は「未実行」、壊れた JSON は該当 phase だけ「読取不能」とし、
**証跡に無い状態を推測しない**。`blocking_reasons` を SKILL.md 第5節の対処表の語彙に
マップした次アクションのヒントを出す。

### #100 — Issue の受入条件は契約に載っているが、誰も測っていなかった

契約 yaml が運ぶ検証情報は `verify.gates` だけで、それも operator が `--verify-gates` で
名指しした場合に限られる。**Issue 固有の受入条件は機械ゲートに一切変換されず**、意味的な判定は
UAT の `cmate-acceptance-test`（任意 install）まで、しかも **merge の後**まで持ち越されていた。
「動いた」（repo 共通ゲート緑）と「完成した」（受入条件充足）を分けるのは中核のはずが、
その最初の問いが納品後にしか発されない。

調査で分かったのは、散文からコマンドを推測する経路は `extractTestExpectations()` として
**既に実装済みで、裁定に使わないという判断が既に下されている**ことだった。

→ 実装ではなく [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) を先に書いた。
記法（`acceptance-gates` fenced block、**散文からの推測生成は禁止**）・実行場所・空振り防止の
検証規約・生産側の範囲を裁定してある。実装は ADR のレビュー後。

### #95 — 無人運転を足すと、契約の根幹に例外ができる

「plan → 人間の承認 → dispatch」「runner は次の phase を勝手に始めない」は設計思想の根幹であり、
CI / cron からの無人運転はそこに例外を作る。フラグ追加で済ませると、止まるべき場面で成功に
丸める余地が生まれる。

→ 実装ではなく [adr-unattended-mode.md](./adr-unattended-mode.md) を先に書いた。中心の裁定は
**「`--unattended` は『この invocation に人間は居ない』という入力の宣言であって、mutation の
権限を与えるフラグではない。含意するのは締め付けだけである」**。緩和フラグとの併用は
`invalid_input` で拒否し、`--approve` を含意しない。無人でも止まる停止理由を
[dispatch-contract.md](./dispatch-contract.md) の語彙で網羅列挙してあり、
**「unattended だけの停止」は1つも足していない**。実装は ADR のレビュー後。

### #114 — 受入条件は契約に載っているのに、誰も測っていなかった

契約が運ぶ検証情報は `verify.gates` だけで、それも operator が `--verify-gates` で名指しした
場合に限られた。**Issue 固有の受入条件は機械ゲートに一切変換されず**、意味的な判定は UAT の
`cmate-acceptance-test`（任意 install）まで、しかも **merge の後**まで遅れていた。
「動いた」（repo 共通ゲート緑）と「完成した」（受入条件充足）を分けるのが中核なのに、
その最初の問いが納品後にしか発されない。

→ [adr-issue-acceptance-gates.md](./adr-issue-acceptance-gates.md) 第9節の段1〜6を実装した。
Issue 本文の `acceptance-gates` ブロックを planner が**構文だけ** parse して
`plan.issues[].acceptance_gates` に載せ、dispatch が worktree の verify.yaml と突き合わせて
`send` 前に解決し、和集合規則で `verify.gates` を書き出す。記法の正本は
[acceptance-gates-notation.md](./acceptance-gates-notation.md)。

**散文からの推測生成はしない。** 明示マークされたブロックだけを運ぶ（fail-closed）。
散文からコマンドを推測する経路（`extractTestExpectations()`）は元から在るが、
**裁定に使わないという判断が既に下されている** — 本実装はそれを覆さない。

実装前に第10節の未決事項4点を CommandMate 0.22.0 で実測し、第11節に記録した
（scope の基準点は merge-base ／ verify.yaml の未 commit 変更は work-evidence に計上される ／
fence 抽出の干渉は**実在した** ／ `GATE` 行に由来は出ない）。ADR から形が変わった点は第12節にある。
とくに `gates:`（新規コマンド）は planner が受理して dispatch が実行しないと
**宣言が黙って消えた緑の run** になるので、無視ではなく停止にした。

### #118 — plan の版を上げないと、古い dispatch が受入ゲートを黙って捨てる

#114 は `plan_schema_version` を 1 のままにした。plan を読む runner が ADR の数えた3つではなく
**4つ**（`status.mjs` は ADR 執筆後の #99 で増えた）で、実行契約が2 runner しか許して
いなかったためである。結果、**受入ゲートを載せた plan を 0.18.0 以前の dispatch が読むと
ゲートは黙って無視される**窓が残った。

→ planner は **2** を出し、consumer（dispatch / merge / uat / status）は **1 と 2 の両方を受理**する。
守りたい向きは「古い runner が新しい plan を拒否する」であって逆ではない。とくに `status.mjs` は
**過去 run の artifact を読む view** であり、0.18.0 で作った run を読めなくなるのは
この runner が存在する理由そのものの後退である。schema は
[../schemas/execution-plan.v2.json](../schemas/execution-plan.v2.json) を新設し v1 は残した。
fixture の検査は **plan が申告した版**の schema で行う。

### #128 — 方法論を渡す口が無く、ワーカーの流儀が run ごとに変わっていた

`buildContractGoal()` がワーカーへ渡すのは WHAT（目的・受入条件・変更してよいファイル）と制約
だけで、**HOW（調査・計画・実装の作法）を渡す経路が無かった**。CommandMate リポジトリ内では
スラッシュコマンドがその穴を埋めていたが、**スラッシュコマンドはリポジトリスコープ**であり、
外部リポジトリのワーカーには届かない（`Unknown command` で無反応になる。`send` は exit 0 を
返し composer も空なので気づけない）。

→ `--worker-method <skill-id>` を足した。pre-flight で install を実測し、`## Method` 節を
**契約 goal と worker prompt の両方**に置く（片方だけだと `--contract-mode auto` の
フォールバックで方法論が黙って消える）。既定は off で、**指定しない run は 1 bit も変わらない**
（`d45-worker-method-absent-non-regression` が golden contract の byte 一致で固定している）。

install の判定は **`.claude/skills/<id>/` と `.agents/skills/<id>/` の両方**を要求する。
理由は臆病さではなく**測定できないこと**である: dispatch は `send --agent` を一度も渡さず、
`ls --json` の row も id / branch / path しか持たないので、**どの Agent がこのタスクを取るかを
知らない**。片側を許すと、Codex が読む root に無い契約に「この worktree の Skill を読め」と
書くことになり、それは dispatch が測れない主張になる。開発機の `cmate-*` install 45 件は
すべて両置きだった（実測）。

**schema は触っていない。** merge / uat は report から `worker_state` と `verification.outcome` の
2 field しか読まないので、方法論の事実はそのどちらでもない。`limitations[].code`
（`worker_method_declared` / `worker_method_applied`）と `blocking_reasons[]`
（`worker_method_unavailable`）で運ぶ。方法論の正本は別 package
`cmate-worker-development` にある。

### #121 — timeout 起点の resume が、コードでしか保証されていなかった

`wait --verify` が timeout すると裁定が report に凍結され、その後 worker が完走して commit しても
report は更新されず、`merge.mjs` の eligible から外れる（#89 の報告）。0.18.0 の `--resume` は
この回復経路を与えている —— `isCarryable()` は `completed` かつ `verification.outcome === 'pass'`
だけを引き継ぐので、`timeout` は再実行対象になる。

**しかしそれはコードを読めば分かるだけで、fixture では固定されていなかった。** 既存の resume
ケースの起点はすべて `verification.outcome: "fail"` であって `worker_state: "timeout"` ではなく、
**`isCarryable` を将来だれかが緩めても suite は赤にならなかった。**

→ `r06-timeout-resumed` を足した。緩める変異（outcome の検査ごと外して timeout を carryable に
する）を当てると、#102 が「引き継ぎ」に化けて再 dispatch されなくなり、r01 と併せて 25 assertion が
赤になる。**#89 の再発形がそのまま出る。**

### #121 の続き — `--reverify` で、送らずに裁定を更新する

`--resume` は回復経路を与えたが**再 dispatch する**。#89 の状況では作業は既に終わって
commit されているので、必要なのは worker をもう一度走らせることではなく、
**その worktree の現在の状態をもう一度ゲートにかけること**である。現状は worker のターンを
1つ消費し、契約を再送するので worker が余計な差分を加える余地も残っていた。

→ `--reverify` を足した。**`send` を1回も呼ばない**（`r07` / `r08` が attempt 2 の
`sent: []` で固定している）。裁定の取得には既存の `commandmate verify <id> --json` を使い、
**新しい CLI 表面を要求していない**。

### #136 — `--auto-yes` を付けても Claude の許可プロンプトで止まっていた

`dispatch.mjs --auto-yes` を指定しても、ワーカーが `Do you want to make this edit to X?` で止まる。
**worktree のトグルを手で on にしても効かない。** 原因は2つあり、**両方直さないと動かなかった**。

**(1) 契約の `mode: safe` は `yes_no` しか許さない。** CommandMate の `auto-yes-resolver` は
`mode: 'safe'` のとき `promptType === 'yes_no'` 以外を `type-not-allowed` で抑止する。
Claude の許可プロンプトは **`multiple_choice`** なので必ず弾かれる。
**判定しているのは契約のポリシーであって worktree のトグルではない。**
しかもこの runner は `off` か `safe` の2択しか書かず、契約 v1 の既定である
`mode: null`（ポリシー制約なし）を選べなかった —— **`safe` はブロックを書かないより厳しい。**

**(2) `send` に `--auto-yes` が渡っていなかった。** サーバーの Auto-Yes poller は worktree の
auto-yes 状態が有効でなければ起動しない（`auto-yes not enabled`）。契約に何を書いても、
poller が回らなければ抑止の記録すら残らない（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の第14.6節と同じ構造）。

→ `--auto-yes` のとき契約は **`mode: allow-listed` ＋ `allowPromptTypes: [yes_no, multiple_choice]`**
を書き、`send` にも `--auto-yes --duration <算出値>` を渡す。duration は
`--wait-timeout × --max-turns × wave 数`から出す（推測しない）。
**autoYes ブロックを書かない案は却下した** —— この runner が `mode: off` を書くのは
「積極的な禁止」と「省略」が別物だからで、**許可についても同じ理屈が当てはまる**。
`denyPatterns` は空のまま（CommandMate #1699 の scrollback 汚染を避ける）。

### #142 — 無人運転の段階 C: 根拠を名指しできない pass の上に無人 merge を積まない

契約経路の `wait --verify` が exit 0 を返したのに `GATE <id> PASS|FAIL` 行を1本も出さない CLI が在る
（#83）。その場合 `gates` は空になり、**pass の根拠を report が名指しできない**。人間が読む運転では
limitation として続行してよい —— 読み手が run を開いて確かめられるからである。**無人運転では、その
名指しできない pass が段階 C の `--merge-prs` が動く唯一の根拠になる。**

→ `--unattended` では `verification_gates_unrecorded` を **blocking** として扱い、**次の wave を
dispatch せずに停止する**（`dispatch_error` / exit 7）。**裁定そのものは書き換えない** ——
exit code の pass はそのまま `verification.outcome: pass` で残り、wave barrier の `advanced` も
true のままである（barrier が測っているのは completion と verification であって、report が何を
示せるかではない）。変わるのは run が先へ進むかだけである。`human_required` は **false**（`GATE` 行を
出す CommandMate で再実行すれば解ける）。フラグ無しでは従来どおり limitation で続行する
（同じ世界を2回 dispatch して突き合わせる fixture で二点測定）。

---

### #145 — 段1 が知らない規約の repo では、まだ run が丸ごと失われていた

#147（段1）が消したのは「**planner が知っている規約の repo**」の分だけである。
L1 が出さない配置（独自の spec ツリー等）の repo では、受入条件が unit test を要求していて
`## 対象ファイル` にテストが無い Issue が、**今も dispatch すれば必ず scope ゲートで落ちる**。
worker は直せず（契約の scope は send 時 snapshot）、planner も直せない（repo を開かない）。

→ planner が **dispatch の前に人間へ返す**: warning 1件 ＋ open question 1件
（`acceptance_requires_tests_but_scope_has_none`）。`plan.status` は誰も読まないが、
**question は dispatch の pre-flight が拒否する** —— しかも `--out` を作る前なので、
**偽陽性のコストは、真陽性が払わせるはずだった re-plan と同じ**である。

**段1 との二重発火は構造で防いでいる。** 検出は `suspected` を **`scopeDefaults` を push した後に**
読むので、L1 が導出でテスト path を足した Issue は自動的に沈黙する。`isTestPath` は L1 と同一の
述語なので、「criterion がテスト path を名指した」と「scope が持っている」が食い違うこともない。

**精度がこの機能の本体である。** 既存の2つの question は `length === 0` の構造的判定で間違えようが
ないが、これは推論であり、しかもそれを通す `--allow-questions` は **plan 全体に効く** ——
1件の偽陽性が運用者にそのフラグを習慣づけ、本物の `no_acceptance_criteria` まで一緒に黙らせる。
走査は `acceptance_criteria` に限定し、「テストの名詞 ＋ 能動的な要求」か「テスト形 path の名指し」
だけを採り、**4つの否定形**（不要 / 既存が緑のまま / 手動 / 変更しない）が criterion 単位で veto する。
除外は**先に評価して勝たせる** ——「上限を追加する、unit test は不要」は名詞と `追加` の両方を持つので、
除外が無ければ必ず誤爆する。**4つは融合した1本の正規表現にせず独立した4文**にしてある。
1つずつ外して赤になることを変異注入で実測できる形にするためである（実測: 4本とも赤）。

裁定 A（[adr-scope-derivation.md](./adr-scope-derivation.md) 第8節）:
**推論は機械を止めてよいが、機械に指示してはならない。** この検出は `acceptance_gates` にも
`scope.allow` にも1バイトも書かない。

### #157 — `run_id` が profile の3 field しか hash せず、中身の違う plan が同じ id を持てた

`run_id` は「plan を決める入力の hash」として文書化されているのに、profile からは
**`base` / `id` / `repository` の3つしか hash していなかった**。plan を決める profile field は
他に5つある —— `baseline`（`verifyBinaries` 経由で `test_expectations`）・`branch_template` /
`worktree_template`（`issues[].branch` / `.worktree`）・`verified`（`unverified_profile` warning と
high severity の risk）・`scope_companions`（`suspected_files` / `scope_defaults`。#149）。
**`baseline` は #149 より前から外にあった**ので、新しい退行ではなく元からの誤りである。

→ **解決後の profile を丸ごと hash に入れる。** 5つを列挙し直す案を採らなかったのは、
**列挙こそが失敗した当のものだから**である —— 列挙は profile に field が増えるたび人間が
見直さねばならず、忘れても誰も検出しない。コストは受容している: profile のどの field を
編集しても新しい既定 id になる。それは安全な方向であり（**共有された古い id のほうが、
違う2つの plan を1つの run に見せかける**）、`--resume` は dispatch ディレクトリを名指すので影響しない。

**`run_exists` のメッセージも直した。** 従来は
`so this means nothing changed since that run` と**断定**していたが、profile を編集しただけの
re-plan ではこれは偽である。しかも **profile 全体を入れてもなお断定はできない** ——
既定 profile の cwd 突合が読む cwd は hash に入っておらず、片方の plan にだけ
`profile_repository_mismatch` を入れうるからである。断定をやめ、
**その directory の `plan.json` を読んで確かめてもらう**形にした。

実装では key 順の正規化パスを**一度書いてから削除**している。`normalizeProfile` が profile を
field ごとに組み立て直すので、**このローダーが受け付けるどの入力でも両版を区別できない** ——
観測できない防御は、この Issue が扱っている「コードを超えた主張」と同じ形をしている。
性質自体は、それを実際に提供している層に対する fixture で固定してある。

### #149 — planner が聞いたことのない規約は、誰にも宣言できなかった

L1（#147）が導出できるのは**慣習的な**テスト path だけである。`spec/` が `app/` を鏡写しにする木、
`.proto` の隣の `*_pb.ts`、ソースから再生成される locale 表 —— **planner が知らない規約**は
導出しようがない。planner は repo を開かず、dispatch も worktree を観測してはならない
（契約の byte-identical 性が壊れる。[adr-scope-derivation.md](./adr-scope-derivation.md) 第3節で却下済み）。
L3（#145）が警告して人間に返すところまでは行くが、**宣言する先が無かった。**

→ **repo 知識が入ってよい唯一の場所は profile であり、profile は plan の一部である。**
`scope_companions.derive[]` に `when` / `add` の path テンプレート対を書けるようにした。

```json
{ "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] }
```

placeholder は `{dir}`（0個以上の segment・末尾 `/` 込み）と `{base}`（ちょうど1 segment）の2つだけ。
**ミラーが表現できるのは `{dir}` のおかげ**である。

**ADR 第2節の不変条件3件が、後付けの検査ではなく形の構造的性質になっている。**
**glob 構文が存在しない**（`*` `?` `[` は両テンプレートで拒否）ので、唯一のワイルドカードは
placeholder であり、**捕捉されるのは宣言された path の literal な部分文字列**である。
`add` は `when` が束縛した placeholder を最低1つ持たねばならないので、
**宣言に含まれない path を許可する規則は書けない** —— `**/*.test.*` も裸の
`docs/module-reference.md` も load 時に拒否される。profile 経由で #50 の穴が開くことはない。

**実運用の観測がまだ無いので、形は「今の必要」ではなく「後から広げられること」を優先した。**
`{ext}` を入れなかったのもそのためで、後から足しても互換な広がり方になる（ADR 第15.2節）。
未宣言の profile は **段1 までの挙動へ degrade** する —— その後方互換は assert ではなく**実測**で、
`cases/45-scope-companions-absent/expected-plan.json` は**実装コードを1行も書く前に 0.24.0 の
runner で生成**して check-in してある（`44` との差は profile だけ）。

**既知の限界**: `scope_companions` は `run_id` の入力集合に入っていない。宣言を編集して re-plan すると
`run_exists`（exit 4）に当たる。ただしこれは `baseline` / `branch_template` / `worktree_template` /
`verified` も同様で、**profile 全体をまとめて裁定すべき別件**である（ADR 第15.7節に revisit 条件つきで記録）。

### #148 — 直せない scope 違反に、上限まで再指示を送り続けていた

Kewton/BorderFreeKidsMap #35 の note は `supervision exceeded its hard iteration bound` である。
**1回落ちたのではなく turn 上限まで回っていた。** 再指示文そのものは正しく、違反 path を転記して
「worker 側では解決できません — 停止して報告してください」とまで言っている。
**しかし dispatch は turn 数しか見ずに再送し続ける。** worker は
「テストを消す＝受入条件を落とす」というジレンマに置かれ、同じ結論を繰り返す。

→ 「その変更が不可避か」は判定できないが、「**このループが収束しているか**」は判定できる。
違反 path 集合が前ターンと同一なら再送しても結果は変わらないので、そこで停止する。
`blocking_reasons[].code = scope_unsatisfiable` が**違反 path を逐語で**運ぶ ——
それが「次に何を Issue の対象ファイルへ足せばよいか」の唯一の情報源である。

**止めるのは repeat であって retry ではない。** worker が違反を1つでも減らせば従来どおり
再指示が続く。決めていなかった3点はすべて**遮断が狭くなる側**に倒した:
`--max-turns` 到達を先に見る / 比較は連続2ターンに限る / 違反 path を読めなかったターンは
比較しない（「2回とも読めなかった」は「同じ path だ」の証拠ではない）。

`stop_reason` の enum に値は増えず、`verification.outcome` も書き換えない ——
検証は本当に失敗しており、それは CommandMate の exit code である。変わるのは run が先へ進むかだけ。
`summary_markdown` では「worktree を診断して再 dispatch」の行を**併記ではなく置換**する。
ここではその助言が積極的に誤りだからである（同じ plan を再投入すれば同じ所で止まる）。

### #160 / #170 — `GATE` 行は stderr に出ていたのに、runner は stdout しか読んでいなかった

`commandmate wait --verify` は `GATE <id> PASS|FAIL` 行を **stderr** に出す
（stdout は prompt JSON 契約のために予約されている。CommandMate 側の意図的な設計である）。
ところが `runCliAsync` は成功枝で `stderr: ''` を返して捨てており、`gatesFromWaitOutput` は
stdout しか走査していなかった。**契約経路で pass した検証の `verification.gates` は
原理的に常に空**になる。

#47 が入れた「report 単体で pass の根拠が読める」性質は、契約経路の pass では**一度も
成立していなかった**。そして #142 が `verification_gates_unrecorded` を `--unattended` で
blocking に昇格させたため、**無人運転の段階 C は全ゲート pass でも wave 1 の直後に必ず
停止していた。** ADR 第6.5節の意図（根拠を名指しできない pass の上に無人 merge を積まない）は
正しいが、その前提である「GATE 行を読む」経路が機能していなかった。

fail 経路（exit 20 / 21）は catch 枝で stderr を捕捉しており、かつ `describeFailingGates`
（`verify --json` の stdout JSON）という別経路の代替があったため、症状が表面化していなかった。

**なぜテストが捕まえなかったか。** テストダブルが実 CLI と逆の stream を使っていた。
`tests/fixtures/cmate-orchestrate/fake-cli.mjs` は GATE 行を **stdout** に書いており、
コメントは "Like the real CLI (verify-runner's reportGates)" と実機準拠を謳いながら、
**何を印字するかだけを写し、どこへ印字するかを写していなかった**。その結果、
`verification_gates` が埋まることを assert していた既存の緑ケース群は、**実機では成立しない
stdout 経路**を検証していた。fake を stderr に寄せたうえで実装だけを戻すと、新設ケースに加えて
**既存の 5 ケースも `verification.gates []` で落ちる** —— 修正前まで幻の経路に対して緑だった
ことの実測である。

**#83 は原因を取り違えていた。** 当時これは「契約経路の `wait --verify` が exit 0 を返したのに
`GATE` 行を 1 本も出さない CLI が在る」と、**CLI の出力欠落**として記述された。実測では CLI は
出力しており、**読み手が別の stream を見ている**というのが実際の姿だった。誤診は fixture
（`d26` の description）と復旧手順（SKILL.md / codes-and-recovery.md）に焼き込まれ、以後この
症状を観測しても「既知の CLI 差異」に見える自己強化構造になっていた。

→ `runCliAsync` の成功枝で stderr を保持し、`waitStreams()` が両 stream を連結して
`gatesFromWaitOutput` の呼び出し 3 箇所すべてに渡す（`GATE_LINE_RE` は行頭一致なので混在しても
誤検出しない）。fake-cli の GATE 行を `writeGateLine()` で stderr に寄せ、実機と一致させた。
同期版 `runCli` の `stderr: ''` は `execFileSync` の API 上の制約なので**そのまま**である
（そこから GATE 行を読む箇所は無い）。

**#170 はその後始末である。** 復旧手順は SKILL.md と codes-and-recovery.md では訂正されたが、
**運用者が実際に読む唯一の場所** —— dispatch サマリの next 行 —— に旧文言が残っていた。
「`GATE` 行を出す CommandMate で再実行する」は二重に誤っている: CommandMate は元から出力して
おり、直すべきは **runner の版**である。ADR 第17.3節も同じ誤診を**論拠として**使っていた
（`human_required` を false に保つ理由）。結論は維持し、理由を差し替えたうえで
`contract_unsupported` との違いを書き分けた —— あちらは CommandMate を上げれば runner は
そのままで解けるが、こちらは runner 自身の更新が要る。

再発防止として、**実際に描画された next 行**と codes-and-recovery.md / SKILL.md / ADR 第17.3節が
「まず runner の版」「stderr」「#160」で一致し、反証済みの文言が summary に戻らないことを
1 本のテストで固定した。recovery 表と next 行の一般的な対応（表に在る code は next 行にも在る）は
**採らなかった** —— 表の `dispatch` 行 21 本のうち 5 本は reason code ではなく stop_reason か
summary を描画しない経路を指しており、例外表が要る。3 つ目の同期先を作ることになり、
二重管理の治療にならない。

### #164 — 表示の都合が、run を止めるかどうかを決めていた

`scopeViolationLines` は scope ゲートの logTail を先頭 20 行で打ち切っていたが、その打ち切りが
**dedup / sort より前**に掛かっていた。L4 ループ判定（#148）が比べていたのは「違反集合」ではなく
「**logTail 先頭 20 行の集合**」であり、違反が 21 件以上あると**窓の外だけが異なる 2 ターン
（＝ worker は前進している）が「同一の答え」と読まれ、前進中の worker が
`scope_unsatisfiable` で止まる**。逆向きもあり得た —— 窓の中の 1 件を直すと後ろの行が繰り上がり、
停滞している 2 ターンが「異なる」と読まれて turn を浪費する。切ったこと自体はどこにも残らない。

前提は現実的である。CommandMate の logTail は既定 8192 bytes
（`DEFAULT_MAX_LOG_TAIL_BYTES`）なので 21 行以上は普通に載り、違反が数十件になるのは worker が
formatter や `lint --fix` を repo 横断で走らせた事故のとき —— **まさに scope ゲートが捕まえたい
状況**である。

→ **判定と表示を分ける。** `scopeViolationLines` は全行を返し、`MAX_SCOPE_VIOLATION_LINES` は
表示上限として残す。比較は文字列一致なので全行を持つコストはほぼ無い。新設した
`scopeViolationDisplay` が `{shown, dropped, total}` を返し、再指示文と
`blocking_reasons[].detail` の両方がこれを使う。worker record の note には「メッセージが何行中
何行を伝えたか」を残す —— 20 path を並べた report が「違反が 20 件だった run」と読まれないため。

**ガードは弱めていない。** 本当に同じ違反集合を 2 ターン連続で返した worker は従来どおり
打ち切られることを、相方の fixture で二点測定している。

### #165 / #171 — 切り捨てが無言だった箇所と、切り捨ての注記が切り捨てられうる経路

`MAX_REPORTED_GATES`（50）と `MAX_SETUP_REASONS`（5）の切り詰めが何も残していなかった。
`merge.mjs` は同じ問題を `capped()` / `droppedNote()` で解いており、PR 本文の表はすべて
「_Not listed here: N further ..._」を明記する。同じ規則を dispatch にも適用した。
**上限値そのものは report サイズ抑制として妥当なので変えていない。**

**#171 はその副作用である。** #165 以降、gate を上限で切った事実は `checks` の**末尾**に 1 行
足される —— つまり `checks` は伸びる。ところが `carriedWorkerRecord` / `transcribedVerification`
が過去 report を再転記するとき同じ上限で無言に切り直すため、**末尾から落ちるのはまさにその
注記**だった。50 件ちょうどの `checks` を持つ carried record が「全部載っている」と読める状態に
戻る。新設した `transcribeCapped` が注記のぶんの枠を先に確保し、**この転記で何を切ったか**を
名乗る（上流で既に切られている可能性があるため「HERE」であることが分かる文言にした）。

### #176 — 禁止事項は goal に載らず、worker からは「存在しない」ように見えた

契約 `goal` は Issue 本文の要約であり、plan の抽出は**肯定形**（やること・受入条件・対象 file）に
偏っている。禁止事項を読む口が無いので、落ちた制約は worker から見ると「許可されていない」ではなく
**「存在しない」**ように見える。

実測（2026-08-09、Kewton/BorderFreeKidsMap #35）: 「送ってよい / 送ってはいけない」表の禁止 3 件の
うち転記されたのは 2 件で、worker は残る 1 件（施設の個別 ID と結び付いた閲覧履歴）を payload に載せて
commit した。**全ゲート green のまま受入条件違反**で、発見は人間のレビューだった。scope は path を、
`verify.gates` は exit code を締めるが、**禁止事項はそのどちらでもない。**

→ 否定的制約を含む節・表・箇条書きを要約対象から外し、**原文転記**する。配置は `## Objective` の直後
（worker は上から読み、goal の切り詰めは末尾から効く）。本文は dispatch 時に
`gh issue view <n> --json body` で **read-only** に Issue ごと 1 回読む —— plan は肯定形の抽出結果しか
運んでいないので**plan からは復元できない**。読めなければ停止せず、goal がそう名乗る。

**転記は切らない。** 上限に収まらないブロックはそこで打ち切り、後ろの短い節も載せない（載せると
transcript が本文の prefix でなくなり、**中抜けした要約と区別できない**）。落とした節を goal に名指しし、
「本文に他節がある。`gh issue view <n>` で全文を読め」の 1 行を必ず入れる。**禁止の表を半分載せた goal は、
落とした半分を許可したのと同じである。** 切り捨ては named code（`issue_constraints_transcribed` /
`issue_constraints_untranscribed` / `issue_body_unreadable`）で機械可読にした —— goal の 1 行は
**それが制約する当の worker が書き換えられる file の中に在る**が、report は run artifact なので動かない
（`contract_scope_dropped` と同じ設計）。`--unattended` で blocking へ昇格させることは検討して却下した:
`gh` 認証の無い CI が 1 人も dispatch できなくなり、しかも re-plan では直らない。

**見出し語集合は hardcode であって profile 宣言ではない。** 根拠 3 点:

1. 宣言し忘れたリポジトリの goal から禁止事項が**黙って消える** —— 本件そのものを設定で再現することに
   なる。**宣言しなければ効かない既定は、既定ではない。**
2. 「どの禁止を転記するか」を絞れる knob は、設定の見た目をした**権限の拡大**である。
   [dispatch-contract.md](./dispatch-contract.md) 第2.9節は `--verify-gates` に同じ形を既に禁じている。
3. `scope_companions` が profile 宣言なのは**テスト file の配置がリポジトリごとに本当に違うから**で
   あって、禁止表現の語彙はリポジトリの道具立てではなく **Issue を書く言語**の性質である。

見出し語集合は**床であって天井ではない**: 見出しに関わらず表・箇条書きを拾う規則が取りこぼしを覆う。

**Issue に関わらず**、header へ `Issue body: gh issue view <n>`、`## Rules` の先頭へ「契約が言及して
いない禁止事項は許可ではない」を入れた —— 見出し語を取りこぼした Issue でも、**本文を読めという指示
だけは届く**。フォールバック worker prompt にも同じ文面を入れてある。片方だけが運ぶと禁止事項が
「古い CLI の run だけ落ちる」ことになり、ADR §1.2 が `## Method` で退けた非対称になる。

同じ規則を **cmate-worker-development（0.2.0）** にも書いた: **契約が言及していない禁止事項は、契約が
許可したのではなく書いていないだけであり、Issue 本文が正本**。狭める方向（禁止）は本文も効き、
広げる方向（権限・対象 file）は契約が正本、という非対称である。A 段（読取）は「契約 file を読み、
**そのうえで** goal が Issue 番号を参照しているなら本文全文を読み取り専用で取得する」を必須手順にした
—— 従来の文面は契約だけで止まりうるものだった。取得できなかったら証拠に書く（**読まなかったことと
読めなかったことは別の事実**である）。

### #179 — `wait` の timeout が、worker の死と区別できなかった

`--wait-timeout` は `commandmate wait` の**1 回あたりの上限**であって、worker の**1 ターンの上限では
ない**。ターンが窓より長ければ runner は timeout を報告するが worker は走り続け、完走して commit まで
載せることがある（実測: Kewton/BorderFreeKidsMap #62、1 ターン約 40 分に対して `--wait-timeout 1800`）。
report からは「worker が死んだ」と区別できないので、ここで再 dispatch すると**完成済みの作業の上に
別 worker を重ねる**。見分けは人間が `capture --json` を手で叩いて行っていた。

→ wait が exit 124 を返した時点で `capture <worktree-id> --json` を**1 回だけ**叩き、その答えを当該
worker の `worker_liveness` へ転記して、同じ code の blocking reason を Issue ごとに 1 件出す。
契約経路とフォールバック経路の**両方**で行う —— どちらに乗るかは CLI の版が決めることで、operator が
選んだことではない。

**既存の `timeout` の意味は変えず、その隣に足した。** `worker_state` も `stop_reason` も `timeout` の
まま、blocking `worker_timeout` もそのまま出て、新しい 3 code（`wait_window_exhausted` /
`worker_stalled` / `worker_liveness_unreadable`）は**その隣に**並ぶ。理由は 2 つ:

1. `worker_timeout` は「**なぜ run が止まったか**」の答えで、その答えは変わっていない。新 code が
   答えるのは「**その timeout はどちらだったか**」という別の問いである。片方を他方で置き換えると、
   既存の read（`status.mjs` の hint 表・resume の停止梯子・fixture）が**答えを 1 つ失う**。
2. `stop_reason` は schema versioned な閉じた enum で、新値は `dispatch_schema_version` を上げる
   （第7節 / ADR 第11節）。`wall_clock_budget_exhausted` が `timeout` を再利用したのと同じ判断で、
   **上げずに済むならそうする**。`worker_liveness` は**任意 field** なので、この field を持たない既存
   report は引き続き schema に適合する。

生死の 3 code は**停止理由ではなく所見**なので、同じ wave の prompt / exit 99 が `stop_reason` を
取った run でも記録される（**測った事実は、どの停止理由が勝ったかで消えない**）。`capture` が失敗した /
出力が JSON でない / boolean が 1 つも読めない、はいずれも `worker_liveness_unreadable` として
**測れなかったこと自体**を記録する —— merge の `change_evidence_unavailable` と同型の規則で、
「見られなかった」を「何も無かった」に丸めない。読めない field は `false` ではなく `null` を記録し、
`worker_liveness` の**不在**も「稼働していなかった」ではない。

`--wait-while-generating` は実装していない。「生成中は待ち続ける」は **wait の時間意味そのものを変える
機能**で、延長の判断根拠（polling 間隔・生成中の定義・延長回数）は本件が入れた 1 回の測定とは別に実測して
決めるべきものである。本件の 1 回の測定と `--reverify` で、実測ケースの回収経路は閉じる。

### #180 — リポジトリの事情を書いた flag の置き場が、人間の記憶しか無かった

`--no-infer` / `--auto-yes` / `--wait-timeout` は run の事情ではなく**リポジトリの事情**を書いている
flag なのに、置き場が人間の記憶と CLAUDE.md しか無かった。付け忘れは**遅い run ではなく事故**になる
（phantom edge / 誰も答えない prompt / `wait_window_exhausted`）。planner が `develop` / `npm` を
hardcode しないのと同じ理由で、**その知識の入口は profile だけであるべき**である。

→ 任意 field `profile.dispatch_defaults`（`no_infer` / `auto_yes` / `wait_timeout` / `max_turns`）を
足し、dispatch runner が plan の profile から読んで引数解決に混ぜる。**宣言の無い plan では entry も
出力も 1 byte も変わらない。**

`Boolean(values['auto-yes'])` は「**渡していない**」と「**off のつもりで渡した**」が同じ false になるので、
これを**三値**で読み直した。`inputs.stated` の `null` が「誰も何も言っていない」であり、boolean の
false を打つ手段として `--no-auto-yes` を新設した（`parseArgs` は boolean option への
`--auto-yes=false` を先に落とすので、negation flag 以外に「この run だけ断る」を表現する方法が無い）。
`stated` が非 null のときだけ flag を採り、それ以外で profile の宣言を採る。**どちらを採ったかは
limitation `dispatch_defaults_applied` に 1 行で残す。**

**排他は argv ではなく解決後の値に対して行う。** `--unattended` と auto-yes の排他は profile 由来の値でも
同じく `invalid_input`（exit 3）になる。**argv だけを見る検査は、profile が回り込める検査**であり、
人が居ない run で唯一残る停止点（exit 10）を profile が構造的に消せてしまう。判定は plan を読んだ直後・
lock / pre-flight / `--out` の前に置いたので、拒否した run は `--out` を作らず CLI を 1 回も呼ばない。

`no_infer` は planner の flag で、**承認済み plan を dispatch が un-infer することはできない**。profile は
runner ごとに分けず 1 つの宣言にしたいので key は受け取り、plan の `inputs.infer` と突き合わせて
**食い違いだけ**を `dispatch_defaults_no_infer_not_applied` に記録する（合致している側は何も出さない。
黙って無視しない）。

profile-init は `dispatch_defaults` を**起案しない**。起案 runner が読むのは「リポジトリが**自分について
宣言していること**」であり、base branch は workflow に、baseline は package.json に、テスト配置は互いを
写す 2 つの実ファイルに書いてある。**運転既定はそのどれでもない** ——「このリポジトリには `--no-infer` が
要る」は**動かした人間が到達した結論**であって tree の中の事実ではない。起案すれば必ず推測になり、
推測した `auto_yes: true` は**検出した値と出力上見分けがつかない**（profile-contract §7.2 が消しに来た
性質そのもの）。`scope_companions` 式の「空宣言 + TODO」も置かない —— あちらの空宣言は「配置を決定
できなかった」TODO と対で意味を持つが、ここは**決定すべき材料が最初から無く**、TODO はどのリポジトリでも
永久に消えない。よって key ごと出さない（出さなければ flag の既定がそのまま効く）。

### #183 — wall-clock が「各 wave の最遅 worker の合計」だった

wave 方式の wall-clock は「各 wave の最遅 worker の合計」になる。worker の 1 ターンは実測で数分〜約 40 分と
ばらつくので（Kewton/BorderFreeKidsMap #62 は e2e/build 込みで約 40 分）、依存の無い Issue が
**「同じ wave に居合わせただけ」の最遅 worker を待つ**時間が支配的になる。

→ `--schedule dag` を足し、その Issue 自身の依存が `completed` かつ `verification.outcome: pass` に
なった時点で `--max-parallel` の空き枠へ投入する。律速が「wave の深さ × 最遅」から**最長経路**へ変わる。
**既定は `wave` のまま**で、`--schedule` を渡さない run の report は #183 以前と byte 一致する。

ready 判定は **#182 の実効 edge** に対して行う（`basis: lexical` を除いた集合）。語彙一致だけの推論は
planner が edge にしないので正しい plan には入っていないが、**手編集や古い runner の plan が #182 の効果を
打ち消すのを防ぐ**ため runner 側でも落とし、落としたら `schedule_dag_lexical_edge_ignored` で名乗る。
`basis` を持たない edge は落とさない（「区別ができる前に書かれた」であって「根拠が無い」ではない）。
file 衝突は依存ではないが、wave packing が担っていた「同じ file を宣言する 2 件を同時に走らせない」は
scheduler 自身が守る。`plan.waves` は参考情報になる（`merge_order` はこれの平坦化であり続ける）。

**barrier が兼ねていた安全装置は 3 つあり、それぞれ別の答えを出した。**

1. **失敗の伝播** — fail した Issue の**下流だけ**を止め（`blocked_by_upstream_failure`）、独立系列は
   走り続ける。`--unattended` では従来どおり全停止に倒し、依存は満たしていたのに投入しなかった Issue は
   `schedule_halted_unattended` として**別 code**で名乗る（対処が違う: 前者は「上流を直して
   `--resume`」、後者は「**この Issue には何も問題が無い**」）。
2. **合流検証のタイミング** — **run の末尾に 1 回。dispatch は merge を 1 回も呼ばない。**
   (a) #175 の受け渡しは「operator が wave 境界で手を止めて merge を回す」運用でしか成立しておらず、
   dag には**その停止点が構造的に無い**。(b) dispatch から merge を呼ぶと 1 invocation = 1 mutating
   phase が壊れ、承認境界（`--approve` / PR 作成 / base の fetch）が dispatch の flag 1 つに畳まれる。
   (c)「N 件ごと」は境界の意味が run ごとに変わる（wave 境界には「そこまでの依存が閉じている」が
   あったが、任意の N には無い）。**dag が失うのは「合流後の赤を早く見つけること」であって「合流後を
   見ること」ではない** —— 依存を宣言している下流は上流の pass を待つので、壊れた前段の上には積まない。
   report / summary / limitation `schedule_dag` が `merge --merge-prs --integration-verify` を 1 回
   回す指示を必ず書く。
3. **同時実行数の増加** — barrier は実効並列度を wave 幅に抑える副作用も持っていたので、dag では同じ
   `--max-parallel` でも走る worker が増える。前提の Kewton/CommandMate#1771（ゲートのリソース直列化 /
   worktree ごとの env 注入）は**現時点で OPEN のまま**であり、ゲートが何を bind するかを runner は
   知らないので直せない。よって**直さずに宣言する**: 「検証ゲートが資源（ポート等）を共有する
   リポジトリでは偽赤が増えうる。#1771 が着地するまでは `--max-parallel` を保守的に設定すること」を
   SKILL.md・契約・`dag` の run の limitation の**すべて**に書いた。
   **`--max-parallel` の既定を dag だけ下げるのは不採用にした** —— `max_parallel` は plan に載って
   **承認された値**であり、dispatch が黙って下げるのは「承認した plan と違う run」を作ることになる
   （無言の劣化を禁じている第2.7節と同じ規律）。下げるべきだと判断した operator は plan を作り直せばよい。

`--reverify` との併用は `invalid_input` で拒否する。reverify は 1 件も send しないので短縮する wall-clock が
無く、しかも ready 条件（依存が green）は**reverify が直しに来た状態そのものを拒否する**。
`--schedule` を #180 の `dispatch_defaults` に足していないのは、これが**リポジトリの性質ではなく、その
run で wall-clock と barrier のどちらを優先するかという運用判断**だからである（加えて #1771 が OPEN の間、
「このリポジトリでは常に dag」という宣言は偽赤を常態化させる）。

実装では、DAG のために per-issue の準備・監督・裁定記録を wave ループから括り出し、**両モードが同じ
関数を通る**ようにした（2 つ目の実装は片方でしか直らない）。DAG では worker の終了順が投入順と一致
しないので、**report に載るものは完了の中から書かない**: scope / liveness の blocking reason も裁定の
記録も、run の最後に **plan 順**で 1 回だけ回す（完了時点で走らせるのは、下流の ready 判定に必要な
fallback 検証だけである）。

### #197 — 構文として正しく、何にも一致しない規則は、誰も検出できなかった

profile-contract 第9.3節は、括弧の誤記（`{Base}` / `{base`）を `load_error` で拒否する理由として
「typo が literal に化けると**一致しない規則が黙って残る**」と書いている。その懸念は正しいが、
**構文として正しく、何にも一致しない規則**は同じ結果になり、こちらは検出されない ——
`scripts/{base}.mjs` と `scripts/{dir}{base}.mjs` はどちらも合法で、
`scripts/adapters/human-review.mjs` に届くのは後者だけである。`require[].add` のリテラルが
**実在しないファイル**でも load は通る。

気づけるのは plan を回して `scope_defaults` を目視したときだけで、そのためには Issue か fixture が
要る。実測（2026-08-14、Kewton/BorderFreeKidsMap）では #181 の `require` へ集約テストの宣言を
移して規則が 6 本になり、**6 本すべてが効いているかを確かめるのに 5 Issue 分の fixture を手書き
した**。書き間違えた 1 本は plan を成立させたまま導出を 1 件減らすだけなので、実際に分かるのは
worker が scope ゲートで落ちたときになる —— 契約 scope は send 時 snapshot なので、
**worker 側からは直せない位置**である。

→ `profile-init.mjs` に read-only の `--check <profile.json>` を足した。起案（draft の生成）とは
逆向きの、**既にある宣言を tree に突き合わせる**モードで、規則ごとに 1 行、`when` が repo tree の
実ファイル何件に一致するか、`derive[].add` / `require[].add` が指す path のうち何件が実在するかを
出す。守っているのは 3 つである。

- **read-only。** tree と profile を読むだけで、profile も plan も書かない。`--out` / `--emit` /
  `--repo` / `--id` との併用は `invalid_input` で拒否する —— **起案しない mode であることを、
  flag の無視ではなく拒否で言う。**
- **裁定しない。** 0 件一致は誤りではない（これから作る file を見越した宣言はありうる）ので、
  `companion_when_unmatched` / `companion_add_missing` は warning であって error ではない。
  status は `partial` になるが exit は 0 で、起案 mode と同じ規約に従う。
- **planner は対象リポジトリを開かない**（第9.1節）は不変である。これは planner ではなく、
  **人間が profile をレビューするときに使う別 runner** である。

**マッチングの意味論を 2 箇所に持たない。** `--check` が独自の解釈を持てば「`--check` は通るが
planner は一致しない」という、本件が消しに来た事象の**変種を自分で作る**ことになる。規則評価
（`{dir}` / `{base}` の展開と一致判定）と宣言の正規化を `lib.mjs` へ抽出し、planner と `--check` が
**同じ関数**を呼ぶ。#177 の境界（`HARNESS_PATH_PREFIXES` / `isHarnessPath`）も、profile を読む
両者で共有する。**抽出が純粋であることは golden で示した** —— 全文 golden 9 本を含む全 plan case の
plan が **1 byte も変わらない。**

例外は 1 つだけで、意図的である。`require[].add` の literal が repo の外を指していないかの拒否は
planner の path 語彙（`SYSTEM_ROOTS`。cmate-issue-authoring が byte 単位で mirror しているので
`orchestrate.mjs` に宣言が残る必要がある）に属するので、planner が predicate を loader へ渡す形に
した。`--check` は同じリテラルを「実在しない path」として warning に出し、planner は profile を
読んだ時点で `load_error` にする —— **許可を与えるのは planner だけなので、拒否も planner が持つ。**
fixture がこの分岐を両側から固定している。

### #224 — `GATE <id> FLAKY` を読めない reader は、裁定を 2 方向に間違える

上流 #1772 は GATE 行に**第 3 の語** `FLAKY` を足した（1 回目 fail → 同一 tree の 2 回目 pass）。
`PASS|FAIL` しか知らない reader にとってこの行は**存在しない行**なので、`verification.gates` から
そのゲートが黙って消える —— #47 が塞いだ穴（report 単体で pass の根拠が読めない）にそのまま戻る。

語彙を `lib.mjs` に置いた。読む側が 4 つ（dispatch / merge / status / uat）在るので、
1 つに語を足して他に足さない形は、同じ run が PR 本文では `unknown`・マトリクスでは `fail` に
見える report を作る。合わせて 3 つの規律を書き下した:

1. **転記であって再判定ではない。** verdict は `wait --verify` の exit code が正であり、
   `FLAKY` が 1 本混ざっていることを理由に `verification.outcome` を動かさない。それを決める
   `flakyIsPass` は verify.yaml 側の宣言で、**GATE 行にも report にも載っていない** ——
   行から裁定を再計算する実装は、`flakyIsPass: true` の run を fail に、`false` の run を pass に、
   **両方向に**間違える。
2. **`flaky` を「失敗を意味する status」の集合に足さない。** #1772 は DB マイグレーションを
   伴わないので `verification_gate_results.status` は `passed` / `failed` のままで、FLAKY は
   その上に重なる LABEL である。足すと、`flakyIsPass: true` で緑になった run が失敗ゲートを
   持つことになる。
3. **detail は解釈しない。** 製品 CLI は括弧形式・standalone runner は空白区切りで**元から別物**
   （#1544 以来）なので、detail を解析する実装は片方の句読点を契約と読み違えている。

---

### #220 — `--max-turns` 到達が、「12ターン働いて空だった」と「1ターンも動けなかった」を同じ文で報告していた

`--wait-timeout` 到達には #179 が3分類を入れたが、**`--max-turns` 到達には分類が無かった**。
exit 21（work-evidence が commit も未 commit の変更も見つけない）が続いて cap に達すると report は
`no work evidence after N turn(s); gave up at the --max-turns N cap` としか言わず、次の2つが
**同じ1文**になった —— worker が本当にNターン回って何も産まなかった（Issue が過大・曖昧）と、
worker が**1ターンも実行できなかった**（上流が落ちていた）。対処は「Issue を分割」と
「ただ待って `--resume`」で**正反対**である。しかも `codes-and-recovery.md` の `worker_failed` 行は
「指示が過大なら Issue を分割して re-plan する」と無条件に書いており、**上流障害のときに誤った対処へ
誘導していた**。

実測（CommandMate #1834 / 利用リポジトリ Kewton/BorderFreeKidsMap #231）: worktree は commit 0・
未 commit 変更 0、`capture` は `isRunning: true / sessionStatus: ready`、pane は 1,001 行すべて空白。
真因は `~/.claude/projects/<worktree>/*.jsonl` を**手で読んで**判明した —— `API Error: 529 Overloaded`
が13回連続、1ターンも実行されていない。10分待って `--resume` したら次の1回で完走した。

既存の signal では見えない理由が、材料を選ぶ根拠になっている。`sendAndConfirm` の「started」も
`probeWorkerLiveness` の「alive」も `isRunning || isGenerating || isPromptWaiting` しか見ないが、
CommandMate の `isRunning` は **tmux セッションが healthy** の意味であって「ターン進行中」ではない。
そして `wait` は `sessionStatus === 'ready'` を見た最初のポーリングで成功を返すので、上流エラーで
即プロンプトに戻る worker は**1ターン5〜10秒で「完了」**する。12ターンが2分で燃えるのはそのためで、
**どちらの signal も「働いていた」と答えてしまう**。

→ exit 21 の cap 分岐で**1回だけ**材料を集め、#179 と同型の任意 object `worker_turn_evidence` を
worker record に足し、同じ code の blocking reason を Issue ごとに1件出す。**裁定は1つも動かない** ——
`verification.outcome` は `fail`、`worker_state` は `failed`、blocking `worker_failed` もそのまま出る
（「なぜ run が止まったか」の答えは変わっていない）。足したのは「**なぜ何も無いのか**」だけで、
`dispatch_schema_version` は 1 のままである。

**「測れなかった」をどちらにも丸めない**のが本件の中心規則である。`worker_upstream_unavailable` は
上流障害の**肯定的証拠**（transcript 末尾の同一1行エラー3件以上／pane の署名一致／hooks が
`stop` を返していない／CLI 自身の `upstreamFault`）を要求し、`worker_produced_nothing` は
ターン成立の**肯定的証拠**（tool 使用・非エラー出力・send 後の `stop`）を要求する。
どちらも無ければ `worker_output_unreadable` を名乗る —— merge の `change_evidence_unavailable`・
#179 の `worker_liveness_unreadable` と同型で、**「見られなかった」を「何も無かった」に丸めない**。
元の障害はまさにその丸めだった。

`turn_durations_seconds` は**判定に使わず必ず記録する**。全ターンが `wait` のポーリング間隔2回分以内
なら人間が読めば分かるし、閾値を runner が決めればモデルの速度についての当て推量になる。
transcript は `cliToolId` が `claude` のときだけ読み、**候補が2つ以上あれば選ばない**（「一番新しい
ものが当該 worker のもの」は推測を測定に見せかける）。CommandMate #1839 の `upstreamFault` は
**在れば使い、前提にはしない** —— 古い CLI には field ごと無く、無いことは「上流は無事だった」ではない。
上流エラー署名は `lib.mjs` に置いた。同じ集合が `monitor-lib.sh` と CommandMate 側にも在るが、
**shell と ES module は定数を共有できない**ので重複を許容している。

対象は exit 21 の cap 分岐だけである。exit 20 の cap と「pass したが commit が無い」cap は
**どちらも実作業が在る**（判定されて落ちた変更／未 commit の変更）ので、「なぜ何も無いのか」という
問い自体が立たない。

### CommandMate #3006 — 新しいセッションへの最初の送信が、起動待ちに負けて落ちていた

Kewton/Musunest #201・#213・#217・#233 で、dispatch が新しく起動したワーカーへの**最初の送信**が
`Command Code prompt not ready: timed out waiting for the composer before sending` で毎回落ちた
（worktree は無傷）。同時に動いていたワーカーは 1〜2 本で、並列度のせいではない。上流は送信の前に
composer を待ち、見つからなければ**打鍵する前に**止める —— つまり何も届いていない。管理が
`--resume` で送り直すと通っていた。

→ 起動中（503 `SESSION_STARTING`。上流側で Command Code もこの code を返すように直る）と
prompt not ready の2つだけを「未送信・送り直してよい」と読み、定数の間を置いて**1回だけ**送り直す。
判定は exit 99 と文言の両方で行う —— 409 も exit 99 で出てくるので、exit code だけで送り直すと
別の拒否まで繰り返す。exit 2（PROMPT_WAITING）も送り直さない。再送の事実は
`send_retried_not_ready` として report に残す（黙って送り直すと、`--resume` を要した run と
区別がつかない）。待ち時間は flag にしない（起動の競合を吸収するためのもので、run ごとに
調整するものではない）。fixture は `CMATE_ORCHESTRATE_SEND_PAUSE_MS=0` で実時間を待たない。
UAT の fix worktree もその run が作るので最初の送信は必ず起動を伴い、同じ判定を共有する
（`scripts/lib.mjs`）。正本: [dispatch-contract.md](./dispatch-contract.md) 第2.13節。

### CommandMate #3007 — 前の回の質問画面が composer を塞いで、送信が理由なく落ちていた

Kewton/Musunest #201・#204 で、前の回に質問を返して止まったワーカーのセッションへ新しい契約を
送ると、残った質問画面が composer を塞いで送信が通らなかった。#201 の送信は #3006 と同じ
`prompt not ready`（exit 99）で落ちており、report からは「起動が遅かった」と区別がつかなかった。
上流の送信ガード（#1708）は読める質問なら 409 で止めるが、読めない質問 UI と plan レビューは
意図的に素通りさせる（Codex の pager や `/model` まで止めないため）ので、上流だけでは直らない。
管理は質問に答えずに `commandmate interrupt` で古いターンを畳んでから送り直していた。

→ dispatch が最初の send の**前に** `capture --json` を読み、`isPromptWaiting` か
`isSelectionListActive` が立っていれば送らずに `stale_prompt_on_session` で止める（画面の抜粋と
`commandmate interrupt` の案内つき）。サーバ側のガードは変えない（上流 Issue での決定）。
`--interrupt-stale-prompt`（既定 off）は管理の手順を runner がやるもので、interrupt の後に
**capture を読み直して composer に戻ったことを確かめてから**送る —— Command Code の
AskUserQuestion / plan レビューに Esc を送ったときにキャンセルになるのかは実測されていないので、
interrupt の exit code だけを信じない。戻らなければ同じ code で止める。どの経路でも質問には
答えない。fixture は CommandMate 側の Command Code 検出 fixture（AskUserQuestion・読めない
質問 UI・plan レビュー）を capture の JSON として渡す（`tests/fixtures/cmate-orchestrate/stale-screens/`）。

各 worker の最初の send の前に capture が1回増えるので、capture の回数を数えていた既存の
fixture（d76〜d78）は回数だけを直した。最初の capture が読めない場合は送信を止めない（上流の
ガードと同じく fail-open）ので、capture が読めない世界の既存 case の結論は変わらない。
正本: [dispatch-contract.md](./dispatch-contract.md) 第2.14節。

### CommandMate #3009 — 監督の nudge が固定文で、ワーカーに「進めてよい許可」と読まれた

dispatch の nudge（「完遂してください」）は固定文だった。指示どおりに書けない状況のワーカーが
これを許可と読み、指示を読み替えて完遂した（Musunest #159）。利用側は「書けないと分かったら
止めて報告する」を必ず添えると決めたが、runner の文面が固定なので添える手段が無かった。

→ 既定文に「指示どおりに書けないと分かったら、進めずに止めて報告してください。」を足し、
profile の `worker_messages.nudge` と `--nudge-message` で**追記**できるようにした（優先順位は
flag → profile）。差し替えにしなかったのは、既定文の「単一 commit が完了の合図」の行を消せると、
commit を待つ監督ループの前提が profile 1 行で崩れるため。`dispatch_defaults` に置かなかったのは、
あちらが真偽値と整数だけで未知 key を拒否する object だから。止まったワーカーを max-turns まで
nudge して最後に failed にする扱いは変えていない。commit 依頼と `cmate-uat` の fix nudge も対象外。

### #287 — nudge に従って止めて報告したワーカーの報告が、report のどこにも残らなかった

上の #3009 で nudge に「止めて報告」を足した結果、ワーカーはそれに従って止まるようになった。しかし runner は
止まったワーカーへ `--max-turns`（既定 8）まで nudge を送り続け、最後は「no commit / no work evidence」の
`failed` にしていた。**ワーカーが書いた報告の文は report に残らず**、報告の無い無進捗と同じ行に並んだ。
利用側（Kewton/Musunest）は止まって返すことを良い停止として扱っており、報告の文が残ることを求めていた。

→ nudge のターンが進捗なしで終わり、ワーカーの transcript がその nudge への返答の文で終わっていたら、
それを「止めて報告した」と読み、**その時点で nudge を止めて** worker 記録の `worker_report` と blocking
`worker_stopped_with_report`（`worker_failed` の隣）に報告の文を写すようにした。正本は
[dispatch-contract.md](./dispatch-contract.md) 第2.12.1節。

判断したこと:

- **見分けるのは nudge のターンだけにした。** 最初のターンで「まず読みます」と返して止まるワーカーは珍しくなく、
  それを報告と読めば従来 nudge で前に進んでいた run を止めてしまう。「止めて報告」を頼んでいるのは nudge なので、
  nudge への返答だけを報告として読む。
- **返答の出どころは transcript にし、画面は使わなかった。** `capture --json` の `realtimeSnippet` には nudge 自身の
  エコーが返答と並んでおり、どの行がどのターンのものかを画面は言えない。transcript なら「最後の human message が
  この nudge で、その後の最後の発話が文」と言えて、それが「この返答はこのターンのものだ」の根拠になる。
  読み方（`cliToolId` と `*.jsonl` がちょうど1つ）は #220 と共有し、2つの読み手が別の file を選ぶことが無いようにした。
- **見分けたら nudge を止めることにした。** 同じ問いに既に答えたワーカーに同じ nudge を送っても、ターンを cap まで
  使って報告を埋もれさせるだけである。次の一手（報告を読んで Issue を直すか `--resume`）は人が決める。
- **裁定と停止理由は動かしていない。** `worker_state` は `failed`、`stop_reason` は `worker_failed`（enum は閉じた集合）、
  `verification.outcome` はそのターンの `wait --verify` のまま。区別は新しい blocking code と `worker_report` が担う。
  `worker_report` は schema で required にしていないので、既存 report は検証を通る。
- **報告を読めなかったとき（`capture` 失敗・Claude 以外・transcript が無い / 2つ以上）は、止めない。**
  「読めなかった」を報告と読めば、読めないだけの run が早く止まる。従来どおり cap まで nudge し、cap で #220 の
  `worker_turn_evidence` を記録する。報告の無い無進捗（最後が tool 呼び出し・nudge が記録されていない）も同じ扱いで、
  従来の挙動を変えていない。

---

## merge（`scripts/merge.mjs`）

### #296 — Command Code など Claude 以外のワーカーの返答が読めず、止めて報告しても上限まで nudge されていた

#287 は返答を Claude Code の転写（`capture --json` の `cliToolId` が `claude`、`*.jsonl` がちょうど1つ）から読んでいた。
Command Code など他のエージェントは「読めなかった」扱いで、止めて報告しても cap まで nudge され、`failed` の
まま返答は report に残らなかった。上流 CommandMate 0.43.0 の `commandmate reply` は、転写リーダーが台帳に書いた
行だけを返答とみなして返す（claude / codex / antigravity / command-code / opencode）。

→ `reply` を持つ CLI では、返答の読み取りを `commandmate reply <worktree-id> --since <その nudge を送る直前の時刻> --json`
に置き換え、出どころを `worker_report.source: commandmate_reply` として残す。返答の文への規則（上流エラー署名なら
報告なし・末尾を残す 600 字・`truncated`）は #287 のまま。正本は [dispatch-contract.md](./dispatch-contract.md) 第2.12.1節。

判断したこと:

- **`reply` の有無は `reply --help` の成否を 1 回だけ probe して決めた。** 起動時の `send --help` / `wait --help` と同じ流儀で、
  `commandmate --version` の比較は採らなかった（版番号ではなく、その CLI が実際に答えるかを見る）。
- **`reply` が無い CLI（0.43.0 未満）では、従来の Claude 専用の転写読みに戻す（フォールバック）。** 「読めない」扱いにすると
  0.35.0 で読めていた Claude のワーカーが後退するため。どちらでも dispatch は失敗させない。
- **`reply` が exit 0 以外・JSON が読めない・`reply: null` のときは報告なし**として従来の無進捗の扱いに落とす。`reply` は pane に
  フォールバックしないので、返答の無いターンを報告と読むことは無い。
- **`--since` は nudge を送る前に取った時刻にした。** 送信後に取ると、速いワーカーの返答がそれより前になり得る。
- **`--instance` は渡していない。** dispatch は `send` / `wait` にも instance を渡しておらず、3 つとも worktree の
  primary instance を指す。`--instance` を足すなら send / wait と同時に足す。
- `worker_report.source` の enum に `commandmate_reply` を足しただけで、`worker_report` は required のまま増えていない。
  blocking `worker_stopped_with_report` の detail は、出どころに応じて「`commandmate reply` で読んだ」または
  「Claude Code の転写から写した」と言う。

### CommandMate#3005 — `--create-prs` の PR が、利用側の運用では merge できなかった

利用側（Kewton/Musunest）は「検証が緑になったらワーカーが push して PR を作り、管理が merge する」で
回しており、**毎回あとから追加のメッセージで push を指示していた**。1件はワーカーが「skill 第4節と
実行契約が禁じている」として断った（Kewton/Musunest#210）。起票時の提案は「実行契約でワーカーに
push と PR を許可する」だったが、問答で確かめると、**PR を作る経路はすでに `merge.mjs --create-prs`
にあった**（run `plan-01ba9bc589cb` の #248 に preview で実行。push・PR 準備までそのまま使え、本文の
検証証跡はワーカーに書かせていたものより充実していた）。使われていなかった理由は2つだった。

1. **PR タイトルが Issue タイトルそのものだった。** 利用側は PR タイトルを Conventional Commits で
   CI 検査しており（semantic-pull-request）、squash の件名＝PR タイトルなので、日本語の Issue
   タイトルのままでは merge できない。
2. **ワーカーの「読み替え・判断」の申告が PR 本文に載らなかった。** 本文は dispatch report から作られ、
   申告はワーカーの最後の報告にしか無い。利用側は「読み替えの申告があれば merge せず窓口へ返す」を
   決まりにしていて（先に merge された Kewton/Musunest#233 から）、申告は merge を止める合図である。

→ **ワーカーは push も PR も作らない既定のまま**にした（二重 PR を防ぐ `cmate-worker-development`
第4節と実行契約の文面は変えていない）。代わりに `--create-prs` を利用側の運用で使えるようにした。

- profile に `pr_title_template` を足した（[profile-contract.md](./profile-contract.md) 第13節、
  [merge-contract.md](./merge-contract.md) 第5.7節）。`{{type}}` / `{{scope}}` は**ブランチ自身の
  コミット件名**から取る。Issue の label から取る案は採らなかった —— label の語彙（`enhancement` /
  `bug`）は type の語彙ではなく、対応表はこの runner が発明する第二の規約になる。コミット件名は
  ワーカーが既にリポジトリの規約で書いているもので、squash ではそれが PR タイトルに置き換わる
  （タイトルは件名の後継である）。**決まらなければ推測せず、その PR を作らずに止める**
  （`pr_title_undetermined`）。推測した type は、タイトル検査に push の後で落とされるか、違う type の
  まま通るかのどちらかである。欄が無ければタイトルは従来どおり（既存 golden は byte 一致）。
- ワーカーのコミットメッセージ本文の申告行（`読み替え:` / `判断:` / `本文に無い指摘:`）を PR 本文の
  「ワーカーの申告」節へ原文転記し、report に `worker_declarations_transcribed` を出す（第5.8節）。
  置き場所をコミットメッセージにしたのは、ワーカーが既にそこへ書いていて、ブランチと一緒に運ばれ、
  他の誰も書き込まないからである。利用側では `.commandmate/` は人だけが書く場所なので、
  ファイルは置かせない。申告が無い run の本文は変わらない。読めなかったときは「読めなかった」と書き
  （`worker_declarations_unread`）、「申告なし」と見分けがつくようにした。

### #142 — 無人運転の段階 C（`merge --merge-prs`）

段階 A / B が到達する最遠点は PR であり、**PR は人間が読む場所である**。「lint と test が通った」を
「Issue が完成した」と読み替えた成果物が PR として立つことは、害ではなく本来の姿だった
（レビュアーが読み、必要なら close する）。**段階 C は違う。そこで読み替えが起きると、誰も読まないまま
base branch に入る。**

→ `--merge-prs --unattended` を受理する。段階 B の `invalid_input` は**消したのではなく、それが名指し
していた段に置き換えた**。**含意する締め付けは1つだけである: 全 eligible Issue が「受入ゲートブロック
（```acceptance-gates）を持つ」かつ「受入条件を持つ」こと**（ADR 第9節 条件2）。1件でも欠ければ
**1つも merge せずに停止**する（`preflight_failed` / exit 1）—— **除外ではなく停止**であり、
**条件を満たす Issue も merge しない**。除外にすると「満たす方だけ merge して success」を返すので、
対象集合が黙って縮んだことに誰も気づけない。読むのは plan だけで、**ゲート id が実在するかは問わない**
（それは worktree を持つ dispatch の問いであり、merge 段では既に消えているかもしれない worktree に
ついて二番目に悪い意見を出すことになる）。

`--create-prs` の締め付けリストは**段階 B の1件のままである**（後から段階 B の意味を変えない）。
`merge_schema_version` は 1 のまま、`stop_reason` の enum にも値を足していない。

### #134 — 無人運転の段階 B（`merge --create-prs`）

`--unattended` を `merge.mjs` が受理する。**含意する締め付けは1つだけである:
`change_evidence_unavailable` を limitation ではなく blocking として扱う。** PR 本文に実変更を
載せられなかったという事実は、人間が読む運転なら読み手が branch を開いて補える劣化だが、
無人では**証拠の無い PR が黙って作られる**ことになるので、その Issue の PR を作らずに停止する。
フラグ無しでは従来どおり limitation で続行する（fixture で二点測定）。

**`--approve` を含意しない**（無人で PR を作る CI は両方書く）。**`--merge-prs` との併用は
`invalid_input` で拒否する**（段階 C 未実装。受理して無視すると CI は自分が守られていると誤解する）。
`gh` 由来の停止はコードに足していない —— 実測（#115 第14.5節）どおり
`GH_TOKEN` と `GIT_TERMINAL_PROMPT=0` は job 定義側の話である。


### #97 — PR 本文が「検証した」と言うだけで、何を通ったのかは JSON の中だった

merge runner は `--dispatch` で dispatch-report.json を必須入力として読んでいたのに、
eligible 判定にしか使っていなかった。PR 本文の Verification 節は定型文と profile baseline の
コマンド一覧だけで、**gate 別の合否も exit code も転記されない**。レビュアーは run artifact を
掘るか、diff を自力で照合するしかなかった。契約が宣言した `scope.allow` に対して
**実際に何を変更したのか**も PR には現れなかった。

→ Verification 節を実測証拠に置き換えた。gate 名・合否・exit code の表、宣言 scope と実変更
ファイルの対比（契約ゲート `requireScopeClean` の人間可読版）、diff 規模。`verification.ran` が
false ならその事実を明示する（定型文で pass を匂わせない）。転記値は既存の `redact()` を通し、
gh の本文上限に備えて checks は打ち切り、**打ち切った事実を本文に書く**。

### #39 — 多段ブランチ運用で、PR を merge しても Issue が open のまま残った

GitHub が `Resolves #n` で Issue を自動クローズするのは**デフォルトブランチへの merge 時だけ**
である。`feature/* → develop → stg → main`（デフォルトは `main`）のような運用で `develop` 宛に
PR を出すと、merge しても Issue は open のまま残った。

→ phase 冒頭で read-only の `gh repo view --json defaultBranchRef` を **invocation あたり1回**
引き、PR の base がデフォルトブランチかどうかを見る。違えば limitation
`issue_autoclose_not_default_branch` を記録し、各 PR body にも同趣旨の注記を1行足す。
`gh repo view` が失敗した場合は**照合をスキップするだけ**で、PR 作成フローは阻害しない
（不明を不一致として扱わない）。記録に留め、`gh issue close` を勝手に実行することはしない。
正本: [merge-contract.md](./merge-contract.md) 第5.1節。

### #174 — 非ASCII path が、PR 本文で「宣言外の変更」に化けていた

`changeEvidence()` が `git diff --name-only <range>` の出力を、plan の `scope.allow`（Issue が書いた
ままの UTF-8）と文字列比較していた。**git は path をそのまま出さない** —— `core.quotePath` が既定
true なので非ASCII バイトを 8 進エスケープし、全体をダブルクォートで囲む。結果、同一 file が別表記で
2 行に並び、scope 内の変更が PR 本文で `Out-of-scope changes: 1` / `Declared: no` になる。

裁定（CommandMate の scope ゲート）はこの経路を通らないので **pass のまま正しく、壊れていたのは人間が
読む本文だけ**である。ただし出るのが `branch_changed_outside_declared_scope` という**正常系の名前の
limitation** なので、「worker がスコープを踏み越えた」と読まれる。

→ 2 案のうち **`-z`（NUL 区切り）** を採った。`-c core.quotePath=false` は**非ASCII しか解かない** ——
`"`・`\`・制御文字を含む path は quotePath に関係なく C クォートされるので残る。`-z` は munge 自体を
止め、区切りも NUL になるので `split('\n')` が持っていた**別の穴（改行を含む path）**も同時に塞ぐ。
実測で `-z` が使えない事象は無かったため fallback は採用していない。`--numstat` も揃えた（現状は
件数集計にしか使っていないので出力は正しいが、**将来 path 列を読んだときに同じ欠陥が再発する**）。

PR 本文と reference が引用する command 行にも `-z` を入れた。この節の目的は「run ディレクトリの JSON の
中にしか無い証拠を残さない」ことなので、読み手が同じ command を再実行して**表の path と同じもの**を
得られる必要がある —— `-z` 無しの command を書くと、再実行結果はエスケープ表記になり、**本件と同じ
食い違いを読み手側に作る**。

fixture 側の穴も同時に塞いだ。それまでの fake CLI は scenario の path を**そのまま echo していた**ので、
**この不具合は fixture からは見えなかった**。本物と同じ munge 挙動（quotePath 既定 true、`"`/`\`/
制御文字は設定に関係なくクォート、`-z` なら munge 無しの NUL 終端、`git -c k=v` の解釈）を持たせてある。

### #175 — file が重ならない意味的衝突は、合流後を誰も検証していなかった

wave の衝突検出は `suspected_files` の重なりしか見ず、guarded merge が確認する CI は**兄弟 PR が入る前の
base** で走っている。したがって「片方がデータを直し、もう片方がそのデータの性質に依存する検査を書く」類の
**意味的衝突**は file が重ならないので「衝突なし」として同一 wave に入り、**合流後の状態は誰も検証して
いない**。実測（2026-08-12、Kewton/BorderFreeKidsMap #105 × #106）では develop に入った直後から
`npm run test:unit` が赤で、発覚は develop → stg の promotion PR の CI だった。

→ `--merge-prs` に **opt-in の `--integration-verify`（既定 OFF）** を足した。merge を 1 件でも行った
あと、merge ループの後に**1 回だけ** `git fetch` → `FETCH_HEAD` の使い捨て detached checkout →
profile の baseline を実行 → 畳む、を行う。

- **何を実行するかは profile からしか取らない**（`develop` / `npm` は hardcode しない。planner と
  同じ設計原則で、規約の出どころは profile だけである）。
- **materialise するのは `FETCH_HEAD`** である。ローカルの `develop` も fetch 前の `origin/develop` も
  「**各 PR の CI が既に green だと主張した状態**」であり、合流後を測るには remote が今持っている tip で
  なければならない。
- **使い捨ての detached checkout** で測り、invocation の作業ツリーには触れない。branch も持たず
  CommandMate にも登録しないので、`cmate-worktree-setup` に委ねている worker 用 worktree の準備段では
  ない。畳めなければ**裁定は変えずに** `integration_verify_tree_left` に残す。
- preview / eligible 無しでは merge が無いので `outcome: not_run` + `integration_verify_not_run`。
  **「測っていない」を green に丸めない。**

**profile に baseline の宣言が無いときは error であって skip ではない**（1 件も merge せずに
`preflight_failed` / exit 1 / `integration_verify_unavailable`）。根拠は 3 つ:

1. skip にすると、**opt-in した検証が走らないまま「merge phase 完了」と報告される**。誰も合流後を
   見ていないのに緑に見える —— **#175 が消しに来た事象そのもの**である。
2. 同じ読みが既にこの package の 2 箇所にある。dispatch の fallback 検証は baseline が空なら
   `outcome: fail`（「検証すべき gate が無いから pass」に化けさせない）、profile-init が埋められない
   baseline に置く雛形は **exit 0 しない command** である（profile-contract 第7.2節）。
   **埋め忘れた baseline は fail-closed でなければならない。**
3. **merge の前**に拒否するので世界は動いていない。profile に `baseline` を書いて同じコマンドを
   再実行すればよく、**取り消すものが何も無い**。

`merge_schema_version` は 1 のまま、`stop_reason` / target `outcome` / `preflight[].code` にも値を
足していない。上げると `status.mjs`（`SUPPORTED_MERGE_SCHEMA_VERSION = 1` を pin）が**フラグを使って
いない run の report まで読めなくなる**。赤は既存の **`merge_failed`** が受ける —— `ci_failed` /
`ci_pending` はこの report では「その PR の CI が green でないので **merge しなかった**」を意味しており、
合流後の赤は **merge が成功した後**の話なので、そこへ流すと report の中で最も安全に関わる事実
（**何が既に base に入ったか**）が逆に読める。名指しは `blocking_reasons[]` の code が行う。
`--create-prs` との併用は `invalid_input`（exit 3）で拒否する —— **merge しない phase には合流後が無い**。
受理して無視しない（段階 B の `--merge-prs --unattended` 拒否と同じ規律）。

これで wave barrier の意味が「前 wave の全 worker 完了 + verification pass」から**「統合ブランチも
green」**まで広がった。dispatch が読むのは `integration_verify.outcome` で、進んでよいのは
**`status: success` かつ `"pass"`** のときだけ —— `"not_run"` は「測っていない」であって green ではなく、
**field ごと無いのは「フラグを使っていない run」**である（第5.4節）。

**merge queue 方式（base 更新 → CI 再走 → merge の直列化）は実装していない。** Issue 本文が「まずは
合流後検証の 1 段で十分」と判断している。#183（`--schedule dag`）から見たこの検証の位置づけは
dispatch 節の #183 に書いた。

### #195 — `--integration-verify` が、目的の違う検証集合を流用していた

#175 の `--integration-verify` が実行するのは profile の `baseline` だが、`baseline`（各 worker が
worktree で回す **proportional な健全性確認**）と「**合流後の統合ブランチが green か**」は
目的の違う検証集合である。同じ key を共有している限り、どちらか一方は必ず間違う ——
`baseline` を重くすれば worker の fallback 検証が毎回 build / e2e を回し、軽いままにすれば
opt-in した統合検証が「**測っていないのに green**」になる。

しかも #175 の fail-closed は**これを検出できない**。埋め忘れ（未宣言）は `preflight_failed` /
exit 1 で落ちるが、**目的の違う `baseline` が宣言されている状態**は `outcome: "pass"` を返して
`status: success` になる。実測（Kewton/BorderFreeKidsMap）では、このリポジトリの `baseline` は
`npm ci` / `lint` / `typecheck` の 3 本で **`unit` を持たない**（重い検証は最後の verify に任せる、
という運用文書の判断である）。したがって **#175 を起票させた当の #105 × #106 が、
`--integration-verify` を付けたまますり抜ける** —— この機能が消しに来た当の事象である。

→ 任意 field `integration_baseline` を足し、解決を `integration_baseline` ?? `baseline` にした。
**`??` が働くのは key が未宣言のときだけ**で、宣言しない profile の run は #175 と同一の集合を測る。
`"integration_baseline": []` は「**統合検証の定義は無い**」という宣言なので `baseline` へは落とさず、
`--integration-verify` 下では `preflight_failed` / exit 1 / `integration_verify_unavailable` にする
（1 件も merge しない）—— 目的の違う集合へ黙って落ちるのは、**本件の論旨そのものに反する**。
配列でない値を持つ手書き plan も同じ fail-closed 側へ倒す。

**採った側を `integration_verify.source` に記録する。** どちらを測ったのかが report 単体で読めないと、
この分離は「**静かな 2 つ目の baseline**」になる —— 違う集合を測った 2 つの report が同じに読める。
何も実行しなかった run でも記録し、2 つある拒否の next action もこれで分岐する。空宣言の author に
「`baseline` を宣言しろ」と案内するのは、**意図した宣言を取り消せという意味になる**からである。

planner 側（`PROFILE_FIELDS` と `publicProfile()` の echo）を同梱したのは、#180 が踏んだ
「**読む側だけ先に着地する**」非対称（#196）を繰り返さないためである。`merge.mjs` だけ直しても、
`integration_baseline` を書いた profile は plan 段階を通らない。echo では**宣言された `[]` を `[]` の
まま出す** —— merge の解決は key の存在で分岐するので、落とすと未宣言と区別が付かなくなる。

`profile-init` は `integration_baseline` を**起案しない**（#180 / #181 と同じ規律）。何を統合検証に
すべきかは、**リポジトリが自分について宣言している事実ではなく、運転して分かる結論**である。

「宣言したが読まれていない」緑は**変異で反証した**。`baseline` は合流後 green・`integration_baseline`
は赤という profile（`m28`）は、宣言を無視する実装 ——すなわち #175 の挙動—— なら緑になる。逆向き
（`m29`: フォールバックが赤・宣言が緑）の `pass` は、宣言を読んだ実装にしか出せない。

`merge_schema_version` は 1 のまま据え置いた。足したのは `--integration-verify` を渡した run にしか
現れない object の内側の 1 field で、上げると `status.mjs`（`SUPPORTED_MERGE_SCHEMA_VERSION = 1` を
pin。#175 と同じくこの Issue の宣言 scope の外）が**フラグを使っていない run の report まで読めなく
なる**。判断は [merge-contract.md](./merge-contract.md) 第10節に #175 の先例と並べて書いた。

### #222 — merge が成功したあとの `index.lock` が、「merge が壊れた」と読めた

`merge.mjs --merge-prs --approve --integration-verify` が `status: success` /
`integration_verify.outcome: pass` で終わったあと、**呼び出し元 worktree に 0 バイトの
`index.lock` が残り、後続の `git pull --ff-only` が落ちる**ことが同日に 2 回あった
（CommandMate #1836。利用リポジトリ Kewton/BorderFreeKidsMap での実測。発見時点でそれぞれ
約 40 分・52 分経過、`pgrep -fl 'git '` は該当なし、stale lock を消せば復旧）。

**危険なのは lock そのものではなく、それが「merge が壊れた」と読めることである。**
merge も統合検証も終わっているので、ここで人間が巻き戻すと **正しく終わった run の上に
二次被害を積む**。

**真因はこの runner には無い。** フィードバック元は「統合検証の使い捨て checkout が
呼び出し元の index を掴んでいる」と推定し、`git worktree add --detach` にすることを提案したが、
**それは #175 の時点で既に実装である**（`merge.mjs` の `runIntegrationVerify`、および
`INTEGRATION_TREE_DIRNAME` の上のブロック）。この file が呼ぶ git verb は `fetch` /
`rev-parse` / `worktree add|remove` / `diff` / `push` だけで、`checkout` / `merge` / `reset` /
`read-tree` / `stash` / `pull` / `update-index` は**1つも無い** —— 呼び出し元の index を書く経路が
無い。`runCli` は `execFileSync` に `timeout` も `killSignal` も渡していないので、runner が git を
SIGKILL する経路も無い（SIGTERM なら git は自分の lock を消す）。0 バイト・数十分放置・git
プロセス無し、は「**何かの git が lock 保持中に SIGKILL / クラッシュした**」形であり、候補は
呼び出し元 worktree で走る他プロセス（agent harness / IDE の git 連携 / git status のポーリング）
だが、**コードだけでは特定できない**。

→ **消すのではなく、検出して名乗る。** run の開始前（pre-flight の前。この invocation が git を
1回も呼ぶ前）と report を書く直前に `git rev-parse --git-path index.lock` → `stat` し、
`caller_worktree.index_lock_before` / `index_lock_after` に記録する。開始時に在れば
`caller_index_lock_pre_existing`、無くて終了時に在れば `caller_index_lock_appeared`。
**どちらも notice で、裁定を1つも変えない** —— この runner は呼び出し元の index を使わないので
停止する理由が無いし、merge も統合検証も終わった run を failure に落とすのは、本件が消そうと
している誤読そのものである。

**runner は lock を消さない。** lock は「今この index を書いている」という git の宣言であり、
他人が保持中の lock を消すと**それが守っていた index が壊れる**。復帰手順（先に
`integration_verify.outcome` と `merged` を読む → size 0 / mtime が run 中 / `pgrep -fl 'git '`
に該当なし、の3つが揃うときだけ人間が手で消す）は
[codes-and-recovery.md](./codes-and-recovery.md) 第4節に置いた。「消さない」ことは fixture でも
**ファイルシステムの事実として**測っている（`m33` / `m34` は run 後に lock が残っていることを
確かめる。実装が unlink すれば、limitation が同じでも赤くなる）。

`path` は**呼び出し cwd からの相対**で記録する（[merge-contract.md](./merge-contract.md) 第7節:
絶対 path を report / artifact に残さない）。復帰は同じ cwd で走るので相対のまま使えて、
利用者名が漏れない。

**ついでに、後片付けの成功を報告するようにした**（`integration_verify.tree_removed`）。#175 では
畳めなかった側（`integration_verify_tree_left`）しか記録が無く、**成功が無言**だったので、
「畳んだ」と「言えるほど新しくない runner」が同じ report だった。`ran` が true のときだけ現れる
（＝畳む対象が在ったときだけ）ので、不在は「checkout を作っていない」であって
「測っていない」ではない。

`merge_schema_version` は **1 のまま**。足したのは optional な `caller_worktree`（両 phase に出る。
lock 無しの run は両方 null で、fixture `m22` の golden はこの block だけを増やして byte 比較を
続ける）と、`integration_verify` の内側の `tree_removed` である。`stop_reason` にも
`preflight[].code` にも値を1つも足していない。

---

### #219 — PR 本文の scope 対比が、上流のゲートより狭い解釈をしていた

`scopeMatches` は `*` と `**` だけを解釈し、それ以外は literal だった。上流の scope ゲート
（`globToRegExp`、CommandMate #1546）は同じ入力に対して**ディレクトリ前置**（`src/lib` は
配下すべてを指す。人がディレクトリを書く綴りである）・`?`・`{a,b}` も honour するので、
PR 本文の対比表は in-scope の変更を「宣言外」として数えていた。レビュアが読むのは
実在しない違反であり、しかも上流のゲートは同じ変更を通す。

→ `lib.mjs` に上流の部分集合を移植し、merge と planner の両方がその1つの関数を使うようにした
（1つの関係に対する実装が package 内に2つあれば、その2つは黙って食い違う）。
`[` と `]` が literal であることも含めて写してある —— Next.js の `src/app/[...path]/` を
文字クラスとして読むと、その path を名指した pattern が何にも一致しなくなる。
裁定の**置き場所**は変えていない: `requireScopeClean` を下すのは上流であって、この runner は
その根拠を人間が読める形にするだけである。

---

## uat（`scripts/uat.mjs`）

### #288 — uat の fix nudge だけが固定文で、dispatch と同じ読み替えが起きえた

何が起きたか: dispatch の監督 nudge には「指示どおりに書けないと分かったら、進めずに止めて報告してください。」が入り、
`worker_messages.nudge` で追記もできた（CommandMate#3009）。uat の修正ループの nudge（`FIX_NUDGE_MESSAGE`）は固定文のままで、
fix worker が指示どおりに書けないとき、止めずに別の読み替えで進めうる。
だからこう変えた: 既定文に同じ 1 文を足し（既存の行は消さない）、`worker_messages.fix_nudge` と `--fix-nudge-message` を設けた
（flag → profile → 既定文の順。追記であって差し替えではない）。設計判断: (1) flag を足したのは dispatch の `--nudge-message` と
同じ操作で 1 run だけ文面を変えられるようにするため。(2) planner と dispatch は `fix_nudge` を受理する（dispatch は使わない）。
拒否すると uat 用の欄を書いた profile が dispatch で止まるため。検証規則は `lib.mjs` の `workerMessageProblem` を共有する。
(3) uat report の schema は増やさず、採用結果は limitations の `worker_messages_applied` に文字数だけ残した。

### #259 — 意味ゲートの producer が 1 つに固定されていて、実機 UAT の判定を入れられなかった

`skill.id` の検査が `cmate-acceptance-test` の 1 値決め打ちだったので、**同じ
`acceptance-result.v1` を書いても別の Skill の判定は `invalid`** になった。これが効いたのは
[#260](https://github.com/Kewton/commandmate-skills/issues/260) の `cmate-uat` である。

分担はこうなっている。`cmate-acceptance-test` は**渡された対象を検証する判定器**で、環境は立てない。
サーバや DB を立てないと確かめられない受入条件は `manual_pending` にしか落とせず、runner では
`acceptance_conditional`（owner `human`）で止まる。`cmate-uat` はその穴を埋めるために環境を起動し・
隔離を実測し・TC を回し・証跡を残してから判定する。

**両方を直列に回す案は採らなかった。** `cmate-acceptance-test` は自分で check を実行する設計で、
外から渡された証跡を受け取る入力を持たない。直列にすると受入条件の抽出・test plan の確認・実行・
証跡の記録がまるごと二重になり、2 本目から得られるのは「判定の語彙と決定表と schema」だけになる。
そこで `cmate-uat` 側が同じ schema を書き、**runner が producer を 2 値の allowlist で受ける**形にした。

→ `skill.id` の検査を `['cmate-acceptance-test', 'cmate-uat']` の **allowlist** にし、
per-issue の `acceptance.producer` に `{id, version}` を記録する。**緩和ではない**:
この 2 つ以外は従来どおり `invalid` で、「v1 に見えるから通す」ことはしない。
合成規則（第4.2節）は 1 行も変えていない —— 誰が書いたかは裁定を変えないからである。

`producer` を記録したのは、fix prompt の受入判定見出しを**固定文字列にしていた**のが実害だった
からである。producer が 2 つになった時点で、その Skill が出していない判定にその Skill の名前が乗る。
見出しは `acceptance.producer` から組み、名乗れる producer が無い state（`missing` / `invalid` /
`mismatched`）では総称の `semantic gate` に落とす。`uat_schema_version` は 1 のまま、
`stop_reason` にも `verdict_source` にも新しい値は足していない。

### #142 — 無人運転の段階 C（`uat`）と、再merge が入る先の検査

`uat.mjs` の再merge は `git merge --no-ff --no-edit <fix-branch>` で **cwd 指定を持たない**ので、fix は
**invocation cwd の現在の branch** に入る。[#115](https://github.com/Kewton/commandmate-skills/issues/115)
が使い捨てリポジトリで実測した（ADR 第14.3節）: **CI が base branch を checkout した状態で回すと
UAT の fix が誰のレビューも経ずにそこへ入り**（push 済みなら不可逆）、**detached HEAD では merge exit 0 で
「merged」と報告しながらどの branch にも残らない**（既存の停止語彙では捕まらない静かな false success）。
人間が居る運転では cwd を選んだのが人間なので前提は満たされていたが、**無人運転ではこれは前提ではなく
検査すべき条件になる**。

→ `--unattended` を受理し、`--create-uat-fix-worktrees` では **fix worktree を1つも作る前に**
`git symbolic-ref -q HEAD` を撃つ。出力が空（detached）なら `unattended_cwd_detached`、
`--expect-branch` と違えば `unattended_cwd_branch_mismatch` で停止する（`preflight_failed` / exit 1）。
**worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしない。** 比較対象の branch は
plan のどこにも無いので（`profile.base` は **base** であり、fix を base に入れることこそこの検査が
防ぐ事故である）、dispatch の drift check と同名の **`--expect-branch` を足した**。

`--unattended` は **`--require-acceptance` と `--max-attempts` の明示も要求する**。意味ゲート無しの
無人 UAT は「dispatch が既に通した baseline をもう一度走らせた」でしかなく、**受入を確認したとは
言えない**。その帰結として `acceptance_not_run` は**昇格ではなく「起こらない」**（劣化は不合格になる）——
専用のコードは1行も書いていない。`uat_schema_version` は 1 のまま、`stop_reason` の enum にも
値を足していない。

### CommandMate #1616 — baseline が green でも受入条件は未達、という穴

機械ゲート（profile baseline）だけで裁定していたため、「lint も test も通るが、Issue の受入条件は
満たしていない」成果物が `success` に丸められた。

→ 裁定を **機械ゲート + 意味ゲート**の二層にする。意味ゲートの入力は cmate-acceptance-test の
result document（`acceptance-result.v1`）であり、**判定の生成はエージェント側の手順、合成は
uat runner の決定的処理**である（runner 内で LLM 判定はしない）。`conditional_go` は human 判断
であって自動修正の対象ではないので pass にも fix 対象にもせず `partial` で提示する。
result が無い・schema 不適合・対象 Issue 不一致は limitation `acceptance_not_run` として記録し、
**黙って劣化しない**。`--require-acceptance` はそれを不合格に格上げする。
正本: [uat-contract.md](./uat-contract.md) 第4節。

### CommandMate #1448 — fix worktree は worktree-result の形に合わせる

fix worktree の作成は base を resolved SHA に再確認し、既存 worktree を暗黙上書きしない。

### CommandMate #1468（uat 側） — fix worker も監督ループで駆動する

fix worker も dispatch worker と同じく毎ターン idle 化する。**wait の idle は完了ではない。**
fix branch に新規 commit が出れば `completed`、未 commit なら継続 nudge を送って `wait` へ戻り、
`--max-turns` 到達で未 commit なら `fix_failed` で停止する。

### 上限到達を成功に丸めない

fix 回数は `--max-attempts` を超えない。上限到達でなお不合格が残るなら **`blocked`
（`max_attempts_reached`）** で停止し、未解決 Issue と next action を返す。回数無制限のループは
スコープ外である。

### #163 — 「人が閉じるべき残件」が 8 件で黙って切れていた

`acceptanceFindings` / `acceptanceConditions` は集めた項目を `MAX_ACCEPTANCE_ITEMS`（8）で
切っていたが、切ったことをどこにも書かなかった。9 件目以降の fail や未解決基準が uat-report から
読めなくなり、**リストは全量であるかのように見える**。8 件ちょうどのとき、それが「全部で 8 件」
なのか「8 件で切れた」のか区別できない。

さらに items の組み立て順（criteria → next_actions → limitations）により、**criteria が 8 枠を
食い尽くすと next_actions と limitations は 1 件も載らない**。acceptance 側が明示した次アクションが
report から丸ごと消える。`conditions` は「人が閉じるべき残件」の一覧なので、誤読の代償が大きい。

→ 新設した `fitAcceptanceItems(groups, max)` が 2 つの規則で枠を配る。いずれも `merge.mjs` の
`capped()` / `droppedNote()` から持ってきた考え方である。**(1) 切ったら必ず名乗る** ——
落とした件数と種別ごとの内訳を末尾の注記に書く。注記は上限の外に足すのではなく **1 枠を消費する**
ので、schema の `maxItems` 境界は変わらない。**(2) 発言のある種別は最低 1 枠を確保する** ——
長い fail の列が予算を食い尽くして後ろの種別が丸ごと消えることを防ぐ。

上限値 8 そのものは report サイズ抑制として妥当なので変えていない。合否裁定（`outcome`）にも
触れていない —— 変えたのは読み取りだけである。

---

## inspect（`scripts/inspect.mjs`）

### #217 — 本文が主張する事実が古いことを、dispatch までの経路で誰も検知しなかった

planner の入力は Issue の number / title / body / labels だけで、**対象リポジトリを開かない**
（`orchestrate.mjs` の `loadIssues`、profile-contract 第9.1節）。これは設計上の不変条件であり、
本件でも変えていない。問題はその不変条件が**残す穴**のほうだった —— 本文が主張する事実
（`path:line`・「N 行」）が古くなっていることを、**dispatch まで誰も機械的に検知しない**。
`orchestrate.mjs` / `lib.mjs` に行番号や行数を突き合わせる処理は無く（根拠節の `path:line` は
context 扱いになるだけ）、下流の `cmate-worker-development` 規律4「行番号が食い違ったら実測を
正とする」と `cmate-issue-refinement` Step 4 は**どちらも LLM 手順**で、dispatch 前に走る script は
1つも無かった。

実測（CommandMate #1831 / Kewton/BorderFreeKidsMap）では、epic 配下 16 Issue を 1 日で連続
dispatch して **16 件中 11 件**で本文が実物とずれていた。前日に起票し、その間に先行 Issue が
同じ file を動かしたためである。`repository.ts` は本文 1,070 行に対し実測 1,129 行で根拠の
行番号 5 点すべてがずれ（`:979` → `:1038` 等）、`AreaMap.tsx` は 1,411 対 1,668、
`validators.ts` の `:392` / `:488` は実測 `:443` / `:513`。いちばん高くついたのは
**e2e の test 件数**で、受入条件が「着手前と同じ 130」と書かれていたのに実測は 136 —— 直さない限り
**「先行 Issue が足した 6 件を消す」が受入条件の正しい読み**になる。回避策は人間が 16 件ぶん
手で照合することだった。

→ plan とは**別の read-only 点検 runner** `scripts/inspect.mjs --check-references` を足した。
`profile-init.mjs --check`（#197）と同じ規律である ——

- **何も書かない。** plan.json には 1 byte も書かず、`--out` を名指したときだけそこに書く
  （既存なら `out_exists`）。stdout と `--out` は**同じ byte**である。
- **裁定しない。** 所見は5つとも warning で（`reference_file_missing` /
  `reference_line_out_of_range` / `reference_identifier_moved` / `reference_line_count_stale` /
  `reference_claim_inconsistent`）、1件でも出れば `status: partial`、**exit は 0** である。
  本文が古いことは「dispatch してはいけない」ことではない。
- **読めない入力は点検しない**（無視ではなく拒否）。`--repo-root` が無い / Issue が取れない /
  `--ref` が解決しないは `load_error`（exit 6）、引数不正は `invalid_input`（exit 3）で止まり、
  envelope の `inspection` は `null` になる。**「見て何も無かった」と「見られなかった」を
  同じ形にしない。**

**候補抽出を2箇所に持たない。** 抽出（`extractFileCandidates` と3本の pattern）は planner の
ものを `orchestrate.mjs` から **import** する。planner が候補にしない citation は plan が
運んでいない citation なので、それを点検すると「計画された文書とは別の文書についての報告」に
なる。**移動はしていない** —— `firstNonEmptyLine` から `isSafeRepoPath` までのミラー領域は
byte 単位で不変で、`cmate-issue-authoring` の `mirror-conformance.mjs` が読む位置も
`^const NAME = ...;` の形も変わらない。追加したのは file 末尾の `export { … }` ブロックと、
`main()` を「このファイルが**プログラムであるとき**だけ実行する」ガードだけである
（import が run directory を書いてはならないため）。**plan の golden は 1 byte も変わらない。**

**`profile-init.mjs --check` に相乗りさせなかった理由**は、`--check` が
「**subprocess も network も使わない**」を性質として掲げている（第9.7節）ことである。
本 runner は `--ref` 指定時に `git show` を呼ぶので、相乗りは その性質を黙って変える。
後続の「宣言済み acceptance-gates の base 先行評価」（コマンド実行を伴う）も同じ runner に載る。

**境界を明示した。** 本文の**意味的な**矛盾（「決定事項 対 受入条件」など）は対象外で、
`cmate-issue-refinement` Step 4 の仕事である。報告する食い違いは**機械的な部分集合**だけ ——
同一 path に2つの行数主張、同一 `path:line` に2つの識別子。表記ゆれ（`web/src/lib/filter.ts` と
`src/lib/filter.ts`）の検出も既存の `ambiguous_file_candidate` に任せ、そう判定された候補は
**点検せず件数だけ名乗る**（どちらが対象かは著者しか決められない）。

実装で決めたことが2つある。**「N 行」の数え方を固定した** —— 末尾改行のある file は `wc -l` と
同じで、**末尾改行の無い最終行も1行として数える**（`wc -l` より1多い）。数え方が読み手ごとに
違う警告は、誰も対処できない警告である。**warning にしない verdict を2つ置いた** ——
照合できる識別子が同じ行に無い citation（`unchecked`）と、識別子が file 内に1度も現れない
citation（`identifier_absent`）。後者を「移動した」と呼ぶのは、その語がこの file の識別子だという
**前提そのものが測れていない**まま下す裁定である。

**exit code は本 Issue 本文の提案（`invalid_input` / exit 2）ではなく、package の既存語彙に
合わせた。** 本 package では `invalid_input` は 6 runner すべてで exit **3** であり、
**exit 2 は `not_implemented`** が既に取っている（codes-and-recovery 第1節）。SKILL.md 第4節は
準備 runner にも同じ規約（`invalid_input` 3 / `out_exists` 4 / `load_error` 6）を課しており、
`--repo-root` 不在を `load_error` / 6 とするのは `profile-init` の既存 fixture と同じである。
**受入条件が測っている性質（読めない入力は拒否し、点検結果を出さない）は fixture で固定してある。**

### #218 — 受入条件そのものが「着手前に落ちる」かを、誰も確かめていなかった

`cmate-worker-development` は実装に**二点測定**を課している（適合状態で緑・変異状態で赤。
`references/work-discipline.md` 規律2）。ところが**受入条件そのものには誰も同じことをしない。**
受入条件は「**着手前に落ち、着手後に通る**」ものでなければゲートとして働かないが、その性質は
dispatch まで一度も確かめられなかった —— dispatch は send 前に `require:` の id が worktree の
`.commandmate/verify.yaml` に**在ること**を確認するだけで、base で実行はしない。base 側で
コマンドを回す唯一の経路は非契約 fallback の `verifyWorker` で、これは worker 完了**後**である。

実測（CommandMate #1832 / Kewton/BorderFreeKidsMap）: オーケストレータが 1 日で機能しない
受入条件を3つ書き、いずれも dispatch まで誰も止めなかった。

| 書いた条件 | 実際 |
|---|---|
| 候補 2,000 件で 100ms 未満 | 着手前の O(n²) 実装でも 0.4ms。直しても直らなくても緑 |
| 出力の sha256 が着手前と一致 | 出力に `判定時刻 : <ISO8601>` を含み、実行のたびに必ず不一致 |
| `wc -l` が 860 以下 | 移せる量を測らずに決めた閾値で到達不能（993 行で着地） |

**どれも「着手前に1回（非決定性は2回）走らせる」だけで分かる。**

→ #217 の点検 runner に **mode を相乗り**させた（新設ではない）。`inspect.mjs --evaluate-gates`
は Issue が ```acceptance-gates ブロックで宣言した gate を base で `--repeat`（既定 2）回
先行実行し、`already_satisfied`（warning）/ `failing_at_base`（記録のみ）/
`nondeterministic`（warning）/ `not_evaluable`（**notice**）に分類する。正本は
[runner-operations.md](./runner-operations.md) 第16節、code は
[codes-and-recovery.md](./codes-and-recovery.md) 第6.3節である。

**4つ目の分類が本体である。** `not_evaluable` を置いたのは、**「測れなかった」を「通った」にも
「落ちた」にも丸めないため**だけである。id が verify.yaml に無い／built-in でコマンドが無い／
timeout／ブロックが読めない／`--repo-root` が base でない —— どれも受入条件についての所見では
ないので notice であり、`status` を動かさない（planner の `severity: notice`（#199）と同じ規約）。

**散文からは何も導出しない。** [acceptance-gates-notation.md](./acceptance-gates-notation.md)
第5節の拒否理由4点（引用≠指示・binary 集合が profile 依存・決定性・未承認ゲート）は覆していない
——**実行を伴う**この mode ではむしろ強く効く。散文から導出したコマンドを base で走らせるのは、
誰も承認していないコマンドを他人のリポジトリで実行することである。閾値を測らせたい条件は
`gates:` に `test $(wc -l < path) -le 860` と書く（同 notation 第5.1節に足し、
`cmate-issue-authoring` の手引き第8節にミラーした）。

**plan.json には1バイトも書かない。** plan の純関数性を壊すし、schema の `acceptance_criteria` は
`string[]` のままである。結果は点検 runner の artifact にだけ載る。

**parse を2つ持たない。** ブロックの読み取りは planner の `readIssueAcceptanceGates` を
`orchestrate.mjs` から import する（32 件上限も `issue-<番号>-` 接頭辞も同じ判定）。
`require:` の id を verify.yaml の command へ解決する reader は dispatch の
`readWorktreeGateIds` を `lib.mjs` の `readVerifyConfigGates` へ**そのまま移した**もので、
dispatch はその同じ関数を呼ぶ。**`ids` の順序も拒否メッセージも byte 単位で不変**であり、
dispatch case 109 本が非回帰を測っている。2つ目の reader は、inspect が
`gate_id_unresolved` と言う id を dispatch が平然と解決する状態を作れてしまう。

**汚れた tree では1回も実行しない。** `git status --porcelain` が空でなければ
`invalid_input`（**exit 3**）で拒否する —— 汚れた tree での実測は双方向に無意味である
（緑は誰かの未 commit の編集が緑なのかもしれない）。fixture はこの「実行しなかった」を
exit code ではなく **fake gate の呼び出し log が空であること**で測る。
exit code は #217 と同じ理由で本文の提案（exit 2）ではなく package の既存語彙（exit 3）に
合わせた。**exit 2 は `not_implemented` が取っている。**

**`--repeat` の既定を 2 にした。** 1 回では `nondeterministic` に到達できないからである。
`--repeat 1` は許すが、その run の `summary_markdown` は**到達できない分類がある**ことを
明記する（黙って「非決定性は無かった」に見せない）。timeout した回でその gate の repeat は
打ち切るが、**実行した回はすべて `runs[]` に残る**（中央値にも1回目にも丸めない）。

**判定順は verdict の反転が先である。** Issue 本文は `failing_at_base` を「全回 非 0」、
`nondeterministic` を「回ごとに exit code が違う」と定義していて、exit 1 → exit 2 の gate で
2つが重なる。反転（0 と非 0 の混在）を先に見て、残った「安定して落ちるが code が揺れる」も
`nondeterministic` と呼ぶ —— 1回目 127（binary 不在）で2回目 1 のコマンドは、著者が思っている
ものを測っていない。**本文の定義との差はこれ1点である。**

---

## observe（`scripts/observe.mjs`）

### #221 — 「merge 後の CI を N 回測る」段が無く、人間が手で測って測り方を間違えていた

受入条件には **worktree の中では測れないもの**がある。「merge 後の CI 3 run の wall-clock 中央値が
着手前より 1 分以上短い」「CI 5 run の e2e 時間が 30% 以上短く flaky 件数が +1 以内」。
`uat.mjs` は **worktree 内**で profile baseline を回す受入判定であり（`uat.mjs:22-24`）、
`merge.mjs --integration-verify` は merge 後 base 上で検証集合を **1 回**回す段である（#175 / #195）。
GitHub Actions の run 時間を N 回集める段は**どちらでもない**。結果、人間が手で測った。

実測（CommandMate #1835 / Kewton/BorderFreeKidsMap）で、測り方の誤りが3つ出た。

1. **最初の 2 本が外れ値だった。** merge 直後 3 run の中央値 446 秒を見て「未達」と報告し、
   run が溜まってから 8 run で測り直したら中央値 385.0 秒（−63.5 秒）で達成していた。
   **誤報告を撤回した。**
2. **run 全体に `setup-node` のばらつきが乗る**（38〜66 秒）。e2e 並列化の受入条件を run の
   wall-clock で読むと、条件が言っていないものを測ることになる。**step 単位で採る**には
   job step API が要る。
3. **5 run 目で初めて出た不良。** 1〜4 run 目は緑で、5 run 目で serve が 3 回死んで 28 分ハングした。
   **4 run では出ない。**

→ merge の後に、**profile が宣言した観測を N 回集めて report に残す read-only runner** を足した。

**裁定しない。** これが本 runner の中心にある固定事項である。実測3件目のとおり、**数字が揃っても
結論は割れる** —— 時間は線を超えていたが、5 run 目のハングを見て差し戻したのが正解だった。
だから report に verdict field は無く、`status` は**観測の完了度**（`success` = 全観測が `--runs` 件
揃った / `partial` = 揃わなかった・観測不能があった / `refused` = 1件も観測していない）だけを表す。
**`pass` / `fail` の語は出力に出さない** —— 唯一の例外が GitHub の `conclusion` の逐語転記で、
それは常に `conclusion` という名の key の下に在る（fixture の語彙検査はその位置だけを
**構造的に**除外して grep するので、runner が自分の散文に verdict を書けば赤くなる）。

**全 run を並べる。** `samples[]` は除外されたものも含めて1件ずつ在り、`summary_markdown` は
それを1行ずつの表に出す。実測1は**中央値をその系列なしで読んだ**ことで起きた。`--runs` に
**既定値を置かなかった**のも同じ理由である —— 3 と 8 で結論が逆になったのだから、何件に基づく
数字かは人間が決めて report に残すべき値である。

**除外は黙って落とさない。** `cancelled` / `in_progress` / 非 green の run は集計に入れないが
（終わっていない run・放棄された run はそれを測っていない）、`excluded[]` に
`{conclusion, count}` として必ず出る。`collected - counted` と `excluded` の合計は常に一致する。

**`mergedAt` / merge commit は `merge-report.json` に無い**（`pr_number` と `merged: bool` だけ）ので、
`gh pr view <n> --json mergedAt,mergeCommit` で取って**この report に記録する**。取れなければ
その Issue は `not_observable`（理由付き）で、**窓の始まりを推測しない** —— 捏造した始まりは、
その merge が起こしていない run をその merge に帰属させる。

**`uat.mjs` に混ぜていない**（Issue の固定事項）。uat は worktree、observe は merge 後 base である。
混ぜると「network に触る run と触らない run」が同じ phase になり、`status` が2つの意味を持つ。

**GitHub に書く初の経路**である。それまでの `gh` は `pr view` / `pr checks` / `pr merge` /
`issue view` だけで、SKILL.md 第1節は「Issue 本文の自動編集」をスコープ外としている。
**この runner はその線を動かさない** —— `--comment` は `--approve` 必須で、拒否は**入力を読む前・
最初の `gh` の前**に起き、書くのは `gh issue comment` だけである。投稿する byte は
`summary_markdown` と 1 byte も違わない（そのため summary はコメントの前に確定し、後に作り直さない)。

**実装で決めたことが3つある。**

**宣言の出どころは `plan` を既定にし、`--profile` を併設した。** Issue は「どちらを既定にするかは
実装者が決め、理由を書く」としていた。plan を既定にしたのは、dispatch が
`plan.profile.dispatch_defaults` を読み（#196）merge が `plan.profile.integration_baseline` を
読む（#195）のと同じ handoff だからである —— **走るものは承認された plan が凍結したもの**であり、
on-disk の profile を黙って優先すると同じ `run_id` の 2 回の observe が違うものを測れてしまう。
`--profile` を併設したのは、**merge 済みの wave は re-plan できない**からである（profile に
`observations` を足すと run_id が変わり、観測したい run はもう起きている）。使った run は
`observations_source: "profile_file"` と limitation で名乗るので、黙って別のものを測ることはない。

**正規化は `lib.mjs` に置いた。** planner と observe の両方が読む語彙だからである
（lib.mjs 冒頭の維持規則そのもの）。2つ持てば「宣言が何を意味するか」について2つの意見を持つことに
なり、その食い違いは黙って進む —— planner が拒否する profile を observe が受ける、またはその逆。

**refusal envelope の `status` は `failure` ではなく `refused` にした。** この document の status
語彙は collection について1つだけであり、「何も集めていない、理由はこれ」を、work についての
裁定と読める語を借りずに言う必要がある。`issues: null` が「見て何も無かった」と「見られなかった」を
分ける（`inspect.mjs` の `inspection: null` と同じ規律）。

**`status.mjs` の run view には載せていない**（Issue が「載せないなら contract に書く」とした側）。
observe の出力先は `--out` であって run directory とは限らず、status の phase モデルは
plan → dispatch → merge / uat である。ただし `NEXT_ACTION_HINTS` には新設10 code をすべて入れた ——
表に無い code は `UNKNOWN_CODE_HINT` に落ち、「まだ分類していない code」と「表示する場所が無い code」が
同じ形になるためである。

**SKILL.md への追記は 1 行に留め、差し引きで byte を減らした。** `scripts/validate.py:68` の
`SKILL_MD_MAX_SIZE` は 60,000 byte で、着手時点の SKILL.md は 59,894 byte（**残り 106 byte**）だった。
第3節に本 runner の節を足すと 1.5KB 程度になり、他の記述を削って場所を作ることになる ——
同 wave の別 PR も SKILL.md に触るので、**削って作った場所はそのまま rebase の衝突面になる。**
契約の正本は `references/observe-contract.md` なので、SKILL.md に置いたのは
**準備 runner の段落への一方向参照 1 行だけ**である。その 103 byte は、同じ場所で2つ削って作った ——
profile-init の `--emit` の挙動を述べた括弧書き（`profile-contract.md` 第2節の表と一対一の重複）と、
第3.6節の `（第9.1節）`（SKILL.md に第9節は無い。指しているのは `profile-contract.md` 第9.1節で、
同じ段落の下でリンク済みである）。結果 59,882 byte で、**着手前より 12 byte 小さい。**

---

## 設計（ADR のみ。実装は後続）

### #103 — 「ワーカーが Issue を受け取ってから何をするか」を持つ Skill が無かった

11 スキルは上流（Issue 起案・精錬・調査）・準備・実行制御・検証・後始末を覆うが、
**開発の方法だけが空白**だった。`buildContractGoal()` が渡すのは WHAT（Objective / 受入条件 /
変更してよいファイル）と制約で、**HOW（調査・計画・実装の作法）を渡していない**。
CommandMate リポジトリ内では `/pm-auto-issue2dev` が埋めているが、
**スラッシュコマンドはリポジトリスコープ**なので外部リポジトリでは `Unknown command` になる。

→ [adr-worker-development-skill.md](./adr-worker-development-skill.md) を書いた。中心の裁定は
**「このスキルが足すのは方法であって権限ではない。契約と食い違ったら契約が勝つ」**。
呼び出し口は契約 `goal` の `## Method` 節で skill を名指しする形とし、
**`buildWorkerPrompt`（契約非対応 CLI のフォールバック経路）にも同じ節を置く**
—— 片方だけだと `--contract-mode auto` の落ち先で方法論が黙って消える。
runner に方法論の要約を埋め込む案は、正本が2つになる・方法の更新に本 package の再リリースが
要る・委譲先の install を検査できない、の3点で却下した。実装は別 Issue。

### #115 — unattended の未決事項を測ったら、前提が2つ逆だった

[adr-unattended-mode.md](./adr-unattended-mode.md) 第13節の6点を実測し、第14節に記録した。
**4点で ADR の記述を訂正した。**

- **`gh` は対話に落ちない。** TTY が無いことを自分で判定して待たずに落ちる。無人運転を実際に
  止めるのは **`git push` の資格情報プロンプト**である。第6.3節に足すべき停止は無く、
  必要なのは job 定義側の環境変数だった。
- **契約の `autoYes: mode: off` は monitor を止めない。** サーバ側では確かに効くが、
  その事実が `capture --json` に出るのは Auto-Yes poller が回っているときだけで、poller は
  `autoYesState.enabled` が false なら起動しない。unattended は auto-yes を切るので
  poller が回らず、monitor は抑止を知らないまま Enter を送る。**`--no-auto-approve` は要件のまま**。
- **cron の再入は排他が要る**（同じ worktree に2つの supervisor が交互に `send` する状態を再現）。
- **uat の再merge は detached HEAD で「merged」と報告してどこにも残らない**（段階Cに pre-flight 検査）。

第14.7節に**測らなかったこと**を明記してある。

### #122 — 無人運転の停止は在ったが、二重起動と時計の穴が開いたままだった

[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測（ADR 第14節）が2つの穴を
確定させた。**`out_exists` は mutex ではない** —— pre-flight 実行中・`--out` が run ごとに変わる cron・
`--resume` の3経路では成立せず、700 ms ずらして起動した2本の run が同じ worktree に交互に `send` した。
そして **時計の上限が構造的に存在しない経路が在る** —— profile baseline と acceptance コマンドは
`timeout` 無しで実行されるので、`--wait-timeout` はその時間に一切効かない。

→ 段階 A（dispatch のみ）を実装した。`--unattended` は**締め付けだけ**を含意する:
`--contract-mode require`、pre-flight での全 Issue scope 検査（`--out` 未消費・all-or-nothing）、
**worktree 単位の排他 lock**（`mkdirSync` の EEXIST に依る。`kill -9` された run の lock は
死んだ pid を見て回収する）、**`--wall-clock-budget` の明示必須**（残り budget は子プロセスすべての
timeout でもあるので、timeout を持たない baseline も打ち切れる）、`unattended_baseline` の記録。
緩和フラグとの併用は `invalid_input`。**`stop_reason` の enum にも field にも1つも足していない**
（打ち切りは既存の `timeout` を再利用し、事実は `limitations` / `blocking_reasons` の自由文字列で運ぶ）。
`--unattended` を渡さない run が 1 bit も変わらないことは、**同じ世界を2回 dispatch して
report を突き合わせる fixture**で機械的に固定してある。実装で形が変わった点は
[adr-unattended-mode.md](./adr-unattended-mode.md) 第15節にある。

### #121 — 回復経路は在ったが、「終わっている worker をもう一度走らせる」しか無かった

[#89](https://github.com/Kewton/commandmate-skills/issues/89) の中心的な被害（検証に通った成果物が
納品経路から外れる）は `--resume`（#98）で塞がった。残っていたのは**手段**である。`wait --verify` が
timeout すると裁定が `not_run` のまま report に凍り、worker がその後に完走して commit しても report は
更新されない。この状態で古いのは**裁定だけ**で、**作業は既に終わって worktree に在る**。それでも
`--resume` は再 dispatch する —— worker のターンを1つ消費し、終わっていると分かっている worker に
契約を再送するので、不要な差分が生まれる余地も残った。

→ `--reverify <前回の --out>` を足した。`send` を1回も呼ばず、worktree の現状を verification gate に
かけ直して report を更新する。裁定は契約経路なら `commandmate verify <worktree-id> --json` の
exit code、契約非対応なら profile baseline の再実行 —— **どちらも既に在る CLI 表面**で、新しいものは
1つも要求していない。

裁定:

- **「作業が在る」を推測しない。** 対象を選ぶ基準は work-evidence ゲートと**同じ2つの事実**
  （work ブランチの commit / worktree の未 commit の変更）で、`git rev-list --count <base>..HEAD` と
  `git status --porcelain` で**判定の前に**測る。前回 report の `worker_state` からは読み取れない ——
  timeout した record は `verification.outcome: not_run` であって、測定結果を1つも持っていない。
  「timeout だから多分作業は在る」は、Issue が名指しで禁じた推測である。
- **測定を `commandmate verify` に委譲しない。** 委譲すると答えが**裁定**として返る: exit 21 は
  `fail` なので（この意味は変えない）、誰も作業していない Issue の record を**格下げ**することになる。
  しかもその格下げは、この flag が避けるために存在する「余計な実行」の産物である。裁定規則を
  1つも変えずに済ませる唯一の方法が「訊かないこと」だった。フォールバック経路の judge（profile
  baseline）が work-evidence を測らないことも、基準を judge の外に置くべき理由になった。
- **完了の定義は変えない。** `completed` に上がるのは work ブランチに commit が在るときだけである。
  未 commit の作業しか無い Issue は納品できず、この経路は commit を要求できない（要求は send である）。
- **無人運転の排他 lock は取る。** 送らないので worker は起動しない —— それでも取るのは、
  `commandmate verify` が **worktree の中でリポジトリのゲートを実行する**からであり、その裁定が
  **merge が eligible として読む report** に書き込まれるからである。別の run の worker が書き換えて
  いる最中の木を裁定すると、誰も納品していない状態についての合格を作って、そのまま届けてしまう。
  lock の粒度が「1 worktree に supervisor は1人」なのはこの harm のためで、「読むだけだが裁定する者」
  はその内側にいる。
- **`--resume` との併用は拒否する。** 両者は引き継がなかった Issue に対する**正反対の答え**である。
  両方受け付けると runner が片方を推測することになり、外せば worker のターンを無駄にするか、
  終わっていない作業を放置するかのどちらかになる。
- **artifact の作法・整合性ガードは `--resume` と同一で、code も共有する。** ディレクトリ名を
  `reverify-attempt-` にしなかったのは、`status.mjs` の走査順と、両者を混ぜたときの attempt 番号の
  連続性が1つの命名規約に依っているからである。`dispatch_schema_version` は 1 のまま、
  `stop_reason` の enum にも値を足していない（#93 / #95 / #103 / #122 と同じ裁定）。

fixture は `sent: []`（1件も送っていない）と `verify` の呼び先（引き継ぎ分には飛ばない・作業証跡が
無い Issue にも飛ばない）を両方固定する。正本: [dispatch-contract.md](./dispatch-contract.md) 第8.5節。

---

## パッケージ

### 0.37.0 — 止めて報告した返答を、Claude 以外のワーカーからも読めるようにした（#296）

- **#296** —— 0.35.0（#287）の「止めて報告」の返答は Claude Code の転写からしか読めず、Command Code などのワーカーは
  報告しても `--max-turns` まで nudge されていた。CLI が `commandmate reply`（CommandMate 0.43.0+）を持つときは、
  nudge を送った時刻を `--since` にしてそれで読む（`worker_report.source` は `commandmate_reply`）。有無は `reply --help` を
  1 回だけ確かめ、無い CLI では従来の Claude 専用の転写読みに戻る。`reply: null`・exit 非 0・JSON 不正は報告無しとして従来どおり扱う。

### 0.36.0 — `--reverify` の検証を直列にでき、OpenCode V2 を互換に載せた（#274 / #275）

- **#274** —— `--reverify` に `--verify-concurrency <n>` を足した。重いゲートを並べると負荷で実行時間依存のテストが落ち、
  1 件ずつなら通る Issue が `verification_failed` になっていた。run の引数であって plan の値ではないので、run id の hash にも
  `--reverify` の突き合わせにも入れない。フラグ無しは従来どおり全件同時で、report は byte 一致。
- **#275** —— `compatibility.agents` に `opencode-v2: native`（CommandMate#2975 の実測: opencode2 2.0.18 の `GET /api/skill` での発見と
  `/<name>` での呼び出し）を足した。この package 単体では測っていない。同じ理由で全 package の版を patch で上げている。

### 0.35.0 — 人がやる Issue と、止まって返したワーカーを runner が扱えるようにした（#286 / #287 / #288）

0.34.0 で利用側の要望に応えた nudge（「書けないと分かったら止めて報告」）と、cmate-issue-authoring 0.10.0 の
`human-only` ラベルを、runner の側で受け止める版である。各件の経緯は本文の planner / dispatch / uat の節に在る。

- **#286** —— `labels` に `human-only` を持つ Issue を、planner は plan に残したまま wave / merge_order から外し
  （`dispatch_excluded: "human_only"`、notice `human_only_excluded`）、dispatch は worker を送らずに report へ
  `not_dispatched` として残す。human-only の Issue への依存は待たず、plan の blocking と report の limitation
  `human_only_dependency` で名指す。全 Issue が human-only の plan は `plan_invalid`。
- **#287** —— nudge で開いたターンが進捗なしで終わり、ワーカーの返答があるとき、nudge を止めて返答を
  `worker_report` に残し、blocking `worker_stopped_with_report` を出す。**この版では Claude のワーカーだけ**
  （返答を転写から読むため）。Command Code などへの拡張は #296 で入れた（上流 CommandMate#3039、`commandmate reply`）。
- **#288** —— uat の修正ループの nudge にも「止めて報告」の 1 文を足し、profile の `worker_messages.fix_nudge` と
  `uat --fix-nudge-message` で追記できるようにした。planner と dispatch も `fix_nudge` を受理する。

**破壊的変更は無い。** schema の版は据え置きで、足したのは optional な field・code だけである。`human-only`
ラベルも `fix_nudge` も持たない plan / report は byte 一致。

### 0.34.0 — 利用側の並列開発で「運用で補っていた」箇所を runner に入れた（CommandMate #3002〜#3009、#272 / #273）

**この版の 9 件は、すべて利用側（Kewton/Musunest の M1.4〜M1.6）の実測から来ている。** 利用側は手順書に
「地の文にパスを書かない」「nudge に一文添える」「`--resume` で送り直す」などの運用を積み上げていた。
その運用を runner の側へ移した。各件の経緯は本文の runner 別の節（planner / dispatch / merge）に在る。

**planner**

- **#3002（+ #273）** —— 成果物見出しを持つ Issue では、見出しの外（散文・`## 完了条件`・`## やること`・
  `## 追記`）にだけ書いたパスを scope に入れず `reference_files` へ回し、Issue ごとに 1 件の notice
  `prose_path_ignored` で名指す。**「変えるな」と書いたファイルほど scope に入っていた**のを止める。
  成果物見出しの範囲は下位の `###` で切らない（#273）。「外」「以外」「しない」で終わる見出しは成果物見出しにしない。
- **#3003（+ #272）** —— 成果物見出しの下では、backtick で囲んだファイル名を拡張子によらず拾う
  （`expression.ebnf`・`Cargo.lock`・`Makefile`）。profile の欄にはしなかった（起票時の検査と食い違うため）。
- **#3004** —— 契約 goal の `## Files you may change` には宣言したファイルだけを並べ、導出したテスト候補は
  本数で述べる。plan は宣言と導出の本数を分けて出す。`scope.allow` と L1 の導出は変えていない（ADR §15.2 は不変）。

**dispatch**

- **#3006** —— 起動中（503 `SESSION_STARTING`）または `prompt not ready` で断られた最初の send を、
  間を置いて 1 回だけ送り直す（limitation `send_retried_not_ready`）。exit 2 と 409 は送り直さない。
- **#3007** —— 最初の send の前に capture を読み、前の回の質問画面が残っていれば送らずに止める
  （blocking `stale_prompt_on_session`）。`--interrupt-stale-prompt` で畳んでから送れる（既定 off、質問には答えない）。
- **#3008** —— `--only <issues>` で plan の一部だけを dispatch する。選外の Issue に依存する Issue は
  `--out` を作る前に `invalid_input` で断る。`--resume` は選んだ集合を引き継ぐ。
- **#3009** —— 監督 nudge の既定文に「指示どおりに書けないと分かったら、進めずに止めて報告してください。」を足し、
  profile の `worker_messages.nudge` と `--nudge-message` で後ろに追記できるようにした。

**merge**

- **#3005** —— `--create-prs` に profile の `pr_title_template` を足した（type / scope はブランチのコミット件名から。
  決まらなければその PR を作らない）。ワーカーのコミット本文の申告行を PR 本文の「## ワーカーの申告」へ写す。
  ワーカーは push も PR も作らない既定のまま。

**破壊的変更は無い。** schema の版はすべて据え置きで、足したのは optional な field・enum 値・code だけである。
成果物見出しを持つ Issue の scope が狭くなるのは #3002 の狙いどおりの挙動変更で、見出しの無い Issue の plan は不変。

### 0.32.0 — 一本道の前と後ろに、測るだけの段が付いた（#217 / #218 / #219 / #220 / #221 / #222 / #223 / #224）

**この版が足したのは plan → dispatch → merge → uat の「外側」である。** 0.31.0 までの runner は、
Issue 本文が主張する事実も、受入条件そのものが着手前に落ちるかも、merge 後にしか測れない条件も、
**一度も測らないまま通していた**。0.32.0 は前後に段を足した —— どちらも**裁定しない**。
各件の経緯は本文の runner 別の節（inspect / observe / dispatch / merge / planner）に在る。

**着手前**（`scripts/inspect.mjs`）

- `--check-references`（#217）—— Issue 本文の `path:line` と行数の主張を base の tree に
  突き合わせる。planner が対象リポジトリを開かないという不変条件（profile-contract 第9.1節）は
  変えていない。**その不変条件が残す穴を、別の段で塞いだ**のがこの mode である。
- `--evaluate-gates`（#218）—— 宣言済みの受入ゲートを base で `--repeat`（既定 2）回先行実行し、
  `already_satisfied` / `failing_at_base` / `nondeterministic` / `not_evaluable` に 4 分類する。
  **4 つ目が本体である**: 「測れなかった」を「通った」にも「落ちた」にも丸めない。`not_evaluable` は
  notice なので status を動かさない（#199 の severity 規約と同じ）。exit は常に 0 で、
  **plan.json には 1 バイトも書かない。**

**merge 後**（`scripts/observe.mjs`。新 runner）

- #221 —— profile が `observations` に宣言した測定を merged base で N 回集め、**見た値を全部**
  report に書く。**裁定しない** —— verdict field も閾値も無く、`status` は「宣言された回数を
  採り切れたか」だけを述べる。worktree の中では原理的に測れない受入条件（「merge 後の CI 3 run の
  wall-clock 中央値」）に、測り方の正本を与えるための段である。`observe-report.v1.json` を新設した。

**残る 4 件は「読めているのに使えない」「読めているのに名指しできない」の系統である。**

- **#219** —— planner が glob（`*` / `**` / `?` / `{a,b}`）と末尾スラッシュのディレクトリを
  **成果物見出しの配下でだけ**抽出するようになり、scope の重なり判定を上流の scope ゲート
  （`src/lib/verification/scope-gate.ts` の `globToRegExp`）から移植した述語に揃えた。契約も上流も
  CommandMate #1546 以来 glob を受け取れたのに、**Issue 本文からそれを書く方法だけが無かった** ——
  backtick の中だけが偶然通る、テストも文書も無い経路が唯一の抜け道だった。merge の PR 本文が出す
  scope 対比も同じ述語になり、`sharedFiles` と `waves_conflict_free` も揃えた。
- **#220** —— `--max-turns` 到達（exit 21 の連続）を `worker_turn_evidence` として
  `worker_upstream_unavailable` / `worker_produced_nothing` / `worker_output_unreadable` の 3 つに
  分ける。**同じ exit code に、次の一手が正反対の 3 状態が畳まれていた**（待つ / Issue を割る /
  手で確かめる）。
- **#222** —— merge run の前後で呼び出し元 worktree の `index.lock` を検査し、limitations と
  report に記録する。**削除はしない。** 危険なのは lock そのものではなく、成功した run の直後に
  それが「merge が壊れた」と読めることである。真因はこの runner には無い（`git worktree add
  --detach` は #175 で既に実装である）ので、runner が言えるのは**観測した事実だけ**である。
- **#223 / #224** —— 上流 CommandMate #1771（gate 単位の `mutex` と worktree ごとの env 注入）と
  #1772（FLAKY を一級の outcome にする）を、**GATE 行を読む側**として同じ意味で受け取る。語彙を
  `lib.mjs` に集約し（`GATE_LINE_RE` / `parseGateLine` / `isFlakyVerdict`）、`flaky` は第 3 の
  verdict として**転記する** —— pass にも fail にも丸めない。planner は `mutex` / `retryOnFail` /
  `flakyIsPass` を宣言した ```acceptance-gates ブロックを受理し、dispatch は**宣言されたときだけ**
  契約に書く。同じ移植の実行側は `cmate-verify` 0.5.0 / `cmate-verify-advisor` 0.3.0 である。

**破壊的変更は無い。** `plan_schema_version`（2）/ `dispatch_schema_version`（1）/
`merge_schema_version`（1）はすべて据え置きで、増えたのは additive な field と enum 値
（dispatch report の verdict に `flaky`、execution-plan v2 の gate 定義に 3 field、
`worker_turn_evidence`）だけである —— dispatch-contract.md 第7節が additive と分類する範囲に
収まっている。**宣言を持たない Issue の plan は byte 不変**で、新しい段はどれも既存の経路を
呼び出さない限り走らない。

### 0.31.0 — Issue が定義した受入ゲートを、`.commandmate/verify.yaml` を 1 バイトも書かずに運ぶ（#125）

**「読めているのに強制できない」記法が、1つだけ残っていた**（#125 / PR #215）。```acceptance-gates
ブロックの `gates:`（新規コマンドゲートの**定義**）は #114（0.19.0）以来「記法としては予約済み・
planner が `acceptance_gate_block_unsupported` で停止」だった。停止は既定として正しい —— 読めた宣言を
黙って捨てれば、著者が書いた受入条件が消えた run が緑で終わる。だが停止は答えではない。裁定に入れ
られるのは `require:` に書ける**既存**ゲートだけで、「この Issue でだけ測りたい新しい条件」はブロックの
外の散文に落ち、誰も測らないまま残っていた。

**当初の設計は採らなかった。** [ADR](./adr-issue-acceptance-gates.md) 第3.5節は「dispatch が worktree の
`.commandmate/verify.yaml` に未 commit で追記し、裁定後に SHA-256 を突き合わせて改竄を検出する」経路を
前提に、上流へ「work-evidence の除外を 1 path 広げてほしい」を出す想定だった。**その見積もりが誤って
いた** —— 上流のソース（`src/lib/verification/scope-gate.ts`）に理由が書いてある。`.commandmate/tasks/**`
を除外できるのは契約が送信時に `tasks.contract_json` へ snapshot されるからであり、
`.commandmate/verify.yaml` には snapshot が無く**毎ラン読み直される**。変更集合に残っていること自体が
「エージェントが自分を裁くゲートを弱めた」ことの**検出面**である。「1 path 広げるだけ」の依頼は、実際
には snapshot 機構の新設を要求していた。

そこで上流に設計相談 CommandMate #1756 を起こし、**案 B ——「そもそも verify.yaml を書き換えない」**が
採られた（CommandMate #1791 / PR #1793）。実行契約の `verify` が**ゲート定義そのもの**を運ぶ
（`gateDefinitions`。`{id, command, timeoutSec}` の list、最大 32 件）。契約は既に snapshot され変更集合
からも除外済みなので、**新しい改竄面が 1 つも増えない**。ADR 第3.5節の前提 (1)(2)(4) は消滅し、(2') は
「除外を広げる」ではなく「追記をやめる」で解決した —— **除外は 1 バイトも広がっていない**（第3.5.1節に
読み替え表を足した。第10節・第11節の当時の測定は取り消していない。**その測定こそが #1756 を起こす根拠
だった**）。

したがって **この runner は `.commandmate/verify.yaml` を 1 バイトも書かない。** 実装にもテストにも書き
込み経路が無く、dispatch case が worktree の verify.yaml を byte 単位で不変と assert する。

planner はブロックを**構文と Issue 番号スコープだけ**読み、`plan.issues[].acceptance_gates.gates` に
**著者の順のまま**載せる。`timeoutSec` は**著者が書いたときだけ**載り、書かなければ契約でも黙る ——
CommandMate 自身の既定（600 秒）が効き、runner が発明した数が混ざらない。定義 id が
`issue-<番号>-<何を測るか>` で始まることは**確かめるだけで、書き換えない** —— 書き換えは
[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第2節が禁じる再エンコードであり、Issue に
書いた id と report に出る id が違う状態を作る。予約 id・command 無し・timeout 範囲外・重複・32 件超は
`acceptance_gate_block_invalid` である。**上限超過は 32 件に丸めず、拒否して件数を名乗る**（黙って 1 件
落として dispatch するのは、この機能が消しに来た失敗そのものである）。

dispatch は定義を契約の `verify.gateDefinitions` に書く。`verify.gates` を出力する経路では**定義 id を
`gates` にも必ず列挙する** —— 上流は「定義したのに誰も走らせない」を契約エラーにするし、契約が唯一の
宣言元なので選ばれなければ**永久に走らない**。goal には **id だけでなく command も**書く（契約にしか
存在しないゲートは worktree のどこを探しても見つからず、id だけ渡された worker は何が走るのか判定でき
ない）。定義ゲートの `verification.gates[].origin` は `issue` である —— 契約以外にそれを知っている場所が
無い以上、定義ゲートは定義上 issue 由来である。

**衝突は runner が先に止める。** 定義 id が worktree の `.commandmate/verify.yaml` の既存 id と衝突する
と、新 code `acceptance_gate_id_conflict` が **`send` の前に**その Issue を止める。契約は**足せるだけで
上書きできない**（上流の裁定）—— 同じ id を契約が再定義できると、リポジトリ自身が宣言した「合格の定義」
を委任単位で差し替えられ、しかも report 上は同じ id なので**差し替えたことが読み取れない**。上流は同じ
契約を送信時 exit 2 で拒否するので、これは**そこへ到達させないための停止**である: 走ってすらいない
worker を「契約が不正だった」と報告するより解ける（`acceptance_gate_id_unknown` と同じ理由である）。

**`acceptance_gate_block_unsupported` は planner からは出なくなった。** 記法違反は
`acceptance_gate_block_invalid` に一本化し、台帳（[codes-and-recovery.md](./codes-and-recovery.md) 第2節）
からは外して**廃止 note として意味だけ残した** —— 古い plan に在れば「その run の runner は `gates:` を
実行できなかった」という意味である。#210（0.30.0）が入れた「新設 code は severity を分類してから足す」の
反対側、**出なくなった code の畳み方**である。停止そのものが消えたのではない: 読めない `gates:` ブロックは
今も止まるし、実行契約の無い run（`--contract-mode off`、契約非対応 CLI への fallback）で `gates:` を宣言
した Issue も `acceptance_gates_not_enforceable` で止まる。この code と `acceptance_gate_id_unknown` は
**#125 以前から dispatch に在ったのに台帳に無かった**ので、`acceptance_gate_id_conflict` と併せて第3節へ
載せた（#210 の棚卸しが `plan.warnings` について見つけた欠落と、同じ形の欠落である）。

merge の段階 C（`--merge-prs` の無人 merge）は、**`gates:` だけのブロックも declaration として読む** ——
既存ゲートを選ぶより、**新しい条件を書くほうが弱い宣言ではない**。

**宣言の無い Issue は byte 不変である。** `gates` キーは定義が無いとき**空 list ではなく不在**なので、
`require:` だけの Issue が出す plan は key が存在しなかった頃と同じ byte になり、ブロックを持たない Issue の
goal も従来どおりである。`plan_schema_version`（2）・`dispatch_schema_version`・`merge_schema_version` は
すべて据え置きで、**破壊的変更は無い**。

**生産側 2 package（`cmate-issue-authoring` / `cmate-issue-refinement`）はまだ `gates:` を出さない**
（今回は据え置き。ミラーは後続 Issue である）。consumer が読めることと producer が書けることは別に進む ——
producer が `gates:` を `acceptance_gate_block_unsupported` で拒否し続けるのは「**自分が出せない記法を
出さない**」という producer 側の判断であって、consumer の状態を述べたものではない。conformance テスト
（`tests/fixtures/cmate-issue-authoring/acceptance-gates-conformance.mjs`）は、この乖離を `PRODUCER_LAG` の
patch 列として書き下し、**patch を当てた結果が mirror と byte 一致する**ことを要求する形に変えた（共有部分は
今も byte 固定である）。乖離が 1 件の明示的な差として固定されているので、producer が追いつく Issue はそこを
見ればよい。

fixture は plan case 30（受理）/ 84（6 通りの拒否）、dispatch case d94〜d98、段階 C の `gates:`-only case を
足した。**13 通りの変異で空振りでないことを実測**し、`tests/fixtures/cmate-orchestrate/README.md` に表として
記録してある。

### 0.30.0 — 壊れた fixture から黙って部分集合を作らず、warning の severity に台帳を持たせる（#208 / #210）

**offline fixture の読めない要素が、黙って捨てられていた**（#208）。`--issue-json` の loader
（`loadIssuesFromFixture()`）には黙る挙動が3つあった —— object でない要素と `number` が読めない
要素は `continue` で捨てられ、同一 `number` は `Map.set` の後勝ちで**先行の本文が消える**。さらに
読み口が `Number.parseInt` で、これは数ではなく**数の PREFIX** を読む: `"123abc"` は 123 に、
`"12.9"` は 12 になる。つまり読めない要素は捨てられるだけでなく**別の番号として読まれうる** ——
書き間違いが落ちるのではなく、**別の Issue が計画される**。0.29.0（#200）はこの挙動を
plan-contract 第1.1節に仕様として書いたうえで、締めるかどうかを別 Issue へ切り出していた。
本 release がそれである。

fixture は plan の**入力そのもの**であり、壊れた入力から黙って部分集合を作った plan は
「測っていない Issue を測ったことにして緑で終わる」—— [plan-contract.md](./plan-contract.md)
第5節が他の構成要素について既に拒否している性質である。全要素を読んでから使うようにし、読めない
要素（非 object / `number` 不在 / 整数として読めない `number` / 同一 `number` の重複）はすべて
`load_error` / exit 6 にした。整数判定は `Number.isSafeInteger` と「整数だけからなる文字列」に
限る。message は**どの要素（0 始まりの index）が・なぜ**読めないかを名指しし、`"12"` と `"12.9"` を
一目で見分けられるよう読めなかった値そのものを引用する。読めない要素が先に拒否されるので、
`fixture does not contain issues:` は**文字どおり不在だけ**を意味するようになり、その message は
fixture が宣言している番号も併せて出す（従来はこれが唯一の観測点で、**FILE が壊れているときに
読み手を REQUEST の側へ送っていた**）。

**正常な fixture の plan は 1 byte も変わらない。** 既存 plan case のうち成功する 59 件について、
#208 以前の runner と本 release の runner が書く `plan.json` は byte 一致する（差 0 件）。新規
case 78–82 は #208 以前の runner では 5 件とも exit 0 で plan が出ていた ——
**拒否されるようになるのは意図した破壊**である。

**warning の severity に、判断理由つきの台帳ができた**（#210）。#199（0.29.0）は severity の
仕組みだけを入れて notice 集合を `{harness_path_in_scope}` の1件に固定し、個別の分類を別 Issue へ
送った。結果として「**検討して blocking に決めた code**」と「**まだ誰も検討していない code**」が
`severity` 無しの同じ形で並んでいた —— #199 が `status` について消しに来た「2つの違う状態が同じ色で
出る」の、分類台帳版である。`plan.warnings` の合流点5系統（profile 由来 / 抽出 / 契約 scope /
open question / 依存）を1つずつ辿って**到達しうる warning code を 16 件に確定**し、
[codes-and-recovery.md](./codes-and-recovery.md) 第2節を severity 列つきの表に置き換えた。
**blocking の行にも「blocking が正しい」と理由が書いてある** —— 無言の既定と、検討した結果としての
blocking は違う。棚卸しは台帳の欠落も2件見つけた（`acceptance_gate_block_invalid` /
`acceptance_gate_block_unsupported`。どちらも `plan.warnings` に出て `status` を落とすのに表に
無かった）。以後**新設 warning code は severity を分類してから足す** —— 規約を
codes-and-recovery.md 冒頭に、規範を plan-contract 第5.6節に置いた。

**`profile_repository_override` が notice へ移る**（#210。1 code = 1 判断であり、まとめて動かして
いない）。この code は `--repo <other>`（差し替え。これが `verified` を降格させる）と
`--allow-unverified`（降格の受諾。**無ければ run は `unverified_profile` で exit 3 する**）の
**2つの明示 flag が揃わないと出ない**ので、operator が既に決めて run の command line に記録した
事実の報告である。分類原理どおりだから移したのではない —— **blocking 側が2つの実測で壊れていた**。
同じ受諾を `--profile-json <verified: false> --allow-unverified` と綴ると warning 1件も無しの
`success` で返り（case 08。risk は同じく high）、`profile_repository_mismatch` の対処表が指示する
`--repo` を選ぶと**表のとおりに直したのに `partial` のまま**だった —— #177 が denied 側について
言った「正しい書き方に対して `partial` を出す warning は、読み手に読み飛ばし方を教える」の、
operator 側から到達した同じ失敗である。**落としたのは色だけである** —— `profile.verified` は
`false` のまま、`risk.factors` の `unverified_profile`（high）と `risk.level: high` もそのまま
plan に載り、warning 自身も detail ごと `plan.warnings` に残る。`success` は「読まなくてよい」では
ない。

**破壊的変更は無い。** `plan_schema_version` / `dispatch_schema_version` / `merge_schema_version` は
すべて据え置きで、`stop_reason` / `worker_state` / `completion_check[].id` の enum にも値を1つも
足していない。schema に触れたのは `warnings[].severity` の description（notice 集合が2件になった）
だけである。**notice を含まない plan は byte 不変**で、#199 の byte 規律（`severity` を emit するのは
notice の entry にだけ）もそのままである。fixture は case 14 を `success` + `severity: notice` へ
更新し、case 83 で **notice と blocking が同居したとき `status` が blocking 側に決まる**ことを
固定した（両方向の測定である）。

**止まり方が2つ変わる。** 読めない要素を持つ fixture は plan が出なくなり（#208。`load_error` /
exit 6）、`--repo` + `--allow-unverified` の run は `partial` ではなく `success` になる（#210）。

同時に **cmate-issue-authoring が 0.8.0** に上がる（#209）。0.28.0 の #178 で入った ```open-questions
記法の生産側は、refinement（#198 / 0.29.0 と同時）に続いて**起案側も着地した** —— authoring が
起案する Issue **本文そのもの**にブロックを埋めるようになり、「問いを出す → 本文へ残す →
**決めたら消して re-plan**」の線に手作業が1つも残らなくなった（ブロックは計画の `open_questions[]`
から renderer が組むので、写す step が存在しない）。記法の正本は
[open-questions-notation.md](./open-questions-notation.md) のままである。**#209 が
orchestrate 側に加えた変更は同文書だけ**で（「生産側へのミラーは後続 Issue である」を着地後の記述へ
更新し、実装表に生産側2つを足した）、runner には触れていない。

### 0.29.0 — リポジトリの事情を profile が全部宣言でき、宣言が効いているか確かめられる（#195 / #196 / #197 / #199 / #200）

**目的の違う 2 つの検証集合が、1 つの key を共有していた**（#195）。`--integration-verify`（#175）が
回すのは profile の `baseline` だが、`baseline` は各 worker が worktree で回す proportional な
健全性確認であり、統合検証は「**合流後の統合ブランチが green か**」である。#175 の fail-closed は
埋め忘れ（未宣言）しか捕まえられず、**目的の違う `baseline` が宣言されている状態**は
`outcome: "pass"` を返す。実測（Kewton/BorderFreeKidsMap）ではこのリポジトリの `baseline` に
`unit` が無いため、**#175 を起票させた当の #105 × #106 が `--integration-verify` を付けたまま
すり抜ける** —— この機能が消しに来た当の事象である。任意 field `integration_baseline` で分離し、
採った側を `integration_verify.source` に記録する。

残る 4 件は 3 つの塊になる。

**1. profile が、リポジトリの事情を全部宣言できる（#196 と #195 の planner 側）。** #180 で入った
`dispatch_defaults` は **dispatch 側だけの着地**で、宣言を書いた profile は plan 段階を
`load_error`（exit 6）で通らなかった —— この field が runner に届く道は「手で patch した plan」
しか無く、`--auto-yes` / `--wait-timeout` の置き場は人間の記憶と CLAUDE.md のままだった。planner 側
（`PROFILE_FIELDS` と `publicProfile()` の echo）を着地させ、#195 の `integration_baseline` は
**両側同時**に入れた ——「**読む側だけ先に着地する**」非対称を繰り返さない。

**2. 宣言が効いているかを、plan を回す前に確かめられる（#197）。** 構文として正しく、
**何にも一致しない** `scope_companions` 規則は誰も検出できなかった（`scripts/{base}.mjs` と
`scripts/{dir}{base}.mjs` はどちらも合法で、`scripts/adapters/human-review.mjs` に届くのは後者
だけである）。read-only の `profile-init --check` が規則ごとに一致件数を出す。**裁定はしない** ——
0 件一致は warning であって error ではない。マッチングの意味論を 2 箇所に持たないため、規則評価を
`lib.mjs` へ抽出し、planner と `--check` が同じ関数を呼ぶ。

**3. 「名乗る」と「止める」を分け、入口を文書化した（#199 / #200）。** #177 の唯一の出口
（ハーネス path の明示宣言）を通ると run 全体が `partial` に落ちており、ハーネスを in-repo で
保守するリポジトリでは**検証ゲートを足すのが定常作業**なので `partial` が常態になっていた ——
#177 自身が除外側について同じ力学（読み手に読み飛ばし方を教える）を論拠にしている。
`plan.warnings[]` に `severity` を足し、`status` を落とすのは blocking だけにした。そして
`--issue-json` の fixture 形式は **runner を読まないと分からない**状態だった —— 0.28.0 が増やした
3 経路（#177 / #178 / #182）の正しい対処が「本文を直して re-plan」である以上、これは
**推奨した対処法の入り口が塞がっている**状態であり、plan-contract 第1.1節に書いた（#200）。

**破壊的変更は無い。** `plan_schema_version` / `dispatch_schema_version` / `merge_schema_version` は
すべて据え置きで、`stop_reason` / `worker_state` / `completion_check[].id` の enum にも値を 1 つも
足していない。plan 側に足した field（`warnings[].severity` / `profile.dispatch_defaults` /
`profile.integration_baseline`）は**すべて schema 上 optional** で、0.28.0 以前が書いた plan は今も
valid であり、`status.mjs` は過去 run を読み続けられる。required にしたのは
`integration_verify.source` の 1 つだけだが、**この object は `--integration-verify` を渡した run に
しか存在しない** —— 判断は [merge-contract.md](./merge-contract.md) 第10節に #175 の先例と並べて
書いてある。

**宣言しない profile の plan / report は 1 byte も変わらない。** 条件付き echo の追加順は
`scope_companions` → `dispatch_defaults` → `integration_baseline` に固定してあり（**順序が plan の
バイト列を決める**）、`severity` は **notice の entry にだけ** emit する（`blocking` を綴ると notice を
含まないすべての plan が動く）。#197 の `lib.mjs` 抽出が純粋であることは、**全文 golden 9 本を含む
全 plan case の plan が 1 byte も変わらない**ことで示した。`m22`（merge）と `d87`（dispatch）は
0.28.0 と同じく、**その機能が入る前の runner が書いた** golden を byte 比較する非回帰の測定として
残っている。

**止まり方が 2 つ変わる。** ハーネス path を**明示宣言した** plan は `partial` ではなく `success` に
なる（#199。`harness_path_in_scope` は `plan.warnings` に残り続け、`codes-and-recovery.md` の対処表にも
載り続けるので、「名乗る」は失われていない）。逆に `"integration_baseline": []` を宣言して
`--integration-verify` を渡すと、`baseline` の有無に関わらず `preflight_failed` / exit 1 で
**1 件も merge せずに止まる**（#195）—— 空配列は「統合検証の定義は無い」という宣言であり、目的の違う
集合へ黙って落ちるのは本件の論旨そのものに反する。あわせて、`dispatch_defaults` /
`integration_baseline` を書いた profile が **`load_error` で拒否されなくなる**のもこの release からで
ある。

同時に **cmate-issue-refinement が 0.4.0** に上がる（#198）。0.28.0 の #178 で入った ```open-questions
記法には**読む側しか無かった** —— refinement が blocking な open question をそのまま貼れるブロックと
して出すようになり、「問いを出す → 本文へ残す → **決めたら消して re-plan**」の線が両端で繋がる。
生成規則はリポジトリ層の conformance テストが**実物の planner に食わせて**固定しており、
refinement 側に散文のミラーは置いていない（記法の正本は
[open-questions-notation.md](./open-questions-notation.md) のままである）。

### 0.28.0 — 推測を推測と名乗らせ、wall-clock を最長経路へ（#174 / #175 / #176 / #177 / #178 / #179 / #180 / #181 / #182 / #183）

**worker が、自分を裁く検証ランナーを書き換えられた**（#177）。受入条件に書いた
`.claude/skills/cmate-verify/scripts/verify-run.sh` がそのまま `scope.allow` に入っていた ——
受入条件の中の path は「成果物」であるのと同じくらい「実行するコマンド」であり、**形では区別できない**。
ハーネス root を deny-by-default にし、落とした path は `reference_files`（読めるが書けない）へ出す。
**ゲートが 1 つ機能していなかった**ので、この 10 件の中で唯一、認可境界に開いていた穴を塞ぐ修正である。

残る 9 件は 3 つの塊になる。

**1. 推測を、推測と名乗らせる（planner）。** 語彙が似ているだけの 3 Issue が 3 wave に直列化し、
「依存しない」と**否定するために**書いた行が phantom 依存を作り、宣言した path が「長い方が正しい」で
落とされて**触るなと書いた生成物の方が scope に残っていた**（#182）。edge に `basis` を足し、語彙だけの
推論と shadow は **question** にした（推論そのものは消していない —— file を共有する組の順序付けは残る）。
著者が本文に書いた「**まだ決めていない**」も、```open-questions ブロックとして初めて機械に読まれる
（#178。実測では 3 件の未決を残したまま dispatch が通り、worker が自分で決めていた）。規則からは決して
出てこない**集約テスト**は `scope_companions.require` で宣言できるようになった（#181。ADR 第15.2節が
`derive` を緩めず兄弟 key にすることを既に裁定していた）。

**2. 契約と report が、測った事実を落とさない（dispatch）。** 禁止事項は goal に載る口が無く、worker
からは「許可されていない」ではなく**「存在しない」**ように見えていた（#176。実測: 禁止 3 件のうち
2 件しか転記されず、**全ゲート green のまま受入条件違反**。発見は人間のレビュー）。原文転記にし、
切ったら名乗る。`wait` の timeout は **worker の死と区別できず**、再 dispatch が完成済みの作業の上に
別 worker を重ねていた（#179）—— exit 124 の時点で生死を 1 回測って report へ転記する。
リポジトリの事情を書いた flag の置き場は、人間の記憶から profile になった（#180）。

**3. 合流後を見る / 待たない（merge・dispatch）。** file が重ならない**意味的衝突**は、合流後の状態を
誰も検証していなかった（#175。実測: develop に入った直後から赤で、発覚は次段 promotion PR の CI）——
opt-in の `--integration-verify` で **wave barrier が「統合ブランチも green」まで広がる**。非ASCII path が
PR 本文で「宣言外の変更」に化けていたのも直した（#174。裁定は正しく、壊れていたのは人間が読む本文だけ
だが、出る名前が正常系だったので誤読される）。そして wave の wall-clock「各 wave の最遅 worker の合計」を、
opt-in の `--schedule dag` で**最長経路**にした（#183。barrier が兼ねていた 3 つの安全装置には
それぞれ別の答えを出してある）。

**破壊的変更は無い。** `plan_schema_version` / `dispatch_schema_version` / `merge_schema_version` は
すべて据え置きで、`stop_reason` / `worker_state` / `completion_check[].id` の enum にも値を 1 つも
足していない。足した field（`dependencies[].basis` / `worker_liveness` / `integration_verify` /
`schedule` / `profile.dispatch_defaults`）は**すべて schema 上 optional** である —— したがって
0.27.0 以前が書いた plan / report は今も valid で、`status.mjs` は過去 run を読み続けられる。

**新 flag を使わない run の report は、`skill_version` の 1 行を除いて 0.27.0 と byte 一致する。**
`m22`（merge）と `d87`（dispatch）が、**その機能が入る前の runner が書いた** golden をそのまま置いて
byte 比較しており、「opt-in が opt-in である」ことはこの 2 件が測っている。`integration_verify` は
`--integration-verify` を渡した run に、`schedule` は `--schedule dag` の run に、`worker_liveness` は
wait が timeout した worker に、`dispatch_defaults` は profile が宣言した run にしか現れない。

**plan は変わりうる。** `dependencies[].basis` は planner が**必ず出す**ので、edge を持つ plan は 1 行
増える（`required` に入れていないので、`basis` を持たない過去の plan は valid のままである）。そして
本文が #177 / #178 / #182 の拾う形を持っていれば `suspected_files` / `reference_files` / `questions` は
当然変わる —— **それがこのリリースである。** その形を持たない本文の plan は 1 byte も動かない
（`31` / `45` / `61` の全文 golden が、本リリースで `skill_version` の 1 行しか差分を持たないことで
測られている）。

**新たに止まりうるのは 3 つ**である。`--allow-questions` 無しの run で `open_question_declared`（#178）/
`ambiguous_file_candidate`・`unconfirmed_lexical_dependency`（#182）が立った場合と、
`harness_path_in_scope` で `partial` に落ちる場合（#177）—— いずれも 0.27.0 までなら**推測が推測のまま
dispatch されていた**ケースであり、止まる方が正しい。`--schedule dag` は opt-in だが、採ると同じ
`--max-parallel` でも実効並列度が上がる。Kewton/CommandMate#1771（ゲートのリソース直列化）が OPEN の
うちは、**検証ゲートが資源を共有するリポジトリで偽赤が増えうる** —— 直せないので宣言してある。

同梱の **cmate-worker-development も 0.2.0** に上がる（#176）。契約が言及していない禁止事項は許可では
なく **Issue 本文が正本**であること、狭める方向（禁止）は本文も効き広げる方向（権限・対象 file）は
契約が正本であること、そして A 段で本文全文を読み取り専用で取得することを必須手順にした。

### 0.27.0 — 無言で消える情報を潰した（#160 / #161 / #162 / #163 / #164 / #165 / #170 / #171）

**契約経路の pass が、根拠を名指しできるようになった。** `wait --verify` の `GATE` 行は
**stderr** に出るのに runner は stdout しか読んでおらず、`verification.gates` は契約経路の pass で
**常に空**だった（#160）。#142 が `verification_gates_unrecorded` を `--unattended` で blocking に
昇格させていたため、**無人運転の段階 C は全ゲート pass でも必ず停止していた** —— 0.26.0 まで、
段階 C は実物の CommandMate で 1 度も成功していない。**0.27.0 で初めて成立する。**

残る 7 件は同じ形の欠陥である: **宣言された、または測定された情報が、どこにも記録されずに
消えていた。**

- **宣言した対象ファイルが契約から消える**（#161 / #162）。件数上限 200 の切り詰めと形チェックの
  per-item drop。worker は Issue が明記したファイルを編集して scope ゲートで落ち、
  send 時 snapshot なので**回復手段が無い**。pre-flight で `contract_scope_dropped` を blocking に
  した。
- **表示の都合が run を止めるかどうかを決めていた**（#164）。scope 違反の 20 行打ち切りが L4 の
  比較集合を汚し、前進中の worker を `scope_unsatisfiable` で止めうる。判定は全行、表示は上限、
  切ったら名乗る、に分けた。
- **「人が閉じるべき残件」が 8 件で黙って切れていた**（#163）。種別ごとに 1 枠を確保し、
  切った件数と内訳を注記する。
- **gate リスト・setup 失敗理由・再転記の切り捨てが無言だった**（#165 / #171）。特に #171 は
  **切り捨ての注記そのものが切り捨てられる**経路である。
- **誤った復旧手順が run 出力に残っていた**（#170）。#83 は本症状を「GATE 行を出さない CLI が
  在る」と誤診しており、その復旧手順（「GATE 行を出す CommandMate で再実行する」）が
  dispatch サマリの next 行と ADR 第17.3節に残っていた。**この原因では何度再実行しても解決しない。**

**上限値は 1 つも変えていない。** 変えたのは、引かれた事実が残るかどうかだけである。
[plan-contract.md](./plan-contract.md) 第5.1節の「足した分は必ず可視である」に対して、
**「引いた分も必ず可視である」**を対の規範として明文化した。

破壊的変更は無い。report の schema も enum も増えていない。`--unattended` を使っている run では
`contract_scope_dropped` で**新たに止まりうる** —— ただしそれは 0.26.0 までなら黙って権限が
狭まったまま dispatch されていたケースであり、止まる方が正しい。

### 0.26.0 — `run_id` が plan を一意に指すようになった（#157）

`run_id` の入力集合に **解決後の profile が丸ごと**入った。
`baseline` / `branch_template` / `worktree_template` / `verified` / `scope_companions` を
編集すれば、既定 `run_id` は変わる。`run_exists` のメッセージも、
**runner が主張できないことを主張しない**形に直した。

`run_id` が plan を一意に指さない性質は #149 の実装中に見つかり、
`adr-scope-derivation.md` 第15.7節に「profile 全体としてまとめて裁定すること」と
記録されていた。本リリースはその裁定である。

### 0.25.0 — scope 導出の4層が揃った（#149）

段4（L2・profile の `scope_companions`）が入り、
[adr-scope-derivation.md](./adr-scope-derivation.md) の **L1 / L2 / L3 / L4 が揃った**。

| 層 | 何をするか | 版 |
|---|---|---|
| L1 | 宣言されたソースから慣習的なテスト path を導出（設定不要） | 0.23.0（#147） |
| L2 | **repo 固有の規約を profile に宣言**（本リリース） | 0.25.0（#149） |
| L3 | 埋まらない残余を dispatch 前に question で止める | 0.24.0（#145） |
| L4 | 収束しない scope 再指示の遮断 | 0.23.0（#148） |

`suspected_files`（推測）を `scope.allow`（認可境界）へ無変換で昇格していた根本原因は、
**`allow = declared ∪ companions(declared)`** という裁定 0 で閉じた。
**4段すべてが CommandMate を1バイトも変えずに実装されている。**

### 0.24.0 — scope 導出の段3（#145）

段1（#147）が届かない残余 —— **planner が知らないテスト配置の repo** —— を、
**dispatch の前に人間へ返す**ようになった。`acceptance_requires_tests_but_scope_has_none` は
warning と open question の両方に載り、dispatch の pre-flight が `--out` を作る前に停止する。

これで [adr-scope-derivation.md](./adr-scope-derivation.md) の4層のうち **L1 / L3 / L4 が揃った**。
残るは L2（#149・profile の `scope_companions`）である。**CommandMate は引き続き1バイトも変わっていない。**

### 0.23.0 — scope は「推測」から「宣言の閉包」へ（#147 / #148）

**同型の障害が3回出たので、クラスとして裁定した**（[adr-scope-derivation.md](./adr-scope-derivation.md)）。
根本原因は `suspected_files`（推測）を `scope.allow`（認可境界）へ**無変換で昇格**していたことである。

裁定 0 は `allow = declared ∪ companions(declared)` ——
**宣言は Issue のものに保ったまま、認可境界だけを閉包へ広げる。**
段1（#147・planner がテスト伴走を導出）と段2（#148・収束しない再指示の遮断）が入った。
段3（#145・残余の検出）と段4（#149・profile の repo 規約宣言）は後続である。

**CommandMate は1バイトも変わっていない** —— 契約 schema を分けない裁定（ADR 第4節）により、
全段が skill 側で完結する。

### 0.22.0 — 無人運転の段階 C（#142）

`--unattended` が dispatch / merge 両 phase / uat の**すべてに到達**した。
段階 A（#122）→ B（#134）→ C（#142）の3段が揃い、宣言の意味が invocation のどこでも同一になった。
中心は uat の cwd pre-flight である —— 再merge の `git merge --no-ff` は cwd 引数を持たないので、
fix は invocation cwd の branch に入る。**fix worktree を1つも作る前に**それを拒否する。

### 0.21.0 — パレット復帰・無人運転の段階 B・`--auto-yes` の実効化（#134 / #135 / #136）

**0.20.0 はパレットに出なかった。** `SKILL.md` が 71,383 bytes となり CommandMate の
64KB 上限を超えて、ローダーが黙って読み飛ばしていた（#135）。0.14.0 の方針へ戻して
`references/` へ移送し、`validate.py` に**リリース前に止まるサイズガード**を足した。

無人運転は段階 B（`merge --create-prs`）まで来た（#134）。`--auto-yes` は
**指定しても効いていなかった**ものが実際に効くようになった（#136）。

### #135 — SKILL.md が 64KB を超え、スラッシュコマンドパレットから消えた

**インストールは正常なのに、`/cmate-orchestrate` が補完に出なくなった。** CommandMate の
skills API は 0.20.0 を「インストール済み」と認識し、ディスク上にも `.claude/skills/` と
`.agents/skills/` の両方に実体があり、エージェントは `SKILL.md` を直接読むので手で打てば動く。
**落としていたのはパレットのローダーだけ**である —— `parseSkillFile()` は読む前に `stat` し、
`MAX_SKILL_FILE_SIZE_BYTES`（65536）を超えると `logger.warn` を1行書いて `return null` する。
利用者から見ると**理由もなく消える**。

版ごとの `SKILL.md`: 0.16.0=23,213 → 0.17.0=24,155 → 0.18.0=48,178 → 0.19.0=50,632 →
**0.20.0=71,383**。#128（`--worker-method`）・#122（unattended 段階A）・#121（`--reverify`）を
すべて SKILL.md へ書き足した結果で、**0.20.0 で初めて上限を越えた**。インストール済み12件のうち
次に大きいのは 22,825 bytes（`cmate-task-contract`）で、この package だけが突出していた。

対処は**方針へ戻すこと**である。0.14.0（下記）は SKILL.md を「いつ使うか / 呼び出し方と順序 /
出力の読み方 / 停止時に人間が何をするか」の4点に絞り、機構の詳細を正本への一方向参照に変えた。
0.20.0 はそこから外れて肥大した。**移送先を2つ新設し、内容は1文字も削らずに移した**:

- [runner-operations.md](./runner-operations.md) — ランチャー表記・worktree の前提・条件付き依存の
  Skill・dispatch の各 flag（`--prepare-worktrees` / `--worker-method` / `acceptance-gates` /
  `--resume` / `--reverify` / `--contract-mode` / `--unattended` / monitor 境界）・PR 本文・
  profile-init の3点・status の表示規則
- [codes-and-recovery.md](./codes-and-recovery.md) — plan の失敗 code / warning code /
  limitation code の全一覧と、**停止したときの対処表の正本**、無人 run の取り消し手順

SKILL.md は 71,383 → 約 37,000 bytes になり、4点だけを述べて上の2つへ一方向に参照する。
`references` と `schemas` の内容は削っていない（0.14.0 と同じ約束である）。

**再発は `scripts/validate.py` が止める。** 全 package の `SKILL.md` に **60,000 bytes** の上限を
置き、超えたら hard fail する（`SKILLS_SKILL_MD_TOO_LARGE`。エラーは「`references/` へ移送せよ」と
次の行動を名指しする）。閾値を上流の 65536 の生値にしないのは、`MAX_SKILL_FILE_SIZE_BYTES` が
上流の実装詳細だからで、**触れる前に止める**のが安全である。置き場所は #92（`SKILL_VERSION` の
一致）と同じ —— `.commandmate/verify.yaml` の宣言ゲートかつ CI の両ジョブで走るので、
**公開前に必ず通る**。今回は公開してから発覚した。validate.py で落ちていれば公開前に止まった。

なお `acceptance-gates` ブロックを説明する行が ` ```acceptance-gates ` で始まっていたため、
そこから merge 節の直前までが**コードブロックとして描画されていた**。移送のついでに直してある。

### 0.20.0 — 方法を渡す口・無人運転・送らない再裁定（#121 / #122 / #128）

ワーカーへ **HOW（開発の方法）を渡す口**が入った（#128）。方法論の正本は別 package
`cmate-worker-development` にあり、dispatch は `--worker-method` でそれを名指しするだけである。

無人運転は段階A が入った（#122）。**`--unattended` が含意するのは締め付けだけ**で、
どのゲートも無効化せず `--approve` も含意しない。#115 の実測が ADR を4点訂正しており、
その訂正どおりに実装してある —— **`gh` にコードの停止は足していない**（前提が逆だった。
必要なのは `GIT_TERMINAL_PROMPT=0` という job 定義側の環境変数である）。

`--reverify` で **送らずに裁定を更新できる**ようになり、#89 が報告した「timeout で凍結された
裁定のせいで検証済み成果物が納品経路から外れる」は、回復経路つきで閉じた（#121）。

### 0.19.0 — 受入条件の機械ゲート化と、無人運転の前提の訂正（#103 / #114 / #115 / #118）

Issue の受入条件を契約へ運ぶ経路が入った（#114）。plan は v2 になり、古い dispatch が
新しい plan を拒否するようになった（#118）—— ゲートが黙って捨てられる窓を、
**新 planner を持つ版が世に出る前に**塞いである。

無人運転（#115）とワーカー側の開発スキル（#103）は ADR まで。#115 の実測は ADR の記述を
4点訂正しており、実装 Issue は**訂正後の第14節を正本として書くこと**。

### 0.18.0 — 一気通貫化の第一陣（#90 / #91 / #92 / #93 / #94 / #95 / #97 / #98 / #99 / #100）

worktree の継ぎ目（#90 / #91 / #93）、profile の調達（#94）、証拠の提出（#97）、監督の可視化
（#99）、部分失敗からの再開（#98）、版の一致（#92）を入れ、無人運転（#95）と受入条件の機械
ゲート化（#100）は ADR まで進めた。runner は 4 phase ＋ read-only view（`status.mjs`）＋
準備 runner（`profile-init.mjs`）の構成になった。

`scripts/lib.mjs` の `SKILL_VERSION` が 0.13.0 のまま 0.15.0 / 0.16.0 / 0.17.0 が公開され、
report の `skill_version` が install した版と食い違っていた（#92）。`scripts/validate.py` に
manifest との一致チェックを足したので、以後の bump 漏れは CI が止める。

### 0.14.0 — SKILL.md の再構成と `scripts/lib.mjs` の追加

SKILL.md がスクリプト内部のアルゴリズムを逐条解説し、`references/*.md` が正本として同じ内容を
再述し、`schemas/*.json` がまた符号化する三重記述になっていた。SKILL.md を「いつ使うか /
呼び出し方と順序 / 出力の読み方 / 停止時に人間が何をするか」の4点に絞り、機構の詳細は正本への
一方向参照に変え、経緯（この文書）を切り出した。**references と schemas の内容は削っていない。**

あわせて、4 runner に重複していたヘルパーのうち **byte 単位で同一だったものだけ** を
`scripts/lib.mjs` に集約した。同名でも実装が違うもの（`parseCli` / `renderSummary` / `excerpt` /
`bullets` / `runCli` / `validatePlan` / `positiveInt` / `preflight` / `eligibleIssues` / `halt`）は
統合していない。理由は `scripts/lib.mjs` の冒頭に、差分の内容ごと記録してある。
