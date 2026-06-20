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

const __dirname = import.meta.dirname
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
 * Length-preserving, string/comment/template-aware preprocessor.
 *
 * Why this exists: the import regex matches a quoted specifier after the
 * `from` keyword / inside `import(`. But a *string or template literal whose
 * CONTENTS look like an import* (e.g. ``const code = `import { x } from
 * './x'` `` — codegen fixtures, doc snippets) would also be matched by the
 * regex, registering a phantom edge to `./x` and false-FAILing a legit PR.
 *
 * Naively blanking *all* string contents is wrong: a REAL import specifier
 * (`from './foo'`) is itself a quoted string — blanking it empties the
 * specifier and breaks cycle detection. So the blanking must be
 * context-aware: it replaces the contents of
 *   - line comments (`// …`),
 *   - block comments (`/* … *​/`), and
 *   - template literals (backticks, including any `${…}` interpolation)
 * with spaces (length-preserving so error offsets stay meaningful), while
 * leaving ordinary single/double-quoted strings intact. The import regex is
 * then run over the result.
 *
 * That still leaves one class of false positive: an import-shaped *value*
 * inside an ordinary quoted string, e.g. `const s = "import q from './qux'"`.
 * The regex's quoted-specifier branch only fires for `… from '<spec>'` /
 * `import('<spec>')`, but a value-position string can spell exactly that.
 * We defeat it with the tokenizer's `codeMask`: each character is tagged as
 * code (the quote delimiters and everything outside any literal) or
 * non-code (the *interior* of every quoted string and template). A regex
 * match is accepted only when its `import`/`export`/`import(` *keyword* sits
 * in code position — a real statement always does; an import-shaped string
 * sitting in value position has its leading `import` inside the string
 * interior, so the match is rejected. A real specifier survives because its
 * surrounding `from`/`import(` keyword is in code position even though the
 * specifier's own characters are (correctly) string-interior.
 *
 * Escaped quotes (`\'`, `\"`, `` \` ``) are handled so they don't
 * prematurely close a literal. Nested templates / interpolation are treated
 * conservatively as literal interior (blanked), which only ever *removes*
 * potential edges — it can never invent one.
 *
 * @param {string} src
 * @returns {{ masked: string, codeMask: Uint8Array }}
 *   `masked` has comment/template interiors blanked; `codeMask[i] === 1`
 *   iff character `i` is in code (not inside a quoted-string interior).
 */
function preprocess(src) {
  const n = src.length
  const out = Array.from({ length: n })
  const codeMask = new Uint8Array(n)
  // Shared cursor context the per-state handlers mutate. `state` ∈
  // { code, line, block, sq, dq, tmpl }; `i` is the read cursor.
  const cx = { src, n, out, codeMask, i: 0, state: 'code' }
  while (cx.i < n) {
    switch (cx.state) {
      case 'code': {
        stepCode(cx)
        break
      }
      case 'line': {
        stepLine(cx)
        break
      }
      case 'block': {
        stepBlock(cx)
        break
      }
      case 'sq':
      case 'dq': {
        stepQuoted(cx)
        break
      }
      default: {
        // 'tmpl'
        stepTemplate(cx)
      }
    }
  }
  return { masked: out.join(''), codeMask }
}

/** Emit one code char, marking it code (1). */
function emitCode(cx, ch) {
  cx.out[cx.i] = ch
  cx.codeMask[cx.i] = 1
  cx.i++
}

/** Blank a 2-char delimiter (`//`, `/*`, `*​/`) as code and advance. */
function blankDelimiter(cx) {
  cx.out[cx.i] = ' '
  cx.out[cx.i + 1] = ' '
  cx.codeMask[cx.i] = 1
  cx.codeMask[cx.i + 1] = 1
  cx.i += 2
}

function stepCode(cx) {
  const ch = cx.src[cx.i]
  const next = cx.i + 1 < cx.n ? cx.src[cx.i + 1] : ''
  if (ch === '/' && next === '/') {
    blankDelimiter(cx)
    cx.state = 'line'
  } else if (ch === '/' && next === '*') {
    blankDelimiter(cx)
    cx.state = 'block'
  } else if (ch === "'" || ch === '"') {
    // The delimiter is code; the interior is not.
    emitCode(cx, ch)
    cx.state = ch === "'" ? 'sq' : 'dq'
  } else if (ch === '`') {
    // Template literal: drop the backtick and blank its whole interior so the
    // regex never sees import-shaped template text as code.
    cx.out[cx.i] = ' '
    cx.codeMask[cx.i] = 0
    cx.i++
    cx.state = 'tmpl'
  } else {
    emitCode(cx, ch)
  }
}

function stepLine(cx) {
  const ch = cx.src[cx.i]
  cx.out[cx.i] = ch === '\n' ? '\n' : ' '
  cx.codeMask[cx.i] = 1
  if (ch === '\n') cx.state = 'code'
  cx.i++
}

function stepBlock(cx) {
  const ch = cx.src[cx.i]
  const next = cx.i + 1 < cx.n ? cx.src[cx.i + 1] : ''
  if (ch === '*' && next === '/') {
    blankDelimiter(cx)
    cx.state = 'code'
    return
  }
  cx.out[cx.i] = ch === '\n' ? '\n' : ' '
  cx.codeMask[cx.i] = 1
  cx.i++
}

function stepQuoted(cx) {
  const ch = cx.src[cx.i]
  const closer = cx.state === 'sq' ? "'" : '"'
  if (ch === '\\') {
    // Escaped char: keep both chars verbatim as string interior.
    cx.out[cx.i] = ch
    cx.codeMask[cx.i] = 0
    if (cx.i + 1 < cx.n) {
      cx.out[cx.i + 1] = cx.src[cx.i + 1]
      cx.codeMask[cx.i + 1] = 0
    }
    cx.i += 2
    return
  }
  if (ch === closer) {
    // Closing delimiter is code.
    emitCode(cx, ch)
    cx.state = 'code'
    return
  }
  // Interior: keep the character (real specifiers must survive) but mark it
  // non-code so import-shaped *value* strings are rejected by codeMask.
  cx.out[cx.i] = ch
  cx.codeMask[cx.i] = 0
  cx.i++
}

function stepTemplate(cx) {
  const ch = cx.src[cx.i]
  // Blank the whole template interior, including any `${…}` interpolation.
  // Conservatively treating interpolated code as literal interior can only
  // remove edges, never invent one.
  if (ch === '\\') {
    cx.out[cx.i] = ' '
    cx.codeMask[cx.i] = 0
    if (cx.i + 1 < cx.n) {
      cx.out[cx.i + 1] = cx.src[cx.i + 1] === '\n' ? '\n' : ' '
      cx.codeMask[cx.i + 1] = 0
    }
    cx.i += 2
    return
  }
  if (ch === '`') {
    cx.out[cx.i] = ' '
    cx.codeMask[cx.i] = 0
    cx.i++
    cx.state = 'code'
    return
  }
  cx.out[cx.i] = ch === '\n' ? '\n' : ' '
  cx.codeMask[cx.i] = 0
  cx.i++
}

/**
 * Extract import/export specifier strings from source text. Pure (no I/O):
 * takes source, returns the raw specifier strings (unresolved). A specifier
 * is reported only when the `import`/`export` keyword that anchors its regex
 * match sits in CODE position — defeating import-shaped text that lives
 * inside a string or template literal in value position.
 *
 * @param {string} src
 * @returns {string[]} specifier strings in match order (may contain dups)
 */
export function detectImports(src) {
  const { masked, codeMask } = preprocess(src)
  const specs = []
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(masked)) !== null) {
    // Guard against zero-width matches looping forever.
    if (m.index === IMPORT_RE.lastIndex) IMPORT_RE.lastIndex++
    // The match must be anchored by a real keyword in code position: the
    // first character of the match (`import`/`export`) must be code.
    if (codeMask[m.index] !== 1) continue
    const spec = m[1] ?? m[2]
    if (spec) specs.push(spec)
  }
  return specs
}

/** Extract resolved import targets for a file. */
function importsOf(file) {
  const src = readFileSync(file, 'utf8')
  const targets = new Set()
  for (const spec of detectImports(src)) {
    const resolved = resolveSpecifier(spec, file)
    if (resolved) targets.add(resolved)
  }
  return [...targets]
}

/**
 * Build the graph, run Tarjan's SCC, and exit non-zero on any cycle.
 *
 * Guarded behind a direct-invocation check so that importing this module
 * (e.g. from the unit test that exercises `detectImports`) does not walk
 * `src/`, scan the tree, or call `process.exit`.
 */
function main() {
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
    for (const f of comp.toSorted()) console.error(`    - ${rel(f)}`)
  }
  process.exit(1)
}

// Run the scan only when invoked directly as a script, not when imported.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main()
}
