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
//        node scripts/check-tauri-import-baseline.mjs --self-test
// Exit:  0 = clean, 1 = drift (new importer or stale baseline entry),
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/**
 * Replace block comments (`/* … *\/`, incl. JSDoc) and line comments
 * (`// …`) with spaces so a documented/commented-out import of the
 * wrapper layer is not counted.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
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
 * (see isFullySanctioned). Pure over the filesystem so the self-test can
 * drive it against a synthetic tree. `sanctioned` is a `Set` as produced by
 * readSanctioned(). Returns `{ importers, newImporters, staleBaseline, scanned }`.
 */
function analyze({ root, srcDir, baseline, sanctioned = new Set() }) {
  const baselineSet = new Set(baseline)
  const importers = []
  let scanned = 0
  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const src = fs.readFileSync(file, 'utf8')
    const stripped = stripComments(src)
    if (touchesTauriWrapper(stripped) && !isFullySanctioned(stripped, sanctioned)) {
      importers.push(toPosix(path.relative(root, file)))
    }
  }
  importers.sort()
  const importerSet = new Set(importers)
  const newImporters = importers.filter((f) => !baselineSet.has(f))
  const staleBaseline = [...baselineSet].filter((f) => !importerSet.has(f)).toSorted()
  return { importers, newImporters, staleBaseline, scanned }
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

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else if (process.argv.includes('--update-baseline')) {
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
  const { importers } = analyze({ root: ROOT, srcDir: SRC_DIR, baseline: [], sanctioned })
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
  const { importers, newImporters, staleBaseline } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
    baseline,
    sanctioned,
  })

  let failed = false

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

