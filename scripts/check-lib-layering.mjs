#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Frontend tier-layering ratchet guard (#3121).
//
// `src/lib/` is a 40.7K-LOC, 118-top-level-file flat namespace with no
// admission criteria: pure utilities, IPC wrappers, i18n, logging, and
// graph-simulation code all sit side by side, and nothing stops a "pure"
// helper from reaching into a Zustand store or a React hook. Backend
// layering is enforced by cargo's acyclic crate graph
// (agaric-core -> agaric-store -> agaric-engine -> agaric-sync -> app);
// the frontend has no equivalent above the `ui/` primitives.
// `check-import-cycles.mjs` (#761) proves the graph has no *loop*, which is
// a different property from proving dependencies flow one way — a pure
// util importing a store is perfectly acyclic and still breaks layering.
//
// This is step 1 of #3121's suggested direction: name the tiers and add a
// direction guard with a ratcheted baseline, so the violation count can
// only go down from here. Step 2 (splitting `src/lib/` by concern to burn
// the baseline down, and carving out a `lib/ipc` leaf) is deliberately OUT
// of scope for this guard — it moves no files and fixes no violations.
//
// ─── The tiers (low to high) ─────────────────────────────────────────
//
//   lib/ (rank 0)  <-  stores/ (rank 1)  <-  hooks/ (rank 2)  <-  components/ (rank 3)
//
// Read the arrow as "is depended on by": `lib/` is the foundation and may
// only depend on itself (plus external packages); `stores/` may depend on
// `lib/` and itself; `hooks/` may depend on `lib/`, `stores/`, and itself;
// `components/` may depend on all three plus itself. A LOWER-ranked module
// may never import a HIGHER-ranked one. That is the whole rule — it is
// deliberately narrower than a full concern-based scheme (e.g. it says
// nothing about `lib/ipc` vs. "pure" `lib/`, which is left to a later,
// mechanical splitting step) because a minimal cut that's easy to state
// and easy to keep green is worth more than an elaborate one nobody
// follows.
//
// `src/editor/`, `src/workers/`, `src/types/`, and everything else outside
// these four directories is out of scope: this guard neither scans them as
// importers nor treats imports of them as violations.
//
// ─── How it works ─────────────────────────────────────────────────────
//
// `scripts/lib-layering-baseline.json` is a committed, sorted JSON array of
// every non-test file (under the four tiers) that CURRENTLY imports a
// higher-ranked tier. On each run the guard recomputes the live violator
// set and FAILS if:
//
//   - a file imports a higher-ranked tier but is NOT in the baseline (a
//     NEW violation — the count went up), or
//   - a baseline entry no longer has any such import (a STALE entry — it
//     must be pruned so the count ratchets DOWN as violations are fixed;
//     a green suite against a stale baseline would otherwise hide the win
//     and let the count silently creep back up if the import returns).
//
// When you fix a file's layering, remove its baseline entry (or run
// `--update-baseline`). When a genuinely new upward dependency is added,
// either restructure to avoid it or, if it's an intentional exception,
// add it via `--update-baseline` and justify it in the commit — this
// guard has no per-edge allowlist, unlike `check-store-layering.mjs`.
//
// Import detection reuses `detectImports` from `check-import-cycles.mjs`
// (comment- and string-literal-aware, so text that merely *looks* like an
// import inside a string/template/comment is never counted). Only the
// project's `@/` alias and relative (`./`, `../`) specifiers are resolved
// to a tier; bare specifiers (node_modules) are out of scope.
//
// ─── Scope ─────────────────────────────────────────────────────────────
//
// Scans `src/lib/**`, `src/stores/**`, `src/hooks/**`, `src/components/**`
// (`.ts`/`.tsx`), excluding test files (`*.test.ts[x]`, `__tests__/`,
// `tests/` directories) and `.d.ts`.
//
// Usage: node scripts/check-lib-layering.mjs
//        node scripts/check-lib-layering.mjs --update-baseline
// Exit:  0 clean, 1 = drift (new violation or stale baseline entry),
//        2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

import { detectImports } from './check-import-cycles.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'lib-layering-baseline.json')

/** Tier directories (directly under `src/`) and their rank, low (foundation) to high. */
const TIERS = [
  { name: 'lib', rank: 0 },
  { name: 'stores', rank: 1 },
  { name: 'hooks', rank: 2 },
  { name: 'components', rank: 3 },
]
const TIER_RANK = new Map(TIERS.map((t) => [t.name, t.rank]))

// ─── helpers ────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/**
 * Walk a tier directory for `.ts`/`.tsx` files, excluding test files and
 * `__tests__`/`tests` directories. Baseline tracks non-test app code only.
 */
