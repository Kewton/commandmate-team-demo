#!/usr/bin/env node
// cmate-orchestrate — deterministic profile DRAFT runner (Node stdlib only, Node >= 22).
//
// The planner resolves base branch, branch name, worktree path and baseline
// verification from a *profile* (references/profile-contract.md). Two profiles
// ship built in; every other repository has to hand-write one and run the
// planner with --allow-unverified. That hand-writing step is the first wall a
// CommandMate user hits, and this runner lowers it: it reads what the target
// repository already declares about itself — package.json, Cargo.toml,
// pyproject.toml, go.mod, Makefile, .github/workflows, the contributing docs,
// .git/config — and drafts a profile from that evidence.
//
// Three properties make the draft reviewable rather than merely convenient:
//
//   verified is FALSE, always. This runner never confirms a profile; confirming
//   one means running the baseline in a real worktree, which is what
//   references/profile-contract.md §8 asks a human to do before flipping the
//   flag. A drafting tool that could promote its own draft would make the flag
//   meaningless.
//
//   Every field says where it came from. `provenance[]` names the file, the line
//   and the text each default was read out of. A field with no evidence in the
//   repository gets a SAFE TEMPLATE and an explicit TODO — never a quiet guess
//   that reads exactly like a detected value.
//
//   The output is a pure function of the repository's bytes. No network, no
//   clock, no subprocess: only files under --repo-root are read, and every
//   directory listing is sorted before use, so a Claude run and a Codex run over
//   the same tree produce byte-identical output (the parity the four runners are
//   held to).
//
// Provenance is NOT a field inside the emitted profile. orchestrate.mjs rejects
// a profile carrying any field outside the contract (`load_error`, "profile has
// an unknown field"), so a profile annotated in place would be refused by the
// very runner it is drafted for. It travels alongside instead: --out writes the
// contract-clean profile, stdout carries the envelope that explains it.
//
// Issue #94.
//
// ---- The second mode: --check (Issue #197) ----------------------------------
//
// Drafting runs FORWARD, from a repository to a proposed declaration. `--check`
// runs BACKWARD, from an existing declaration to the repository it claims to
// describe: for each `scope_companions` rule it reports how many real files the
// `when` matches and how many of the paths the `add` produces exist. Same three
// properties — read-only, no subprocess, a pure function of the bytes it reads —
// and the same exit-code convention.
//
// It exists because a rule can be perfectly legal and match NOTHING.
// references/profile-contract.md §9.3 already refuses the brace typos that would
// leave "a rule that never matches and never says so", but `scripts/{base}.mjs`
// and `scripts/{dir}{base}.mjs` are both legal and only the second one reaches
// `scripts/adapters/human-review.mjs`. Before this, the only way to tell them
// apart was to write an issue fixture, run the planner and read `scope_defaults`
// — so a mistyped rule was normally discovered by a worker failing the scope
// gate, which is the one place it cannot be repaired.
//
// Two properties make it a review tool rather than a second gate:
//
//   IT DOES NOT ADJUDICATE. A rule that matches nothing is a WARNING, never an
//   error. Declaring a companion for files that do not exist yet is a legitimate
//   thing to do, and a check that called it wrong would be teaching authors to
//   write their profile after their code instead of before it.
//
//   IT IS NOT THE PLANNER. §9.1 — "the planner never opens the target
//   repository" — is untouched, and untouchable: this is a different runner, run
//   by a human, at profile-review time. What the two share is the MATCHER
//   (lib.mjs), because a `--check` with its own reading of `{dir}` / `{base}`
//   would be a second truth, and the first thing it would produce is a rule
//   `--check` calls matched and the planner does not.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

import {
  REDACTIONS,
  SKILL_ID,
  SKILL_VERSION,
  SkillError,
  normalizeScopeCompanions,
  compileScopeCompanions,
  companionsForPath,
} from './lib.mjs';

const PROFILE_INIT_SCHEMA_VERSION = 1;

// The profile contract's field set, in the order references/profile-contract.md
// documents it. The draft is emitted in exactly this shape: no more fields (the
// planner refuses unknown ones) and no fewer (it refuses missing ones).
const PROFILE_FIELDS = [
  'id',
  'repository',
  'base',
  'branch_template',
  'worktree_template',
  'baseline',
  'verified',
  // Optional in the contract, always emitted here: a drafted profile that stayed
  // silent about companions would be indistinguishable from one whose author
  // decided there were none, and telling those two apart is this runner's job.
  // An undetectable layout yields an EMPTY declaration plus a TODO, which
  // derives exactly what no declaration derives (Issue #149).
  'scope_companions',
  // `dispatch_defaults` (Issue #180) is deliberately NOT here, and its absence is
  // a decision rather than an omission. This runner drafts what the repository
  // DECLARES ABOUT ITSELF: a base branch is in a workflow file, a baseline is in
  // package.json, a test layout is two real files that mirror each other. The
  // operating defaults are none of those — "this repository needs --no-infer",
  // "our workers ask before they write", "our e2e turn needs an hour" are
  // conclusions somebody reached by RUNNING the thing, and no file in the tree
  // states them. Drafting them would mean guessing, and this runner's whole
  // contract is that "we defaulted" and "we detected" never look alike (§7.2);
  // a guessed `auto_yes: true` would read exactly like a detected one and arm
  // auto-yes for every worker of every run made from that draft.
  //
  // Nor is an empty `dispatch_defaults: {}` emitted the way `scope_companions`
  // gets its empty declaration. That one is emitted BECAUSE it comes with a TODO
  // that says the layout could not be determined, and a TODO here would fire on
  // every repository forever: there is nothing to determine. An absent key
  // resolves the same values the flags always resolved, so the draft stays
  // exactly as usable as it was, and profile-contract.md §10 tells the reviewer
  // where to add the key once they have run the repository enough to know.
];

// Safe templates. Used when the repository says nothing about a field, always
// together with an explicit TODO — the point is that "we defaulted" and "we
// detected" never look alike in the output.
const DEFAULT_REPOSITORY = 'OWNER/REPO';
const DEFAULT_BASE = 'origin/main';
const DEFAULT_BRANCH_PREFIX = 'feature';
const DEFAULT_WORKTREE_TEMPLATE = '../{repo}-issue-{number}-{slug}';

// A baseline that cannot be inferred must fail CLOSED. dispatch.mjs re-runs the
// baseline inside the worktree and passes only when every command exits zero, so
// a placeholder that errors is the safe stand-in; an empty baseline would leave
// the contract path with nothing to judge. `false` exits non-zero whether it is
// spawned directly (the trailing tokens become inert arguments) or ever read by
// a shell (they become a comment).
const BASELINE_PLACEHOLDER = "false # TODO: replace with this repository's verification commands";

// Files larger than this are not evidence, they are payload. Skipped with a
// warning rather than read.
const MAX_SOURCE_BYTES = 1024 * 1024;

// Free-text evidence is echoed back to the reviewer, so it is redacted and
// clipped like every other lifted string in this package.
const EVIDENCE_MAX_CHARS = 160;

// =============================================================================
// Redaction
// =============================================================================

// The non-tallying copy, matching orchestrate.mjs: this envelope has no
// `redactions[]` field, so the tallying version in lib.mjs would be a behavior
// change rather than a shared helper. The PATTERNS are shared, which is the part
// that must never drift between runners.
function redact(value) {
  let text = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

// =============================================================================
// Argument parsing
// =============================================================================

const USAGE = `cmate-orchestrate profile runner (read-only): draft one, or check one

Usage:
  profile-init.mjs [options]                     draft a profile from this repository
  profile-init.mjs --check <profile.json> [...]  report what its rules match here

Options:
  --repo-root <path>     Repository to inspect (default: the working directory).
  --out <path>           Write the draft profile JSON here. Refuses to overwrite.
  --emit <mode>          What goes to stdout: "envelope" (default) or "profile".
  --repo <owner/name>    Declare the GitHub slug instead of inferring it.
  --id <id>              Declare the profile id instead of deriving it.
  --check <path>         Read an EXISTING profile and report, one line per
                         scope_companions rule, how many files under --repo-root
                         its "when" matches and how many of the paths its "add"
                         produces exist. Writes nothing. A rule that matches
                         nothing is a warning, not an error.
  --help                 Show this help.

The draft is always verified:false. It is a proposal for a human to check against
references/profile-contract.md, not a profile this runner vouches for.`;

const EMIT_MODES = new Set(['envelope', 'profile']);

// The drafting flags, which --check refuses. Stated as a list rather than as
// four conditions because the statement is one: --check DRAFTS NOTHING, so every
// flag that shapes or writes a draft is meaningless with it, and a flag silently
// ignored is a flag whose author believed it did something.
const DRAFT_ONLY_FLAGS = ['out', 'emit', 'repo', 'id'];

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        'repo-root': { type: 'string' },
        out: { type: 'string' },
        emit: { type: 'string' },
        repo: { type: 'string' },
        id: { type: 'string' },
        check: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new SkillError('invalid_input', error.message, 3);
  }
  return parsed;
}

