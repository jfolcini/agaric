// ────────────────────────────────────────────────────────────────────
// No-raw-localStorage guard (#2466).
//
// `src/lib/preferences.ts` is the typed preferences registry: every
// device/space/page-local preference is declared once (key, type,
// default, version, scope) as a `PreferenceDefinition`, consumed via
// `usePreference` / `readPreference` / `writePreference` /
// `hasPreference` / `removePreference` — accessors that never throw. A
// raw `localStorage.getItem(...)` / `.setItem(...)` bypass sidesteps
// that contract entirely — a typo'd key, an unvalidated shape, or a
// forgotten try/catch compiles clean and only fails at runtime (or
// silently corrupts a stored value). This guard forbids the raw
// pattern in NEW app code so the registry stays the single place a
// preference's storage key is declared.
//
// ─── Detection ─────────────────────────────────────────────────────────
//
// Flags `localStorage.<method>(` and `window.localStorage.<method>(` for
// `getItem` / `setItem` / `removeItem` / `clear`. Comments are stripped
// before scanning, so a commented-out or documented call is not a
// violation. Access through an intermediate variable (e.g.
// `const storage = localStorage; storage.getItem(...)`) is NOT matched —
// mirrors `check-raw-invoke.mjs`'s documented scope, and covers the
// handful of one-time legacy-key migration readers that pre-date this
// guard.
//
// ─── Scope / exemptions ────────────────────────────────────────────
//
// Scans `src/**/*.{ts,tsx}`, excluding test files (`*.test.ts[x]`,
// `__tests__/`, `/tests/`). Two kinds of exemption:
//
//   - `src/lib/preferences.ts` itself — the registry's own
//     implementation IS the sanctioned raw-localStorage call site.
//   - A grandfather list of pre-#2466 call sites intentionally NOT
//     migrated in that pass (see `preferences.ts`'s file header for the
//     per-file rationale — mostly `useSyncExternalStore` + synthetic-
//     `StorageEvent`-dispatch hooks and modules with their own
//     caching/migration-fallback semantics that a mechanical migration
//     would risk breaking). Removing a file from this list as it
//     migrates is expected and welcome; ADDING one back requires the
//     same "why not the registry" justification as the original
//     grandfather entry.
//
// A NEW file (not on the grandfather list) or a NEW call site inside an
// already-exempt file's UNRELATED code is still flagged — the grandfather
// list is per-file, not a blanket opt-out for the whole codebase.
//
// Usage: node scripts/check-raw-local-storage.mjs
//        node scripts/check-raw-local-storage.mjs --self-test
// Exit:  0 = clean, 1 = at least one violation, 2 = repo layout /
//        self-test failure.
// ────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

// Repo-relative (POSIX) exact-file exemptions.
const EXEMPT_FILES = Object.freeze(
  new Set([
    // The registry implementation itself.
    'src/lib/preferences.ts',
    // Generic typed localStorage-backed useState — a sanctioned
    // alternative accessor layer alongside (not instead of) the
    // registry; `usePreference` delegates to it, and a handful of
    // pre-registry call sites (useAgendaPreferences.ts, etc.) still use
    // it directly with their own key/parse/serialize.
    'src/hooks/useLocalStoragePreference.ts',
    // useSyncExternalStore + synthetic same-tab StorageEvent dispatch
    // carrying the exact raw old/new string — readPreference/
    // writePreference only expose the typed value, not the raw string
    // the dispatch needs.
    'src/hooks/useTheme.ts',
    'src/hooks/useWeekStart.ts',
    'src/hooks/useJournalDateFormat.ts',
    'src/hooks/useExternalImagePolicy.ts',
    // Module-level parsed-value cache keyed on the raw string,
    // invalidated by both same-module writes and a `storage` listener —
    // the caching behavior itself is the point of this module.
    'src/lib/keyboard-config/storage.ts',
    // readFrequency()'s legacy-MRU migration fallback depends on
    // distinguishing "key absent" from "key present but empty", which
    // readPreference's default-collapsing would erase.
    'src/hooks/useEmojiRecents.ts',
    // Legacy-format auto-detection transform (canonical FilterPredicate[]
    // vs. pre-migration GraphFilter[]) embedded in the read path.
    'src/components/graph/GraphFilterBar.tsx',
    // One-time legacy default resolver for a useLocalStoragePreference-
    // backed key; not a store this guard's contract targets.
    'src/components/journal/UnfinishedTasks.tsx',
  ]),
)

