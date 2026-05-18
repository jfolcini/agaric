#!/usr/bin/env node
// Merge per-shard `coverage-final.json` files produced by vitest's v8
// provider into one aggregate coverage map, then emit
// `coverage-merged/coverage-summary.json` with the standard
// istanbul summary shape (matches what vitest emits when run unsharded).
//
// Why this exists: PEND-41 R17 originally ran `--coverage` only on
// shard 1 of the 3-way vitest split so the step-summary had numbers to
// render. That's ⅓-of-the-suite coverage, which understates real
// coverage and is misleading when read at face value. Running coverage
// on all 3 shards is cheap (~2 min v8-instrumentation overhead per
// shard, in parallel — no wall-clock cost); merging is a single
// post-shards CI job that downloads the 3 partial reports and unifies
// them.
//
// Uses `istanbul-lib-coverage` (a transitive dep via @vitest/coverage-v8
// — no new package install needed). The library handles the proper
// merge semantics: overlapping covered lines are deduped, not
// double-counted (`CoverageMap.merge` does the right thing for v8
// and istanbul-shape JSONs alike).
//
// Usage:
//   node scripts/merge-vitest-coverage.mjs \
//        coverage-shard-1/coverage-final.json \
//        coverage-shard-2/coverage-final.json \
//        coverage-shard-3/coverage-final.json
//
// Output:
//   coverage-merged/coverage-final.json   — merged raw data
//   coverage-merged/coverage-summary.json — istanbul summary shape
//
// Exit codes: 0 ok / 1 input error / 2 merge failure.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import istanbul from 'istanbul-lib-coverage'

const OUT_DIR = 'coverage-merged'

function die(code, msg) {
  process.stderr.write(`merge-vitest-coverage: ${msg}\n`)
  process.exit(code)
}

const inputs = process.argv.slice(2)
if (inputs.length < 2) {
  die(1, `expected at least 2 input coverage-final.json paths; got ${inputs.length}`)
}

const map = istanbul.createCoverageMap({})
for (const p of inputs) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    die(1, `read ${p}: ${e.message}`)
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    die(1, `parse ${p}: ${e.message}`)
  }
  try {
    map.merge(data)
  } catch (e) {
    die(2, `merge ${p}: ${e.message}`)
  }
}

mkdirSync(OUT_DIR, { recursive: true })

// Write merged raw data (same shape vitest produces).
writeFileSync(resolve(OUT_DIR, 'coverage-final.json'), JSON.stringify(map.toJSON()))

// Build the istanbul-style summary: a totals row + one entry per file.
// `CoverageMap.getCoverageSummary()` aggregates the FileCoverage entries
// into a single CoverageSummaryData; we wrap it in the same envelope
// vitest's `json-summary` reporter emits so downstream tooling can
// consume it identically.
const totals = map.getCoverageSummary()
const summary = { total: totals.toJSON() }
for (const file of map.files()) {
  summary[file] = map.fileCoverageFor(file).toSummary().toJSON()
}
writeFileSync(resolve(OUT_DIR, 'coverage-summary.json'), JSON.stringify(summary, null, 2))

// One-line stdout for the CI step to grep on.
const t = totals.toJSON()
process.stdout.write(
  `merged ${inputs.length} shards → lines=${t.lines.pct}% functions=${t.functions.pct}% ` +
    `statements=${t.statements.pct}% branches=${t.branches.pct}% ` +
    `(covered ${t.lines.covered}/${t.lines.total} lines)\n`,
)