// `owner/name`, the shape `gh --repo` takes. Rejected rather than sanitized: a
// slug this runner had to repair is a slug the reviewer should have written.
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// A profile id ends up in run ids, artifact paths and error messages, so it is
// held to the same plain-token shape a branch segment is.
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function resolveInputs(parsed) {
  const { values } = parsed;

  const repoRoot = values['repo-root'] ?? '.';
  if (String(repoRoot).trim() === '') {
    throw new SkillError('invalid_input', '--repo-root must not be empty', 3);
  }
  if (!existsSync(repoRoot)) {
    throw new SkillError('load_error', `no directory at --repo-root ${redact(repoRoot)}`, 6);
  }
  if (!statSync(repoRoot).isDirectory()) {
    throw new SkillError('invalid_input', `--repo-root ${redact(repoRoot)} is not a directory`, 3);
  }

  // --check is a MODE, not a modifier. It reads a profile that already exists
  // and reports; it drafts nothing, so every flag that shapes or writes a draft
  // is refused beside it rather than ignored.
  const check = values.check ?? null;
  if (check !== null) {
    if (String(check).trim() === '') {
      throw new SkillError('invalid_input', '--check must name a profile JSON file', 3);
    }
    const conflicting = DRAFT_ONLY_FLAGS.filter((flag) => values[flag] !== undefined);
    if (conflicting.length > 0) {
      throw new SkillError(
        'invalid_input',
        `--check cannot be combined with ${conflicting.map((flag) => `--${flag}`).join(' / ')}: ` +
          '--check reads an existing profile and writes nothing, so there is no draft to name, ' +
          'emit or write. Run the two modes separately.',
        3,
      );
    }
    if (!existsSync(check)) {
      throw new SkillError('load_error', `no profile at --check ${redact(check)}`, 6);
    }
    return { repoRoot, check };
  }

  const emit = values.emit ?? 'envelope';
  if (!EMIT_MODES.has(emit)) {
    throw new SkillError(
      'invalid_input',
      `unknown --emit "${redact(emit)}"; use "envelope" or "profile"`,
      3,
    );
  }

  const repoOverride = values.repo ?? null;
  if (repoOverride !== null && !REPO_SLUG_RE.test(repoOverride)) {
    throw new SkillError('invalid_input', `--repo must be owner/name: got "${redact(repoOverride)}"`, 3);
  }

  const idOverride = values.id ?? null;
  if (idOverride !== null && !PROFILE_ID_RE.test(idOverride)) {
    throw new SkillError(
      'invalid_input',
      `--id must start alphanumeric and use only [A-Za-z0-9._-]: got "${redact(idOverride)}"`,
      3,
    );
  }

  const out = values.out ?? null;
  // Same rule as every mutating runner's --out: an existing artifact is never
  // overwritten, because the file this would clobber is a profile someone may
  // already have reviewed and edited.
  if (out !== null && existsSync(out)) {
    throw new SkillError(
      'out_exists',
      `--out ${redact(out)} already exists; refusing to overwrite a profile that may have been reviewed. ` +
        'Pass a different --out, or drop --out and read the draft from stdout.',
      4,
    );
  }

  return { repoRoot, out, emit, repoOverride, idOverride, check: null };
}

// =============================================================================
// Repository access
// =============================================================================

// Every read goes through this object so that the whole runner is confined to
// --repo-root, every listing is sorted, and each file is read at most once
// (repeat detectors over the same file cannot disagree about its contents).
function openRepo(repoRoot, warnings) {
  const cache = new Map();

  function readText(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const full = join(repoRoot, relative);
    let text = null;
    try {
      const stat = statSync(full);
      if (stat.isFile()) {
        if (stat.size > MAX_SOURCE_BYTES) {
          warnings.push({
            code: 'source_too_large',
            detail: `${relative} is larger than ${MAX_SOURCE_BYTES} bytes and was not read as evidence`,
          });
        } else {
          text = readFileSync(full, 'utf8');
        }
      }
    } catch {
      // A path that cannot be stat'ed or read is simply absent evidence. It is
      // never an error: drafting must survive an unreadable optional file.
      text = null;
    }
    cache.set(relative, text);
    return text;
  }

  function exists(relative) {
    try {
      return existsSync(join(repoRoot, relative));
    } catch {
      return false;
    }
  }

  // `list` returns [] both for "not a directory" and for "empty directory", so a
  // recursive walk needs the two told apart.
  function isDir(relative) {
    try {
      return statSync(join(repoRoot, relative)).isDirectory();
    } catch {
      return false;
    }
  }

  // Sorted names only. The order a filesystem hands back directory entries is
  // not a contract, and every default derived downstream depends on this order.
  function list(relativeDir) {
    try {
      const full = join(repoRoot, relativeDir);
      if (!statSync(full).isDirectory()) return [];
      return readdirSync(full).slice().sort();
    } catch {
      return [];
    }
  }

  // Case-insensitive lookup of a single file in a directory (CONTRIBUTING.md vs
  // contributing.md, pull_request_template.md vs PULL_REQUEST_TEMPLATE.md). The
  // on-disk name is returned so evidence quotes the real path.
  function find(relativeDir, name) {
    const wanted = name.toLowerCase();
    for (const entry of list(relativeDir)) {
      if (entry.toLowerCase() === wanted) {
        return relativeDir === '.' ? entry : `${relativeDir}/${entry}`;
      }
    }
    return null;
  }

  return { readText, exists, isDir, list, find };
}

function lines(text) {
  return text.split(/\r?\n/);
}

function evidence(file, line, text) {
  const trimmed = redact(String(text ?? '').trim());
  return {
    file,
    line: line === null || line === undefined ? null : line,
    text: trimmed.length > EVIDENCE_MAX_CHARS ? `${trimmed.slice(0, EVIDENCE_MAX_CHARS)}…` : trimmed,
  };
}

// Best-effort 1-based line of the first line matching `pattern`, so JSON- and
// TOML-derived facts can still point at a line. Null when it cannot be located;
// a null line is honest, an invented one is not.
function lineOf(text, pattern) {
  if (typeof text !== 'string') return null;
  const all = lines(text);
  for (let i = 0; i < all.length; i += 1) {
    if (pattern.test(all[i])) return i + 1;
  }
  return null;
}

function quoteLine(text, line) {
  if (typeof text !== 'string' || !line) return '';
  return lines(text)[line - 1] ?? '';
}

// =============================================================================
// repository (owner/name)
// =============================================================================

// The two git URL forms the CLI writes, normalized to `owner/name`. Same
// acceptance as orchestrate.mjs's cwd cross-check, kept as a local copy because
// that one is not exported and lib.mjs is not this Issue's to change.
function normalizeRemoteUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let rest = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(rest); // scp-like ssh form
  if (scp) {
    rest = scp[2];
  } else {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.*)$/.exec(rest);
    if (!withScheme) return null;
    const afterHost = withScheme[1].replace(/^[^/]*\//, ''); // drop [user@]host[:port]
    if (afterHost === withScheme[1]) return null;
    rest = afterHost;
  }
  rest = rest.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = rest.split('/').filter((s) => s !== '');
  if (segments.length !== 2) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(segments[0]) || !/^[A-Za-z0-9._-]+$/.test(segments[1])) return null;
  return `${segments[0]}/${segments[1]}`;
}

// Where this repository's git config lives, as a path relative to --repo-root
// when possible. In a plain clone that is `.git/config`; in a linked worktree —
// which is exactly where orchestrate is used — `.git` is a file pointing at the
// per-worktree git dir, and the remotes live in the COMMON dir it names. Reading
// through that link is still reading this repository's own metadata: no network,
// no subprocess.
function gitConfigPath(repoRoot, repo) {
  if (repo.exists('.git/config')) return { label: '.git/config', full: join(repoRoot, '.git', 'config') };
  const pointer = repo.readText('.git');
  if (typeof pointer !== 'string') return null;
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  const gitDir = isAbsolute(match[1].trim())
    ? match[1].trim()
    : resolve(repoRoot, match[1].trim());
  let commonDir = gitDir;
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (common !== '') commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
  } catch {
    // No `commondir` means the pointer already names the common dir.
  }
  const full = join(commonDir, 'config');
  return existsSync(full) ? { label: '.git/config (linked worktree)', full } : null;
}

// `[remote "origin"] url = …` out of a git config, without a git subprocess.
function originUrlFrom(configText) {
  if (typeof configText !== 'string') return null;
  let inOrigin = false;
  const all = lines(configText);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    const section = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }
    if (!inOrigin) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url) return { url: url[1], line: i + 1, text: line };
  }
  return null;
}

// package.json `repository`, in both forms npm accepts.
function repositoryFromPackageJson(pkg) {
  const raw = pkg?.repository;
  if (typeof raw === 'string') {
    const shorthand = /^(?:github:)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.exec(raw.trim());
    if (shorthand) return shorthand[1];
    return normalizeRemoteUrl(raw.replace(/^git\+/, ''));
  }
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') {
    return normalizeRemoteUrl(raw.url.replace(/^git\+/, ''));
  }
  return null;
}

