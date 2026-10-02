# Agent 差異と Claude/Codex の reload・呼出

この Skill は特定の Agent の tool 名・命令形式に依存しない。SKILL.md は
「何を inspect し、何を作成し、何を出すか」だけを規定し、「どの tool でそれを行うか」は
各 Agent の裁量に委ねている。その前提で、実行環境ごとに差が出る点を定める。

## 1. 必要な能力

この Skill が成立するために Agent 側へ求めるのは次である。

| 能力 | 用途 | 無いときの動作 |
|---|---|---|
| file と directory の読み取り | repository inspect・profile 検出 | status `failure` / `input_invalid` |
| read-only の version-control 照会 | branch/base/worktree の把握、base SHA 確定 | 代替不可なら `failure` |
| command 実行（`git`, `commandmate`） | worktree 作成・baseline・sync | `partial`。作成できなければ plan のみ返す |
| 対話確認 | plan 承認・dependency install 承認 | 承認が取れない操作は行わず `limitations` に記録 |

非対話（確認を取れない）実行では、plan 承認と dependency install 承認を伴う操作を行わない。
plan と、未実行である旨だけを返す。

## 2. base SHA と collision の扱い

base SHA が取れない Agent 環境では、その base で作成せず `limitations` に記録する。推定 SHA を書かない。
collision 判定は `git worktree list --porcelain` を正本とし、path の substring 一致で代用しない。

## 3. 出力形式

result object は JSON である。Agent が構造化出力の機構を持つ場合はそれを使う。
持たない場合は、`summary_markdown` に続けて JSON を **単一の code block** で出す。
JSON を複数の block に分割しない。`summary_markdown` は result object の field であって、
result object の代わりではない。片方だけを返さない。

## 4. Claude / Codex の reload と呼出

公開済み version は immutable であり、更新は常に新しい version であって、
同じ version の bytes 差し替えではない。install / 更新後の反映は次のとおり。

1. CommandMate の Skill install flow で新 version を install する。install は Catalog の
   artifact digest に pin し、権限と risk 宣言を適用前に提示する。UI/CLI の文言は CommandMate 側に属し、
   ここでは再掲しない。
2. payload は登録済み worktree の `.agents/skills/cmate-worktree-setup/` と
   `.claude/skills/cmate-worktree-setup/` の **両方**へ byte-identical に配置される
   （CommandMate 0.15.0 以降。install receipt の `install_roots` に両 root が記録される）。
   これらの directory の外は触れられず、install 時に中の何かが実行されることもない。
3. Agent は discovery 時に `SKILL.md` を読む。更新が landing した時点で既に走っていた session は
   古い text のままなので、**新しい session を開始** して新 version を読み込む。
   - Claude — `.claude/skills` から `SKILL.md` を discovery する（`.agents/skills` は読まない）。
     新しい session を開始すれば再 discovery される。Claude 固有の tool 名を手順は前提にしない。
   - Codex — `.agents/skills` の `SKILL.md` を新しい session の起動時に読み込む。
     ただし Codex CLI 0.145.0 は skill を slash command として露出しないので、名前で指示する。
     手順は capability（読む・照会する・command を実行する）で書かれており、Codex 側の
     tool 名に依存しない。
4. 実効 version は、install 済み `commandmate.skill.yaml` の `version` を読んで確認する。
   Catalog は「入手可能なもの」を示し、install 済み manifest は「実際に使われているもの」を示す。

install が digest 検査に失敗したら、別 artifact に対して retry しない。それは pin が
機能している状態であり、報告すべき事象である。

## 5. 検証済みの組み合わせ

manifest の `compatibility.agents` には、`SKILL.md` の discovery 経路が確認できている Agent だけを
`native` として宣言している。実機での品質評価（rubric による採点）を行った Agent と version、および
Node/Rust fixture の結果は、配布元リポジトリ
<https://github.com/Kewton/commandmate-skills> の
`tests/fixtures/cmate-worktree-setup/README.md` に記録する。この file は package には含まれないので、
install 済みの copy には無い。

宣言が `unknown` の Agent で動かないという意味ではない。確認していない、という意味である。
