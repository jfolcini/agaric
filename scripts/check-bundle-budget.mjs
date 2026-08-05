#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Bundle-size regression gate (#750).
//
// Vite's Rolldown config hand-tunes `codeSplitting.groups` with a rationale: the
// single-bundle default pushed the entry chunk past 1.8 MB raw, tripping
// Vite's 500 kB warning and slowing first-paint parse on low-end / Android
// devices. That tuning is invisible to CI — any new STATIC import (someone
// statically importing mermaid / a heavy vendor lib into the entry path)
// silently reverts the work and nothing fails.
//
// This gate measures the gzip size of each named chunk in a fresh
// production build and compares it against a checked-in per-chunk budget.
// A chunk over its budget fails the build with the offending delta. The
// budgets are MEASURED (built the bundle, read the number) plus headroom,
// never invented — see scripts/bundle-budgets.json for the provenance.
//
// Usage:
//   npm run build                       # produce dist/
//   node scripts/check-bundle-budget.mjs            # gate against budgets
//   node scripts/check-bundle-budget.mjs --update   # re-baseline from dist/
//
// Exit: 0 = every chunk within budget; 1 = at least one chunk over, or a
//       declared vendor chunk or its budget is missing.
// ─────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { VENDOR_CHUNK_GROUPS } from './vendor-chunk-groups.ts'

const __dirname = import.meta.dirname
const REPO_ROOT = join(__dirname, '..')
const DIST_ASSETS = join(REPO_ROOT, 'dist', 'assets')
const BUDGETS_PATH = join(__dirname, 'bundle-budgets.json')

// Allowed growth before the gate fails, as a fraction of the budgeted
// Gzip size. value is the entry chunk staying small; 10% lets
// ordinary feature growth through while catching a heavy static import
// (which moves a chunk by far more than 10%).
const GROWTH_TOLERANCE = 0.1

/**
 * Map a hashed asset filename to its logical chunk name.
 * `editor-M_1CiEOP.js` -> `editor`; `index-DE2apdo9.js` -> `index`.
 * Returns null for files we can't confidently de-hash.
 */
function logicalName(file) {
  // Vite/Rolldown content hashes are 8 base64url chars — [A-Za-z0-9_-], which
  // DOES include `-` (e.g. `index-DdAc-Z5m.js`, `react-vendor-oz-_EXyL.js`).
  // Pin the hash to exactly the 8 chars before `.js` and keep the logical-name
  // part GREEDY so hyphenated group names (`react-vendor`, `ui-radix`) and
  // hyphenated hashes both parse. The split is unambiguous because the hash is
  // always the 8 chars immediately before `.js`, preceded by a `-`.
  const m = file.match(/^(.+)-[A-Za-z0-9_-]{8}\.js$/)
  return m ? m[1] : null
}

/** gzip size (level 9, deterministic) of a dist asset, in bytes. */
function gzipBytes(file) {
  return gzipSync(readFileSync(join(DIST_ASSETS, file)), { level: 9 }).length
}

/** Build { logicalName: gzipBytes } for every .js chunk in dist/assets. */
function measureDist() {
  if (!existsSync(DIST_ASSETS)) {
    console.error(`ERROR: ${DIST_ASSETS} not found. Run \`npm run build\` first.`)
    process.exit(1)
  }
  const sizes = {}
  for (const file of readdirSync(DIST_ASSETS)) {
    if (!file.endsWith('.js')) continue
    const name = logicalName(file)
    if (!name) continue
    // A logical name should be unique per build; if not, retain the largest
    // emitted asset so the result is deterministic.
    const gz = gzipBytes(file)
    if (sizes[name] === undefined || gz > sizes[name]) sizes[name] = gz
  }
  return sizes
}

function loadBudgets() {
  const raw = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'))
  return raw.chunks
}

