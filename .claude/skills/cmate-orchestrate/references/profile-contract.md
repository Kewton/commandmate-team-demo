# profile 契約

`cmate-orchestrate` は、対象リポジトリごとに変わる値 — base branch、branch 名、
worktree path、baseline 検証 — を **profile** から解決する。planner は
`develop` / `feature/...` / `npm` / `cargo` を一切 hardcode しない（ADR [#1447](https://github.com/Kewton/CommandMate/issues/1447)）。
新しいリポジトリへの対応は profile の追加であって、runner の改修ではない。

自分のリポジトリ用の profile は、`scripts/profile-init.mjs` に **draft を起案させて**
から手で仕上げるのが早い（第7節）。起案は常に `verified: false` であり、
`verified: true` にしてよい条件は第8節に列挙する。

## 1. profile の形

```json
{
  "id": "node-commandmate",
  "repository": "Kewton/CommandMate",
  "base": "origin/develop",
  "branch_template": "feature/issue-{number}-{slug}",
  "worktree_template": "../{repo}-issue-{number}-{slug}",
  "baseline": ["npm ci", "npm run build", "npm test"],
  "verified": true
}
```

| field | 必須 | 意味 |
|---|---|---|
| `id` | 必須 | profile の識別子 |
| `repository` | 必須 | `owner/name` 形式の GitHub slug |
| `base` | 必須 | 分岐元。例 `origin/develop`、`origin/main` |
| `branch_template` | 必須 | branch 名の雛形。`{number}` `{slug}` `{repo}` を展開 |
| `worktree_template` | 必須 | worktree path の雛形。同じ placeholder を展開 |
| `baseline` | 必須 | 各 worker が実行する検証 command の配列 |
| `verified` | 任意 | 実機確認済みなら `true`。既定は `false` |
| `scope_companions` | 任意 | このリポジトリ固有の**伴走ファイル規約**。宣言済み path の関数を書く `derive` と、名前が固定された伴走を書く `require` の2 key。第9節。**未指定なら宣言が無いのと同じ**で、planner は組み込みの導出だけを行う |
| `dispatch_defaults` | 任意 | このリポジトリ固有の**運転既定**（`no_infer` / `auto_yes` / `wait_timeout` / `max_turns`）。第10節。**未指定なら宣言が無いのと同じ**で、CLI flag の既定値がそのまま効く |
| `integration_baseline` | 任意 | **合流後の統合ブランチ**に対する検証 command の配列（`merge.mjs --integration-verify` が実行する）。第11節。**未指定なら `baseline` にフォールバック**する（＝#195 以前と同じ挙動）。`[]` は「統合検証の定義は無い」という**宣言**であり、`baseline` には落ちない |
| `pr_title_template` | 任意 | `merge.mjs --create-prs` が付ける **PR タイトルの型**（例 `{{type}}({{scope}}): {{title}} (#{{number}})`）。第13節。**未指定なら Issue タイトルそのまま**（＝CommandMate#3005 以前と同じ） |

placeholder は次のとおり展開する。

- `{number}` — Issue 番号
- `{slug}` — Issue title を ASCII slug 化したもの（小文字・英数・`-`、最大48字）
- `{repo}` — `repository` の `/` 以降

未知の field を持つ profile は拒否する（`load_error`）。

## 2. 動作確認済み profile

runner に内蔵しているのは、ADR で動作確認された次の2つだけである。
`--profile <id>` で選ぶ。

| id | repository | base | baseline |
|---|---|---|---|
| `node-commandmate` | `Kewton/CommandMate` | `origin/develop` | `npm ci` / `npm run build` / `npm test` |
| `rust-commandagent` | `Kewton/CommandAgent` | `origin/develop` | `cargo fmt --check` / `cargo clippy ...` / `cargo test` |

どちらも `verified: true` である。

## 3. unverified profile

`--profile-json <path>` で渡した独自 profile は、`verified: true` を
明示しない限り **unverified** として扱う。unverified profile は、
`--allow-unverified` を付けない限り planning を拒否する（`unverified_profile`）。
これは「未検証リポジトリは実行前確認の上で利用する」という ADR 決定を、
mutation の無い plan 段階でも一貫させるためである。

`--allow-unverified` を付けて planning した場合、plan の `risk` には
`unverified_profile`（severity high）が必ず載る。

## 4. base / repository の上書き

`--base <ref>` と `--repo <owner/name>` は profile の値を上書きする。
上書きした値は plan の `profile` と `inputs` にそのまま反映され、
run_id の入力にも含まれる（第 [plan-contract.md](./plan-contract.md) 参照）。

**`--repo` は `verified` を降格させる。** `verified: true` は「その profile の
branch/base/worktree/baseline を **そのリポジトリで** 確認した」という主張であり、
リポジトリを差し替えた時点で主張の対象が消える。よって `--repo` が profile の
`repository` と異なる値を指定した場合、planner は `verified` を `false` に落とす。
結果として `--allow-unverified` が無ければ `unverified_profile` で拒否し、
付けた場合は risk factor `unverified_profile`（high）と warning
`profile_repository_override` が載る。
`--base` の上書きは `verified` を変えない（同一リポジトリ内の話だからである）。

**この warning は `status` を落とさない**（`severity: notice`。
[#210](https://github.com/Kewton/commandmate-skills/issues/210)。
[plan-contract.md](./plan-contract.md) 第5.6節）。この経路は `--repo`（差し替え）と
`--allow-unverified`（降格の受諾）の**2つの明示 flag が揃わないと通れない**ので、warning が運ぶのは
operator が既に決めて run の command line に記録した事実である。同じ受諾を
`--profile-json <verified: false> --allow-unverified` と綴った run は warning すら出ずに
`success` で返るので、`partial` は同一の判断を綴りで色分けしていた。**降格自体は何も変わっていない**
—— `profile.verified` は `false` のまま plan に載り、`risk.level` は `high` のままである。

## 5. 既定 profile と cwd の照合

profile が **既定値**（`node-commandmate`）に解決された場合、つまり `--profile` も
`--profile-json` も指定されなかった場合に限り、planner は read-only の
`git remote get-url origin` を1回実行し、URL を `owner/name` に正規化して
（`git@host:owner/name.git` / `ssh://…` / `https://…` の各形式）profile の対象
リポジトリと大文字小文字を無視して照合する。

- 不一致 → warning `profile_repository_mismatch` を積み、result を `partial` にする。
  planner は停止しない。
- 一致・cwd が git リポジトリでない・`origin` が無い・`owner/name` に正規化できない
  → **照合をスキップ**し、従来どおり `success` とする。probe の失敗を不一致に化けさせない。
- 明示的に profile を指定した場合は照合しない。指定は意図的な選択だからである。

別リポジトリの worktree で profile を指定し忘れると、planner は既定 profile の
リポジトリから Issue を読み、**中身の違う Issue から一見きれいな plan を返す**。
この照合はその事故を warning として可視化するためのものである
（[#36](https://github.com/Kewton/commandmate-skills/issues/36)）。cwd の remote から
profile を **自動解決** することはしない。plan の入力に cwd 状態を持ち込む挙動変更だからである。

**profile の自動解決をしないことと、profile の起案を助けることは別である。**
前者は plan の純粋性の問題で、後者は plan の前に人間が1回だけ行う作業である。
起案は第7節の別 runner が担当し、その出力は plan の入力にはならない（人間が渡す）。

## 6. CommandMate worktree 同期

worktree の CommandMate 側 ID は、将来新設される `commandmate sync` が
dispatch 時に解決する。現状 CLI に sync は無いため、plan 段階では各 Issue の
`worktree_id` を `null`（欠落）として返し、失敗にはしない（ADR 決定3、optional 扱い）。
`commandmatedev` は公式経路に使わない。公式経路は public `commandmate` である。

## 7. profile の起案（`scripts/profile-init.mjs`）

内蔵 profile 以外のリポジトリでは、profile を手書きする必要があった。それが
「CommandMate 既存ユーザーなら誰でも使える」への最大の初期障壁だったので、
リポジトリ自身の宣言から **draft を起案する** runner を同梱する
（[#94](https://github.com/Kewton/commandmate-skills/issues/94)）。
「`verify.yaml` が無ければ CI 定義から起案する」（cmate-verify）と同じ思想である。

```
profile-init.mjs [--repo-root <path>] [--out <path>] [--emit envelope|profile]
                 [--repo <owner/name>] [--id <id>]
profile-init.mjs --check <profile.json> [--repo-root <path>]
```

| flag | 既定 | 効果 |
|---|---|---|
| `--repo-root <path>` | cwd | 調べるリポジトリ |
| `--out <path>` | — | draft profile JSON の書き出し先。**既存なら `out_exists`（exit 4）で上書きしない** |
| `--emit <mode>` | `envelope` | stdout に出すもの。`profile` なら draft JSON そのもの（`> profile.json` 用） |
| `--repo <owner/name>` | 推定 | GitHub slug を宣言する |
| `--id <id>` | 導出 | profile id を宣言する |
| `--check <path>` | — | **起案しない別 mode。** 既にある profile の `scope_companions` を tree に突き合わせて報告する（第9.7節）。上の4 flag とは併用できない（`invalid_input`） |

```bash
# draft を書き出して確認し、そのまま plan に食わせる
node scripts/profile-init.mjs --repo-root . --out /tmp/my-profile.json
node scripts/orchestrate.mjs 123 --profile-json /tmp/my-profile.json --allow-unverified
```

### 7.1 何を根拠に何を決めるか

読むのは `--repo-root` 配下の file だけである。**network も subprocess も clock も
使わない。** directory 列挙は必ずソートしてから使うので、同じ tree からは
**byte 単位で同じ draft** が出る（Claude/Codex parity）。

| field | 判定材料 | 無かったときの雛形 |
|---|---|---|
| `repository` | `--repo` → git config の `origin` → `package.json` の `repository` → `Cargo.toml` / `pyproject.toml` の repository URL | `OWNER/REPO`（**実在しない形**にしてある） |
| `base` | `.github/workflows/*.yml` の `on.pull_request.branches` → 無ければ `on.push.branches`。複数あるときは `develop` > `main` > `master` > 辞書順先頭 | `origin/main` |
| `branch_template` | CONTRIBUTING / PR template / `docs/*.md` / README が **命名規約として** 述べている prefix（`feature/issue-…` のように placeholder を伴うか、branch 命名を論じている行に限る。ターミナル貼り付けの `feature/greet` のような**実例は採らない**） | `feature/issue-{number}-{slug}` |
| `worktree_template` | 上と同じ文書群の `git worktree add ../…`。**確認できるのは「兄弟 directory である」ことだけで、名前ではない** | `../{repo}-issue-{number}-{slug}` |
| `baseline` | toolchain manifest（`package.json` / `Cargo.toml` / `pyproject.toml` / `go.mod` / `Makefile`）と lockfile。cargo clippy はリポジトリが clippy を使っている証跡があるときだけ入れる。**これは各 worker が回す proportional な健全性確認である**（重い build / e2e の置き場は第11節の `integration_baseline`） | 後述の失敗する placeholder |
| `id` | `<toolchain>-<repository 名>`（内蔵 profile と同じ命名） | `custom-repo` |
| `verified` | — | **常に `false`。この runner が変えることはない** |
| `scope_companions` | `spec/` `test/` `tests/` の実ファイルと、それが写している `src/` `app/` `lib/` の実ファイルの**対**。両方が実在するときだけ `derive` を1件起案する。`require` は起案しない（第9.4節） | `{"derive": []}`（空。＝宣言が無いのと同じ挙動） |
| `dispatch_defaults` | **起案しない**（key ごと出さない）。第10.5節に理由を書く | — |
| `integration_baseline` | **起案しない**（key ごと出さない）。第11.5節に理由を書く | — |

toolchain が複数ある場合は `node` > `rust` > `python` > `go` > `make` の固定順で
1つを選び、選ばなかったものを warning `multiple_ecosystems` に載せる。npm 系 lockfile が
複数ある場合も同様に warning `multiple_lockfiles` を載せる。テスト配置が複数見つかった
場合も同じで、固定順の先頭を起案して残りを warning `multiple_test_layouts` に載せる。
**黙って1つを選ばない。**

### 7.2 provenance と TODO

**profile JSON の中には provenance を入れない。** planner は契約外の field を持つ
profile を `load_error` で拒否するので（第1節）、注釈を書き込んだ profile は
それを使うはずの runner に拒否される。provenance は **stdout の envelope 側**に出る。

envelope の `provenance[]` は field ごとに `source` と `evidence[]`（file・行番号・
その行の**本文**）を持つ。`source` は次のいずれかである。

| source | 意味 |
|---|---|
| `flag` | `--repo` / `--id` で人間が宣言した |
| `detected` | リポジトリ内の記述から読んだ。`evidence[]` がその出所 |
| `derived` | 他の field から機械的に組み立てた（`id`） |
| `default` | **判定材料が無かった**。安全側の雛形であり、必ず対の TODO がある |
| `fixed` | 契約上固定（`verified: false`） |

`source: default` の field には必ず `todos[]` に同じ field の項目が載る。
**「材料が無かったので雛形を置いた」と「読み取った」が出力上見分けられること**が
この runner の要点であり、`gaps_explicit` completion check がそれを自己検査する。
`todos` か `warnings` が1件でもあれば status は `partial` になる（雛形が1つも
無ければ `success`。ただしそれでも `verified` は `false` のままである）。

baseline を1つも推定できなかったときの雛形は、**exit 0 しない command** である。

```
false # TODO: replace with this repository's verification commands
```

baseline は shell を経由せず whitespace 分割で実行されるので、これは `false` の
実行になり必ず失敗する。空配列にしないのは、契約経路で「検証すべき gate が無いから
pass」に化けさせないためである。**埋め忘れた baseline は fail-closed でなければならない。**

### 7.3 起案は profile ではない

profile-init の出力は **draft** であり、envelope はそのことを `draft: true` と
`verified: false` の両方で明示する。plan に渡すには `--allow-unverified` が要り、
plan の risk には `unverified_profile`（high）が載る。これは劣化ではなく設計である
——起案 runner が自分の起案を承認できてしまえば、`verified` flag は意味を失う。

## 8. `verified: true` への昇格

`verified: true` は「この profile の branch/base/worktree/baseline を、**このリポジトリで
実機確認した**」という主張である。書き換えるのは人間であり、runner ではない。
次のすべてを満たしたときにだけ `true` にしてよい。

1. **`repository` が実在し、Issue を読める。** `gh issue view <n> --repo <repository>`
   が成功する。placeholder（`OWNER/REPO`）が残っていない。
2. **`base` が実在する ref である。** `git rev-parse <base>` が成功し、それが実際に
   feature branch の分岐元・PR の向き先である（CI の `pull_request.branches` と一致する）。
3. **`branch_template` が展開後に妥当な branch 名になる。** `{number}` `{slug}` `{repo}`
   を展開した文字列が `[A-Za-z0-9._/-]+` に収まり、`..` を含まず、`/` や `-` で始まらない
   （runner の safe-ref guard と同じ条件）。既存の branch 命名規約と衝突しない。
4. **`worktree_template` が展開後に書ける相対 path になる。** 絶対 path でも
   drive path でもなく、先頭の `../` 以外に `..` を含まない（同 guard）。展開先の親
   directory が実在し書き込み可能で、そこに worktree を作ってよい合意がある。
5. **`baseline` を worktree 内で実際に通した。** clean な worktree で全 command を
   順に実行し、**すべて exit 0**。`false` や `TODO` の残骸が無い。第7節の
   `todos[]` が1件も残っていない。
6. **baseline が「壊れていれば落ちる」ことを確認した。** わざと壊した状態で同じ
   baseline を実行し、**非 0 で落ちる**。素通りする baseline は verification gate に
   ならない（pass の意味が無い gate を verified と呼ばない）。
7. **1件の Issue で plan → dispatch → verification pass まで通した。** `--profile-json`
   に渡した profile で `orchestrate.mjs` が plan を出し、dispatch が worker を配って
   verification が pass する。ここまで通っていない profile は「動くはず」でしかない。

上記を満たしたら `verified: true` を書き足す。**確認した日付・CommandMate の version・
確認した Issue 番号を profile と一緒に記録しておくこと**（profile JSON 自体には
契約外の field を足せないので、profile を置いた場所の README なり commit message なりに書く）。

8. **`scope_companions` が実在の規約を写している。** 宣言した規則が、このリポジトリで
   実際に使われている配置と一致する（第9節）。宣言は worker の `scope.allow` に入るので、
   でたらめな規則は「使われない許可」として無害ではあるが、**verified の主張には含まれる**。

`--repo` で対象リポジトリを差し替えると `verified` は自動的に降格する（第4節）。
上の主張が「そのリポジトリで」確認したことである以上、リポジトリを替えれば主張の
対象が消えるからである。**確認していない環境へ verified を持ち回さない。**

## 9. `scope_companions` — repo 固有の伴走ファイル規約（任意）

裁定の記録は [adr-scope-derivation.md](./adr-scope-derivation.md)（第2節・第3節・第15節）、
plan 側の正本は [plan-contract.md](./plan-contract.md) 第5.1節である。

### 9.1 何を解く field か

`suspected_files` は dispatch がそのまま契約の `scope.allow` へ写す。したがって
**Issue が書き忘れた伴走ファイルに触れた worker は不合格になり、契約 scope は send 時
snapshot なので worker 側からは直せない。** planner は「宣言されたファイルを編集すれば
機械的に付いてくるファイル」を既定で許可してこれを消しているが（plan-contract.md 第5.1節）、
その規則は **path だけから決まる普遍のもの**に限られる。

repo には planner が知りようのない規約がある。

- `app/` を `spec/` が写す独自のテスト配置
- 生成物（`.proto` → `*_pb.ts`、locale 辞書、snapshot）
- 宣言済みファイルから決まる、repo が要求する更新
- **名前が固定された伴走** —— 複数モジュールをまとめて検証する集約テスト、repo が更新を
  要求する docs。どのソース名とも対応しないので、規則からは出てこない（第9.2節 `require`）

**planner は対象リポジトリを開かない**（開けば plan が入力の純関数でなくなる）し、
**dispatch が worktree を観測する案は却下されている**（契約が worktree ごとに変わり、
`dispatch-contract.md` の byte-identical 性が壊れる）。repo 知識の正しい入口は profile
だけであり、profile は plan の一部なので、そこに置けば両方の性質が保たれる。

この原則は第9.7節の `--check` でも**変わらない**。tree を開くのは planner ではなく、
**人間が profile をレビューするときに叩く別 runner**（`profile-init.mjs`）であり、
plan 経路は1 byte も tree を読まない。`scripts/inspect.mjs --check-references`
（[#217](https://github.com/Kewton/commandmate-skills/issues/217)。Issue 本文が主張する
`path:line` と行数を tree に突き合わせる）も同じ位置に在る —— **planner が開かないことの
代償は、本文の主張が古くても誰も気づかないことであり、それを払うのは plan ではなく
その隣に立つ read-only runner である。**

### 9.2 形

key は2つある。**`derive` は宣言済み path の関数**を、**`require` は名前が固定された
伴走ファイル**を宣言する。どちらも任意で、**併存する**。

```json
"scope_companions": {
  "derive": [
    { "when": "app/{dir}{base}.rb", "add": ["spec/{dir}{base}_spec.rb"] },
    { "when": "src/{dir}{base}.proto", "add": ["src/{dir}{base}_pb.ts"] }
  ],
  "require": [
    { "when": "scripts/{dir}{base}.mjs", "add": ["scripts/tests/shared-contract.test.mjs"] },
    { "when": "web/src/shared/{base}.mjs", "add": ["scripts/tests/shared-contract.test.mjs"] }
  ]
}
```

#### `derive` —— テンプレートの対

1つの規則は、**共通の語彙で書かれた2つの path テンプレートの対**である。
`when` が**宣言済み path** に一致して placeholder を束縛し、`add` がその束縛を
具体的な path として書き戻す。placeholder は2つだけである。

| placeholder | 一致するもの |
|---|---|
| `{dir}` | 0個以上の path segment（各々に末尾 `/` が付く）。repo 直下なら空文字 |
| `{base}` | ちょうど1つの segment。通常はファイルの stem（拡張子はテンプレートに直接書く） |

`{dir}` があることで**ミラーが書ける**。`app/{dir}{base}.rb` → `spec/{dir}{base}_spec.rb` は
`app/models/user.rb` を `spec/models/user_spec.rb` に写す（先頭の `app/` は落ちる）。

**glob は書けない。** `*` `?` `[` `]` は両テンプレートで拒否され、wildcard は placeholder
だけである。したがって `add` が生む path は必ず**宣言済み path の一部を literal に含む**。
`when` で `**` を書きたくなったら `{dir}{base}`、`*` を書きたくなったら `{base}` である
（`scripts/**` は `scripts/{dir}{base}`）。エラー文がこの対応を名指しする。

#### `require` —— 名前が固定された伴走（[#181](https://github.com/Kewton/commandmate-skills/issues/181)）

`add` に **placeholder を含まないリテラル path** だけを書く。`when` は `derive` と同じ
語彙で、**宣言済み path に一致したときだけ**その literal を足す。

複数モジュールをまとめて検証する**集約テスト**がこれを必要とする。
`scripts/tests/shared-contract.test.mjs` はどのソース名とも対応しない —— **対応しないことが
集約テストの定義**である —— ので、L1 の慣習導出にも `derive` にも乗らない。#181 以前は
Issue 本文の `## 対象ファイル` へ毎回手書きする運用しか残っておらず、書き忘れた worker は
テストを更新できないまま scope ゲートで落ちていた。

- **何件一致しても1回だけ出る。** 最初に一致した宣言済みファイルの位置に1件入る
- **`when` は placeholder を持たなくてよい。** `{ "when": "docs/data-contract.md", "add": [...] }`
  は「この file を触るなら、あの file も触ってよい」という完結した規則である
  （`derive` では逆に拒否される —— 束縛が無ければ `add` を宣言の関数にできない）
- **`derive` は緩まない。** placeholder を1つも含まない `add` は `derive` では依然
  `load_error` である。**括弧の誤記が literal に化けることはない** —— `{Base}` や `{base`
  はどちらの key でも拒否され、括弧ごと落とした誤記（`spec/dir/base_spec.rb`）は
  `derive` で拒否される。key を移して初めて合法になる、つまり**判別しているのは
  中身の推測ではなく著者が書いた key** である

`require` の literal は宣言済み path の関数**ではない**（`derive` との唯一の違いである）。
それでも `when` に gate されているので「宣言が無ければ1件も出ない」は保たれる。
第9.1節の強い言明を `derive` に残したまま、弱い方を key の名前で可視にするのが
この形の目的である（[adr-scope-derivation.md](./adr-scope-derivation.md) 第15.2節が
「実例が出たら別 key として足す」と裁定していた、その実例である）。

### 9.3 拒否される宣言（すべて `load_error` / exit 6）

Issue を読む前、profile を読んだ時点で止まる。

| 宣言 | なぜ拒否するか |
|---|---|
| `derive[].add: ["spec/**/*_spec.rb"]` | 単独 glob。宣言と無関係な許可であり、[#50](https://github.com/Kewton/commandmate-skills/issues/50) が塞いだ穴を profile 経由で開ける |
| `derive[].add: ["docs/module-reference.md"]` | placeholder を1つも含まない。宣言済み path の関数になっていない（固定名なら `require` へ書く） |
| `derive[].add` が `when` の束縛していない placeholder を使う | 同上 |
| `derive[].when` が placeholder を1つも持たない | 固定 path 1件にしか一致せず、そこから何も導出できない（`require` では正当） |
| どちらかの `when` が同じ placeholder を2回持つ | 意味が定義できない（compile は独立した capture group にするので「等しいこと」を要求しない） |
| `require[].add` が placeholder を含む | literal として書かれた path はそのまま許可される。展開する束縛が無い以上、`{base}` の6文字が scope へ入るだけである |
| `require[].add` が repo の外を指す（`users/…` `C:/…` `https://…`、制御文字） | **literal だけは宣言済み path から作られない**ので、ここを通さないと profile 経由の path traversal になる。`..` / 先頭 `/` / `\` はテンプレート parser が先に落とす |
| `require[].add` が harness path（`.claude/skills/` / `.agents/skills/` / `.commandmate/`） | 第9.6節 |
| `{ext}` など未知の placeholder、`{base` のような括弧の不整合 | typo が literal に化けると「一致しない規則」が黙って残る。**両方の key で拒否する**（構文として正しいまま何にも一致しない規則はここでは捕まらない。それを見るのが第9.7節の `--check` である） |
| `..` を含む / 絶対 path | 対象リポジトリの外を指す |
| `derive` / `require` 以外の key、規則の `when` / `add` 以外の key | 未知 field を持つ profile を拒否するのと同じ（第1節）。**新しい runner 向けの profile は古い runner で黙って半分無視されるのではなく、はっきり落ちなければならない** |
| `add: []`、`derive` / `require` が配列でない、`scope_companions` が object でない | 形が違う |
| `scope_companions: {}` | どちらの key も無い。「宣言する規約が無い」は `{"derive": []}` と書く |

`{"derive": []}` は**正当で、かつ何もしない**。未指定と同じ導出になる（`{"require": []}` も同じ）。

**正規化は宣言した key しか持たない。** `derive` だけを書いた profile の plan は
`require` が増える前と 1 byte も変わらない（`plan.profile` の echo も `{"derive": …}` のまま）。

### 9.4 起案（`profile-init.mjs`）と provenance

`profile-init.mjs` は `spec/` → `test/` → `tests/` の順に走査し、その下の実ファイルが
`src/` → `app/` → `lib/` の実ファイルを写しているとき、その対を根拠に規則を1件起案する。
**directory があるだけでは起案しない** —— 2つの実ファイルで裏が取れた対だけを、
`provenance[].evidence[]` にその2つを挙げて `detected` として出す。

裏の取れた配置が複数あるときは走査順の先頭を起案し、残りを warning
`multiple_test_layouts` に載せる。1件も取れなければ `{"derive": []}` を `default` として置き、
対の TODO `scope_companions_undetermined` を必ず添える。**起案は常に1規則である** ——
draft は人間が広げる出発点であり、`verified: false` がそう言っている。

**`require` は起案しない**（[#181](https://github.com/Kewton/commandmate-skills/issues/181)）。
literal 伴走とソースの関係は**意味の関係**であって配置の関係ではない —— 集約テストは
どのソース名とも対応しないからこそ集約テストなので、対で裏を取れる実ファイルが存在しない。
どの宣言がそれを引き込むべきか（`when`）も「その file が何を覆っているか」の言明であり、
著者にしか書けない。起案すれば規則の両側を発明して `detected` と名乗ることになり、
それは第9.4節の規律そのものに反する。代わりに **TODO `scope_companions_undetermined` の
文面が `require` を名指しする** —— この TODO は「何も検出できなかった」ときに出る、
つまり人間がちょうどこの field を読んでいるときに出る。

### 9.5 運用上の注意

- **宣言を直して plan を取り直すと `run_exists`（exit 4）になる。** run_id の入力は
  Issue 内容・base・profile の `id` / `repository` などであって、profile の中身全部ではない
  （[plan-contract.md](./plan-contract.md) 第1節）。`baseline` を直したときと同じで、
  `--run-id` か `--runs-dir` を使う。エラー文がその2つを名指しする。
- **当たらない規則は無害である。** `scope.allow` は指示ではなく権限なので、使われなかった
  許可は何も起こさない。一方、宣言しなければ worker 1人分の run が失われる。
  ただし「当たらない」ことに**気づけない**のは無害ではない ——
  書き間違えた1本は plan を成立させたまま `scope_defaults` を1件減らすだけなので、
  Issue 側で気づくのは worker が scope ゲートで落ちたときになる。
  宣言を書いたら `profile-init.mjs --check` で一致件数を見る（第9.7節）。
- **書きすぎは無害ではない。** dispatch は `scope.allow` を sort してから 200 件に切り詰めるので、
  導出が増えすぎると宣言済みファイルが押し出される。planner は合計が 200 に達する手前で
  宣言済みファイル単位に打ち切るが、規則を増やすほど1 Issue あたりの導出は増える。
  `require` の literal は何件一致しても1回しか出ないので、この観点では `derive` より安い。

### 9.6 harness path は `require` に書けない（[#177](https://github.com/Kewton/commandmate-skills/issues/177) の境界）

`.claude/skills/` / `.agents/skills/` / `.commandmate/` —— worker と検証役が**である** Skill
package と、「verified とは何か」を決める設定 —— は、planner が既定で `scope.allow` から外す。
審判を書き換えられる被審判は審判されていないからである。**profile はこの境界を緩められない。**
#177 は除外集合を hardcode する理由として「`scope_companions` 的な key で緩められる境界は、
静かな2つ目の扉を持つ境界である」と述べており、literal 伴走はまさにその key である。

- **literal（`require[].add`）は profile 読み込み時に `load_error` で拒否する。**
  literal は静的に判定できるし、後で黙って落とせば「一致しない規則が黙って残る」ことになる。
  profile は人がレビューする成果物なので、その場で落とすほうが直せる
- **template（`derive[].add`）が harness に展開されたときは導出時に落とす。**
  ただし**宣言済み path 自身が harness の中にあるとき**は落とさない —— それは Issue が
  成果物見出しで名指しし、`harness_path_in_scope` warning で記録された、#177 が認めている
  唯一の許可であり、L1 も同じ宣言から慣習テスト path を導出している

出口は今までどおり Issue 本文の成果物見出し1つだけで、そこには warning が付く。

### 9.7 宣言を tree に突き合わせる（`profile-init.mjs --check`、[#197](https://github.com/Kewton/commandmate-skills/issues/197)）

第9.3節は括弧の誤記を `load_error` で拒否する理由として「typo が literal に化けると
**一致しない規則が黙って残る**」と書いている。その懸念は正しいが、**構文として正しく、
何にも一致しない規則**は同じ結果になり、そちらは拒否では捕まらない。

- `when: "scripts/{dir}{base}.mjs"` と `when: "scripts/{base}.mjs"` は**どちらも合法**だが、
  `scripts/adapters/human-review.mjs` に一致するのは前者だけである
- `require[].add` のリテラルが**実在しない file** でも load は通る

気づけるのは plan を回して `scope_defaults` を目視したときだけで、そのためには Issue
（または fixture）が要った。`--check` はその突き合わせを **plan の前に**行う。

```bash
node scripts/profile-init.mjs --check .commandmate/profile.json --repo-root .
```

**規則ごとに1行**、次を出す（`check.rules[]`、および `summary_markdown` の表）。

| 出るもの | 意味 |
|---|---|
| `when_matches` | その `when` が `--repo-root` 配下の**実ファイル何件に一致したか**。`when_examples` に先頭 3 件 |
| `add[].expands_to` | その `add` テンプレートが展開した**相異なる path の件数**（`require` の literal は常に 1） |
| `add[].existing` | そのうち**実在するものの件数**。`missing_examples` に実在しなかった先頭 3 件 |

守っている性質は4つである。

- **read-only。** tree と profile を読むだけで、profile も plan も書かない。subprocess も
  network も使わない。`--out` / `--emit` / `--repo` / `--id` は併用できず `invalid_input` になる
  —— 「起案しない mode」であることを、無視ではなく拒否で言う
- **裁定しない。** 0 件一致は**誤りではない**（これから作る file を見越した宣言はありうる）ので
  **warning であって error ではない**。`companion_when_unmatched`（`when` が何にも当たらない）と
  `companion_add_missing`（`when` は当たったが `add` の展開先が1つも実在しない）が出て
  status は `partial` になるが、**exit は 0** である（第7節と同じ規約）
- **planner は対象リポジトリを開かない**（第9.1節）は**不変**である。`--check` は planner では
  なく、**人間が profile をレビューするときに使う別 runner** であり、plan の純関数性には
  一切触れない
- **一致判定を2箇所に持たない。** `{dir}` / `{base}` の展開と一致判定、および宣言の正規化は
  `scripts/lib.mjs` にあり、**planner と `--check` は同じ関数を呼ぶ**。`--check` が独自の解釈を
  持てば「`--check` は通るが planner は一致しない」という、この節が消しに来た事象の変種を
  自分で作ることになる

**「subprocess を使わない」は性質であって都合ではない。** 読み取り以外を一切しないので、
`--check` は走っている run の隣で何回呼んでも安全であり、同じ tree からは byte 一致の
報告が出る。だから、**コマンドを走らせる read-only 点検は `--check` に相乗りさせない** ——
Issue 本文の `path:line` を base の tree に突き合わせる `scripts/inspect.mjs --check-references`
（[#217](https://github.com/Kewton/commandmate-skills/issues/217)）は `--ref` 指定時に
`git show` を呼ぶので、別 runner として置いた。規律（何も書かない・裁定しない・warning は
`partial` のまま exit 0・読めない入力は拒否する）は本節と同じである。全文は
[runner-operations.md](./runner-operations.md) 第15節。

**`--check` は profile を承認しない。** 契約適合の裁定は planner 側にある。ひとつだけ
`--check` が判定しないのは `require[].add` のリテラルが repo の外を指していないか
（第9.3節の `users/…` `C:/…` `https://…`）で、これは planner の path 語彙に属する拒否である。
`--check` はそのリテラルを**「実在しない path」として warning に出す**（実際そうである）一方、
planner は profile を読んだ時点で `load_error` にする。**許可を与えるのは planner だけ**なので、
拒否も planner が持つ。

走査から外す directory は `.git` / `node_modules` / `.venv` / `__pycache__` の4つで、report が
その一覧を `check.skipped_directories` に載せる。生成物置き場（`dist` / `build` / `target`）は
**外さない** —— 生成ファイルはまさに `derive` が宣言する対象だからである。tree が大きく走査上限に
達した場合は warning `tree_scan_truncated` が出て、件数は**下界**として読む。

## 10. `dispatch_defaults` — repo 固有の運転既定（任意）

runner 側の正本は [dispatch-contract.md](./dispatch-contract.md) 第1.1節である
（[#180](https://github.com/Kewton/commandmate-skills/issues/180)）。

### 10.1 何を解く field か

`--no-infer` / `--auto-yes` / `--wait-timeout` は、その run の事情ではなく**リポジトリの事情**を
書いている flag である。

- `--no-infer` — 散文の語彙が重なるリポジトリでは、依存でないものが依存に見える
- `--auto-yes` — worker が書く前に訊くリポジトリでは、付け忘れた run が prompt で止まる
- `--wait-timeout` — e2e / build を含む baseline は、既定 300 秒では必ず timeout する

これらの置き場は人間の記憶と CLAUDE.md しかなく、**付け忘れは「遅い run」ではなく事故**
（phantom edge、誰も答えない prompt、`wait_window_exhausted`）になっていた。第5節が言うとおり
リポジトリ知識の入口は profile だけであり、運転既定もリポジトリ知識である。

### 10.2 形

```json
"dispatch_defaults": {
  "no_infer": true,
  "auto_yes": true,
  "wait_timeout": 3600,
  "max_turns": 10
}
```

| key | 型 | 対応する flag | 消費するのは |
|---|---|---|---|
| `no_infer` | boolean | `--no-infer` | **planner**（`orchestrate.mjs`）。ただし現 version は未消費 —— 第10.6節 |
| `auto_yes` | boolean | `--auto-yes` / `--no-auto-yes` | dispatch |
| `wait_timeout` | 1 以上の整数（秒） | `--wait-timeout` | dispatch |
| `max_turns` | 1 以上の整数 | `--max-turns` | dispatch |

すべて任意で、**未指定の key は宣言が無いのと同じ**である。未知の key・型違い・0 以下は拒否する。
読み飛ばす実装だと、新しい runner 向けの profile が古い runner で**半分だけ効く**ことになるからである
（第9.3節と同じ理由）。空の `{}` は正当で、何も宣言していないのと同じである。

**同じ型規則を両側が持ち、code / exit だけが違う**（[#196](https://github.com/Kewton/commandmate-skills/issues/196)）。

| 読む側 | 何について読むか | 拒否 |
|---|---|---|
| planner（`orchestrate.mjs`） | **profile ファイル** | `load_error` / exit 6。Issue を読む前、profile を読んだ時点で止まる |
| dispatch（`dispatch.mjs`） | **plan ファイル**の `plan.profile.dispatch_defaults` | `plan_invalid` / exit 3。dispatch を始めない |

code が割れているのではなく、**同じ不備が違うファイルについての事実**だからそうなっている。
profile の他の不備（`profile.baseline must be an array of strings` 等）はすべて `load_error` / exit 6
で出ており、ここだけ exit 3 にすると planner 側の規約が割れる。dispatch にとっては逆で、渡された plan は
この planner が作ったとは限らない（第10.6節）から、事実は plan ファイルについてのものになる。

**検証ロジックは共有しない（両側に持つ）。** dispatch は自分の検証を planner に降ろせない ——
loader を通っていない plan を受ける経路がある以上、profile 側の検査は dispatch にとって
「起きたはず」でしかない。二重に持つ代わりに、**受理する宣言の集合は完全に一致させる**
（`null` はどちらも拒否、`{}` はどちらも受理）。片方だけが通す宣言があると、二重化が監査できなくなる。

### 10.3 解決規則

1. **CLI flag は常に上書きする（explicit wins）。明示された off も上書きする。**
   boolean flag は「渡していない」と「off のつもりで渡した」が同じ argv になるので、
   dispatch は三値（true / false / 未宣言）で読み、false を打つ手段として `--no-auto-yes` を持つ。
   `--auto-yes` と `--no-auto-yes` の同時指定は `invalid_input`。
2. **既存の検証は解決後の値に対して行う。** `--unattended` と auto-yes の排他は、
   flag 由来でも profile 由来でも同じく `invalid_input`（exit 3）である。逃げ道は `--no-auto-yes`。
3. 解決結果は dispatch report の limitation `dispatch_defaults_applied` に1行で残る。
   宣言の無い plan では entry が出ないので、**その run の report は本 field 以前と byte 一致する。**

`no_infer` を dispatch は消費できない（承認済み plan を後から un-infer はできない）。
plan の `inputs.infer` と突き合わせ、食い違ったときだけ limitation
`dispatch_defaults_no_infer_not_applied` を残す。**黙って無視はしない。**

### 10.4 run_id と運転既定

profile は **field を選ばず丸ごと** run_id の hash に入る（[#157](https://github.com/Kewton/commandmate-skills/issues/157)、
[plan-contract.md](./plan-contract.md) 第1節）。したがって `dispatch_defaults` を編集した profile で
plan を取り直すと**別の run_id になり、別の run directory に書かれる**。これは
`baseline` や `scope_companions` を直したときと同じ性質で、`dispatch_defaults` のために
新しく作った仕組みではない —— 列挙を持たない hash の設計がそのまま効く。

運用上の注意も第9.5節と同じである: 宣言を直して同じ plan を取り直そうとすると
`run_exists`（exit 4）になるので、`--run-id` か `--runs-dir` を使う。

### 10.5 起案（`profile-init.mjs`）は `dispatch_defaults` を出さない

起案 runner が読むのは**リポジトリが自分について宣言していること**である（第7.1節）。
base branch は workflow に、baseline は `package.json` に、テスト配置は互いを写す2つの実ファイルに
書いてある。運転既定はそのどれでもない ——「このリポジトリには `--no-infer` が要る」は
**動かしてみた人間が到達した結論**であって、tree の中に書いてある事実ではない。

起案すれば必ず推測になり、推測した `auto_yes: true` は検出した `auto_yes: true` と
出力上見分けがつかない（第7.2節が消しに来た性質そのもの）。`scope_companions` のように
**空の宣言 + TODO** を置くこともしない。あちらの空宣言は「配置を決定できなかった」という
TODO と対になっているから意味があるのに対し、ここには決定すべき材料が最初から無く、
TODO はすべてのリポジトリで永久に立ち続けることになる。

**key ごと出さない。** 出さなければ flag の既定値がそのまま効き、draft の使い勝手は変わらない。
運転して分かった時点で、人間がこの節を見て書き足す。

### 10.6 planner 側（[#196](https://github.com/Kewton/commandmate-skills/issues/196)）

**`dispatch_defaults` を宣言した profile は plan 段階を通る。** `orchestrate.mjs` の
`PROFILE_FIELDS` が本 field を持ち、`publicProfile()` が宣言を `plan.profile` へ echo する。
dispatch は profile ファイルを開かず `plan.profile.dispatch_defaults` を読むので、
**この echo が宣言から runner までの経路そのもの**である。

echo の規則は `scope_companions` と同じで、そこに1つ足す。

- **宣言したときだけ**出す。宣言しない profile の plan は、本 field が無かった頃と **1 byte も変わらない**
  （既存の全文 golden がそのまま非回帰の測定になっている）
- **必須7 field の後ろに、宣言順ではなく固定順で**出す。順は
  `scope_companions` → `dispatch_defaults` → `integration_baseline`
  （[#195](https://github.com/Kewton/commandmate-skills/issues/195) が末尾に着地済み。第11.6節）。
  **この順序が plan のバイト列を決める**ので、
  新しい任意 field は常に末尾へ追加する（間に差し込むと、内容の変わっていない plan のバイト列が動く）
- **契約の key 順に組み直して**から載せる（`no_infer` / `auto_yes` / `wait_timeout` / `max_turns`）。
  profile は field を選ばず丸ごと run_id の hash に入る（第10.4節）ので、組み直さないと
  **profile の中で key を並べ替えただけで run_id が割れる**

第10.4節の run_id の性質は、宣言が loader を通った時点で追加の実装なしに得られている
（署名は field を列挙していない）。

**planner は本 field を読むだけで、使わない。** `no_infer` は planner の flag だが、この version の
planner は宣言を消費しない —— 受理して echo するだけである。したがって `no_infer: true` を宣言した
profile で `--no-infer` を渡さずに plan を作ると、plan は**推論ありのまま**作られ、dispatch が
第10.3節の `dispatch_defaults_no_infer_not_applied` を残す。第10.2節の表が `no_infer` の消費者を
planner と書いているのは**到達点であって現状ではない**。宣言を planner が実際に消費するのは別 Issue である。

`plan.profile.dispatch_defaults` を持つ plan を**手で用意する**経路は塞がらない（plan は artifact であり、
status / resume が読む plan をこの planner が作ったとは限らない）。だから dispatch 側の検証は
残り続ける ——第10.2節の「両側に持つ」はそれである。

## 11. `integration_baseline` — 合流後の統合ブランチに対する検証（任意）

runner 側の正本は [merge-contract.md](./merge-contract.md) 第5.4節である
（[#195](https://github.com/Kewton/commandmate-skills/issues/195)、[#175](https://github.com/Kewton/commandmate-skills/issues/175)）。

### 11.1 何を解く field か

`baseline` と「合流後の統合ブランチが green か」は、**目的の違う検証集合**である。

| | `baseline` | `integration_baseline` |
|---|---|---|
| 誰が回すか | **各 worker**（dispatch の fallback 検証。worktree の中） | **merge 後に1回**（`--integration-verify`） |
| 何を測るか | その worker の作業が壊れていないか（proportional な健全性確認） | **合流後の統合ブランチが green か** |
| 適切な重さ | 軽い。重い build / e2e は最後の verify に任せる | **そのリポジトリの「合格の定義」そのもの** |

#175 は後者を前者の配列で実行していた。同じ key を共有している限り、どちらか一方は必ず間違う ——
`baseline` を重くすれば worker の fallback 検証が毎回 build / e2e を回し、軽いままにすれば
opt-in した統合検証が**測っていないのに green** になる。

**実測（Kewton/BorderFreeKidsMap、#175 を起票させた当の事象）。** そのリポジトリの `baseline` は
`npm ci` / lint / typecheck の3つで、`build` も `unit` も入っていない —— 運用文書が
「worker が回す健全性確認は proportional であるべきで、重い build は最後の verify に任せる」と
決めているからである。#105 × #106（file 重なり 0、合流後に `npm run test:unit` が赤）は、
したがって **`--integration-verify` を付けても捕まらない。** この機能が消しに来た当の事象が、
この機能を有効にしたまますり抜ける。第7.1節が `baseline` の起案根拠を toolchain manifest に
置いているのも、`baseline` が意図しているのが前者だという同じ事実である。

### 11.2 形と解決規則

```json
"integration_baseline": [
  "bash .claude/skills/cmate-verify/scripts/verify-run.sh --cwd ."
]
```

**型規則は `baseline` と同じ**（文字列の配列）。同じ「順番に実行する command の列」であり、
片方だけ違う規則を持つと、同一 profile の2つの検証リストが「command とは何か」について
食い違うことになる。未知の型・非文字列の要素は `load_error` / exit 6 で拒否する。

解決は **`integration_baseline` ?? `baseline`** で、**`??` が働くのは未宣言（key が無い）ときだけ**である。

| profile の状態 | `--integration-verify` が実行するもの | `integration_verify.source` |
|---|---|---|
| `integration_baseline` 未宣言 | `baseline`（#195 以前と同じ。**既存 profile の run は 1 byte も変わらない**） | `"baseline"` |
| `integration_baseline` に1件以上 | **その配列**（`baseline` は使わない） | `"integration_baseline"` |
| `"integration_baseline": []` | **何も実行しない。`preflight_failed` / exit 1 / `integration_verify_unavailable`**（1件も merge しない） | `"integration_baseline"` |
| 両方とも空／未宣言 | 同上（#175 の fail-closed のまま） | `"baseline"` |

**`[]` を `baseline` に落とさないのは本 field の論旨そのものである。** `[]` は
「このリポジトリに統合検証の定義は無い」という**宣言**であって、未宣言とは別の事実である。
目的の違う `baseline` へ黙って落とすことは、明示的に書いた profile に対してだけ
**静かなフォールバック**を復活させることになる。fail-closed は第7.2節と同じ規律
（**埋め忘れた検証は fail-closed でなければならない**）で、宣言の有無に関わらず貫く。

### 11.3 どちらを採ったかは report に残る

`merge-report.json` の `integration_verify.source`（`"integration_baseline"` | `"baseline"`）である。
**どちらを測ったのかが report から読めないと、この分離は「静かな2つ目の baseline」になる** ——
同じコマンドを打った2つの run が違う集合を測り、report は同じに読めてしまう。
何も実行しなかった run（preview / 空宣言の拒否）でも記録する: 「何を測るはずだったか」が、
2つある拒否の対処を分ける唯一の手がかりだからである（[codes-and-recovery.md](./codes-and-recovery.md) 第4節）。

### 11.4 run_id と統合検証

profile は **field を選ばず丸ごと** run_id の hash に入る（第10.4節と同じ性質）。
`integration_baseline` を書き換えて plan を取り直せば別の run_id になる。ここでは性質の意味が
1段強い —— **書き換えたのは「合格の定義」そのもの**なので、同じ id を共有して既存の run directory を
再利用すれば、差し替える前の定義で merge して「検証した」と報告することになる。

### 11.5 起案（`profile-init.mjs`）は `integration_baseline` を出さない

第10.5節・[#180](https://github.com/Kewton/commandmate-skills/issues/180) / [#181](https://github.com/Kewton/commandmate-skills/issues/181) と同じ規律である。
起案 runner が読むのは**リポジトリが自分について宣言していること**であり（第7.1節）、
`baseline` は toolchain manifest から読める。しかし**「合流後の統合ブランチが満たすべき条件」は
tree の中に書いてある事実ではない** —— 起案すれば `baseline` の複製（＝この field を作った意味が消える）か、
根拠のない重い列の推測かのどちらかにしかならない。

**空宣言 + TODO の route も採らない。** `scope_companions` の空宣言は「配置を決定できなかった」という
TODO と対になっているから意味があるのに対し、ここでは第11.2節のとおり `[]` 自体が
「統合検証は無い」という**宣言**であり、`--integration-verify` を渡した run を全部落とす。
起案 runner が policy を沈黙で決めることになる。**key ごと出さない**（出さなければ `baseline` への
フォールバックがそのまま効き、draft の使い勝手は #195 以前と同じである）。

### 11.6 planner 側（本 Issue に含む）

**`integration_baseline` を宣言した profile は plan 段階を通る。** `orchestrate.mjs` の
`PROFILE_FIELDS` が本 field を持ち、`publicProfile()` が宣言を `plan.profile` へ echo する。
merge は profile ファイルを開かず `plan.profile.integration_baseline` を読むので、
**この echo が宣言から runner までの経路そのもの**である。

読む側だけ先に着地させると、宣言を書いた profile が plan 段階を通らない（`load_error` / exit 6）。
それは #180 が踏み、第10.6節が2 release ぶん自認していた非対称そのものなので、
**本 Issue は planner 側を同時に着地させる。** echo の規則は第10.6節の3点と同じで、順序だけが増える。

- **宣言したときだけ**出す。宣言しない profile の plan は、本 field が無かった頃と **1 byte も変わらない**
- **必須7 field の後ろに、固定順で**出す。順は
  `scope_companions` → `dispatch_defaults` → `integration_baseline` で、**新しい任意 field は常に末尾**へ足す
- **`[]` は `[]` のまま echo する**（絶対に落とさない）。第11.2節の解決は key の**存在**で分岐するので、
  空宣言を「無かったこと」にした plan は、merge にとって未宣言の profile と見分けが付かなくなる

**planner は本 field を読むだけで、使わない**（`dispatch_defaults` と同じ）。plan 内容は1 byte も変わらず、
変わるのは `plan.profile` の echo と、その結果としての run_id だけである。

`plan.profile.integration_baseline` を持つ plan を**手で用意する**経路は塞がらない（plan は artifact である）。
merge 側は plan を読む側として、配列でない値・欠けた値を「実行できるものが無い」＝ fail-closed 側に倒す。

## 12. `observations` — merge 後に base branch で測るもの（任意）

[#221](https://github.com/Kewton/commandmate-skills/issues/221)。読む側の契約は
[observe-contract.md](./observe-contract.md) が正本で、ここは **profile field としての形**である。

### 12.1 何を解く field か

受入条件には **worktree の中では測れないもの**がある。「merge 後の CI 3 run の wall-clock 中央値が
着手前より 1 分以上短い」「CI 5 run の e2e 時間が 30% 以上短い」。`baseline` は worker の健康診断、
`integration_baseline` は合流後 1 回の検証であり、**どちらも「N 回測って並べる」段ではない。**
測る対象は repository ごとに違う（workflow 名・job 名・step 名・計測 command）ので、
**出どころは profile だけ**である。

### 12.2 形

```json
"observations": [
  { "id": "ci-wallclock", "kind": "gh_run",      "workflow": "ci.yml", "unit": "s" },
  { "id": "e2e-step",     "kind": "gh_job_step", "workflow": "ci.yml", "job": "e2e", "step": "Run e2e", "unit": "s" },
  { "id": "bundle-size",  "kind": "command",     "command": "bash scripts/measure-bundle.sh", "unit": "bytes" }
]
```

| key | 必須 | 説明 |
|---|---|---|
| `id` | 常に | 観測の名前。`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。**文書をまたぐ lookup key** である（report と `--inspect` の突き合わせ）ので、JSON key として往復できる形に限る |
| `kind` | 常に | `gh_run` / `gh_job_step` / `command` |
| `workflow` | `gh_run` / `gh_job_step` | workflow file 名 |
| `job` / `step` | `gh_job_step` | job 名と step 名 |
| `command` | `command` | merge commit の使い捨て checkout で回す command。空白分割・shell 無し（`baseline` と同じ規則） |
| `unit` | 常に | 単位。**既定を置かない** —— runner は換算しないので、`446` と `446000` を見分ける唯一の情報である |

### 12.3 拒否される宣言（すべて `load_error` / exit 6）

第9.3節と同じ規律である。**黙って飛ばさない。**

| 宣言 | 理由 |
|---|---|
| 配列でない | 宣言は測定の**並び**である |
| entry が object でない | 同上 |
| 未知の `kind` | 飛ばした run は「揃った観測集合」を名乗りながら、著者が頼んだ測定を欠く |
| `kind` の必須 key 不足 | 何を測るのか決まらない |
| `unit` 不足・空 | 第12.2節 |
| entry の未知 field | closed である（例: `threshold` を書いても runner は判定しない） |
| `id` の重複 | 「`ci-wallclock` の値」が2つになる。id はそれを消すために在る |
| `id` が token でない | 文書をまたぐ lookup key だから |

正規化は **`scripts/lib.mjs` の `normalizeObservations`** に在る。**planner と `observe.mjs` の両方が
読むから**である（`observe.mjs --profile <path>` は profile file を直接読む）。2つ持てば
「宣言が何を意味するか」について2つの意見を持つことになり、その食い違いは黙って進む。

### 12.4 起案（`profile-init.mjs`）は `observations` を出さない

第10.5節・第11.5節と同じ理由である。**tree の中に「この repository の受入条件が何を測るか」は
書いていない。** workflow file から workflow 名は読めても、「どの step の秒数が受入条件なのか」は
Issue の側の話であり、起案 runner が沈黙で決めてよいものではない。**key ごと出さない。**

### 12.5 planner 側と run_id

`orchestrate.mjs` の `PROFILE_FIELDS` が本 field を持ち、`publicProfile()` が
**必須7 field の後ろ、`integration_baseline` の次**に echo する。規則は第11.6節の3点と同じで、
順序だけが増える（新しい任意 field は常に末尾）。

**planner は読むだけで使わない。** plan 内容は 1 byte も変わらず、変わるのは `plan.profile` の echo と、
その結果としての run_id だけである（解決済み profile 全体が hash 対象。第11.4節と同じ）。

**`[]` は `[]` のまま echo する。** 「この repository に merge 後の観測は無い」という宣言であり、
`observe.mjs` は `observations_undeclared` で**名指して拒否**する —— 観測を1件もしなかった run を
観測した run と同じ形にしないためである。

### 12.6 後から足したときの逃げ道

profile に本 field を足すと run_id は変わる。**しかし merge 済みの wave は re-plan できない。**
そのために `observe.mjs --profile <path>` がある（read-only・merge 後なので plan の純関数性に触れない）。
既定はあくまで `plan.profile.observations` で、逃げ道を使った run は report が
`observations_source: "profile_file"` と limitation `observations_from_profile_file` で名乗る
（[observe-contract.md](./observe-contract.md) 第4.2節）。

## 13. `pr_title_template` — `--create-prs` の PR タイトルの型（任意）

runner 側の正本は [merge-contract.md](./merge-contract.md) 第5.7節である（CommandMate#3005）。

### 13.1 何を解く field か

`merge.mjs --create-prs` は PR のタイトルを **Issue タイトルそのまま**にしていた。PR タイトルを
Conventional Commits で CI 検査するリポジトリ（semantic-pull-request）では、squash merge の件名＝PR
タイトルなので、Issue タイトルが日本語の文であるだけで**その PR は merge できない**。PR タイトルの
形はリポジトリの規約であり、リポジトリ知識の入口は profile だけである（第5節）。

### 13.2 形

```json
"pr_title_template": "{{type}}({{scope}}): {{title}} (#{{number}})"
```

| placeholder | 値 | 決まらないとき |
|---|---|---|
| `{{type}}` | ブランチ上のコミット件名（`<base>..<branch>`、merge commit を除く）の Conventional Commits の type | その PR を**作らずに止める**（`pr_title_undetermined`） |
| `{{scope}}` | 同じコミット件名の scope | 同上 |
| `{{title}}` | Issue タイトル（従来の PR タイトル） | —（無ければ `Resolve issue #<n>`） |
| `{{number}}` | Issue 番号 | — |

**「決まる」とは、全コミットの件名が `type(scope): description`（`!` 可）の形で、使われている要素が
全コミットで1つの値に揃っていること**である。件名が1つでも形を外れる・コミットが無い・type（scope）が
コミット間で食い違う・`{{scope}}` を使うのに scope の無い件名がある —— いずれも**推測しない**。

拒否される宣言（planner は `load_error` / exit 6、merge は plan について `plan_invalid` / exit 3。
検証は `lib.mjs` の `normalizePrTitleTemplate` 1つを両側が呼ぶ）:

- 文字列でない・空・改行を含む・200 文字を超える
- 上の4つ以外の placeholder（`{{kind}}` など）。**タイトルに文字のまま残すことはしない**

### 13.3 `dispatch_defaults` に入れない理由

`dispatch_defaults` は dispatch が読む運転既定で、真偽値と正の整数しか受けず、未知の key を拒否する
（第10.2節）。PR タイトルは **merge が読む**文字列であり、読み手も型も違う。`integration_baseline`
（第11節）と同じく、merge の読む欄として独立させた。

### 13.4 planner 側と run_id

planner は読むだけで使わない。検証して `plan.profile` の最後（optional field の末尾）へ echo する。
**欄の無い profile の plan は byte 一致のまま**であり、欄を足した profile は別の run_id になる（第10.4節と同じ）。

### 13.5 起案（`profile-init.mjs`）は `pr_title_template` を出さない

タイトルの規約は CI の設定（semantic-pull-request の type 一覧など）から**推測はできる**が、
推測した型と検出した型は出力上見分けがつかない（第10.5節と同じ理由）。人間が書き足す。


## 14. `worker_messages` — worker へ送る文面への追記（任意）

runner 側の正本は [dispatch-contract.md](./dispatch-contract.md) 第1.1節である
（CommandMate#3009）。

```json
"worker_messages": {
  "nudge": "指示どおりに書けないと分かったら、進めずに止めて報告してください。"
}
```

| key | 型 | 消費するのは |
|---|---|---|
| `nudge` | 空白のみでない文字列（2000 文字以下） | dispatch の監督 nudge（`--nudge-message` が同じ位置を上書きする） |
| `fix_nudge` | 空白のみでない文字列（2000 文字以下） | uat の修正ループ（fix worker）の nudge（`uat --fix-nudge-message` が同じ位置を上書きする）。既定文の後ろに追記する |

- **差し替えではなく追記**である。dispatch の既定 nudge の**後ろ**に足す。既定文の
  「単一 commit が完了の合図」の行は runner が必ず付けるので、profile からは消せない。
- 既定文にも「指示どおりに書けないと分かったら、進めずに止めて報告してください。」が入っている。
  この field は、リポジトリ固有の但し書きを足したいときのものである。
- `dispatch_defaults` の**外**に置く。あちらは真偽値と整数だけで、未知の key を拒否する object である。
- 未知の key・空文字・空白のみ・文字列以外・2000 文字超は `load_error` / exit 6（planner）、
  plan 経由なら `plan_invalid` / exit 3（dispatch）で拒否する。
- 宣言は plan の `profile.worker_messages` に写る（宣言が無ければ写らず、plan は従来と byte 一致）。
  profile ごと run_id の hash に入るので、直して取り直すと別の run_id になる。
- 対象は dispatch の監督 nudge（`nudge`）と uat の fix nudge（`fix_nudge`）である。commit 依頼（`COMMIT_REQUEST_MESSAGE`）は変えない。
- planner と dispatch はどちらも `nudge` / `fix_nudge` の両方を受理する（自分が使わない key でも拒否しない。dispatch は `fix_nudge` を使わず、uat が読む）。検証は同じ規則（空白のみでない・2000 文字以下）を共有する。