function detectRepository(ctx) {
  const { inputs, repo, files } = ctx;

  if (inputs.repoOverride) {
    return {
      value: inputs.repoOverride,
      source: 'flag',
      evidence: [],
      detail: '--repo declared the GitHub slug',
    };
  }

  const config = gitConfigPath(inputs.repoRoot, repo);
  if (config) {
    let configText = null;
    try {
      configText = readFileSync(config.full, 'utf8');
    } catch {
      configText = null;
    }
    const origin = originUrlFrom(configText);
    const slug = origin ? normalizeRemoteUrl(origin.url) : null;
    if (slug) {
      return {
        value: slug,
        source: 'detected',
        evidence: [evidence(config.label, origin.line, origin.text)],
        detail: 'the "origin" remote recorded in this repository\'s git config',
      };
    }
  }

  if (files.packageJson) {
    const slug = repositoryFromPackageJson(files.packageJson);
    if (slug) {
      const line = lineOf(files.packageJsonText, /"repository"\s*:/);
      return {
        value: slug,
        source: 'detected',
        evidence: [evidence('package.json', line, quoteLine(files.packageJsonText, line))],
        detail: 'the "repository" field declared in package.json',
      };
    }
  }

  if (files.cargoTomlText) {
    const line = lineOf(files.cargoTomlText, /^\s*repository\s*=/);
    const match = /^\s*repository\s*=\s*"([^"]+)"/m.exec(files.cargoTomlText);
    const slug = match ? normalizeRemoteUrl(match[1]) : null;
    if (slug) {
      return {
        value: slug,
        source: 'detected',
        evidence: [evidence('Cargo.toml', line, quoteLine(files.cargoTomlText, line))],
        detail: 'the `repository` key declared in Cargo.toml',
      };
    }
  }

  if (files.pyprojectText) {
    const match = /^\s*(?:repository|Repository|Source|source)\s*=\s*"([^"]+)"/m.exec(files.pyprojectText);
    const slug = match ? normalizeRemoteUrl(match[1]) : null;
    if (slug) {
      const line = lineOf(files.pyprojectText, /^\s*(?:repository|Repository|Source|source)\s*=/);
      return {
        value: slug,
        source: 'detected',
        evidence: [evidence('pyproject.toml', line, quoteLine(files.pyprojectText, line))],
        detail: 'a repository URL declared in pyproject.toml',
      };
    }
  }

  return {
    value: DEFAULT_REPOSITORY,
    source: 'default',
    evidence: [],
    detail:
      'nothing in this repository names its GitHub slug (no origin remote, no repository field). ' +
      'The placeholder is deliberately not a real slug so it cannot be shipped unnoticed.',
    todo: {
      field: 'repository',
      code: 'repository_undetermined',
      detail: `replace "${DEFAULT_REPOSITORY}" with the owner/name the issues live under, or re-run with --repo <owner/name>`,
    },
  };
}

// =============================================================================
// Ecosystem and baseline
// =============================================================================

// Fixed precedence. A polyglot repository gets the first ecosystem on this list
// that it declares, and a warning naming the others — a draft that silently
// picked one of several toolchains would be the kind of quiet guess this runner
// exists to avoid.
const ECOSYSTEM_ORDER = ['node', 'rust', 'python', 'go', 'make'];

// The npm-family lockfiles, in the order a repository carrying more than one is
// resolved. `install` is the reproducible-install command, `run` the script
// prefix, and `test` the idiomatic short form where the manager has one.
const NODE_MANAGERS = [
  { lockfile: 'package-lock.json', install: 'npm ci', run: 'npm run', test: 'npm test' },
  { lockfile: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile', run: 'pnpm run', test: 'pnpm test' },
  { lockfile: 'yarn.lock', install: 'yarn install --frozen-lockfile', run: 'yarn run', test: 'yarn test' },
  // `bun test` is bun's own runner, not the package script, so bun keeps the
  // explicit `bun run test`.
  { lockfile: 'bun.lockb', install: 'bun install --frozen-lockfile', run: 'bun run', test: 'bun run test' },
];

// package.json scripts recognised as verification, in the order they are run.
const NODE_VERIFY_SCRIPTS = ['build', 'typecheck', 'lint', 'test'];

// Makefile targets recognised as verification, in the order they are run.
const MAKE_VERIFY_TARGETS = ['build', 'lint', 'test'];

function detectEcosystems(files, repo) {
  const found = [];
  if (files.packageJson) found.push('node');
  if (files.cargoTomlText) found.push('rust');
  if (files.pyprojectText || repo.exists('requirements.txt')) found.push('python');
  if (repo.exists('go.mod')) found.push('go');
  if (files.makefileText) found.push('make');
  return ECOSYSTEM_ORDER.filter((name) => found.includes(name));
}

function nodeBaseline(ctx) {
  const { files, repo, warnings } = ctx;
  const commands = [];
  const ev = [];

  const present = NODE_MANAGERS.filter((manager) => repo.exists(manager.lockfile));
  if (present.length > 1) {
    warnings.push({
      code: 'multiple_lockfiles',
      detail:
        `several npm-family lockfiles are present (${present.map((m) => m.lockfile).join(', ')}); ` +
        `the draft assumes ${present[0].lockfile}. Confirm which manager this repository actually uses.`,
    });
  }
  const manager = present[0] ?? null;
  if (manager) {
    commands.push(manager.install);
    ev.push(evidence(manager.lockfile, null, `${manager.lockfile} is present`));
  } else {
    commands.push('npm install');
    ev.push(evidence('package.json', null, 'package.json with no lockfile'));
  }

  const scripts = files.packageJson.scripts;
  const declared = scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
  const run = manager ? manager.run : 'npm run';
  const test = manager ? manager.test : 'npm test';
  let matched = 0;
  for (const name of NODE_VERIFY_SCRIPTS) {
    if (typeof declared[name] !== 'string') continue;
    matched += 1;
    commands.push(name === 'test' ? test : `${run} ${name}`);
    const line = lineOf(files.packageJsonText, new RegExp(`"${name}"\\s*:`));
    ev.push(evidence('package.json', line, quoteLine(files.packageJsonText, line)));
  }

  const todos = [];
  if (matched === 0) {
    todos.push({
      field: 'baseline',
      code: 'baseline_no_verification_scripts',
      detail:
        `package.json declares none of ${NODE_VERIFY_SCRIPTS.join(' / ')}, so the draft baseline only installs. ` +
        'Add the commands that actually prove this repository is healthy.',
    });
  }
  return {
    commands,
    evidence: ev,
    todos,
    detail: manager
      ? `package.json scripts, installed with ${manager.install} because ${manager.lockfile} is present`
      : 'package.json scripts; no lockfile was found, so the install step is not a reproducible one',
  };
}

function rustBaseline(ctx) {
  const { files, repo, workflows } = ctx;
  const commands = ['cargo fmt --check'];
  // Evidence pairs a line number with that line's TEXT, never with a summary of
  // it: a citation a reader cannot check against the file is not a citation.
  // Presence-only facts (a lockfile exists) carry a null line instead.
  const packageLine = lineOf(files.cargoTomlText, /^\s*\[package\]/);
  const ev = [evidence('Cargo.toml', packageLine, quoteLine(files.cargoTomlText, packageLine))];
  const todos = [];

  // clippy is a separate component, not a given. It goes in when the repository
  // shows it uses it, and is called out as absent when it does not.
  const clippyConfig = repo.exists('clippy.toml') ? 'clippy.toml' : (repo.exists('.clippy.toml') ? '.clippy.toml' : null);
  const clippyWorkflow = workflows.find((wf) => /\bclippy\b/.test(wf.text));
  if (clippyConfig) {
    commands.push('cargo clippy --all-targets -- -D warnings');
    ev.push(evidence(clippyConfig, null, `${clippyConfig} is present`));
  } else if (clippyWorkflow) {
    const line = lineOf(clippyWorkflow.text, /\bclippy\b/);
    commands.push('cargo clippy --all-targets -- -D warnings');
    ev.push(evidence(clippyWorkflow.path, line, quoteLine(clippyWorkflow.text, line)));
  } else {
    todos.push({
      field: 'baseline',
      code: 'baseline_clippy_not_evidenced',
      detail:
        'nothing in this repository shows clippy is used, so no clippy step was added. ' +
        'Add `cargo clippy --all-targets -- -D warnings` if this repository lints with it.',
    });
  }

  commands.push('cargo test');
  return {
    commands,
    evidence: ev,
    todos,
    detail: 'the standard cargo verification set, with clippy included only where the repository evidences it',
  };
}

// pyproject tool tables recognised as verification, in the order they are run.
const PYTHON_TOOLS = [
  { table: 'ruff', command: 'ruff check .' },
  { table: 'black', command: 'black --check .' },
  { table: 'mypy', command: 'mypy .' },
];

function pythonBaseline(ctx) {
  const { files, repo } = ctx;
  const commands = [];
  const ev = [];
  const todos = [];
  const text = files.pyprojectText ?? '';

  let envPrefix = null;
  if (repo.exists('uv.lock')) {
    commands.push('uv sync --frozen');
    ev.push(evidence('uv.lock', null, 'uv.lock is present'));
    envPrefix = 'uv run';
  } else if (repo.exists('poetry.lock')) {
    commands.push('poetry install');
    ev.push(evidence('poetry.lock', null, 'poetry.lock is present'));
    envPrefix = 'poetry run';
  } else if (files.pyprojectText) {
    const projectLine = lineOf(text, /^\s*\[(?:project|build-system)\]/);
    commands.push('python3 -m pip install -e .');
    ev.push(evidence('pyproject.toml', projectLine, quoteLine(text, projectLine)));
  } else if (repo.exists('requirements.txt')) {
    commands.push('python3 -m pip install -r requirements.txt');
    ev.push(evidence('requirements.txt', null, 'requirements.txt is present'));
  }

  let matched = 0;
  for (const tool of PYTHON_TOOLS) {
    const pattern = new RegExp(`^\\s*\\[tool\\.${tool.table}(?:\\.|\\])`);
    const line = lineOf(text, pattern);
    if (line === null) continue;
    matched += 1;
    commands.push(tool.command);
    ev.push(evidence('pyproject.toml', line, quoteLine(text, line)));
  }

  const pytestLine = lineOf(text, /^\s*\[tool\.pytest(?:\.|\])/);
  if (pytestLine !== null) {
    matched += 1;
    commands.push('pytest');
    ev.push(evidence('pyproject.toml', pytestLine, quoteLine(text, pytestLine)));
  } else if (repo.exists('tests')) {
    matched += 1;
    commands.push('pytest');
    ev.push(evidence('tests/', null, 'a tests/ directory is present'));
  }

  if (envPrefix) {
    todos.push({
      field: 'baseline',
      code: 'baseline_env_prefix',
      detail:
        `this project is managed by ${envPrefix.split(' ')[0]}; the check commands are drafted bare. ` +
        `Prefix them with \`${envPrefix} \` if they must run inside the managed environment.`,
    });
  }
  if (matched === 0) {
    todos.push({
      field: 'baseline',
      code: 'baseline_no_verification_scripts',
      detail:
        'pyproject.toml configures none of ruff / black / mypy / pytest and there is no tests/ directory, ' +
        'so the draft baseline only installs. Add the commands that prove this repository is healthy.',
    });
  }
  return { commands, evidence: ev, todos, detail: 'the python tooling this repository configures in pyproject.toml' };
}

function goBaseline() {
  return {
    commands: ['go build ./...', 'go vet ./...', 'go test ./...'],
    evidence: [evidence('go.mod', null, 'go.mod is present')],
    todos: [],
    detail: 'the standard go verification set for a module',
  };
}

function makeBaseline(ctx) {
  const { files } = ctx;
  const commands = [];
  const ev = [];
  const todos = [];
  for (const target of MAKE_VERIFY_TARGETS) {
    const line = lineOf(files.makefileText, new RegExp(`^${target}\\s*:`));
    if (line === null) continue;
    commands.push(`make ${target}`);
    ev.push(evidence(files.makefilePath, line, quoteLine(files.makefileText, line)));
  }
  if (commands.length === 0) {
    todos.push({
      field: 'baseline',
      code: 'baseline_no_verification_scripts',
      detail:
        `the Makefile declares none of the ${MAKE_VERIFY_TARGETS.join(' / ')} targets, ` +
        'so no baseline could be read from it.',
    });
  }
  return { commands, evidence: ev, todos, detail: 'the verification targets declared in the Makefile' };
}

function detectBaseline(ctx) {
  const { ecosystems, warnings } = ctx;
  if (ecosystems.length > 1) {
    warnings.push({
      code: 'multiple_ecosystems',
      detail:
        `this repository declares more than one toolchain (${ecosystems.join(', ')}); ` +
        `the draft baseline covers "${ecosystems[0]}" only. Add the other toolchains' commands by hand.`,
    });
  }

  const builders = {
    node: nodeBaseline,
    rust: rustBaseline,
    python: pythonBaseline,
    go: goBaseline,
    make: makeBaseline,
  };
  const primary = ecosystems[0];
  const built = primary ? builders[primary](ctx) : null;

  if (!built || built.commands.length === 0) {
    return {
      value: [BASELINE_PLACEHOLDER],
      source: 'default',
      evidence: [],
      detail:
        'no toolchain manifest (package.json / Cargo.toml / pyproject.toml / go.mod / Makefile) yielded a ' +
        'verification command. The placeholder exits non-zero on purpose: an unfilled baseline must fail, ' +
        'not pass by having nothing to check.',
      todo: {
        field: 'baseline',
        code: 'baseline_undetermined',
        detail:
          'replace the placeholder with the commands a worker must pass before its change is considered verified ' +
          '(install, build, lint, test — whatever this repository actually runs)',
      },
    };
  }

  return {
    value: built.commands,
    source: 'detected',
    evidence: built.evidence,
    detail: built.detail,
    todos: built.todos,
  };
}

// =============================================================================
// base branch
// =============================================================================

// The branch a feature branch is cut from, read from what CI says pull requests
// target. Preference among several: `develop` when the repository has one (a
// gitflow repository's integration branch), then `main`, then `master`, then the
// first in sorted order.
const BASE_PREFERENCE = ['develop', 'main', 'master'];

// A line-oriented reader for the one YAML shape this needs: the branch lists
// under `on: { pull_request | push }`. Deliberately not a YAML parser — a full
// parser is a dependency, and this package takes none. Anything it cannot read
// simply yields no candidates, which surfaces as an explicit TODO rather than a
// wrong answer.
function branchTriggersFrom(workflow) {
  const found = [];
  const all = lines(workflow.text);
  let onIndent = null;
  let trigger = null;
  let triggerIndent = null;
  let branchesIndent = null;
  let branchesTrigger = null;

  const indentOf = (line) => line.length - line.replace(/^\s*/, '').length;

  for (let i = 0; i < all.length; i += 1) {
    const line = all[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = indentOf(line);

    if (/^on\s*:/.test(line)) {
      onIndent = indent;
      trigger = null;
      triggerIndent = null;
      branchesIndent = null;
      continue;
    }
    if (onIndent === null) continue;
    if (indent <= onIndent) {
      // Left the `on:` block entirely.
      onIndent = null;
      trigger = null;
      triggerIndent = null;
      branchesIndent = null;
      continue;
    }

    const triggerMatch = /^\s*(pull_request|pull_request_target|push)\s*:/.exec(line);
    if (triggerMatch && (triggerIndent === null || indent <= triggerIndent)) {
      trigger = triggerMatch[1] === 'push' ? 'push' : 'pull_request';
      triggerIndent = indent;
      branchesIndent = null;
      continue;
    }
    if (trigger === null) continue;
    if (indent <= triggerIndent) {
      // A sibling key of the trigger that is not itself a trigger: out of scope.
      trigger = null;
      triggerIndent = null;
      branchesIndent = null;
      continue;
    }

    const branchesMatch = /^\s*branches\s*:\s*(.*)$/.exec(line);
    if (branchesMatch) {
      branchesIndent = indent;
      branchesTrigger = trigger;
      const inline = branchesMatch[1].trim();
      const flow = /^\[(.*)\]$/.exec(inline);
      if (flow) {
        for (const raw of flow[1].split(',')) {
          const name = cleanBranchName(raw);
          if (name) found.push({ name, trigger: branchesTrigger, line: i + 1, text: line });
        }
        branchesIndent = null;
      }
      continue;
    }
    if (branchesIndent !== null && indent > branchesIndent) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        const name = cleanBranchName(item[1]);
        if (name) found.push({ name, trigger: branchesTrigger, line: i + 1, text: line });
        continue;
      }
      branchesIndent = null;
    } else if (branchesIndent !== null) {
      branchesIndent = null;
    }
  }
  return found;
}

