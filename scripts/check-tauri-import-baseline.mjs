#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tauri-import ratchet guard (#2927).
//
// `src/lib/tauri.ts` is a large hand-written IPC wrapper layer that the
// codebase is migrating OFF, onto the tauri-specta-generated typed
// bindings in `src/lib/bindings.ts` (call `commands.foo(...)` and unwrap
// the Result with the `unwrap` helper from `@/lib/app-error`). Many of
// the wrappers are pure one-line pass-throughs that add no value; the
// long-term goal is to delete them and have app code depend on the
// generated bindings directly.
//
// That migration is file-by-file and spans hundreds of call sites, so it
// can only land safely in small slices. This guard is the ratchet that
// makes the incremental migration monotonic: the set of non-test files
// importing `@/lib/tauri` may only SHRINK, never grow.
//
// ─── How it works ───────────────────────────────────────────────────
//
// `scripts/tauri-import-baseline.json` is a committed, sorted allowlist
// of every non-test file that currently imports `@/lib/tauri`. On each
// run the guard recomputes the live set of importers and FAILS if:
//
//   - a file imports `@/lib/tauri` but is NOT in the baseline — a NEW
//     importer (the count went up), or
//   - a baseline entry no longer imports `@/lib/tauri` — a STALE entry
//     that must be pruned so the count ratchets DOWN as call sites are
//     migrated (a green suite on a stale baseline would otherwise hide
//     the win and let the count silently creep back up).
//
// When you migrate a file off `@/lib/tauri`, remove it from the baseline
// (or run `--update-baseline`). When you add legitimately new UI that
// must call an as-yet-unmigrated value-adding wrapper (channels,
// pagination, error-shaping), prefer the generated binding; if the
// wrapper is genuinely still the right seam, run `--update-baseline` to
// record the new importer with a justification in the commit message.
//
// ─── Detection ──────────────────────────────────────────────────────
//
// Flags a static `… from '@/lib/tauri'` (import or re-export) or a
// dynamic `import('@/lib/tauri')`. Comments are stripped first, so a
// commented-out or documented import is not counted. The sibling modules
// `@/lib/tauri-mock` / `@/lib/tauri-mock/…` do NOT match (the specifier
// must be exactly `@/lib/tauri`).
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Scans `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts[x]`,
// `__tests__/`, `/tests/`) and `.d.ts`. The wrapper module itself
// (`src/lib/tauri.ts`) does not import itself, so it never appears.
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

// A static `from '@/lib/tauri'` (import or re-export) or a dynamic
// `import('@/lib/tauri')`. The trailing quote in the character class
// keeps `@/lib/tauri-mock` from matching.
const STATIC_RE = /from\s*(['"])@\/lib\/tauri\1/
const DYNAMIC_RE = /import\(\s*(['"])@\/lib\/tauri\1\s*\)/

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/**` for `*.ts` / `*.tsx` files, excluding test files and
 * `__tests__/` + `tests/` directories. The baseline tracks non-test
 * app code only (test files may mock `@/lib/tauri` freely).
 */
function listSourceFiles(srcDir = SRC_DIR) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
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
  visit(srcDir)
  return out
}

/**
 * Replace block comments (`/* … *\/`, incl. JSDoc) and line comments
 * (`// …`) with spaces so a documented/commented-out import of
 * `@/lib/tauri` is not counted.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/** Does `src` import (statically or dynamically) `@/lib/tauri`? */
function importsTauri(src) {
  const stripped = stripComments(src)
  return STATIC_RE.test(stripped) || DYNAMIC_RE.test(stripped)
}

// ─── analysis ───────────────────────────────────────────────────────

/**
 * Compute the live importer set under `srcDir` and diff it against
 * `baseline` (an array of POSIX repo-relative paths). Pure over the
 * filesystem so the self-test can drive it against a synthetic tree.
 * Returns `{ importers, newImporters, staleBaseline, scanned }`.
 */
function analyze({ root, srcDir, baseline }) {
  const baselineSet = new Set(baseline)
  const importers = []
  let scanned = 0
  for (const file of listSourceFiles(srcDir)) {
    scanned += 1
    const src = fs.readFileSync(file, 'utf8')
    if (importsTauri(src)) importers.push(toPosix(path.relative(root, file)))
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

// ─── main ───────────────────────────────────────────────────────────

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
  const { importers } = analyze({ root: ROOT, srcDir: SRC_DIR, baseline: [] })
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
  const { importers, newImporters, staleBaseline } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
    baseline,
  })

  let failed = false

  if (newImporters.length > 0) {
    failed = true
    console.error('ERROR: new import(s) of `@/lib/tauri` in app code:')
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
  }

  if (staleBaseline.length > 0) {
    failed = true
    console.error('ERROR: stale entr(ies) in the tauri-import baseline — these files no longer')
    console.error('import `@/lib/tauri` and must be pruned so the count ratchets down:')
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

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives analyze() against a synthetic src tree so the guard's own exit
// behavior is verified: a baselined importer PASSES, a NEW importer is
// flagged, a STALE baseline entry is flagged, a dynamic import counts, a
// `@/lib/tauri-mock` import does NOT count, a commented import does NOT
// count, and test files are ignored.
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
    for (const d of [libDir, compDir, testDir]) fs.mkdirSync(d, { recursive: true })

    // Baselined importer → clean.
    fs.writeFileSync(
      path.join(compDir, 'Baselined.tsx'),
      "import { createBlock } from '@/lib/tauri'\nexport const C = () => createBlock()\n",
    )
    // New importer NOT in baseline → violation.
    fs.writeFileSync(
      path.join(compDir, 'NewImporter.tsx'),
      "import { deleteBlock } from '@/lib/tauri'\nexport const D = () => deleteBlock()\n",
    )
    // Dynamic import, in baseline → clean (and proves dynamic detection).
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

    const baseline = [
      'src/components/Baselined.tsx',
      'src/components/Dynamic.tsx',
      'src/components/Migrated.tsx', // stale: file no longer imports the wrapper
    ]
    const { newImporters, staleBaseline } = analyze({ root: tmp, srcDir, baseline })

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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
