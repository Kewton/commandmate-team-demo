# Agent 差異と fallback

この Skill は、特定の Agent の tool 名・命令形式に依存しない。
plan の生成は同梱の deterministic runner（`scripts/orchestrate.mjs`）が、
承認済み plan の dispatch・監督は別 runner（`scripts/dispatch.mjs`）が行い、
Agent は runner を呼び出して結果を解釈するだけである。したがって、
plan の内容は Agent の種類によらず同じになる（Claude/Codex parity）。
dispatch は public `commandmate` を driver に取り、その CLI 経路を
[dispatch-contract.md](./dispatch-contract.md) が定める。

## 1. 必要な能力

| 能力 | 用途 | 無いときの動作 |
|---|---|---|
| `node`（>=22）の実行 | runner の実行 | この Skill は成立しない。`process_execution` を要求する |
| file の書き込み | run artifact の生成 | plan を保存できない。`filesystem_write` を要求する |
| `gh` の実行（任意） | live な Issue 取得 | `--issue-json` で offline 実行に代替できる |

runner は Node stdlib のみで動く。外部 package の install は要らない。

## 2. runner を呼ぶ責務

Agent は次を行う。

1. profile・Issue 集合・`max_parallel` 等の入力を決める（SKILL.md 第4節）。
2. `scripts/orchestrate.mjs` を **dry-run（既定）** で呼ぶ。
3. stdout の result envelope を JSON として読み、`status` と
   `completion_check.passed` を確認する。
4. `run_dir` 配下の `manifest.md` / `issue-analysis.md` / `dependency-plan.md`
   を人へ提示し、承認可能かを判断してもらう。

runner が非0で終了した場合、その stdout には `status: failure` の result が
出ている。Agent は `errors[].code` をそのまま報告し、**推測で plan を捏造しない**。

## 3. 決定的であることの利用

同じ入力からは同じ plan（run_id まで一致）が出る。ある Agent で得た plan を、
別の Agent で再現して突き合わせられる。差が出た場合、それは入力差か
runner のバグであり、どちらも `--run-id` を固定して diff を取れば切り分けられる。

## 4. 出力形式

runner は result envelope（JSON）を stdout に、進捗 notice を stderr に出す。
Agent が構造化出力の機構を持つ場合は result envelope をそのまま渡す。
持たない場合は、`summary_markdown` に続けて result JSON を単一の code block で出す。
片方だけを返さないこと。

## 5. 検証済みの組み合わせ

manifest の `compatibility.agents` には、SKILL.md の discovery 経路が
確認できている Agent だけを `native` として宣言している。
実機での品質評価（rubric による採点）を行った Agent と version は、
配布元リポジトリ <https://github.com/Kewton/commandmate-skills> の
`tests/fixtures/cmate-orchestrate/README.md` に記録する。
この file は package には含まれないので、install 済みの copy には無い。

宣言が `unknown` の Agent で動かないという意味ではない。
確認していない、という意味である。
