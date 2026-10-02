# changelog — version 履歴、期待効果、制約

Catalog の `changelog` はこの Skill の release tag の annotation から生成される。
その annotation の元になる記述をここに置く。install 前の利用者が読む前提で書く。
**新しい version を上に置く。version を上げたらこの file も同じ commit で更新する。**

## 0.2.0

`acceptance-result.v1` の `skill.id` を、この Skill の名前に固定した `const` から
**2 値の `enum`**（`cmate-acceptance-test` / `cmate-uat`）へ広げた（#259 / #260）。

### 何が変わるか

- **この Skill の手順・判定規則・決定表・outcome の定義は 1 つも変わっていない。**
  変わったのは schema が「誰が書いた document を v1 と認めるか」だけである。
- **`cmate-uat` が書いた document も v1 に適合するようになった。** 受入判定の *形* は
  証跡の取り方に依存しない —— `cmate-acceptance-test` は渡された対象を検証し、
  `cmate-uat` は実機環境を立ててから検証する、という違いは document の shape を変えない。
  そこで schema を 2 つの producer で共有し、**schema 自体はこの package に 1 本だけ置く**
  （複製すると必ず乖離する）。
- **`enum` は閉じたままである。** `cmate-orchestrate` の uat runner はこの document を
  意味ゲートとして読むので、**著者を特定できない判定は受け付けない**。
  「v1 に見えるから通す」ようにはしていない。

### 使う側への影響

- この Skill が書く document は従来どおり `skill.id: cmate-acceptance-test` である。
  **既存の document は 1 つも無効にならない**（`const` から `enum` への拡大なので、
  以前適合していたものは今も適合する）。
- 読む側で `skill.id` を `cmate-acceptance-test` と決め打ちで比較している consumer は、
  `cmate-uat` の document を弾く。runner 側の対応は `cmate-orchestrate` 0.33.0（#259）。

## 0.1.3

SKILL.md を「いつ使うか / どう呼ぶか / 出力をどう読むか / 止まったとき何をするか」の
4 つに絞り、references と schema にある規則の再掲をやめた（Issue #68）。

### 何が変わるか

- **規則の正本が references と schema だけになった。** SKILL.md が持っていた
  決定表の要約（Step 5）、権限の用途表（§2）、完了条件の 8 項目（§6）、evidence の
  type 別必須項目（Step 4）、summary の構成（Step 7）、分類と risk tier の定義
  （Step 2）は、いずれも `verdict-rubric.md` / `evidence.md` / `test-plan.md` /
  `acceptance-result.v1.json` / `commandmate.skill.yaml` にある内容だった。
  二重に書かれていた分だけ乖離の余地があったので、SKILL.md 側を参照に置き換えた。
- **手順そのもの、判定規則、outcome の定義、決定表、schema に変更はない。**
  0.1.2 の result document はそのまま有効である。
- `evidence.md` §4 が SKILL.md の項番（`§6-2`）を指していたのを、schema の
  `criterion.evidence_ids` を指すように直した。項番に依存した参照は、節を編集するたび
  黙って壊れるからである。
- 0.1.2 で入れた `target.issue_ref` の記録規則、cmate-orchestrate との consumer 関係、
  `result_path` の規約は、いずれも他所に正本が無いのでそのまま残している。

## 0.1.2

`target.issue_ref` の記録規則を定義し、consumer である cmate-orchestrate との
関係を明記した（Issue #60）。

### 何が変わるか

- **`target.issue_ref` に何を書くかが SKILL.md §5 で決まった。** 呼び出し元から
  渡された入力をそのまま記録し、何も渡されなかった場合は固定文字列 `unspecified` を
  記録する。推測で Issue 番号を埋めない。
  これで「入力が欠けていれば `status: failure` を出力する」という §5 の指示と、
  `issue_ref` を required・非空とする schema が両立する。schema は変更していない。
- `unspecified` の result は、cmate-orchestrate の uat runner が **mismatched** に
  分類し、`--require-acceptance` 付きの実行では不合格になる。安全側の意図した挙動で
  あることを SKILL.md に明記した。
