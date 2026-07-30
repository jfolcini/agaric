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
//        node scripts/check-lib-layering.mjs --self-test
// Exit:  0 clean, 1 = drift (new violation or stale baseline entry),
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
 * module-level `SRC_DIR` constant) so the self-test can drive relative-
 * specifier resolution against its synthetic tree instead of the real repo.
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
 * filesystem so the self-test can drive it against a synthetic tree.
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

// ─── self-test ──────────────────────────────────────────────────────
//
// Drives analyze()/specifierTier() against a synthetic src tree so the
// guard's own exit behavior is verified: a legal (downward) import PASSES,
// an illegal (upward) NEW import is flagged, a BASELINED upward import
// PASSES, and a STALE baseline entry (fixed, no longer imports upward) is
// flagged.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-layering-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const srcDir = path.join(tmp, 'src')
    const libDir = path.join(srcDir, 'lib')
    const storesDir = path.join(srcDir, 'stores')
    const hooksDir = path.join(srcDir, 'hooks')
    const compDir = path.join(srcDir, 'components')
    const testDir = path.join(hooksDir, '__tests__')
    const altTestDir = path.join(libDir, 'tests')
    for (const d of [libDir, storesDir, hooksDir, compDir, testDir, altTestDir]) {
      fs.mkdirSync(d, { recursive: true })
    }

    // Legal: a hook importing a store (downward) → clean.
    fs.writeFileSync(
      path.join(hooksDir, 'useThing.ts'),
      "import { useBlocksStore } from '@/stores/blocks'\nexport const useThing = () => useBlocksStore()\n",
    )
    // Illegal, NEW: a pure lib util importing a store (upward) → violation.
    fs.writeFileSync(
      path.join(libDir, 'newOffender.ts'),
      "import { useBlocksStore } from '@/stores/blocks'\nexport const f = () => useBlocksStore()\n",
    )
    // Illegal, but BASELINED: a store importing a component (upward) → clean
    // (recorded in the baseline passed to analyze()).
    fs.writeFileSync(
      path.join(storesDir, 'legacyOffender.ts'),
      "import { Widget } from '@/components/Widget'\nexport const w = Widget\n",
    )
    // STALE baseline entry: this file used to import upward but has been
    // fixed (only imports its own tier now) — must be flagged so the
    // baseline is pruned.
    fs.writeFileSync(
      path.join(hooksDir, 'fixedOffender.ts'),
      "import { helper } from '@/hooks/helper'\nexport const g = helper\n",
    )
    // Relative-specifier upward import, also NEW → proves relative
    // resolution (not just the `@/` alias) is checked.
    fs.writeFileSync(
      path.join(libDir, 'relativeOffender.ts'),
      "import { useThing } from '../hooks/useThing'\nexport const h = useThing\n",
    )
    // Out-of-scope target (`@/editor/...`) → not a violation either way.
    fs.writeFileSync(
      path.join(libDir, 'touchesEditor.ts'),
      "import { Foo } from '@/editor/Foo'\nexport const e = Foo\n",
    )
    // Test file with an upward import → ignored entirely.
    fs.writeFileSync(
      path.join(testDir, 'ignored.test.ts'),
      "import { Widget } from '@/components/Widget'\nexport const t = Widget\n",
    )
    // A `tests/` (not `__tests__`) directory is excluded by DIRECTORY NAME
    // alone — this file's own name doesn't match the `.test.ts` filename
    // filter, so it's only caught if the 'tests' directory exclusion holds.
    fs.writeFileSync(
      path.join(altTestDir, 'fixture-helper.ts'),
      "import { Widget } from '@/components/Widget'\nexport const t2 = Widget\n",
    )
    // `.d.ts` declaration files are excluded even with an upward import.
    fs.writeFileSync(
      path.join(libDir, 'ambient.d.ts'),
      "import type { Widget } from '@/components/Widget'\nexport type W = typeof Widget\n",
    )
    // `.tsx` files are scanned too, not just `.ts` (two real baseline
    // entries are `.tsx` — a new upward import in one must be flagged).
    fs.writeFileSync(
      path.join(libDir, 'newOffender.tsx'),
      "import { Widget } from '@/components/Widget'\nexport const jsx = () => Widget\n",
    )

    const baseline = ['src/stores/legacyOffender.ts', 'src/hooks/fixedOffender.ts']
    const { violators, newViolators, staleBaseline } = analyze({ root: tmp, srcDir, baseline })

    if (!newViolators.includes('src/hooks/useThing.ts')) ok('downward import is legal')
    else fail('downward import is legal', 'useThing.ts flagged')

    if (newViolators.includes('src/lib/newOffender.ts')) ok('new upward import is flagged')
    else fail('new upward import is flagged', JSON.stringify(newViolators))

    if (
      violators.includes('src/stores/legacyOffender.ts') &&
      !newViolators.includes('src/stores/legacyOffender.ts')
    ) {
      ok('baselined upward import passes')
    } else {
      fail('baselined upward import passes', JSON.stringify({ violators, newViolators }))
    }

    if (staleBaseline.includes('src/hooks/fixedOffender.ts')) ok('stale baseline entry is flagged')
    else fail('stale baseline entry flagged', JSON.stringify(staleBaseline))

    if (newViolators.includes('src/lib/relativeOffender.ts')) {
      ok('relative-specifier upward import is flagged')
    } else {
      fail('relative-specifier upward import flagged', JSON.stringify(newViolators))
    }

    if (!violators.includes('src/lib/touchesEditor.ts')) {
      ok('out-of-scope target (editor) is not a violation')
    } else {
      fail('out-of-scope target ignored', 'touchesEditor.ts flagged')
    }

    if (!violators.some((f) => f.includes('__tests__'))) ok('test file ignored')
    else fail('test file ignored', 'a __tests__ file appeared in violators')

    if (!violators.some((f) => f.includes('/tests/'))) ok("'tests/' directory ignored")
    else fail("'tests/' directory ignored", 'a tests/ file appeared in violators')

    if (!violators.includes('src/lib/ambient.d.ts')) ok('.d.ts file ignored')
    else fail('.d.ts file ignored', 'ambient.d.ts flagged')

    if (newViolators.includes('src/lib/newOffender.tsx')) {
      ok('.tsx files are scanned (new upward import flagged)')
    } else {
      fail('.tsx files are scanned (new upward import flagged)', JSON.stringify(newViolators))
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
 * End-to-end CLI self-test: spawns THIS script as a real subprocess against a
 * fully synthetic fixture repo (its own scripts/ + src/ + baseline file) and
 * asserts on the actual process exit code. The assertions in runSelfTest()
 * drive analyze()/specifierTier() directly and never call runGuard(),
 * readBaseline(), or the process.exit() calls that make the pre-commit hook
 * actually block a bad PR -- a regression that dropped `process.exit(1)`
 * from runGuard() (defanging the gate entirely) would sail through those
 * assertions with zero failures, since prek.toml never runs the plain guard
 * against the live repo when only this script changes (only `--self-test`
 * fires). This closes that hole by running the real CLI end to end.
 */
function runCliSelfTest(ok, fail) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-layering-cli-selftest-'))
  try {
    const fixtureScripts = path.join(fixtureRoot, 'scripts')
    const fixtureSrc = path.join(fixtureRoot, 'src')
    fs.mkdirSync(fixtureScripts, { recursive: true })
    fs.mkdirSync(path.join(fixtureSrc, 'lib'), { recursive: true })
    fs.mkdirSync(path.join(fixtureSrc, 'stores'), { recursive: true })
    fs.copyFileSync(import.meta.filename, path.join(fixtureScripts, 'check-lib-layering.mjs'))
    fs.copyFileSync(
      path.join(import.meta.dirname, 'check-import-cycles.mjs'),
      path.join(fixtureScripts, 'check-import-cycles.mjs'),
    )
    fs.writeFileSync(path.join(fixtureSrc, 'stores', 'x.ts'), 'export const useX = 1\n')
    fs.writeFileSync(path.join(fixtureSrc, 'lib', 'clean.ts'), 'export const ok = 1\n')

    const run = () =>
      spawnSync(process.execPath, [path.join(fixtureScripts, 'check-lib-layering.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })

    // No baseline file yet -> exit 2 (repo-layout/config error).
    let res = run()
    if (res.status === 2) ok('CLI exits 2 when the baseline file is missing')
    else fail('CLI exits 2 when the baseline file is missing', `status=${res.status}`)

    // Empty baseline, no violations -> exit 0 (the real pre-commit-passing path).
    fs.writeFileSync(path.join(fixtureScripts, 'lib-layering-baseline.json'), '[]\n')
    res = run()
    if (res.status === 0) ok('CLI exits 0 on a clean tree')
    else fail('CLI exits 0 on a clean tree', `status=${res.status} stderr=${res.stderr}`)

    // Introduce a NEW upward import not in the baseline -> exit 1 (the real
    // pre-commit-FAILING path -- this is what actually blocks a bad PR).
    fs.writeFileSync(
      path.join(fixtureSrc, 'lib', 'offender.ts'),
      "import { useX } from '@/stores/x'\nexport const y = useX\n",
    )
    res = run()
    if (res.status === 1) ok('CLI exits 1 on a new violation (the gate actually blocks)')
    else fail('CLI exits 1 on a new violation (the gate actually blocks)', `status=${res.status}`)
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// ─── main ───────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}
