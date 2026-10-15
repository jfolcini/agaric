#!/usr/bin/env node
// #3722 meta-guard — fixing ONE script that runs git in a throwaway fixture
// does not fix the CLASS. Four scripts have now independently reinvented the
// same scrub for the same reason (#3690, then this script's own history in
// check-migrations-immutable.sh / test-related-rust.sh / check-sqlx-cache-drift.sh
// / check-session-log-numbering.sh, then #3736 for a FIFTH, unprotected
// script — pr-overlap-diverged.sh — before it was migrated to the shared
// helper). Each private copy protected only the one script that carried it;
// the next self-test author had no way to know the pattern existed, wrote
// their own throwaway `git -C <dir> init`, and reproduced the incident.
//
// scripts/lib/git-scratch-guard.sh is the shared fix (`git_scratch_guard` +
// `git_scratch_init`), with `scripts/lib/git-scratch-guard.mjs` as its Node
// sibling. This script is the thing that makes it STICK: it scans every
// `.sh` and `.mjs` file under scripts/ and fails the commit if either —
//
//   1. it hand-rolls its own `unset ... GIT_DIR ...` scrub instead of
//      sourcing the shared helper (the exact shape of all four incidents:
//      "smart enough to know about the danger, but reinventing the fix"), or
//   2. it runs `git init` / `git -C <dir> init` — the fixture-creating
//      command that is unsafe under an inherited GIT_DIR — without sourcing
//      the shared helper AT ALL (the "never learned about the danger"
//      shape: pr-overlap-diverged.sh before #3724).
//
// scripts/lib/git-scratch-guard.sh and its Node sibling
// scripts/lib/git-scratch-guard.mjs are exempt from both checks — they ARE
// the canonical implementations of `git init` inside a fixture, and the one
// place allowed to contain a raw `unset` / `delete env[...]` of these
// variables (the scrub loop itself, plus a deliberately UNGUARDED
// demonstration inside the shell one's self-test, proving the incident is
// real rather than hypothetical). This file is exempt too: it necessarily
// contains the offending patterns as detector fixtures.
//
// ─── The three design calls (#4043, #4044, #4064) ────────────────────────
//
// Each of these is a decision this file used to make silently, by the shape
// of a regex, so the next reader had to infer it. They are stated here
// because the answer is not derivable from the code — only visible in it.
//
// 1. A COMMAND-SCOPED SCRUB COUNTS, WHEN THE COMMAND IT SCOPES IS `git`
//    (#4043). `env -u GIT_INDEX_FILE git …`, `env -i PATH=$PATH git -C "$d"
//    init` and `GIT_DIR= GIT_WORK_TREE= git -C "$d" init` are all working
//    private scrubs of a git command's environment — the same defect as a
//    process-wide `unset`, spelled per-command, and `env -u` is the idiom
//    someone who already knows about #3722 reaches for first. They are rule-1
//    matches.
//
//    Scrubbing some OTHER program's environment is NOT a fixture scrub and is
//    not matched: `env -u GIT_INDEX_FILE node <guard>` pins the INPUT of a
//    guard under test, and no git command runs under that environment.
//    Requiring `git` on the same logical line is what draws that line.
//
// 2. A DYNAMIC `import()` COUNTS AS WIRING (#4044). `await import('…/
//    git-scratch-guard.mjs')` was reported as "without wiring itself … at
//    all" — a false red whose remedy the author had already applied. The
//    symmetric objection (a dynamic import is weaker evidence than a static
//    one, because it may never be evaluated) does not discriminate: this
//    guard ALREADY cannot prove the helper is called before the first git
//    command, for any import form. Under that stated limitation static and
//    dynamic are the same evidence, so treating them differently would be
//    precision the guard does not have.
//
// 3. `not-a-fixture-scrub: <reason>` REPLACES THE EXEMPTION LIST (#4064). A
//    set of basenames in this file grew an entry every time a legitimate
//    `GIT_` removal appeared elsewhere, and it excused the WHOLE file's
//    rule 1 rather than the one statement that earned it. The pragma is a
//    trailing comment on the scrub line itself, carries a mandatory reason,
//    and waives rule 1 for THAT LINE ONLY:
//
//      delete out.GIT_INDEX_FILE // not-a-fixture-scrub: <why>
//
//    Its one live user is `scripts/lib/guard-file-source.mjs`'s `gitEnv`.
//    A bare `not-a-fixture-scrub:` with no reason does not waive anything —
//    the reason is the whole mechanism, and a pragma that could be typed
//    without one would be the exemption list again, distributed.
//
// ─── Why `.mjs` is scanned, not just `.sh` (#4015) ───────────────────────
//
// This guard used to enumerate with `entry.name.endsWith('.sh')`, so it
// inspected ~30 shell scripts and nothing else. That is the meta-guard
// committing the exact error it was written to end: a per-LANGUAGE fix does
// not end a class of defect any more than a per-SCRIPT one does, it just
// moves the next occurrence somewhere new.
//
// It did. `scripts/lib/git-scratch-guard.mjs` was added during #3962 as the
// Node sibling of the shell helper; its own header names this gap
// explicitly — that a `.mjs` self-test spawning git is the unwatched case —
// and the very file that says so shipped a scenario which leaked. One
// scenario read the index IN PROCESS rather than through a spawned guard,
// with no `env` threaded to `git ls-files`, so under a real `git commit` the
// ambient `GIT_INDEX_FILE` (which OUTRANKS `cwd`) made it enumerate the real
// repository's 4,610 paths instead of the fixture's 8. The standalone
// self-test passed, `prek run --all-files` passed, and three adversarial
// review passes over the diff passed; only an actual `git commit`
// reproduced it, because that is the only context which sets
// `GIT_INDEX_FILE`.
//
// Deliberately grep-based, not a real shell parser (matching the issue's own
// suggested fix: "a meta-guard that greps hook scripts and self-tests for
// git invocations"). Two known, deliberately-accepted gaps:
//
//   * It cannot prove a script calls `git_scratch_guard` BEFORE its first
//     git command — only that the file sources the helper somewhere. That
//     is a real gap, but the alternative (parsing bash control flow) is a
//     much bigger tool for a problem four independent one-off patches
//     already show is dominated by "nobody sourced the shared code at all",
//     not by subtle ordering bugs in scripts that did.
//   * The `git init` detector is a literal-text match on the word `git`
//     adjacent to `init`. A script that indirects the command name through
//     a variable (`GITBIN=git; "$GITBIN" -C "$dir" init`) or an alias is
//     invisible to it and passes uncaught, hand-rolled scrub or not.
//     Textual regexes cannot generally defeat deliberate obfuscation;
//     closing this needs a real shell parser (see the point above) and is
//     not attempted here. If this is ever hit for real, it is evidence the
//     grep-based approach has reached its limit, not a bug in this file.
//
// Usage:
//   node scripts/check-git-fixture-isolation.mjs
//
// Exit codes: 0 = every fixture-building script is wired through the shared
// guard; 1 = at least one is not (or the wiring itself looks broken).

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SCRIPTS_DIR = join(import.meta.dirname)
// The shared scrubbers, one per language that has one — see the header. The
// shell name is also what a `.sh` script must be seen to SOURCE, and the
// `.mjs` name what a Node script must be seen to IMPORT.
const SHARED_GUARD_BASENAME = 'git-scratch-guard.sh'
const SHARED_GUARD_MJS_BASENAME = 'git-scratch-guard.mjs'
// Exempt from EVERY check — never opened, neither rule run: the two canonical
// implementations, and this file, which necessarily carries the offending
// patterns as detector fixtures.
const EXEMPT_BASENAMES = new Set([
  SHARED_GUARD_BASENAME,
  SHARED_GUARD_MJS_BASENAME,
  'check-git-fixture-isolation.mjs',
])

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git'])

