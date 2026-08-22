#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// `src/types/` must stay type-only (#4226).
//
// `check-lib-layering.mjs` (#3121) deliberately excludes `src/types/**`
// from its tier scan: anything routed there is erased at compile time, so
// importing it can never invert a runtime dependency. That premise only
// holds while every file under `src/types/` stays type-only, and nothing
// enforced it — a future PR could add a real runtime export (a const
// object, an enum, a helper function) as a quick way to make a layering
// complaint go away, and the layering guard would neither flag the file
// nor notice it exists. The #4006 burndown made this worse in the same
// commit that documented it: it established "move the type into
// `src/types/`" as the standard fix for a type-only edge, widening the
// escape hatch it was warning about.
//
// ─── Why this guard, and not the issue's "fold into the tier scan" option ──
//
// #4226 offered two options: (1) a guard asserting every export under
// `src/types/` is type-only, or (2) give `src/types/` rank -1 in
// `check-lib-layering.mjs`'s tier scan, below `lib/`, so an ordinary
// upward IMPORT from `src/types/` becomes an ordinary violation with no
// special case to remember.
//
// Option 2 was the issue's stated recommendation, but a tier scan only
// detects bad IMPORTS — it walks a file's import specifiers and checks
// their target tier. The threat here is a bad EXPORT: a self-contained
// runtime value (the realistic shape is a const object) that imports
// NOTHING at all. Give such a file rank -1 and scan it for upward
// imports and it reports clean, because it has no imports to flag — the
// runtime leak sails through untouched. Rank -1 alone is therefore
// insufficient for the stated threat and is not implemented here: it
// would add scanning cost and a second thing to keep in sync with zero
// additional coverage, since the rule below (every export is
// `type`/`interface`/ambient) already forbids a runtime value from
// living in `src/types/` at all — regardless of whether it imports
// anything upward, downward, or nothing. A file that cannot export a
// runtime value cannot leak one through an upward import either, so this
// guard alone closes the door #4226 opened; folding `src/types/` into
// the tier scan on top of it would be pure redundancy.
//
// ─── What counts as type-only ──────────────────────────────────────────
//
// An export is SAFE only when it is one of:
//   - `export type ...`            (alias, or `export type { … } from …`,
//                                    or `export type * from …`)
//   - `export interface ...`
//   - `export declare ...`         (ambient — ᴺᴼ runtime code is emitted
//                                    for a `declare` statement, in or out
//                                    of a `.d.ts` file)
//   - `export { type Foo, type Bar as Baz }`  — EVERY specifier in the
//     brace list must carry its own explicit `type` modifier; a single
//     bare specifier (`export { Foo }`, `export { Foo } from './x'`)
//     cannot be proven type-only from syntax alone and is flagged.
//
// Everything else — `export const`/`let`/`var`, `export function`,
// `export class`, `export enum` (regular OR `const enum`), `export
// default`, `export namespace`/`module`, `export * from './x'` (re-
// exports everything, unprovable), and any export shape this guard does
// not recognise — is a violation. Fail CLOSED: an unrecognised export
// shape is treated as a possible runtime leak, not waved through.
//
// `.d.ts` files are excluded from the scan entirely (mirroring every
// sibling guard's `listSourceFiles`) because TypeScript's own grammar
// forbids a value INITIALIZER in an ambient declaration file — a `.d.ts`
// cannot emit runtime code no matter what it contains, so there is
// nothing here for this guard to check.
//
// ─── Detection ──────────────────────────────────────────────────────
//
// Uses the shared lexical scanner (`scripts/lib/js-scanner.mjs`) — the
// sanctioned implementation per #3950/#3991, not a hand-rolled
// comment/string stripper. Comments are stripped, string/template
// contents are blanked (so export-shaped text inside a string or
// template literal in value position is never mistaken for a real
// export statement), and the token immediately after each top-level
// `export` keyword drives the classification above. A file the shared
// scanner cannot lex unambiguously (`ScanError`) is a FAILURE, not a
// silent skip.
//
// ─── No baseline ────────────────────────────────────────────────────
//
// Unlike `check-lib-layering.mjs`, this is not a ratchet: `src/types/`
// is required to be type-only at ALL times, so the population this
// guard tolerates is always exactly zero. As of #4226 the tree already
// has zero violations (the three files the #4006 burndown moved here —
// `view.ts`, `editor-surface.ts`, `search-sheet-mode.ts` — were verified
// at the time to be plain `interface`/type-alias declarations), so no
// grandfather list is needed. If this guard is ever red against real
// code, the fix is to move the runtime value OUT of `src/types/` (back
// to whichever tier it belongs in) — there is no `--update-baseline`
// escape hatch, by design: baselining a runtime-value leak here would be
// re-opening the exact hole #4226 closed.
//
// ─── Scope ─────────────────────────────────────────────────────────────
//
// Scans `src/types/**/*.ts` / `*.tsx`, excluding test files
// (`*.test.ts[x]`, `__tests__/`, `tests/` directories) and `.d.ts`.
//
// Usage: node scripts/check-types-erasure.mjs
//        node scripts/check-types-erasure.mjs --self-test
// Exit:  0 = clean, 1 = at least one non-type-only export (or an
//        unlexable file), 2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ScanError,
  blankStringsAndTemplates,
  findMatchingBracket,
  splitTopLevelCommas,
  stripComments,
  tokenize,
} from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const TYPES_DIR = path.join(SRC_DIR, 'types')

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/types/**` for `.ts`/`.tsx` files, excluding test files and
 * `__tests__`/`tests` directories, and `.d.ts` (see the header — a `.d.ts`
 * cannot emit runtime code regardless of content). Mirrors
 * `check-lib-layering.mjs`'s `listSourceFiles`, scoped to one directory.
 */
