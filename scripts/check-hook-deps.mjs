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
 * or without trailing flags — and since #4439 also the `.cjs`/`.js`/`.ts`/
 * `.mts`/`.cts`/`.bash` spellings, which used to fall through as "not a
 * script" and be SKIPPED), whose own entry script EXISTS on disk, and
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
 *              A BARE specifier is classified POSITIVELY (#4439 note 3):
 *              a `node:` builtin, a bare builtin name, or a package this
 *              repo declares in `package.json` / has resolved in the
 *              COMMITTED `package-lock.json` is external and contributes
 *              nothing (#4466 note 2: this used to consult the local
 *              `node_modules/` directory instead, which made the verdict
 *              depend on whether `npm install` happened to have been run on
 *              THIS machine rather than on anything the repo commits);
 *              ANYTHING ELSE — notably a first-party path alias such as
 *              `@/lib/foo`, which no `imports` map makes resolvable under
 *              plain node and which is indistinguishable from `lodash/fp`
 *              without reading tsconfig/vite config — marks the hook
 *              UNVERIFIABLE instead of being discarded as third-party.
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
 *          PLAIN imports are resolved too since #4439 (note 2):
 *          `python3 scripts/x.py` puts `scripts/` on `sys.path[0]`, so
 *          `import <sibling>` / `from lib.x import y` really do load a
 *          file out of `scripts/` — they are dependency EDGES, where
 *          before they yielded neither an edge nor a marker. A name that
 *          matches no file under `scripts/` is stdlib or third-party, and
 *          that is knowledge rather than a guess (`sys.path[0]` is the
 *          only place a first-party one could come from). An explicit
 *          RELATIVE import, and `importlib.import_module(`/`__import__(`
 *          (a module named at run time), are UNVERIFIABLE.
 *        - A dependency whose extension NONE of the above can walk
 *          (`.ts`, say) is UNVERIFIABLE, not a silent closure leaf
 *          (#4439 notes 4/6). Only an explicit allow-list of DATA
 *          extensions (`.json`, `.toml`, …) ends a closure cleanly,
 *          because a data file has no imports of its own by
 *          construction; every other unanticipated extension fails
 *          closed.
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
 * being unverifiable). A third direction since #4439 (note 5): a baselined
 * pair that still reproduces but under a DIFFERENT `class` is RECLASSIFIED
 * — neither new nor stale, so both of the other two checks used to walk
 * past it while the baseline kept the wrong label and each label has a
 * different fix. `--update-baseline` refuses to WRITE a baseline that
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
import { builtinModules } from 'node:module'
import os from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import { blankPyDocstrings, stripLineComments } from './check-git-fixture-isolation.mjs'
import {
  blankStringsAndTemplates,
  ScanError,
  stripComments as stripJsComments,
} from './lib/js-scanner.mjs'

const __dirname = import.meta.dirname
const REPO_ROOT = resolve(__dirname, '..')
const BASELINE_PATH = resolve(__dirname, 'hook-deps-baseline.json')
const UNVERIFIABLE_BASELINE_PATH = resolve(__dirname, 'hook-deps-unverifiable-baseline.json')
// Prefix of the in-repo CLI self-test fixture tree (see runCliSelfTest).
//
// The leading dot is LOAD-BEARING, not cosmetic: `listGuardedScripts` in
// check-git-fixture-isolation.mjs skips dot-prefixed directories outright
// (`if (entry.name.startsWith('.')) continue`), so a concurrent run of that
// sibling guard never walks this fixture tree. Rename the prefix without the
// dot and that isolation breaks silently.
//
// Swept at start-up AND listed in .gitignore -- the two cover different
// failure modes, the sweep bounding a stranded tree's lifetime and the ignore
// rule stopping one that exists right now from riding along on a
// `git add -A`.
const CLI_FIXTURE_PREFIX = '.hookdeps-cli-selftest-'

// Extensions whose files are DATA rather than code: they carry no imports of
// their own, so a closure that ends at one has genuinely ended. Kept as an
// explicit ALLOW-LIST, never a deny-list of "extensions we know are bad":
// every extension NOT named here falls through to UNVERIFIABLE in
// `extractDirectDepsUncached`, so the next unanticipated one fails closed.
const INERT_DEP_EXT_RE = /\.(?:json|jsonc|txt|md|toml|ya?ml|lock)$/

// Exit code for a FAILED `--self-test`, matched to check-store-layering.mjs's
// (#4439 note 7). Distinct from `runGuard`'s 1 and from node's own crash code.
const SELF_TEST_FAILURE_EXIT = 2

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

// Extensions that make a `scripts/**` path a RUNNABLE SCRIPT at all. This is
// deliberately WIDER than the set this scan can walk (see
// `extractDirectDepsUncached`): #4439 note 1 found the two restricted to
// `mjs|py|sh`, so `entry = "node scripts/check-foo.js"` fell through to
// `{kind: 'none'}` and the hook was SKIPPED -- not reported UNVERIFIABLE,
// just silently dropped, in a guard whose whole premise is that input it does
// not recognise must never read as clean. The two halves of this file
// disagreed, too: `extractDirectDepsUncached` has always accepted `.js` as a
// DEPENDENCY. Recognising the path here and letting the extension decide
// afterwards is the classify-positively version: an entry naming a `.ts`
// script is now UNVERIFIABLE (this scan cannot walk it), and one naming a
// `.js`/`.cjs` script is scanned for real.
const SCRIPT_EXT_GROUP = '(?:mjs|cjs|js|mts|cts|ts|py|sh|bash)'
const ENTRY_SHAPE_RE = new RegExp(
  `^(node|python3|bash)\\s+(scripts/[\\w./-]+\\.${SCRIPT_EXT_GROUP})\\b`,
)
const ANY_SCRIPT_MENTION_RE = new RegExp(`scripts/[\\w./-]+\\.${SCRIPT_EXT_GROUP}`)

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

/**
 * Every package name this repo has POSITIVELY declared in `package.json`.
 * Memoised per repo root: `analyze` runs over ~180 hooks and `package.json`
 * does not change underneath a run (the CLI self-test rewrites its fixture,
 * but each of its runs is a fresh subprocess -- the same reasoning
 * `extractDirectDeps`'s cache relies on).
 *
 * @type {Map<string, Set<string>>}
 */
const declaredPackagesCache = new Map()

function declaredPackages(repoRoot) {
  const hit = declaredPackagesCache.get(repoRoot)
  if (hit) return hit
  const names = new Set()
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(pkg?.[field] ?? {})) names.add(name)
    }
  } catch {
    // No package.json, or an unreadable one. Not an error here: a repo with
    // no manifest simply declares nothing, and every bare specifier then
    // falls through to the UNVERIFIABLE branch below rather than to "fine".
  }
  declaredPackagesCache.set(repoRoot, names)
  return names
}

