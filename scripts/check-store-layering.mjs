#!/usr/bin/env node
/**
 * Frontend store-dependency layering guard (#2465).
 *
 * `docs/architecture/frontend.md` states the store layer's load-bearing
 * dependency direction as prose: "Dependencies flow one way: page-block
 * stores → global focus, never the reverse." Nothing mechanical enforced
 * that sentence — this hook does.
 *
 * This is deliberately NOT the same job as `check-import-cycles.mjs` (#761):
 * a cycle guard only rejects graphs with a cycle. A one-way LAYERING
 * violation can be perfectly acyclic — e.g. `blocks.ts` importing
 * `page-blocks.ts` with nothing importing back — and still break the
 * documented data-flow direction. So this hook checks two things:
 *
 *  1. **Family allowlist.** The page-block-store family (`page-blocks.ts`,
 *     `page-blocks-reducers.ts`, `page-blocks-map.ts`, `page-blocks-move.ts`,
 *     `page-blocks-types.ts`) may only import the OTHER store modules listed
 *     in `PAGE_BLOCK_STORE_ALLOWED_IMPORTS` below. That allowlist mirrors
 *     what the family legitimately depends on today (global focus, current
 *     space, page-level undo) — a new cross-store import from this family is
 *     a layering decision that deserves a reviewed addition to the
 *     allowlist, not a silent new edge.
 *  2. **Reverse ban.** `blocks.ts` (the "global focus" store the sentence
 *     names as the one-way target) must not import ANY page-block-store
 *     family module — the "never the reverse" half of the same sentence.
 *
 * Resolution is intentionally narrow (unlike `check-import-cycles.mjs`'s
 * general resolver): every store module lives flat in `src/stores/`, so a
 * same-store import is always `./<name>` or `@/stores/<name>`. Only
 * specifiers shaped that way are treated as store-to-store edges; anything
 * else (component/hook/lib imports) is out of scope for this hook.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'

import { detectImports } from './check-import-cycles.mjs'

const __dirname = import.meta.dirname
const STORES_DIR = resolve(__dirname, '..', 'src', 'stores')

/** The page-block-store family named in the doc sentence. */
export const PAGE_BLOCK_STORE_FAMILY = [
  'page-blocks.ts',
  'page-blocks-reducers.ts',
  'page-blocks-map.ts',
  'page-blocks-move.ts',
  'page-blocks-types.ts',
]

/**
 * Other store modules the page-block-store family may import today.
 * `blocks.ts` (global focus) is the documented target of the one-way
 * dependency; `space.ts` (current space) and `undo.ts` (page-level
 * undo/redo) are the family's other two real cross-store dependencies.
 * `tabs.ts` and `recent-pages.ts` were added for the #2802 stale-space
 * heal: load()'s space-membership rejection pops the stale active-tab
 * entry and drops the page from the old space's recents — a forward
 * edge (page-block store → navigation stores); neither module imports
 * the family back (the reverse ban plus the import-cycle hook keep it
 * one-way).
 * Intra-family imports (e.g. `page-blocks.ts` importing
 * `page-blocks-reducers.ts`) are always allowed and don't need listing here.
 */
export const PAGE_BLOCK_STORE_ALLOWED_IMPORTS = new Set([
  'blocks.ts',
  'space.ts',
  'undo.ts',
  'tabs.ts',
  'recent-pages.ts',
])

/** Store module that must never import the page-block-store family. */
export const GLOBAL_FOCUS_STORE = 'blocks.ts'

/**
 * Check the documented layering against a store-to-store import graph.
 *
 * @param {Map<string, string[]>} storeImports store filename ->
 *   imported store filenames (basenames, e.g. `blocks.ts`)
 * @returns {string[]} human-readable violation messages, empty when clean
 */