// ─── self-test ──────────────────────────────────────────────────────────
//
// Drives analyze() against a synthetic src tree so the guard's own exit
// behavior is verified: a baselined importer PASSES, a NEW importer is
// flagged, a STALE baseline entry is flagged, a dynamic import counts, a
// `@/lib/tauri-mock` import does NOT count, a commented import does NOT
// count, and test files are ignored — plus (#3196) a submodule static
// import is caught, a submodule dynamic import is caught, a
// `@/lib/tauri-mock/…` submodule import still does NOT count, the wrapper
// layer's own internal cross-submodule imports are excluded from the scan
// entirely, a submodule import of a non-sanctioned symbol fails, a
// submodule import of ONLY sanctioned symbols needs no baseline entry, a
// baselined file that graduates to sanctioned-only is flagged stale, a
// side-effect-only submodule import (no `from` clause) is caught, a
// side-effect-only `@/lib/tauri-mock/…` import still does NOT count, an
// inline `type` specifier (`{ type readAttachment }`) on a sanctioned symbol
// resolves to the sanctioned key, likewise with an `as` alias
// (`{ type readAttachment as RA }`), and an inline-`type` sanctioned symbol
// mixed with a non-sanctioned value symbol still counts as debt.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-baseline-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const compDir = path.join(srcDir, 'components')
    const testDir = path.join(compDir, '__tests__')
    const wrapperDir = path.join(libDir, 'tauri')
    for (const d of [libDir, compDir, testDir, wrapperDir]) fs.mkdirSync(d, { recursive: true })

    // Baselined barrel importer → clean.
    fs.writeFileSync(
      path.join(compDir, 'Baselined.tsx'),
      "import { createBlock } from '@/lib/tauri'\nexport const C = () => createBlock()\n",
    )
    // New barrel importer NOT in baseline → violation.
    fs.writeFileSync(
      path.join(compDir, 'NewImporter.tsx'),
      "import { deleteBlock } from '@/lib/tauri'\nexport const D = () => deleteBlock()\n",
    )
    // Dynamic barrel import, in baseline → clean (and proves dynamic detection).
    fs.writeFileSync(
      path.join(compDir, 'Dynamic.tsx'),
      "export const E = async () => (await import('@/lib/tauri')).createBlock()\n",
    )
    // Imports the sibling mock, NOT the wrapper → must NOT count.
    fs.writeFileSync(
      path.join(libDir, 'usesMock.ts'),
      "import { installTauriMock } from '@/lib/tauri-mock'\nexport const F = installTauriMock\n",
    )
    // Commented-out import → must NOT count.
    fs.writeFileSync(
      path.join(compDir, 'Commented.tsx'),
      "// import { x } from '@/lib/tauri'\nexport const G = () => null\n",
    )
    // Migrated file that is STILL listed in baseline → stale entry.
    fs.writeFileSync(
      path.join(compDir, 'Migrated.tsx'),
      "import { commands } from '@/lib/bindings'\nexport const H = () => commands.createBlock()\n",
    )
    // Test file that imports the wrapper → ignored (out of scope).
    fs.writeFileSync(
      path.join(testDir, 'Ignored.test.tsx'),
      "import { createBlock } from '@/lib/tauri'\nit('x', () => createBlock())\n",
    )

    // #3196: submodule static import of a NON-sanctioned symbol, NOT in
    // baseline → violation (the original blind spot: this used to be
    // completely invisible).
    fs.writeFileSync(
      path.join(compDir, 'SubmoduleStatic.tsx'),
      "import { deleteProperty } from '@/lib/tauri/properties'\nexport const I = () => deleteProperty()\n",
    )
    // #3196: submodule dynamic import → violation regardless of sanctioned
    // list (symbols aren't verifiable text-side, so always debt).
    fs.writeFileSync(
      path.join(compDir, 'SubmoduleDynamic.tsx'),
      "export const J = async () => (await import('@/lib/tauri/properties')).deleteProperty()\n",
    )
    // #3196: `@/lib/tauri-mock/…` submodule import → must still NOT count.
    fs.writeFileSync(
      path.join(libDir, 'usesMockSubmodule.ts'),
      "import { installHandler } from '@/lib/tauri-mock/handlers'\nexport const K = installHandler\n",
    )
    // #3196 (review fix): side-effect-only submodule import, NOT in baseline
    // → violation. No `from` clause, so STATIC_RE alone would miss this;
    // there are no symbols to check, so it is unverifiable => always debt,
    // same as the dynamic/namespace shapes above.
    fs.writeFileSync(
      path.join(compDir, 'SubmoduleSideEffect.tsx'),
      "import '@/lib/tauri/logging'\nexport const O = 1\n",
    )
    // #3196 (review fix): side-effect-only import of the sibling mock →
    // must still NOT count (same specifier-boundary guarantee as the named
    // and dynamic mock cases above).
    fs.writeFileSync(
      path.join(libDir, 'usesMockSideEffect.ts'),
      "import '@/lib/tauri-mock/handlers'\nexport const P = 1\n",
    )
    // #3196: submodule import of ONLY sanctioned symbols, NOT in baseline →
    // clean, no baseline entry required at all (the completion criterion).
    fs.writeFileSync(
      path.join(compDir, 'SanctionedOnly.tsx'),
      "import { readAttachment } from '@/lib/tauri/attachments'\nexport const L = () => readAttachment('x')\n",
    )
    // #3196: submodule import mixing a sanctioned symbol with a
    // non-sanctioned one → still counts as debt (conservative: ALL named
    // symbols from that submodule must be sanctioned).
    fs.writeFileSync(
      path.join(compDir, 'MixedSanctioned.tsx'),
      "import { readAttachment, readAttachmentMeta } from '@/lib/tauri/attachments'\nexport const M = () => [readAttachment, readAttachmentMeta]\n",
    )
    // #3196 (review fix): inline `type` specifier on a sanctioned symbol
    // (`{ type readAttachment }`) must still resolve to the sanctioned key —
    // exercises parseNamedSpecifiers' per-specifier `type` stripping, not
    // just the whole-statement `import type { … }` form covered elsewhere.
    fs.writeFileSync(
      path.join(compDir, 'InlineTypeSanctioned.tsx'),
      "import { type readAttachment } from '@/lib/tauri/attachments'\nexport type Q = typeof readAttachment\n",
    )
    // #3196 (review fix): inline `type` + `as` alias on a sanctioned symbol
    // (`{ type readAttachment as RA }`) — the alias must be dropped and the
    // `type` keyword stripped, in either order, to recover the sanctioned key.
    fs.writeFileSync(
      path.join(compDir, 'InlineTypeAliasSanctioned.tsx'),
      "import { type readAttachment as RA } from '@/lib/tauri/attachments'\nexport type R = RA\n",
    )
    // #3196 (review fix): inline-`type` sanctioned symbol mixed with a
    // non-sanctioned value symbol in the same specifier list → still counts
    // as debt (same conservative all-must-be-sanctioned rule as
    // MixedSanctioned above, but via the inline-`type` path specifically).
    fs.writeFileSync(
      path.join(compDir, 'InlineTypeMixed.tsx'),
      "import { type readAttachment, readAttachmentMeta } from '@/lib/tauri/attachments'\nexport const S = readAttachmentMeta\n",
    )
    // #3196: a file previously baselined that has since been reduced to
    // ONLY sanctioned submodule imports → must be flagged stale so it gets
    // pruned (proves the baseline can ratchet all the way to the real
    // floor, not just to zero).
    fs.writeFileSync(
      path.join(compDir, 'GraduatedToSanctioned.tsx'),
      "import { startSync } from '@/lib/tauri/sync'\nexport const N = () => startSync('peer')\n",
    )
    // #3196: the wrapper layer's own internal cross-submodule import (e.g.
    // real `links.ts`/`history.ts` importing `@/lib/tauri/_shared`) must be
    // excluded from the scan entirely — not "sanctioned", not "debt",
    // simply not scanned at all.
    fs.writeFileSync(
      path.join(wrapperDir, '_shared.ts'),
      'export const toSpaceScope = () => null\n',
    )
    fs.writeFileSync(
      path.join(wrapperDir, 'core.ts'),
      "import { toSpaceScope } from '@/lib/tauri/_shared'\nexport const withAbort = toSpaceScope\n",
    )
    fs.writeFileSync(path.join(libDir, 'tauri.ts'), "export * from '@/lib/tauri/core'\n")

    const sanctioned = new Set([
      '@/lib/tauri/attachments#readAttachment',
      '@/lib/tauri/sync#startSync',
    ])
    const baseline = [
      'src/components/Baselined.tsx',
      'src/components/Dynamic.tsx',
      'src/components/Migrated.tsx', // stale: file no longer imports the wrapper
      'src/components/GraduatedToSanctioned.tsx', // stale: now sanctioned-only
    ]
    const { importers, newImporters, staleBaseline } = analyze({
      root: tmp,
      srcDir,
      baseline,
      sanctioned,
    })

    if (newImporters.includes('src/components/NewImporter.tsx')) ok('new importer is flagged')
    else fail('new importer is flagged', JSON.stringify(newImporters))

    if (!newImporters.includes('src/components/Baselined.tsx')) ok('baselined importer passes')
    else fail('baselined importer passes', 'Baselined.tsx flagged as new')

    if (!newImporters.includes('src/components/Dynamic.tsx'))
      ok('dynamic import counts and is accepted from baseline')
    else fail('dynamic import counts', 'Dynamic.tsx flagged as new')

    if (!newImporters.includes('src/lib/usesMock.ts')) ok('@/lib/tauri-mock does not count')
    else fail('@/lib/tauri-mock does not count', 'usesMock.ts flagged')

    if (!newImporters.includes('src/components/Commented.tsx'))
      ok('commented import does not count')
    else fail('commented import does not count', 'Commented.tsx flagged')

    if (staleBaseline.includes('src/components/Migrated.tsx')) ok('stale baseline entry is flagged')
    else fail('stale baseline entry is flagged', JSON.stringify(staleBaseline))

    if (
      !newImporters.some((f) => f.includes('__tests__')) &&
      !staleBaseline.some((f) => f.includes('__tests__'))
    )
      ok('test file is ignored')
    else fail('test file is ignored', 'a __tests__ file appeared')

    if (newImporters.includes('src/components/SubmoduleStatic.tsx'))
      ok('submodule static import of a non-sanctioned symbol is caught')
    else fail('submodule static import is caught', JSON.stringify(newImporters))

    if (newImporters.includes('src/components/SubmoduleDynamic.tsx'))
      ok('submodule dynamic import is caught (unverifiable => debt)')
    else fail('submodule dynamic import is caught', JSON.stringify(newImporters))

    if (!newImporters.includes('src/lib/usesMockSubmodule.ts'))
      ok('@/lib/tauri-mock/… submodule import does not count')
    else fail('@/lib/tauri-mock/… submodule import does not count', 'usesMockSubmodule.ts flagged')

    if (newImporters.includes('src/components/SubmoduleSideEffect.tsx'))
      ok('side-effect-only submodule import is caught (no `from` clause, still debt)')
    else fail('side-effect-only submodule import is caught', JSON.stringify(newImporters))

    if (!newImporters.includes('src/lib/usesMockSideEffect.ts'))
      ok('side-effect-only @/lib/tauri-mock/… import does not count')
    else
      fail(
        'side-effect-only @/lib/tauri-mock/… import does not count',
        'usesMockSideEffect.ts flagged',
      )

    if (
      !importers.includes('src/lib/tauri.ts') &&
      !importers.includes('src/lib/tauri/core.ts') &&
      !importers.includes('src/lib/tauri/_shared.ts')
    )
      ok("wrapper layer's own internal imports are excluded from the scan")
    else fail("wrapper layer's own internal imports are excluded", JSON.stringify(importers))

    if (!newImporters.includes('src/components/SanctionedOnly.tsx'))
      ok('submodule import of only sanctioned symbols needs no baseline entry')
    else fail('sanctioned-only submodule import passes', 'SanctionedOnly.tsx flagged as new')

    if (newImporters.includes('src/components/MixedSanctioned.tsx'))
      ok('submodule import mixing a non-sanctioned symbol still counts as debt')
    else fail('mixed sanctioned/non-sanctioned import counts as debt', JSON.stringify(newImporters))

    if (!newImporters.includes('src/components/InlineTypeSanctioned.tsx'))
      ok('inline `type` specifier on a sanctioned symbol resolves to the sanctioned key')
    else
      fail(
        'inline `type` specifier resolves to sanctioned key',
        'InlineTypeSanctioned.tsx flagged as new',
      )

    if (!newImporters.includes('src/components/InlineTypeAliasSanctioned.tsx'))
      ok('inline `type` + `as` alias on a sanctioned symbol resolves to the sanctioned key')
    else
      fail(
        'inline `type` + alias resolves to sanctioned key',
        'InlineTypeAliasSanctioned.tsx flagged as new',
      )

    if (newImporters.includes('src/components/InlineTypeMixed.tsx'))
      ok(
        'inline-`type` sanctioned symbol mixed with a non-sanctioned value symbol still counts as debt',
      )
    else
      fail(
        'inline-type-sanctioned + non-sanctioned value still counts as debt',
        JSON.stringify(newImporters),
      )

    if (staleBaseline.includes('src/components/GraduatedToSanctioned.tsx'))
      ok('baselined file that graduates to sanctioned-only is flagged stale')
    else fail('graduated-to-sanctioned file is flagged stale', JSON.stringify(staleBaseline))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