// `localStorage.<method>(` or `window.localStorage.<method>(`.
const RAW_STORAGE_RE = /\b(?:window\.)?localStorage\.(getItem|setItem|removeItem|clear)\s*\(/g

// ─── helpers ───────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk `src/**` for `*.ts` / `*.tsx` files, excluding test files and
 * `__tests__/` + `tests/` directories.
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

function isExempt(rel) {
  return EXEMPT_FILES.has(rel)
}

/**
 * Replace block comments (`/* … *\/`, incl. JSDoc) and line comments
 * (`// …`) with spaces so a documented/commented-out call is not
 * flagged. Newlines inside block comments are preserved so line numbers
 * stay accurate for reporting.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/**
 * Return the raw-localStorage violations in a single source string as an
 * array of `{ line, method }`.
 */
function scanSource(src) {
  const stripped = stripComments(src)
  const violations = []
  for (const match of stripped.matchAll(RAW_STORAGE_RE)) {
    const upto = stripped.slice(0, match.index)
    const line = upto.split('\n').length
    violations.push({ line, method: match[1] })
  }
  return violations
}

// ─── analysis ─────────────────────────────────────────────────────────────

/**
 * Analyze all source files under `srcDir` for raw-localStorage
 * violations, honoring the exemption list. Pure over the filesystem so
 * the self-test can drive it against a synthetic tree. Returns
 * `{ violations, scanned }`.
 */
function analyze({ root, srcDir }) {
  const violations = []
  let scanned = 0
  for (const file of listSourceFiles(srcDir)) {
    const rel = toPosix(path.relative(root, file))
    if (isExempt(rel)) continue
    scanned += 1
    const src = fs.readFileSync(file, 'utf8')
    for (const v of scanSource(src)) {
      violations.push({ file: rel, line: v.line, method: v.method })
    }
  }
  return { violations, scanned }
}

// ─── main ────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else {
  runGuard()
}

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }

  const { violations, scanned } = analyze({ root: ROOT, srcDir: SRC_DIR })

  if (violations.length > 0) {
    console.error('ERROR: raw localStorage calls found in app code:')
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  localStorage.${v.method}(…)`)
    }
    console.error('')
    console.error('Declare the preference in src/lib/preferences.ts (PREFERENCES) and use the')
    console.error('typed accessors instead of a raw localStorage call:')
    console.error('')
    console.error(
      "    import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'",
    )
    console.error('    const value = readPreference(PREFERENCES.myPreference)')
    console.error('    writePreference(PREFERENCES.myPreference, next)')
    console.error('')
    console.error("If a raw call is genuinely required (see preferences.ts's file header for the")
    console.error('standing exemption categories), add the file to EXEMPT_FILES in')
    console.error('scripts/check-raw-local-storage.mjs with a justification.')
    process.exit(1)
  }

  console.log(`OK: ${scanned} source file(s) scanned, no raw localStorage calls in app code`)
}

// ─── self-test ───────────────────────────────────────────────────────────────
//
// Drives analyze() against a synthetic src tree so the guard's exit
// behavior is itself verified: a raw call FAILS, a registry accessor
// call PASSES, a commented call PASSES, an exempt-file raw call PASSES,
// a variable-indirection call PASSES, and a test file is ignored.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-local-storage-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const hooksDir = path.join(srcDir, 'hooks')
    const compDir = path.join(srcDir, 'components')
    const testDir = path.join(compDir, '__tests__')
    for (const d of [libDir, hooksDir, compDir, testDir]) fs.mkdirSync(d, { recursive: true })

    // 1. Raw getItem in a component → violation.
    fs.writeFileSync(
      path.join(compDir, 'Bad.tsx'),
      "export const C = () => localStorage.getItem('agaric-foo')\n",
    )
    // 2. Raw window.localStorage.setItem → violation.
    fs.writeFileSync(
      path.join(compDir, 'BadWindow.tsx'),
      "export const f = () => window.localStorage.setItem('agaric-foo', '1')\n",
    )
    // 3. Registry accessor call → clean.
    fs.writeFileSync(
      path.join(compDir, 'Good.tsx'),
      "import { PREFERENCES, readPreference } from '@/lib/preferences'\nexport const C = () => readPreference(PREFERENCES.foo)\n",
    )
    // 4. Commented / documented call → clean.
    fs.writeFileSync(
      path.join(compDir, 'Commented.tsx'),
      "// legacy: localStorage.getItem('foo') used to live here\n/** JSDoc: localStorage.setItem('x', '1') */\nexport const C = () => null\n",
    )
    // 5. Exempt file (preferences.ts) with a raw call → clean.
    fs.writeFileSync(
      path.join(libDir, 'preferences.ts'),
      "export const f = () => localStorage.getItem('agaric-foo')\n",
    )
    // 6. Exempt file (useTheme.ts) with a raw call → clean.
    fs.writeFileSync(
      path.join(hooksDir, 'useTheme.ts'),
      "export const f = () => localStorage.setItem('theme-preference', 'dark')\n",
    )
    // 7. Variable-indirection call → not matched (out of this guard's scope).
    fs.writeFileSync(
      path.join(compDir, 'Indirect.tsx'),
      "const storage = localStorage\nexport const f = () => storage.getItem('agaric-foo')\n",
    )
    // 8. Test file with a raw call → ignored (out of scope).
    fs.writeFileSync(
      path.join(testDir, 'Bad.test.tsx'),
      "it('x', () => localStorage.getItem('agaric-foo'))\n",
    )

    const { violations } = analyze({ root: tmp, srcDir })
    const hit = (f) => violations.some((v) => v.file === `src/${f}`)

    if (hit('components/Bad.tsx')) ok('raw getItem in component is flagged')
    else fail('raw getItem in component is flagged', JSON.stringify(violations))

    if (hit('components/BadWindow.tsx')) ok('raw window.localStorage.setItem is flagged')
    else fail('raw window.localStorage.setItem is flagged', JSON.stringify(violations))

    if (!hit('components/Good.tsx')) ok('registry accessor call passes')
    else fail('registry accessor call passes', 'Good.tsx was flagged')

    if (!hit('components/Commented.tsx')) ok('commented call passes')
    else fail('commented call passes', 'Commented.tsx was flagged')

    if (!hit('lib/preferences.ts')) ok('exempt registry file passes')
    else fail('exempt registry file passes', 'preferences.ts was flagged')

    if (!hit('hooks/useTheme.ts')) ok('exempt grandfathered file passes')
    else fail('exempt grandfathered file passes', 'useTheme.ts was flagged')

    if (!hit('components/Indirect.tsx')) ok('variable-indirection call passes')
    else fail('variable-indirection call passes', 'Indirect.tsx was flagged')

    if (!violations.some((v) => v.file.includes('__tests__'))) ok('test file is ignored')
    else fail('test file is ignored', 'a __tests__ file was flagged')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
