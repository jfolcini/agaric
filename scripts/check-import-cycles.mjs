#!/usr/bin/env node
/**
 * Frontend import-cycle guard.
 *
 * Builds the module import graph for `src/` (TypeScript/TSX) and reports any
 * cycles via Tarjan's strongly-connected-components algorithm. A clean graph
 * has zero SCCs of size > 1 and no module that imports itself.
 *
 * The frontend graph was driven to zero cycles in #761; this hook keeps it
 * there. Exits non-zero (and prints each cycle) when a new cycle appears.
 *
 * Resolution is intentionally lightweight — it understands the project's
 * `@/` alias (-> src/) and relative specifiers, resolving to `.ts`/`.tsx`/
 * `.js`/`.jsx` files or `index.*` barrels. Bare specifiers (node_modules) are
 * ignored. Both value and `import type` edges count: a type-only cycle still
 * confuses bundlers and humans, and the graph is clean enough to forbid them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(__dirname, '..', 'src')

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const INDEX = EXTS.map((e) => `index${e}`)

/** Recursively collect source files under `dir`. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full, out)
    } else if (EXTS.some((e) => name.endsWith(e))) {
      out.push(full)
    }
  }
  return out
}

/** Resolve a specifier from `fromFile` to an absolute source path, or null. */
function resolveSpecifier(spec, fromFile) {
  let base
  if (spec.startsWith('@/')) {
    base = join(SRC, spec.slice(2))
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = resolve(dirname(fromFile), spec)
  } else {
    return null // bare specifier — external package
  }
  // Exact file with extension already present.
  try {
    if (statSync(base).isFile()) return base
  } catch {}
  for (const e of EXTS) {
    try {
      if (statSync(base + e).isFile()) return base + e
    } catch {}
  }
  for (const idx of INDEX) {
    try {
      const p = join(base, idx)
      if (statSync(p).isFile()) return p
    } catch {}
  }
  return null
}

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Strip `//` line comments and block comments so specifiers that appear only
 * inside JSDoc/prose (e.g. `import { x } from './foo'` in a doc-comment) are
 * not mistaken for real import edges. Conservative: leaves string contents
 * alone, which is fine because import/export statements never legitimately
 * embed a `//` or block comment before the specifier we capture.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

/** Extract resolved import targets for a file. */
function importsOf(file) {
  const src = stripComments(readFileSync(file, 'utf8'))
  const targets = new Set()
  let m
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2]
    if (!spec) continue
    const resolved = resolveSpecifier(spec, file)
    if (resolved) targets.add(resolved)
  }
  return [...targets]
}

const files = walk(SRC)
/** @type {Map<string, string[]>} */
const graph = new Map()
for (const f of files) graph.set(f, importsOf(f))

// Tarjan's SCC.
let index = 0
const stack = []
const onStack = new Set()
const idx = new Map()
const low = new Map()
const sccs = []

function strongConnect(v) {
  idx.set(v, index)
  low.set(v, index)
  index++
  stack.push(v)
  onStack.add(v)
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) {
      strongConnect(w)
      low.set(v, Math.min(low.get(v), low.get(w)))
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), idx.get(w)))
    }
  }
  if (low.get(v) === idx.get(v)) {
    const comp = []
    let w
    do {
      w = stack.pop()
      onStack.delete(w)
      comp.push(w)
    } while (w !== v)
    sccs.push(comp)
  }
}

for (const v of graph.keys()) if (!idx.has(v)) strongConnect(v)

const rel = (f) => relative(SRC, f)
const cycles = []
for (const comp of sccs) {
  if (comp.length > 1) {
    cycles.push(comp)
  } else {
    const [only] = comp
    if ((graph.get(only) ?? []).includes(only)) cycles.push(comp)
  }
}

if (cycles.length === 0) {
  console.log(`OK: ${files.length} modules scanned, 0 import cycles.`)
  process.exit(0)
}

console.error(`FAIL: ${cycles.length} import cycle(s) found across ${files.length} modules:`)
for (const comp of cycles) {
  console.error('  cycle:')
  for (const f of comp.sort()) console.error(`    - ${rel(f)}`)
}
process.exit(1)
