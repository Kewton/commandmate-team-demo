# 未決の問い記法 v1（`open-questions` ブロック）

**この文書が記法の正本である。** 記法の形は
[acceptance-gates-notation.md](./acceptance-gates-notation.md) と**同型**であり、
YAML subset・違反の扱い・変更規約はそちらの第3節・第7節・第10節を**そのまま適用する**。
ここに書くのは、そこから変わる部分（info string・key・意味）と、
**なぜ見出しではなくブロックなのか**だけである。

この記法を運用するのは 3 つである。読んで裁定するのは 1 つだけで、残りは書く側である。

| 実装 | 役割 |
|---|---|
| `scripts/orchestrate.mjs`（planner） | ブロックを **構文だけ** parse し、1 件につき 1 件の blocking question を `plan.issues[].questions` に載せる |
| `cmate-issue-refinement` | blocking な open question からブロックを組み、`open_questions_block` として出力に載せる（貼るのは人間） |
| `cmate-issue-authoring` | 起案する Issue 本文にブロックを埋め、`open_questions[]` との一致を `validate-plan.mjs` が検査する。同 script は上の reader の逐語の写しを持つ |

dispatch は**この記法を知らない**。question は既存の open question ゲートに乗るので、
`--allow-questions` 無しにはその Issue を送らない —— 新しい停止経路も新しい緩和フラグも
足していない。

---

## 1. 何のための記法か

Issue 著者が「**これはまだ決めていない**」と宣言するためのものである。

planner が立てる他の question（`no_acceptance_criteria` / `no_suspected_files` /
`acceptance_requires_tests_but_scope_has_none` / `ambiguous_file_candidate` /
`unconfirmed_lexical_dependency`）はすべて **planner が本文から読み取れなかったこと**の
報告であり、不在についての推論であるから偽陽性がありうる。本記法が運ぶのはその逆で、
**決めていないと書いた人自身の事実の申告**である。planner が計算しても答えは出ない。