export function checkLayering(storeImports) {
  const violations = []

  for (const [file, imports] of storeImports) {
    if (PAGE_BLOCK_STORE_FAMILY.includes(file)) {
      for (const imp of imports) {
        const isIntraFamily = PAGE_BLOCK_STORE_FAMILY.includes(imp)
        const isAllowed = PAGE_BLOCK_STORE_ALLOWED_IMPORTS.has(imp)
        if (!isIntraFamily && !isAllowed) {
          violations.push(
            `${file} imports ${imp}, which is outside the page-block-store family's allowed ` +
              `cross-store set (${[...PAGE_BLOCK_STORE_ALLOWED_IMPORTS].join(', ')}). ` +
              `docs/architecture/frontend.md: "Dependencies flow one way: page-block stores → ` +
              `global focus, never the reverse." If this new dependency is intentional, add it ` +
              `to PAGE_BLOCK_STORE_ALLOWED_IMPORTS in scripts/check-store-layering.mjs with a ` +
              `reason and document it in frontend.md.`,
          )
        }
      }
    }

    if (file === GLOBAL_FOCUS_STORE) {
      for (const imp of imports) {
        if (PAGE_BLOCK_STORE_FAMILY.includes(imp)) {
          violations.push(
            `${GLOBAL_FOCUS_STORE} imports ${imp} — the page-block-store family must depend ON ` +
              `${GLOBAL_FOCUS_STORE}, never the reverse (docs/architecture/frontend.md, #2465).`,
          )
        }
      }
    }
  }

  return violations
}

/** Resolve a same-store-directory specifier to its basename, or null. */
function storeBasename(spec) {
  let name
  if (spec.startsWith('./')) {
    name = spec.slice(2)
  } else if (spec.startsWith('@/stores/')) {
    name = spec.slice('@/stores/'.length)
  } else {
    return null // not a same-directory store import — out of scope here
  }
  name = name.split('/').pop()
  if (!name) return null
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) name += '.ts'
  return name
}

/** List first-party store module files directly under `src/stores/` (no subdirs). */
function listStoreFiles() {
  return readdirSync(STORES_DIR).filter((name) => {
    if (!/\.(ts|tsx)$/.test(name)) return false
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return false
    return statSync(resolve(STORES_DIR, name)).isFile()
  })
}

/** Build the store-to-store import graph by scanning `src/stores/`. */
function buildStoreImportMap() {
  const map = new Map()
  for (const file of listStoreFiles()) {
    const src = readFileSync(resolve(STORES_DIR, file), 'utf8')
    const targets = new Set()
    for (const spec of detectImports(src)) {
      const name = storeBasename(spec)
      if (name && name !== file) targets.add(name)
    }
    map.set(file, [...targets])
  }
  return map
}

