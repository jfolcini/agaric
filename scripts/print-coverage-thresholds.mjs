#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Print the vitest coverage thresholds as a human-readable clause, derived
// from `vitest.config.ts` at run time.
//
// Why this exists (#3258): the coverage thresholds used to be hardcoded in
// THREE places — `vitest.config.ts` (the actual gate), a comment on the
// vitest step in `_validate.yml`, and the `$GITHUB_STEP_SUMMARY` string
// emitted by that same step — plus a fourth stale copy inside
// `vitest.config.ts`'s own prose comment. All four drifted out of sync with
// each other after PR #980 changed the gate numbers without updating the
// three prose copies, silently reintroducing the exact drift #749 had
// already fixed once. A copy that is derived at run time from the one
// place that actually gates (`vitest.config.ts`) cannot drift from it.
//
// Usage:
//   node scripts/print-coverage-thresholds.mjs
//   node scripts/print-coverage-thresholds.mjs --self-test
//
// Exit: 0 on success (prints the clause to stdout); 1 if the thresholds
// block cannot be found/parsed in vitest.config.ts.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG_PATH = join(import.meta.dirname, '..', 'vitest.config.ts')

const METRICS = ['lines', 'functions', 'branches', 'statements']

export function extractThresholds(configSource) {
  const block = configSource.match(/thresholds:\s*\{([^}]*)\}/s)
  if (!block) return null
  const body = block[1]
  const out = {}
  for (const metric of METRICS) {
    // `(\d+(?:\.\d+)?)`, not `(\d+)`: vitest's coverage thresholds accept
    // fractional percentages (e.g. `82.5`). An integer-only pattern would
    // silently truncate `82.5` to `82` instead of failing loudly — a
    // wrong-but-plausible number in the CI step summary, understating the
    // real gate by up to ~1pp with no indication anything was lost.
    const m = body.match(new RegExp(`\\b${metric}\\s*:\\s*(\\d+(?:\\.\\d+)?)`))
    if (!m) return null
    out[metric] = Number(m[1])
  }
  return out
}

export function formatClause(thresholds) {
  return METRICS.map((m) => `${m} >= ${thresholds[m]}%`).join(', ')
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  const source = readFileSync(CONFIG_PATH, 'utf8')
  const thresholds = extractThresholds(source)
  if (!thresholds) {
    process.stderr.write(
      `print-coverage-thresholds: could not find a \`thresholds: { ... }\` block in ${CONFIG_PATH}\n`,
    )
    process.exit(1)
  }
  process.stdout.write(`${formatClause(thresholds)}\n`)
}

function runSelfTest() {
  let failed = false
  const ok = (label) => process.stdout.write(`  ok ${label}\n`)
  const bad = (label, detail) => {
    process.stderr.write(`  FAIL - ${label}: ${detail}\n`)
    failed = true
  }

  // 1. Well-formed config extracts all four metrics.
  const good = extractThresholds(
    'export default defineConfig({ test: { coverage: { thresholds: { lines: 91, functions: 90, branches: 82, statements: 89 } } } })',
  )
  if (
    good &&
    good.lines === 91 &&
    good.functions === 90 &&
    good.branches === 82 &&
    good.statements === 89
  ) {
    ok('extracts all four metrics from a well-formed thresholds block')
  } else {
    bad('extracts all four metrics from a well-formed thresholds block', JSON.stringify(good))
  }

  // 2. Ratchet: a block missing a metric (regression — e.g. a threshold key
  //    renamed or removed) must be REJECTED, not silently formatted with a
  //    missing/undefined number. Anchored on a real partial block, not a
  //    contrived string, so this cannot pass by construction.
  const partial = extractThresholds('thresholds: { lines: 91, functions: 90, branches: 82 }')
  if (partial === null) {
    ok('rejects a thresholds block missing a metric')
  } else {
    bad('rejects a thresholds block missing a metric', JSON.stringify(partial))
  }

  // 3. Ratchet: absent thresholds block entirely must be REJECTED (not
  //    silently produce `undefined` clauses).
  const absent = extractThresholds('export default defineConfig({ test: {} })')
  if (absent === null) {
    ok('rejects config source with no thresholds block')
  } else {
    bad('rejects config source with no thresholds block', JSON.stringify(absent))
  }

  // 3b. Ratchet: a fractional threshold (vitest accepts these, e.g. `82.5`)
  //    must be extracted in full, not silently truncated to its integer
  //    part. An integer-only pattern would pass this metric's own presence
  //    check while quietly reporting a lower gate than the config actually
  //    enforces — wrong-but-plausible, not a loud failure.
  const fractional = extractThresholds(
    'thresholds: { lines: 91, functions: 90, branches: 82.5, statements: 89 }',
  )
  if (fractional && fractional.branches === 82.5) {
    ok('extracts a fractional threshold without truncating it')
  } else {
    bad('extracts a fractional threshold without truncating it', JSON.stringify(fractional))
  }

  // 4. Against the REAL vitest.config.ts on disk, the extracted numbers must
  //    match what the file actually says today (91/90/82/89) — this is the
  //    live anchor that would catch this script itself drifting from the
  //    config it reads.
  const real = extractThresholds(readFileSync(CONFIG_PATH, 'utf8'))
  if (
    real &&
    real.lines === 91 &&
    real.functions === 90 &&
    real.branches === 82 &&
    real.statements === 89
  ) {
    ok('extracts the current on-disk vitest.config.ts thresholds correctly')
  } else {
    bad('extracts the current on-disk vitest.config.ts thresholds correctly', JSON.stringify(real))
  }

  if (failed) {
    process.stderr.write('print-coverage-thresholds self-test FAILED\n')
    process.exit(2)
  }
  process.stdout.write('print-coverage-thresholds self-test passed\n')
}

// Only run the CLI when invoked directly. The self-test above imports
// `extractThresholds`/`formatClause` in-process, so a bare top-level
// `main()` call would fire (and, on a malformed config, `process.exit(1)`)
// merely from being imported. Sanctioned realpath form (#3376) — comparing
// `import.meta.url` against a `file://${process.argv[1]}` template, or
// comparing `process.argv[1]` to `import.meta.*` without wrapping both
// sides in `realpathSync(...)`, silently no-ops through a symlink.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main()
}