/**
 * Every package name the COMMITTED `package-lock.json` actually resolved --
 * at any nesting depth, so a hoisted transitive-only dependency (one this
 * repo imports directly but never lists in `package.json`, relying on some
 * other declared package to have pulled it in) is still recognised.
 *
 * #4466 note 2: this replaces an earlier `existsSync(node_modules/<pkg>)`
 * check. That read the FILESYSTEM, so the verdict depended on whether
 * `npm install` happened to have been run on the machine executing the
 * guard -- clean with deps installed, UNVERIFIABLE on a bare checkout of the
 * identical commit. It also fed a ratchet baseline that fails in BOTH
 * directions (a hook goes UNVERIFIABLE with no install, or a stale baseline
 * entry stops reproducing once one is), so which state a run landed in
 * depended on an ambient fact the guard never controlled. `package-lock.json`
 * is a file the repo commits and this guard already treats as authoritative
 * elsewhere in this file (`extractDirectDeps` et al. read `package.json`
 * itself, never the disk under `node_modules/`), so consulting it instead
 * makes the verdict a function of the checked-out tree, not of what a
 * previous `npm install` happened to leave lying around.
 *
 * npm's lockfileVersion 3 `packages` map keys every resolved package by its
 * install path (`node_modules/foo`, or nested as
 * `node_modules/foo/node_modules/bar` for a version conflict); taking
 * everything after the LAST `node_modules/` recovers the package name
 * (scoped names such as `@scope/name` contain no further `/node_modules/`,
 * so the split does not cut them). An older lockfileVersion 1 lockfile has
 * no `packages` map at all (only a `dependencies` tree this function does
 * not read) -- `lockfilePackages` itself warns LOUDLY when it sees that
 * shape (#4477 note 5) rather than returning the same empty `Set` a
 * genuinely-resolves-nothing lockfile would, which this repo's own
 * lockfileVersion 3 file can never trigger.
 *
 * @type {Map<string, Set<string>>}
 */
const lockfilePackagesCache = new Map()

