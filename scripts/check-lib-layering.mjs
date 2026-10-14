#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Frontend tier-layering guard (#3121).
//
//   lib/ (rank 0)  <-  stores/ (rank 1)  <-  hooks/ (rank 2)  <-  components/ (rank 3)
//
// Read the arrow as "is depended on by": `lib/` may depend only on itself
// (plus external packages); `stores/` may add `lib/`; `hooks/` may add
// `stores/`; `components/` may depend on all three. A LOWER-ranked module
// may never import a HIGHER-ranked one. `check-import-cycles.mjs` proves the
// graph has no loop, a different property: a pure util importing a store is
// acyclic and still breaks layering.
//
// Fix a violation by moving the shared code down to the lower tier, or the
// importing file up to the tier it actually belongs to. There is no baseline
// and no allowlist.
//
// `src/editor/`, `src/workers/`, `src/types/`, and everything else outside
// the four tier directories is out of scope: never scanned as an importer,
// never a violating target. Only the `@/` alias and relative specifiers are
// resolved; bare specifiers (node_modules) are out of scope. Import detection
// reuses `detectImports` from `check-import-cycles.mjs` (comment- and
// string-literal-aware). Test files (`*.test.ts[x]`, `__tests__/`, `tests/`)
// and `.d.ts` are excluded.
//
// Usage: node scripts/check-lib-layering.mjs
// Exit:  0 clean, 1 = upward import found, 2 = repo layout failure (a tier
//        directory missing or empty — a scan that could not look).
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

import { detectImports } from './check-import-cycles.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

/** Tier directories (directly under `src/`) and their rank, low (foundation) to high. */
const TIERS = [
  { name: 'lib', rank: 0 },
  { name: 'stores', rank: 1 },
  { name: 'hooks', rank: 2 },
  { name: 'components', rank: 3 },
]
const TIER_RANK = new Map(TIERS.map((t) => [t.name, t.rank]))

function toPosix(p) {
  return p.split(path.sep).join('/')
}

/** Walk a tier directory for non-test `.ts`/`.tsx` files. */
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
  visit(dir)
  return out
}

/**
 * Resolve an import specifier to the tier it targets, without touching the
 * filesystem: only the `@/` alias and relative specifiers are understood,
 * and only the FIRST path segment under `srcDir` matters (`@/lib/foo` and
 * `../../lib/bar/baz` both resolve to `lib`). Returns `null` for bare
 * specifiers and anything outside the four tiers.
 *
 * @param {string} spec raw specifier text
 * @param {string} fromFile absolute path of the importing file
 * @param {string} srcDir absolute path of the `src/` root to resolve against
 * @returns {string | null} tier name, or null if out of scope
 */
function specifierTier(spec, fromFile, srcDir) {
  let logicalRel
  if (spec.startsWith('@/')) {
    logicalRel = spec.slice(2)
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    const abs = path.resolve(path.dirname(fromFile), spec)
    logicalRel = toPosix(path.relative(srcDir, abs))
  } else {
    return null
  }
  const first = logicalRel.split('/')[0]
  return TIER_RANK.has(first) ? first : null
}

/** 1-based line of the first import-shaped line quoting `spec`, for the error message. */
function lineOf(src, spec) {
  const idx = src
    .split('\n')
    .findIndex(
      (l) =>
        /\b(?:import|export|from)\b/.test(l) &&
        (l.includes(`'${spec}'`) || l.includes(`"${spec}"`)),
    )
  return idx === -1 ? '?' : idx + 1
}

function main() {
  const violations = []
  let scanned = 0
  for (const tier of TIERS) {
    const tierDir = path.join(SRC_DIR, tier.name)
    if (!fs.existsSync(tierDir)) {
      console.error(`ERROR: tier directory not found (repo layout changed?): ${tierDir}`)
      process.exit(2)
    }
    const files = listSourceFiles(tierDir)
    if (files.length === 0) {
      console.error(`ERROR: no source files found under ${tierDir} — the scan could not look`)
      process.exit(2)
    }
    for (const file of files) {
      scanned += 1
      const src = fs.readFileSync(file, 'utf8')
      for (const spec of detectImports(src)) {
        const target = specifierTier(spec, file, SRC_DIR)
        if (target && TIER_RANK.get(target) > tier.rank) {
          const rel = toPosix(path.relative(ROOT, file))
          violations.push(`${rel}:${lineOf(src, spec)}  ${tier.name} imports ${target}: '${spec}'`)
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('ERROR: tier-layering violation(s) — a lower tier must never import a higher')
    console.error('one (lib < stores < hooks < components, #3121):')
    for (const v of violations) console.error(`  ${v}`)
    console.error('')
    console.error('Fix: move the shared code down to the importing tier, or move the importing')
    console.error('file up to the tier it actually belongs to.')
    process.exit(1)
  }

  console.log(
    `OK: ${scanned} file(s) scanned, no upward imports (lib < stores < hooks < components)`,
  )
}

main()