function writeBudgets(sizes, tracked) {
  const chunks = {}
  for (const name of tracked) {
    if (sizes[name] === undefined) {
      console.error(`ERROR: tracked chunk "${name}" not present in the build — cannot re-baseline.`)
      process.exit(1)
    }
    // Budget = measured + tolerance headroom, rounded up to a whole byte.
    chunks[name] = Math.ceil(sizes[name] * (1 + GROWTH_TOLERANCE))
  }
  const doc = {
    _comment:
      'Bundle-size budgets (#750) — per-chunk gzip ceiling in bytes. ' +
      'MEASURED from a real production build (npm run build) plus a ' +
      `${Math.round(GROWTH_TOLERANCE * 100)}% headroom margin, then ` +
      'checked in. Regenerate with `node scripts/check-bundle-budget.mjs ' +
      '--update` after an intentional, reviewed size change. The ' +
      "check-bundle-budget gate fails when a chunk's gzip size exceeds " +
      'its budget here.',
    measuredAt:
      'Baseline gzip sizes at generation time were below these budgets ' +
      'by the headroom margin; see git history for the build that set them.',
    chunks,
  }
  writeFileSync(BUDGETS_PATH, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`Wrote ${BUDGETS_PATH}`)
}

// `index` is Vite's entry chunk; every other tracked name comes directly from
// the same config array Rolldown consumes. A newly declared vendor group can
// therefore never be silently omitted from the budget gate.
export const TRACKED = Object.freeze(['index', ...VENDOR_CHUNK_GROUPS.map((group) => group.name)])

/**
 * Evaluate measured gzip sizes against the complete tracked-name set.
 * Exported for a fixture-level regression that proves a declared group with no
 * checked-in budget fails the same path used by the production gate.
 */
export function evaluateBudgets(sizes, budgets, tracked = TRACKED) {
  const failures = []
  const missing = []
  const seen = new Set()

  for (const name of tracked) {
    if (seen.has(name)) {
      missing.push(`tracked chunk name "${name}" is declared more than once`)
    }
    seen.add(name)
  }

  for (const name of Object.keys(budgets)) {
    if (!seen.has(name)) {
      missing.push(`stale budget for undeclared chunk "${name}" in ${BUDGETS_PATH}`)
    }
  }

  for (const name of seen) {
    const budget = budgets[name]
    if (budget === undefined) {
      missing.push(`budget for tracked chunk "${name}" missing from ${BUDGETS_PATH}`)
      continue
    }
    const gz = sizes[name]
    if (gz === undefined) {
      // A tracked chunk vanished — the declared code-splitting group changed (a
      // heavy lib got merged into the entry chunk, say). That is exactly
      // the regression class this gate exists to catch.
      missing.push(`tracked chunk "${name}" not found in dist/ — codeSplitting group changed?`)
      continue
    }
    if (gz > budget) {
      const overPct = ((gz / budget - 1) * 100).toFixed(1)
      failures.push(`${name}: ${gz} B gzip > budget ${budget} B (+${overPct}% over budget)`)
    }
  }

  return { failures, missing, ok: failures.length === 0 && missing.length === 0 }
}

function main() {
  const update = process.argv.includes('--update')
  const sizes = measureDist()

  if (update) {
    writeBudgets(sizes, TRACKED)
    return 0
  }

  const budgets = loadBudgets()
  const { failures, missing, ok } = evaluateBudgets(sizes, budgets)

  if (!ok) {
    console.error('Bundle-size budget gate (#750) failed:\n')
    for (const m of missing) console.error(`  MISSING: ${m}`)
    for (const f of failures) console.error(`  OVER:    ${f}`)
    console.error(
      '\n  -> A chunk grew past its gzip budget. If a heavy module landed on\n' +
        '     the entry/critical path via a new STATIC import, lazy-load it\n' +
        '     (dynamic import()) or add it to VENDOR_CHUNK_GROUPS. If\n' +
        '     the growth is intentional and\n' +
        '     reviewed, re-baseline:\n' +
        '       npm run build && node scripts/check-bundle-budget.mjs --update',
    )
    return 1
  }

  console.log('Bundle-size budget gate (#750): all tracked chunks within budget.')
  for (const name of TRACKED) {
    console.log(`  ${name.padEnd(14)} ${sizes[name]} B gzip / ${budgets[name]} B budget`)
  }
  return 0
}

const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) process.exit(main())