// A branch name usable as a base. Globs are dropped: `release/*` names a family,
// not a ref to branch from.
function cleanBranchName(raw) {
  const value = String(raw).trim().replace(/^['"]|['"]$/g, '').trim();
  if (value === '') return null;
  if (/[*?[\]!]/.test(value)) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return null;
  return value;
}

function detectBase(ctx) {
  const { workflows } = ctx;
  const candidates = [];
  for (const workflow of workflows) {
    for (const hit of branchTriggersFrom(workflow)) {
      candidates.push({ ...hit, path: workflow.path, text: quoteLine(workflow.text, hit.line) });
    }
  }

  for (const trigger of ['pull_request', 'push']) {
    const scoped = candidates.filter((c) => c.trigger === trigger);
    if (scoped.length === 0) continue;
    const names = [...new Set(scoped.map((c) => c.name))].sort();
    const preferred = BASE_PREFERENCE.find((name) => names.includes(name)) ?? names[0];
    const hit = scoped.find((c) => c.name === preferred);
    const todos = [];
    if (trigger === 'push') {
      todos.push({
        field: 'base',
        code: 'base_inferred_from_push',
        detail:
          'the base was inferred from a push trigger, not from what pull requests target. ' +
          'Confirm feature branches are actually cut from it.',
      });
    }
    // More than one candidate is a choice this runner made by convention, not a
    // fact it read. It says so rather than letting the preference order pass for
    // evidence.
    if (names.length > 1) {
      todos.push({
        field: 'base',
        code: 'base_ambiguous',
        detail:
          `CI names more than one branch (${names.map((n) => `"${n}"`).join(' / ')}); ` +
          `"${preferred}" was chosen by the ${BASE_PREFERENCE.join(' > ')} preference order, ` +
          'not because this repository says so. Confirm it.',
      });
    }
    return {
      value: `origin/${preferred}`,
      source: 'detected',
      evidence: [evidence(hit.path, hit.line, hit.text)],
      detail:
        trigger === 'pull_request'
          ? `CI runs on pull requests targeting ${names.map((n) => `"${n}"`).join(' / ')}; ` +
            `"${preferred}" was taken as the integration branch`
          : `no pull_request branch filter was declared; "${preferred}" is where CI runs on push, ` +
            'which is weaker evidence for the branch point',
      todos,
    };
  }

  return {
    value: DEFAULT_BASE,
    source: 'default',
    evidence: [],
    detail:
      'no workflow declares a branch filter, so nothing in the repository names its integration branch. ' +
      `"${DEFAULT_BASE}" is the conservative template, not a reading.`,
    todo: {
      field: 'base',
      code: 'base_undetermined',
      detail: `confirm feature branches are cut from ${DEFAULT_BASE}, and change it if this repository integrates elsewhere (e.g. origin/develop)`,
    },
  };
}

// =============================================================================
// branch_template / worktree_template
// =============================================================================

// Branch-name prefixes worth recognising in prose. The template is always
// `<prefix>/issue-{number}-{slug}`: the placeholder half comes from the profile
// contract, and only the prefix is read from the repository.
const BRANCH_PREFIXES = ['feature', 'feat', 'fix', 'bugfix', 'hotfix', 'topic', 'task', 'chore', 'issue'];
const BRANCH_PREFIX_RE = new RegExp(
  `(?:^|[\\s\`"'(])((?:${BRANCH_PREFIXES.join('|')})\\/)([A-Za-z0-9{<$%-]\\S*)`,
);

// A branch NAME is not a branch CONVENTION. `feature/greet` in a pasted terminal
// transcript is an instance; `feature/issue-<n>-<slug>` in a contributing guide
// is the rule. Only one of those should become a template, so a hit counts when
// either the name itself is written as a template (a placeholder or an issue
// marker follows the prefix) or the line is talking about branch naming.
const BRANCH_TEMPLATE_TAIL_RE = /^(?:issue|\{|<|\$|%|\d)/i;
const BRANCH_CONVENTION_LINE_RE = /branch|ブランチ|naming|convention|命名|規約/i;

function detectBranchTemplate(ctx) {
  const { docs } = ctx;
  // Counted rather than first-wins: a convention stated once in passing should
  // not outrank one used consistently. Ties keep the earliest occurrence, which
  // is the scan order declared in docSources().
  const tally = new Map();
  for (const doc of docs) {
    const all = lines(doc.text);
    for (let i = 0; i < all.length; i += 1) {
      const match = BRANCH_PREFIX_RE.exec(all[i]);
      if (!match) continue;
      if (!BRANCH_TEMPLATE_TAIL_RE.test(match[2]) && !BRANCH_CONVENTION_LINE_RE.test(all[i])) continue;
      const prefix = match[1].slice(0, -1);
      const entry = tally.get(prefix);
      if (entry) entry.count += 1;
      else tally.set(prefix, { count: 1, path: doc.path, line: i + 1, text: all[i] });
    }
  }

  if (tally.size > 0) {
    // Map preserves insertion order, so the reduce below is a stable
    // highest-count-wins with earliest-seen as the tie-break.
    let best = null;
    for (const [prefix, entry] of tally) {
      if (best === null || entry.count > best.entry.count) best = { prefix, entry };
    }
    return {
      value: `${best.prefix}/issue-{number}-{slug}`,
      source: 'detected',
      evidence: [evidence(best.entry.path, best.entry.line, best.entry.text)],
      detail:
        `"${best.prefix}/" is the branch prefix this repository's documentation uses ` +
        `(${best.entry.count} occurrence${best.entry.count === 1 ? '' : 's'}); ` +
        'the {number}/{slug} half is the profile contract\'s placeholder form',
    };
  }

  return {
    value: `${DEFAULT_BRANCH_PREFIX}/issue-{number}-{slug}`,
    source: 'default',
    evidence: [],
    detail:
      'no contributing document states a branch naming convention, so this is the package template ' +
      '(the shape both built-in profiles use), not a reading of this repository.',
    todo: {
      field: 'branch_template',
      code: 'branch_template_undetermined',
      detail: `confirm branches are named ${DEFAULT_BRANCH_PREFIX}/… here; the placeholders {number} / {slug} / {repo} are the contract's and should be kept`,
    },
  };
}

const WORKTREE_RE = /git\s+worktree\s+add\b[^\n]*?(\.\.\/[^\s`"'*]+)/;

function detectWorktreeTemplate(ctx) {
  const { docs } = ctx;
  for (const doc of docs) {
    const all = lines(doc.text);
    for (let i = 0; i < all.length; i += 1) {
      const match = WORKTREE_RE.exec(all[i]);
      if (!match) continue;
      return {
        value: DEFAULT_WORKTREE_TEMPLATE,
        source: 'detected',
        evidence: [evidence(doc.path, i + 1, all[i])],
        detail:
          'this repository documents worktrees in a SIBLING directory (`../…`), which is the shape of the ' +
          'template. The evidence confirms the location, not the exact name — the name stays the contract template.',
      };
    }
  }

  return {
    value: DEFAULT_WORKTREE_TEMPLATE,
    source: 'default',
    evidence: [],
    detail:
      'nothing in this repository documents where worktrees are created, so this is the package template ' +
      '(a sibling directory next to the checkout), not a reading of this repository.',
    todo: {
      field: 'worktree_template',
      code: 'worktree_template_undetermined',
      detail:
        'confirm a sibling directory next to this checkout is where worktrees may be created and is writable; ' +
        'the path must stay relative (the dispatch runner refuses an absolute or escaping worktree target)',
    },
  };
}

// =============================================================================
// scope_companions (Issue #149)
// =============================================================================
//
// The planner's L1 derivation covers the test layouts a path alone predicts: a
// sibling `*.test.ts`, a `_test.go`, a `tests/test_*.py`. What it cannot know is
// a MIRROR — `app/models/user.rb` tested by `spec/models/user_spec.rb` — because
// the mirror is a fact about this repository's directory tree, and the planner
// never opens the target repository. This runner does open it, which is exactly
// why references/adr-scope-derivation.md §3 puts the declaration in the profile
// and its detection here.
//
// Detection is EVIDENCE-BASED, not name-based: a rule is proposed only when an
// actual test file and the actual source file it mirrors both exist, and both
// are cited in `provenance`. Nothing is inferred from the mere presence of a
// `spec/` directory — a drafted rule nobody can check against two real files is
// the quiet guess this runner exists to avoid.
//
// At most ONE rule is drafted. A repository with several layouts gets the first
// in the fixed scan order plus a `multiple_test_layouts` warning naming the
// others, the same discipline `multiple_ecosystems` follows: never silently pick
// one of several. The draft is a starting point a human extends, and
// `verified: false` says so.
//
// Only `derive` is ever drafted — the `require` key (Issue #181) is never
// proposed, and that is a decision rather than an omission. A literal companion
// is the shape whose relationship to the sources is SEMANTIC: an aggregate
// contract test is called `shared-contract.test.mjs` precisely because its name
// corresponds to no source name, so there is no pair of files a scan could hold
// up as evidence, and its `when` — WHICH declarations should pull it in — is a
// statement about what the file covers that only its author can make. Drafting
// it would mean inventing both halves of a rule and marking them `detected`,
// which is the quiet guess this runner exists to avoid (ADR §15.6). What the
// runner does instead is name the key in the `scope_companions_undetermined`
// TODO, so an author reading the draft's gaps learns the shape exists; the TODO
// fires exactly when nothing was detected, which is also when a human is already
// reading this field.

// Fixed scan order. The first (test root, source root, affix) triple that pairs
// two real files wins, so this order is part of the runner's determinism, not an
// implementation detail.
const COMPANION_TEST_ROOTS = ['spec', 'test', 'tests'];
const COMPANION_SOURCE_ROOTS = ['src', 'app', 'lib'];

// How a test file's name relates to its source file's name. Ordered most
// specific first: the bare pair (a test tree that repeats the source name
// unchanged) is last because it is the one that can also match by accident.
const COMPANION_AFFIXES = [
  { prefix: '', suffix: '_test' },
  { prefix: '', suffix: '_spec' },
  { prefix: '', suffix: '.test' },
  { prefix: '', suffix: '.spec' },
  { prefix: 'test_', suffix: '' },
  { prefix: '', suffix: 'Test' },
  { prefix: '', suffix: 'Spec' },
  { prefix: '', suffix: '' },
];

// A tree walk in a drafting tool is a convenience, not a search: it stops well
// before it could become the reason this runner is slow on a large checkout.
const COMPANION_SCAN_MAX_FILES = 400;
const COMPANION_SCAN_MAX_DIRS = 200;

// Only plain path characters are considered. Everything read here ends up inside
// a profile template that orchestrate.mjs refuses if it carries a glob
// metacharacter, so a file named `weird*name.ts` must be skipped rather than
// drafted into a rule the planner would then reject.
const COMPANION_PATH_RE = /^[A-Za-z0-9._/-]+$/;

// Breadth-first, each directory's entries already sorted by repo.list, so the
// file order is a function of the tree and not of the filesystem.
function listFilesUnder(repo, root) {
  const files = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < COMPANION_SCAN_MAX_DIRS) {
    const dir = queue.shift();
    visited += 1;
    for (const entry of repo.list(dir)) {
      const path = `${dir}/${entry}`;
      if (repo.isDir(path)) queue.push(path);
      else files.push(path);
      if (files.length >= COMPANION_SCAN_MAX_FILES) return files;
    }
  }
  return files;
}

// Given a file under a test root, the rule that would have produced it — but
// only if the source file it mirrors is really there.
function companionRuleFrom(repo, testPath) {
  const cut = testPath.indexOf('/');
  if (cut === -1) return null;
  const testRoot = testPath.slice(0, cut);
  const rest = testPath.slice(cut + 1);
  const slash = rest.lastIndexOf('/');
  const dir = slash === -1 ? '' : rest.slice(0, slash + 1);
  const file = rest.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  // `dot <= 0` covers the extensionless name and the dotfile whose leading dot
  // is not an extension separator.
  if (dot <= 0) return null;
  const stem = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  if (!/^[A-Za-z0-9]+$/.test(ext)) return null;
  for (const { prefix, suffix } of COMPANION_AFFIXES) {
    if (!stem.startsWith(prefix) || !stem.endsWith(suffix)) continue;
    const base = stem.slice(prefix.length, stem.length - suffix.length);
    if (base.length === 0) continue;
    for (const sourceRoot of COMPANION_SOURCE_ROOTS) {
      const sourcePath = `${sourceRoot}/${dir}${base}.${ext}`;
      if (!repo.exists(sourcePath)) continue;
      return {
        rule: {
          when: `${sourceRoot}/{dir}{base}.${ext}`,
          add: [`${testRoot}/{dir}${prefix}{base}${suffix}.${ext}`],
        },
        sourcePath,
        testPath,
      };
    }
  }
  return null;
}

function detectScopeCompanions(ctx) {
  const { repo, warnings } = ctx;
  const found = [];
  const seen = new Set();
  for (const testRoot of COMPANION_TEST_ROOTS) {
    if (!repo.isDir(testRoot)) continue;
    for (const testPath of listFilesUnder(repo, testRoot)) {
      if (!COMPANION_PATH_RE.test(testPath)) continue;
      const candidate = companionRuleFrom(repo, testPath);
      if (candidate === null) continue;
      const key = JSON.stringify(candidate.rule);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(candidate);
    }
  }

  if (found.length === 0) {
    // An EMPTY declaration, which derives exactly what no declaration derives.
    // The value is a template like every other `default` here, so it carries the
    // TODO that keeps "we found nothing" from reading like "there is nothing".
    return {
      value: { derive: [] },
      source: 'default',
      evidence: [],
      detail:
        `no file under ${COMPANION_TEST_ROOTS.join(' / ')} pairs with a source file under ` +
        `${COMPANION_SOURCE_ROOTS.join(' / ')}, so no repository-specific companion could be PROVED. ` +
        'An empty declaration derives what no declaration derives: the planner\'s built-in rules only.',
      todo: {
        field: 'scope_companions',
        code: 'scope_companions_undetermined',
        // The text names BOTH keys, because the shapes it lists do not all fit
        // one of them (Issue #181): a mirrored test tree and a generated file are
        // functions of the source path and belong in "derive", while an aggregate
        // contract test and a required document have fixed names and are only
        // expressible as a "require" literal. Until #181 this TODO asked for the
        // second kind and the runner then refused it — advice that cost the
        // author a load_error to discover.
        detail:
          'if this repository keeps its tests or its generated files somewhere the planner cannot reach ' +
          'from a source path, declare the rule under "derive" — and if a file with a FIXED name has to ' +
          'be edited alongside them (an aggregate contract test, a required document), declare it as a ' +
          'literal under "require", whose "when" gates it on a declared path. A companion missing from a ' +
          'worker\'s scope fails the scope gate in a way the worker cannot resolve ' +
          '(references/profile-contract.md §9). If there is no such convention, leave "derive" empty.',
      },
    };
  }

  if (found.length > 1) {
    warnings.push({
      code: 'multiple_test_layouts',
      detail:
        `several test layouts pair with real source files (${found.map((c) => c.rule.add[0]).join(', ')}); ` +
        `the draft declares ${found[0].rule.add[0]} only. Add the others by hand if this repository uses them.`,
    });
  }

  const chosen = found[0];
  return {
    value: { derive: [chosen.rule] },
    source: 'detected',
    evidence: [
      evidence(chosen.sourcePath, null, `${chosen.sourcePath} is a source file this layout mirrors`),
      evidence(chosen.testPath, null, `${chosen.testPath} is its test, which "${chosen.rule.add[0]}" reproduces`),
    ],
    detail:
      `${chosen.testPath} mirrors ${chosen.sourcePath}, a pairing the planner cannot derive from a path ` +
      'alone; the rule re-derives it for every source file the issue declares',
  };
}

// =============================================================================
// id
// =============================================================================

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function detectId(ctx, repository, ecosystems) {
  if (ctx.inputs.idOverride) {
    return {
      value: ctx.inputs.idOverride,
      source: 'flag',
      evidence: [],
      detail: '--id declared the profile identifier',
    };
  }
  const ecosystem = ecosystems[0] ?? 'custom';
  const name = repository.value === DEFAULT_REPOSITORY
    ? 'repo'
    : (slugify(repository.value.split('/').pop() ?? '') || 'repo');
  return {
    value: `${ecosystem}-${name}`,
    source: 'derived',
    evidence: [],
    detail:
      `"<toolchain>-<repository name>", the naming both built-in profiles use ` +
      `(toolchain "${ecosystem}", repository "${name}")`,
    todos: repository.value === DEFAULT_REPOSITORY || ecosystem === 'custom'
      ? [{
        field: 'id',
        code: 'id_derived_from_placeholder',
        detail:
          'the id was derived from a value that is itself a placeholder; rename it once the repository ' +
          'and toolchain are settled, or re-run with --id',
      }]
      : [],
  };
}

// =============================================================================
// Source gathering
// =============================================================================

function docSources(repo) {
  // Fixed, documented order: the canonical place for a convention first, the
  // incidental places last. Every branch/worktree default's tie-break resolves
  // through this order, so it is part of the contract, not an implementation
  // detail.
  const paths = [];
  const contributing = repo.find('.', 'contributing.md');
  if (contributing) paths.push(contributing);
  const ghContributing = repo.find('.github', 'contributing.md');
  if (ghContributing) paths.push(ghContributing);
  const prTemplate = repo.find('.github', 'pull_request_template.md');
  if (prTemplate) paths.push(prTemplate);
  for (const entry of repo.list('docs')) {
    if (entry.toLowerCase().endsWith('.md')) paths.push(`docs/${entry}`);
  }
  const readme = repo.find('.', 'readme.md');
  if (readme) paths.push(readme);

  const docs = [];
  for (const path of paths) {
    const text = repo.readText(path);
    if (typeof text === 'string') docs.push({ path, text });
  }
  return docs;
}

function workflowSources(repo) {
  const out = [];
  for (const entry of repo.list('.github/workflows')) {
    if (!/\.(?:yml|yaml)$/i.test(entry)) continue;
    const path = `.github/workflows/${entry}`;
    const text = repo.readText(path);
    if (typeof text === 'string') out.push({ path, text });
  }
  return out;
}

function parseJsonOrNull(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    // A malformed manifest is absent evidence, not a crash: drafting a profile
    // for a repository with a broken package.json must still produce a draft.
    return null;
  }
}

function gatherFiles(repo) {
  const packageJsonText = repo.readText('package.json');
  const makefilePath = repo.find('.', 'makefile');
  return {
    packageJsonText,
    packageJson: parseJsonOrNull(packageJsonText),
    cargoTomlText: repo.readText('Cargo.toml'),
    pyprojectText: repo.readText('pyproject.toml'),
    makefilePath: makefilePath ?? 'Makefile',
    makefileText: makefilePath ? repo.readText(makefilePath) : null,
  };
}

// =============================================================================
// Draft assembly
// =============================================================================

function draftProfile(inputs) {
  const warnings = [];
  const repo = openRepo(inputs.repoRoot, warnings);
  const files = gatherFiles(repo);
  const workflows = workflowSources(repo);
  const docs = docSources(repo);
  const ecosystems = detectEcosystems(files, repo);
  const ctx = { inputs, repo, files, workflows, docs, ecosystems, warnings };

  const repository = detectRepository(ctx);
  const fields = {
    id: detectId(ctx, repository, ecosystems),
    repository,
    base: detectBase(ctx),
    branch_template: detectBranchTemplate(ctx),
    worktree_template: detectWorktreeTemplate(ctx),
    baseline: detectBaseline(ctx),
    scope_companions: detectScopeCompanions(ctx),
  };

  const profile = {
    id: fields.id.value,
    repository: fields.repository.value,
    base: fields.base.value,
    branch_template: fields.branch_template.value,
    worktree_template: fields.worktree_template.value,
    baseline: fields.baseline.value,
    // Not a decision this runner is allowed to make. See the header, and
    // references/profile-contract.md §8 for what promotes it.
    verified: false,
    // Last, because it is the one optional field: a reviewer diffing a draft
    // against the contract's table reads the seven required fields first.
    scope_companions: fields.scope_companions.value,
  };

  const provenance = [];
  const todos = [];
  for (const field of PROFILE_FIELDS) {
    if (field === 'verified') {
      provenance.push({
        field: 'verified',
        value: false,
        source: 'fixed',
        evidence: [],
        detail: 'a drafting tool never certifies its own draft; see references/profile-contract.md §8',
      });
      continue;
    }
    const detected = fields[field];
    provenance.push({
      field,
      value: detected.value,
      source: detected.source,
      evidence: detected.evidence,
      detail: detected.detail,
    });
    if (detected.todo) todos.push(detected.todo);
    for (const todo of detected.todos ?? []) todos.push(todo);
  }

  return { profile, provenance, todos, warnings, ecosystems, docs, workflows };
}

// =============================================================================
// --check: an existing declaration against this repository's tree (Issue #197)
// =============================================================================
//
// The reverse of drafting, and the reason the file header calls it read-only
// twice: this mode opens a profile somebody already wrote and answers, per rule,
// "does it do anything here?".
//
// Everything about WHAT A RULE MATCHES comes from lib.mjs — the same
// normalizeScopeCompanions the planner loads a profile with, the same
// compileScopeCompanions, the same companionsForPath. Nothing about matching is
// re-implemented here, and that is the whole design constraint of this mode
// (Issue #197): a `--check` with its own reading of `{dir}` / `{base}` would
// answer a question the planner never asked.
//
// The ONE refusal not shared is the repository-relative test on a
// `require[].add` literal, which consults the planner's own path vocabulary
// (`SYSTEM_ROOTS`). A literal that names a system root simply does not exist
// under --repo-root, so this mode reports it as a rule adding nothing — which is
// true, and is the warning an author needs — while the planner still refuses the
// profile outright when it loads it. Nothing here overrides that; `--check` is
// not a gate and does not certify a profile.

// Directories a companion rule is never about, skipped so the scan measures the
// repository rather than its dependencies and its history. Deliberately short:
// every entry is a directory whose contents are NOT this repository's source by
// universal convention, and the report names the list so a surprising count can
// be read against it. Build outputs (`dist`, `target`, `build`) are NOT here —
// a generated file is exactly the kind of companion `derive` exists to declare.
const CHECK_SKIP_DIRS = ['.git', 'node_modules', '.venv', '__pycache__'];

// A bound, not a budget. A scan that walked an unbounded tree would turn a review
// command into a reason not to run one; the counts are reported as lower bounds
// with a warning when either bound is reached, never silently truncated. The
// directory bound is also what terminates a symlink cycle.
const CHECK_SCAN_MAX_FILES = 20000;
const CHECK_SCAN_MAX_DIRS = 4000;

// How many concrete examples each rule's report carries. A count says whether a
// rule fires; an example says whether it fires on what its author meant. Bounded
// so the envelope stays a fixed size on a large repository.
const CHECK_EXAMPLES = 3;

// Breadth-first from the repository root, every directory's entries already
// sorted by repo.list, so the file order — and therefore every example below —
// is a function of the tree and not of the filesystem.
function walkRepoFiles(repo, warnings) {
  const skip = new Set(CHECK_SKIP_DIRS);
  const files = [];
  const queue = ['.'];
  let visitedDirs = 0;
  let truncated = null;
  while (queue.length > 0 && truncated === null) {
    if (visitedDirs >= CHECK_SCAN_MAX_DIRS) {
      truncated = `${CHECK_SCAN_MAX_DIRS} directories`;
      break;
    }
    const dir = queue.shift();
    visitedDirs += 1;
    for (const entry of repo.list(dir)) {
      const path = dir === '.' ? entry : `${dir}/${entry}`;
      if (repo.isDir(path)) {
        if (!skip.has(entry)) queue.push(path);
        continue;
      }
      files.push(path);
      if (files.length >= CHECK_SCAN_MAX_FILES) {
        truncated = `${CHECK_SCAN_MAX_FILES} files`;
        break;
      }
    }
  }
  if (truncated !== null) {
    warnings.push({
      code: 'tree_scan_truncated',
      detail:
        `the scan stopped at ${truncated}, so every count below is a LOWER BOUND. ` +
        'A rule reported as matching nothing may still match a file the scan never reached; ' +
        'narrow --repo-root to the subtree the rules are about before reading the zero counts.',
    });
  }
  return files;
}

// One report line per rule, in the profile's own declaration order (`derive`
// first, then `require` — compileScopeCompanions' order, which is also the order
// the planner applies them in).
//
// `when_matches` counts REAL FILES, because that is the question: a `when` is a
// gate on a declared path, and a path an issue can declare is a path that
// exists. `add` is reported per template, with how many distinct paths it
// expanded to and how many of those are real — one number for `derive` (whose
// expansion is a function of each match) and the degenerate case of the same
// number for `require` (whose literal expands to itself, once).
function checkCompanionRules(rules, files, repo) {
  const perRule = rules.map((rule) => ({
    rule,
    matched: [],
    // Insertion-ordered: a Map keyed by the expanded path, valued by whether it
    // exists. Distinct paths, first-seen order, no sort — the same discipline
    // every other output in this runner is held to.
    expanded: rule.addTemplates.map(() => new Map()),
  }));
  const byRule = new Map(rules.map((rule, index) => [rule, perRule[index]]));

  for (const file of files) {
    for (const { rule, at, companion } of companionsForPath(rules, file)) {
      const entry = byRule.get(rule);
      if (entry.matched[entry.matched.length - 1] !== file) entry.matched.push(file);
      const seen = entry.expanded[at];
      if (!seen.has(companion)) seen.set(companion, repo.exists(companion));
    }
  }

  return perRule.map(({ rule, matched, expanded }) => {
    const add = rule.addTemplates.map((template, at) => {
      const paths = [...expanded[at].entries()];
      const existing = paths.filter(([, exists]) => exists);
      return {
        template,
        expands_to: paths.length,
        existing: existing.length,
        missing_examples: paths.filter(([, exists]) => !exists).slice(0, CHECK_EXAMPLES).map(([path]) => path),
      };
    });
    return {
      key: rule.key,
      index: rule.index,
      when: rule.when,
      when_matches: matched.length,
      when_examples: matched.slice(0, CHECK_EXAMPLES),
      add,
    };
  });
}

// The two zero-count shapes the Issue asks for, as WARNINGS. Neither is an error
// and neither ever will be: a declaration written ahead of the files it
// describes is legitimate, and a check that called it wrong would push authors
// into writing the profile after the code instead of before it. What a warning
// buys is that the author is told, at review time, instead of a worker being
// told by the scope gate, at a point where it cannot be repaired.
function checkWarnings(report) {
  const warnings = [];
  for (const rule of report) {
    const at = `${rule.key}[${rule.index}]`;
    if (rule.when_matches === 0) {
      warnings.push({
        code: 'companion_when_unmatched',
        detail:
          `${at}.when "${rule.when}" matches no file under --repo-root, so the rule adds nothing here. ` +
          'That is legitimate if the files it describes do not exist yet; otherwise the template is ' +
          'narrower than the tree — "{dir}{base}" spans a whole subtree where "{base}" spans one segment ' +
          '(references/profile-contract.md §9.2).',
      });
      continue;
    }
    for (const add of rule.add) {
      if (add.expands_to > 0 && add.existing === 0) {
        warnings.push({
          code: 'companion_add_missing',
          detail:
            `${at}.add "${add.template}" matched ${rule.when_matches} file(s) but none of the ` +
            `${add.expands_to} path(s) it produces exist` +
            (add.missing_examples.length === 0 ? '' : ` (e.g. ${add.missing_examples.join(', ')})`) +
            '. That is legitimate for a companion the repository has yet to create; otherwise the two ' +
            'halves of the rule disagree about this layout.',
        });
      }
    }
  }
  return warnings;
}

function checkCompletionChecks(report, declared) {
  const checks = [
    {
      id: 'read_only',
      passed: true,
      detail: 'nothing was written and no subprocess was run: the profile and the tree were only read',
    },
    {
      id: 'shared_matcher',
      passed: true,
      detail:
        'the declaration was loaded and matched with lib.mjs (normalizeScopeCompanions / ' +
        'compileScopeCompanions / companionsForPath), the same functions orchestrate.mjs derives with',
    },
    {
      id: 'rules_covered',
      passed: report.length === declared,
      detail: 'every declared rule has exactly one report line',
    },
    {
      id: 'no_adjudication',
      passed: true,
      detail: 'a rule matching nothing is reported as a warning; this runner raises no error over it',
    },
    {
      id: 'deterministic',
      passed: true,
      detail: 'the report is a pure function of the profile and the files under --repo-root',
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function renderCheckSummary({ profilePath, report, warnings, filesScanned }) {
  const zero = warnings.filter((warning) => warning.code === 'companion_when_unmatched').length;
  const lines = [
    '## 目的',
    `既にある profile の \`scope_companions\` 規則が、このリポジトリの tree で**実際に何に一致するか**を突き合わせた（read-only・起案なし）。`,
    '',
    '## 結論',
    report.length === 0
      ? `\`${profilePath}\` は \`scope_companions\` 規則を1本も宣言していない。突き合わせる対象が無い。`
      : `規則 ${report.length} 本 / 走査 ${filesScanned} file。` +
        `**0 件一致の規則 ${zero} 本**、警告 ${warnings.length} 件。` +
        '**0 件一致は誤りではない**（これから作るファイルを見越した宣言はありうる）ので warning である。',
  ];
  if (report.length > 0) {
    lines.push('', '## 規則ごとの一致件数');
    for (const rule of report) {
      const where = rule.when_examples.length === 0 ? '' : `（例: ${rule.when_examples.join(', ')}）`;
      const adds = rule.add
        .map((add) => `\`${add.template}\` → 展開 ${add.expands_to} / 実在 ${add.existing}`)
        .join(' / ');
      lines.push(`- \`${rule.key}[${rule.index}]\` \`${rule.when}\` — 一致 ${rule.when_matches} 件${where}: ${adds}`);
    }
  }
  if (warnings.length > 0) {
    lines.push('', '## Warnings', ...warnings.map((warning) => `- ${warning.code}: ${warning.detail}`));
  }
  lines.push(
    '',
    '## 次の一手',
    '- 一致 0 件の規則は、テンプレートが tree より狭いのか、まだ作っていないファイルの宣言なのかを決める。',
    '- 一致判定は planner と同じ関数（`lib.mjs`）なので、ここで一致した規則は plan でも一致する。',
    '- **この runner は profile を承認しない。** 契約適合の裁定は `orchestrate.mjs --profile-json` の `load_error` 側にある。',
    `- 走査から外した directory: ${CHECK_SKIP_DIRS.join(' / ')}。`,
  );
  return lines.join('\n');
}

function buildCheckResult({ status, profilePath, repoRoot, filesScanned, report, warnings, completionCheck, summary }) {
  return {
    profile_init_schema_version: PROFILE_INIT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    // Stated as data next to `draft`, so a consumer cannot read a check envelope
    // as a drafting one: there is no profile in it, and `draft: false` here means
    // "nothing was drafted", not "this profile is approved".
    mode: 'check',
    status,
    draft: false,
    profile: null,
    check: {
      profile_path: profilePath,
      repo_root: repoRoot,
      files_scanned: filesScanned,
      skipped_directories: [...CHECK_SKIP_DIRS],
      rules: report,
    },
    provenance: [],
    todos: [],
    artifacts: [],
    errors: [],
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

function runCheck(inputs) {
  const profilePath = redact(inputs.check);
  let raw;
  try {
    raw = JSON.parse(readFileSync(inputs.check, 'utf8'));
  } catch (error) {
    throw new SkillError(
      'load_error',
      `cannot read profile at --check ${profilePath}: ${redact(error.message)}`,
      6,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillError('load_error', `--check ${profilePath} is not a JSON object`, 6);
  }

  // The planner's loader, minus the one refusal that needs its path vocabulary
  // (see the section header). A declaration this refuses is a declaration the
  // planner refuses too, with the same message and the same exit code — which is
  // the point: the two runners must not disagree about what a rule IS either.
  const declaration = normalizeScopeCompanions(raw.scope_companions);
  const rules = compileScopeCompanions(declaration);

  const warnings = [];
  const repo = openRepo(inputs.repoRoot, warnings);
  const files = rules.length === 0 ? [] : walkRepoFiles(repo, warnings);
  const report = checkCompanionRules(rules, files, repo);
  warnings.push(...checkWarnings(report));

  const completionCheck = checkCompletionChecks(report, rules.length);
  const status = warnings.length > 0 ? 'partial' : 'success';
  const result = buildCheckResult({
    status,
    profilePath,
    repoRoot: redact(inputs.repoRoot),
    filesScanned: files.length,
    report,
    warnings,
    completionCheck,
    summary: renderCheckSummary({ profilePath, report, warnings, filesScanned: files.length }),
  });

  process.stderr.write(
    'checked scope_companions against the tree: nothing was written, and this runner does not certify a profile.\n',
  );
  // Exit 0 for `partial` exactly as drafting does. A zero-match rule is a finding
  // for a human, not a failure of this run (Issue #197).
  return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
}

// =============================================================================
// Result envelope
// =============================================================================

function completionChecks(profile, provenance, todos) {
  const covered = new Set(provenance.map((entry) => entry.field));
  const checks = [
    {
      id: 'verified_false',
      passed: profile.verified === false,
      detail: 'the draft does not claim verification',
    },
    {
      id: 'contract_shaped',
      passed:
        Object.keys(profile).length === PROFILE_FIELDS.length &&
        PROFILE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(profile, field)),
      detail: 'the draft carries exactly the fields references/profile-contract.md defines',
    },
    {
      id: 'provenance_complete',
      passed: PROFILE_FIELDS.every((field) => covered.has(field)),
      detail: 'every field states where its value came from',
    },
    {
      id: 'gaps_explicit',
      passed: provenance
        .filter((entry) => entry.source === 'default')
        .every((entry) => todos.some((todo) => todo.field === entry.field)),
      detail: 'every field that fell back to a safe template carries a TODO',
    },
    {
      id: 'read_only',
      passed: true,
      detail: 'nothing outside --out was written and no subprocess was run',
    },
    {
      id: 'deterministic',
      passed: true,
      detail: 'the draft is a pure function of the files under --repo-root',
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
}

function renderSummary({ profile, provenance, todos, warnings, ecosystems, artifacts }) {
  const bySource = (source) => provenance.filter((entry) => entry.source === source).map((entry) => entry.field);
  const detected = bySource('detected');
  const defaulted = bySource('default');
  const lines = [
    '## 目的',
    `${profile.repository} 向け profile の **draft** を、リポジトリ内の宣言だけから起案した（network なし・決定的）。`,
    '',
    '## 結論',
    `\`verified: false\` の draft である。**人間が確認するまで profile ではない。** ` +
      `検出 ${detected.length} field / 既定の雛形 ${defaulted.length} field / TODO ${todos.length} 件。`,
    '',
    '## draft',
    '',
    '```json',
    JSON.stringify(profile, null, 2),
    '```',
    '',
    '## 根拠（provenance）',
    ...provenance.map((entry) => {
      const where = entry.evidence.length === 0
        ? '—'
        : entry.evidence.map((e) => (e.line ? `${e.file}:${e.line}` : e.file)).join(', ');
      return `- \`${entry.field}\` = ${JSON.stringify(entry.value)} — ${entry.source}（${where}）: ${entry.detail}`;
    }),
  ];
  if (todos.length > 0) {
    lines.push('', '## TODO（判定材料が無かった項目）', ...todos.map((todo) => `- \`${todo.field}\` ${todo.code}: ${todo.detail}`));
  }
  if (warnings.length > 0) {
    lines.push('', '## Warnings', ...warnings.map((warning) => `- ${warning.code}: ${warning.detail}`));
  }
  lines.push(
    '',
    '## 次の一手',
    `- 検出した toolchain: ${ecosystems.length === 0 ? 'なし' : ecosystems.join(', ')}。`,
    '- draft を references/profile-contract.md 第1節の表と突き合わせ、TODO を埋める。',
    `- \`orchestrate.mjs --profile-json <path> --allow-unverified\` で plan を回して確認する（${
      artifacts.length === 0 ? '--out を付けると file に書ける' : `draft は ${artifacts.join(', ')}`
    }）。`,
    '- 実機で確認できたら references/profile-contract.md 第8節の昇格チェックリストに従って `verified: true` にする。',
  );
  return lines.join('\n');
}

function buildResult({ status, mode, profile, provenance, todos, warnings, errors, artifacts, completionCheck, summary }) {
  return {
    profile_init_schema_version: PROFILE_INIT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: SKILL_VERSION,
    // Which of the two modes produced this envelope (Issue #197). Stated even on
    // the drafting side, and even on a failure, so a consumer never has to infer
    // it from which fields happen to be populated.
    mode,
    status,
    // Stated as data, not only in prose: a consumer that reads this envelope
    // must not be able to mistake the draft for a reviewed profile.
    draft: true,
    profile,
    provenance,
    todos,
    artifacts,
    errors,
    warnings,
    completion_check: completionCheck,
    summary_markdown: summary,
  };
}

// `mode` is what the argv ASKED for, resolved before anything else can fail, so
// a failure envelope names the mode the operator ran even when the failure is
// what stopped that mode from doing anything (Issue #197).
function initFailure(error, mode) {
  const completionCheck = {
    passed: false,
    checks: mode === 'check'
      ? [
        { id: 'read_only', passed: true, detail: 'nothing was written' },
        { id: 'shared_matcher', passed: false, detail: 'no declaration was matched' },
        { id: 'rules_covered', passed: false, detail: 'no rule was reported' },
        { id: 'no_adjudication', passed: true, detail: 'the failure is about reading the inputs, not about what a rule matches' },
        { id: 'deterministic', passed: true, detail: 'the failure is a pure function of the inputs' },
      ]
      : [
        { id: 'verified_false', passed: true, detail: 'no draft was produced' },
        { id: 'contract_shaped', passed: false, detail: 'no draft was produced' },
        { id: 'provenance_complete', passed: false, detail: 'no draft was produced' },
        { id: 'gaps_explicit', passed: false, detail: 'no draft was produced' },
        { id: 'read_only', passed: true, detail: 'nothing was written' },
        { id: 'deterministic', passed: true, detail: 'the failure is a pure function of the inputs' },
      ],
  };
  return buildResult({
    status: 'failure',
    mode,
    profile: null,
    provenance: [],
    todos: [],
    warnings: [],
    errors: [{ code: error.code, detail: redact(error.detail ?? error.message) }],
    artifacts: [],
    completionCheck,
    summary: `## 結論\n失敗（${error.code}）。${redact(error.detail ?? error.message)}`,
  });
}

// =============================================================================
// Entry point
// =============================================================================

function run(argv) {
  const parsed = parseCli(argv);
  if (parsed.values.help) {
    process.stderr.write(`${USAGE}\n`);
    return { exitCode: 0, stdout: null };
  }

  const inputs = resolveInputs(parsed);
  if (inputs.check !== null) return runCheck(inputs);

  const { profile, provenance, todos, warnings, ecosystems } = draftProfile(inputs);

  const profileJson = `${JSON.stringify(profile, null, 2)}\n`;
  const artifacts = [];
  if (inputs.out) {
    try {
      writeFileSync(inputs.out, profileJson, 'utf8');
    } catch (error) {
      throw new SkillError('write_error', `cannot write --out ${redact(inputs.out)}: ${redact(error.message)}`, 6);
    }
    // Redacted like every other path this package reports: an --out under an
    // absolute host path must not survive into the envelope. The unredacted path
    // is echoed on stderr, which is a notice channel and not an artifact.
    artifacts.push(redact(inputs.out));
  }

  const completionCheck = completionChecks(profile, provenance, todos);
  // `partial` whenever a field fell back to a template: the draft is usable, but
  // something in it was not read out of the repository and a human has to settle
  // it. `success` means every field has evidence behind it — which still leaves
  // verified:false, because evidence is not confirmation.
  const status = todos.length > 0 || warnings.length > 0 ? 'partial' : 'success';
  const result = buildResult({
    status,
    mode: 'draft',
    profile,
    provenance,
    todos,
    warnings,
    errors: [],
    artifacts,
    completionCheck,
    summary: renderSummary({ profile, provenance, todos, warnings, ecosystems, artifacts }),
  });

  if (inputs.out) process.stderr.write(`wrote draft profile to ${inputs.out}\n`);
  process.stderr.write('draft profile: verified=false. Review it against references/profile-contract.md before use.\n');

  return {
    exitCode: 0,
    stdout: inputs.emit === 'profile' ? profileJson : `${JSON.stringify(result, null, 2)}\n`,
  };
}

function main() {
  const argv = process.argv.slice(2);
  // Read off the raw argv rather than from resolveInputs, because the failure
  // this labels may be resolveInputs itself refusing the arguments.
  const mode = argv.includes('--check') || argv.some((arg) => arg.startsWith('--check=')) ? 'check' : 'draft';
  try {
    const { exitCode, stdout } = run(argv);
    if (stdout) process.stdout.write(stdout);
    process.exit(exitCode);
  } catch (error) {
    if (error instanceof SkillError) {
      // The failure envelope always goes to stdout, even under --emit profile:
      // there is no draft to emit, and a consumer piping stdout into a file must
      // get something that is obviously not a profile rather than nothing.
      process.stdout.write(`${JSON.stringify(initFailure(error, mode), null, 2)}\n`);
      process.stderr.write(`error [${error.code}]: ${redact(error.detail ?? error.message)}\n`);
      process.exit(error.exitCode ?? 1);
    }
    process.stderr.write(`internal error: ${redact(error.stack ?? String(error))}\n`);
    process.exit(1);
  }
}

main();