function listSourceFiles(dir = TYPES_DIR) {
  const out = []
  const visit = (d) => {
    if (!fs.existsSync(d)) return
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
        visit(full)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full)
      }
    }
  }
  visit(dir)
  return out
}

/** Identifier keywords that, as the token right after `export`, are ALWAYS type-only. */
const SAFE_LEAD = new Set(['type', 'interface', 'declare'])
/** Identifier keywords that, as the token right after `export`, are ALWAYS a runtime value. */
const RUNTIME_LEAD = new Set([
  'const',
  'let',
  'var',
  'function',
  'class',
  'enum',
  'abstract',
  'async',
])

/**
 * Scan one file's source for `export` statements that are not provably
 * type-only. Returns `{ hits, scanError }` where `hits` is
 * `[{ line, detail }]` (1-based line, human-readable reason) and
 * `scanError` is set (with `hits: []`) when the shared scanner could not
 * lex the file unambiguously.
 *
 * @param {string} rawSrc
 */
export function analyzeSource(rawSrc) {
  try {
    // Comments stripped (whitespace-preserving); strings/templates then
    // blanked in a SEPARATE view used only to LOCATE the `export`
    // keyword, so export-shaped text living inside a string/template
    // literal is never mistaken for a real statement. Structural lookups
    // (matching braces, splitting specifiers) read from `src` — comments
    // stripped, strings intact — at the SAME offsets, since both
    // transforms are length- and newline-preserving.
    const src = stripComments(rawSrc)
    const search = blankStringsAndTemplates(src)
    const tokens = [...tokenize(search)].filter((t) => t.kind !== 'ws')
    const hits = []

    const lineOf = (offset) => src.slice(0, offset).split('\n').length

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok.kind !== 'ident' || tok.value !== 'export' || tok.propertyName === true) continue

      const next = tokens[i + 1]
      const next2 = tokens[i + 2]

      if (!next) {
        hits.push({ line: lineOf(tok.start), detail: "'export' with nothing following it" })
        continue
      }

      // `export type ...` / `export interface ...` / `export declare ...`
      // — always type-only (a `declare` statement emits no runtime code).
      if (next.kind === 'ident' && SAFE_LEAD.has(next.value)) continue

      // `export { … }` [`from '…'`] — safe only if EVERY specifier in the
      // brace list carries its own `type` modifier.
      if (next.kind === 'punct' && next.value === '{') {
        const closeIdx = findMatchingBracket(src, next.start)
        if (closeIdx === -1) {
          hits.push({ line: lineOf(tok.start), detail: 'export { … } with an unbalanced brace' })
          continue
        }
        const specs = splitTopLevelCommas(src.slice(next.start + 1, closeIdx))
        // `/^type\b/` alone is a hole: a specifier whose ENTIRE text is
        // `type` is TS's *value* export of a binding named `type`
        // (`const type = {…}; export { type }`), not a type-only export —
        // and that is precisely the leak this guard exists to stop. Require
        // something to follow the modifier.
        const untyped = specs.filter((s) => !/^type\s+\S/.test(s.trim()))
        if (untyped.length > 0) {
          hits.push({
            line: lineOf(tok.start),
            detail: `export { ${untyped.join(', ')} } — missing an explicit 'type' modifier, cannot prove type-only`,
          })
        }
        continue
      }

      // `export * from '…'` / `export * as X from '…'` — re-exports
      // everything from the target module; unprovable without resolving
      // and recursively checking that module, which this guard does not do.
      if (next.kind === 'punct' && next.value === '*') {
        hits.push({
          line: lineOf(tok.start),
          detail: "export * from '…' re-exports everything — cannot prove type-only",
        })
        continue
      }

      if (next.kind === 'ident' && next.value === 'default') {
        hits.push({ line: lineOf(tok.start), detail: 'export default is always a runtime value' })
        continue
      }

      if (next.kind === 'ident' && (next.value === 'namespace' || next.value === 'module')) {
        hits.push({
          line: lineOf(tok.start),
          detail: `export ${next.value} … may contain runtime values`,
        })
        continue
      }

      if (next.kind === 'ident' && RUNTIME_LEAD.has(next.value)) {
        const isConstEnum =
          (next.value === 'const' || next.value === 'let' || next.value === 'var') &&
          next2?.kind === 'ident' &&
          next2.value === 'enum'
        hits.push({
          line: lineOf(tok.start),
          detail: isConstEnum
            ? `export ${next.value} enum … is a runtime value`
            : `export ${next.value} … is a runtime value`,
        })
        continue
      }

      // Fail CLOSED: an export shape this guard does not recognise is
      // treated as a possible runtime leak, not waved through.
      hits.push({
        line: lineOf(tok.start),
        detail: `unrecognised export form starting with '${next.value ?? next.kind}' — cannot prove type-only`,
      })
    }

    return { hits, scanError: null }
  } catch (err) {
    if (!(err instanceof ScanError)) throw err
    return { hits: [], scanError: err }
  }
}

