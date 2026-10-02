# 出力 code の一覧と、停止からの復帰

この文書は [SKILL.md](../SKILL.md) 第4節・第5節から**そのまま移送した**一覧である。
**削っていない。** 移送の理由は [runner-operations.md](./runner-operations.md) の冒頭と同じ
（[#135](https://github.com/Kewton/commandmate-skills/issues/135)）。

SKILL.md 側には「読み方」（status と exit の写像、まず `status.mjs` を読むこと、そして
**止まったら押し通さず読む**という規律）が残っている。ここに在るのは、そこから引く
**全一覧**である —— plan の失敗 code、plan の warning code、limitation code、そして
**停止したときの対処表の正本**と、無人 run の取り消し手順。

`status.mjs --run <run-dir>` は第4節の対処表を機械的に引いて表示する。表がその正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない。**

> **新設規約（[#210](https://github.com/Kewton/commandmate-skills/issues/210)）: plan の warning code
> を新しく足すときは、`blocking` か `notice` かを分類し、その理由を第2節の表に1行書いてから足す。**
> 分類を忘れても既定は `blocking` なので run は fail-closed のまま止まる —— しかしそれでは
> 「**検討して blocking に決めた**」と「**検討していない**」が同じ形で残る。第2節の表はどの code に
> ついても理由を1行持っており、blocking の行にも「blocking が正しい」と書いてある。
> 分類の規範は [plan-contract.md](./plan-contract.md) 第5.6節。

| SKILL.md での位置 | ここでの節 |
|---|---|
| 第4節 plan の失敗 code と exit | 第1節 |
| 第4節 plan の warning code | 第2節 |
| 第4節 limitation code | 第3節 |
| 第5節 停止したとき、人間が何をするか（対処表） | 第4節 |
| 第5節 無人 run を取り消す | 第5節 |
| （run の語彙ではない）準備 runner の warning code（profile-init `--check` / inspect `--check-references`） | 第6節 |
| （run の語彙ではない）merge 後の観測 runner の code（observe） | 第7節 |

---


## 1. plan の失敗 code と exit

| 状況 | code | exit |
|---|---|---|
| Issue 番号が無い / 引数不正 / max-parallel 範囲外 | `invalid_input` | 3 |
| mutating phase 指定（実行は dispatch runner の担当） | `not_implemented` | 2 |
| unverified profile（`--allow-unverified` 無し） | `unverified_profile` | 3 |
| Issue / profile / fixture が読めない | `load_error` | 6 |
| 依存 cycle / 不完全 override / 順序違反 | `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 5 |
| run directory が既存 | `run_exists` | 4 |

失敗時も stdout に `status: failure` の result を出す。**plan を推測で埋めない。**


## 2. plan の warning code（**blocking** が1件でも出れば `partial`）

**warning には severity がある**（[#199](https://github.com/Kewton/commandmate-skills/issues/199)）。
`plan.status` を落とすのは **blocking** な warning だけで、**notice** は落とさない。
既定は blocking であり、**新しい code は誰かが明示的に notice と判断するまで blocking のままになる**
（fail-closed。「黙って `partial` でなくなる」向きには倒れない）。notice が blocking を隠すことは
ない —— blocking が1件でも在れば `partial` である。

**下表は `plan.warnings` に入りうる warning code の全一覧であり、1 code につき severity と
その判断理由を1行持つ**（[#210](https://github.com/Kewton/commandmate-skills/issues/210)）。
#199 は severity の仕組みだけを入れて notice 集合を1件に固定し、個別の分類を後回しにしたので、
「検討して blocking に決めた code」と「まだ誰も検討していない code」が同じ形（`severity` 無し）で
並んでいた。#210 が runner を1 code ずつ裏取りして棚卸しした結果がこの表である。**blocking の行にも
「blocking が正しい」と理由が書いてある** —— 無言の既定と、検討した結果としての blocking は違う。

分類の原理は #199 が言語化したものをそのまま使う:

- **「著者（または operator）が既に決めて宣言したことの報告」は notice**
- **「planner が読めなかった／著者が決めていないことの報告」は blocking**

**分けるのは「宣言されたか」ではなく「何が宣言されたか」である。** `open_question_declared` は
著者自身の宣言だが、宣言している内容が「**まだ決めていない**」なので blocking であり、しかも
最も強い blocking である（本節の後半）。

`severity` は plan（`plan.warnings[].severity`）にだけ載り、notice の entry にだけ書かれる
（blocking は暗黙の既定。書かれていない＝blocking と読む）。result envelope
（`result.json` / stdout）の `warnings` は code と detail だけを運ぶ ——
その envelope が要る集計は `status` そのものだからである。規範は
[plan-contract.md](./plan-contract.md) 第5.6節。

**`status` は人間が読む色であって、run を止める信号ではない。** dispatch を止めるのは
`plan.issues[].questions` の配列であり（`execution-plan.v2` schema の `questions` が
「this array — not plan.status — is what stops a run」と明言している）、`status` ではない。
したがって notice を `success` に含めても**自動化系の振る舞いは1つも変わらない**。

| code | severity | 意味と、その severity にした理由 |
|---|---|---|
| `profile_repository_mismatch` | blocking | 既定 profile の対象リポジトリが cwd の `origin` と一致しない。**blocking が正しい。** この warning が出る条件は「`--profile` も `--profile-json` も渡されなかった」こと（runner の `defaultResolved`）そのものである —— operator は対象リポジトリを1度も宣言しておらず、runner が仮定した。宣言済みの報告ではなく**未宣言の報告**である |
| `profile_repository_override` | **notice** | `--repo` でリポジトリを差し替えたため profile の検証が対象を失った。**notice**（#210 で blocking から移した）。この code は `--repo <other>`（差し替え。これが `verified` を降格させる）と `--allow-unverified`（降格の受諾。**これが無ければ run は `unverified_profile` で exit 3 する**）の**2つの明示 flag が揃わないと出ない**ので、operator が既に決めて run の command line に記録した事実の報告である。**risk は落ちていない** —— `risk.factors` の `unverified_profile`（high）と `profile.verified: false` はそのまま plan に載る（後述） |
| `external_dependency` | blocking | この plan に含まれない Issue への依存を宣言している。**blocking が正しい。** 依存を宣言したのは著者だが、この warning が報告しているのは「その `#N` が既に merge 済みかを planner は知らない」という**未決の状態**である。順序は担保できていない |
| `human_only_dependency` | blocking | dispatch する Issue が、`human-only` ラベルの Issue に依存している（[#286](https://github.com/Kewton/commandmate-skills/issues/286)）。辺は `dependencies` に残るが wave は待たず、dispatch も待たない。**blocking が正しい。** `external_dependency` と同じで、報告しているのは「その人の作業が終わったかを planner も dispatch も知らない」という**未決の状態**である。人が終わったことを確かめてから依存側を dispatch / merge する。[plan-contract.md](./plan-contract.md) 第3.3節 |
| `human_only_excluded` | **notice** | `labels` に `human-only`（固定名）を持つ Issue を、plan に残したまま wave と merge_order から外した（[#286](https://github.com/Kewton/commandmate-skills/issues/286)）。Issue ごとに1件で、立てなかった question の件数も名指す。**notice**。ラベルは「人がやる」という**既に下された判断**であり、warning は planner がその判断を守ったことの報告である。[plan-contract.md](./plan-contract.md) 第3.3節 |
| `ambiguous_dependency_direction` | blocking | 1行に順方向と逆方向の方向語が同居し、依存の向きを一意に読めない。**blocking が正しい。** 「planner が読めなかった」の報告そのものである。しかも planner は片方の読みで edge を作っているので、読み違えていれば wave 順が違う |
| `no_acceptance_criteria` | blocking | 受入条件を1件も読み取れない。**blocking が正しい。** 何をもって完了かが宣言されていない |
| `no_suspected_files` | blocking | 対象 file を1件も読み取れない。**blocking が正しい。** worker に与える scope が空になる（＝書き込み権限が空）。dispatch 側では同じ事実が `contract_scope_unknown` になり、その wave は advance しない |
| `unrecognized_file_extension` | blocking | 既知拡張子外の backtick path が抽出から落ちた。**blocking が正しい。** 著者は宣言したが planner が**運べなかった**ので、`harness_path_in_scope`（宣言を honour した報告）とは向きが逆である。scope が宣言より狭いまま dispatch される 成果物見出しを持つ Issue では出ない（CommandMate #3003）: 見出しの下の backtick の file 名は拡張子によらず拾われ、見出しの外の path は `prose_path_ignored` に回る。直し方は「`## 対象ファイル` の下に backtick で書く」である（[plan-contract.md](./plan-contract.md) 第5.9節） |
| `ambiguous_file_candidate` | blocking | 同じ file の2つの綴り（一方が他方の path 境界つき suffix）が本文に在り、どちらを意図したか決められない。**どちらも落とさず**両方 scope に入れたうえで訊いている。**blocking が正しい。** どちらが対象かを著者が決めていない |
| `unconfirmed_lexical_dependency` | blocking | 生産者/消費者の推論が**共有 topic token だけ**を根拠にしていたので、依存 edge にしなかった。順序が要るなら人間が述べる。**blocking が正しい。** 2 Issue が独立かどうかを、それを決められる人間がまだ決めていない |
| `harness_path_in_scope` | **notice** | agent ハーネスの path（`.claude/skills/` / `.agents/skills/` / `.commandmate/`）を、Issue が**成果物見出しで明示的に宣言した**ので scope に入れた。既定は「入れない」である。**notice**（#199）。著者が本文に書いて決めたことを honour した記録であり、ハーネスを in-repo で保守しているリポジトリでは**正しい書き方に対して毎回出る**（後述） |
| `scope_pattern_declared` | **notice** | Issue が**成果物見出しの下**で宣言した `scope.allow` の entry のうち、path ではなく pattern（glob / 末尾スラッシュのディレクトリ）であるものを列挙する。**notice**（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。著者が本文に書いて決めたことを honour した記録であり、`harness_path_in_scope` と同じ側にある。plan は pattern を**展開しない**（working tree を開かない＝ADR 不変条件3）ので、可視化できるのは宣言そのものである —— 「足した分は必ず可視」（不変条件2）を、展開せずに満たす形である。展開結果の証跡は裁定を行う CommandMate の scope ゲート側に残す（Kewton/CommandMate#1841） |
| `scope_pattern_dropped` | **notice** | 成果物見出しの**外**（`## 根拠` / `## 参考` の配下、または見出しの外の散文）に書かれた pattern を、scope に入れずに落とした。**notice**（#219）。glob は「誰も列挙していない file 集合に対する権限」なので、#177 がハーネスに引いたのと同じ規則（**明示の宣言が言及に優る**）で成果物見出しの下だけ honour する。0.31.0 までは backtick の中の glob だけが偶然どこからでも `scope.allow` に届いていたので、黙って落とすと誰かの scope が黙って狭くなる —— この warning はその予告であり、直し方は「`## 対象ファイル` へ移して re-plan する」の 1 通りしかない。**`unrecognized_file_extension` には落とさない**（`.json` は既知拡張子であり、綴りを直せと言うのは誤診である） |
| `prose_path_ignored` | **notice** | 成果物見出し（`## 対象ファイル` 等）を持つ Issue が、その見出しの範囲の**外**（散文・`## 完了条件`・`## 追記 N`・title）にだけ書いた path を、`suspected_files` に入れず `reference_files` に入れた（CommandMate #3002）。Issue ごとに1件で、件数と先頭5件を名指す。**notice**。`scope_pattern_dropped` と同じ側 —— 報告しているのは「読めなかった」ではなく「成果物見出しで scope を宣言した Issue の言及を、宣言として読まなかった」という**著者が書いた位置についての事実**である。正しく書かれた Issue（「差分 0」「触るな」を完了条件に書く）でも出るので、blocking にすると誰も読まなくなる。見出しの無い Issue では出ない（挙動は従来どおり）。[plan-contract.md](./plan-contract.md) 第5.8節 |
| `open_question_declared` | blocking | Issue 本文の ```open-questions ブロックが「これはまだ決めていない」と宣言している。**planner の推論ではなく、著者自身の申告**である。1件につき1件。**blocking が正しい。著者の宣言だから notice、ではない** —— 分けるのは「何が宣言されたか」であり、これが宣言しているのは**未決そのもの**なので、この表で最も強い blocking である |
| `open_question_block_invalid` | blocking | ```open-questions ブロックが読めない（2個以上・未閉・未知 version・未知 key・空・重複・subset 違反）。**「ブロックが無かった」に丸めない**。**blocking が正しい。** 「planner が読めなかった」の報告である |
| `acceptance_gate_block_invalid` | blocking | ```acceptance-gates ブロックが読めない（2個以上・未閉・tab・未知 version・未知 key・不正な gate id・重複・空・上限超過、および `gates:` の定義が予約 id / `issue-<番号>-` 始まりでない / command 無し / timeout 範囲外）。**「ブロックが無かった」に丸めない**（[acceptance-gates-notation.md](./acceptance-gates-notation.md) 第4節）。**blocking が正しい。** 「planner が読めなかった」の報告であり、丸めれば著者が書いたはずの受入ゲートが黙って消えた run が緑で終わる |
| `acceptance_requires_tests_but_scope_has_none` | blocking | 受入条件がテストの**作成**を能動的に要求しているのに、対象 file（**段1 の導出結果を含めて**）にテストらしき path が1件も無い。**blocking が正しい。** 「テストを足すのか、足さないのか」を著者が決めていない（判定は推論なので偽陽性がありうる。detail に原文が入っている） |
| `contract_scope_dropped` | blocking | 宣言された対象 file の一部が、dispatch の実行契約の `scope.allow` に**入らない**（件数上限 200 超過、契約が扱えない形の path、または repository 全体を意味する pattern ＝ `over_broad`。[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。detail に**落ちた件数・落ちた path（先頭3件）・落ちた理由**が入る。**blocking が正しい。** worker の権限が Issue の宣言より**狭く**なるという予告であり、`--unattended` では dispatch 側で blocking reason になって run ごと止まる |

**この表に無い code が `plan.warnings` に出ることはない。** #210 は runner の
`plan.warnings` 合流点（profile 由来 / 抽出 / 契約 scope / open question / 依存の5系統）を
1つずつ辿って上表を作った。以前の表には ```acceptance-gates ブロック由来の2 code
（`acceptance_gate_block_invalid` / `acceptance_gate_block_unsupported`）が**載っていなかった** ——
どちらも `plan.warnings` に出て `status` を落とすのに、台帳の側から見えていなかった。
新設 code をここへ書き足す規約は本書の冒頭に在る。

> **廃止した code: `acceptance_gate_block_unsupported`**（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）。
> ```acceptance-gates ブロックの `gates:`（新規 command gate の定義）が実装されたので、
> 「読めてはいるが強制できない」という状態が無くなった。**この planner はもう出さない**ので
> 上表から外した。意味だけ残す: 古い plan に在れば「その run の runner は `gates:` を
> 実行できなかった」という意味である。記法違反は `acceptance_gate_block_invalid` に一本化され、
> worktree の既存 gate id との衝突は dispatch の `acceptance_gate_id_conflict`（第3節）になる。
> なお生産側 2 package（`cmate-issue-authoring` / `cmate-issue-refinement`）は**まだ出す** ——
> 「自分が出せない記法を出さない」という producer 側の判断であり、ミラーは後続 Issue である。

`open_question_declared` / `open_question_block_invalid` /
`no_acceptance_criteria` / `no_suspected_files` / `acceptance_requires_tests_but_scope_has_none` /
`ambiguous_file_candidate` / `unconfirmed_lexical_dependency`
は dispatch の open question ゲートと対になる。**これらを放置したまま `--allow-questions` で
押し通さないこと。** このフラグは plan 全体に効くので、1件を黙らせるつもりで全部を黙らせる。

先頭2つは [#178](https://github.com/Kewton/commandmate-skills/issues/178) で足した。
**この2つだけは planner の推論ではない。** 他はすべて「本文から X を読み取れなかった」という
不在についての報告であり偽陽性がありうるが、`open_question_declared` が運ぶのは
「**X をまだ決めていない**」という、決められる唯一の人間による事実の申告である。
planner が計算しても答えは出ないので、`questions` の**先頭**に立つ。

- `open_question_declared`: Issue 本文に ```open-questions ブロックが在り、その問いを
  そのまま転記している。**その問いを決めて、答えを本文へ畳み込み、ブロックを消して
  re-plan する。** 止めなかった場合の実測（2026-08-10、Kewton/BorderFreeKidsMap#63）は
  「worker が本文の他節から推測するか自分で決め、**どちらに転んだかは diff を読むまで
  分からない**」である。記法は
  [open-questions-notation.md](./open-questions-notation.md)。
- `open_question_block_invalid`: ブロックの構文を直すか、ブロックごと消して re-plan する。
  `acceptance_gate_block_invalid` と同じ fail-closed（同記法 第4節）であり、
  **「ブロックが無かった」に丸めない** —— 丸めると、著者が未決と書いたはずのものが
  黙って消えた run が緑で終わる。

後ろ2つは [#182](https://github.com/Kewton/commandmate-skills/issues/182) で足した。どちらも
**planner が推測をやめて訊く**ようにした結果であり、以前は前者が warning だけ
（`shadowed_file_candidate` —— 本 planner はもう出さない）、後者が黙って作られる
依存 edge だった。どちらの場合も、気づかない人間に対しては**推測がそのまま dispatch されていた**。

- `ambiguous_file_candidate`: 本文に `data/demo/facilities.json` と
  `web/public/dist/data/demo/facilities.json` の両方が在るような状態である。**どちらを対象から
  消すかを決めて本文を直し、re-plan する。** 両方が対象なら `--allow-questions` でよい ——
  両方とも scope に入っている。
- `unconfirmed_lexical_dependency`: 「語彙は共有しているが file は共有していない」2 Issue が
  在るという報告である。**順序が要るなら Issue 本文に `depends on #N` と書くか
  `--depends <consumer>:<producer>` を渡して re-plan する。** 要らない（＝独立である）と
  読んだなら `--allow-questions` で進めてよい。3 Issue が語彙一致だけで3 wave に直列化していた
  のが元の障害なので、**この question の正しい答えは多くの場合「独立である」**である。

`acceptance_requires_tests_but_scope_has_none` は前2つと違って**推論**である
（[adr-scope-derivation.md](./adr-scope-derivation.md) 第7節・第8節、第14節）。判定の元になった
**受入条件が原文で detail に入っている**ので、偽陽性かどうかはその1行を読めば決まる。
「テストは不要」「既存のテストが緑のまま」「手動テストで確認」「テストは変更しない」と
書いた受入条件は**検出から除外される**ので、これらで止まったら実装側の欠陥である。

`contract_scope_dropped` は**推論ではなく予告**である ——「dispatch の実行契約はこの path を
運べない」という、その場で確定している事実を、dispatch より前に言っている。dispatch 側にも
**同名の code** が在り（第3節・第4節）、`--unattended` では blocking reason、人間が居る run では
limitation になる。同じ欠陥に同じ名前を付けてあるので、plan の warning と dispatch の停止は
**同じ1件の findings を2つの時点で読んでいる**と分かる。詳細と規範は
[plan-contract.md](./plan-contract.md) 第5.1節の不変条件4（「引いた分も必ず可視である」）にある。

`harness_path_in_scope` は他の warning と**向きが逆**である。他は「入らなかった」の報告だが、
これは「**入れた**」の報告である —— `.claude/skills/` / `.agents/skills/` / `.commandmate/` は
worker とその審判（verify runner）と「合格の定義」（`.commandmate/verify.yaml`）そのものなので、
planner は**既定でこれらを `scope.allow` に入れない**。受入条件に
`` `bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd .` が RESULT passed を返す `` と
書くのは受入条件の**普通の書き方**であり、それが審判への書き込み権限になってはならない。
既定で落とした path は捨てずに `reference_files`（「読むが scope.allow には入れない」）に出る
ので、warning は付かない —— **正しい書き方に対して partial を出さない**。この code が出るのは
Issue が `## 対象ファイル`（成果物見出し）に書いた場合だけで、そのときは人間が明示的に宣言して
いるので通す。**通したこと自体を残すのがこの warning である。**詳細と #1756 との整合は
[plan-contract.md](./plan-contract.md) 第5.3節と
[adr-scope-derivation.md](./adr-scope-derivation.md) 第17節にある。

**ハーネスを成果物とする Issue でこの code が出るのは正常である。** 検証ゲートを足す・skill 定義を
直す・`.commandmate/verify.yaml` を書き換えるといった作業は、ハーネスを in-repo で保守している
リポジトリ（このリポジトリがそうである）では**例外ではなく定常作業**なので、この warning は
定期的に出る。出たこと自体は欠陥の徴候ではない —— 読むべきは「その Issue の成果物が本当に
ハーネスなのか」の1点だけである（第4節の対処表）。#199 以前はこの形の Issue が**毎回 `partial` で
返っていた**（実測 2026-08-14、Kewton/BorderFreeKidsMap）。その `partial` も異常ではなかったが、
正しい書き方に対して常時出る色は色として機能しないので、#199 でこの code を
`severity: notice` に分類し、`status` を落とすのをやめた。**warning 自体は残り続ける。**

`profile_repository_override` は notice 集合の2件目である（[#210](https://github.com/Kewton/commandmate-skills/issues/210)）。
`harness_path_in_scope` が**著者**の宣言の報告であるのに対し、これは **operator** の宣言の報告である
—— 同じ分類原理の、同じ側である。判断の裏取りは runner の発生条件そのものにある:

- `--repo <other>` が profile の `repository` と違う値を指したときだけ `verified` が降格し、
  この降格が `verified_downgraded` を立てる。これが warning の唯一の発生源である
- 降格した profile は `--allow-unverified` **無しでは run が `unverified_profile` で exit 3 する**
  （fixture case 13）。したがって**この warning が plan に載っている run は、必ず
  `--repo` と `--allow-unverified` の両方を明示的に受け取っている**
- `--allow-unverified` を求める側のメッセージは
  「`branch/base/worktree/baseline` が正しいことを確認してから付け直せ」と書いている。
  フラグはその確認の記録であり、**run の command line に残る**

**「原理どおりだから」だけで移したのではない。2つの実測が blocking 側を壊していた。**

1. **同じ受諾が、綴りによって色分けされていた。** `--profile-json <verified: false>
   --allow-unverified` は「検証されていない profile を承知で使う」というまったく同じ判断だが、
   warning は1件も出ず `status: success` で返る（fixture case 08。risk は同じく high）。
   `--repo` 経由の同じ判断だけが `partial` だった
2. **第4節の対処表が指示した直し方が、色を動かさなかった。** `profile_repository_mismatch`
   （cwd の origin と既定 profile が食い違う）の対処は
   「`--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する」である。
   `--repo` を選ぶと `profile_repository_override` が出て、run は `partial` のままになる。
   **表のとおりに直したのに色が変わらない** —— これは #177 が denied 側について言った
   「正しい書き方に対して `partial` を出す warning は、読み手に読み飛ばし方を教える」の、
   operator 側から到達した同じ失敗である

**落としたのは色だけである。** `profile.verified` は plan の中で `false` のままだし、
`risk.factors` には `unverified_profile`（severity `high`）が載り続け、`risk.level` も `high` の
ままである。warning 自身も detail ごと `plan.warnings` に残り、`dependency-plan.md` にも
`(notice)` の印つきで出る。**`success` は「読まなくてよい」ではない。**


## 3. limitation code（停止はしていないが、後から効いてくる制約）

| code | runner | 意味 |
|---|---|---|
| `contract_unsupported` | dispatch | CLI が実行契約に非対応で、より弱い baseline 裁定に落ちた |
| `contract_disabled` | dispatch | `--contract-mode off` を明示したため probe していない |
| `contract_scope_unknown` | dispatch | 対象 file が空の Issue を dispatch しなかった（その wave は advance しない） |
| `acceptance_gate_id_unknown` | dispatch | Issue の ```acceptance-gates ブロックが `require:` した gate id が worktree の `.commandmate/verify.yaml` に無い、あるいはそのファイルを読めない（`gates:` を宣言した Issue も同じく読めなければ止まる —— `gateDefinitions` を運ぶ契約は config 無しでは評価され得ない）。**Issue ごとに1件。send する前に止める。** detail が実在する id を列挙するので、綴り違いなら diff がそのまま出る |
| `acceptance_gate_id_conflict` | dispatch | Issue の `gates:` が定義した id が、worktree の `.commandmate/verify.yaml` が**既に宣言している** id と衝突している（[#125](https://github.com/Kewton/commandmate-skills/issues/125)）。**Issue ごとに1件。send する前に止める。** 契約は**足せるだけで上書きできない** —— 同じ id なら report がどちらの裁定か言えず、リポジトリ自身の「合格の定義」を委任単位で差し替えられてしまう。Issue 側の id を `issue-<番号>-<何を測るか>` に直すか、定義をやめて既存ゲートを `require:` する。上流は同じ契約を送信時 exit 2 で拒否するので、**そこへ到達させないための停止**である |
| `acceptance_gates_not_enforceable` | dispatch | 実行契約の無い run（`--contract-mode off`、契約非対応 CLI への fallback）で、Issue が受入ゲートを `require:` / `gates:` している。**Issue ごとに1件。** 裁定は profile baseline の再実行になり、gate id を伝える口も定義を置く場所も無い。dispatch すると **Issue が書いた条件を一度も測っていない緑**ができるので止める |
| `contract_scope_dropped` | dispatch | 宣言された対象 file の一部が実行契約の `scope.allow` に入らないまま dispatch した。**Issue ごとに1件。** worker の権限は Issue の宣言より**狭い**。detail に落ちた件数・落ちた path・落ちた理由が入る。**`--unattended` では limitation ではなく blocking reason になり、`--out` を作る前に停止する** |
| `open_questions_accepted` | dispatch | `--allow-questions` で未回答 question を引き受けた |
| `auto_yes_used` | dispatch | `--auto-yes` で prompt を自動応答した |
| `dispatch_defaults_applied` | dispatch | plan の profile が `dispatch_defaults` を宣言しており、この run がそれを解決した（[#180](https://github.com/Kewton/commandmate-skills/issues/180)、[profile-contract.md](./profile-contract.md) 第10節）。**run 全体で1件。** どの値が profile 由来で、どの値が flag に上書きされたかを detail に書く。**flag は常に profile を上書きする** |
| `human_only_excluded` | dispatch | plan が `dispatch_excluded: human_only` の印を付けた Issue に worker を割り当てなかった（[#286](https://github.com/Kewton/commandmate-skills/issues/286)、[dispatch-contract.md](./dispatch-contract.md) 第3.0.6節）。**run 全体で1件。** その Issue は `waves[]` の最後の entry に worker_state `not_dispatched`（note `human-only`）で並ぶ。失敗でも blocking でもない |
| `human_only_dependency` | dispatch | この run が dispatch した Issue が human-only の Issue に依存していたが、**待たずに**送った（dispatch は人の作業の完了を見られない）。**run 全体で1件**で、「#N depends on human-only #M」を全件並べる。依存側を merge する前に、人の作業が終わったことを確かめる |
| `worker_messages_applied` | dispatch / uat | `--nudge-message` または plan の `profile.worker_messages.nudge` が、監督 nudge の既定文の後ろへ追記された（CommandMate#3009、[profile-contract.md](./profile-contract.md) 第14節）。**run 全体で1件。** 由来（flag / profile）と文字数を detail に書く（本文は書かない）。既定文は消えない。uat（`fix_uat` のみ）は `--fix-nudge-message` または `profile.worker_messages.fix_nudge` が fix nudge の既定文の後ろへ追記されたときに limitations へ同じ code で1件残す |
| `schedule_dag` | dispatch | `--schedule dag` を渡した（[#183](https://github.com/Kewton/commandmate-skills/issues/183)、[dispatch-contract.md](./dispatch-contract.md) 第3.2節）。**run 全体で1件**、何かを dispatch する前に記録する。その run の `max_parallel`・`waves[]`・`barrier` を**どう読むか**を決める宣言なので、他のすべての行はこれを前提に読む。detail は3点を書く: `--max-parallel` は同時実行数の上限であること、`plan.waves` は参考情報であること、**合流後の統合ブランチ検証（#175）は run の末尾に1回**回す必要があること。並列度が上がるので、検証ゲートが資源を共有するリポジトリでの偽赤（Kewton/CommandMate#1771、本 Issue 時点で OPEN）への注意もここに入る |
| `schedule_dag_lexical_edge_ignored` | dispatch | `--schedule dag` の run が受け取った plan に `basis: lexical` の依存 edge が在り、**ready 判定に使わなかった**（#183 / #182）。**run 全体で1件。** 語彙一致だけの推論は planner が edge にしないので、正しい plan には在り得ない —— 在るなら古い runner の plan か手編集である。従っていたら #182 が un-serialize した run を再び直列化することになる。順序が本当に要るなら Issue 本文に述べて re-plan する |
| `dispatch_defaults_no_infer_not_applied` | dispatch | profile が `dispatch_defaults.no_infer` を宣言しているのに、渡された plan は**推論を有効にしたまま**作られている（`inputs.infer` が true）。**run 全体で1件。** dispatch は承認済み plan を後から un-infer できないので、wave が語彙一致で直列化されているなら `--no-infer` を付けて plan を取り直す |
| `send_retried_not_ready` | dispatch | `commandmate send` が **起動中（503 `SESSION_STARTING`）または prompt not ready（どちらも exit 99、何も打鍵されていない）** で断られたので、間を置いて**1回だけ**送り直した（[CommandMate#3006](https://github.com/Kewton/CommandMate/issues/3006)、[dispatch-contract.md](./dispatch-contract.md) 第2.13節）。**再送1回ごとに1件。** detail が断り方・待った秒数・結果（通った／再送も断られた／budget が足りず送り直していない）を名指しする。通っていれば人間がすることは無い。再送も断られた run は `worker_failed` で止まっているので、セッションを `commandmate capture <worktree-id>` で見てから `--resume` する。exit 2（PROMPT_WAITING）や他の 409 は**送り直さない** |
| `stale_prompt_interrupted` | dispatch | `--interrupt-stale-prompt` の run で、最初の send の前に前の回の質問画面（`isPromptWaiting` / `isSelectionListActive`）が残っていたので、`commandmate interrupt` で**答えずに**畳み、capture で composer に戻ったのを確かめてから送った（[CommandMate#3007](https://github.com/Kewton/CommandMate/issues/3007)、[dispatch-contract.md](./dispatch-contract.md) 第2.14節）。**Issue ごとに1件。** detail に画面の抜粋が入る。**その質問が何を訊いていたかは誰も決めていない** —— 抜粋を読み、決めるべきことだったなら Issue か次の指示に書く |
| `parallelism_truncated` | dispatch | wave が `max_parallel` より広かったので上限で切った |
| `unsafe_worktree_target` | dispatch | worktree path が path-escape guard に弾かれた |
| `worktree_sync_ran` | dispatch | `ls` で解決できず `commandmate sync` を1度実行して `ls` を読み直した（解決した branch / なお未解決の branch を detail に列挙） |
| `worktree_sync_unavailable` | dispatch | `commandmate sync` が失敗した（0.21.0 未満には subcommand が無い）。**この失敗自体では停止しない**が、server 未登録の worktree は登録し直せていない |
| `worktree_setup_ran` | dispatch | `--prepare-worktrees` で `cmate-worktree-setup` provider を1回呼んだ（対象 Issue・status・phase を detail に記録） |
| `worktree_prepared` | dispatch | provider が worktree を作成/再利用した。**Issue ごとに1件**（branch・base SHA・baseline 合否を detail に記録） |
| `worktree_setup_partial` | dispatch | 要求したうち一部しか作られなかった。作れた分は**消さずに保持**し、未解決 Issue については停止する |
| `worktree_setup_skipped` | dispatch | `--prepare-worktrees` を指定したが、pre-flight が別の drift で先に止まったため provider を呼んでいない |
| `worktree_sync_rescanned` | dispatch | 準備段のため `commandmate sync` を2回実行した（解決時の1回＋作成後の強制1回） |
| `issue_constraints_transcribed` | dispatch | Issue 本文の否定的制約を task text へ**原文転記した**（[#176](https://github.com/Kewton/commandmate-skills/issues/176)、[dispatch-contract.md](./dispatch-contract.md) 第2.4.1節）。**Issue ごとに1件**（転記した節を detail に名指しする）。**転記したことは、守られたことではない** |
| `issue_constraints_untranscribed` | dispatch | 否定的制約を見つけたが、上限（1200 文字 / 8 ブロック）に収まらず**一部を運べなかった**。**Issue ごとに1件。** ブロックを途中で切ることはしないので、落ちたのは節単位である。goal には落とした節の名前と `gh issue view <n>` の1行が入っている |
| `issue_body_unreadable` | dispatch | `gh issue view` が Issue 本文を読めなかった（未 install / 未認証 / 網なし）。**Issue ごとに1件。** 停止はしない（scope と verify は plan 由来なので運べる）が、**否定的制約は1件も運べていない**。goal はその旨と `gh issue view <n>` を名指ししている |
| `worker_method_declared` | dispatch | `--worker-method <id>` 付きの run である。**run 全体で1件。** 停止した run にも残る（何を前提にした run だったかが読めるように） |
| `worker_method_applied` | dispatch | その Issue の worktree に skill が在り、task text に `## Method` 節を書いた。**Issue ごとに1件。** 「適用された」であって「守られた」ではない |
| `unattended_mode` | dispatch / merge / uat | `--unattended` 付きの run である。**run 全体で1件。** 停止した run にも残る。**その runner・その phase が含意した締め付け**を detail に記録する（dispatch: contract require / pre-flight の scope 検査 / wall-clock budget / worktree lock / 裁定根拠の要求。merge `--create-prs`: 変更証拠の要求。merge `--merge-prs`: 受入ゲートブロックと受入条件の要求。uat: 意味ゲートと上限の明示＋再merge 先の pre-flight） |
| `unattended_baseline` | dispatch | その Issue の worktree が dispatch 開始時どこに居たか（**branch 名と短縮 SHA**。絶対 path は書かない）。**Issue ごとに1件。** 取り消しの起点であり、**担保するのは worktree branch の1段だけ**である（本書第5節） |
| `verification_unrecorded` | dispatch | completed した worker に裁定が1つも記録されなかった（runner 側の欠陥。`verification_recorded` completion check も落ちる） |
| `verification_gates_unrecorded` | dispatch | verification は pass だが `GATE` 行を読めず、pass の根拠となった gate を report が名指しできない |
| `drift_<check>` | dispatch | 非 blocking な drift（`integration_clean` / `worktrees_present`）を記録して続行した |
| `issue_autoclose_not_default_branch` | merge | base がデフォルトブランチでないため `Resolves #n` が効かない。**merge 後に手動クローズが要る** |
| `unsafe_branch` | merge | branch 名が safe-ref guard に弾かれた |
| `change_evidence_unavailable` | merge | branch の実変更 file を読めなかった（worktree 不在など）。PR 本文もそう書く。**scope 内に収まっていた証拠ではない** |
| `branch_changed_outside_declared_scope` | merge | 実変更に宣言 scope（`scope.allow`）外の file がある。PR 本文が違反 path を名指しする |
| `worker_declarations_transcribed` | merge | ワーカーがコミットメッセージ本文に書いた申告（`読み替え:` / `判断:` / `本文に無い指摘:`）を PR 本文の「ワーカーの申告」節へ転記した（CommandMate#3005）。**Issue ごとに1件。** merge は止めない —— **merge する前に人が読む** |
| `worker_declarations_unread` | merge | ブランチのコミットメッセージを読めなかった（`git log` 失敗）。PR 本文もそう書く。**申告が無かった証拠ではない**。worktree を確かめ、`git log <base>..<branch>` を手で読む |
| `integration_verify_not_run` | merge | `--integration-verify` を渡したが、この invocation は1件も merge していない（preview / eligible 無し / 最初の merge の前に停止）ので合流後を測っていない。**「測っていない」であって「green」ではない**（`integration_verify.outcome` は `not_run`） |
| `integration_verify_tree_left` | merge | 統合検証に使った**使い捨ての detached checkout**（`<out>/integration-tree`）を畳めなかった。裁定は baseline の結果のまま。`git worktree remove --force` で消す |
| `caller_index_lock_pre_existing` | merge | **呼び出し元 worktree の `index.lock` が、この run の開始前から在った**（[#222](https://github.com/Kewton/commandmate-skills/issues/222)）。**run 全体で1件。** severity は **notice** —— この runner は呼び出し元の index を読み書きしないので、**停止する理由が無い**（処理は続行し、裁定は1つも変わらない）。detail に path（呼び出し cwd からの相対）・size・mtime が入る。**後続の `git pull` がこの lock で落ちるなら、それはこの run より前から在ったものである** |
| `caller_index_lock_appeared` | merge | **呼び出し元 worktree の `index.lock` が、run の実行中に出現した**（同上）。**run 全体で1件。** severity は **notice**。開始時に無く終了時に在る、という**観測**であって、**この runner が作ったという主張ではない** —— merge runner が呼ぶ git は `fetch` / `rev-parse` / `worktree add\|remove` / `diff` / `push` だけで、呼び出し元の index を書く verb が1つも無い。**merge と統合検証の裁定は変わらない。**先に `integration_verify.outcome` と各 target の `merged` を読むこと（第4節の該当行） |
| `acceptance_not_run` | uat | 意味ゲートが verdict を出せず、baseline のみで裁定した |
| `no_eligible_issues` | merge / uat | dispatch report に completed かつ verification pass の Issue が無い |
| `completion_check_failed` | dispatch / merge / uat | completion check のどれかが passed でない |

`conditional_go` の保持（`acceptance_conditional`）と fix 上限到達（`max_attempts_reached`）は
limitation ではなく **stop_reason / blocking reason** である。**停止であって、続行しながらの
注記ではない。**

`issue_constraints_untranscribed` / `issue_body_unreadable` は**止まらないが、放置してよい種類では
ない**。どちらも「否定的制約が worker へ全部届いていない」と言っており、scope ゲートも verification
ゲートも**それを測らない**（[dispatch-contract.md](./dispatch-contract.md) 第2.4.1節）。人間がすること:
`issue_constraints_untranscribed` なら detail と goal が落とした節を名指ししているので、その節を
worker へ渡すべきなら **Issue を分割するか本文の制約節を短くして re-plan する**；
`issue_body_unreadable` なら `gh auth status` を確かめて（未 install / 未認証 / 網なし）から
**同じコマンドで再実行する** —— 本文が読めれば転記が入る。どちらの場合も、その run の pass は
**「本文の禁止事項を守った」ことを意味しない**。なお、この3つの code は現時点で status runner の
hint 表に**入っていない**（`status.mjs` は #176 の宣言 scope の外だった。
`acceptance_requires_tests_but_scope_has_none` と同じ事情で、第4節の注記を見よ）。したがって
`status.mjs` は detail を読ませる既定に落ちる。


## 4. 停止したとき、人間が何をするか（対処表の正本）

**runner が止まったら、それは「押し通す」合図ではなく「読む」合図である。**
`blocking_reasons` の code と `summary_markdown` を読み、次の対応を取る。

`status.mjs --run <run-dir>`（[SKILL.md](../SKILL.md) 第3.6節）は**この表を機械的に引いた結果**を、どの Issue の話かを
添えて出す。JSON を自分で突き合わせる前に、まずこれを読めばよい。表がこの節の正本であり、
status runner はそれを引くだけなので、**ここに無い code は status runner も推測しない**
（「detail と `summary_markdown` を読む」に落ちる）。

> `acceptance_requires_tests_but_scope_has_none` は現時点で status runner の hint 表に
> **入っていない**（`status.mjs` は本表を追加した変更の宣言 scope の外だった）。したがって
> `status.mjs` はこの plan warning について detail を読ませる既定に落ちる。**運転で人間が
> 出会う停止は dispatch 側の `open_questions`** であり、そちらは hint を持っていて
> 質問の本文（＝受入条件の原文）をそのまま出す。

| 止まり方 | 何が起きたか | 人間がすること |
|---|---|---|
| plan `status: partial` + `no_acceptance_criteria` / `no_suspected_files` | Issue に受入条件か対象 file が書かれていない | **Issue 本文に書き足して re-plan する。** run_id は本文を含む hash なので自動的に別 run になる |
| plan `status: partial` + `open_question_declared`（dispatch 側では `open_questions` として止まる） | Issue 本文の ```open-questions ブロックが「これはまだ決めていない」と宣言している。**推測ではなく著者の申告**であり、planner が計算しても答えは出ない。止めなければ worker は本文の他節から推測するか自分で決め、**どちらに転んだかは diff を読むまで分からない**（実測 2026-08-10、Kewton/BorderFreeKidsMap#63） | **その問いを決めて、答えを Issue 本文へ畳み込み、`open-questions` ブロックを消して re-plan する。** ブロックの削除が「決めた」の記録である。question に著者の原文が入っているので、判断は本文を開かずに始められる。**`--allow-questions` は「決めていないことを worker に決めさせる」という判断である** —— そう決めたのなら通してよいが、それが run の command line に残る |
| plan `status: partial` + `open_question_block_invalid`（同上） | ```open-questions ブロックを読めなかった（2個以上・未知 version・未知 key・空・重複・subset 違反）。**「ブロックが無かった」には丸めていない** | **ブロックの構文を直すか、ブロックごと消して re-plan する。** warning detail が壊れ方を名指ししている。記法は [open-questions-notation.md](./open-questions-notation.md)（YAML subset は acceptance-gates 記法 第3節と同じ: 2スペース・tab 禁止・行頭 `#` のみコメント） |
| plan `status: partial` + `acceptance_requires_tests_but_scope_has_none`（dispatch 側では `open_questions` として止まる） | 受入条件はテストの作成を要求しているのに、宣言された file からテスト path が1件も導出できていない。**そのまま dispatch すれば worker は正しくテストを書いて scope ゲートで落ち、契約 scope は send 時 snapshot なので worker 側に回復手段は無い** | **Issue 本文の対象 file にテスト path を書いて re-plan する。** テストが本当に不要なら受入条件にそう書く（否定形は検出から除外される）。判定の元になった受入条件が warning detail と question に原文で入っているので、偽陽性の確認はその1行で済む。**`--allow-questions` で押し通すのは、そのまま worker 1人分の run を捨てることである** |
| plan `status: partial` + `ambiguous_file_candidate`（dispatch 側では `open_questions` として止まる） | 同じ file の2つの綴りが本文に在る（一方が他方の path 境界つき suffix）。**どちらも scope に入れてある** —— 以前は長い方を残して短い方を落としており、実測では「宣言した path が落ちて、触るなと書いたビルド生成物が scope に残る」向きに外れた | **どちらが対象かを決めて、もう片方を本文から消して re-plan する。** 両方とも対象なら `--allow-questions` で進めてよい（両方入っている）。question の本文が2つの path を名指ししているので、判断は本文を開かずに済む |
| plan `status: partial` + `unconfirmed_lexical_dependency`（同上） | 生産者/消費者の推論が当たったが、根拠が**共有 topic token だけ**で共有 file が無かったので edge にしていない。**その2 Issue は同じ wave に入る** | **順序が要るなら述べる**（Issue 本文に `depends on #N`、または `--depends <consumer>:<producer>`）。要らないなら `--allow-questions` で進めてよい。散文の語が一致しただけで3 Issue が3 wave に直列化していたのが元の障害なので、**「独立である」が正しい答えであることが多い**。**edge が欲しいのに `--no-infer` を足さない** —— それは推論を丸ごと切るだけで、この question の答えにはならない |
| plan `harness_path_in_scope`（`severity: notice`。**`status` は落ちない** —— 他に blocking が無ければ `success` である） | Issue が `## 対象ファイル`（成果物見出し）に agent ハーネスの path（`.claude/skills/` / `.agents/skills/` / `.commandmate/`）を書いたので、**worker がそれを書き換えられる状態で dispatch される**。既定では入らない path が、明示宣言によって入っている。**ハーネスを成果物とする Issue では正常に出る**（第2節） | **その Issue の成果物が本当にハーネスなのかを読んで決める。** そうなら（このリポジトリ自身の Issue のように）そのまま進めてよい —— warning は宣言の記録であって停止ではない。そうでない（ただ「その runner を実行して通ること」を言いたいだけの）なら、**成果物見出しから path を消して散文か参考見出し（`根拠` / `参考`）へ移し、re-plan する**。移しても worker はその path を読める（`reference_files` に出る）。**審判を書き換えられる worker を「たぶん大丈夫」で送らない。`success` は「読まなくてよい」ではない** —— この行を読ませるために warning は残してある（#199） |
| plan `scope_pattern_declared`（`severity: notice`。**`status` は落ちない**） | Issue が成果物見出しの下で **glob / ディレクトリ**を宣言し、それがそのまま worker の `scope.allow` になる（[#219](https://github.com/Kewton/commandmate-skills/issues/219)）。plan は pattern を**展開しない**（working tree を開かない）ので、何 file を指すかは plan から読めない | **列挙された pattern を1つずつ、権限として読む。** `**` は階層を跨ぐ（`data/geo/**` は `data/geo/` 配下すべて）、`*` と `?` は跨がない、`{a,b}` は選択、`[` と `]` は literal、ディレクトリは配下すべて。広すぎるなら **Issue 本文の pattern を狭めて re-plan する**（`data/geo/**` → `data/geo/{landmarks,stations}/`）。妥当ならそのまま進めてよい —— warning は宣言の記録であって停止ではない。**変更 file ごとにどの pattern が許可したかは、裁定を行う CommandMate の scope ゲート側に残る** |
| plan `scope_pattern_dropped`（`severity: notice`。**`status` は落ちない**） | 成果物見出しの**外**（`## 根拠` / `## 参考` の配下、または見出しの外の散文）に書かれた glob / ディレクトリを、scope に入れずに落とした（#219）。0.31.0 までは backtick の中の glob だけが本文のどこからでも `scope.allow` に届いていたので、**その書き方をしていた Issue はここで scope が狭くなる** | **その pattern を worker に書かせたいのかを決める。** 書かせたいなら **`## 対象ファイル` へ移して re-plan する**（それが唯一の直し方である）。引用しているだけなら何もしなくてよい —— warning は「宣言として読まなかった」の記録である。**`unrecognized_file_extension` と混同しない**: 拡張子は正しく、位置だけが宣言になっていない |
| plan `prose_path_ignored`（`severity: notice`。**`status` は落ちない**） | 成果物見出しを持つ Issue が見出しの**外**にだけ書いた path を、scope に入れずに `reference_files` へ回した（CommandMate #3002）。worker はその path を読めるが書けない | **名指された path を worker に書かせたいのかを決める。** 書かせたいなら **`## 対象ファイル` の下へ書き足して re-plan する**（それが唯一の直し方である）。「差分 0」「触るな」と書いただけなら何もしなくてよい —— それがこの規則の狙いである。完了条件にしか書いていないテスト path は `acceptance_requires_tests_but_scope_has_none` と一緒に出ることがある（直し方は同じ） |
| plan `cycle_detected` / `override_incomplete` / `dependency_order_violation` | 依存グラフが実行不能 | `dependency-plan.md` の edge `reason`（どの方向語をどの行から読んだか）を見て、Issue 本文か `--depends` を直す |
| plan `run_exists` | **同じ既定 run_id に hash された run が既にある**（Issue 集合・Issue 内容・**profile 全体**・CLI option がすべて同じ、が典型）。「何も変えていない」とまでは断定できない —— 既定 profile の cwd `origin` 判定は hash の外にある（Issue #157） | エラーが指す既存の `plan.json` と突き合わせて、意図した plan かを確かめる。違うなら Issue 本文か profile を直す（**profile はどの field を編集しても別 run_id になる**）。同じでよいなら `--run-id <new-id>` / `--runs-dir <dir>` を渡す |
| plan `profile_repository_mismatch` | cwd の origin と profile の対象リポジトリが違う | `--profile` / `--profile-json` / `--repo` のどれかを渡して意図を明示する。**`--repo` を選ぶと `verified` が降格するので `--allow-unverified` も要り、次の行の notice が出る**（#210 以降、それで `status` は落ちない） |
| plan `profile_repository_override`（`severity: notice`。**`status` は落ちない** —— 他に blocking が無ければ `success` である） | `--repo` で profile の対象リポジトリを差し替え、`--allow-unverified` でその降格を受諾した run である。**`branch_template` / `worktree_template` / `base` / `baseline` は別のリポジトリで確認された値のまま**であり、この plan はそれらを検証なしで使う。`risk.level` は `high`、`profile.verified` は `false` | **その4項目がこのリポジトリで正しいかを確かめる。** 正しいなら進めてよい —— 2つの flag がその判断の記録であり、warning は記録の側である。恒常的にこのリポジトリを対象にするなら **`profile-init.mjs` で専用 profile を作って検証し、`--profile-json` で渡す**（[profile-contract.md](./profile-contract.md) 第7節・第8節）。そうすれば降格そのものが起きない。**`success` は「読まなくてよい」ではない** —— この行を読ませるために warning は残してある（#210） |
| dispatch `open_questions` + `human_required` | 未回答の question を持つ Issue がある | blocking reason に**質問の本文**が出ている。Issue 本文に回答を書いて re-plan する |
| dispatch `drift` | plan 承認後に branch / HEAD / 権限が動いた | drift の内容を確認し、必要なら re-plan する。**drift の上に dispatch しない** |
| dispatch `worktree_unresolved`（`stop_reason: drift`） | 対象 Issue の worktree が `commandmate ls` で解決できない（runner は `commandmate sync` を1度試したうえでの結論。`limitations` の `worktree_sync_ran` / `worktree_sync_unavailable` を見る）。**worker は1人も起動していない**（`task_id: null`・worker ログ無し） | **`cmate-worktree-setup` で worktree を作成し、同じコマンドで再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。plan と同じ profile（同じ `branch_template`）を使う。**Issue の分割や re-plan は不要** |
| dispatch `worktree_setup_unavailable`（`stop_reason: dispatch_error`） | `--prepare-worktrees` を指定したのに `cmate-worktree-setup` を呼べなかった（未 install / `--worktree-setup` 未指定 / launcher が起動不能） | **`cmate-worktree-setup` を install し、`--worktree-setup <launcher>` でその呼び出し口を渡して再実行する。** 準備段を使わないなら `--prepare-worktrees` を外し、従来どおり worktree を用意してから dispatch する |
| dispatch `worktree_setup_failed`（同上） | provider は動いたが result contract を返さなかった、または1件も作らなかった | provider の出力（blocking reason）を読んで原因を直し、同じコマンドで再実行する。**作成済みの worktree は削除していない**ので、再実行の対象は残りの Issue だけになる |
| dispatch `worktree_profile_mismatch`（同上） | provider が作った branch が plan の branch と違う（**profile の不一致**） | plan と `cmate-worktree-setup` に**同じ profile（同じ `branch_template`）**を渡す。既に作られた branch を使いたいなら、その branch を作る profile で plan を作り直す |
| dispatch `worker_method_unavailable`（`stop_reason: dispatch_error`） | `--worker-method <id>` を指定したのに、その Skill が対象 worktree に無い（`.claude/skills/<id>/SKILL.md` と `.agents/skills/<id>/SKILL.md` の**両方**が要る。detail が「無い」のか「片側だけ在る」のかを名指しする）。**worker は1人も起動していない** | **`commandmate skill install <skill-id>` で対象 worktree に入れ、同じコマンドをそのまま再実行する**（最初の Wave 前で止まった場合、`--out` は消費されていない）。方法論なしで走らせてよいと判断したなら `--worker-method` を外す。**Issue の分割や re-plan は不要** |
| dispatch exit 10（prompt 検出） | worker が人間の判断を求めている | `capture` の内容が report に出ている。**自分で判断して答える。** runner は自動応答しない |
| dispatch `verification_not_judged`（exit 99） | run が error / cancelled で**誰も判定していない** | **再 dispatch では解けない。** CommandMate 側のログを見る。判定していないものを worker に直させない |
| dispatch `worker_failed`（`--max-turns` 到達で未 commit。**blocking**） | worker が起動したが commit まで到達しなかった（worktree 未解決はこの code に落ちない。上の行）。**この code だけでは「なぜ無いのか」が分からない** —— worker が N ターン働いて何も産まなかったのか、1ターンも実行できなかった（上流障害）のかで**対処は正反対**である（[#220](https://github.com/Kewton/commandmate-skills/issues/220)） | **まず当該 worker の `worker_turn_evidence.code` を読む**（下の3行。exit 21 で cap に到達した run にだけ付く）。`worker_upstream_unavailable` なら **再 dispatch も Issue の分割も re-plan もしない** —— 待って `--resume` する。`worker_produced_nothing` なら worker ログを読み、指示が過大なら Issue を分割して re-plan する。`worker_output_unreadable` ならどちらとも決めつけず手で確かめる。**`worker_turn_evidence` が無い**（exit 20 側の cap・prompt・送信失敗など）なら prompt / worker ログを読む |
| dispatch `worker_upstream_unavailable`（`stop_reason: worker_failed` / `partial`。**blocking**。`worker_failed` の隣に出る） | `--max-turns` に到達したが、**worker が1ターンも実行できていない肯定的証拠がある**: transcript の末尾が同一の1行エラー3件以上、pane が上流エラー署名に一致、hooks が「投げたが `stop` が返っていない」と言っている、あるいは CLI 自身の `upstreamFault`。**この run はその Issue について何も測っていない**（実測: Kewton/CommandMate#1834。`API Error: 529 Overloaded` が13回連続し、report は「12 ターン働いて成果物が無い」と読めた） | **待って `dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`。** 上流の復旧が対処であり、**Issue の分割・書き直し・re-plan はいずれも間違った対処である**（直すものが Issue の側に無い）。`worker_turn_evidence.turn_durations_seconds` を見ると、全ターンが数秒で終わっていることが読める。裁定（`verification.outcome: fail` / `worker_state: failed`）は書き換えていない —— 足したのは「なぜ無いのか」だけである |
| dispatch `worker_produced_nothing`（同上） | 同じ cap だが、**ターンが成立した肯定的証拠がある**: transcript に tool 使用か非エラーの assistant 出力がある、hooks が最後の send のあとに `stop` を返している、pane に（枠や footer ではない）非空白・非エラーの出力がある。つまり worker は本当に働いたうえで commit も未 commit の変更も残していない | worker のログを読み、**Issue の粒度か指示の曖昧さ**を疑う。分割するか書き直して re-plan する。**同じ plan のまま `--resume` しても同じ所で止まる** |
| dispatch `worker_output_unreadable`（同上） | 同じ cap で、**どちらの肯定的証拠も得られていない**（`capture` が失敗した / pane が空白だけ / transcript が読めない・候補が2つ以上ある / hooks が無い） | **「働いて何も出なかった」とも「上流が落ちていた」とも読み替えない**（merge `change_evidence_unavailable`・timeout `worker_liveness_unreadable` と同型の規則）。`commandmate capture <worktree-id> --json` を手で叩き、Claude worker なら `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<cwd の非英数字を "-" に置換>/*.jsonl` の末尾を読む（detail が path-free な1行コマンドを載せている）。同一の1行エラーの連続なら上流、tool 使用があるならターンは成立している |
| dispatch `worker_stopped_with_report`（`stop_reason: worker_failed` / `partial`。**blocking**。`worker_failed` の隣に出る） | worker が監督 nudge の「指示どおりに書けないと分かったら、進めずに止めて報告してください。」に従って**止めて報告した**: nudge の後のターンが進捗なし（exit 21 / 新しい commit なし）で終わり、worker がその nudge への返答の文を返していた（`commandmate reply`、または `reply` の無い CLI では Claude の transcript から読む）。runner は**その時点で nudge を止めている**（`--max-turns` まで回していない）。報告の文は worker 記録の `worker_report.text` と detail にある（[#287](https://github.com/Kewton/commandmate-skills/issues/287)、[dispatch-contract.md](./dispatch-contract.md) 第2.12.1節） | **報告を読んでから決める**（owner: human）。書けない理由が Issue 側（対象ファイル・受入条件・指示の矛盾）にあるなら Issue を直して re-plan する。障害が解消済みなら `dispatch.mjs --plan <plan.json> --resume <この run の dispatch ディレクトリ>` で再開する。**報告の無い無進捗（`worker_produced_nothing` など）と同じ扱いにしない** —— こちらは worker が理由を言っている。報告を読めなかった run（`reply` が返答を返さない・`reply` の無い CLI で `capture` 失敗・Claude 以外・transcript が無い）にはこの code は出ず、従来どおり cap の3 code のどれかになる |
| dispatch `scope_unsatisfiable`（`stop_reason` は `verification_failed` か `worker_failed`。`partial`） | scope ゲートの**違反 path が2ターン連続で同一**だった。worker は同じ結論に到達しており、再送しても答えは変わらないので `--max-turns` を待たずに打ち切った（[dispatch-contract.md](./dispatch-contract.md) 第2.3.1節）。契約の `scope.allow` は **send 時 snapshot** なので、**worker 側には回復手段が無い** | **detail に違反 path がそのまま入っている。それを Issue の対象ファイルに足して re-plan する**（owner: human）。repo の規約（テスト配置・生成物・lockfile 等）なら profile 側に宣言する。**違反が 20 行を超えると detail は 20 行で切られ、`(+N more line(s) not listed here …)` が残りの件数を名乗る**（判定はいつでも全行で行っている。#164）—— 全件は `commandmate verify <worktree-id>` で読む。**同じ plan のまま `--resume` しても同じ所で止まる。** 裁定（`verification.outcome`）は fail のままで、これは書き換えていない —— 変わったのは run が先へ進まないことだけである |
| dispatch `stale_prompt_on_session`（`stop_reason: human_required` / `partial`。worker は `prompt`） | 最初の send の前に `capture --json` を読んだら、**前の回のターンが残した質問画面**（`isPromptWaiting`＝上流が読める質問 / `isSelectionListActive`＝読めない質問 UI・plan レビュー）が composer を塞いでいた。**何も送っておらず、質問にも答えていない**（[CommandMate#3007](https://github.com/Kewton/CommandMate/issues/3007)。実測: Kewton/Musunest#201・#204）。`--interrupt-stale-prompt` を付けていたなら、interrupt が失敗した・画面が戻らなかった・再読できなかったのどれかを detail が名指ししている | **`commandmate capture <worktree-id>` で画面を見る。** 終わったターンの質問なら **答えずに `commandmate interrupt <worktree-id>` で畳み**、`--resume` で送り直す（`--interrupt-stale-prompt` を付けて再実行すれば同じことを runner がやり、composer に戻ったのを確かめてから送る）。まだ意味のある質問なら人間が答えてから `--resume` する。**`--auto-yes` で押し通さない** —— その質問はこの run のものではない。interrupt しても戻らなかった場合は画面を見るまで送り直さない |
| dispatch `wait_window_exhausted`（`stop_reason: timeout` / `partial`。`worker_timeout` の隣に出る） | `--wait-timeout` は **`commandmate wait` の1回あたりの上限**であって worker の1ターンの上限ではない。timeout の時点で `capture` を1回叩いたところ、**worker はまだ稼働していた**（`worker_liveness` に `isRunning` / `sessionStatus` / 経過秒が入っている）。すなわち止まったのは**見ていた側**であって worker ではない（実測: Kewton/BorderFreeKidsMap #62。1ターン約40分に対して `--wait-timeout 1800`、worker はそのまま完走して commit を載せた） | **ここで再 dispatch しない。** 完成しかけの作業の上に2人目の worker を重ねることになる。worker が idle 化するのを待ってから **`dispatch.mjs --plan <plan.json> --reverify <その run の dispatch ディレクトリ>`** で送らずに裁定だけ取り直す（[SKILL.md](../SKILL.md) 第3.2節）。1ターンの実測に対して窓が恒常的に短いなら **`--wait-timeout` をその実測に合わせて上げる**。**timeout を「worker が死んだ」と読み替えない** |
| dispatch `worker_stalled`（同上） | 同じ timeout だが、`capture` は答えたうえで**稼働の証拠を1つも示さなかった**（`isRunning` / `isGenerating` / `isPromptWaiting` がすべて false） | worker のログと worktree を読む。**作業証跡（commit / 未 commit の変更）を確かめてから** `--resume` で再 dispatch する。**「動いていない」は「作業が無い」ではない** —— 未 commit の作業が在るなら、それを潰さないことが先である |
| dispatch `worker_liveness_unreadable`（同上） | 同じ timeout で、**`capture` 自体が読めなかった**（呼び出しが失敗した / 出力が想定外だった / boolean が1つも入っていなかった）。**生死はどちらも測れていない** | **読めなかったことを「動いている」とも「止まっている」とも読み替えない**（merge `change_evidence_unavailable` と同型の規則）。`commandmate capture <worktree-id> --json` を手で叩いて確かめ、動いていれば idle 化を待って `--reverify`、止まっていれば worktree を確かめてから `--resume` |
| dispatch `blocked_by_upstream_failure`（**`--schedule dag`**。`stop_reason` は原因側に付く。`partial`） | その Issue の依存が `completed` かつ `verification.outcome: pass` に到達しなかったので、**下流である当該 Issue を投入しなかった**（[dispatch-contract.md](./dispatch-contract.md) 第3.2節）。**この Issue の worktree は1度も駆動していない**（`worker_state: not_dispatched` / `task_id: null`）。**独立系列は止めていない** —— wave 方式ならその wave ごと止まっていた Issue が、この run では走り切っている | **上流の Issue を直してから `dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`。** blocking detail が上流の Issue 番号を名指ししている。上流が止まった理由は、その Issue 自身の停止 code（`worker_failed` / `verification_failed` / `worker_timeout` / …）を本表で引く。**この Issue 自体をデバッグしない** —— 何も送っていない |
| dispatch `schedule_halted_unattended`（**`--schedule dag --unattended`**。同上） | **この Issue の依存はすべて pass していた。** 別の Issue が green にならなかったので、無人運転として**新規投入をやめた**（人間が読む運転では下流だけを止め、この Issue は走っていた）。既に走っていた worker は最後まで見届けている | **失敗した Issue を直してから `--resume`。** この Issue には何も問題が無く、再開すればそのまま走る。**「下流だけ止める」側で運転してよいと判断したなら `--unattended` を外す** —— それは「止まった半分を読んで、続けてよいかを決める人間が居る」という宣言である |
| dispatch `verification_failed` / `worker_failed` / `timeout` で **一部の Issue だけ**落ちた | pass 済みの Issue と落ちた Issue が同じ run に混ざっている | 落ちた分を直したうえで **`dispatch.mjs --plan <plan.json> --resume <その run の dispatch ディレクトリ>`**。pass 済みは再 dispatch されず記録だけ引き継がれる（[SKILL.md](../SKILL.md) 第3.2節）。**re-plan は不要** |
| dispatch `invalid_input`（`--only` の依存違反。`stop_reason: dispatch_error`。exit 3） | `--only` で選んだ Issue が、**選ばれていない Issue に依存**している（`plan.dependencies`。`lexical` の辺は数えない。前回 attempt が pass させた依存を `--resume` で引き継ぐ場合は数えない）。**何も dispatch しておらず、`--out` も作っていない** | detail の「#N depends on #M」に従い、依存先を `--only` に足すか、依存元を外す。**全体を断っているので、直して同じコマンドを再実行してよい**（[dispatch-contract.md](./dispatch-contract.md) 第3.0.5節） |
| dispatch `invalid_input`（`--only` が plan に無い番号を名指し / 番号でない値。exit 3） | `--only` の値が `12,14,15` の形でない、または plan の Issue 番号に無い | detail が plan の Issue 一覧を出している。番号を直して再実行（何も dispatch していない） |
| dispatch `only_subset`（limitation。report の `plan_scope` と対） | 今回の run が plan の**一部だけ**を扱った（`--only`、または resume / reverify が前回の部分集合を引き継いだ） | 停止ではない。`deselected` は worker_state `not_dispatched`（note `excluded by --only`）で、失敗でなく未着手。続きは `--resume <dir> --only <残り>` |
| dispatch `invalid_input`（`--only` が human-only の Issue を名指し。exit 3） | `--only` に plan が human-only と印を付けた Issue が入っている（[#286](https://github.com/Kewton/commandmate-skills/issues/286)）。**何も dispatch しておらず、`--out` も作っていない** | その番号を `--only` から外して再実行する。人がやる Issue はどの run も dispatch しない |
| dispatch `plan_invalid`（全 Issue が human-only。exit 3） | plan の Issue がすべて `human-only` で、wave が空 | dispatch するものは無い。人の作業として進める |
| plan / dispatch `human_only_excluded`（notice / limitation） | `human-only` ラベルの Issue を dispatch の対象から外した | 停止でも失敗でもない。人の作業として進め、終わったら Issue を閉じる |
| plan `human_only_dependency`（blocking）/ dispatch `human_only_dependency`（limitation） | 依存側は human-only の Issue を待たずに plan され、送られた | 人の作業が終わったことを確かめてから依存側を merge する |
| dispatch `resume_plan_mismatch`（`stop_reason: dispatch_error`） | `--resume` 先の report が**別 plan**のものだった（`run_id` / repository / base 不一致） | その plan 自身の dispatch ディレクトリを `--resume` に渡す。新規に走らせるなら `--out` で始める。**何も dispatch していないので、直して同じコマンドを再実行してよい** |
| dispatch `resume_invalid`（同上） | `--resume` 先の report が `dispatch-report.v1` として読めない（schema version 違い / JSON 破損） | detail が「何がどう合わないか」を名指ししている。報告どおりの report を指すか、`--out` で新規 run にする。**壊れた report を半分だけ信じて引き継がない** |
| dispatch `verify_concurrency_limited`（limitation。`--reverify --verify-concurrency <n>` のとき） | 再判定を同時 n 件までにして走らせた、という記録。判定の中身は変えていない | 対応不要。負荷起因で落ちるゲートを直列に確かめたいときに `--verify-concurrency 1` を足して `--reverify` をやり直す。`--reverify` 無しの `--verify-concurrency` は `invalid_input` |
| dispatch `resume_no_work`（`status: success`） | 再実行対象が1件も無い（全 Issue が completed かつ pass） | 停止ではない。その attempt の report をそのまま merge / uat に渡す |
| dispatch `contract_unsupported` + `require` | CLI が実行契約に非対応 | CommandMate を 0.17.0 以上に上げるか、弱い裁定を承知のうえで `auto` に落とす。**`--unattended` の run では `auto` は選べない**（`require` を含意する。落とすなら `--unattended` を外して人間が読む運転に戻す） |
| dispatch `contract_scope_unknown`（`stop_reason: dispatch_error`。**`--unattended` のとき**） | 対象 file を1件も宣言していない Issue が plan に在る。**1人も dispatch していない**（`--out` も未作成） | **Issue 本文に対象ファイルを書いて re-plan する。** フラグ無しの run では同じ Issue が wave の中で1人ずつ拒否される（そのときは他 Issue の worker が既に走っている）。無人ではその始末をする読み手が居ないので、pre-flight で全 Issue を検査している |
| dispatch `contract_scope_dropped`（`stop_reason: dispatch_error`。**`--unattended` のとき**。フラグ無しでは limitation で続行） | 対象 file を**宣言しているのに、その一部が実行契約に入らない** Issue が plan に在る。`contract_scope_unknown`（scope が空）とは別で、**scope は在るが宣言より狭い**。無人では **1人も dispatch していない**（`--out` も未作成） | **detail が落ちた path と理由を名指ししている。理由で直し方が変わる。** `over_bound`（件数上限 200 超過）なら **Issue を分割する** —— 200 は CommandMate 側の契約上限なので runner の flag では上げられない。それ以外（`too_long` / `absolute` / `drive_letter` / `backslash` / `parent_escape` / `nul_byte`）は**その path 1件の形の問題**なので、200 字以内の repository-relative な path に書き直す。どちらも直して re-plan する。フラグ無しの run では Issue は**狭い権限のまま dispatch される**ので、**その run の pass は「宣言どおりの scope で通った」ことを意味しない** |
| dispatch `unattended_locked`（同上） | 同じ worktree を**別の dispatch run が動かしている**（`--out` も未作成・`human_required: false`） | **先行 run の終了を待って、同じコマンドをそのまま再実行する。** lock が残り続けるなら所有 run の pid が生きているかを確認する（`kill -9` された run の lock は次の run が自動で回収する）。lock は `$CMATE_ORCHESTRATE_LOCK_DIR`（既定 `$TMPDIR/cmate-orchestrate-locks/`）に置かれる |
| dispatch `wall_clock_budget_exhausted`（`stop_reason: timeout` / `partial`） | `--wall-clock-budget` に到達して打ち切った。**成功ではない** | 何に時間を使ったかを確認する（**profile baseline と acceptance コマンドは自前の timeout を持たない**ので、まずそこを疑う）。原因を潰すか budget を実測に合わせてから **`--resume` で再開する**。**打ち切りを success に丸めない** |
| merge `ci_failed` / `ci_pending` | CI が green でない | CI を直す。**green 無しに merge しない** |
| merge `pr_missing` / `merge_failed` | PR が無い / conflict | PR の状態を確認し、conflict は手で解消する |
| merge `pr_title_undetermined`（**profile に `pr_title_template` があるとき**。`stop_reason: pr_create_failed` / `partial`） | 型が使う `{{type}}` / `{{scope}}` がブランチのコミット件名から決まらない（件名が `type(scope): …` の形でない・コミットが無い・コミット間で食い違う・scope が無い）。**その PR は作っておらず、push もしていない**（CommandMate#3005） | detail が名指しした件名を worktree で `type(scope): description` に直し（`git commit --amend` / rebase）、`--create-prs` を再実行する。**型を推測して PR を立てない** |
| merge `issue_autoclose_not_default_branch` | base がデフォルトブランチでない | merge 後に **Issue を手動でクローズする** |
| merge `integration_verify_failed`（**`--integration-verify`**。`stop_reason: merge_failed` / `partial`） | **合流後の統合ブランチで、profile の検証集合（`integration_verify.source` が `integration_baseline` か `baseline` かを名指す。[#195](https://github.com/Kewton/commandmate-skills/issues/195)）が赤い。** 各 PR の CI は green だったが、それらは**兄弟 PR が入る前の base** で走ったものである（[#175](https://github.com/Kewton/commandmate-skills/issues/175) の実測）。merge 自体は成功しており、赤いのは**合流の結果**である | **既に merge 済みなので、この phase の再実行では戻らない。** 統合ブランチを green にする（前進修正、または revert）まで **次の wave を dispatch しない**（`integration_verify.outcome` が `fail` の間は barrier が満たされていない）。この code は **file 重なりに出ない意味的衝突**の徴候なので、同じ wave の Issue が**同じデータ・同じ前提を別方向へ動かしていないか**を読む（owner: human）。**「PR 個別の CI は緑だったのだから大丈夫」で押し通さない** |
| merge `caller_index_lock_pre_existing` / `caller_index_lock_appeared`（**stop_reason は動かない。`status` も動かない**） | **merge が成功したあと、呼び出し元 worktree に `index.lock` が残っていることがある**（[#222](https://github.com/Kewton/commandmate-skills/issues/222)。実測: 0 バイト・約40分と約52分放置・`pgrep -fl 'git '` に該当なし・手で消して復旧、が同日2回）。症状は**後続の `git pull --ff-only` が `error: Unable to create '.../index.lock': File exists.` で落ちる**ことである | **まず `merge-report.json` の `integration_verify.outcome` と各 target の `merged` を読む。** **そこが pass / merged なら merge は壊れていない —— 巻き戻すと二重に壊す**（merge も統合検証も済んでいる）。そのうえで `caller_worktree.index_lock_after` を見る: 非 null なら、(1) `size` が 0 か、(2) `mtime` が run の期間内か、(3) `pgrep -fl 'git '` に該当が無いか、を確かめ、**3つとも満たすときだけ人間が手で消す**（`rm <caller_worktree.index_lock_after.path>`。path は run の cwd からの相対である）。**runner は消さない** —— 保持中の lock を消すと、それが守っていた index が壊れる。`pgrep` に該当が在るなら**待つ**（消さない）。`caller_index_lock_pre_existing` なら**この run より前から在った**ので、原因はこの run の外に在る（agent harness / IDE の git 連携 / git status のポーリング等。**コードだけでは特定できない**）。次に踏んだら `stat` の mtime・run の開始/終了時刻・`ps -o etime,command -p <pid>`・その worktree で動いていた他プロセスを残すこと（owner: human） |
| merge `integration_verify_unavailable`（同上） | 統合検証を実行できなかった。3通りあり、`integration_verify.source` が (a) と (a') を分ける（[#195](https://github.com/Kewton/commandmate-skills/issues/195)）: **(a) `source: "baseline"` —— `integration_baseline` 未宣言で、`baseline` も空**（`stop_reason: preflight_failed` / `failure`。**1件も merge していない**）／**(a') `source: "integration_baseline"` —— `"integration_baseline": []` が宣言されている**（＝「統合検証の定義は無い」。同じく merge 前に停止。`baseline` の有無に関わらず落ちる）／**(b) merge 後の probe が失敗した**（`git fetch` / `rev-parse` / 検証用 checkout。`stop_reason: merge_failed` / `partial`。**merge は済んでいる**） | (a) **profile に `baseline` を書いて同じコマンドを再実行する**（合流後を別集合で判定するなら `integration_baseline` に書く）。世界は動いていないので取り消すものは無い（統合検証をしない運転に戻すなら `--integration-verify` を外す）。(a') **`baseline` へは落とさない。** 合流後の「合格の定義」を `integration_baseline` に書くか、`baseline` を流用してよいなら **key ごと消す**（未宣言に戻せばフォールバックが効く）。**「`baseline` を宣言しろ」は誤った案内である** —— 意図して書いた宣言を取り消せという意味になる。(b) **merge は済んでいるのに結果を測れていない。** remote 到達性 / base の解決 / worktree 作成の失敗要因を直し、**統合ブランチで同じ検証集合を手で1回通してから**次の wave へ進む（owner: operator） |
| uat `acceptance_conditional` | 受入判定が `conditional_go` | **条件を読んで人間が判断する。** 自動修正の対象ではない |
| uat `blocked` / `max_attempts_reached` | 上限まで直しても不合格 | `unresolved_issues` と `next_actions` を読む。**success に丸めない** |
| uat `acceptance_not_run` | 意味ゲートを掛けずに baseline だけで裁定した | cmate-acceptance-test を入れて result を用意し、必要なら `--require-acceptance` で必須にする |
| dispatch `verification_gates_unrecorded`（**`--unattended` では blocking**。`stop_reason: dispatch_error` / `partial`） | 契約 pass なのに `GATE <id> PASS\|FAIL` 行を1本も読めず、**pass の根拠を report が名指しできない**。裁定（exit code）は pass のままで、次の wave を dispatch せずに停止した | **まず runner の版を疑う。** `GATE <id> PASS\|FAIL` 行は **stderr に出る**（実測: CommandMate 0.22.2 の verify-runner `reportGates`）のに、0.26.0 までの dispatch は **stdout しか読んでいなかった** —— 契約経路で pass した run の `gates` は常に空になり、**再実行しても必ず同じ所で止まる**（[#160](https://github.com/Kewton/commandmate-skills/issues/160) で両方の stream を読むよう修正）。修正版でも空なら、その run が本当に `GATE` 行を出していないということなので、`commandmate wait <worktree-id> --verify` を手で回して stderr を確かめる。人間が読む運転に戻すなら `--unattended` を外せば従来どおり limitation として続行する。**根拠の無い pass の上に無人 merge を積まない** |
| merge `change_evidence_unavailable`（**`--unattended --create-prs` では blocking**。`stop_reason: pr_create_failed` / `partial`） | branch の実変更を読めず、宣言 scope と対比できない。PR は**開いていない**（本文も書いていない） | 対象 Issue の worktree を復旧して `git diff <base>...<branch>` が答える状態にしてから再実行する。**「読めなかった」を「scope 内だった」と読ませない** |
| merge `acceptance_gates_required` / `no_acceptance_criteria`（**`--unattended --merge-prs`**。`stop_reason: preflight_failed` / `failure`） | 無人 merge の対象 Issue に**受入ゲートブロック（```acceptance-gates）／受入条件が無い**。**1つも merge していない**（条件を満たす Issue も含めて） | **Issue 本文に書いて re-plan する。** 該当 Issue だけを除外して回す道は用意していない（対象集合を黙って縮めないため）。人間が読む運転に戻すなら `--unattended` を外す |
| uat `unattended_cwd_detached` / `unattended_cwd_branch_mismatch`（**`--unattended --create-uat-fix-worktrees`**。`stop_reason: preflight_failed` / `failure`） | 再merge（`git merge --no-ff`）は **invocation cwd の branch** に入るのに、cwd が detached HEAD だった／`--expect-branch` と違う branch だった。**fix worktree を1つも作らず、fix worker を1人も送らず、再merge を1度もしていない** | **invocation cwd を `--expect-branch` の integration branch に checkout してから**再実行する。detached のままだと「merged」と報告されながら成果がどの branch にも残らず、base branch のままだと review を経ずに入る（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測） |


## 5. 無人 run を取り消す（`unattended_baseline` の読み方）

`--unattended` の run は、dispatch した worktree ごとに開始時の HEAD を
`limitations` の `unattended_baseline` に **branch 名と短縮 SHA** で残す。取り消しはそれを起点に、
**上流から順に**行う。

1. `git reset --hard <sha>`（worktree が残っている場合）。
2. worktree が既に片付いていれば **`git branch -f <branch> <sha>`**。
   `git reset` は exit 128 で使えない。**baseline を branch 名で書いてあるのはこのためで、
   絶対 path では手が届かない。**

**この起点が担保するのは worktree branch の1段だけである。** 次の4つでは足りない
（[#115](https://github.com/Kewton/commandmate-skills/issues/115) の実測）:

1. **untracked file は `git reset --hard` で戻らない**（`.commandmate/tasks/*.yaml` を含む）。
   完全に戻すには `git clean -fdx` が要るが、それは worker の成果物も消す ——
   **無人で機械にやらせる操作ではない。**
2. **既に merge / push されていたら戻らない。** 下流から先に取り消す（PR を close し、
   remote branch を消し、必要なら revert PR を立てる）。**force push で歴史を消さない。**
3. **worktree が片付いていると `git reset` は使えない**（上の 2）。
4. **branch も消えて `git gc --prune=now` が走ると object ごと消える。** baseline が base branch から
   到達可能なら生き残るので、危ないのは **baseline が base から到達できないとき** ——
   `--prepare-worktrees` が既存 worktree を再利用した場合や、前の run の commit の上に
   baseline が乗っている場合である。

**取り消せるのはリポジトリの状態であって、送られた通知ではない。** push は対象リポジトリの CI を
起動し（実行時間・課金・通知）、PR 作成は reviewer に通知を出す。

`worktree_setup_unavailable` / `worktree_setup_failed` / `worktree_profile_mismatch` と
`resume_attempt` / `resume_no_work` / `resume_invalid` / `resume_plan_mismatch` / `only_subset`、
そして `scope_unsatisfiable` / `contract_scope_dropped` / `harness_path_in_scope` /
`ambiguous_file_candidate` / `unconfirmed_lexical_dependency` /
`open_question_declared` / `open_question_block_invalid` /
`integration_verify_failed` / `integration_verify_unavailable` /
`wait_window_exhausted` / `worker_stalled` / `worker_liveness_unreadable` は、
この表には在るが **status runner の hint map にはまだ無い**（`status.mjs` は別 Issue で追随する。
`contract_scope_dropped` については `status.mjs` が #161 / #162 の宣言 scope の外だった。
`harness_path_in_scope` も同じく [#177](https://github.com/Kewton/commandmate-skills/issues/177)
の宣言 scope の外である —— なお `status.mjs` は plan の warning を **severity に関わらず全件
そのまま列挙する**ので、[#199](https://github.com/Kewton/commandmate-skills/issues/199) 後も
notice が status 出力から消えることはない（`status.mjs` は `severity` を読んでいない。読ませるのは
別 Issue）。`ambiguous_file_candidate` / `unconfirmed_lexical_dependency` は
[#182](https://github.com/Kewton/commandmate-skills/issues/182) の、`integration_verify_*` は
[#175](https://github.com/Kewton/commandmate-skills/issues/175) の、timeout の生死3 code は
[#179](https://github.com/Kewton/commandmate-skills/issues/179) の宣言 scope の外である。
`open_question_declared` / `open_question_block_invalid` も同じく
[#178](https://github.com/Kewton/commandmate-skills/issues/178) の宣言 scope
（planner の `orchestrate.mjs` だけ）の外である —— **運転で人間が出会う停止は
dispatch 側の `open_questions`** であり、そちらは hint を持っていて question の本文
（＝著者が書いた問いの原文）をそのまま出すので、実害は status runner の1行だけである。
#182 は `status.mjs` に在る `shadowed_file_candidate` の hint —— 「候補から落ちた」と述べる
1行 —— を**古くしている**: planner はもう落とさないし、その code も出さない。文面としては
「Issue 本文で path を完全形で書き直す」が今も対処として正しいので、実害は
「落ちた」の一語だけである。
なお #175 の停止は `stop_reason` としては既存の `merge_failed` / `preflight_failed` に載るので、
status runner はそちらの hint（conflict の解消 / gh・base の復旧）を引く —— **その1行では
足りない停止**なので、`blocking_reasons` の code と `summary_markdown` の「統合検証」節を読むこと。
#179 も同様に `status.mjs` は既存の `worker_timeout` の hint を引き続き出すので、**timeout で
あることは読めるが「どちらの timeout か」は dispatch report の blocking detail と
`worker_liveness` を読む**）。
それまで `status.mjs --run` はこれらを「detail と `summary_markdown` を読む」に落として表示する。
**推測で別の対処を出さない**のが status runner の約束なので、これは劣化ではなく既定の振る舞いである。
dispatch report の `summary_markdown` には上表と同じ next action が出ている。


## 6. 準備 runner（read-only）の warning code

`profile-init.mjs --check` と `inspect.mjs --check-references` は run を進めない
**準備 runner** である。読むものが run artifact ではない（前者は profile、後者は Issue 本文と
対象リポジトリの tree）ので、上の5節までとは別の語彙を持つ。**両方に共通する規律は
「所見は warning であって error ではない」「exit code を1つも変えない」「裁定しない」**である。

### 6.1 profile-init `--check` の warning code（[#197](https://github.com/Kewton/commandmate-skills/issues/197)）

`profile-init.mjs --check <profile.json>` は run artifact ではなく **profile** を読む
準備 runner なので、上の5節（run の停止と復帰）とは別の語彙を持つ。**この節の code は
1つも exit code を変えない。**

| code | 意味 | 人間が何をするか |
|---|---|---|
| `companion_when_unmatched` | その規則の `when` が `--repo-root` 配下の**実ファイルに1件も一致しなかった** | テンプレートが tree より狭いのか（`{base}` は 1 segment、`{dir}{base}` は subtree 全体）、まだ作っていない file の宣言なのかを決める。**後者なら正しい状態である** |
| `companion_add_missing` | `when` は一致したが、その `add` が展開した path が**1件も実在しない** | 規則の両側が同じ配置を指しているかを見る。伴走ファイルをこれから作るなら正しい状態である |
| `tree_scan_truncated` | 走査が上限（20000 file / 4000 directory）に達した | 件数を**下界**として読む。規則が対象にしている subtree へ `--repo-root` を寄せて取り直す |

**3つとも warning であって error ではない。** 0 件一致は「誤り」ではない —— これから作る
file を見越した宣言はありうる —— ので、`status` は `partial` になるが **exit は 0** である
（[profile-contract.md](./profile-contract.md) 第9.7節）。宣言が契約に適合しているか自体の
裁定は planner 側にあり、そちらは `load_error`（exit 6）で止まる。

`--check` は run directory を持たないので、**`status.mjs` はこれらの code を表示しない。**
profile のレビュー時に envelope（または `summary_markdown`）を直接読むものである。

### 6.2 inspect `--check-references` の warning code（[#217](https://github.com/Kewton/commandmate-skills/issues/217)）

`inspect.mjs --check-references` は run artifact でも profile でもなく **Issue 本文と
対象リポジトリの tree** を読む準備 runner なので、これも run の語彙とは別である。
**この節の code も1つも exit code を変えない。**

| code | 意味 | 人間が何をするか |
|---|---|---|
| `reference_file_missing` | 本文が引く `path:line`（または行数を主張している path）の **file が対象 tree に無い** | path の綴りか、その file を動かした先行 Issue を確認する。**本文を直して re-plan する**（run_id は本文を含む hash なので自動的に別 run になる） |
| `reference_line_out_of_range` | `path:N` の N が**実測の行数を超えている**（`measured` 付き） | 先行 Issue がその file を縮めている。実測を正として本文の行番号を取り直す |
| `reference_identifier_moved` | 同じ行の backtick 識別子が **N 行目に無く、別の行にある**（`found_at` 付き） | `found_at` が実測行である。本文の `:N` をそこへ直す。**完全一致は要求していない**ので、識別子が近傍へ移っただけでも出る |
| `reference_line_count_stale` | `<path>（N 行）` の N が実測と違う（`claimed` / `measured` 付き） | 受入条件が「着手前と同じ N」の形になっていないかを確かめる。**なっていれば、直さない限り「先行 Issue が足した分を消す」が正解になる** |
| `reference_claim_inconsistent` | **本文の中で主張が食い違っている**（同一 path に2つの行数主張、または同一 `path:line` に2つの識別子） | どちらが著者の意図かは runner には決められない。本文を読み、実測を正として1つに畳む |

**5つとも warning であって error ではない。** 本文が古いことは「dispatch してはいけない」
ことではない —— 人間が読んで決めることである。`status` は `partial` になるが **exit は 0**
である。**読めない入力**（`--repo-root` が無い / Issue が取れない / `--ref` が解決しない）は
これらとは別で、`load_error`（exit 6）か `invalid_input`（exit 3）で**点検せずに拒否**し、
envelope の `inspection` は `null` になる（「見て何も無かった」と「見られなかった」を
同じ形にしない）。

出さない所見が2つある。**同じ行に照合できる識別子が無い citation**（`unchecked`）と、
**識別子が file の中に1度も現れない citation**（`identifier_absent`）は、件数として
report には出るが warning にはならない。後者で「移動した」と言うのは、その語が
この file の識別子だという**前提そのものが測れていない**まま下す裁定である。

**本文の意味的な矛盾は対象外である**（上の `reference_claim_inconsistent` が見るのは
機械的な部分集合だけである）。「決定事項」と「受入条件」が矛盾している類は
`cmate-issue-refinement` Step 4 が読む。

`--check-references` は run directory を持たないので、**`status.mjs` はこれらの code を
run view に表示しない。** ただし `NEXT_ACTION_HINTS` には5件とも入っている ——
表に無い code は `UNKNOWN_CODE_HINT` に落ちるので、「まだ誰も分類していない code」と
「表示する場所がまだ無い code」が同じ形になってしまうためである。

### 6.3 inspect `--evaluate-gates` の code（[#218](https://github.com/Kewton/commandmate-skills/issues/218)）

`inspect.mjs --evaluate-gates` は **Issue が宣言した受入ゲートを base で先行実行**する。
`--check-references` と同じく run の語彙とは別で、**この節の code も1つも exit code を変えない。**

| code | severity | 意味 | 人間が何をするか |
|---|---|---|---|
| `acceptance_gate_already_satisfied` | warning | 宣言した gate が **base で全回 exit 0** だった | **その条件はゲートとして働かない**（直しても直さなくても緑）。何が変われば赤から緑に変わるのかを書き直して re-plan する |
| `acceptance_gate_nondeterministic` | warning | 実行ごとに判定（または exit code）が変わる | 出力に時刻・乱数・並び順が混ざっていないかを見る。着手後も安定して通らないので、そのままでは完了を判定できない |
| `acceptance_gate_not_evaluable` | **notice** | **測れなかった**（`reason` 付き） | `reason` を読む。**「通った」にも「落ちた」にも丸めない。** notice のまま dispatch すると、その条件は誰にも判定されない |

`acceptance_gate_not_evaluable` の `reason` は6つある。

| reason | 意味 |
|---|---|
| `gate_id_unresolved` | `require:` の id が `.commandmate/verify.yaml` に無い（dispatch も同じ集合で解決するので、この Issue は `acceptance_gate_id_unknown` で send 前に止まる） |
| `gate_id_builtin` | `work-evidence` / `scope` —— CommandMate が判定する built-in で、この tree に走らせるコマンドが無い。**解決できる id であることと測れる id であることは別である** |
| `verify_config_unreadable` | `.commandmate/verify.yaml` が読めない（`readVerifyConfigGates` は fail-closed で、部分的な id 集合を返さない） |
| `block_invalid` | ```acceptance-gates ブロックが読めない。planner も同じ理由で `acceptance_gate_block_invalid` を出す |
| `repo_root_not_base` | `--base` が指す revision と `--repo-root` の HEAD が違う。**この場合コマンドは1つも実行しない** |
| `timeout` | gate の `timeoutSec`（既定 600 秒）を超えた。**超過した回で repeat を打ち切る**ので `runs[]` は1件になる |

**`failing_at_base` は code を持たない。** 着手前に落ちているのは受入条件が正しく書けている
ということであり、報告すべき所見ではない —— `evaluation.gates[]` に記録は残る。

`already_satisfied` / `nondeterministic` が1件でもあれば `status: partial`。`not_evaluable` だけなら
`status: success`（notice は色を変えない。planner の `severity: notice`（[#199](https://github.com/Kewton/commandmate-skills/issues/199)）と同じ規約である）。
**どちらも exit 0 である。**

**読めない入力・汚れた tree は点検せずに拒否する。** `--repo-root` が clean でない / git checkout でない、
`--repeat` が範囲外、mode を2つ渡した、は `invalid_input`（**exit 3**）で、**コマンドを1回も実行しない**。
`--base` が解決しないのは `load_error`（exit 6）。envelope の `evaluation` は `null` になる。

> Issue #218 本文は dirty tree を「`invalid_input` / exit 2」と書いているが、本 package では
> exit 2 は `not_implemented` が取っており `invalid_input` は6 runner すべてで exit 3 である
> （[#217](https://github.com/Kewton/commandmate-skills/issues/217) が同じ点を実測で確定させた）。
> **実装済みの規約を正とした。**

`--evaluate-gates` も run directory を持たないので `status.mjs` は run view に出さないが、
`NEXT_ACTION_HINTS` には3件とも入っている（第6.2節末尾と同じ理由）。

## 7. merge 後の観測 runner（`observe.mjs`）の code（[#221](https://github.com/Kewton/commandmate-skills/issues/221)）

`observe.mjs` は run を進めない。merge のあとに base branch の上で、profile が宣言した観測
（`observations`）を N 回集めて残すだけの runner である。契約の正本は
[observe-contract.md](./observe-contract.md)。

**この節の code はどれも「観測が達成されたか」を言わない。** この runner は**裁定しない** ——
`status` は**観測の完了度**（`success` = 全観測が `--runs` 件揃った / `partial` = 揃わなかった・
観測不能があった / `refused` = 1件も観測していない）だけを表し、report のどこにも
`pass` / `fail` の語は出ない（唯一の例外は GitHub の `conclusion` の逐語転記で、
それは常に `conclusion` という名の key の下に在る）。

### 7.1 拒否（**blocking**。1件も観測せず、`issues` は `null`）

| code | severity | exit | 何が起きたか | 人間が何をするか |
|---|---|---|---|---|
| `approval_required` | **blocking** | 2 | `--comment` を `--approve` 無しで渡した。**この package で runner が GitHub に書く初の経路**なので、入力を読む前・最初の `gh` の前に拒否する | 観測だけなら `--comment` を外して同じコマンドを回す（`--out` は消費していない）。書いてよいなら両方を付ける。**書くのはコメントだけで、Issue 本文は触らない** |
| `observations_undeclared` | **blocking** | 3 | profile が観測を1件も宣言していない（key が無い、または `[]`） | `observations` を profile に書く（[profile-contract.md](./profile-contract.md) 第12節）。merge 済みで re-plan できないなら `--profile <path>` で profile file を直接読ませる |
| `nothing_merged` | **blocking** | 3 | 渡された merge report に `merged: true` の target が1件も無い | base branch が動いていないので merge 後の状態が無い。**実際に merge した run の report を渡す** |
| `invalid_input` | **blocking** | 3 | 引数不正。`--runs` を渡していない場合を含む（**既定値は無い**） | 何件に基づく数字かは人間が決める。3 run と 8 run で結論が逆になった実測があるので、`--runs` は明示する |
| `out_exists` | **blocking** | 4 | `--out` が既存 | 別の `--out` を渡す。既存の観測を上書きしない |
| `load_error` | **blocking** | 6 | plan / merge report / profile / `--inspect` が読めない、または profile の `observations` 宣言が契約に適合しない | detail が拒否理由を名指している。profile 側の拒否一覧は [profile-contract.md](./profile-contract.md) 第12.3節 |

### 7.2 limitation（**notice**。止めていないが、数字の読み方を変える）

| code | severity | 何が起きたか | 人間が何をするか |
|---|---|---|---|
| `not_observable` | notice | その Issue の `mergedAt` が読めず、**観測の窓を開けられなかった**。`observable: false`・`observations: []` | `gh pr view <pr> --json mergedAt,mergeCommit` を手で叩いて認証と PR 番号を確かめる。**窓の始まりは推測しない** —— 捏造した始まりは、その merge が起こしていない run をその merge に帰属させる |
| `observation_incomplete` | notice | `--runs` に足りない件数しか集まっていない。**集まった分は出ている** | run が溜まってから取り直すか `--max-wait` で待つ。**中央値だけを読まない**（実測: 3 run の中央値が「未達」、8 run の中央値が達成） |
| `observation_unavailable` | notice | その観測を1件も集められなかった（`gh run list` / jobs API / checkout が答えなかった） | detail の理由を潰して取り直す。**「観測できなかった」を「変化が無かった」と読み替えない** |
| `observations_from_profile_file` | notice | 宣言を plan ではなく `--profile` の profile file から読んだ | plan と file は違いうる。**何を測ったのかは report の `observations_declared` を読む**（[observe-contract.md](./observe-contract.md) 第4.2節） |
| `baseline_unavailable` | notice | `--inspect` の文書に同 id の数値が無く、着手前の値が `null` である | **artifact についての事実であって欠陥ではない。** 差分が要るなら着手前の値を持つ文書を渡して取り直す（観測そのものは揃っている） |
| `comment_not_written` | notice | 観測の要約を Issue にコメントできなかった | **観測は失われていない**（`--out` 配下に report と summary が在る）。認証・権限を潰して回し直すか、`observe-summary.md` を手で貼る |
| `observe_tree_left` | notice | `kind: command` の使い捨て checkout を削除できなかった | `--out` 配下に残っている。`git worktree remove --force <dir>` で消す。**観測の数字は変わらない** |

### 7.3 `status.mjs` はこの report を run view に表示しない

observe の出力先は `--out` であって run directory とは限らず、status の phase モデルは
plan → dispatch → merge / uat である。**この report は単独で読むものである**
（[observe-contract.md](./observe-contract.md) 第11節）。

ただし **`NEXT_ACTION_HINTS` には本 runner が新設した10 code がすべて入っている**
（第7.1節の6件のうち `invalid_input` / `out_exists` / `load_error` は他 runner と共有の code で、
本 Issue が新設したものではない）。表に無い code は `UNKNOWN_CODE_HINT` に落ちるので、
「まだ誰も分類していない code」と「表示する場所がまだ無い code」が同じ形になってしまうためである
（第6.2節末尾と同じ理由）。
