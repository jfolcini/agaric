#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Frontend trace-interaction naming guard (#2110, M4).
//
// The frontend tracer names a user-interaction span via
// `traceInteraction(NAME, fn, attrs?)`. To keep span names PII-safe **by
// construction**, NAME must be a member of the central `INTERACTIONS` registry
// (`src/lib/observability/interactions.ts`) — e.g. `INTERACTIONS.SEARCH` —
// never a string literal, template literal, or arbitrary variable that could
// interpolate a page title, query text, or block content into the exported
// span name.
//
// This guard makes that convention exhaustive: a `traceInteraction` call whose
// first argument is not an `INTERACTIONS.<KEY>` member access fails the hook.
// (Attribute *values* carry the same ids/counts/enums-only discipline, but
// that is a per-call review concern, not statically decidable here; the name
// dimension is what this guard locks down.)
//
// ─── Scope ──────────────────────────────────────────────────────────
//
// Walks every `*.ts` / `*.tsx` under `src/` (excluding the observability
// module's own implementation + tests, which define and exercise the API).
// For each `traceInteraction(` call it inspects the first argument token.
//
// ─── Rule ───────────────────────────────────────────────────────────
//
// PASS  — first arg matches `INTERACTIONS.<IDENTIFIER>`.
// FAIL  — anything else (string/template literal, bare variable, call, …).
//
// Also validates that every value in the `INTERACTIONS` map is a plain string
// literal, so the registry itself cannot smuggle in a dynamic name.
//
// ─── Output ─────────────────────────────────────────────────────────
//
// Prints offenders to stderr in `path:line: <snippet>` form and exits 1.
// On a clean run prints nothing and exits 0.
//
// ─── Usage ──────────────────────────────────────────────────────────
//
//   node scripts/check-trace-interactions.mjs
//   node scripts/check-trace-interactions.mjs --self-test
//
// Wired into `prek.toml` as a `local` repo hook, files = src TS; a companion
// hook runs `--self-test` whenever this script changes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HERE = import.meta.dirname
const REPO_ROOT = join(HERE, '..')
const SRC_DIR = join(REPO_ROOT, 'src')
const REGISTRY = join(SRC_DIR, 'lib', 'observability', 'interactions.ts')

// The observability module implements `traceInteraction` + the registry and
// tests it with deliberately-varied names; it is not a call-site to police.
const EXCLUDE_DIR = join(SRC_DIR, 'lib', 'observability')

/** First arg must be `INTERACTIONS.<KEY>` (optionally whitespace-padded). */
const VALID_FIRST_ARG = /^\s*INTERACTIONS\.[A-Za-z_$][A-Za-z0-9_$]*\s*$/

/** Recursively collect `*.ts` / `*.tsx` files under `dir`. */
function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (full === EXCLUDE_DIR) continue
      collectFiles(full, out)
    } else if (/\.tsx?$/.test(full)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Find every `traceInteraction(` call in `source` and return the first
 * argument's source text plus its 1-based line, by scanning balanced up to the
 * first top-level comma (or the closing paren for a single-arg call).
 */
function findTraceInteractionCalls(source) {
  const calls = []
  const needle = 'traceInteraction('
  let idx = source.indexOf(needle)
  while (idx !== -1) {
    // Skip a definition/import occurrence (`function traceInteraction(` or
    // `export ... traceInteraction`): only police call sites, i.e. an
    // occurrence whose char before the identifier is not a word char that would
    // make it part of a longer name. (Imports are filtered by the caller.)
    const argsStart = idx + needle.length
    let depth = 1
    let firstArg = ''
    let i = argsStart
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      else if (ch === ',' && depth === 1) break
      if (depth > 0) firstArg += ch
    }
    const line = source.slice(0, idx).split('\n').length
    calls.push({ firstArg, line })
    idx = source.indexOf(needle, argsStart)
  }
  return calls
}

/** Validate the registry: every INTERACTIONS value is a string literal. */
function checkRegistry(offenders) {
  let source
  try {
    source = readFileSync(REGISTRY, 'utf8')
  } catch {
    offenders.push(`${relative(REPO_ROOT, REGISTRY)}:0: INTERACTIONS registry not found`)
    return
  }
  const body = source.match(/INTERACTIONS\s*=\s*\{([\s\S]*?)\}\s*as const/)
  if (!body) {
    offenders.push(`${relative(REPO_ROOT, REGISTRY)}:0: could not parse INTERACTIONS map`)
    return
  }
  const entryRe = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.+?),?\s*$/
  for (const rawLine of body[1].split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    const m = entryRe.exec(line)
    if (!m) continue
    const value = m[2].trim()
    if (!/^'[^']*'$|^"[^"]*"$/.test(value)) {
      offenders.push(
        `${relative(REPO_ROOT, REGISTRY)}: INTERACTIONS.${m[1]} is not a string literal`,
      )
    }
  }
}

/** Run the guard over the real tree. Returns the offenders array. */
function run() {
  const offenders = []
  checkRegistry(offenders)
  for (const file of collectFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('traceInteraction(')) continue
    for (const { firstArg, line } of findTraceInteractionCalls(source)) {
      // An import line lists the name without a `(`; our needle requires the
      // `(`, so imports never match. A call with an INTERACTIONS member passes.
      if (!VALID_FIRST_ARG.test(firstArg)) {
        offenders.push(
          `${relative(REPO_ROOT, file)}:${line}: traceInteraction name must be INTERACTIONS.<KEY>, got: ${firstArg.trim() || '(empty)'}`,
        )
      }
    }
  }
  return offenders
}

// ─── Self-test ──────────────────────────────────────────────────────

function selfTest() {
  const cases = [
    { src: 'traceInteraction(INTERACTIONS.SEARCH, () => f())', good: true },
    { src: 'traceInteraction(  INTERACTIONS.PAGE_OPEN  , () => f())', good: true },
    { src: "traceInteraction('search', () => f())", good: false },
    { src: 'traceInteraction(`page.${id}`, () => f())', good: false },
    { src: 'traceInteraction(name, () => f())', good: false },
    { src: 'traceInteraction(getName(), () => f())', good: false },
  ]
  let failures = 0
  for (const { src, good } of cases) {
    const [{ firstArg }] = findTraceInteractionCalls(src)
    const pass = VALID_FIRST_ARG.test(firstArg)
    if (pass !== good) {
      failures++
      process.stderr.write(`self-test FAIL: ${JSON.stringify(src)} expected ${good}, got ${pass}\n`)
    }
  }
  if (failures > 0) {
    process.stderr.write(`check-trace-interactions self-test: ${failures} case(s) failed\n`)
    process.exit(1)
  }
  process.stdout.write('check-trace-interactions self-test: all cases passed\n')
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const offenders = run()
  if (offenders.length > 0) {
    process.stderr.write('Frontend trace-interaction naming violations (#2110, M4):\n')
    for (const o of offenders) process.stderr.write(`  ${o}\n`)
    process.stderr.write(
      '\nName every traceInteraction span with an INTERACTIONS.<KEY> member ' +
        '(src/lib/observability/interactions.ts) so span names stay PII-safe.\n',
    )
    process.exit(1)
  }
}
