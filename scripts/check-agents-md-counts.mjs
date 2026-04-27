#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// AGENTS.md test-count drift check.
//
// Two AGENTS.md surfaces document concrete numeric counts that drift
// silently as the suite grows or shrinks. This script verifies the
// documented numbers are within tolerance of reality so the docs stay
// useful instead of decorative:
//
//   1. Root AGENTS.md mentions of "<N>+ tests" — the marketing-style
//      counts in the Build Commands block ("Vitest (7300+ tests)",
//      "Rust tests (3000+ tests)"). These are approximate by design
//      (the trailing `+`); the hook tolerates ±25% drift before
//      failing. Counts come from grep'ing `it(` / `test(` in
//      .test.ts(x) and `#[test]` / `#[tokio::test]` in src-tauri/src.
//
//   2. src/__tests__/AGENTS.md "<N> files" entries in the directory
//      tree — concrete counts like `components/__tests__/ — 136 files`
//      and `e2e/ — 26 spec files`. Each must be within ±25% of the
//      actual file count for that directory.
//
// Why ±25% and not ±20% or exact?
//   - The doc counts are intentionally round numbers ("7300+", not
//     "7917"). Hard equality forces a doc churn on every test add.
//   - 25% is loose enough to never false-fire on normal growth, tight
//     enough to catch the "doc says 100, actual is 1" class of drift
//     that MAINT-99 / MAINT-97 are aimed at.
//   - When the doc *should* be updated to reflect a new round number,
//     the hook still passes; the update is a separate doc PR.
//
// Why grep/regex instead of `vitest list` / `cargo nextest list`?
//   - Pre-commit hooks must be fast (<1s for this one). Spawning
//     vitest cold-starts takes ~10s; nextest cold-discovery similar.
//     Counting `it(` lines is O(file size) and ~50ms.
//   - The approximate count is *exactly what the docs claim* — the
//     `+` already encodes "near this number, not exactly". So an
//     approximate measurement against an approximate claim is fine.
//
// Usage: node scripts/check-agents-md-counts.mjs
// Exit:  0 = within tolerance, 1 = at least one count drifted >25%.
// ─────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOLERANCE = 0.25 // ±25%

const failures = []
const notes = []

// ─── helpers ────────────────────────────────────────────────────────

function withinTolerance(documented, actual) {
  if (documented === 0) return actual === 0
  const ratio = Math.abs(actual - documented) / documented
  return ratio <= TOLERANCE
}

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => {
    const full = path.join(dir, f)
    return fs.statSync(full).isFile() && predicate(f)
  })
}

// Count `it(` and `test(` calls in a single file.
function countItTestCalls(file) {
  const src = fs.readFileSync(file, 'utf8')
  const re = /^\s*(?:it|test)\s*[(.]/gm
  return (src.match(re) ?? []).length
}

// Count Rust #[test] and #[tokio::test] attributes in a single file.
function countRustTestAttrs(file) {
  const src = fs.readFileSync(file, 'utf8')
  const re = /^\s*#\[(?:tokio::)?test(?:\s*\(|\s*])/gm
  return (src.match(re) ?? []).length
}

function walkRecursive(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkRecursive(full, predicate, results)
    } else if (entry.isFile() && predicate(entry.name, full)) {
      results.push(full)
    }
  }
  return results
}

// ─── 1. Root AGENTS.md "<N>+ tests" mentions ────────────────────────
//
// Match patterns like `Vitest (7300+ tests)` and
// `Rust tests (2100+ tests)`. Each is associated with its runtime
// (vitest / rust) by surrounding context — we look back a short
// window for the keyword.

const rootAgents = path.join(ROOT, 'AGENTS.md')
const rootSrc = fs.readFileSync(rootAgents, 'utf8')

// Lazy actual-count cache (only computed if the doc references the count).
let vitestCountCache = null
let rustCountCache = null

function getVitestCount() {
  if (vitestCountCache !== null) return vitestCountCache
  const files = walkRecursive(path.join(ROOT, 'src'), (name) => /\.test\.(ts|tsx)$/.test(name))
  let total = 0
  for (const f of files) total += countItTestCalls(f)
  vitestCountCache = total
  return total
}

function getRustCount() {
  if (rustCountCache !== null) return rustCountCache
  const files = walkRecursive(path.join(ROOT, 'src-tauri/src'), (name) => /\.rs$/.test(name))
  let total = 0
  for (const f of files) total += countRustTestAttrs(f)
  rustCountCache = total
  return total
}

