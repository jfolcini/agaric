#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Strict-invoke opt-out ratchet guard (#3332).
//
// `src/test-setup.ts` installs a STRICT `invoke` mock (#3225): an IPC call
// for a command the test never stubbed REJECTS, and a global `afterEach`
// fails the test by name. That guard exists because the previous behavior
// — resolve `undefined` — is indistinguishable from success: `typedError`
// wraps any resolved value as `{ status: 'ok', data }` and `unwrap`
// branches only on `status`. In #3217 that turned a stolen positional mock
// slot into a silent behaviour INVERSION: a "delete fails" test quietly
// exercised the delete-SUCCEEDS path and passed.
//
// The guard is opt-OUT. A file-level
//
//     vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
//
// replaces the whole module, so neither half of the mechanism survives:
// `strictInvokeFallback` never runs, the `afterEach` reads an empty record,
// and the pre-#3225 hazard is back in full inside that file. The rule
// against adding another has existed only as prose in
// `src/__tests__/AGENTS.md` ("Don't add another"), while every other
// invariant of comparable weight in this repo carries a committed baseline
// (`scripts/lib-layering-baseline.json`, `src-tauri/dynamic-sql-baseline.txt`,
// `scripts/tauri-import-baseline.json`, `src-tauri/unsafe-allowlist.txt`).
// This guard is that baseline — for the mechanism that protects the
// truthfulness of the frontend suite itself.
//
// ─── The rule ─────────────────────────────────────────────────────────
//
// A test file that calls `vi.mock('@tauri-apps/api/core', …)` must build
// its `invoke` mock as `vi.fn(strictInvokeFallback)` (imported from
// `src/__tests__/helpers/invoke.ts`, which needs an `async` factory).
// Re-mocking the module is legitimate — e.g. to add `convertFileSrc` — but
// dropping the strict fallback is not.
//
// `scripts/strict-invoke-optout-baseline.json` is a committed, sorted array
// of the test files that CURRENTLY opt out. The guard FAILS if:
//
//   - a file opts out but is NOT in the baseline (a NEW opt-out), or
//   - a baseline entry no longer opts out (a STALE entry — pruning it is
//     what makes the count ratchet DOWN; a green run against a stale
//     baseline would hide the win and let the opt-out silently return).
//
// Shrink-only by construction: `--update-baseline` re-derives the set, so
// the reviewer sees the count change in the diff.
//
// ─── Known second opt-out class (NOT mechanized here) ─────────────────
//
// A blanket `vi.mocked(invoke).mockResolvedValue(undefined)` opts a file
// out just as effectively — an explicit stub is honoured, so the strict
// fallback never fires. That opt-out is deliberate and left to review: it is
// textual to detect and easy to spell differently, so it is left to review rather than mechanized into a
// guard that would be simultaneously noisy and easy to evade.
//
// ─── Scope ────────────────────────────────────────────────────────────
//
// Scans `src/**/*.test.ts` and `src/**/*.test.tsx`. Nothing else can
// install a module mock that affects the shared setup.
//
// Usage: node scripts/check-strict-invoke-optout.mjs
//        node scripts/check-strict-invoke-optout.mjs --update-baseline
//        node scripts/check-strict-invoke-optout.mjs --self-test
// Exit:  0 clean, 1 = drift (new opt-out or stale baseline entry),
//        2 = repo layout / self-test failure.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'strict-invoke-optout-baseline.json')

/** The module whose mock the strict-invoke mechanism lives behind. */
const CORE_MODULE = '@tauri-apps/api/core'
/** The fallback that makes an unstubbed command reject instead of resolving. */
const STRICT_FALLBACK = 'strictInvokeFallback'

// ─── analysis (pure over a src dir, so the self-test can drive it) ──────

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
    calls.push(source.slice(open, i + 1))
  }
  return calls
}

/**
 * Whether `source` opts out of the strict-invoke guard: it re-mocks the core
 * module without threading `strictInvokeFallback` into the `invoke` mock.
 *
 * A bare `vi.mock('@tauri-apps/api/core')` with NO factory keeps vitest's
 * automock, which does not resolve through the shared setup either — it is
 * an opt-out too.
 */
export function optsOutOfStrictInvoke(source) {
  const calls = extractCoreMockCalls(source)
  if (calls.length === 0) return false
  return !calls.every((call) => call.includes(STRICT_FALLBACK))
}

