#!/usr/bin/env node
/**
 * Hook-dependency union meta-guard (#3997).
 *
 * The shape #3997 is about: a prek hook selected by a `files:` regex runs a
 * repo script that `import`s / `source`s / `importlib`-loads a shared
 * first-party module. When that module's own path is not unioned into the
 * hook's `files:` pattern, a commit that edits ONLY the shared module
 * selects the hook not at all — it defangs the guard, and the commit lands
 * green. Nine hook ids across four families were found this way by a
 * one-time manual sweep; this guard is what stops a tenth from being
 * authored the same way next month, mechanically, instead of by another
 * manual sweep.
 *
 * ─── What this checks ───────────────────────────────────────────────────
 *
 * For every hook in prek.toml whose `entry` runs a recognisable repo script
 * (`node scripts/x.mjs`, `python3 scripts/x.py`, `bash scripts/x.sh`, with
 * or without trailing flags), whose own entry script EXISTS on disk, and
 * that is not `always_run` (an `always_run` hook ignores `files:` entirely,
 * so the question does not apply):
 *
 *   1. Resolve the script's first-party dependencies, recursively:
 *        - JS: real `import`/`export ... from`/bare `import '…'`/
 *              `require(…)`/dynamic `import(…)` occurrences, found by
 *              matching against `scripts/lib/js-scanner.mjs`'s
 *              `stripComments` output (so a commented-out mention is
 *              invisible) and accepted only when the SAME position survives
 *              `blankStringsAndTemplates` unchanged (so an import-SHAPED
 *              FIXTURE STRING — data passed to `writeFileSync`, entirely
 *              inside a string/template literal — is rejected: the whole
 *              literal, keyword text included, is blanked there, so its
 *              start position never matches the untouched original). This
 *              is a POSITION check, not an indentation or column-0
 *              anchor, so a real import nested inside a function is found
 *              too. A `require(`/`import(` CALL whose argument is not a
 *              plain string literal (concatenation, a variable, a computed
 *              call) cannot be resolved and marks the hook UNVERIFIABLE.
 *        - Python: `importlib.util.spec_from_file_location(...)` anywhere
 *          (including indented inside a function — no column anchor),
 *          found against `check-git-fixture-isolation.mjs`'s
 *          `stripLineComments(text, 'py')` output (blanks docstrings,
 *          drops `#`-comment-only lines), whose second argument resolves
 *          (via `SCRIPT_DIR /` or `REPO_ROOT /` path-joins) to a
 *          `scripts/**` file. A path expression with NO literal string
 *          component (`SCRIPT_DIR / name`), or whose pieces resolve
 *          OUTSIDE `scripts/` (so the assumed base was probably wrong),
 *          marks the hook UNVERIFIABLE too — the base is a guess, and a
 *          guess that lands nowhere is not knowledge that there is no
 *          dependency. `sys.path.insert`/`sys.path.append` and
 *          `exec(` are NOT resolved (a plain `import` after a `sys.path`
 *          splice, or code run from a string, cannot be statically
 *          resolved with any confidence) — their presence marks the whole
 *          hook UNVERIFIABLE instead of silently omitting the edge.
 *        - Shell: a `.`/`source` statement (either keyword, at any
 *          indent — `stripLineComments(text, 'sh')` first, then a
 *          trimmed-line test mirroring `sourcesSharedGuard`'s), naming a
 *          `.sh` file anywhere in the statement — under `lib/` or a
 *          sibling of the sourcing script. A source statement with NO
 *          literal `.sh` filename anywhere in it (a fully dynamic path)
 *          cannot be resolved and marks the hook UNVERIFIABLE.
 *      Dependency resolution is recursive (a dependency's own dependencies
 *      count too) and accumulates UNVERIFIABLE markers from every script in
 *      the closure, not just the entry point.
 *   2. For the hook's own script AND every resolved dependency, confirm the
 *      hook's `files:` regex matches that path AND that path is not
 *      removed again by the hook's own `exclude:` regex, if it has one.
 *
 * A hook whose `entry` cannot be resolved to a recognised single-script
 * shape, but whose `entry` text still MENTIONS a `scripts/*.{mjs,py,sh}`
 * path (e.g. a `bash -c '...'` wrapper that sources a script named inside
 * the string); whose entry script does not exist on disk; whose dependency
 * closure contains an unresolvable construct (`sys.path`, `exec(`, a
 * dynamic shell source with no literal filename); or that is selected by
 * `types`/`types_or` instead of a `files:` regex — is reported as
 * UNVERIFIABLE, never silently treated as clean. See #3997's own "Method
 * limits" section: `cargo-test` and `vitest` are exactly the last shape
 * today (both source `scripts/lib/git-scratch-guard.sh` but are gated by
 * `types`), and that gap is carried forward here rather than re-derived and
 * then hidden.
 *
 * ─── Baselines (ratchets) ───────────────────────────────────────────────
 *
 * Two separate ratchets, because they are two different defects with two
 * different remedies — mixing them into one list is a list nobody can burn
 * down (a `files:` union fix does not resolve a "write this a self-test"
 * entry, and vice versa):
 *
 *   - `scripts/hook-deps-baseline.json`: (hookId, dep) pairs already broken
 *     before this guard existed, each tagged `class`:
 *       - `"no-self-test"` — `dep === ` the hook's OWN entry script, i.e.
 *         this guard has no self-test of any kind (fix: write one, the way
 *         `store-layering-selftest` was added for #3997).
 *       - `"missing-union"` — `dep` is a genuine dependency the script
 *         `import`s/`source`s/loads, not unioned into `files:` (fix: union
 *         it, copying the spelling of a correct sibling).
 *   - `scripts/hook-deps-unverifiable-baseline.json`: hook ids already
 *     UNVERIFIABLE before this guard existed (`cargo-test`, `vitest`, and
 *     whatever else does not fit the recognised shapes today).
 *
 * Both are shrink-only, same convention as `dynamic-sql-baseline.txt` /
 * `lib-layering-baseline.json` elsewhere in this file: a NEW entry — one
 * not already in the relevant baseline — FAILS, and so does a baseline
 * entry that no longer reproduces (the gap was fixed, or a hook stopped
 * being unverifiable). `--update-baseline` refuses to WRITE a baseline that
 * is larger than the one on disk unless `--allow-growth` is also passed —
 * printing exactly what would be added — because a bare regenerate-and-trust
 * command is the same policy-not-mechanism gap that let #3997's nine holes
 * accumulate in the first place; growing a ratchet has to be a decision a
 * reviewer sees, not a side effect of running a command.
 *
 * Usage:
 *   node scripts/check-hook-deps.mjs                          # check the real repo
 *   node scripts/check-hook-deps.mjs --self-test               # fixture suite
 *   node scripts/check-hook-deps.mjs --update-baseline          # refuses to grow
 *   node scripts/check-hook-deps.mjs --update-baseline --allow-growth   # allows growth, prints additions
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import { stripLineComments } from './check-git-fixture-isolation.mjs'
import { blankStringsAndTemplates, stripComments as stripJsComments } from './lib/js-scanner.mjs'

const __dirname = import.meta.dirname
const REPO_ROOT = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'hook-deps-baseline.json')
const UNVERIFIABLE_BASELINE_PATH = resolve(__dirname, 'hook-deps-unverifiable-baseline.json')
// Prefix of the in-repo CLI self-test fixture tree (see runCliSelfTest).
// Dot-leading so it sorts out of the way; swept at start-up, AND listed in
// .gitignore -- the two cover different failure modes, the sweep bounding a
// stranded tree's lifetime and the ignore rule stopping one that exists
// right now from riding along on a `git add -A`.
const CLI_FIXTURE_PREFIX = '.hookdeps-cli-selftest-'

// ─── prek.toml parsing ──────────────────────────────────────────────────

function loadHooks(prekTomlPath) {
  const toml = parseToml(readFileSync(prekTomlPath, 'utf8'))
  const hooks = []
  for (const repo of toml.repos || []) {
    for (const h of repo.hooks || []) hooks.push(h)
  }
  return hooks
}

// ─── entry -> script resolution ─────────────────────────────────────────

const ENTRY_SHAPE_RE = /^(node|python3|bash)\s+(scripts\/[\w./-]+\.(?:mjs|py|sh))\b/
const ANY_SCRIPT_MENTION_RE = /scripts\/[\w./-]+\.(?:mjs|py|sh)/

/**
 * Classify one hook's entry.
 * @returns {{kind: 'script', scriptRel: string} | {kind: 'unverifiable', reason: string} | {kind: 'none'}}
 */
function classifyEntry(entry, repoRoot) {
  const m = ENTRY_SHAPE_RE.exec(entry || '')
  if (m) {
    const scriptRel = m[2]
    if (!existsSync(resolve(repoRoot, scriptRel))) {
      return { kind: 'unverifiable', reason: `entry script '${scriptRel}' does not exist on disk` }
    }
    return { kind: 'script', scriptRel }
  }
  if (ANY_SCRIPT_MENTION_RE.test(entry || '')) {
    return {
      kind: 'unverifiable',
      reason: 'entry does not match the recognised <interpreter> scripts/<path> shape',
    }
  }
  return { kind: 'none' }
}

// ─── dependency extraction ──────────────────────────────────────────────