/**
 * Compute every non-type-only export across `src/types/**`. Pure over the
 * filesystem so the self-test can drive it against a synthetic tree.
 *
 * @returns {{ offenders: string[], details: Map<string, string[]>,
 *   scanErrors: {file: string, message: string}[], scanned: number }}
 */
export function analyze({ root, typesDir }) {
  const offenders = []
  const details = new Map()
  const scanErrors = []
  let scanned = 0

  for (const file of listSourceFiles(typesDir)) {
    scanned += 1
    const rel = toPosix(path.relative(root, file))
    const rawSrc = fs.readFileSync(file, 'utf8')
    const { hits, scanError } = analyzeSource(rawSrc)
    if (scanError) {
      scanErrors.push({ file: rel, message: scanError.message })
      continue
    }
    if (hits.length > 0) {
      offenders.push(rel)
      details.set(
        rel,
        hits.map((h) => `line ${h.line}: ${h.detail}`),
      )
    }
  }

  offenders.sort()
  return { offenders, details, scanErrors, scanned }
}

// ─── CLI ────────────────────────────────────────────────────────────

function requireLayout() {
  // TYPES_DIR is checked as well as SRC_DIR, or the ratchet is vacuous: if
  // the directory is renamed, `listSourceFiles` early-returns [] and the
  // guard prints `OK: 0 file(s)` and exits 0 — green for a directory it
  // never found, instead of the exit-2 layout-changed path documented above.
  for (const dir of [SRC_DIR, TYPES_DIR]) {
    if (!fs.existsSync(dir)) {
      console.error(`ERROR: expected directory not found (repo layout changed?): ${dir}`)
      process.exit(2)
    }
  }
}

