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

// Only run the CLI when invoked directly. `extractThresholds` /
// `formatClause` are exported, so a bare top-level `main()` call would fire
// (and, on a malformed config, `process.exit(1)`) merely from being
// imported. Sanctioned realpath form (#3376) — comparing
// `import.meta.url` against a `file://${process.argv[1]}` template, or
// comparing `process.argv[1]` to `import.meta.*` without wrapping both
// sides in `realpathSync(...)`, silently no-ops through a symlink.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main()
}
