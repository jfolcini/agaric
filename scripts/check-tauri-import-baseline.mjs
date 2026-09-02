#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri-import ratchet guard (#2927, blind-spot fix #3196).
//
// `src/lib/tauri.ts` + `src/lib/tauri/**` is a large hand-written IPC
// wrapper layer that the codebase is migrating OFF, onto the
// tauri-specta-generated typed bindings in `src/lib/bindings.ts` (call
// `commands.foo(...)` and unwrap the Result with the `unwrap` helper from
// `@/lib/app-error`). Many of the wrappers are pure one-line pass-throughs
// that add no value; the long-term goal is to delete them and have app
// code depend on the generated bindings directly. A few wrappers
// genuinely can't be deleted (Channel plumbing, raw binary transport,
// plugin shims) — see "Sanctioned symbols" below.
//
// That migration is file-by-file and spans hundreds of call sites, so it
// can only land safely in small slices. This guard is the ratchet that
// makes the incremental migration monotonic: the set of non-test files
// depending on the wrapper layer may only SHRINK, never grow.
//
// (#3218) This is now the ONLY guard on the wrapper layer. A sibling
// `check-tauri-bindings-parity.mjs` guard used to require one wrapper per
// `commands.*` binding — the opposite direction from this ratchet (adopting
// a wrapper satisfies parity but fails this ratchet; migrating a call site
// off its wrapper satisfies this ratchet but orphans the wrapper, failing
// parity, unless the wrapper is deleted and the command allowlisted). It
// was retired rather than reconciled because "every command has a wrapper"
// was never the real target: the end state has a small, permanently
// sanctioned residual (see "Sanctioned symbols" below), and this guard's
// own completion criterion — baseline `[]`, modulo the sanctioned list —
// already tells you when the migration is done. Its Phase-2 ambition
// (real Rust-signature parity) was never implemented and, for anything
// routed through `commands.*`, is subsumed by `tsc` typechecking the
// generated call; it only had bite for the couple of raw-`invoke` seams
// that bypass `commands.*` entirely, which the sanctioned-symbols list
// already tracks by name.
//
// ─── How it works ───────────────────────────────────────────────────
//
// `scripts/tauri-import-baseline.json` is a committed, sorted allowlist
// of every non-test file that currently depends on the wrapper layer
// (barrel `@/lib/tauri` import, OR a submodule `@/lib/tauri/<domain>`
// import that pulls in at least one NON-sanctioned symbol — see below).
// On each run the guard recomputes the live set of importers and FAILS
// if:
//
//   - a file depends on the wrapper layer but is NOT in the baseline — a
//     NEW importer (the count went up), or
//   - a baseline entry no longer depends on the wrapper layer (including
//     a file that has been reduced to ONLY sanctioned-symbol submodule
//     imports — see below) — a STALE entry that must be pruned so the
//     count ratchets DOWN as call sites are migrated (a green suite on a
//     stale baseline would otherwise hide the win and let the count
//     silently creep back up).
//
// When you migrate a file off the wrapper layer, remove it from the
// baseline (or run `--update-baseline`). When you add legitimately new UI
// that must call an as-yet-unmigrated value-adding wrapper (channels,
// pagination, error-shaping), prefer the generated binding; if the
// wrapper is genuinely still the right seam, run `--update-baseline` and
// justify it in the commit message. If the wrapper can NEVER be deleted
// (see "Sanctioned symbols"), add the symbol there instead — a file whose
// only wrapper dependency is a sanctioned submodule symbol needs no
// baseline entry at all.
//
// ─── Detection ──────────────────────────────────────────────────────
//
// Flags a static `… from '@/lib/tauri'` / `… from '@/lib/tauri/<domain>'`
// (import or re-export), the dynamic equivalents `import('@/lib/tauri')` /
// `import('@/lib/tauri/<domain>')`, or a side-effect-only import with no
// bindings at all (`import '@/lib/tauri'` / `import '@/lib/tauri/<domain>'`
// — no `from` clause, so it would otherwise be invisible to the static
// check). Comments are stripped first, so a commented-out or documented
// import is not counted. The sibling mock module `@/lib/tauri-mock` /
// `@/lib/tauri-mock/…` does NOT match — the optional submodule segment must
// start with a literal `/`, and the character right after `tauri` in
// `tauri-mock` is `-`, so the closing-quote backreference never lines up.
//
// ─── Sanctioned symbols (the #3196 completion criterion) ────────────
//
// `scripts/tauri-sanctioned-symbols.json` is a short, explicit, reviewed
// list of `{ module, symbol }` pairs that are confirmed un-migratable —
// not thin pass-throughs, but wrappers that do real work the generated
// binding cannot express on its own (Channel plumbing, raw binary
// transport, a plugin shim with no IPC at all). A file's dependency on
// the wrapper layer is "fully sanctioned" — and therefore excluded from
// the importer count entirely, no baseline entry needed — only if ALL of
// the following hold:
//
//   - it has no bare `@/lib/tauri` (barrel) import, static or dynamic —
//     the barrel re-exports everything, so it can't be symbol-checked;
//   - it has no dynamic submodule import (`import('@/lib/tauri/x')`), no
//     namespace submodule import (`import * as x from '@/lib/tauri/x'`),
//     and no side-effect-only submodule import (`import '@/lib/tauri/x'`)
//     — none of these exposes symbols to a text-level check, so all three
//     are conservatively treated as unverifiable (i.e. still debt);
//   - every static named import it takes from a `@/lib/tauri/<domain>`
//     submodule (`import { a, b } from '@/lib/tauri/domain'`, including
//     `import type { … }` and `type` specifiers) names only symbols on
//     the sanctioned list for that domain.
//
// This makes "done" mechanically checkable: the migration is complete
// when the baseline is `[]`. At that point every remaining
// `@/lib/tauri/*` import in the repo is, by construction, restricted to
// the sanctioned list — anything else would still be sitting in the
// (now-empty) baseline requirement and fail the guard as a "new
// importer". The sanctioned list itself is the audit trail: growing it
// requires a reviewed commit, same as `--update-baseline`.
//
// Type-only specifiers are checked against the same sanctioned list as
// value specifiers (no separate type/value carve-out) — simpler to
// reason about, and in practice a symbol that's genuinely un-migratable
// rarely needs its type re-exported by a caller that imports nothing
// else from that submodule.
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Scans `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts[x]`,
// `__tests__/`, `/tests/`) and `.d.ts`. The wrapper layer itself —
// `src/lib/tauri.ts` and everything under `src/lib/tauri/` — is also
// excluded from the scan. Without this exclusion, the wrapper's own
// internal cross-submodule imports (e.g. `src/lib/tauri/links.ts` and
// `history.ts` importing `@/lib/tauri/_shared`, or `search.ts` importing
// `@/lib/tauri/core`) would start counting as soon as submodule detection
// was widened, even though they are not app code depending on the
// wrapper — they ARE the wrapper.
//
// Usage: node scripts/check-tauri-import-baseline.mjs
//        node scripts/check-tauri-import-baseline.mjs --update-baseline
// Exit:  0 = clean, 1 = drift (new importer or stale baseline entry),
//        2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'