/** Extension -> language tag. The scanned corpus is exactly these keys, and
 * the wiring guard below asserts each one still matches at least one real
 * file, so an extension list that falls out of step with the repo is a loud
 * failure rather than a silently narrower scan. */
export const SCANNED_EXTENSIONS = new Map([
  ['.sh', 'sh'],
  ['.mjs', 'mjs'],
])

// ---------------------------------------------------------------------------
// Text-level detection
// ---------------------------------------------------------------------------

/** Drop whole-line comments — a comment merely NAMING `git init` or
 * `GIT_DIR` in prose (every migrated script's docstring does this, on
 * purpose, to explain the incident) must not be mistaken for the code this
 * guard actually cares about.
 *
 * `lang` picks the comment marker: `#` for shell, `//` for Node.
 * Getting this wrong is not cosmetic — a Node file whose entire 30-line
 * header explains the incident would have every one of those lines read as
 * CODE, and `hasFixtureGitInit` would flag the file that documents the
 * hazard as if it committed it. Node block comments (`/* … *\/`) are
 * stripped too, wherever they start. */
export function stripLineComments(text, lang = 'sh') {
  const body = lang === 'mjs' ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text
  const commentRe = lang === 'mjs' ? /^\s*\/\// : /^\s*#/
  return body
    .split('\n')
    .filter((line) => !commentRe.test(line))
    .join('\n')
}