function lockfilePackages(repoRoot) {
  const hit = lockfilePackagesCache.get(repoRoot)
  if (hit) return hit
  const names = new Set()
  try {
    const lockPath = resolve(repoRoot, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    // A lockfileVersion 1 (npm <= 6) or 2-without-packages lockfile has no
    // top-level `packages` map at all -- only the older nested `dependencies`
    // tree this function does not read. That makes `names` come back EMPTY,
    // same as "no lockfile" -- but unlike that case it is silent (#4477
    // note 5): the catch below's comment covers a MISSING or unparseable
    // lockfile, not a present, parseable, merely OLDER-SCHEMA one, and an
    // empty Set looks exactly like a legitimate "this lockfile resolved
    // nothing" answer. Say so loudly instead, once per repo root -- fail
    // CLOSED still (every hoisted transitive-only import still falls to
    // UNVERIFIABLE below), but not for a reason anyone reading the guard's
    // own output could otherwise tell apart from "nothing to see here".
    if (lock?.packages === undefined) {
      console.error(
        `WARNING: ${lockPath} has no top-level "packages" map (lockfileVersion ` +
          `${lock?.lockfileVersion ?? '<unset>'}, an npm <= 6 shape this guard does not read) ` +
          '-- every package that lockfile alone resolved (not declared directly in ' +
          'package.json) will read UNVERIFIABLE below for a reason that has nothing to do ' +
          'with any hook change. Regenerate it at lockfileVersion >= 2 (a plain `npm install` ' +
          'on a current npm does this) to fix this rather than working around it hook by hook.',
      )
    }
    for (const key of Object.keys(lock?.packages ?? {})) {
      const name = key.split('node_modules/').pop()
      if (name) names.add(name)
    }
  } catch {
    // No package-lock.json, or an unreadable/unparseable one. A repo with no
    // lockfile resolves nothing beyond package.json's own declarations, so
    // every remaining bare specifier falls through to UNVERIFIABLE below --
    // the same fail-closed direction `declaredPackages` takes.
  }
  lockfilePackagesCache.set(repoRoot, names)
  return names
}

/** `@scope/name/deep/path` -> `@scope/name`; `lodash/fp` -> `lodash`. */
function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Classify one JS import specifier.
 *
 * Returns a DISCRIMINATED result, never a bare `null` (#4439 note 3). The old
 * form returned `null` for ANYTHING not starting with `.` or `scripts/`, so a
 * FIRST-PARTY path alias -- `@/lib/foo`, the vite/tsconfig alias this repo
 * uses throughout `src/` -- was discarded as though it were an npm package.
 * That is the fail-open direction, and it is exactly the classify-positively
 * rule this file already applies to a dynamic `require(`/`import(` argument,
 * not applied here.
 *
 * The honest position (#4439's follow-up round): with no `imports` map and no
 * `exports` field in `package.json`, `@/lib/foo` and `lodash/fp` are
 * INDISTINGUISHABLE without reading tsconfig/vite config, which this scan
 * does not do. So the classification is positive on the two states that ARE
 * knowable -- a `node:` builtin (or a bare builtin name), and a package the
 * repo declares or the COMMITTED `package-lock.json` resolved -- and
 * everything else is UNVERIFIABLE.
 *
 * `package-lock.json`, not `node_modules/` on disk (#4466 note 2): both name
 * a package this scan did not have to guess at, but only the lockfile is
 * part of the checked-out tree. Consulting the filesystem instead made the
 * verdict for a hoisted transitive-only import depend on whether `npm
 * install` happened to have been run on the machine running the guard --
 * clean with deps installed, UNVERIFIABLE on a bare checkout of the exact
 * same commit -- and that ambient fact then fed a ratchet baseline that
 * fails in both the "new" and the "stale" direction depending on which way
 * the coin landed.
 *
 * @returns {{kind: 'dep', rel: string} | {kind: 'external'} | {kind: 'unresolvable', reason: string}}
 */
function classifyJsSpec(repoRoot, scriptRepoDir, spec) {
  if (spec.startsWith('.')) {
    return { kind: 'dep', rel: relative(repoRoot, resolve(repoRoot, scriptRepoDir, spec)) }
  }
  if (spec.startsWith('scripts/')) return { kind: 'dep', rel: spec }
  if (spec.startsWith('node:')) return { kind: 'external' }
  if (builtinModules.includes(spec)) return { kind: 'external' }
  const pkg = packageNameOf(spec)
  if (declaredPackages(repoRoot).has(pkg)) return { kind: 'external' }
  if (lockfilePackages(repoRoot).has(pkg)) return { kind: 'external' }
  return {
    kind: 'unresolvable',
    reason:
      `bare import specifier '${spec}' is neither a node: builtin nor a package this repo ` +
      `declares or has resolved ('${pkg}' is in no package.json dependency field and no ` +
      'package-lock.json entry) — it may be a first-party path alias (e.g. `@/lib/foo`), which ' +
      'this scan cannot tell from a third-party package without reading tsconfig/vite config',
  }
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
// A PLAIN import statement, at any indent: `import a.b`, `import a, b`,
// `from a.b import c`, `from . import c`. Group 1 is the `from` module (may
// be dotted or relative), group 2 the comma-separated `import` list.
const PY_PLAIN_IMPORT_RE = /^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import\b|import[ \t]+([\w.,\t ]+))/gm
// A DYNAMIC import by name. Both take a module NAME rather than a path, so
// neither is resolved here; their presence marks the hook unverifiable, the
// same treatment `sys.path`/`exec(` already get.
const PY_DYNAMIC_IMPORT_RE = /\b(?:importlib\.import_module|__import__)\s*\(/

/**
 * Resolve one PLAIN Python module name to a `scripts/**` path, if it names
 * one (#4439 note 2).
 *
 * `python3 scripts/x.py` puts `scripts/` on `sys.path[0]`, and
 * `classifyEntry` accepts no other Python entry shape — so a plain
 * `import <sibling>` or `from lib.x import y` in a hook's entry script
 * really does load a file out of `scripts/`, at runtime, today. Before this,
 * `extractPyDeps` resolved only `spec_from_file_location`, so such an import
 * produced neither a dependency edge NOR an unresolved marker: it read as
 * "no dependency here", the fail-open direction.
 *
 * The classification is POSITIVE, and soundly so rather than by convention:
 * `sys.path[0]` is `scripts/` (or, for a module loaded from a subdirectory,
 * that module's own directory), so a plain import can only ever resolve to a
 * file under one of those two roots or to a genuinely installed package. A
 * name that matches no file under `scripts/` is therefore KNOWN not to be a
 * first-party `scripts/**` dependency — that is knowledge, not a guess.
 *
 * An explicit RELATIVE import (`from . import x`) is the one shape that is
 * neither: it cannot work in a script run as `__main__` at all, so this scan
 * has no model for what it would load, and it is reported unresolved.
 *
 * @returns {{kind: 'dep', rel: string} | {kind: 'external'} | {kind: 'unresolvable', reason: string}}
 */
function resolvePyModule(repoRoot, scriptRepoDir, moduleName) {
  if (moduleName.startsWith('.')) {
    return {
      kind: 'unresolvable',
      reason:
        `explicit relative import '${moduleName}' in a script this guard models as run via ` +
        '`python3 scripts/<path>` (i.e. as __main__, where a relative import cannot resolve) — ' +
        'this scan has no model for what it loads',
    }
  }
  const asPath = moduleName.split('.').join('/')
  for (const base of new Set([scriptRepoDir, 'scripts'])) {
    for (const candidate of [`${base}/${asPath}.py`, `${base}/${asPath}/__init__.py`]) {
      const rel = relative(repoRoot, resolve(repoRoot, candidate))
      if (rel.startsWith('scripts/') && existsSync(resolve(repoRoot, rel))) {
        return { kind: 'dep', rel }
      }
    }
  }
  return { kind: 'external' } // stdlib or an installed third-party package
}

/**
 * Blank every triple-quoted Python string literal `blankPyDocstrings`
 * (check-git-fixture-isolation.mjs) left alone (#4466 note 3).
 *
 * `blankPyDocstrings` deliberately blanks ONLY a triple-quoted literal that
 * OPENS A STATEMENT — at the start of a line, indentation and string prefix
 * aside. That is the right rule for ITS consumer: `hasFixtureGitInit` must
 * still see `subprocess.run("""git init""")` as the real code it is, and
 * that file's own doc comment gives exactly that example. This scanner has
 * the opposite need: an `import`/`from` line found INSIDE ANY triple-quoted
 * string — say `TEMPLATE = """\n    import subprocess\n"""`, a fixture or
 * template constant, where `TEMPLATE = ` precedes the delimiter so the
 * line-start rule leaves it un-blanked — is not code the Python interpreter
 * executes as a statement no matter where in the file the string sits. (A
 * string later handed to `exec(`/`eval(` IS a run-time execution hazard —
 * that is a *different* gap, one `extractPyDeps` already reports as
 * UNVERIFIABLE via the `exec(`/`execfile(` marker below rather than papering
 * over it here.) Before this pass, `PY_PLAIN_IMPORT_RE` had no equivalent to
 * the "not a quoted string" check `extractPyDeps` already applies to a
 * `spec_from_file_location(` match (the `prev === "'"` guard below) — the
 * two halves of this same scanner disagreed about the identical hazard.
 *
 * Rather than widen `blankPyDocstrings` itself — which every OTHER consumer
 * of `stripLineComments('py')` relies on to keep non-docstring triple-quoted
 * code visible — this runs as a SEPARATE, LOCAL second pass, over text where
 * every docstring-shaped literal has already been blanked (delimiters
 * included). Anything still spelled `"""`/`'''` in that text therefore did
 * NOT open a statement, by construction, so unlike `blankPyDocstrings` there
 * is no per-literal "is this a docstring" distinction left to make — every
 * remaining pair is blanked unconditionally.
 *
 * Same two conservatisms as `blankPyDocstrings`, and for the same reasons
 * (see its doc comment): an UNTERMINATED literal ends the walk rather than
 * blanking to EOF, and an escaped delimiter inside a literal is not modelled.
 *
 * A THIRD, different-in-KIND gap (#4477-round-2 note 3): a `"""`/`'''`
 * substring sitting inside an ORDINARY quoted string — e.g. `X = '"""'` — is
 * not modelled either, and unlike the two conservatisms above, this one is
 * NOT conservative: it FAILS OPEN. Pass 1 (`blankPyDocstrings`) leaves such a
 * line visible (it does not open a statement, so a real `import` between two
 * such literals is still found); this unconditional pass instead pairs the
 * two embedded delimiters and blanks everything between them, taking that
 * real import with it — a MISSED dependency edge, the opposite direction
 * from every other gap in this file, which only ever risks reporting an edge
 * that is not really there. Not currently reachable (no `.py` file anywhere
 * under `scripts/` has this shape as of this writing); documented here,
 * rather than modelled, because doing so properly needs a real
 * string-literal lexer (quote-type and escape tracking), not a cheap regex
 * tweak.
 *
 * MUST run on `blankPyDocstrings`'s OUTPUT DIRECTLY — i.e. before
 * `stripLineComments`'s `#`-comment-LINE filter, not after it as an earlier
 * version of this pass did (#4477 note 4). That filter drops a whole line
 * matching `/^\s*#/` with no idea it might sit inside a still-open,
 * non-docstring triple-quoted literal — e.g. a line that is really the
 * TAIL of `OPEN = """`'s string, spelled `# """`, which also happens to
 * carry this scanner's own closing delimiter. Deleting that line does not
 * just lose a comment: it deletes the ONLY `"""` that this pass would have
 * paired as `OPEN`'s close, so the naive next-occurrence search below then
 * pairs `OPEN` with a wholly unrelated LATER `"""` instead — blanking every
 * real statement in between, imports included, as collateral. Running this
 * pass first means every delimiter `blankPyDocstrings` left untouched is
 * still exactly where the raw source put it when this pass pairs them, and
 * the comment-line filter only ever removes text this pass has already
 * turned into blank space or genuine non-code.
 */
function blankRemainingPyTripleQuoted(text) {
  const DELIM_RE = /"""|'''/g
  let out = ''
  let pos = 0
  for (;;) {
    DELIM_RE.lastIndex = pos
    const open = DELIM_RE.exec(text)
    if (open === null) {
      out += text.slice(pos)
      break
    }
    const close = text.indexOf(open[0], open.index + 3)
    if (close === -1) {
      out += text.slice(pos)
      break
    }
    const end = close + 3
    out += text.slice(pos, open.index)
    out += text.slice(open.index, end).replace(/[^\n]/g, ' ')
    pos = end
  }
  return out
}

/** The `#`-comment-only-LINE half of `stripLineComments(text, 'py')`, kept
 * as its own step so it can run AFTER `blankRemainingPyTripleQuoted` rather
 * than before (#4477 note 4 — see that function's doc comment for why the
 * order matters: this filter drops a whole line with no idea it might be
 * carrying a still-live triple-quote delimiter). `blankPyDocstrings` already
 * blanks (not deletes) every docstring-shaped literal by the time this runs,
 * so this is the ONLY line-shape check left to apply — identical regex to
 * `stripLineComments`'s own 'py'/'sh' branch. */
function stripHashCommentLines(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

/**
 * Extract Python `spec_from_file_location` dependencies, plus unresolved
 * markers for `sys.path.insert`/`append` (a plain `import` after a path
 * splice cannot be statically resolved to a file) and `exec(`/`execfile(`
 * (code run from a computed string is opaque to a static scan).
 *
 * Docstrings are blanked (`blankPyDocstrings`, check-git-fixture-
 * isolation.mjs, #3722/#4015), every OTHER triple-quoted literal is then
 * blanked too (`blankRemainingPyTripleQuoted`, #4466 note 3), and only THEN
 * are `#`-comment-only lines dropped (`stripHashCommentLines`) — that order,
 * not `stripLineComments(text, 'py')`'s combined one, is load-bearing
 * (#4477 note 4). Together this means a docstring or comment merely NAMING
 * `spec_from_file_location(` in prose is not mistaken for a real call — the
 * same protection #3997's review found missing for the "indented inside a
 * function" shape, which this fixes by not requiring a column-0 anchor at
 * all (the position just has to survive comment/docstring stripping) — and
 * a plain import sitting inside any triple-quoted string reads the same as
 * one sitting inside a docstring: not code.
 */
function extractPyDeps(rawText) {
  const stripped = stripHashCommentLines(blankRemainingPyTripleQuoted(blankPyDocstrings(rawText)))
  const specs = []
  const plainModules = []
  const unresolved = []

  PY_PLAIN_IMPORT_RE.lastIndex = 0
  let pm
  while ((pm = PY_PLAIN_IMPORT_RE.exec(stripped)) !== null) {
    if (pm[1] !== undefined) {
      plainModules.push(pm[1])
      continue
    }
    // `import a.b, c as d` -> the module names are the first token of each
    // comma-separated clause. `as` aliases and trailing whitespace are
    // dropped; a name that is not a dotted identifier is skipped rather than
    // guessed at (the regex cannot produce one, but the filter says so).
    for (const clause of (pm[2] ?? '').split(',')) {
      const name = clause.trim().split(/\s+/)[0]
      if (/^[\w.]+$/.test(name)) plainModules.push(name)
    }
  }
  if (PY_DYNAMIC_IMPORT_RE.test(stripped)) {
    unresolved.push(
      'importlib.import_module(/__import__( found — a module loaded by NAME at run time cannot ' +
        'be resolved to a file by this scan',
    )
  }

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
  return { specs, plainModules, unresolved }
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
 * Drop a TRAILING `#` comment from one shell line.
 *
 * `stripLineComments(text, 'sh')` only removes lines that are ENTIRELY a
 * comment, so `. "$DIR/lib/shared.sh" # superseded lib/legacy-helper.sh`
 * arrives here intact -- and `SH_FILENAME_RE` would then harvest
 * `legacy-helper.sh` out of the prose, guess `scripts/lib/legacy-helper.sh`
 * for it, find nothing there, and redden the hook. A commit failed by a
 * comment.
 *
 * A `#` opens a comment only at the start of a word (start of line, or
 * preceded by whitespace) and only OUTSIDE quotes -- `"a # b"` is data. The
 * quote tracking is what stops the cut from swallowing the rest of a real
 * statement; a naive first-`#` cut would fail closed here (the line would
 * lose every `.sh` name and read as "no literal filename" -> UNVERIFIABLE)
 * rather than fail open, but a spurious UNVERIFIABLE is still a hook nobody
 * can check. Backslash escapes are honoured; `$#` and `${#x}` are not
 * word-initial, so they are left alone by construction.
 */
function stripShTrailingComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') {
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Extract shell `.`/`source` dependencies (either keyword, mirroring
 * `sourcesSharedGuard`'s own recognised forms — #3997's review found only
 * the dot form was matched before), at ANY indent, naming a `.sh` file
 * anywhere in the statement — under `lib/`, or a sibling of the sourcing
 * script (#3997 review: "a shell dep not under lib/"). A TRAILING `#`
 * comment is removed first (`stripShTrailingComment`), so a filename that
 * appears only in prose is not mistaken for an edge. A source/dot
 * statement with no literal `.sh` filename anywhere (a fully dynamic
 * `. "$VAR"`) cannot be resolved and is reported unresolved rather than
 * silently dropped.
 */
function extractShDeps(rawText, repoRoot, scriptRepoDir) {
  const stripped = stripLineComments(rawText, 'sh')
  const specs = []
  const unresolved = []
  for (const rawLine of stripped.split('\n')) {
    // Trailing `#` comments first -- a filename named only in prose is not a
    // dependency (see stripShTrailingComment).
    const trimmed = stripShTrailingComment(rawLine.trim()).trim()
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

  if (scriptRel.endsWith('.mjs') || scriptRel.endsWith('.js') || scriptRel.endsWith('.cjs')) {
    let extracted
    try {
      extracted = extractJsDeps(text)
    } catch (err) {
      // `js-scanner.mjs` fails CLOSED: `stripComments` /
      // `blankStringsAndTemplates` THROW `ScanError` on an unterminated
      // literal or an ASI-ambiguous `/` rather than guess. Uncaught, that
      // aborts `hook-deps` -- an `always_run` hook, so EVERY commit -- with
      // a raw Node stack trace naming js-scanner internals and not the file
      // at fault: the same "what even is this error -> --no-verify" outcome
      // `readJsonArray`'s try/catch exists to prevent. A file this scan
      // cannot tokenise is exactly what UNVERIFIABLE means, so report it
      // that way (the hook still fails the guard until it is baselined --
      // this is not a silent skip) and name the file and the reason.
      // Caught broadly, not just `ScanError`: any other throw from the
      // tokenizer is equally un-actionable as a stack trace, and
      // UNVERIFIABLE fails closed too, so widening cannot fail open.
      const kind = err instanceof ScanError ? 'ScanError' : (err?.name ?? 'Error')
      return {
        deps: [],
        unresolved: [`${scriptRel} could not be tokenised (${kind}: ${err?.message})`],
      }
    }
    const { specs, unresolved } = extracted
    const deps = []
    for (const spec of specs) {
      const r = classifyJsSpec(repoRoot, scriptRepoDir, spec)
      // A specifier this scan cannot judge is REPORTED, never filtered away
      // as though it were third-party -- see classifyJsSpec's doc comment.
      if (r.kind === 'unresolvable') unresolved.push(r.reason)
      else if (r.kind === 'dep' && r.rel !== scriptRel) deps.push(r.rel)
    }
    return { deps, unresolved }
  }
  if (scriptRel.endsWith('.py')) {
    const { specs, plainModules, unresolved } = extractPyDeps(text)
    const deps = []
    for (const argText of specs) {
      const r = resolvePySpec(repoRoot, scriptRepoDir, argText)
      // A path expression this scan cannot resolve is reported, never
      // filtered away -- see resolvePySpec's doc comment.
      if (r.kind === 'unresolvable') unresolved.push(r.reason)
      else if (r.rel !== scriptRel) deps.push(r.rel)
    }
    for (const moduleName of plainModules) {
      const r = resolvePyModule(repoRoot, scriptRepoDir, moduleName)
      if (r.kind === 'unresolvable') unresolved.push(r.reason)
      else if (r.kind === 'dep' && r.rel !== scriptRel) deps.push(r.rel)
    }
    return { deps, unresolved }
  }
  if (scriptRel.endsWith('.sh')) {
    const { specs, unresolved } = extractShDeps(text, repoRoot, scriptRepoDir)
    return { deps: specs.filter((d) => d !== scriptRel), unresolved }
  }
  if (INERT_DEP_EXT_RE.test(scriptRel)) {
    // DATA, not code. A `.json` payload has no imports of its own BY
    // CONSTRUCTION, so "no further edges" here is knowledge rather than a
    // guess -- which is the whole difference this function's fall-through
    // below exists to make.
    return { deps: [], unresolved: [] }
  }
  // #4439 notes 4/6: everything else. The old unqualified
  // `return { deps: [], unresolved: [] }` made a dependency whose extension
  // this scan cannot walk a silent CLOSURE LEAF -- its own imports invisible,
  // reported as "no dependency here". Live example: `check-bundle-budget.mjs`
  // really does `import … from './vendor-chunk-groups.ts'` (Node type
  // stripping). The DIRECT edge to that `.ts` file was always caught
  // (`classifyJsSpec` is extension-agnostic for relative paths) and demanded
  // in `files:`; only its TRANSITIVE imports vanished. Unreachable today only
  // because no hook's `entry` is that script.
  return {
    deps: [],
    unresolved: [
      `${scriptRel} has no dependency scanner for its extension, so its own imports are ` +
        'invisible to this scan — that is "could not check", not "nothing to check"',
    ],
  }
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

/**
 * The hook's `files:` pattern as a RegExp, or `null` if it does not compile.
 *
 * Named (#4439 note 6) because `analyze` used to get this signal by calling
 * `hookFilesMatch(h, cls.scriptRel)` purely to look at whether the result was
 * `null`, and then call it a SECOND time for the same path inside the
 * `targets` loop. Two calls, two meanings, one of them not about matching at
 * all.
 */
function compileFilesRegex(h) {
  try {
    return new RegExp(h.files)
  } catch {
    return null
  }
}

/** `files:` match AND not removed again by `exclude:`, if the hook has one. */
function hookFilesMatch(h, targetPath) {
  const re = compileFilesRegex(h)
  if (re === null) return null // caller already reports a compile-error separately
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

    if (compileFilesRegex(h) === null) {
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

/**
 * A pair's IDENTITY. Deliberately excludes `class` -- growth is about which
 * (hook, dep) pairs are baselined at all, and a pair whose LABEL changed is
 * not a new deferral for a reviewer to approve.
 */
function pairKey(p) {
  return `${p.hookId}::${p.dep}`
}

/**
 * A pair's identity PLUS its class, used only to detect a baseline entry
 * whose label has gone stale (#4439 note 5).
 *
 * `pairKey` alone is what both ratchet directions used to compare, so a
 * baselined pair whose class flipped between `no-self-test` and
 * `missing-union` was neither NEW nor stale: the baseline silently kept the
 * old label, and `runGuard` never noticed. `--update-baseline` would have
 * rewritten it correctly (`writeBrokenBaseline` emits the CURRENT class), so
 * the staleness persisted exactly as long as nobody regenerated -- which is
 * the kind of silent drift the rest of this file is careful about. The
 * trigger is narrow (class derives from `t === cls.scriptRel`, so it can only
 * flip if the hook's `entry` changes to or from that dep path), which is why
 * this is its own third bucket rather than being folded into NEW/stale: a
 * relabelling is neither of those, and reporting it as both would be noise.
 *
 * `?? '<none>'` rather than `p.class`: a hand-edited baseline entry with NO
 * class field at all must also be reported, not compared as `undefined` and
 * quietly matched against nothing.
 */
function pairClassKey(p) {
  return `${pairKey(p)}::${p.class ?? '<none>'}`
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
  // Same pair, different label -- neither NEW nor stale, and invisible to
  // both of the checks above. See pairClassKey.
  const baselineClassKeys = new Set(baseline.map(pairClassKey))
  const reclassified = broken.filter(
    (p) => baselineKeys.has(pairKey(p)) && !baselineClassKeys.has(pairClassKey(p)),
  )

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
    reclassified.length === 0 &&
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
  if (reclassified.length > 0) {
    const classIn = new Map(baseline.map((p) => [pairKey(p), p.class ?? '<none>']))
    console.error(
      `FAIL: ${reclassified.length} baseline entr(y/ies) still reproduce but under a DIFFERENT ` +
        `class -- the pair is right, the label is stale, and each class has a different fix:`,
    )
    for (const p of reclassified) {
      console.error(
        `  - ${p.hookId} :: ${p.dep}: baseline says '${classIn.get(pairKey(p))}', now '${p.class}'`,
      )
    }
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

  // ── #4439 note 1: a `.js` entry script. `ENTRY_SHAPE_RE` used to accept
  // only `mjs|py|sh`, so this returned `{kind: 'none'}` and the hook was
  // SKIPPED -- while `extractDirectDepsUncached` had always accepted `.js` as
  // a DEPENDENCY. It must now be scanned like any other JS, i.e. its missing
  // union must be FLAGGED.
  writeFileSync(
    join(scriptsDir, 'js-entry.js'),
    "import { helper } from './lib/shared.mjs'\nexport const x = helper()\n",
  )
  // ...and a `.ts` entry: recognised as a script, but not walkable by this
  // scan, so UNVERIFIABLE rather than skipped.
  writeFileSync(join(scriptsDir, 'ts-entry.ts'), "import './lib/shared.mjs'\nexport const t = 1\n")

  // ── #4439 notes 4/6: a dependency whose extension this scan cannot walk.
  // The DIRECT edge is found (`classifyJsSpec` is extension-agnostic for
  // relative paths) and IS unioned into files: below, so nothing is broken --
  // what must still be reported is that the `.ts` file's OWN imports are
  // invisible. Live shape: check-bundle-budget.mjs imports
  // ./vendor-chunk-groups.ts under Node type-stripping.
  writeFileSync(
    join(scriptsDir, 'vendor-thing.ts'),
    "import './lib/shared.mjs'\nexport const v = 1\n",
  )
  writeFileSync(join(scriptsDir, 'ts-dep.mjs'), "import './vendor-thing.ts'\nexport const y = 1\n")
  // The converse, and the reason the fall-through is an ALLOW-LIST: a `.json`
  // dependency is DATA and has no imports of its own by construction, so the
  // closure genuinely ends there. Edge found and unioned; not unverifiable.
  writeFileSync(join(scriptsDir, 'data.json'), '{ "budget": 1 }\n')
  writeFileSync(
    join(scriptsDir, 'json-dep.mjs'),
    "import data from './data.json' with { type: 'json' }\nexport const d = data\n",
  )

  // ── #4439 note 3: a first-party PATH ALIAS. `resolveJsSpec` returned
  // `null` for anything not starting with `.` or `scripts/`, so `@/lib/foo`
  // was discarded as though it were an npm package. Indistinguishable from
  // `lodash/fp` without reading tsconfig/vite config -- which is precisely
  // why it must be UNVERIFIABLE rather than silently dropped.
  writeFileSync(
    join(scriptsDir, 'bare-alias.mjs'),
    "import { foo } from '@/lib/foo'\nexport const a = foo\n",
  )
  // ...and the positive half: a `node:` builtin, and a bare builtin name, are
  // KNOWN not to be first-party, so they are neither edges nor markers. Without
  // this case the rule above could be satisfied by calling everything
  // unverifiable.
  writeFileSync(
    join(scriptsDir, 'bare-builtin.mjs'),
    "import { readFileSync } from 'node:fs'\nimport { join } from 'path'\nexport const b = [readFileSync, join]\n",
  )

  // A dependency the shared tokenizer REFUSES to scan. `js-scanner.mjs`
  // fails CLOSED -- it throws `ScanError` rather than guess (here: an
  // ASI-ambiguous `/` after `i++` across a newline). The throw must be
  // caught and turned into an UNVERIFIABLE hook: `hook-deps` is
  // `always_run`, so an uncaught one aborts EVERY commit with a raw Node
  // stack trace, which is the "what even is this error -> --no-verify"
  // outcome `readJsonArray` was written to avoid. It sits one hop DOWN the
  // closure on purpose: the catch has to cover the whole recursion, not
  // just the entry script.
  writeFileSync(join(libDir, 'unscannable.mjs'), 'let i = 0\ni++\n/re/.test("x")\n')
  writeFileSync(
    join(scriptsDir, 'scan-throws.mjs'),
    "import './lib/unscannable.mjs'\nexport const w = 1\n",
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
  // ── #4439 note 2: PLAIN Python sibling imports. `python3 scripts/x.py`
  // puts `scripts/` on `sys.path[0]`, so both of these load a real file out
  // of `scripts/` at run time -- yet `extractPyDeps` resolved only
  // `spec_from_file_location`, so they produced neither an edge nor a marker
  // and read as "no dependency here".
  writeFileSync(join(scriptsDir, 'py_sibling.py'), 'def sibling():\n    return 1\n')
  writeFileSync(
    join(scriptsDir, 'py-plain-import.py'),
    'import py_sibling\n\n\ndef go():\n    return py_sibling.sibling()\n',
  )
  writeFileSync(
    join(scriptsDir, 'py-from-lib.py'),
    'from lib.shared_py import helper\n\n\ndef go():\n    return helper()\n',
  )
  // The positive half: stdlib / third-party names resolve to no file under
  // `scripts/`, which is KNOWLEDGE that they are not first-party (that is the
  // only place `sys.path[0]` can put one) -- so no edge and no marker. Without
  // this case, "mark every plain import unverifiable" would pass the two above.
  writeFileSync(
    join(scriptsDir, 'py-stdlib-import.py'),
    'import json\nfrom pathlib import Path\n\n\ndef go():\n    return json.dumps(str(Path(".")))\n',
  )
  // ...and the two plain-import shapes that genuinely cannot be resolved.
  writeFileSync(
    join(scriptsDir, 'py-relative-import.py'),
    'from . import py_sibling\n\n\ndef go():\n    return py_sibling\n',
  )
  writeFileSync(
    join(scriptsDir, 'py-import-module.py'),
    'import importlib\n\n\ndef go(name):\n    return importlib.import_module(name)\n',
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
  // #4466 note 3: an indented `import <sibling>` sitting inside a
  // NON-docstring triple-quoted string (a fixture/template constant, not a
  // module/function/class docstring -- the delimiter does not OPEN the
  // line, `TEMPLATE = ` does). `blankPyDocstrings` deliberately does not
  // blank this shape (see its doc comment: a triple-quoted literal that
  // does not open a statement is left as "the code it is", which
  // check-git-fixture-isolation.mjs's OWN scan needs). Without
  // `blankRemainingPyTripleQuoted`'s extra pass, `PY_PLAIN_IMPORT_RE` would
  // read the indented line inside the string as a real import of
  // `py_sibling` -- a real scripts/py_sibling.py -- producing a spurious
  // dependency edge from text that is never executed.
  writeFileSync(
    join(scriptsDir, 'py-string-import.py'),
    'TEMPLATE = """\n' +
      'Example usage:\n' +
      '    import py_sibling\n' +
      '    py_sibling.sibling()\n' +
      '"""\n' +
      'x = 1\n',
  )
  // #4477 note 4: a REAL import sitting between two non-docstring-shaped
  // `"""` delimiters, where the line carrying the SECOND delimiter of the
  // FIRST pair also happens to look like a whole-line `#` comment. Real
  // Python semantics: `OPEN`'s string opens on line 1 and closes on line 2
  // (the very next `"""`, wherever it is spelled), so `import py_sibling` on
  // line 3 is genuine code, not string content — `CLOSE = """` on line 4 is
  // a second, separately unterminated literal.
  //
  // `stripLineComments`'s `#`-comment-LINE filter has no idea line 2 is
  // carrying this scanner's own closing delimiter — it just sees a line
  // starting with `#` and deletes it whole. Doing that BEFORE
  // `blankRemainingPyTripleQuoted` runs erases the only "for" that pass
  // would have paired with line 1's `OPEN`, so its naive next-occurrence
  // search instead pairs `OPEN` with line 4's unrelated `CLOSE` delimiter —
  // blanking the real import in between as collateral: a missed dependency
  // edge (fail OPEN), not the fail-closed direction every other case in
  // this file takes. Running that pass on `blankPyDocstrings`'s output
  // directly, before the comment-line filter, is the fix.
  writeFileSync(
    join(scriptsDir, 'py-comment-line-collision.py'),
    'OPEN = """\n' + '# """\n' + 'import py_sibling\n' + 'CLOSE = """\n',
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
  // A TRAILING `#` comment on the source line. `stripLineComments(_, 'sh')`
  // only drops WHOLE-comment lines, so this text survives into `trimmed`,
  // and `SH_FILENAME_RE` harvests every `.sh` name on the line -- including
  // one that exists only in the prose. The `/lib/` branch then rewrites it
  // to a `scripts/lib/` path that does not exist, and the hook goes
  // UNVERIFIABLE: a red commit caused by a comment.
  writeFileSync(
    join(scriptsDir, 'trailing-comment.sh'),
    '#!/usr/bin/env bash\n' +
      '. "$(dirname "$0")/lib/shared.sh" # superseded lib/legacy-helper.sh\n',
  )
  // ...and the converse: a `#` that is INSIDE quotes is not a comment, so
  // truncating at it would throw away the rest of the statement. On a
  // `.`/`source` line the sourced path is the first word, so the only shape
  // that can put a quoted `#` AHEAD of the filename is a parameter-expansion
  // default inside the path itself -- contrived, but it is the shape that
  // pins the property, and a naive first-`#` cut turns this line into
  // "no literal .sh filename" (UNVERIFIABLE) instead of a resolved edge.
  writeFileSync(
    join(scriptsDir, 'quoted-hash-source.sh'),
    '#!/usr/bin/env bash\n' + '. "${DIR:-\' # default\'}/lib/shared.sh"\n',
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
id = "scan-throws-js"
entry = "node scripts/scan-throws.mjs"
files = "^scripts/scan-throws\\\\.mjs$"

[[repos.hooks]]
id = "js-entry"
entry = "node scripts/js-entry.js"
files = "^scripts/js-entry\\\\.js$"

[[repos.hooks]]
id = "ts-entry"
entry = "node scripts/ts-entry.ts"
files = "^scripts/ts-entry\\\\.ts$"

[[repos.hooks]]
id = "ts-dep-js"
entry = "node scripts/ts-dep.mjs"
files = "^scripts/(ts-dep\\\\.mjs|vendor-thing\\\\.ts)$"

[[repos.hooks]]
id = "json-dep-js"
entry = "node scripts/json-dep.mjs"
files = "^scripts/(json-dep\\\\.mjs|data\\\\.json)$"

[[repos.hooks]]
id = "bare-alias-js"
entry = "node scripts/bare-alias.mjs"
files = "^scripts/bare-alias\\\\.mjs$"

[[repos.hooks]]
id = "bare-builtin-js"
entry = "node scripts/bare-builtin.mjs"
files = "^scripts/bare-builtin\\\\.mjs$"

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
id = "py-plain-import"
entry = "python3 scripts/py-plain-import.py"
files = "^scripts/py-plain-import\\\\.py$"

[[repos.hooks]]
id = "py-from-lib"
entry = "python3 scripts/py-from-lib.py"
files = "^scripts/py-from-lib\\\\.py$"

[[repos.hooks]]
id = "py-stdlib-import"
entry = "python3 scripts/py-stdlib-import.py"
files = "^scripts/py-stdlib-import\\\\.py$"

[[repos.hooks]]
id = "py-relative-import"
entry = "python3 scripts/py-relative-import.py"
files = "^scripts/py-relative-import\\\\.py$"

[[repos.hooks]]
id = "py-import-module"
entry = "python3 scripts/py-import-module.py"
files = "^scripts/py-import-module\\\\.py$"

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
id = "py-string-import"
entry = "python3 scripts/py-string-import.py"
files = "^scripts/py-string-import\\\\.py$"

[[repos.hooks]]
id = "py-comment-line-collision"
entry = "python3 scripts/py-comment-line-collision.py"
files = "^scripts/py-comment-line-collision\\\\.py$"

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
id = "trailing-comment-sh"
entry = "bash scripts/trailing-comment.sh"
files = "^scripts/trailing-comment\\\\.sh$"

[[repos.hooks]]
id = "quoted-hash-source-sh"
entry = "bash scripts/quoted-hash-source.sh"
files = "^scripts/quoted-hash-source\\\\.sh$"

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

    if (unverifiableIds.has('scan-throws-js')) {
      ok('a dependency the tokenizer refuses to scan is UNVERIFIABLE, not an uncaught throw')
    } else {
      fail('unscannable dependency is unverifiable', JSON.stringify(unverifiable))
    }

    runClassificationCases(ok, fail, {
      broken,
      unverifiable,
      brokenIds,
      brokenPairs,
      unverifiableIds,
    })

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

    // #4466 note 3: the two halves of this scanner used to disagree about
    // the same hazard -- PY_SPEC_CALL_RE refuses a call written out as a
    // quoted string literal, PY_PLAIN_IMPORT_RE had no equivalent, so an
    // indented `import <sibling>` sitting inside a non-docstring
    // triple-quoted fixture string read as a real dependency edge.
    if (!brokenIds.has('py-string-import') && !unverifiableIds.has('py-string-import')) {
      ok(
        'a plain import sitting inside a non-docstring string literal is not a false edge (note 3)',
      )
    } else {
      fail(
        'string-literal import is not a false positive',
        JSON.stringify({ broken, unverifiable }),
      )
    }

    // #4477 note 4: a real import between two non-docstring `"""` pairs,
    // where the first pair's closing delimiter sits on a line that ALSO
    // looks like a whole-line `#` comment. Filtering comment lines before
    // (rather than after) `blankRemainingPyTripleQuoted` runs deletes that
    // delimiter, so the pass mis-pairs `OPEN` with the unrelated later
    // `CLOSE` and blanks the real import as collateral -- a MISSED
    // dependency edge (fail-open), the opposite direction from every other
    // case here. This must be FLAGGED (the edge found, `files:` doesn't
    // cover it), not silently clean.
    if (brokenPairs.has('py-comment-line-collision::scripts/py_sibling.py')) {
      ok('a real import next to a comment-shaped delimiter line is still found (note 4)')
    } else {
      fail(
        'comment-shaped delimiter line does not hide a real import',
        JSON.stringify({ broken, unverifiable }),
      )
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

    if (
      !unverifiableIds.has('trailing-comment-sh') &&
      brokenPairs.has('trailing-comment-sh::scripts/lib/shared.sh')
    ) {
      ok('a .sh name that appears only in a TRAILING # comment does not redden the hook')
    } else {
      fail(
        'trailing shell comment is not harvested as a dependency',
        JSON.stringify({ broken, unverifiable }),
      )
    }

    if (
      !unverifiableIds.has('quoted-hash-source-sh') &&
      brokenPairs.has('quoted-hash-source-sh::scripts/lib/shared.sh')
    ) {
      ok('a `#` inside quotes is NOT a comment, so the rest of the statement is still scanned')
    } else {
      fail(
        'quoted # does not truncate the source statement',
        JSON.stringify({ broken, unverifiable }),
      )
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

    // #4439 note 5: a baselined pair whose CLASS flipped is neither NEW nor
    // stale, so both checks above walk straight past it and the baseline
    // keeps the wrong label. Driven through the same `pairKey` / `pairClassKey`
    // pair `runGuard` uses, so a regression there is what this catches.
    const relabelled = broken
      .filter((p) => p.hookId === 'bad-js')
      .map((p) => ({
        hookId: p.hookId,
        dep: p.dep,
        files: p.files,
        class: p.class === 'missing-union' ? 'no-self-test' : 'missing-union',
      }))
    const relabelledIdKeys = new Set(relabelled.map(pairKey))
    const relabelledClassKeys = new Set(relabelled.map(pairClassKey))
    const reclassified = stillBroken.filter(
      (p) => relabelledIdKeys.has(pairKey(p)) && !relabelledClassKeys.has(pairClassKey(p)),
    )
    if (reclassified.length === 1 && reclassified[0].hookId === 'bad-js') {
      ok('a baselined pair whose class flipped is reported as RECLASSIFIED (neither NEW nor stale)')
    } else {
      fail('class flip on a baselined pair is reported', JSON.stringify(reclassified))
    }
    // ...and the same computation must NOT fire when the class still agrees,
    // or "reclassified" would just be a second name for "baselined".
    const agreeingIdKeys = new Set(baselineWithBadJs.map(pairKey))
    const agreeingClassKeys = new Set(baselineWithBadJs.map(pairClassKey))
    const notReclassified = stillBroken.filter(
      (p) => agreeingIdKeys.has(pairKey(p)) && !agreeingClassKeys.has(pairClassKey(p)),
    )
    if (notReclassified.length === 0) {
      ok('a baselined pair whose class still agrees is NOT reported as reclassified')
    } else {
      fail('unchanged class is not reclassified', JSON.stringify(notReclassified))
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
  runLockfileSchemaSelfTest(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    // 2, not 1 (#4439 note 7): `check-store-layering.mjs`'s self-test -- this
    // one's sibling, added in the same PR -- has always exited 2, and both
    // being non-zero satisfied prek while leaving a reader to wonder whether
    // the difference meant something. It did not. 2 also keeps a self-test
    // failure distinguishable from a GUARD failure (`runGuard` returns 1) and
    // from node's own crash code, which is 1 as well.
    process.exit(SELF_TEST_FAILURE_EXIT)
  }
  console.log('self-test: all assertions passed')
}

/**
 * The #4439 classification cases: every place where an input this scan does
 * not recognise must read as UNVERIFIABLE rather than as "no dependency
 * here", plus the positive counterpart of each (a `node:` builtin, a stdlib
 * python import, a `.json` data leaf) that stops the rule being satisfied by
 * calling everything unverifiable.
 *
 * Its own function purely so eslint counts its branches separately from
 * `runSelfTest`'s — the same reason `runCliSelfTest` and
 * `runUpdateBaselineGrowthSelfTest` are split out below.
 *
 * @param {(name: string) => void} ok
 * @param {(name: string, detail: string) => void} fail
 */
function runClassificationCases(
  ok,
  fail,
  { broken, unverifiable, brokenIds, brokenPairs, unverifiableIds },
) {
  // ── #4439 note 1: a `.js` entry is SCANNED, not skipped ─────────────
  if (brokenPairs.has('js-entry::scripts/lib/shared.mjs')) {
    ok('a `.js` entry script is scanned like any other JS, not silently skipped (note 1)')
  } else {
    fail('.js entry script is scanned', JSON.stringify({ broken, unverifiable }))
  }
  if (unverifiableIds.has('ts-entry')) {
    ok('a `.ts` entry script is UNVERIFIABLE (recognised, not walkable), not skipped (note 1)')
  } else {
    fail('.ts entry script is unverifiable', JSON.stringify({ broken, unverifiable }))
  }

  // ── #4439 notes 4/6: a non-walkable DEPENDENCY is not a silent leaf ──
  if (unverifiableIds.has('ts-dep-js') && !brokenIds.has('ts-dep-js')) {
    ok('a `.ts` dependency is unioned AND its own invisible imports make the hook UNVERIFIABLE')
  } else {
    fail('non-walkable dep is unverifiable', JSON.stringify({ broken, unverifiable }))
  }
  if (!unverifiableIds.has('json-dep-js') && !brokenIds.has('json-dep-js')) {
    ok('a `.json` dependency is an INERT leaf — the closure really does end there, not "unknown"')
  } else {
    fail('json dep is an inert leaf', JSON.stringify({ broken, unverifiable }))
  }

  // ── #4439 note 3: a bare specifier this scan cannot classify ─────────
  if (unverifiableIds.has('bare-alias-js')) {
    ok('a first-party-looking path alias is UNVERIFIABLE, not discarded as third-party (note 3)')
  } else {
    fail('path alias is unverifiable', JSON.stringify({ broken, unverifiable }))
  }
  if (!unverifiableIds.has('bare-builtin-js') && !brokenIds.has('bare-builtin-js')) {
    ok('a node: builtin (and a bare builtin name) is positively external — no edge, no marker')
  } else {
    fail('builtin specifiers stay clean', JSON.stringify({ broken, unverifiable }))
  }

  // ── #4439 note 2: plain Python sibling imports ───────────────────────
  if (brokenPairs.has('py-plain-import::scripts/py_sibling.py')) {
    ok('a plain `import <sibling>` is a real dependency edge, not "no dependency here" (note 2)')
  } else {
    fail('plain python sibling import is an edge', JSON.stringify({ broken, unverifiable }))
  }
  if (brokenPairs.has('py-from-lib::scripts/lib/shared_py.py')) {
    ok('a plain `from lib.x import y` is a real dependency edge (note 2)')
  } else {
    fail('plain python package import is an edge', JSON.stringify({ broken, unverifiable }))
  }
  if (!brokenIds.has('py-stdlib-import') && !unverifiableIds.has('py-stdlib-import')) {
    ok('a stdlib/third-party plain import is positively external — no edge, no marker')
  } else {
    fail('stdlib python import stays clean', JSON.stringify({ broken, unverifiable }))
  }
  if (unverifiableIds.has('py-relative-import')) {
    ok('an explicit relative python import is UNVERIFIABLE (no model for what it loads)')
  } else {
    fail('relative python import is unverifiable', JSON.stringify({ broken, unverifiable }))
  }
  if (unverifiableIds.has('py-import-module')) {
    ok('importlib.import_module(/__import__( is UNVERIFIABLE, not silently clean')
  } else {
    fail('dynamic python import is unverifiable', JSON.stringify({ broken, unverifiable }))
  }
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

/**
 * #4477 note 5: `lockfilePackages` must warn LOUDLY when the committed
 * `package-lock.json` has no top-level `packages` map (lockfileVersion 1,
 * npm <= 6) instead of silently returning the same empty `Set` a lockfile
 * that genuinely resolves nothing would produce. Two fixtures, each its own
 * `repoRoot` so `lockfilePackagesCache` cannot leak a verdict from one into
 * the other: an OLDER-schema lockfile must warn, this repo's own
 * lockfileVersion 3 shape must not.
 */
function runLockfileSchemaSelfTest(ok, fail) {
  const buildMinimalBareImportFixture = (tmp) => {
    const scriptsDir = join(tmp, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(
      join(scriptsDir, 'bare-import.mjs'),
      "import { thing } from 'totally-unresolvable-pkg'\nexport const x = thing\n",
    )
    writeFileSync(
      join(tmp, 'prek.toml'),
      '\n[[repos]]\nrepo = "local"\n[[repos.hooks]]\n' +
        'id = "bare-import"\n' +
        'entry = "node scripts/bare-import.mjs"\n' +
        'files = "^scripts/bare-import\\\\.mjs$"\n',
    )
  }

  const runCapturingStderr = (prekTomlPath) => {
    const lines = []
    const origError = console.error
    console.error = (...args) => lines.push(args.map(String).join(' '))
    try {
      analyze(prekTomlPath)
    } finally {
      console.error = origError
    }
    return lines
  }

  const oldSchemaTmp = mkdtempSync(join(os.tmpdir(), 'hook-deps-lockschema-old-'))
  const newSchemaTmp = mkdtempSync(join(os.tmpdir(), 'hook-deps-lockschema-new-'))
  try {
    buildMinimalBareImportFixture(oldSchemaTmp)
    writeFileSync(
      join(oldSchemaTmp, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        lockfileVersion: 1,
        dependencies: { 'totally-unresolvable-pkg': { version: '1.0.0' } },
      }),
    )
    const oldSchemaStderr = runCapturingStderr(join(oldSchemaTmp, 'prek.toml'))
    if (oldSchemaStderr.some((line) => line.includes('no top-level "packages" map'))) {
      ok('a lockfileVersion 1 lockfile (no "packages" map) warns loudly, not silently (note 5)')
    } else {
      fail('older lockfile schema warns loudly', JSON.stringify(oldSchemaStderr))
    }

    buildMinimalBareImportFixture(newSchemaTmp)
    writeFileSync(
      join(newSchemaTmp, 'package-lock.json'),
      JSON.stringify({
        name: 'fixture',
        lockfileVersion: 3,
        packages: { 'node_modules/totally-unresolvable-pkg': { version: '1.0.0' } },
      }),
    )
    const newSchemaStderr = runCapturingStderr(join(newSchemaTmp, 'prek.toml'))
    if (!newSchemaStderr.some((line) => line.includes('no top-level "packages" map'))) {
      ok('a lockfileVersion 3 lockfile (has "packages") does not false-positive the warning')
    } else {
      fail('lockfileVersion 3 lockfile does not warn', JSON.stringify(newSchemaStderr))
    }
  } finally {
    rmSync(oldSchemaTmp, { recursive: true, force: true })
    rmSync(newSchemaTmp, { recursive: true, force: true })
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