function listSourceFiles(dir) {
  const out = []
  const visit = (d) => {
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
  if (fs.existsSync(dir)) visit(dir)
  return out
}

/**
 * Resolve an import specifier to the tier it targets, without touching the
 * filesystem: only the `@/` alias and relative specifiers are understood,
 * and only the FIRST path segment under `srcDir` matters (e.g. `@/lib/foo`
 * and `../../lib/bar/baz` both resolve to the `lib` tier). Bare specifiers
 * (node_modules) and anything outside the four named tiers (e.g.
 * `@/editor/...`, `@/types/...`) return `null` — out of scope for this
 * guard.
 *
 * `srcDir` is threaded through explicitly (rather than reading the
 * module-level `SRC_DIR` constant) so relative-specifier resolution can be
 * driven against an arbitrary tree instead of the real repo.
 *
 * @param {string} spec raw specifier text
 * @param {string} fromFile absolute path of the importing file
 * @param {string} srcDir absolute path of the `src/` root to resolve against
 * @returns {string | null} tier name, or null if out of scope
 */
export function specifierTier(spec, fromFile, srcDir) {
  let logicalRel
  if (spec.startsWith('@/')) {
    logicalRel = spec.slice(2)
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = path.resolve(path.dirname(fromFile), spec)
    logicalRel = toPosix(path.relative(srcDir, abs))
  } else {
    return null // bare specifier — external package
  }
  const first = logicalRel.split('/')[0]
  return TIER_RANK.has(first) ? first : null
}

/**
 * Compute the live set of layering-violating files (files under a tier
 * directory that import a HIGHER-ranked tier) and diff it against
 * `baseline` (an array of POSIX repo-relative paths). Pure over the
 * filesystem, so it can be driven against an arbitrary tree.
 *
 * @returns {{ violators: string[], details: Map<string, string[]>,
 *   newViolators: string[], staleBaseline: string[], scanned: number }}
 *   `details` maps a violator's repo-relative path to the higher tiers it
 *   illegally imports (for the error message only — not baseline schema).
 */
export function analyze({ root, srcDir, baseline }) {
  const baselineSet = new Set(baseline)
  const violators = []
  const details = new Map()
  let scanned = 0

  for (const tier of TIERS) {
    const tierDir = path.join(srcDir, tier.name)
    for (const file of listSourceFiles(tierDir)) {
      scanned += 1
      const src = fs.readFileSync(file, 'utf8')
      const badTiers = new Set()
      for (const spec of detectImports(src)) {
        const targetTier = specifierTier(spec, file, srcDir)
        if (targetTier && TIER_RANK.get(targetTier) > tier.rank) {
          badTiers.add(targetTier)
        }
      }
      if (badTiers.size > 0) {
        const rel = toPosix(path.relative(root, file))
        violators.push(rel)
        details.set(rel, [...badTiers].toSorted())
      }
    }
  }

  violators.sort()
  const violatorSet = new Set(violators)
  const newViolators = violators.filter((f) => !baselineSet.has(f))
  const staleBaseline = [...baselineSet].filter((f) => !violatorSet.has(f)).toSorted()
  return { violators, details, newViolators, staleBaseline, scanned }
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return []
  const raw = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (!Array.isArray(raw)) {
    throw new Error(`baseline file is not a JSON array: ${BASELINE_FILE}`)
  }
  return raw
}

function writeBaseline(violators) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(violators, null, 2)}\n`)
}

function updateBaseline() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
  const { violators } = analyze({ root: ROOT, srcDir: SRC_DIR, baseline: [] })
  writeBaseline(violators)
  console.log(
    `OK: wrote baseline with ${violators.length} layering violation(s) to ${path.relative(ROOT, BASELINE_FILE)}`,
  )
}

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`ERROR: baseline file not found: ${BASELINE_FILE}`)
    console.error('Seed it with: node scripts/check-lib-layering.mjs --update-baseline')
    process.exit(2)
  }

  const baseline = readBaseline()
  const { violators, details, newViolators, staleBaseline } = analyze({
    root: ROOT,
    srcDir: SRC_DIR,
    baseline,
  })

  let failed = false

  if (newViolators.length > 0) {
    failed = true
    console.error('ERROR: new tier-layering violation(s) — a lower tier must never import a')
    console.error('higher one (lib < stores < hooks < components, #3121):')
    for (const f of newViolators) {
      const targets = details.get(f)?.join(', ') ?? '?'
      console.error(`  ${f}  (imports: ${targets})`)
    }
    console.error('')
    console.error(
      'Restructure to avoid the upward dependency, or if this is an intentional exception,',
    )
    console.error(
      'run `node scripts/check-lib-layering.mjs --update-baseline` and justify it in the commit.',
    )
  }

  if (staleBaseline.length > 0) {
    failed = true
    console.error('ERROR: stale entr(ies) in the lib-layering baseline — these files no longer')
    console.error('have an upward import and must be pruned so the count ratchets down:')
    for (const f of staleBaseline) console.error(`  ${f}`)
    console.error('')
    console.error('Prune them with:  node scripts/check-lib-layering.mjs --update-baseline')
  }

  if (failed) process.exit(1)

  console.log(
    `OK: ${violators.length} baseline layering violation(s), no new violations, no stale entries ` +
      `(lib < stores < hooks < components)`,
  )
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}