function runGuard() {
  requireLayout()
  const { offenders, details, scanErrors, scanned } = analyze({ root: ROOT, typesDir: TYPES_DIR })

  let failed = false

  if (scanErrors.length > 0) {
    failed = true
    console.error('ERROR: file(s) under src/types/ could not be scanned unambiguously, so their')
    console.error('exports were NOT verified as type-only:')
    console.error('')
    for (const e of scanErrors) console.error(`  ${e.file} — ${e.message}`)
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    console.error('')
  }

  if (offenders.length > 0) {
    failed = true
    console.error('ERROR: src/types/** must be type-only (#4226) — check-lib-layering.mjs')
    console.error('excludes this directory from its tier scan on exactly that premise. A')
    console.error('non-type-only export here can invert a runtime dependency that guard would')
    console.error('never see:')
    console.error('')
    for (const f of offenders) {
      for (const d of details.get(f)) console.error(`  ${f}  ${d}`)
    }
    console.error('')
    console.error('Move the runtime value out of src/types/ into the tier it actually belongs to')
    console.error('(lib/, stores/, hooks/, or components/) — there is no baseline/opt-out here.')
  }

  if (failed) process.exit(1)

  console.log(`OK: ${scanned} file(s) under src/types/, all exports are type-only`)
}

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives analyze()/analyzeSource() against a synthetic types/ tree: a
// type-only file PASSES, a file with a runtime const-object export FAILS,
// and the other recognised shapes (interface, declare, typed re-export,
// enum, function, class, default, `export *`, bare re-export specifier,
// unlexable file) are each exercised once.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'types-erasure-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const typesDir = path.join(tmp, 'src', 'types')
    const testDir = path.join(typesDir, '__tests__')
    for (const d of [typesDir, testDir]) fs.mkdirSync(d, { recursive: true })

    // Legal: interface + type alias, the two real shapes in the tree today.
    fs.writeFileSync(
      path.join(typesDir, 'clean.ts'),
      "export interface Foo { a: string }\nexport type Bar = 'x' | 'y'\n",
    )
    // Legal: `declare` (ambient — emits no runtime code).
    fs.writeFileSync(
      path.join(typesDir, 'ambient.ts'),
      'export declare const globalFlag: boolean\n',
    )
    // Legal: fully-typed re-export.
    fs.writeFileSync(
      path.join(typesDir, 'reexport-typed.ts'),
      "export { type Foo, type Bar as Baz } from './clean'\n",
    )
    // Legal: `export type * from`.
    fs.writeFileSync(path.join(typesDir, 'star-typed.ts'), "export type * from './clean'\n")

    // ILLEGAL, the realistic shape from the issue: a self-contained const
    // object, no imports at all — the case a tier scan (option 2) cannot
    // see, since it has no upward import to flag.
    fs.writeFileSync(
      path.join(typesDir, 'runtimeConst.ts'),
      "export const STATUS_LABELS = { open: 'Open', done: 'Done' }\n",
    )
    // ILLEGAL: enum (regular).
    fs.writeFileSync(path.join(typesDir, 'runtimeEnum.ts'), 'export enum Mode { A, B }\n')
    // ILLEGAL: const enum.
    fs.writeFileSync(
      path.join(typesDir, 'runtimeConstEnum.ts'),
      'export const enum Flag { On, Off }\n',
    )
    // ILLEGAL: function.
    fs.writeFileSync(path.join(typesDir, 'runtimeFn.ts'), 'export function helper() { return 1 }\n')
    // ILLEGAL: class.
    fs.writeFileSync(path.join(typesDir, 'runtimeClass.ts'), 'export class Thing {}\n')
    // ILLEGAL: default export.
    fs.writeFileSync(path.join(typesDir, 'runtimeDefault.ts'), 'const x = 1\nexport default x\n')
    // ILLEGAL: `export * from` — unprovable.
    fs.writeFileSync(path.join(typesDir, 'starUntyped.ts'), "export * from './clean'\n")
    // ILLEGAL: re-export specifier missing the `type` modifier.
    fs.writeFileSync(path.join(typesDir, 'reexport-bare.ts'), "export { Foo } from './clean'\n")
    // Export-shaped text inside a comment/string must NOT be flagged.
    fs.writeFileSync(
      path.join(typesDir, 'commentedOut.ts'),
      '// export const notReal = { a: 1 }\nconst s = "export const alsoNotReal = 1"\nexport type T = typeof s\n',
    )
    // Test file with a runtime export — out of scope, ignored entirely.
    fs.writeFileSync(path.join(testDir, 'fixture.test.ts'), 'export const testOnly = { a: 1 }\n')
    // `.d.ts` file with an initializer-shaped export — ignored (cannot
    // actually compile, but proves the scan excludes `.d.ts` by extension
    // regardless of content).
    fs.writeFileSync(path.join(typesDir, 'ambient.d.ts'), 'export const x: number\n')
    // Unterminated string -> unlexable -> scanError, not a silent skip.
    fs.writeFileSync(path.join(typesDir, 'unlexable.ts'), "export const s = 'unterminated\n")

    const { offenders, details, scanErrors } = analyze({ root: tmp, typesDir })
    const rel = (f) => toPosix(path.join('src/types', f))

    if (!offenders.includes(rel('clean.ts'))) ok('interface + type alias pass')
    else fail('interface + type alias pass', JSON.stringify(details.get(rel('clean.ts'))))

    if (!offenders.includes(rel('ambient.ts'))) ok("'declare' passes (no runtime emission)")
    else fail("'declare' passes", JSON.stringify(details.get(rel('ambient.ts'))))

    if (!offenders.includes(rel('reexport-typed.ts'))) ok('fully-typed re-export passes')
    else fail('fully-typed re-export passes', JSON.stringify(details.get(rel('reexport-typed.ts'))))

    if (!offenders.includes(rel('star-typed.ts'))) ok("'export type * from' passes")
    else fail("'export type * from' passes", JSON.stringify(details.get(rel('star-typed.ts'))))

    if (offenders.includes(rel('runtimeConst.ts'))) {
      ok('self-contained runtime const object is flagged (the realistic leak, no imports at all)')
    } else {
      fail('runtime const object flagged', JSON.stringify(offenders))
    }

    if (offenders.includes(rel('runtimeEnum.ts'))) ok('runtime enum is flagged')
    else fail('runtime enum flagged', JSON.stringify(offenders))

    if (offenders.includes(rel('runtimeConstEnum.ts'))) ok('const enum is flagged')
    else fail('const enum flagged', JSON.stringify(offenders))

    if (offenders.includes(rel('runtimeFn.ts'))) ok('runtime function is flagged')
    else fail('runtime function flagged', JSON.stringify(offenders))

    if (offenders.includes(rel('runtimeClass.ts'))) ok('runtime class is flagged')
    else fail('runtime class flagged', JSON.stringify(offenders))

    if (offenders.includes(rel('runtimeDefault.ts'))) ok('export default is flagged')
    else fail('export default flagged', JSON.stringify(offenders))

    if (offenders.includes(rel('starUntyped.ts'))) ok("bare 'export * from' is flagged")
    else fail("bare 'export * from' flagged", JSON.stringify(offenders))

    if (offenders.includes(rel('reexport-bare.ts'))) {
      ok('re-export specifier missing a type modifier is flagged')
    } else {
      fail('bare re-export specifier flagged', JSON.stringify(offenders))
    }

    if (!offenders.includes(rel('commentedOut.ts'))) {
      ok('export-shaped text inside a comment/string is not flagged')
    } else {
      fail(
        'export-shaped text inside a comment/string not flagged',
        JSON.stringify(details.get(rel('commentedOut.ts'))),
      )
    }

    if (!offenders.some((f) => f.includes('__tests__'))) ok('test file ignored')
    else fail('test file ignored', 'a __tests__ file appeared in offenders')

    if (
      !offenders.includes(rel('ambient.d.ts')) &&
      !scanErrors.some((e) => e.file === rel('ambient.d.ts'))
    ) {
      ok('.d.ts file excluded by extension regardless of content')
    } else {
      fail('.d.ts file excluded', JSON.stringify({ offenders, scanErrors }))
    }

    if (scanErrors.some((e) => e.file === rel('unlexable.ts'))) {
      ok('an unlexable file is reported as a scanError (failure), not silently skipped')
    } else {
      fail('unlexable file reported as scanError', JSON.stringify(scanErrors))
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  runCliSelfTest(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * End-to-end CLI self-test: spawns THIS script as a real subprocess against
 * a fully synthetic fixture repo and asserts on the actual process exit
 * code, so a regression that drops `process.exit(1)` from `runGuard()`
 * (defanging the gate entirely) cannot sail through with the in-process
 * assertions above showing zero failures. Mirrors
 * `check-lib-layering.mjs`'s `runCliSelfTest`.
 */
function runCliSelfTest(ok, fail) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'types-erasure-cli-selftest-'))
  try {
    const fixtureScripts = path.join(fixtureRoot, 'scripts')
    const fixtureLib = path.join(fixtureScripts, 'lib')
    const fixtureTypes = path.join(fixtureRoot, 'src', 'types')
    fs.mkdirSync(fixtureLib, { recursive: true })
    fs.mkdirSync(fixtureTypes, { recursive: true })
    fs.copyFileSync(import.meta.filename, path.join(fixtureScripts, 'check-types-erasure.mjs'))
    fs.copyFileSync(
      path.join(import.meta.dirname, 'lib', 'js-scanner.mjs'),
      path.join(fixtureLib, 'js-scanner.mjs'),
    )

    const run = () =>
      spawnSync(process.execPath, [path.join(fixtureScripts, 'check-types-erasure.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })

    // Clean tree -> exit 0 (the real pre-commit-passing path).
    fs.writeFileSync(path.join(fixtureTypes, 'clean.ts'), 'export type T = string\n')
    let res = run()
    if (res.status === 0) ok('CLI exits 0 on a clean tree')
    else fail('CLI exits 0 on a clean tree', `status=${res.status} stderr=${res.stderr}`)

    // Runtime export -> exit 1 (the real pre-commit-FAILING path — this is
    // what actually blocks a bad PR).
    fs.writeFileSync(path.join(fixtureTypes, 'offender.ts'), "export const LABELS = { a: 'A' }\n")
    res = run()
    if (res.status === 1) ok('CLI exits 1 on a runtime export (the gate actually blocks)')
    else fail('CLI exits 1 on a runtime export (the gate actually blocks)', `status=${res.status}`)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}