export function analyze({ srcDir, root, baseline }) {
  const optOuts = listTestFiles(srcDir)
    .filter((f) => optsOutOfStrictInvoke(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f).replaceAll(path.sep, '/'))
    .toSorted()
  const baseSet = new Set(baseline)
  const optSet = new Set(optOuts)
  return {
    optOuts,
    newOptOuts: optOuts.filter((f) => !baseSet.has(f)),
    staleBaseline: baseline.filter((f) => !optSet.has(f)).toSorted(),
  }
}

function readBaseline() {
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (!Array.isArray(parsed)) {
    console.error(`ERROR: ${path.relative(ROOT, BASELINE_FILE)} must contain a JSON array`)
    process.exit(2)
  }
  return parsed
}

function writeBaseline(entries) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(entries.toSorted(), null, 2)}\n`)
}

// ─── entry point ────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest()
} else if (process.argv.includes('--update-baseline')) {
  updateBaseline()
} else {
  runGuard()
}

function updateBaseline() {
  requireLayout()
  const { optOuts } = analyze({ srcDir: SRC_DIR, root: ROOT, baseline: [] })
  writeBaseline(optOuts)
  console.log(
    `OK: wrote baseline with ${optOuts.length} strict-invoke opt-out(s) to ${path.relative(ROOT, BASELINE_FILE)}`,
  )
}

function requireLayout() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`ERROR: expected directory not found (repo layout changed?): ${SRC_DIR}`)
    process.exit(2)
  }
}

function runGuard() {
  requireLayout()
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`ERROR: baseline file not found: ${BASELINE_FILE}`)
    console.error('Seed it with:  node scripts/check-strict-invoke-optout.mjs --update-baseline')
    process.exit(2)
  }

  const baseline = readBaseline()
  const { optOuts, newOptOuts, staleBaseline } = analyze({
    srcDir: SRC_DIR,
    root: ROOT,
    baseline,
  })

  let failed = false

  if (newOptOuts.length > 0) {
    failed = true
    console.error(
      `ERROR: new strict-invoke opt-out(s) — these test files vi.mock('${CORE_MODULE}')`,
    )
    console.error('without threading the strict fallback into the `invoke` mock:')
    for (const f of newOptOuts) console.error(`  ${f}`)
    console.error('')
    console.error('Inside such a file an IPC the test never stubbed resolves `undefined`, which')
    console.error('`typedError` wraps as `{ status: "ok" }` and `unwrap` reports as SUCCESS — the')
    console.error('#3217 phantom-success hazard the #3225 guard was built to close.')
    console.error('')
    console.error('FIX: drop the module mock and stub commands by name with `mockInvokeCommands`')
    console.error('from `src/__tests__/helpers/invoke.ts`. If you must re-mock the module (e.g.')
    console.error('to add `convertFileSrc`), build the invoke mock from an async factory:')
    console.error('')
    console.error(`    vi.mock('${CORE_MODULE}', async () => {`)
    console.error(
      "      const { strictInvokeFallback } = await import('@/__tests__/helpers/invoke')",
    )
    console.error('      return { invoke: vi.fn(strictInvokeFallback), convertFileSrc: vi.fn() }')
    console.error('    })')
  }

  if (staleBaseline.length > 0) {
    failed = true
    console.error('ERROR: stale entr(ies) in the strict-invoke opt-out baseline — these files no')
    console.error('longer opt out and must be pruned so the count ratchets down:')
    for (const f of staleBaseline) console.error(`  ${f}`)
    console.error('')
    console.error('Prune them with:  node scripts/check-strict-invoke-optout.mjs --update-baseline')
  }

  if (failed) process.exit(1)

  console.log(
    `OK: ${optOuts.length} baselined strict-invoke opt-out(s), no new opt-outs, no stale entries`,
  )
}

// ─── self-test ──────────────────────────────────────────────────────────
//
// Drives analyze() over a synthetic src tree so the guard's own exit
// behavior is verified: a baselined opt-out PASSES, a NEW opt-out is
// flagged, a STALE baseline entry is flagged, a factory that threads
// `strictInvokeFallback` does NOT count, a factory-less `vi.mock` DOES
// count, a mock of a DIFFERENT module does NOT count, a factory whose
// nested parens would truncate a lazy regex is still read whole, and
// non-test files are ignored.
function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-invoke-selftest-'))
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  try {
    const srcDir = path.join(tmp, 'src')
    const testsDir = path.join(srcDir, 'components', '__tests__')
    fs.mkdirSync(testsDir, { recursive: true })

    const write = (name, body) => fs.writeFileSync(path.join(testsDir, name), body)

    write('Baselined.test.ts', `vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n`)
    write('NewOptOut.test.ts', `vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n`)
    write('Fixed.test.ts', `vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n`)
    write(
      'Strict.test.tsx',
      `vi.mock('${CORE_MODULE}', async () => {\n` +
        `  const { strictInvokeFallback } = await import('@/__tests__/helpers/invoke')\n` +
        '  return { invoke: vi.fn(strictInvokeFallback), convertFileSrc: vi.fn() }\n' +
        '})\n',
    )
    write('NoFactory.test.ts', `vi.mock('${CORE_MODULE}')\n`)
    write('OtherModule.test.ts', "vi.mock('sonner', () => ({ toast: vi.fn() }))\n")
    write(
      'NestedParens.test.ts',
      `vi.mock('${CORE_MODULE}', () => ({\n` +
        '  invoke: vi.fn((cmd) => (cmd === "x" ? 1 : 2)),\n' +
        '  convertFileSrc: vi.fn(() => ""),\n' +
        '}))\n',
    )
    write(
      'Commented.test.ts',
      `// A comment mentioning vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n` +
        `/* and a block one: vi.mock('${CORE_MODULE}') */\n` +
        'export const x = 1\n',
    )
    write(
      'CommentThenReal.test.ts',
      `// documented: vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n` +
        `vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n`,
    )
    // Not a test file — must be ignored even though it matches textually.
    fs.writeFileSync(
      path.join(srcDir, 'helper.ts'),
      `vi.mock('${CORE_MODULE}', () => ({ invoke: vi.fn() }))\n`,
    )

    const rel = (n) => `src/components/__tests__/${n}`
    const { optOuts, newOptOuts, staleBaseline } = analyze({
      srcDir,
      root: tmp,
      baseline: [rel('Baselined.test.ts'), rel('Fixed.test.ts'), rel('Gone.test.ts')].toSorted(),
    })

    // `Fixed.test.ts` is written as an opt-out on purpose: only `Gone.test.ts`
    // (absent from the tree) may be stale, which pins "stale == no longer
    // opts out", not "stale == file deleted".
    if (!newOptOuts.includes(rel('Baselined.test.ts'))) ok('baselined opt-out passes')
    else fail('baselined opt-out passes', JSON.stringify(newOptOuts))

    if (newOptOuts.includes(rel('NewOptOut.test.ts'))) ok('new opt-out is flagged')
    else fail('new opt-out is flagged', JSON.stringify(newOptOuts))

    if (staleBaseline.includes(rel('Gone.test.ts'))) ok('stale baseline entry is flagged')
    else fail('stale baseline entry is flagged', JSON.stringify(staleBaseline))

    if (!optOuts.includes(rel('Strict.test.tsx')))
      ok('factory threading strictInvokeFallback is not an opt-out')
    else fail('strictInvokeFallback factory is clean', JSON.stringify(optOuts))

    if (optOuts.includes(rel('NoFactory.test.ts'))) ok('factory-less vi.mock counts as an opt-out')
    else fail('factory-less vi.mock counts', JSON.stringify(optOuts))

    if (!optOuts.includes(rel('OtherModule.test.ts'))) ok('mock of another module does not count')
    else fail('other-module mock does not count', JSON.stringify(optOuts))

    if (optOuts.includes(rel('NestedParens.test.ts')))
      ok('factory with nested parens is read whole and still counts')
    else fail('nested-paren factory is read whole', JSON.stringify(optOuts))

    if (!optOuts.includes(rel('Commented.test.ts')))
      ok('a commented-out / documented vi.mock does not count')
    else fail('commented vi.mock does not count', JSON.stringify(optOuts))

    if (optOuts.includes(rel('CommentThenReal.test.ts')))
      ok('a real vi.mock alongside a documenting comment still counts')
    else fail('real vi.mock next to a comment still counts', JSON.stringify(optOuts))

    if (!optOuts.some((f) => f.endsWith('helper.ts'))) ok('non-test file is ignored')
    else fail('non-test file is ignored', JSON.stringify(optOuts))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}
