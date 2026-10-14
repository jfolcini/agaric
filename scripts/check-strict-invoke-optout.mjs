#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Strict-invoke opt-out guard (#3332).
//
// `src/test-setup.ts` installs a STRICT `invoke` mock (#3225): an IPC call
// for a command the test never stubbed REJECTS, and a global `afterEach`
// fails the test by name. Resolving `undefined` instead is indistinguishable
// from success (`typedError` wraps it as `{ status: 'ok' }`), so a missing
// stub would silently exercise the wrong path (#3217).
//
// A file-level `vi.mock('@tauri-apps/api/core', …)` replaces the whole module,
// so `strictInvokeFallback` never runs and that protection is gone inside
// the file.
//
// ─── The rule ─────────────────────────────────────────────────────────
//
// A test file that calls `vi.mock('@tauri-apps/api/core', …)` must build
// its `invoke` mock as `vi.fn(strictInvokeFallback)` (imported from
// `src/__tests__/helpers/invoke.ts`, which needs an `async` factory).
// Re-mocking the module is legitimate — e.g. to add `convertFileSrc` — but
// dropping the strict fallback is not. ANY opt-out fails the guard, naming
// file and line; there is no baseline.
//
// Fails closed: a test file that cannot be read throws (non-zero exit), a
// mock call whose parentheses never balance counts as an opt-out, and a scan
// that finds no test files at all exits 2 rather than reporting "clean".
//
// ─── Known second opt-out class (NOT mechanized here) ─────────────────
//
// A blanket `vi.mocked(invoke).mockResolvedValue(undefined)` opts a file
// out just as effectively — an explicit stub is honoured, so the strict
// fallback never fires. That opt-out is left to review: it is textual to
// detect and easy to spell differently, so a guard for it would be both
// noisy and easy to evade.
//
// ─── Scope ────────────────────────────────────────────────────────────
//
// Scans `src/**/*.test.ts` and `src/**/*.test.tsx`. Nothing else can
// install a module mock that affects the shared setup.
//
// Usage: node scripts/check-strict-invoke-optout.mjs
// Exit:  0 clean, 1 = opt-out found, 2 = repo layout failure.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')

/** The module whose mock the strict-invoke mechanism lives behind. */
const CORE_MODULE = '@tauri-apps/api/core'
/** The fallback that makes an unstubbed command reject instead of resolving. */
const STRICT_FALLBACK = 'strictInvokeFallback'

// ─── analysis (pure over a src dir) ────────────────────────────────────

function listTestFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTestFiles(full))
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Blank out `//` and block comments, leaving string/template literals intact.
 *
 * Without this the guard flags a file for *documenting* the rule it follows —
 * a comment reading "no per-file `vi.mock('@tauri-apps/api/core', …)`" is the
 * exact text the detector looks for. Replacing comment bytes with spaces (not
 * deleting them) keeps every offset stable so the balance scan below still
 * lines up with the original source.
 */
export function blankComments(source) {
  const out = source.split('')
  let i = 0
  let mode = 'code' // code | line | block | sq | dq | tpl
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line'
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        mode = 'block'
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      if (ch === "'") mode = 'sq'
      else if (ch === '"') mode = 'dq'
      else if (ch === '`') mode = 'tpl'
      i++
      continue
    }
    if (mode === 'line') {
      if (ch === '\n') mode = 'code'
      else out[i] = ' '
      i++
      continue
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        mode = 'code'
        i += 2
        continue
      }
      if (ch !== '\n') out[i] = ' '
      i++
      continue
    }
    // Inside a string/template: honour escapes, then close on the delimiter.
    if (ch === '\\') {
      i += 2
      continue
    }
    if (
      (mode === 'sq' && ch === "'") ||
      (mode === 'dq' && ch === '"') ||
      (mode === 'tpl' && ch === '`')
    ) {
      mode = 'code'
    }
    i++
  }
  return out.join('')
}

/**
 * The full `vi.mock('@tauri-apps/api/core', …)` call texts in `source`.
 *
 * Balance-scans from the call's opening paren so a factory containing
 * parens, arrow functions or nested objects is captured whole — a regex
 * with a lazy `)` would truncate at the first inner paren and misjudge
 * whether the strict fallback is wired in.
 */
export function extractCoreMockCalls(rawSource) {
  const source = blankComments(rawSource)
  const calls = []
  const head = new RegExp(`vi\\.mock\\(\\s*['"\`]${CORE_MODULE.replaceAll('/', '\\/')}['"\`]`, 'g')
  for (const m of source.matchAll(head)) {
    const open = source.indexOf('(', m.index)
    if (open === -1) continue
    let depth = 0
    let i = open
    for (; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    const line = source.slice(0, m.index).split('\n').length
    calls.push({ text: source.slice(open, i + 1), line })
  }
  return calls
}

/**
 * The 1-based lines of every `vi.mock('@tauri-apps/api/core', …)` in `source`
 * that does not thread `strictInvokeFallback` into the `invoke` mock.
 *
 * A bare `vi.mock('@tauri-apps/api/core')` with NO factory keeps vitest's
 * automock, which does not resolve through the shared setup either — it is
 * an opt-out too.
 */
export function optOutLines(source) {
  return extractCoreMockCalls(source)
    .filter((call) => !call.text.includes(STRICT_FALLBACK))
    .map((call) => call.line)
}

export function analyze({ srcDir, root }) {
  const files = listTestFiles(srcDir)
  const optOuts = []
  for (const f of files) {
    for (const line of optOutLines(fs.readFileSync(f, 'utf8'))) {
      optOuts.push({ file: path.relative(root, f).replaceAll(path.sep, '/'), line })
    }
  }
  optOuts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
  return { scanned: files.length, optOuts }
}

// ─── entry point ────────────────────────────────────────────────────────

runGuard()

function runGuard() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }

  const { scanned, optOuts } = analyze({ srcDir: SRC_DIR, root: ROOT })
  if (scanned === 0) {
    console.error(
      `ERROR: no test files found under ${SRC_DIR}; a scan that looked at nothing proves nothing`,
    )
    process.exit(2)
  }

  if (optOuts.length > 0) {
    console.error(
      `ERROR: ${optOuts.length} strict-invoke opt-out(s) — these vi.mock('${CORE_MODULE}')`,
    )
    console.error('calls do not thread the strict fallback into the `invoke` mock:')
    for (const { file, line } of optOuts) console.error(`  ${file}:${line}`)
    console.error('')
    console.error('Inside such a file an IPC the test never stubbed resolves `undefined`, which')
    console.error('`typedError` wraps as `{ status: "ok" }` and `unwrap` reports as SUCCESS — the')
    console.error('#3217 phantom-success hazard the #3225 guard was built to close.')
    console.error('')
    console.error('FIX: drop the module mock and stub commands by name with `stubInvoke` or')
    console.error(
      '`mockInvokeCommands` from `src/__tests__/helpers/invoke.ts`. If you must re-mock',
    )
    console.error('the module (e.g. to add `convertFileSrc`), build the invoke mock from an async')
    console.error('factory:')
    console.error('')
    console.error(`    vi.mock('${CORE_MODULE}', async () => {`)
    console.error(
      "      const { strictInvokeFallback } = await import('@/__tests__/helpers/invoke')",
    )
    console.error('      return { invoke: vi.fn(strictInvokeFallback), convertFileSrc: vi.fn() }')
    console.error('    })')
    process.exit(1)
  }

  console.log(`OK: ${scanned} test file(s) scanned, no strict-invoke opt-outs`)
}
