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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

// Run the scan only when invoked directly as a script, not when imported.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main()
}