// Walk every `(\d+)\+? tests` mention (plural "tests" only — singular
// "test" overwhelmingly means "test framework" / "test timing" / etc.,
// e.g. "React 19 test timing"). Disambiguate vitest vs rust by the
// immediately-preceding token in the same line.
const TEST_COUNT_RE = /\b(\d{2,})\s*\+?\s+tests\b/g
for (const m of rootSrc.matchAll(TEST_COUNT_RE)) {
  const documented = parseInt(m[1], 10)
  // 30-char lookback window for context disambiguation.
  const lineStart = rootSrc.lastIndexOf('\n', m.index) + 1
  const context = rootSrc.slice(lineStart, m.index + m[0].length)
  let actual
  let label
  if (/Rust|cargo|nextest/i.test(context)) {
    actual = getRustCount()
    label = 'Rust tests'
  } else if (/Vitest|npm run test|vitest/i.test(context)) {
    actual = getVitestCount()
    label = 'Vitest tests'
  } else {
    // No clear runtime keyword — skip rather than guess.
    notes.push(
      `SKIP: ambiguous "${m[0]}" mention in AGENTS.md (no Rust/Vitest keyword on the same line)`,
    )
    continue
  }
  if (withinTolerance(documented, actual)) {
    notes.push(`OK: AGENTS.md "${m[0]}" (${label}) within ±25% of actual ${actual}`)
  } else {
    failures.push(
      `AGENTS.md ${label} count drifted: doc says ~${documented}, actual is ${actual} ` +
        `(${(((actual - documented) / documented) * 100).toFixed(0)}% off, threshold ±25%)`,
    )
  }
}

// ─── 2. src/__tests__/AGENTS.md "<N> files" entries ─────────────────
//
// The directory-tree block enumerates each test directory with a
// trailing `— <N> files` (or `— <N> spec files` for e2e/). Match the
// path on the same line so we know which directory to count.

const childAgents = path.join(ROOT, 'src/__tests__/AGENTS.md')
const childSrc = fs.readFileSync(childAgents, 'utf8')

// Each entry pairs a relative path with a count. Examples:
//   `components/__tests__/         # Component tests (.test.tsx) — 136 files`
//   `e2e/                              # 26 Playwright spec files`
const DIR_COUNT_ENTRIES = [
  {
    label: 'src/components/__tests__',
    pattern: /components\/__tests__\/[^—]*—\s*(\d+)\s+files/,
    count: () =>
      listFiles(path.join(ROOT, 'src/components/__tests__'), (n) => /\.test\.(ts|tsx)$/.test(n))
        .length,
  },
  {
    label: 'src/editor/__tests__',
    pattern: /editor\/__tests__\/[^—]*—\s*(\d+)\s+files/,
    count: () =>
      listFiles(path.join(ROOT, 'src/editor/__tests__'), (n) => /\.test\.(ts|tsx)$/.test(n)).length,
  },
  {
    label: 'src/stores/__tests__',
    pattern: /stores\/__tests__\/[^—]*—\s*(\d+)\s+files/,
    count: () =>
      listFiles(path.join(ROOT, 'src/stores/__tests__'), (n) => /\.test\.(ts|tsx)$/.test(n)).length,
  },
  {
    label: 'src/hooks/__tests__',
    pattern: /hooks\/__tests__\/[^—]*—\s*(\d+)\s+files/,
    count: () =>
      listFiles(path.join(ROOT, 'src/hooks/__tests__'), (n) => /\.test\.(ts|tsx)$/.test(n)).length,
  },
  {
    label: 'src/lib/__tests__',
    pattern: /lib\/__tests__\/[^—]*—\s*(\d+)\s+files/,
    count: () =>
      listFiles(path.join(ROOT, 'src/lib/__tests__'), (n) => /\.test\.(ts|tsx)$/.test(n)).length,
  },
  {
    label: 'e2e (spec files)',
    pattern: /e2e\/[^—]*—\s*(\d+)\s+(?:Playwright\s+)?spec\s+files/,
    count: () => listFiles(path.join(ROOT, 'e2e'), (n) => /\.spec\.ts$/.test(n)).length,
  },
]

for (const entry of DIR_COUNT_ENTRIES) {
  const m = childSrc.match(entry.pattern)
  if (!m) {
    notes.push(`SKIP: no documented file count for ${entry.label} in src/__tests__/AGENTS.md`)
    continue
  }
  const documented = parseInt(m[1], 10)
  const actual = entry.count()
  if (withinTolerance(documented, actual)) {
    notes.push(`OK: ${entry.label} doc=${documented}, actual=${actual} (within ±25%)`)
  } else {
    failures.push(
      `${entry.label} file-count drifted: doc says ${documented}, actual is ${actual} ` +
        `(${(((actual - documented) / documented) * 100).toFixed(0)}% off, threshold ±25%)`,
    )
  }
}

// ─── Report ─────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('ERROR: AGENTS.md test-count drift detected:')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('')
  console.error(
    'Update the affected number(s) in AGENTS.md / src/__tests__/AGENTS.md to match reality.',
  )
  console.error(
    'Tolerance is ±25% — only large drifts fail. Pick a round number that brackets the current count.',
  )
  if (process.env.CHECK_AGENTS_MD_VERBOSE === '1') {
    console.error('')
    for (const n of notes) console.error(`  ${n}`)
  }
  process.exit(1)
}

if (process.env.CHECK_AGENTS_MD_VERBOSE === '1') {
  for (const n of notes) console.log(n)
}
console.log(
  `OK: ${notes.filter((n) => n.startsWith('OK:')).length} AGENTS.md count(s) within ±25% of reality.`,
)