止まらないまま dispatch すると、worker は本文の他節から推測するか、自分で決める。
どちらに転んだかは diff を読むまで分からない。
**最も強い停止理由が、機械に読まれないまま通過していた**というのが
[#178](https://github.com/Kewton/commandmate-skills/issues/178) である。

実測（2026-08-10、利用リポジトリ Kewton/BorderFreeKidsMap#63）:
「## 未決の問い」3 件を残したまま plan → `questions: []`、dispatch は止まらない。
3 件を「## 決定事項（着手前に決めた。日付）」へ書き換えて re-plan したら、
worker はコメントに理由まで書いてそのとおり実装した。

---

## 2. ブロックの形

Issue 本文に、info string が `open-questions` の fenced code block を**ちょうど 1 つ**置く。

````markdown
```open-questions
version: 1
questions:
  - 座標変換を保存時に行うか、描画時に行うか
  - 旧実装の `src/legacy/topo.ts` を残すか、この Issue で消すか
```
````

- **`questions:`** — 着手前に決めるべき事柄の列挙。**自由文**である。
- 順序は**著者が書いた順のまま** question に載る。契約は Issue の写しであって
  再エンコードではない、という acceptance-gates 記法 第2節の原則の帰結である。

---

## 3. 規則

acceptance-gates 記法 第3節の表を継承し、次の 3 行だけが異なる。

| 規則 | 内容 |
|---|---|
| key | `version` と `questions` のみ。それ以外は syntax error |
| 値 | `questions` の各項目は**自由文**（gate id のような pattern は無い）。空文字は error |
| 個数上限 | `questions` は最大 32 件。**完全一致の重複は error** |

継承する規則（要点のみ再掲。正本は acceptance-gates 記法 第3節）:

- 本文中に**ちょうど 0 個か 1 個**。2 個以上は syntax error（マージも先勝ちもしない）
- `version` は必須・**先頭 key**・値は `1`。未知の version は syntax error
- list item は**厳密に 2 スペース**インデント。tab は禁止
- コメントは**行頭 `#` の行だけ**。行末の `# ...` は値の一部
- anchor / alias（`&` `*`）・flow collection（`[` `{`）・block scalar（`|` `>`）で
  **始まる**問いは syntax error。`---` / `...` も subset の外

行末 `#` が値の一部であることは、この記法では特に効く ——
`- 旧 API を残すか、#63 に合わせるか` は Issue 番号を保ったまま 1 件の問いになる。

---

## 4. 記法違反の扱い

acceptance-gates 記法 第7節を**そのまま**適用する。**新しい失敗モードを発明していない。**

| 状態 | 扱い |
|---|---|
| ブロックが 0 個 | **従来挙動**。question は載らない。plan は byte 単位で従来どおり |
| ブロックが 1 個・構文 OK | 1 件につき 1 件の blocking question（`open_question_declared`） |
| ブロックが 2 個以上 / 構文違反 / 未知 version / 未知 key / 空 / 重複 | planner が open question + warning `open_question_block_invalid`。**推測で復旧しない** |

**「ブロックが無い」と「ブロックが壊れている」を絶対に混ぜない。**
壊れたブロックを「無かったこと」に丸めると、**著者が未決と書いたはずのものが黙って消えた
run** が緑で終わる。`unrecognized_file_extension`（Issue #43）と
`acceptance_gate_block_invalid`（Issue #114）と同じ結論である。

question は `plan.issues[].questions` に載り、同じ code の warning が `plan.warnings` にも
載るので run は `partial` に落ちる。復帰手順は
[codes-and-recovery.md](./codes-and-recovery.md) 第2節・第4節にある。

---

## 5. なぜ見出し（`## 未決の問い`）ではなくブロックなのか

見出し規約（未決 / undecided / open questions）での検出でも #178 の実測ケースは拾える。
それでも fenced block を採ったのは 3 つの理由による。**見出し検出は併設しない。**

1. **誤検出が無い。** 「以前は未決だったが決めた」と書いた本文、過去の議論を引用した本文、
   `## Open questions（すべて解消済み）` と書いた本文は、見出し語では区別できない。
   偽の停止は `--allow-questions` を習慣にさせる —— それは全 question を一度に黙らせる
   フラグなので、1 件を黙らせるつもりで全部を黙らせることになる。
2. **散文から停止を作らない。** acceptance-gates 記法 第5節が受入ゲートについて述べている
   境界と同じである: **明示マークされたブロックに書かれたことだけを運ぶ。**
   位置と明示マークだけが意図を決める（Issue #54）。
3. **生成と解消が機械化できる。** 見出しには「書く対象」も「消す対象」も無いが、
   ブロックにはある。`cmate-issue-refinement` が open question を出す →
   著者 / `cmate-issue-authoring` が本文へブロックとして残す → **決めたらブロックを消して
   re-plan する**、という一本の線になる。**ブロックの削除が「決めた」の記録である。**
   `cmate-issue-authoring` ではこの線に手作業が 1 つも無い —— ブロックは計画の
   `open_questions[]` から renderer が組み、写す step が存在しないので写し漏れも起こらない。

生産側は 2 つとも着地している。`cmate-issue-refinement` が open question を
`open_questions_block` として**出力に載せ**（[#198](https://github.com/Kewton/commandmate-skills/issues/198)）、
`cmate-issue-authoring` は起案する**本文そのものに埋める**
（[#209](https://github.com/Kewton/commandmate-skills/issues/209)）。後者の不変条件は
「配列が真であり、ブロックはその射影である」で、`validate-plan.mjs` が両方向に検査する ——
宣言した問いが本文に無いことも、宣言していない問いが本文に在ることも落とす。
同 script はこの記法の読み取りも planner から逐語で写しており（抽出器へ渡す前の strip を
含む）、一致は
`tests/fixtures/cmate-issue-authoring/open-questions-conformance.mjs` が定数・関数本体・
corpus・実 planner での end-to-end で固定している。**規則はこの文書にだけ在り、
生産側 2 package は subset を生成するだけである。**

---

## 6. 変更するときの規約

- 記法を変えるなら、**本書・planner・fixture を同じ commit で**変える。
- fixture は二点測定であること: 適合するブロックで question が立つことと、
  **ブロックを消した双子の本文**で plan の機械向け field が byte 一致することの両方。
  緑だけの fixture は「ゲートが効いている証拠」として採用しない
  （`59-open-questions-declared` / `60-open-questions-block-invalid` /
  `61-open-questions-heading-not-read`）。
- `61-open-questions-heading-not-read` の `expected-plan.json` は
  **この記法が実装される前の runner が生成した**ものである。再生成しないこと ——
  それは「ブロックの無い本文は従来どおりに計画される」という主張そのものである。