function main() {
  const storeImports = buildStoreImportMap()
  const violations = checkLayering(storeImports)

  if (violations.length === 0) {
    console.log(`OK: ${storeImports.size} store modules scanned, layering respected (#2465).`)
    process.exit(0)
  }

  console.error(`FAIL: ${violations.length} store-layering violation(s):`)
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

// ─── self-test (#3997) ─────────────────────────────────────────────
//
// Added because this hook had no backstop of any kind: no self-test hook
// existed at all before #3997, so a regression in checkLayering/
// storeBasename — or a defanged check-import-cycles.mjs, the shared module
// this guard delegates import-detection to — could land unnoticed.
function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  // --- checkLayering: pure function over a store-import graph -----------

  const clean1 = checkLayering(new Map([['page-blocks.ts', ['blocks.ts']]]))
  if (clean1.length === 0) ok('allowed cross-store import (page-blocks -> blocks) is clean')
  else fail('allowed cross-store import is clean', JSON.stringify(clean1))

  const intraFamily = checkLayering(new Map([['page-blocks.ts', ['page-blocks-reducers.ts']]]))
  if (intraFamily.length === 0) ok('intra-family import is clean')
  else fail('intra-family import is clean', JSON.stringify(intraFamily))

  const disallowed = checkLayering(new Map([['page-blocks.ts', ['tabs-history.ts']]]))
  if (disallowed.length === 1 && disallowed[0].includes('tabs-history.ts')) {
    ok('disallowed cross-store import from the family is flagged')
  } else {
    fail('disallowed cross-store import from the family is flagged', JSON.stringify(disallowed))
  }

  const reverse = checkLayering(new Map([['blocks.ts', ['page-blocks.ts']]]))
  if (reverse.length === 1 && reverse[0].includes('blocks.ts imports page-blocks.ts')) {
    ok('reverse import (blocks.ts -> family) is flagged')
  } else {
    fail('reverse import (blocks.ts -> family) is flagged', JSON.stringify(reverse))
  }

  const blocksClean = checkLayering(new Map([['blocks.ts', ['space.ts']]]))
  if (blocksClean.length === 0) ok('blocks.ts importing a non-family store is clean')
  else fail('blocks.ts importing a non-family store is clean', JSON.stringify(blocksClean))

  // --- storeBasename: specifier resolution -------------------------------

  if (storeBasename('./blocks') === 'blocks.ts') ok("storeBasename('./blocks') -> blocks.ts")
  else fail("storeBasename('./blocks') -> blocks.ts", storeBasename('./blocks'))

  if (storeBasename('@/stores/space') === 'space.ts') {
    ok("storeBasename('@/stores/space') -> space.ts")
  } else {
    fail("storeBasename('@/stores/space') -> space.ts", storeBasename('@/stores/space'))
  }

  if (storeBasename('@/lib/utils') === null) ok('out-of-scope specifier resolves to null')
  else fail('out-of-scope specifier resolves to null', storeBasename('@/lib/utils'))

  runCliSelfTest(ok, fail)

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * End-to-end CLI self-test: spawns THIS script as a real subprocess against a
 * fully synthetic fixture repo (its own scripts/ + src/stores/), copying
 * check-import-cycles.mjs alongside it exactly as the real repo lays them
 * out, and asserts on the actual process exit code. The assertions above
 * drive checkLayering()/storeBasename() directly and never call main() or
 * its process.exit() calls — a regression that dropped `process.exit(1)`
 * from main() (defanging the gate entirely) would sail through those
 * assertions with zero failures. This closes that hole (mirrors
 * check-lib-layering.mjs's runCliSelfTest, #3997 sibling fix).
 */
function runCliSelfTest(ok, fail) {
  const fixtureRoot = mkdtempSync(resolve(os.tmpdir(), 'store-layering-cli-selftest-'))
  try {
    const fixtureScripts = resolve(fixtureRoot, 'scripts')
    const fixtureStores = resolve(fixtureRoot, 'src', 'stores')
    mkdirSync(fixtureScripts, { recursive: true })
    mkdirSync(fixtureStores, { recursive: true })
    copyFileSync(import.meta.filename, resolve(fixtureScripts, 'check-store-layering.mjs'))
    copyFileSync(
      resolve(import.meta.dirname, 'check-import-cycles.mjs'),
      resolve(fixtureScripts, 'check-import-cycles.mjs'),
    )

    const run = () =>
      spawnSync(process.execPath, [resolve(fixtureScripts, 'check-store-layering.mjs')], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      })

    // Clean tree -> exit 0.
    writeFileSync(resolve(fixtureStores, 'blocks.ts'), 'export const useBlocksStore = () => 1\n')
    writeFileSync(
      resolve(fixtureStores, 'page-blocks.ts'),
      "import { useBlocksStore } from './blocks'\nexport const x = useBlocksStore\n",
    )
    let res = run()
    if (res.status === 0) ok('CLI exits 0 on a clean tree')
    else fail('CLI exits 0 on a clean tree', `status=${res.status} stderr=${res.stderr}`)

    // Reverse import (blocks.ts -> page-blocks.ts) -> exit 1, the gate that
    // actually blocks a bad PR.
    writeFileSync(
      resolve(fixtureStores, 'blocks.ts'),
      "import { x } from './page-blocks'\nexport const useBlocksStore = () => x\n",
    )
    res = run()
    if (res.status === 1) ok('CLI exits 1 on a reverse import (the gate actually blocks)')
    else fail('CLI exits 1 on a reverse import (the gate actually blocks)', `status=${res.status}`)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

// Run the scan only when invoked directly as a script, not when imported.
// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
  } else {
    main()
  }
}