/** Bash line-continuation (`\` at end of line) joined to one logical line,
 * so a multi-line `unset FOO BAR \` + `  BAZ` statement is inspected whole
 * rather than missed because the interesting variable is on the second
 * physical line. */
function joinContinuations(text) {
  return text.replace(/\\\r?\n/g, ' ')
}

const GIT_ENV_VAR_RE =
  /\b(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|GIT_NAMESPACE)\b/

/** The per-statement waiver (design call 3). A TRAILING comment — `#` or
 * `//` — on the scrub line, carrying a non-empty reason. Trailing rather
 * than own-line because `stripLineComments` deletes whole comment lines
 * before any detector sees them, so a pragma on its own line would be gone
 * by the time this runs; and per-line rather than per-file because "this one
 * removal is not a fixture scrub" is the only claim that is ever true.
 *
 * The `\S` is load-bearing: a bare `not-a-fixture-scrub:` waives nothing. */
const NOT_A_FIXTURE_SCRUB_RE = /(?:#|\/\/)\s*not-a-fixture-scrub:\s*\S/

/** Spellings that identify a line as a SCRUB STATEMENT but do not themselves
 * name the variable — the line must ALSO name one of `GIT_ENV_VAR_RE`.
 *
 *   sh   `unset GIT_DIR …`; `export -n GIT_DIR` (removing a name from the
 *        export list is, to a child process, the same thing as unsetting it)
 *   mjs  `delete env.GIT_DIR`, `delete process.env['GIT_INDEX_FILE']`, and
 *        `env.GIT_DIR = undefined` — Node's `child_process` DROPS an
 *        `undefined` env value, so the assignment is the same scrub as the
 *        deletion (#4045)
 */
const SCRUB_STATEMENT_RE = {
  sh: /^\s*unset\b|\bexport\s+-n\b/,
  mjs: /\bdelete\s+[\w$.[\]'"]*GIT_|GIT_\w+(?:['"`]\s*\])?\s*(?<![=!<>])=(?!=)\s*(?:undefined|null)\b/,
}

/** Spellings that are SELF-IDENTIFYING: the pattern names the variable (or
 * the `GIT_` prefix) itself, so no separate `GIT_ENV_VAR_RE` test applies —
 * `env -i` names nothing at all, and a prefix filter names a prefix rather
 * than any one variable.
 *
 *   sh   `env -u GIT_DIR git …`, `env -i … git …`, `GIT_DIR= … git …` — the
 *        command-scoped scrubs of design call 1. Each requires `git` on the
 *        same logical line: scrubbing another program's environment is not a
 *        fixture scrub.
 *   mjs  `k.startsWith('GIT_')` — the filtering spelling of the same scrub.
 */
const SCRUB_SELF_EVIDENT_RE = {
  sh: new RegExp(
    [
      // `env [-flags…] -u GIT_FOO … git …`
      /\benv\b[^\n]*?\s-u\s+GIT_\w+[^\n]*\bgit\b/.source,
      // `env [assignments…] -i … git …`
      /\benv\s(?:[^\n]*\s)?-i(?![\w-])[^\n]*\bgit\b/.source,
      // `GIT_DIR= GIT_WORK_TREE= git …` — an env-prefix assignment to EMPTY.
      // A non-empty one (`GIT_INDEX_FILE=.git/index cmd`) REDIRECTS git
      // rather than scrubbing it and is not this.
      /(?:^|[\s;&|(])GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE)=(?:''|"")?(?=\s)[^\n]*\bgit\b/
        .source,
    ].join('|'),
  ),
  mjs: /\bstartsWith\s*\(\s*['"`]GIT_/,
}

/**
 * A hand-rolled scrub: a statement that removes at least one of the
 * git-context variables that outrank `git -C <dir>` (#3722) from the
 * environment, in whichever way the language spells that. This is what every
 * one of the four incidents' fixes looked like BEFORE being migrated to the
 * shared helper — each is a legitimate, working scrub, and each is exactly
 * the private copy this guard exists to stop from reappearing. The spellings
 * are enumerated on `SCRUB_STATEMENT_RE` and `SCRUB_SELF_EVIDENT_RE`.
 *
 * Comments are stripped first, for the reason `stripLineComments` gives: the
 * shared helper's own prose names every one of these variables, and so does
 * every migrated script's header. What survives that strip is a TRAILING
 * comment on a code line, which is exactly where the `not-a-fixture-scrub:`
 * pragma lives.
 */
export function hasHandRolledGitEnvUnset(text, lang = 'sh') {
  const joined = joinContinuations(stripLineComments(text, lang))
  const statementRe = SCRUB_STATEMENT_RE[lang] ?? SCRUB_STATEMENT_RE.sh
  const selfEvidentRe = SCRUB_SELF_EVIDENT_RE[lang] ?? SCRUB_SELF_EVIDENT_RE.sh
  return joined
    .split('\n')
    .some(
      (line) =>
        !NOT_A_FIXTURE_SCRUB_RE.test(line) &&
        ((statementRe.test(line) && GIT_ENV_VAR_RE.test(line)) || selfEvidentRe.test(line)),
    )
}

/**
 * A fixture-creating `git init` — the command that is unsafe under an
 * inherited GIT_DIR — in either of the two shapes a script can spell it:
 *
 *   1. as a COMMAND LINE, bare or `-C`-scoped: `git init`,
 *      `git -C "$dir" init`. This is the shell form, and also what a `.mjs`
 *      `execSync('git init -q')` looks like textually.
 *   2. as an ARGV ARRAY, which is how Node normally spawns:
 *      `execFileSync('git', ['init', …])`. Nothing in that text puts the
 *      word `git` adjacent to the word `init`, so shape 1's regex is blind
 *      to it — scanning `.mjs`
 *      with only shape 1 would be a scanner that reports "checked" while
 *      unable to see the dominant spelling in the language it just started
 *      checking.
 *
 * Shape 2 requires the two literals to be in the SAME CALL (#4064). It was
 * `/(['"`])git\1[\s\S]{0,400}?(['"`])init\2/` — quote-anchored on both
 * halves, so `gitignore`/`initialise` could not satisfy either, but with no
 * same-call requirement at all: ANY quoted `git` and ANY quoted `init`
 * within 400 characters matched, across statement and even function
 * boundaries, so a file that spawns no fixture was told to restructure
 * working code — the failure mode most likely to get a guard disabled.
 *
 * `argvGitInit` replaces the character window with a bracket scan: from a
 * quoted `git` in argument position, walk forward tracking nesting depth and
 * stop at the close of the ENCLOSING group. A quoted `init` seen before that
 * close is in the same call; one seen after it is in a different one. That
 * covers `execFileSync('git', ['init', …])`, where `git` is the file
 * argument and `init` is inside a nested array, and an argv array holding
 * both, with no full parser. The header's "textual regexes cannot
 * defeat deliberate obfuscation" limitation is unchanged by this.
 *
 * Comments are stripped first (see `stripLineComments`), and continuations
 * are joined (mirroring `hasHandRolledGitEnvUnset`) — `git -C "$dir" \` +
 * `  init` is the same unsafe command split across a line break, and a
 * scanner that joins one detector's continuations but not the other's is
 * itself an evasion.
 */
export function hasFixtureGitInit(text, lang = 'sh') {
  const body = joinContinuations(stripLineComments(text, lang))
  if (/\bgit\s+(-C\s+\S+\s+)?init\b/.test(body)) return true
  if (lang === 'sh') return false
  return argvGitInit(body)
}

/** The string literal opening at `i`, as `{ value, end }` with `end` the
 * index of its LAST delimiter character, or null when it is unterminated.
 * Escapes are consumed so a literal `\'` does not end the string early. */
function readStringLiteral(text, i) {
  const quote = text[i]
  let value = ''
  for (let j = i + 1; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\\') {
      value += text[j + 1] ?? ''
      j += 1
      continue
    }
    if (c === quote) return { value, end: j }
    value += c
  }
  return null
}

const QUOTE_CHARS = new Set(['"', "'", '`'])
/** A quoted `git` in ARGUMENT position — immediately after a `(`, `[` or `,`
 * — which is where the file argument of a spawn and the first element of an
 * argv array both sit. A `const GITBIN = 'git'` is not in argument position
 * and is the indirection the header already documents as out of reach. */
const ARGV_GIT_RE = /(?<=[([,]\s*)(['"`])git\1/g

/** Whether any quoted `git` in argument position has a quoted `init` inside
 * the SAME call — see `hasFixtureGitInit`. The walk descends into nested
 * groups and ends at the first close that has no matching open, which is the
 * end of the group enclosing the `git`; a `git` at top level with no
 * enclosing group therefore matches nothing, because it is in no call. */
function argvGitInit(body) {
  ARGV_GIT_RE.lastIndex = 0
  for (let m = ARGV_GIT_RE.exec(body); m !== null; m = ARGV_GIT_RE.exec(body)) {
    if (initInSameCall(body, m.index + m[0].length)) return true
  }
  return false
}

function initInSameCall(body, from) {
  let depth = 0
  for (let i = from; i < body.length; i += 1) {
    const c = body[i]
    if (QUOTE_CHARS.has(c)) {
      const literal = readStringLiteral(body, i)
      // Unterminated: stop this walk rather than guess where the call ends.
      if (literal === null) return false
      if (literal.value === 'init') return true
      i = literal.end
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return false
      depth -= 1
    }
  }
  return false
}

/**
 * Whether the file WIRES ITSELF to the shared helper for its language — a
 * `.`/`source` statement for shell, an `import`/`require` for Node — not
 * merely whether the basename appears anywhere in the file. Comments are
 * stripped first: a docstring explaining the incident and naming
 * `scripts/lib/git-scratch-guard.sh` in prose (every migrated script's
 * header does this) must not be read as evidence the file uses it, and
 * neither must a stray runtime string that happens to contain the basename.
 * Not WHERE relative to the fixture code, see the header's stated
 * limitation.
 */
export function sourcesSharedGuard(text, lang = 'sh') {
  const basename = lang === 'mjs' ? SHARED_GUARD_MJS_BASENAME : SHARED_GUARD_BASENAME
  const nameRe = new RegExp(basename.replace('.', '\\.'))
  const lines = joinContinuations(stripLineComments(text, lang)).split('\n')
  if (lang === 'mjs') {
    // An ES `import` (the only form in this repo) or a CommonJS `require`,
    // as its own statement. A multi-line `import { a, b } from '…'` is one
    // logical line only after continuations are joined, which bash-style
    // joining does not do for JS — so the specifier is matched against the
    // WHOLE stripped body for `import`, anchored on the statement keyword.
    const body = stripLineComments(text, lang)
    const escaped = basename.replace('.', '\\.')
    const importRe = new RegExp(
      `(?:^|\\n)\\s*import[\\s\\S]{0,200}?from\\s*['"\`][^'"\`]*${escaped}`,
    )
    const requireRe = new RegExp(`require\\s*\\(\\s*['"\`][^'"\`]*${escaped}`)
    const bareImportRe = new RegExp(`(?:^|\\n)\\s*import\\s*['"\`][^'"\`]*${escaped}`)
    // A DYNAMIC import (#4044). `import(` rather than `import '`/`import {`,
    // so it is matched wherever it appears — `await import(…)` inside a
    // function is the whole point of the form and is on no statement line of
    // its own. Counted as wiring: see design call 2 in the header.
    const dynamicImportRe = new RegExp(`\\bimport\\s*\\(\\s*['"\`][^'"\`]*${escaped}`)
    return (
      importRe.test(body) ||
      requireRe.test(body) ||
      bareImportRe.test(body) ||
      dynamicImportRe.test(body)
    )
  }
  return lines.some((line) => {
    const trimmed = line.trim()
    // A dot-command or `source` invocation, as its own statement (allowing a
    // leading `;`/`&&`/`|`/`{` from a compound command). The path argument
    // itself may be an arbitrarily complex `$(...)"..."` expression full of
    // spaces (every real call site in this repo looks like
    // `. "$(dirname "$0")/lib/git-scratch-guard.sh"`), so this only
    // anchors WHERE the statement starts, then checks the basename appears
    // anywhere in that same logical line — not merely anywhere in the file.
    return /^(\.|source)\s+\S/.test(trimmed) && nameRe.test(trimmed)
  })
}

// ---------------------------------------------------------------------------
// Corpus scan
// ---------------------------------------------------------------------------

/** Every `.sh` and `.mjs` file under `dir`, recursively, as
 * `{ path, lang, text }` with `path` relative to `dir` (posix-separated, so
 * messages are stable across platforms) — except the canonical helpers and
 * this file, which are exempt from everything (see the header). There is no
 * per-file rule-1 exemption any more: a legitimate `GIT_` removal says so at
 * the statement, with `not-a-fixture-scrub: <reason>` (#4064). Sorted for
 * deterministic output. */
export function listGuardedScripts(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith('.')) continue
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      // Longest extension first, so `.test.mjs` is matched as `.mjs` rather
      // than being missed for want of an exact key.
      const ext = [...SCANNED_EXTENSIONS.keys()].find((e) => entry.name.endsWith(e))
      if (!ext) continue
      if (EXEMPT_BASENAMES.has(entry.name)) continue
      out.push({
        path: relative(dir, full).split(sep).join('/'),
        lang: SCANNED_EXTENSIONS.get(ext),
        text: readFileSync(full, 'utf8'),
      })
    }
  }
  walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

/** The shared helper a file of this language is expected to wire itself to. */
const SHARED_GUARD_FOR = {
  sh: 'scripts/lib/git-scratch-guard.sh',
  mjs: 'scripts/lib/git-scratch-guard.mjs',
}

const HAZARD =
  'A self-test wired as a prek hook runs inside the pre-commit environment, where ' +
  'GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE outrank `git -C <dir>` (and outrank a spawn ' +
  "`cwd`) — every fixture command lands on the developer's REAL repository instead " +
  '(#3722, #3690, #3736, #4015).'

/** Every problem found across `files` (as returned by `listGuardedScripts`),
 * human-readable — empty means every fixture-building script is wired
 * through the shared guard for its language. */
export function checkFixtureIsolation(files) {
  const problems = []
  for (const { path, lang, text } of files) {
    const helper = SHARED_GUARD_FOR[lang]
    if (hasHandRolledGitEnvUnset(text, lang)) {
      problems.push(
        `${path}: hand-rolls its own git-environment scrub instead of using ` +
          `${helper} (#3722) — every private copy of this scrub is ` +
          'exactly how the NEXT script goes unprotected. Call the shared scrubber ' +
          '(`git_scratch_guard`/`git_scratch_init`, or `scrubbedGitEnv`/' +
          '`withScrubbedProcessEnv`/`initScratchRepo`) instead.',
      )
    }
    if (hasFixtureGitInit(text, lang) && !sourcesSharedGuard(text, lang)) {
      problems.push(
        `${path}: runs \`git init\` (builds a git fixture) without wiring itself to ` +
          `${helper} at all. ${HAZARD}`,
      )
    }
  }
  return problems
}

/** Throws with every offending file named, or returns silently. */
export function assertFixtureIsolation({ scriptsDir = SCRIPTS_DIR } = {}) {
  const files = listGuardedScripts(scriptsDir)
  // Wiring guard (mirrors check-zizmor-version-pin.mjs), PER EXTENSION. A
  // total-count check is not enough: this guard's own #4015 defect was a scan
  // that found ~30 files and reported "checked" while an entire language went
  // uninspected, so the thing that has to be impossible is a scanned
  // extension quietly matching nothing. scripts/ contains `.sh` and `.mjs`
  // files today and there is no plausible future in which it contains none
  // of one of them without this guard needing to be revisited.
  const missing = [...SCANNED_EXTENSIONS.keys()].filter(
    (ext) => !files.some((f) => f.path.endsWith(ext)),
  )
  if (missing.length > 0) {
    throw new Error(
      `scripts/check-git-fixture-isolation.mjs found ZERO ${missing.join(' / ')} file(s) under ` +
        'scripts/ — the corpus scan itself is broken (wrong directory? scripts/ ' +
        'restructured? extension list out of step?), not a clean repo. Fix the scan before ' +
        'trusting its "clean" verdict.',
    )
  }
  const problems = checkFixtureIsolation(files)
  if (problems.length > 0) {
    throw new Error(
      `scripts/check-git-fixture-isolation.mjs found ${problems.length} script(s) not wired ` +
        `through the shared git-fixture guard (#3722):\n  - ${problems.join('\n  - ')}`,
    )
  }
  const byLang = new Map()
  for (const { lang } of files) byLang.set(lang, (byLang.get(lang) ?? 0) + 1)
  return { checked: files.length, byLang }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main() {
  const { checked, byLang } = assertFixtureIsolation()
  const breakdown = [...byLang].map(([lang, n]) => `${n} .${lang}`).join(', ')
  console.log(
    `OK  git fixture isolation: ${checked} script(s) under scripts/ checked (${breakdown}), ` +
      'none hand-roll a git-environment scrub or build a fixture without the shared ' +
      'scratch guard',
  )
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`check-git-fixture-isolation: ${err.message}`)
    process.exit(1)
  }
}