- **cmate-orchestrate との関係を明記した。** この result document は orchestrate の
  UAT 意味ゲートの入力であり、orchestrate から使う場合は `--acceptance-dir` 配下に
  `issue-<n>.json` という file 名で置く。既定の `./acceptance-result.json` のままでは
  読まれない。
- `filesystem_write` の用途にあった参照先の誤り（存在しない「§4 Step 3」の記述）を、
  実在する `references/test-plan.md` §3 へ直した。

判定規則、outcome の定義、決定表、schema に変更はない。0.1.1 の result document は
そのまま有効である。

## 0.1.1

互換宣言を実測へ是正。手順本体に変更なし。

compatibility の結論（claude / codex ともに `native`）は 0.1.0 と同じだが、根拠が
誤っていた。「`.agents/skills` からの標準 discovery」と書いていたが、Claude が読むのは
`.claude/skills` である（CommandMate#343）。2026-07-26 の隔離環境実測へ差し替えた。

- Claude Code 2.1.220 / CommandMate 0.15.0: `.claude/skills` から発見され、slash palette
  に完全一致で露出する（機械的証跡）。installer は `.agents/skills` と `.claude/skills`
  へ byte-identical に配置する（CommandMate#1460）。
- Codex CLI 0.145.0: `.agents/skills` から SKILL.md を読む（self-report）。この version は
  skill を slash command として露出しないため、名前で呼ぶ。
- Gemini / OpenCode は未計測のため `unknown` のまま据え置き。

## 0.1.0

初回 release。Phase 1（MVP）の公式 Skill。

### 何ができるようになるか

- Issue の受入条件を自動検証と手動確認に分け、証跡付きで検証できる。
- 判定が `go` / `conditional_go` / `no_go` の 3 値で返る。
  「たぶん大丈夫」が `go` に混ざらない。
- 結果が schema 付きの JSON（`acceptance-result.v1.json`）で返るので、
  後続の自動処理や、離席後の状態復元に使える。
- 実行した check と実行しなかった check が分けて報告される。

### 期待効果

- 受入判断の根拠が、実行者の記憶ではなく evidence として残る。
- 未検証・環境依存・flaky・未承認が pass に丸められなくなる。
- 破壊的な検証が、cleanup plan つきの確認を経てからしか走らない。

### 制約（install 前に把握しておくこと）

- **実装や修正は行わない。** 検証のみを行う Skill である。
- 実行する command は、この Skill 自身の `gh` / `git`（読み取り用途）と、
  利用者が入力として渡し確認したもの**だけ**である。project の test command を
  推測して実行しない。渡さなければ自動検証は行われない。
- 対話できない実行形態では、`confirm_required` の check は必ず未実行になる。
  その分 `status` は `partial` に留まる。これは仕様であって不具合ではない。
- 受入条件が Issue 本文に定義されていない場合は判定せず `failure` を返す。
- 判定の質は受入条件の書かれ方に依存する。曖昧な条件は `not_verifiable` になる。
- この version の評価は `tests/fixtures/cmate-acceptance-test/` の deterministic
  fixture と rubric によるものである。実 Agent での opt-in 実機評価は未実施であり、
  `compatibility.agents` の `support` はその範囲でのみ `native` を宣言している。

### 権限と risk

- `declared_risk`: `moderate`
- 宣言権限: `filesystem_read` / `filesystem_write` / `process_execution` /
  `network_access` / `environment_read`
- script file と実行 bit 付き file は含まない。install / update が script や hook を
  自動実行することはない。
- network は Issue 本文の取得（`api.github.com` / `github.com`）に限る。

### 再読み込み

更新の反映手順は
[`agent-compatibility.md`](./agent-compatibility.md) の「再読み込み」を参照する。
要点は、install 後に Agent の session を開始し直すこと、そして反映確認は
`commandmate.skill.yaml` の `version` で行うことである。