import { ScanError, stripComments } from './lib/js-scanner.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'tauri-import-baseline.json')
const SANCTIONED_FILE = path.join(ROOT, 'scripts', 'tauri-sanctioned-symbols.json')

// Bare barrel import: static `from '@/lib/tauri'` (import or re-export) or
// dynamic `import('@/lib/tauri')`. Used by isFullySanctioned() below, where a
// barrel import always counts as debt (it can't be symbol-checked).
const BARE_STATIC_RE = /from\s*(['"])@\/lib\/tauri\1/
const BARE_DYNAMIC_RE = /import\(\s*(['"])@\/lib\/tauri\1\s*\)/

// Widened detection (#3196): also matches a submodule path segment
// (`@/lib/tauri/<domain>`), static or dynamic. The optional group starts
// with a literal `/`, so it does NOT extend into the sibling
// `@/lib/tauri-mock` module — the trailing quote backreference (`\1`) must
// still follow immediately, and after `tauri-mock` the next character is
// `-`, not the quote.
const STATIC_RE = /from\s*(['"])@\/lib\/tauri(?:\/[\w-]+)?\1/
const DYNAMIC_RE = /import\(\s*(['"])@\/lib\/tauri(?:\/[\w-]+)?\1\s*\)/

// Side-effect import with no bindings at all (`import '@/lib/tauri'` /
// `import '@/lib/tauri/<domain>'`). There is no `from` clause, so STATIC_RE
// alone misses this form entirely — a real form, distinct from the dynamic
// `import(...)` call syntax matched by DYNAMIC_RE above. A named/default/
// namespace import always has a token (identifier, `{`, or `*`) between
// `import` and the opening quote, so this can only match a genuine
// side-effect import; there are no symbols to check, so it is always debt,
// same as the other unverifiable shapes below.
const SIDE_EFFECT_RE = /import\s*(['"])@\/lib\/tauri(?:\/[\w-]+)?\1/

// Unverifiable submodule import shapes: dynamic (`import('@/lib/tauri/x')`),
// namespace (`import * as x from '@/lib/tauri/x'`), or side-effect-only
// (`import '@/lib/tauri/x'`). None exposes individual symbol names to a
// text-level check, so all three are always treated as debt regardless of
// the sanctioned list.
const DYNAMIC_SUBMODULE_RE = /import\(\s*(['"])@\/lib\/tauri\/[\w-]+\1\s*\)/
const NAMESPACE_SUBMODULE_RE = /import\s+\*\s+as\s+\w+\s+from\s*(['"])@\/lib\/tauri\/[\w-]+\1/

// Static named import from a submodule, e.g. `import { a, b } from
// '@/lib/tauri/domain'` or `import type { a } from '@/lib/tauri/domain'`.
// Captures the brace contents (group 1) and the domain (group 3) so the
// imported symbols can be checked against the sanctioned list per-module.
const SUBMODULE_NAMED_IMPORT_RE =
  /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])@\/lib\/tauri\/([\w-]+)\2/g

// ─── helpers ──────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/**` for `*.ts` / `*.tsx` files, excluding test files,
 * `__tests__/` + `tests/` directories, and the wrapper layer itself
 * (`lib/tauri.ts`, `lib/tauri/**`) — see the "Scope" header comment. The
 * baseline tracks non-test app code only (test files may mock the wrapper
 * layer freely).
 */
function listSourceFiles(srcDir = SRC_DIR) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = toPosix(path.relative(srcDir, full))
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'tests') continue
        if (rel === 'lib/tauri') continue // wrapper layer itself
        visit(full)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts') &&
        rel !== 'lib/tauri.ts' // wrapper layer itself
      ) {
        out.push(full)
      }
    }
  }
  visit(srcDir)
  return out
}

/** Does `stripped` source depend on the wrapper layer at all (barrel or submodule, static, dynamic, or side-effect-only)? */
function touchesTauriWrapper(stripped) {
  return STATIC_RE.test(stripped) || DYNAMIC_RE.test(stripped) || SIDE_EFFECT_RE.test(stripped)
}

/**
 * Parse a brace-delimited named-import list (`"a, type B, c as d"`) into the
 * imported (not local-aliased) symbol names, stripping per-specifier `type`
 * keywords and `as` aliases.
 */
function parseNamedSpecifiers(braceContents) {
  return braceContents
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^type\s+/, ''))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
}

/**
 * Is this file's entire dependency on the wrapper layer covered by the
 * sanctioned-symbols list? See the "Sanctioned symbols" header comment for
 * the exact rules. `stripped` must already have comments stripped.
 * `sanctioned` is a `Set` of `"@/lib/tauri/<domain>#<symbol>"` keys.
 */
function isFullySanctioned(stripped, sanctioned) {
  if (BARE_STATIC_RE.test(stripped) || BARE_DYNAMIC_RE.test(stripped)) return false
  if (DYNAMIC_SUBMODULE_RE.test(stripped)) return false
  if (NAMESPACE_SUBMODULE_RE.test(stripped)) return false
  if (SIDE_EFFECT_RE.test(stripped)) return false

  let sawSubmoduleImport = false
  const re = new RegExp(SUBMODULE_NAMED_IMPORT_RE.source, SUBMODULE_NAMED_IMPORT_RE.flags)
  let m
  while ((m = re.exec(stripped))) {
    sawSubmoduleImport = true
    const [, braces, , domain] = m
    for (const symbol of parseNamedSpecifiers(braces)) {
      if (!sanctioned.has(`@/lib/tauri/${domain}#${symbol}`)) return false
    }
  }
  // A file with no wrapper-layer import at all is not "fully sanctioned" in
  // any meaningful sense — callers only ask this when touchesTauriWrapper()
  // is already true, but guard against a vacuous true regardless.
  return sawSubmoduleImport
}

// ─── analysis ─────────────────────────────────────────────────────────

/**
 * Compute the live importer set under `srcDir` and diff it against
 * `baseline` (an array of POSIX repo-relative paths). A file "imports" the
 * wrapper layer if it touches `@/lib/tauri`(/…) AND is not fully sanctioned
 * (see isFullySanctioned). Pure over the filesystem, so it can be driven
 * against an arbitrary tree. `sanctioned` is a `Set` as produced by
 * readSanctioned(). Returns
 * `{ importers, newImporters, staleBaseline, scanned, scanErrors }`, where
 * `scanErrors` is `{ file, message }` for files the shared scanner could not
 * lex unambiguously — a FAILURE, not a skip: a file this guard cannot parse
 * is a file whose `@/lib/tauri` dependency nobody verified (#3993).
 */
function analyze({ root, srcDir, baseline, sanctioned = new Set() }) {
  const baselineSet = new Set(baseline)
  const importers = []
  const scanErrors = []
  let scanned = 0
  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const rel = toPosix(path.relative(root, file))
    const src = fs.readFileSync(file, 'utf8')
    let stripped
    try {
      stripped = stripComments(src)
    } catch (err) {
      if (!(err instanceof ScanError)) throw err
      scanErrors.push({ file: rel, message: err.message })
      continue
    }
    if (touchesTauriWrapper(stripped) && !isFullySanctioned(stripped, sanctioned)) {
      importers.push(rel)
    }
  }
  importers.sort()
  const importerSet = new Set(importers)
  const newImporters = importers.filter((f) => !baselineSet.has(f))
  const staleBaseline = [...baselineSet].filter((f) => !importerSet.has(f)).toSorted()
  return { importers, newImporters, staleBaseline, scanned, scanErrors }
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return []
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (!Array.isArray(raw)) {
    throw new Error(`baseline file is not a JSON array: ${BASELINE_FILE}`)
  }
  return raw
}

function writeBaseline(importers) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(importers, null, 2)}\n`)
}

/**
 * Load `scripts/tauri-sanctioned-symbols.json` into a `Set` of
 * `"@/lib/tauri/<domain>#<symbol>"` keys. Missing file => empty set (no
 * symbol is sanctioned, i.e. every submodule import counts as debt).
 */
function readSanctioned() {
  if (!fs.existsSync(SANCTIONED_FILE)) return new Set()
  const raw = JSON.parse(fs.readFileSync(SANCTIONED_FILE, 'utf8'))
  if (!Array.isArray(raw)) {
    throw new Error(`sanctioned-symbols file is not a JSON array: ${SANCTIONED_FILE}`)
  }
  const set = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry.module !== 'string' || typeof entry.symbol !== 'string') {
      throw new Error(`malformed sanctioned-symbols entry: ${JSON.stringify(entry)}`)
    }
    set.add(`${entry.module}#${entry.symbol}`)
  }
  return set
}

// ─── entry point ────────────────────────────────────────────────────────

if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}

function updateBaseline() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
  const sanctioned = readSanctioned()
  const { importers, scanErrors } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
    baseline: [],
    sanctioned,
  })
  if (scanErrors.length > 0) {
    console.error('ERROR: file(s) could not be scanned unambiguously; refusing to write a baseline')
    console.error('computed from an incomplete scan:')
    console.error('')
    for (const e of scanErrors) console.error(`  ${e.file} — ${e.message}`)
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    process.exit(2)
  }
  writeBaseline(importers)
  console.log(
    `OK: wrote baseline with ${importers.length} importer(s) of @/lib/tauri to ${path.relative(ROOT, BASELINE_FILE)}`,
  )
}

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`ERROR: baseline file not found: ${BASELINE_FILE}`)
    console.error('Seed it with:  node scripts/check-tauri-import-baseline.mjs --update-baseline')
    process.exit(2)
  }

  const baseline = readBaseline()
  const sanctioned = readSanctioned()
  const { importers, newImporters, staleBaseline, scanErrors } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
    baseline,
    sanctioned,
  })

  let failed = false

  if (scanErrors.length > 0) {
    failed = true
    console.error('ERROR: file(s) could not be scanned unambiguously, so their @/lib/tauri')
    console.error('dependency was NOT verified:')
    console.error('')
    for (const e of scanErrors) console.error(`  ${e.file} — ${e.message}`)
    console.error('')
    console.error('The shared scanner (scripts/lib/js-scanner.mjs) fails closed rather than')
    console.error('guessing. Fix the construct it names, or extend the scanner.')
    console.error('')
  }

  if (newImporters.length > 0) {
    failed = true
    console.error(
      'ERROR: new dependency/dependencies on the @/lib/tauri wrapper layer in app code:',
    )
    for (const f of newImporters) console.error(`  ${f}`)
    console.error('')
    console.error('`@/lib/tauri` is being retired (#2927). New app code must call the generated')
    console.error('typed binding instead:')
    console.error('')
    console.error("    import { commands } from '@/lib/bindings'")
    console.error("    import { unwrap } from '@/lib/app-error'")
    console.error('    const result = unwrap(await commands.someCommand(...))')
    console.error('')
    console.error('If a value-adding wrapper (channel / pagination / error-shaping) is genuinely')
    console.error('still the right seam, run `--update-baseline` and justify it in the commit.')
    console.error('')
    console.error('If the wrapper symbol can NEVER be migrated (Channel plumbing, raw binary')
    console.error('transport, a non-IPC plugin shim), add it to')
    console.error(`${path.relative(ROOT, SANCTIONED_FILE)} instead — a file whose only wrapper`)
    console.error('dependency is a sanctioned submodule symbol needs no baseline entry at all.')
  }

  if (staleBaseline.length > 0) {
    failed = true
    console.error('ERROR: stale entr(ies) in the tauri-import baseline — these files no longer')
    console.error('depend on the wrapper layer (or depend on it only through sanctioned submodule')
    console.error('symbols) and must be pruned so the count ratchets down:')
    for (const f of staleBaseline) console.error(`  ${f}`)
    console.error('')
    console.error(
      'Prune them with:  node scripts/check-tauri-import-baseline.mjs --update-baseline',
    )
  }

  if (failed) process.exit(1)

  console.log(
    `OK: ${importers.length} baseline importer(s) of @/lib/tauri, no new importers, no stale entries`,
  )
}