/** Extract the balanced-paren argument text starting right after `(` at `openIdx`. */
function sliceCall(text, openIdx) {
  let depth = 1
  let i = openIdx + 1
  while (i < text.length && depth > 0) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    i++
  }
  return text.slice(openIdx + 1, i - 1)
}

function resolveJsSpec(repoRoot, scriptRepoDir, spec) {
  if (spec.startsWith('.')) {
    const abs = resolve(repoRoot, scriptRepoDir, spec)
    return relative(repoRoot, abs)
  }
  if (spec.startsWith('scripts/')) return spec
  return null // third-party / node: builtin / bare specifier
}

// `d` (indices) flag: needed on the `from`-form to check the `from` KEYWORD's
// own position, not just the match start -- see extractJsDeps's doc comment.
// Group numbering: from-form is (1)=`from`, (2)=quote, (3)=specifier; the
// other three are (1)=quote, (2)=specifier.
const JS_IMPORT_EXPORT_FROM_RE =
  /\b(?:import|export)\b[\s\S]{0,400}?(from)\s*(['"`])((?:(?!\2)[^\\\n])*)\2/dg
const JS_BARE_IMPORT_RE = /\bimport\s*(['"`])((?:(?!\1)[^\\\n])*)\1/g
const JS_REQUIRE_RE = /\brequire\s*\(\s*(['"`])((?:(?!\1)[^\\\n])*)\1\s*\)/g
const JS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])((?:(?!\1)[^\\\n])*)\1\s*\)/g

/**
 * Extract every first-party JS dependency specifier from `rawText`, plus any
 * unresolvable-but-suspicious construct found: a `require(`/`import(` CALL
 * SHAPE in real code whose argument is not a plain string literal (built
 * from concatenation, a variable, a function call, …) is a real dependency
 * edge this scan cannot resolve, and is reported unresolved rather than
 * silently read as "no dependency here".
 *
 * String-literal safety: `codeMask` blanks every string/template literal's
 * CONTENTS (quotes included, `blankStringsAndTemplates`'s own contract) to
 * spaces while preserving every other character and the overall
 * length/offsets. A KEYWORD position is real code only when
 * `commentsStripped[idx] === codeMask[idx]` there — i.e. it survived the
 * blanking. Note this test is only meaningful for a KEYWORD (`import`,
 * `export`, `from`, `require`) — a real import SPECIFIER is itself always a
 * string literal, so it is ALWAYS "blanked" by this same measure whether or
 * not the surrounding statement is genuine; checking a specifier's own
 * position this way would reject every real import as readily as a fake
 * one, which is not the property wanted.
 *
 * For the tight forms (bare `import '<spec>'`, `require(<spec>)`, dynamic
 * `import(<spec>)`) the keyword sits immediately before the quote/paren, so
 * checking the match START is already exact. The `import|export ... from`
 * form is different: it allows up to 400 characters between the keyword and
 * `from` (so a multi-line destructured import is still found), and that
 * same slack lets the engine walk PAST a real, short `import`/`export`
 * keyword and grab an unrelated `from '<spec>'` that happens to sit inside
 * a LATER string literal (e.g. a self-test fixture string containing the
 * word "from" — exactly what a synthetic `"import { x } from '…'"` fixture
 * is). So for this form BOTH the leading keyword's position AND the `from`
 * keyword's own position (not the specifier's) are checked.
 */
// A `require`/`import` CALL SHAPE in real code, used only to detect a
// DYNAMIC (non-string-literal) argument -- `require(foo)`,
// `require('./lib/' + name)`, `import(computePath())` -- that the precise
// literal-argument regexes above correctly do not match. Such a call is a
// real dependency edge this scan cannot resolve; it must not silently read
// as "no dependency here" just because the strict regex missed it.
const JS_CALL_SHAPE_RE = /\b(?:require|import)\s*\(/g

function extractJsDeps(rawText) {
  const commentsStripped = stripJsComments(rawText)
  const codeMask = blankStringsAndTemplates(commentsStripped)
  const isRealCode = (idx) => commentsStripped[idx] === codeMask[idx]

  const specs = []
  const resolvedCallStarts = new Set()

  JS_IMPORT_EXPORT_FROM_RE.lastIndex = 0
  let m
  while ((m = JS_IMPORT_EXPORT_FROM_RE.exec(commentsStripped)) !== null) {
    const fromStart = m.indices[1][0]
    if (isRealCode(m.index) && isRealCode(fromStart)) {
      specs.push(m[3])
      if (m.index === JS_IMPORT_EXPORT_FROM_RE.lastIndex) JS_IMPORT_EXPORT_FROM_RE.lastIndex++
    } else {
      // REJECTED match: rewind to just past its first character instead of
      // leaving `lastIndex` at the match END. This form spans up to 400
      // characters, so a rejected match can cover input that was never
      // examined -- e.g. an `import` keyword inside a string literal whose
      // nearest following `from` belongs to a GENUINE `import ... from`
      // statement below it. Consuming that span would drop the genuine
      // statement from the scan entirely and report the hook clean: the
      // guard's own fail-open shape, one function over. Rewinding cannot
      // loop forever -- `m.index + 1` is strictly greater than the
      // `lastIndex` this iteration started from, so the scan always
      // advances. `keyword-in-string.mjs` in the fixture is exactly this
      // case and fails without this branch.
      JS_IMPORT_EXPORT_FROM_RE.lastIndex = m.index + 1
    }
  }

  for (const re of [JS_BARE_IMPORT_RE, JS_REQUIRE_RE, JS_DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0
    while ((m = re.exec(commentsStripped)) !== null) {
      if (isRealCode(m.index)) {
        specs.push(m[2])
        if (re !== JS_BARE_IMPORT_RE) resolvedCallStarts.add(m.index)
      }
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  const unresolved = []
  JS_CALL_SHAPE_RE.lastIndex = 0
  while ((m = JS_CALL_SHAPE_RE.exec(commentsStripped)) !== null) {
    if (isRealCode(m.index) && !resolvedCallStarts.has(m.index)) {
      const line = commentsStripped.slice(0, m.index).split('\n').length
      unresolved.push(`dynamic require(/import( argument at line ${line} is not a string literal`)
    }
  }
  return { specs, unresolved }
}

const PY_SPEC_CALL_RE = /\bimportlib\.util\.spec_from_file_location\s*\(/g
const PY_SYS_PATH_RE = /\bsys\.path\.(?:insert|append)\s*\(/
const PY_EXEC_RE = /\bexec(?:file)?\s*\(/

/**
 * Extract Python `spec_from_file_location` dependencies, plus unresolved
 * markers for `sys.path.insert`/`append` (a plain `import` after a path
 * splice cannot be statically resolved to a file) and `exec(`/`execfile(`
 * (code run from a computed string is opaque to a static scan).
 *
 * `stripLineComments(text, 'py')` (reused from check-git-fixture-
 * isolation.mjs, #3722/#4015) blanks triple-quoted docstrings and drops
 * `#`-comment-only lines, so a docstring or comment merely NAMING
 * `spec_from_file_location(` in prose is not mistaken for a real call — the
 * same protection #3997's review found missing for the "indented inside a
 * function" shape, which this fixes by not requiring a column-0 anchor at
 * all (the position just has to survive comment/docstring stripping).
 */
function extractPyDeps(rawText) {
  const stripped = stripLineComments(rawText, 'py')
  const specs = []
  const unresolved = []

  PY_SPEC_CALL_RE.lastIndex = 0
  let m
  while ((m = PY_SPEC_CALL_RE.exec(stripped)) !== null) {
    // Cheap extra safety net: a call written out as a plain string literal
    // (e.g. an error message quoting the idiom) starts right after a quote
    // character, which a real top-level or indented statement never does.
    const prev = stripped[m.index - 1]
    if (prev !== "'" && prev !== '"') {
      const openIdx = stripped.indexOf('(', m.index)
      if (openIdx !== -1) specs.push(sliceCall(stripped, openIdx))
    }
  }
  if (PY_SYS_PATH_RE.test(stripped)) {
    unresolved.push('sys.path.insert/append found — a subsequent plain import cannot be resolved')
  }
  if (PY_EXEC_RE.test(stripped)) {
    unresolved.push(
      'exec(/execfile( found — code run from a computed string is opaque to this scan',
    )
  }
  return { specs, unresolved }
}

/**
 * Resolve one `spec_from_file_location` argument list to a `scripts/**` path.
 *
 * Returns a DISCRIMINATED result, never a bare `null`: this scan's own
 * "classify positively" rule (see the file header) says a path expression it
 * cannot judge is an UNVERIFIABLE hook, not an absent dependency. There are
 * two such shapes, and both used to return `null` and be filtered away
 * silently -- a dropped edge is the exact defect #3997 is about:
 *   - the path expression carries no literal string component at all
 *     (`SCRIPT_DIR / name`), so there is nothing to resolve; and
 *   - the pieces resolve OUTSIDE `scripts/`. The base is a GUESS
 *     (`REPO_ROOT` if the text names it, otherwise the script's own
 *     directory), so landing outside `scripts/` means either the guess was
 *     wrong or the dependency genuinely lives somewhere this guard's
 *     `scripts/**` model does not describe. Either way it is not knowledge
 *     that the hook is fine.
 * @returns {{kind: 'dep', rel: string} | {kind: 'unresolvable', reason: string}}
 */
function resolvePySpec(repoRoot, scriptRepoDir, argText) {
  // argText is `spec_from_file_location`'s full argument list: `"_name", <path
  // expr>`. The first quoted string is the MODULE NAME, not a path component
  // -- only string pieces AFTER the first top-level comma are path segments.
  const oneLine = argText.replace(/\s+/g, ' ').trim()
  const commaIdx = argText.indexOf(',')
  const pathExpr = commaIdx === -1 ? '' : argText.slice(commaIdx + 1)
  const pieces = [...pathExpr.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  if (pieces.length === 0) {
    return {
      kind: 'unresolvable',
      reason:
        'spec_from_file_location path expression has no literal string component ' +
        `(cannot be resolved statically): ${oneLine}`,
    }
  }
  let base
  if (/\bREPO_ROOT\b/.test(argText)) base = repoRoot
  else base = resolve(repoRoot, scriptRepoDir) // SCRIPT_DIR or unrecognised -> script's own dir
  let abs = base
  for (const p of pieces) abs = resolve(abs, p)
  const rel = relative(repoRoot, abs)
  if (!rel.startsWith('scripts/')) {
    return {
      kind: 'unresolvable',
      reason:
        `spec_from_file_location path resolves outside scripts/ (to '${rel}'), so the base ` +
        `this scan assumed may be wrong: ${oneLine}`,
    }
  }
  return { kind: 'dep', rel }
}

const SH_FILENAME_RE = /([\w-]+\.sh)\b/g

/**
 * Extract shell `.`/`source` dependencies (either keyword, mirroring
 * `sourcesSharedGuard`'s own recognised forms — #3997's review found only
 * the dot form was matched before), at ANY indent, naming a `.sh` file
 * anywhere in the statement — under `lib/`, or a sibling of the sourcing
 * script (#3997 review: "a shell dep not under lib/"). A source/dot
 * statement with no literal `.sh` filename anywhere (a fully dynamic
 * `. "$VAR"`) cannot be resolved and is reported unresolved rather than
 * silently dropped.
 */
function extractShDeps(rawText, repoRoot, scriptRepoDir) {
  const stripped = stripLineComments(rawText, 'sh')
  const specs = []
  const unresolved = []
  for (const rawLine of stripped.split('\n')) {
    const trimmed = rawLine.trim()
    if (!/^(?:\.|source)\s+\S/.test(trimmed)) continue
    const names = [...trimmed.matchAll(SH_FILENAME_RE)].map((m) => m[1])
    if (names.length === 0) {
      unresolved.push(`unresolvable shell source (no literal .sh filename): ${trimmed}`)
      continue
    }
    for (const name of names) {
      const candidate = /\/lib\//.test(trimmed)
        ? `scripts/lib/${name}`
        : relative(repoRoot, resolve(repoRoot, scriptRepoDir, name))
      if (existsSync(resolve(repoRoot, candidate))) {
        specs.push(candidate)
      } else {
        unresolved.push(`unresolvable shell source (guessed path does not exist): ${trimmed}`)
      }
    }
  }
  return { specs, unresolved }
}

/**
 * Resolve first-party dependencies of `scriptRel` (a `scripts/**` path,
 * relative to `repoRoot`), NON-recursively — one language-specific
 * extraction pass. Returns `{ deps: string[], unresolved: string[] }`.
 *
 * `cache` is an OPTIONAL `Map<scriptRel, result>` owned by one `analyze()`
 * call. Shared modules (`lib/js-scanner.mjs`, `check-import-cycles.mjs`,
 * `check-raw-tx.py`) sit in the closure of many hooks, and without it each
 * of the ~160 hooks re-reads and re-tokenises every module in its own
 * closure -- on every commit, since `hook-deps` is `always_run`. Scoping
 * the memo to one `analyze()` rather than to the module keeps it correct by
 * construction: no caller mutates the tree between two `analyze()` calls on
 * the SAME `repoRoot` (the CLI self-test does rewrite its fixture, but each
 * of its runs is a fresh subprocess), and each call gets a fresh map, so
 * the key needs no `repoRoot` component.
 */
function extractDirectDeps(repoRoot, scriptRel, cache) {
  const hit = cache?.get(scriptRel)
  if (hit) return hit
  const result = extractDirectDepsUncached(repoRoot, scriptRel)
  cache?.set(scriptRel, result)
  return result
}

function extractDirectDepsUncached(repoRoot, scriptRel) {
  const abs = resolve(repoRoot, scriptRel)
  const text = readFileSync(abs, 'utf8')
  const scriptRepoDir = dirname(scriptRel)

  if (scriptRel.endsWith('.mjs') || scriptRel.endsWith('.js')) {
    const { specs, unresolved } = extractJsDeps(text)
    const deps = specs
      .map((spec) => resolveJsSpec(repoRoot, scriptRepoDir, spec))
      .filter((d) => d && d !== scriptRel)
    return { deps, unresolved }
  }
  if (scriptRel.endsWith('.py')) {
    const { specs, unresolved } = extractPyDeps(text)
    const deps = []
    for (const argText of specs) {
      const r = resolvePySpec(repoRoot, scriptRepoDir, argText)
      // A path expression this scan cannot resolve is reported, never
      // filtered away -- see resolvePySpec's doc comment.
      if (r.kind === 'unresolvable') unresolved.push(r.reason)
      else if (r.rel !== scriptRel) deps.push(r.rel)
    }
    return { deps, unresolved }
  }
  if (scriptRel.endsWith('.sh')) {
    const { specs, unresolved } = extractShDeps(text, repoRoot, scriptRepoDir)
    return { deps: specs.filter((d) => d !== scriptRel), unresolved }
  }
  return { deps: [], unresolved: [] }
}

/**
 * Recursively resolve first-party dependencies of `scriptRel`. Returns
 * `{ deps: Set<string>, unresolved: string[] }` — `deps` NOT including
 * `scriptRel` itself; `unresolved` accumulated from every script in the
 * closure (a suspicious construct three hops away still makes the whole
 * chain unverifiable — the ORIGINAL script's `files:` is what a defanging
 * commit has to get past, no matter which link it targets).
 */
function resolveDeps(repoRoot, scriptRel, seen = new Set(), cache = new Map()) {
  if (!existsSync(resolve(repoRoot, scriptRel))) return { deps: new Set(), unresolved: [] }
  const { deps: direct, unresolved: directUnresolved } = extractDirectDeps(
    repoRoot,
    scriptRel,
    cache,
  )

  const all = new Set(direct)
  const unresolved = [...directUnresolved]
  for (const d of direct) {
    if (seen.has(d)) continue
    seen.add(d)
    const sub = resolveDeps(repoRoot, d, seen, cache)
    for (const t of sub.deps) all.add(t)
    unresolved.push(...sub.unresolved)
  }
  return { deps: all, unresolved }
}

// ─── the check itself ───────────────────────────────────────────────────

/**
 * Every `scripts/**` path that is SOME hook's own entry script, for which
 * at least one hook in the whole file (any hook -- not necessarily the
 * hook whose entry it is) fires on a commit that touches only that path:
 * either an `always_run` hook (fires on everything, e.g. a `--self-test`
 * sibling), or a `files:`-scoped hook whose regex matches that path (e.g.
 * a non-always_run self-test scoped exactly to `^scripts/check-x\.mjs$`).
 *
 * This is this repo's accepted (ubiquitous) way of covering a guard's OWN
 * script without unioning it into ITS OWN primary `files:` pattern -- e.g.
 * `check-elevation-tiers`'s `files:` is scoped to the `src/components/**`
 * it polices, not to its own script, and that is fine because
 * `check-elevation-tiers-self-test` (always_run) fires on every commit
 * regardless. `types-erasure-selftest` covers `check-types-erasure.mjs`
 * the other way -- not always_run, but `files:`-scoped exactly to that
 * script -- which is equally sufficient for "does at least one hook fire".
 *
 * This exemption applies ONLY to a script's OWN-script slot, never to a
 * DEPENDENCY relationship -- #3997's own four family-3 hooks (check-raw-
 * tx/-dynamic-sql/-table-ownership/-command-arity) all had exactly this
 * always_run self-test shape for THEIR OWN script and were still ruled
 * broken for their dependency on `guard_file_source.py` / `check-raw-
 * tx.py`, because a self-test's fixtures exercise the SELF-TESTED script's
 * own logic, not necessarily whatever a dependency it merely calls into
 * does. Conflating the two exemptions would silently re-open exactly the
 * hole #3997 fixed -- see the call site below, which applies this set only
 * when `t === cls.scriptRel`.
 */
function selfCoveredScripts(hooks, repoRoot) {
  const bySelf = new Map() // scriptRel -> [hook, ...] whose OWN entry is that script
  for (const h of hooks) {
    const cls = classifyEntry(h.entry, repoRoot)
    if (cls.kind !== 'script') continue
    if (!bySelf.has(cls.scriptRel)) bySelf.set(cls.scriptRel, [])
    bySelf.get(cls.scriptRel).push(h)
  }
  const covered = new Set()
  for (const [scriptRel, hs] of bySelf) {
    const fires = hs.some((h) => {
      if (h.always_run) return true
      if (!h.files) return false
      // `hookFilesMatch`, not a bare `files:` test: a hook that matches the
      // script and then removes it again in its own `exclude:` provably
      // never fires on it, so it cannot be what covers it. Testing `files:`
      // alone here while `hookFilesMatch` honours `exclude:` everywhere else
      // was an asymmetry that granted the own-script exemption to a hook
      // that does not fire (fixture: `self-excluded-js`).
      return hookFilesMatch(h, scriptRel) === true
    })
    if (fires) covered.add(scriptRel)
  }
  return covered
}

/** `files:` match AND not removed again by `exclude:`, if the hook has one. */
function hookFilesMatch(h, targetPath) {
  let re
  try {
    re = new RegExp(h.files)
  } catch {
    return null // caller already reports a compile-error separately
  }
  if (!re.test(targetPath)) return false
  if (h.exclude) {
    try {
      if (new RegExp(h.exclude).test(targetPath)) return false
    } catch {
      // A malformed exclude is a prek.toml bug of its own; do not let it
      // hide a real dependency gap here.
    }
  }
  return true
}

/**
 * @param {string} prekTomlPath
 * @param {string} [repoRoot] defaults to prekTomlPath's directory
 * @returns {{broken: Array<{hookId: string, dep: string, files: string, class: string}>,
 *            unverifiable: Array<{hookId: string, reason: string}>}}
 */
function analyze(prekTomlPath, repoRoot = dirname(prekTomlPath)) {
  const hooks = loadHooks(prekTomlPath)
  const broken = []
  const unverifiable = []
  const selfCovered = selfCoveredScripts(hooks, repoRoot)
  // One direct-dependency memo for this whole analyze() call -- see
  // extractDirectDeps's doc comment.
  const depCache = new Map()

  for (const h of hooks) {
    if (h.always_run) continue // bypasses files: entirely -- fine by construction

    const cls = classifyEntry(h.entry, repoRoot)
    if (cls.kind === 'none') continue
    if (cls.kind === 'unverifiable') {
      unverifiable.push({ hookId: h.id, reason: cls.reason })
      continue
    }

    if (!h.files) {
      // Selected by `types`/`types_or` (or nothing at all) rather than a
      // `files:` regex -- this guard's method (regex-match a path) does not
      // apply. Reported, not silently treated as fine (#3997's own carried-
      // forward "cargo-test / vitest" gap is exactly this shape).
      unverifiable.push({
        hookId: h.id,
        reason: `runs ${cls.scriptRel} but is selected by types/types_or, not a files: regex`,
      })
      continue
    }

    const matches0 = hookFilesMatch(h, cls.scriptRel)
    if (matches0 === null) {
      unverifiable.push({ hookId: h.id, reason: `files: regex does not compile: ${h.files}` })
      continue
    }

    const { deps, unresolved } = resolveDeps(repoRoot, cls.scriptRel, new Set(), depCache)
    if (unresolved.length > 0) {
      unverifiable.push({
        hookId: h.id,
        reason: `dependency closure contains unresolved construct(s): ${unresolved.join('; ')}`,
      })
      // Fall through -- still check whatever WAS resolved. An unresolved
      // lurking dependency does not excuse a KNOWN one from being unioned.
    }

    const targets = new Set([cls.scriptRel, ...deps])
    for (const t of targets) {
      if (hookFilesMatch(h, t)) continue
      // The "own script, covered by ANY sibling hook that fires on it"
      // exemption applies ONLY to the script itself, never to one of its
      // dependencies (see selfCoveredScripts's doc comment).
      if (t === cls.scriptRel && selfCovered.has(cls.scriptRel)) continue
      broken.push({
        hookId: h.id,
        dep: t,
        files: h.files,
        class: t === cls.scriptRel ? 'no-self-test' : 'missing-union',
      })
    }
  }

  return { broken, unverifiable }
}

// ─── baselines (ratchets) ───────────────────────────────────────────────

function pairKey(p) {
  return `${p.hookId}::${p.dep}`
}

/**
 * Read a baseline file as a JSON array. A malformed baseline is a legible
 * FAILURE naming the file, not an unhandled `SyntaxError` stack trace out
 * of a pre-commit hook -- `hook-deps` is `always_run`, so this is on the
 * path of every commit, and "what even is this error" is the difference
 * between a 10-second fix and a `--no-verify`.
 */
function readJsonArray(path) {
  if (!existsSync(path)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(`FATAL: baseline file is not valid JSON: ${path}`)
    console.error(`  ${err.message}`)
    console.error(
      '\n  -> Fix it by hand, or regenerate it:\n' +
        '       node scripts/check-hook-deps.mjs --update-baseline\n',
    )
    process.exit(1)
  }
  if (!Array.isArray(parsed)) {
    console.error(`FATAL: baseline file must contain a JSON ARRAY: ${path}`)
    console.error(`  got: ${typeof parsed}`)
    console.error(
      '\n  -> Fix it by hand, or regenerate it:\n' +
        '       node scripts/check-hook-deps.mjs --update-baseline\n',
    )
    process.exit(1)
  }
  return parsed
}

function writeBrokenBaseline(pairs, baselinePath) {
  const sorted = [...pairs].toSorted((a, b) => pairKey(a).localeCompare(pairKey(b)))
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      sorted.map((p) => ({ hookId: p.hookId, dep: p.dep, class: p.class })),
      null,
      2,
    )}\n`,
  )
}

function writeUnverifiableBaseline(hookIds, baselinePath) {
  const sorted = [...new Set(hookIds)].toSorted((a, b) => a.localeCompare(b))
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`)
}

function runGuard(
  repoRoot = REPO_ROOT,
  baselinePath = BASELINE_PATH,
  unverifiableBaselinePath = UNVERIFIABLE_BASELINE_PATH,
) {
  const { broken, unverifiable } = analyze(resolve(repoRoot, 'prek.toml'), repoRoot)
  const baseline = readJsonArray(baselinePath)
  const unverifiableBaseline = readJsonArray(unverifiableBaselinePath)

  const baselineKeys = new Set(baseline.map(pairKey))
  const brokenKeys = new Set(broken.map(pairKey))
  const newPairs = broken.filter((p) => !baselineKeys.has(pairKey(p)))
  const staleEntries = baseline.filter((p) => !brokenKeys.has(pairKey(p)))

  const unverifiableIds = new Set(unverifiable.map((u) => u.hookId))
  const unverifiableBaselineSet = new Set(unverifiableBaseline)
  const newUnverifiable = [...unverifiableIds].filter((id) => !unverifiableBaselineSet.has(id))
  const staleUnverifiable = unverifiableBaseline.filter((id) => !unverifiableIds.has(id))

  if (unverifiable.length > 0) {
    console.log(`UNVERIFIABLE (${unverifiable.length}) -- cannot check, reported not skipped:`)
    for (const u of unverifiable) console.log(`  - ${u.hookId}: ${u.reason}`)
  }

  const allClean =
    newPairs.length === 0 &&
    staleEntries.length === 0 &&
    newUnverifiable.length === 0 &&
    staleUnverifiable.length === 0

  if (allClean) {
    console.log(
      `OK: hook-deps guard (#3997) -- ${broken.length} pre-existing baselined gap(s), ` +
        `${unverifiableBaseline.length} pre-existing baselined unverifiable hook(s), 0 new, 0 stale.`,
    )
    return 0
  }

  if (newPairs.length > 0) {
    console.error(
      `FAIL: ${newPairs.length} NEW hook(s) with a files: pattern that misses a first-party ` +
        `dependency (#3997 shape -- editing the dependency alone selects the hook not at all):`,
    )
    for (const p of newPairs) {
      console.error(
        `  - hook '${p.hookId}' (${p.class}): files: ${JSON.stringify(p.files)} does not match '${p.dep}'`,
      )
    }
    console.error(
      "\n  -> Union the dependency path into the hook's files: pattern (copy the spelling\n" +
        '     already used by a correct sibling), or write a self-test if `class` is\n' +
        '     "no-self-test", or if this pair is a genuine pre-existing gap you are\n' +
        '     deliberately deferring, add it via:\n' +
        '       node scripts/check-hook-deps.mjs --update-baseline --allow-growth\n',
    )
  }
  if (staleEntries.length > 0) {
    console.error(
      `FAIL: ${staleEntries.length} baseline entr(y/ies) no longer reproduce -- the gap was ` +
        `fixed, so the baseline must shrink:`,
    )
    for (const p of staleEntries) console.error(`  - ${p.hookId} :: ${p.dep}`)
    console.error('\n  -> Re-run: node scripts/check-hook-deps.mjs --update-baseline\n')
  }
  if (newUnverifiable.length > 0) {
    console.error(
      `FAIL: ${newUnverifiable.length} NEW unverifiable hook id(s) -- a hook this guard cannot ` +
        `check is not the same as a hook that is fine:`,
    )
    for (const id of newUnverifiable) console.error(`  - ${id}`)
    console.error(
      '\n  -> Either make it checkable, or acknowledge it via:\n' +
        '       node scripts/check-hook-deps.mjs --update-baseline --allow-growth\n',
    )
  }
  if (staleUnverifiable.length > 0) {
    console.error(
      `FAIL: ${staleUnverifiable.length} unverifiable-baseline entr(y/ies) are no longer ` +
        `unverifiable -- the baseline must shrink:`,
    )
    for (const id of staleUnverifiable) console.error(`  - ${id}`)
    console.error('\n  -> Re-run: node scripts/check-hook-deps.mjs --update-baseline\n')
  }
  return 1
}

/**
 * Regenerate both baselines, refusing to GROW either one unless
 * `allowGrowth`. Returns the process exit code (0 = wrote, 1 = refused) --
 * the caller wires it to `process.exit`, the same shape `runGuard()` uses.
 *
 * Every parameter has a production default, so `runUpdateBaselineGrowthSelf
 * Test` can point THIS function at a fixture tree instead of testing a
 * second copy of the refusal logic. That is not a stylistic preference: an
 * earlier revision had a `updateBaselineFor()` twin that the self-test
 * drove while production kept its own `!allowGrowth` guard, and deleting
 * the PRODUCTION guard left all three assertions green -- exactly the
 * "the real exit path is untested" defect this file's `runCliSelfTest`
 * exists to close for `runGuard()`, recurring one function over.
 */
function updateBaseline(
  repoRoot = REPO_ROOT,
  baselinePath = BASELINE_PATH,
  unverifiableBaselinePath = UNVERIFIABLE_BASELINE_PATH,
  allowGrowth = process.argv.includes('--allow-growth'),
) {
  const { broken, unverifiable } = analyze(resolve(repoRoot, 'prek.toml'), repoRoot)
  const unverifiableIds = [...new Set(unverifiable.map((u) => u.hookId))]

  const existingBroken = readJsonArray(baselinePath)
  const existingUnverifiable = readJsonArray(unverifiableBaselinePath)
  const existingKeys = new Set(existingBroken.map(pairKey))
  const existingUnverifiableSet = new Set(existingUnverifiable)

  const addedPairs = broken.filter((p) => !existingKeys.has(pairKey(p)))
  const addedUnverifiable = unverifiableIds.filter((id) => !existingUnverifiableSet.has(id))

  if (!allowGrowth && (addedPairs.length > 0 || addedUnverifiable.length > 0)) {
    console.error(
      'REFUSED: --update-baseline would GROW the ratchet. A bare regenerate-and-trust command ' +
        'is the same policy-not-mechanism gap #3997 is about -- growth needs --allow-growth and ' +
        'a reviewer who has seen this list:',
    )
    for (const p of addedPairs) console.error(`  + ${p.hookId} :: ${p.dep} (${p.class})`)
    for (const id of addedUnverifiable) console.error(`  + ${id} (newly unverifiable)`)
    console.error('\n  -> If this is a deliberate deferral, re-run with --allow-growth.\n')
    return 1
  }

  writeBrokenBaseline(broken, baselinePath)
  writeUnverifiableBaseline(unverifiableIds, unverifiableBaselinePath)
  if (addedPairs.length > 0 || addedUnverifiable.length > 0) {
    console.log('Added (growth acknowledged via --allow-growth):')
    for (const p of addedPairs) console.log(`  + ${p.hookId} :: ${p.dep} (${p.class})`)
    for (const id of addedUnverifiable) console.log(`  + ${id} (newly unverifiable)`)
  }
  console.log(
    `Wrote ${relative(repoRoot, baselinePath)} (${broken.length} pair(s)) and ` +
      `${relative(repoRoot, unverifiableBaselinePath)} (${unverifiableIds.length} id(s)).`,
  )
  return 0
}

// ─── self-test ──────────────────────────────────────────────────────────

function buildInProcessFixture(tmp) {
  const scriptsDir = join(tmp, 'scripts')
  const libDir = join(scriptsDir, 'lib')
  mkdirSync(libDir, { recursive: true })

  // A shared JS lib.
  writeFileSync(join(libDir, 'shared.mjs'), 'export const helper = () => 1\n')
  writeFileSync(
    join(scriptsDir, 'good.mjs'),
    "import { helper } from './lib/shared.mjs'\nexport const x = helper()\n",
  )
  writeFileSync(
    join(scriptsDir, 'bad.mjs'),
    "import { helper } from './lib/shared.mjs'\nexport const x = helper()\n",
  )
  // Import-shaped FIXTURE STRING, indented inside a function -- must NOT be
  // read as a real dependency edge (string-literal position check).
  writeFileSync(
    join(scriptsDir, 'has-fixture.mjs'),
    'export function runSelfTest() {\n' +
      '  const src = "import { x } from \'./qux.mjs\'"\n' +
      '  return src\n' +
      '}\n',
  )
  // A commented-out mention -- must NOT be read as a real dependency edge.
  writeFileSync(
    join(scriptsDir, 'has-comment.mjs'),
    "// import { helper } from './lib/shared.mjs'\nexport const y = 1\n",
  )
  // A STRING LITERAL containing the word `import` but NO `from`, sitting
  // ABOVE a genuine `import ... from` statement. The `import|export ... from`
  // regex allows 400 characters of slack between the two keywords, so it
  // matches starting at the FAKE keyword inside the string and running all
  // the way through the REAL statement's `from '<spec>'`. That match is
  // correctly REJECTED (its leading keyword is not real code) -- but a
  // rejected match must not swallow the input it spanned: leaving
  // `lastIndex` past the real statement means the real statement is never
  // rescanned and the dependency is silently lost, which is the guard's own
  // fail-open shape. `has-fixture.mjs` above does NOT cover this: its
  // fixture string carries its own `from`, so the match ends inside the
  // string and the slack never reaches past anything real.
  writeFileSync(
    join(scriptsDir, 'keyword-in-string.mjs'),
    "const NOTE = 'the import keyword'\n" +
      "import { helper } from './lib/shared.mjs'\n" +
      'export const z = helper(NOTE)\n',
  )
  // A LEADING-WHITESPACE (indented) real top-level import, e.g. inside an
  // if-block -- must still be found (#3997-review gap 6).
  writeFileSync(
    join(scriptsDir, 'indented-import.mjs'),
    "if (true) {\n  import('./lib/shared.mjs').then(() => {})\n}\n",
  )
  // require() and export ... from -- #3997-review gaps 3 and 5.
  writeFileSync(join(scriptsDir, 'requires.mjs'), "const s = require('./lib/shared.mjs')\n")
  writeFileSync(join(scriptsDir, 'export-from.mjs'), "export { helper } from './lib/shared.mjs'\n")
  // A DYNAMIC require()/import() argument (concatenation, a variable) --
  // not a form named by #3997's review, but the same "classify positively"
  // principle: the strict literal-argument regexes correctly do not match
  // it, and it must not therefore read as "no dependency here" either.
  writeFileSync(
    join(scriptsDir, 'dynamic-require.mjs'),
    "const name = 'shared'\nconst s = require('./lib/' + name + '.mjs')\n",
  )

  // A shared Python lib + two consumers (one correct, one not) + one with
  // an INDENTED (inside a function) spec_from_file_location -- #3997-review
  // gap 8.
  writeFileSync(join(libDir, 'shared_py.py'), 'def helper():\n    return 1\n')
  const pySpecBody =
    'import importlib.util\n' +
    'from pathlib import Path\n' +
    'SCRIPT_DIR = Path(__file__).resolve().parent\n' +
    '_spec = importlib.util.spec_from_file_location(\n' +
    '    "_shared", SCRIPT_DIR / "lib" / "shared_py.py"\n' +
    ')\n'
  writeFileSync(join(scriptsDir, 'good.py'), pySpecBody)
  writeFileSync(join(scriptsDir, 'bad.py'), pySpecBody)
  writeFileSync(
    join(scriptsDir, 'indented-spec.py'),
    'import importlib.util\n' +
      'from pathlib import Path\n' +
      'SCRIPT_DIR = Path(__file__).resolve().parent\n' +
      'def loader():\n' +
      '    spec = importlib.util.spec_from_file_location(\n' +
      '        "_shared", SCRIPT_DIR / "lib" / "shared_py.py"\n' +
      '    )\n' +
      '    return spec\n',
  )
  // sys.path.insert + plain import, and exec( -- #3997-review gaps 7 and 9:
  // must be UNRESOLVED, not silently clean.
  writeFileSync(
    join(scriptsDir, 'sys-path.py'),
    'import sys\nsys.path.insert(0, "lib")\nimport shared_py\n',
  )
  writeFileSync(
    join(scriptsDir, 'exec-loader.py'),
    'from pathlib import Path\n' + 'exec(Path("lib/shared_py.py").read_text())\n',
  )
  // A spec_from_file_location whose path expression resolves OUTSIDE
  // scripts/ (an unrecognised base -- here REPO_ROOT into a sibling tree).
  // It is a real dependency edge this scan cannot judge, so it must be
  // UNVERIFIABLE, not silently dropped (classify positively).
  writeFileSync(
    join(scriptsDir, 'py-outside-scripts.py'),
    'import importlib.util\n' +
      'from pathlib import Path\n' +
      'REPO_ROOT = Path(__file__).resolve().parent.parent\n' +
      '_spec = importlib.util.spec_from_file_location(\n' +
      '    "_mod", REPO_ROOT / "other" / "mod.py"\n' +
      ')\n',
  )
  // ...and one whose path expression carries NO literal string component at
  // all (a variable): same rule, same outcome.
  writeFileSync(
    join(scriptsDir, 'py-dynamic-spec.py'),
    'import importlib.util\n' +
      'from pathlib import Path\n' +
      'SCRIPT_DIR = Path(__file__).resolve().parent\n' +
      'def load(name):\n' +
      '    return importlib.util.spec_from_file_location("_m", SCRIPT_DIR / name)\n',
  )
  // A docstring/comment MENTIONING spec_from_file_location -- must not be a
  // false positive now that the column-0 anchor is gone.
  writeFileSync(
    join(scriptsDir, 'py-docstring-mention.py'),
    '"""\n' +
      'This module used to call importlib.util.spec_from_file_location(...)\n' +
      'but no longer does.\n' +
      '"""\n' +
      'x = 1\n',
  )

  // A script whose only hook matches it in `files:` and then removes it
  // again in `exclude:` -- the own-script slot's mirror of `excluded-dep`
  // below. `selfCoveredScripts` must apply the SAME files:-AND-NOT-exclude:
  // test `hookFilesMatch` applies, or a hook that provably never fires on
  // its own script still counts as covering it.
  writeFileSync(join(scriptsDir, 'self-excluded.mjs'), 'export const q = 1\n')

  // A shared shell lib under lib/, one NOT under lib/ (sibling), sourced via
  // both `.` and `source` keywords -- #3997-review gaps 1 and 2.
  writeFileSync(join(libDir, 'shared.sh'), 'shared_fn() { :; }\n')
  writeFileSync(join(scriptsDir, 'sibling.sh'), 'sibling_fn() { :; }\n')
  writeFileSync(
    join(scriptsDir, 'good.sh'),
    '#!/usr/bin/env bash\n. "$(dirname "$0")/lib/shared.sh"\n',
  )
  writeFileSync(
    join(scriptsDir, 'bad.sh'),
    '#!/usr/bin/env bash\n. "$(dirname "$0")/lib/shared.sh"\n',
  )
  writeFileSync(
    join(scriptsDir, 'uses-source-keyword.sh'),
    '#!/usr/bin/env bash\nsource "$(dirname "$0")/lib/shared.sh"\n',
  )
  writeFileSync(
    join(scriptsDir, 'sources-sibling.sh'),
    '#!/usr/bin/env bash\n. "$(dirname "$0")/sibling.sh"\n',
  )
  writeFileSync(
    join(scriptsDir, 'dynamic-source.sh'),
    '#!/usr/bin/env bash\nGUARD="$1"\n. "$GUARD"\n',
  )

  return { scriptsDir, libDir }
}

function inProcessFixtureToml() {
  return `
[[repos]]
repo = "local"
[[repos.hooks]]
id = "good-js"
entry = "node scripts/good.mjs"
files = "^scripts/(good\\\\.mjs|lib/shared\\\\.mjs)$"

[[repos.hooks]]
id = "bad-js"
entry = "node scripts/bad.mjs"
files = "^scripts/bad\\\\.mjs$"

[[repos.hooks]]
id = "fixture-string-js"
entry = "node scripts/has-fixture.mjs"
files = "^scripts/has-fixture\\\\.mjs$"

[[repos.hooks]]
id = "commented-js"
entry = "node scripts/has-comment.mjs"
files = "^scripts/has-comment\\\\.mjs$"

[[repos.hooks]]
id = "keyword-in-string-js"
entry = "node scripts/keyword-in-string.mjs"
files = "^scripts/keyword-in-string\\\\.mjs$"

[[repos.hooks]]
id = "indented-import-js"
entry = "node scripts/indented-import.mjs"
files = "^scripts/indented-import\\\\.mjs$"

[[repos.hooks]]
id = "requires-js"
entry = "node scripts/requires.mjs"
files = "^scripts/requires\\\\.mjs$"

[[repos.hooks]]
id = "export-from-js"
entry = "node scripts/export-from.mjs"
files = "^scripts/export-from\\\\.mjs$"

[[repos.hooks]]
id = "dynamic-require-js"
entry = "node scripts/dynamic-require.mjs"
files = "^scripts/dynamic-require\\\\.mjs$"

[[repos.hooks]]
id = "good-py"
entry = "python3 scripts/good.py"
files = "^scripts/(good\\\\.py|lib/shared_py\\\\.py)$"

[[repos.hooks]]
id = "bad-py"
entry = "python3 scripts/bad.py"
files = "^scripts/bad\\\\.py$"

[[repos.hooks]]
id = "indented-spec-py"
entry = "python3 scripts/indented-spec.py"
files = "^scripts/indented-spec\\\\.py$"

[[repos.hooks]]
id = "sys-path-py"
entry = "python3 scripts/sys-path.py"
files = "^scripts/sys-path\\\\.py$"

[[repos.hooks]]
id = "exec-loader-py"
entry = "python3 scripts/exec-loader.py"
files = "^scripts/exec-loader\\\\.py$"

[[repos.hooks]]
id = "py-outside-scripts"
entry = "python3 scripts/py-outside-scripts.py"
files = "^scripts/py-outside-scripts\\\\.py$"

[[repos.hooks]]
id = "py-dynamic-spec"
entry = "python3 scripts/py-dynamic-spec.py"
files = "^scripts/py-dynamic-spec\\\\.py$"

[[repos.hooks]]
id = "py-docstring-mention"
entry = "python3 scripts/py-docstring-mention.py"
files = "^scripts/py-docstring-mention\\\\.py$"

[[repos.hooks]]
id = "good-sh"
entry = "bash scripts/good.sh"
files = "^scripts/(good\\\\.sh|lib/shared\\\\.sh)$"

[[repos.hooks]]
id = "bad-sh"
entry = "bash scripts/bad.sh"
files = "^scripts/bad\\\\.sh$"

[[repos.hooks]]
id = "uses-source-keyword-sh"
entry = "bash scripts/uses-source-keyword.sh"
files = "^scripts/uses-source-keyword\\\\.sh$"

[[repos.hooks]]
id = "sources-sibling-sh"
entry = "bash scripts/sources-sibling.sh"
files = "^scripts/sources-sibling\\\\.sh$"

[[repos.hooks]]
id = "dynamic-source-sh"
entry = "bash scripts/dynamic-source.sh"
files = "^scripts/dynamic-source\\\\.sh$"

[[repos.hooks]]
id = "always-run-bad"
entry = "node scripts/bad.mjs"
always_run = true

[[repos.hooks]]
id = "scoped-elsewhere-shares-bad-script"
entry = "node scripts/bad.mjs"
files = "^other/.*$"

[[repos.hooks]]
id = "types-based"
entry = "bash scripts/good.sh"
types = ["shell"]

[[repos.hooks]]
id = "ambiguous-wrapper"
entry = "bash -c 'source scripts/lib/shared.sh'"
files = "^scripts/.*$"

[[repos.hooks]]
id = "no-script-at-all"
entry = "npx something"
files = "^scripts/.*$"

[[repos.hooks]]
id = "missing-entry-script"
entry = "node scripts/does-not-exist.mjs"
files = "^scripts/does-not-exist\\\\.mjs$"

[[repos.hooks]]
id = "excluded-dep"
entry = "node scripts/bad.mjs"
files = "^scripts/(bad\\\\.mjs|lib/shared\\\\.mjs)$"
exclude = "^scripts/lib/shared\\\\.mjs$"

[[repos.hooks]]
id = "self-excluded-js"
entry = "node scripts/self-excluded.mjs"
files = "^scripts/self-excluded\\\\.mjs$"
exclude = "^scripts/self-excluded\\\\.mjs$"
`
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const tmp = mkdtempSync(join(os.tmpdir(), 'hook-deps-selftest-'))
  try {
    buildInProcessFixture(tmp)
    const prekTomlPath = join(tmp, 'prek.toml')
    writeFileSync(prekTomlPath, inProcessFixtureToml())

    const { broken, unverifiable } = analyze(prekTomlPath)
    const brokenIds = new Set(broken.map((p) => p.hookId))
    const brokenPairs = new Set(broken.map((p) => `${p.hookId}::${p.dep}`))
    const unverifiableIds = new Set(unverifiable.map((u) => u.hookId))
    const classOf = (hookId, dep) => broken.find((p) => p.hookId === hookId && p.dep === dep)?.class

    if (!brokenIds.has('good-js')) ok('good-js (self+dep unioned) is clean')
    else fail('good-js is clean', JSON.stringify(broken))

    if (brokenPairs.has('bad-js::scripts/lib/shared.mjs')) {
      ok('bad-js (dep NOT unioned) is flagged for the missing dependency')
      if (classOf('bad-js', 'scripts/lib/shared.mjs') === 'missing-union') {
        ok('bad-js gap is classed "missing-union"')
      } else {
        fail('bad-js gap classed missing-union', classOf('bad-js', 'scripts/lib/shared.mjs'))
      }
    } else {
      fail('bad-js is flagged', JSON.stringify(broken))
    }

    if (!brokenIds.has('fixture-string-js')) {
      ok('an import-shaped FIXTURE STRING (indented) is not read as a real dependency')
    } else {
      fail('fixture string is not a false positive', JSON.stringify(broken))
    }

    if (!brokenIds.has('commented-js')) {
      ok('a commented-out import is not read as a real dependency')
    } else {
      fail('commented import is not a false positive', JSON.stringify(broken))
    }

    if (brokenPairs.has('keyword-in-string-js::scripts/lib/shared.mjs')) {
      ok(
        'a real import AFTER an import-shaped string literal is still found (rejected match does not swallow it)',
      )
    } else {
      fail('real import after a fake keyword in a string is found', JSON.stringify(broken))
    }

    if (brokenPairs.has('indented-import-js::scripts/lib/shared.mjs')) {
      ok('a LEADING-WHITESPACE dynamic import() is found (review gap 6)')
    } else {
      fail('indented dynamic import is found', JSON.stringify(broken))
    }

    if (brokenPairs.has('requires-js::scripts/lib/shared.mjs')) {
      ok('a require() call is found (review gap 3)')
    } else {
      fail('require() is found', JSON.stringify(broken))
    }

    if (brokenPairs.has('export-from-js::scripts/lib/shared.mjs')) {
      ok('an export ... from is found (review gap 5)')
    } else {
      fail('export ... from is found', JSON.stringify(broken))
    }

    if (unverifiableIds.has('dynamic-require-js')) {
      ok('a DYNAMIC require()/import() argument is UNVERIFIABLE, not silently clean')
    } else {
      fail('dynamic require() argument is unverifiable', JSON.stringify(unverifiable))
    }

    if (!brokenIds.has('good-py')) ok('good-py (self+dep unioned) is clean')
    else fail('good-py is clean', JSON.stringify(broken))

    if (brokenPairs.has('bad-py::scripts/lib/shared_py.py')) {
      ok('bad-py (dep NOT unioned) is flagged for the missing dependency')
    } else {
      fail('bad-py is flagged', JSON.stringify(broken))
    }

    if (brokenPairs.has('indented-spec-py::scripts/lib/shared_py.py')) {
      ok('a spec_from_file_location INDENTED inside a function is found (review gap 8)')
    } else {
      fail('indented spec_from_file_location is found', JSON.stringify(broken))
    }

    if (unverifiableIds.has('sys-path-py')) {
      ok('sys.path.insert + plain import is UNVERIFIABLE, not silently clean (review gap 7)')
    } else {
      fail('sys.path.insert is unverifiable', JSON.stringify(unverifiable))
    }

    if (unverifiableIds.has('exec-loader-py')) {
      ok('exec(...) is UNVERIFIABLE, not silently clean (review gap 9)')
    } else {
      fail('exec( is unverifiable', JSON.stringify(unverifiable))
    }

    if (unverifiableIds.has('py-outside-scripts')) {
      ok('a spec_from_file_location resolving OUTSIDE scripts/ is UNVERIFIABLE, not dropped')
    } else {
      fail('out-of-scripts spec path is unverifiable', JSON.stringify({ broken, unverifiable }))
    }

    if (unverifiableIds.has('py-dynamic-spec')) {
      ok('a spec_from_file_location path with no literal component is UNVERIFIABLE, not dropped')
    } else {
      fail('literal-free spec path is unverifiable', JSON.stringify({ broken, unverifiable }))
    }

    if (!brokenIds.has('py-docstring-mention') && !unverifiableIds.has('py-docstring-mention')) {
      ok('a docstring merely naming spec_from_file_location is not a false positive')
    } else {
      fail('docstring mention is not a false positive', JSON.stringify({ broken, unverifiable }))
    }

    if (!brokenIds.has('good-sh')) ok('good-sh (self+dep unioned) is clean')
    else fail('good-sh is clean', JSON.stringify(broken))

    if (brokenPairs.has('bad-sh::scripts/lib/shared.sh')) {
      ok('bad-sh (dep NOT unioned) is flagged for the missing dependency')
    } else {
      fail('bad-sh is flagged', JSON.stringify(broken))
    }

    if (brokenPairs.has('uses-source-keyword-sh::scripts/lib/shared.sh')) {
      ok('the shell `source` keyword (not just `.`) is recognised (review gap 1)')
    } else {
      fail('source keyword is recognised', JSON.stringify(broken))
    }

    if (brokenPairs.has('sources-sibling-sh::scripts/sibling.sh')) {
      ok('a shell dep NOT under lib/ (a sibling script) is found (review gap 2)')
    } else {
      fail('sibling shell dep is found', JSON.stringify(broken))
    }

    if (unverifiableIds.has('dynamic-source-sh')) {
      ok('a fully dynamic shell source (no literal .sh name) is UNVERIFIABLE')
    } else {
      fail('dynamic shell source is unverifiable', JSON.stringify(unverifiable))
    }

    if (!brokenIds.has('always-run-bad')) {
      ok('always_run hook is exempt from files: matching entirely')
    } else {
      fail('always_run hook is exempt', JSON.stringify(broken))
    }

    if (!brokenPairs.has('scoped-elsewhere-shares-bad-script::scripts/bad.mjs')) {
      ok('own-script gap is exempt when ANY sibling hook (here: always-run-bad) fires on it')
    } else {
      fail(
        'cross-hook self-coverage exemption applies to the own-script slot',
        JSON.stringify(broken),
      )
    }
    if (brokenPairs.has('scoped-elsewhere-shares-bad-script::scripts/lib/shared.mjs')) {
      ok('the same exemption does NOT extend to a DEPENDENCY of that script')
    } else {
      fail('self-coverage exemption must not extend to dependencies', JSON.stringify(broken))
    }

    if (unverifiableIds.has('types-based')) {
      ok('a types:-selected hook (no files: regex) is reported UNVERIFIABLE, not silently fine')
    } else {
      fail('types-based hook is reported unverifiable', JSON.stringify(unverifiable))
    }

    if (unverifiableIds.has('ambiguous-wrapper')) {
      ok('a bash -c wrapper mentioning a script is reported UNVERIFIABLE, not silently fine')
    } else {
      fail('ambiguous wrapper is reported unverifiable', JSON.stringify(unverifiable))
    }

    if (unverifiableIds.has('missing-entry-script')) {
      ok('a hook whose entry script does not exist on disk is UNVERIFIABLE (review gap 10)')
    } else {
      fail('missing entry script is unverifiable', JSON.stringify(unverifiable))
    }

    if (!brokenIds.has('excluded-dep') && !unverifiableIds.has('excluded-dep')) {
      fail(
        'a dep unioned into files: but removed by exclude: is still flagged (review gap 11)',
        JSON.stringify({ broken, unverifiable }),
      )
    } else if (brokenPairs.has('excluded-dep::scripts/lib/shared.mjs')) {
      ok('a dep unioned into files: but removed by exclude: is still flagged (review gap 11)')
    } else {
      fail('excluded dep is flagged', JSON.stringify(broken))
    }

    if (brokenPairs.has('self-excluded-js::scripts/self-excluded.mjs')) {
      ok('a hook whose files: matches its own script and then EXCLUDES it does not self-cover')
      if (classOf('self-excluded-js', 'scripts/self-excluded.mjs') === 'no-self-test') {
        ok('that own-script gap is classed "no-self-test"')
      } else {
        fail(
          'self-excluded own-script gap classed no-self-test',
          String(classOf('self-excluded-js', 'scripts/self-excluded.mjs')),
        )
      }
    } else {
      fail('exclude:-negated self-coverage is not counted as coverage', JSON.stringify(broken))
    }

    if (!brokenIds.has('no-script-at-all') && !unverifiableIds.has('no-script-at-all')) {
      ok('a hook with no script reference at all is silently fine (nothing to check)')
    } else {
      fail('no-script-at-all hook is fine', JSON.stringify({ broken, unverifiable }))
    }

    // --- baseline ratchet behaviour (pairs) -----------------------------
    const asBaseline = (pairs) =>
      JSON.stringify(pairs.map((p) => ({ hookId: p.hookId, dep: p.dep })))

    const baselineWithBadJs = broken.filter((p) => p.hookId === 'bad-js')
    const stillBroken = analyze(prekTomlPath).broken
    const baselineKeys = new Set(baselineWithBadJs.map(pairKey))
    const newPairs = stillBroken.filter((p) => !baselineKeys.has(pairKey(p)))
    if (!newPairs.some((p) => p.hookId === 'bad-js')) {
      ok('a baselined pair is not reported as NEW')
    } else {
      fail('baselined pair is not NEW', asBaseline(newPairs))
    }
    if (newPairs.some((p) => p.hookId === 'bad-py')) {
      ok('a pair NOT in the baseline is still reported as NEW')
    } else {
      fail('non-baselined pair is still NEW', asBaseline(newPairs))
    }

    const staleBaseline = [{ hookId: 'good-js', dep: 'scripts/lib/shared.mjs' }] // never broken
    const brokenKeysNow = new Set(stillBroken.map(pairKey))
    const stale = staleBaseline.filter((p) => !brokenKeysNow.has(pairKey(p)))
    if (stale.length === 1) ok('a stale broken-baseline entry (no longer reproduces) is flagged')
    else fail('stale broken-baseline entry is flagged', JSON.stringify(stale))

    // --- baseline ratchet behaviour (unverifiable) ----------------------
    const unverifiableNow = new Set(analyze(prekTomlPath).unverifiable.map((u) => u.hookId))
    const unverifiableBaselineWithTypesBased = new Set(['types-based'])
    const newUnverifiable = [...unverifiableNow].filter(
      (id) => !unverifiableBaselineWithTypesBased.has(id),
    )
    if (!newUnverifiable.includes('types-based')) {
      ok('a baselined unverifiable hook id is not reported as NEW')
    } else {
      fail('baselined unverifiable id is not NEW', JSON.stringify(newUnverifiable))
    }
    if (newUnverifiable.includes('ambiguous-wrapper')) {
      ok('an unverifiable hook id NOT in the baseline is still reported as NEW')
    } else {
      fail('non-baselined unverifiable id is still NEW', JSON.stringify(newUnverifiable))
    }
    const staleUnverifiableBaseline = ['good-js'] // never unverifiable
    const staleUnverifiable = staleUnverifiableBaseline.filter((id) => !unverifiableNow.has(id))
    if (staleUnverifiable.length === 1) {
      ok('a stale unverifiable-baseline entry (no longer unverifiable) is flagged')
    } else {
      fail('stale unverifiable-baseline entry is flagged', JSON.stringify(staleUnverifiable))
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  runCliSelfTest(ok, fail)
  runUpdateBaselineGrowthSelfTest(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(1)
  }
  console.log('self-test: all assertions passed')
}

/**
 * End-to-end CLI self-test: spawns THIS script as a real subprocess against
 * a fully synthetic fixture repo, and asserts on the actual process EXIT
 * CODE from `runGuard()`/`process.exit(runGuard())` -- never on `analyze()`
 * called in-process. #3997's own review: the reviewer replaced `runGuard`
 * with `return 0` and both `hook-deps` and `hook-deps-selftest` still
 * exited 0, because every assertion above drives `analyze()` directly and
 * none of them ever runs the CLI's own exit-code wiring. Mirrors
 * check-store-layering.mjs's runCliSelfTest (added for the same reason,
 * same #3997 PR) and check-lib-layering.mjs's before it.
 *
 * The fixture is nested INSIDE this repo's own `scripts/` directory (not
 * `os.tmpdir()`, unlike the two guards above) because this script imports a
 * real npm dependency (`smol-toml`) -- Node's ESM resolution for a bare
 * specifier walks up the IMPORTING FILE's ancestor directories looking for
 * `node_modules`, and only nesting the fixture under the real repo puts
 * this repo's `node_modules` on that walk. Always removed in `finally`.
 *
 * `finally` does not survive a hard kill (SIGKILL, an OOM reaper, a pulled
 * plug), which would strand an untracked `.hookdeps-cli-selftest-*` tree --
 * holding a `prek.toml` and copies of three guard scripts -- inside the
 * repo's own `scripts/`. So every run first SWEEPS whatever a previous one
 * left, and says how many it removed: stale debris becomes a visible,
 * self-healing event instead of an invisible one. The sweep assumes
 * self-test runs are not concurrent (prek runs one instance of a hook); a
 * concurrent manual run would lose its fixture and go RED, which is the
 * safe direction to fail.
 */
function runCliSelfTest(ok, fail) {
  const scriptsDir = resolve(REPO_ROOT, 'scripts')
  const stale = readdirSync(scriptsDir).filter((n) => n.startsWith(CLI_FIXTURE_PREFIX))
  for (const name of stale) rmSync(resolve(scriptsDir, name), { recursive: true, force: true })
  if (stale.length > 0) {
    console.log(
      `  (swept ${stale.length} stale CLI-fixture tree(s) from an interrupted run: ${stale.join(', ')})`,
    )
  }

  const fixtureRoot = mkdtempSync(resolve(scriptsDir, CLI_FIXTURE_PREFIX))
  try {
    const fixtureScripts = resolve(fixtureRoot, 'scripts')
    mkdirSync(fixtureScripts, { recursive: true })
    copyFileSync(import.meta.filename, resolve(fixtureScripts, 'check-hook-deps.mjs'))
    copyFileSync(
      resolve(import.meta.dirname, 'check-git-fixture-isolation.mjs'),
      resolve(fixtureScripts, 'check-git-fixture-isolation.mjs'),
    )
    mkdirSync(resolve(fixtureScripts, 'lib'), { recursive: true })
    copyFileSync(
      resolve(import.meta.dirname, 'lib', 'js-scanner.mjs'),
      resolve(fixtureScripts, 'lib', 'js-scanner.mjs'),
    )
    // check-git-fixture-isolation.mjs itself imports node: builtins only, so
    // no further copies are needed for it to load.

    const run = () =>
      execFileSync(process.execPath, [resolve(fixtureScripts, 'check-hook-deps.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })

    // Broken fixture: a hook whose files: misses a real dependency -> the
    // REAL CLI exits 1 (this is what actually blocks a bad PR).
    writeFileSync(resolve(fixtureScripts, 'shared.mjs'), 'export const helper = () => 1\n')
    writeFileSync(
      resolve(fixtureScripts, 'consumer.mjs'),
      "import { helper } from './shared.mjs'\nexport const x = helper()\n",
    )
    writeFileSync(
      resolve(fixtureRoot, 'prek.toml'),
      '[[repos]]\n' +
        'repo = "local"\n' +
        '[[repos.hooks]]\n' +
        'id = "consumer"\n' +
        'entry = "node scripts/consumer.mjs"\n' +
        'files = "^scripts/consumer\\\\.mjs$"\n',
    )
    let status = 0
    try {
      run()
    } catch (err) {
      status = err.status ?? 1
    }
    if (status === 1) ok('CLI exits 1 on a real broken pair (the gate actually blocks)')
    else fail('CLI exits 1 on a real broken pair', `status=${status}`)

    // Clean fixture: same script, but files: unions the dependency -> exits 0.
    writeFileSync(
      resolve(fixtureRoot, 'prek.toml'),
      '[[repos]]\n' +
        'repo = "local"\n' +
        '[[repos.hooks]]\n' +
        'id = "consumer"\n' +
        'entry = "node scripts/consumer.mjs"\n' +
        'files = "^scripts/(consumer|shared)\\\\.mjs$"\n',
    )
    status = 0
    try {
      run()
    } catch (err) {
      status = err.status ?? 1
    }
    if (status === 0) ok('CLI exits 0 on a clean tree')
    else fail('CLI exits 0 on a clean tree', `status=${status}`)

    // Malformed baseline: the guard must fail LEGIBLY, naming the file --
    // not throw an unhandled SyntaxError out of an always_run pre-commit
    // hook. Driven through the real CLI, not `readJsonArray` in process,
    // because `process.exit(1)` is the behaviour under test.
    writeFileSync(resolve(fixtureScripts, 'hook-deps-baseline.json'), '{ not json at all\n')
    let stderr = ''
    status = 0
    try {
      run()
    } catch (err) {
      status = err.status ?? 1
      stderr = String(err.stderr ?? '')
    }
    if (status === 1 && /hook-deps-baseline\.json/.test(stderr) && /not valid JSON/.test(stderr)) {
      ok('CLI fails legibly (exit 1, naming the file) on a malformed baseline')
    } else {
      fail('malformed baseline fails legibly', `status=${status} stderr=${stderr.slice(0, 300)}`)
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

/**
 * Self-test the `--update-baseline` growth gate against the PRODUCTION
 * `updateBaseline()` itself -- pointed at a fixture tree through its own
 * parameters, never a test-local copy of the refusal logic (see
 * `updateBaseline`'s doc comment for the defect that shape hid). Both the
 * files written and the RETURNED EXIT CODE are asserted, because the exit
 * code is what `process.exit(updateBaseline())` in `main` actually
 * propagates to the shell.
 */
function runUpdateBaselineGrowthSelfTest(ok, fail) {
  const tmp = mkdtempSync(join(os.tmpdir(), 'hook-deps-growth-selftest-'))
  try {
    buildInProcessFixture(tmp)
    const prekTomlPath = join(tmp, 'prek.toml')
    writeFileSync(prekTomlPath, inProcessFixtureToml())
    const baselinePath = join(tmp, 'baseline.json')
    const unverifiableBaselinePath = join(tmp, 'unverifiable-baseline.json')

    // No baseline on disk yet -> analyze() finds real broken pairs -> a
    // bare update (no --allow-growth) must REFUSE to write anything, and
    // must say so with a NON-ZERO exit code.
    const refusedCode = updateBaseline(tmp, baselinePath, unverifiableBaselinePath, false)
    if (!existsSync(baselinePath)) {
      ok('--update-baseline without --allow-growth refuses to write a GROWING baseline')
    } else {
      fail(
        '--update-baseline without --allow-growth refuses to grow',
        readFileSync(baselinePath, 'utf8'),
      )
    }
    if (refusedCode === 1) {
      ok('the refusal EXITS 1 (what `process.exit(updateBaseline())` propagates)')
    } else {
      fail('refusal exits 1', `code=${refusedCode}`)
    }

    // With --allow-growth, it writes, and exits 0.
    const grewCode = updateBaseline(tmp, baselinePath, unverifiableBaselinePath, true)
    if (existsSync(baselinePath)) {
      ok('--update-baseline --allow-growth writes the baseline')
    } else {
      fail('--update-baseline --allow-growth writes the baseline', 'no file written')
    }
    if (grewCode === 0) ok('an acknowledged growth exits 0')
    else fail('acknowledged growth exits 0', `code=${grewCode}`)

    // Re-running with the SAME tree and no growth (nothing new) must
    // succeed without needing --allow-growth (shrink/no-op is always fine).
    const before = readFileSync(baselinePath, 'utf8')
    const noopCode = updateBaseline(tmp, baselinePath, unverifiableBaselinePath, false)
    const after = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null
    if (after === before) {
      ok('--update-baseline without growth (no-op) succeeds without --allow-growth')
    } else {
      fail('no-op update-baseline succeeds without --allow-growth', String(after))
    }
    if (noopCode === 0) ok('a no-op update exits 0')
    else fail('no-op update exits 0', `code=${noopCode}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ─── main ───────────────────────────────────────────────────────────────

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
  } else if (process.argv.includes('--update-baseline')) {
    process.exit(updateBaseline())
  } else {
    process.exit(runGuard())
  }
}

export { analyze, resolveDeps }
