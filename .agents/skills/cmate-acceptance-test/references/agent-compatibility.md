# Agent 差異、fallback、再読み込み

同じ手順を複数の Agent で読ませるため、この Skill は特定 Agent の tool 名・
slash command・subagent 機構に依存しない。ここでは差が出る点と、その埋め方を書く。

## 1. 依存しないもの

`SKILL.md` の手順は次のいずれも前提にしない。

- 特定の tool 名（`Read` / `Write` / `Bash` などの固有名）
- subagent や task 分割の機構
- 会話履歴・作業 directory・直前の実行結果といった暗黙 context
- `dev-reports/` のような特定 project の慣習的な path

必要な入力は `SKILL.md` §1 の表にすべて挙げてある。表にない情報を前提にしない。

## 2. 能力差と fallback

| 能力 | ある場合 | ない場合の fallback |
|---|---|---|
| command 実行 | Step 4 の automated check を実行する | 全 criterion を `manual` か `not_run` にし、`status: partial` |
| file 書き込み | result document と evidence を書く | summary を標準出力に出し、result document を code block で提示。`result_path` に「書き出せなかった」と明示 |
| 利用者との対話 | Step 3 で確認を取る | `confirm_required` をすべて `not_run`。承認済みとみなさない |
| network | `gh` で Issue を取得する | `criteria_override` を必須入力に格上げする。取得できなければ `status: failure` |

fallback を使った場合は、その事実を result document の `limitations` と
summary の「実行しなかった check」に必ず書く。
能力が無かったことは、条件が満たされたことを意味しない。

## 3. Agent 別の状況

`commandmate.skill.yaml` の `compatibility.agents` が正本である。ここは補足で、
`support` の値は次を意味する。

- `native` — Agent 自身が install 先の `SKILL.md` を discovery できる
  （Claude は `.claude/skills/<skill-id>/`、Codex は `.agents/skills/<skill-id>/` から読む）
- `commandmate_runtime` — CommandMate の Runtime 経由で手順を渡す必要がある
- `unknown` — この version では検証していない。動かないという意味ではない

`unknown` の Agent で使う場合、この Skill は「手順書」として読み込めば動作するが、
discovery と reload の挙動は保証されない。結果の再現性を主張する前に、
どの Agent の、どの version で実行したかを result document の `environment` に記録する。

## 4. 実行環境の記録

再現性の主張には、次の 3 つが揃っている必要がある。

1. Agent 名と version
2. Skill の `id` と `version`
3. 対象 repository の commit SHA と、作業 tree が dirty かどうか

いずれかが欠けた実行は、`summary` で「再現条件が不完全」と明示する。

## 5. 再読み込み（reload）

Skill は CommandMate が登録済み worktree の `.agents/skills/<skill-id>/` と
`.claude/skills/<skill-id>/` の **両方**へ byte-identical に配備する
（CommandMate 0.15.0 以降）。Claude は後者を、Codex は前者を読む。
配備先 path は server 側で解決されるものであり、この Skill が絶対 path を指定しない。

更新を反映する手順:

1. CommandMate 側で対象 Skill の新しい version を install する
   （install は既存 file を暗黙に上書きせず、差分の確認を経る）。
2. Agent の session を開始し直す。多くの Agent は SKILL.md を session 開始時に
   読み込むため、session を跨いだ自動反映は期待しない。
3. 反映されたかは、`SKILL.md` の frontmatter `name` と
   `commandmate.skill.yaml` の `version` を突き合わせて確認する。

install / update が script や hook を自動実行することはない。
この package は script file を 1 つも含まない（manifest の `files` の `script` が
すべて `false` であることで確認できる）。
