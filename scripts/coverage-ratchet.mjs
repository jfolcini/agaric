#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Coverage ratchet (#648) — patch-level coverage signal; HARD-GATES with `--gate`.
//
// Coverage is already produced on every CI run (Rust: `coverage.lcov`
// merged across the cargo-tests shards; vitest: `coverage-summary.json`)
// and then discarded — the data is paid for but only rendered as a table.
// This script turns it into a ratchet: it computes total LINE coverage from
// a coverage artifact and compares it against a checked-in baseline
// (`scripts/coverage-baseline.json`). A DROP beyond a small tolerance is
// surfaced loudly in the step summary. By default the script exits 0
// (non-blocking signal); with `--gate` a drop beyond tolerance exits 1 (the
// rust call uses `--gate` so cargo-coverage — now in validate-all's needs —
// fails the merge gate). The NOISE_TOLERANCE_PP slack absorbs llvm-cov jitter.
//
// Two input shapes are accepted:
//   --lcov <path>      LLVM/lcov tracefile (Rust) — sums LF/LH records.
//   --summary <path>   istanbul json-summary (vitest) — reads .total.lines.
//
// Usage:
//   node scripts/coverage-ratchet.mjs --summary coverage-merged/coverage-summary.json --key vitest
//   node scripts/coverage-ratchet.mjs --lcov coverage.lcov --key rust --gate
//   node scripts/coverage-ratchet.mjs --summary <path> --key vitest --update
//
// Exit: 0 by default; 1 when `--gate` is set AND coverage dropped beyond tolerance.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'coverage-baseline.json')

// A drop smaller than this (percentage points) is run-to-run noise, not a
// regression worth surfacing. Coverage instrumentation varies slightly
// shard-to-shard / run-to-run.
const NOISE_TOLERANCE_PP = 0.5

function parseArgs(argv) {
  const args = { update: false, gate: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--update') args.update = true
    else if (a === '--gate') args.gate = true
    else if (a === '--lcov') args.lcov = argv[++i]
    else if (a === '--summary') args.summary = argv[++i]
    else if (a === '--key') args.key = argv[++i]
  }
  return args
}

/** Total line coverage % from an lcov tracefile (sum LH / sum LF). */
function lineCoverageFromLcov(path) {
  // A missing/unreadable artifact degrades to "no data" (return null) rather
  // than throwing — this script's contract is ALWAYS exit 0 (non-blocking),
  // and the CI `hashFiles()` guard can still race a deleted/partial artifact.
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let found = 0
  let hit = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('LF:')) found += Number(line.slice(3))
    else if (line.startsWith('LH:')) hit += Number(line.slice(3))
  }
  if (found === 0) return null
  return (hit / found) * 100
}

/** Total line coverage % from an istanbul json-summary. */
function lineCoverageFromSummary(path) {
  // Same no-throw contract as lineCoverageFromLcov: a missing/empty/malformed
  // summary degrades to "no data", never aborts the non-blocking step.
  let json
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const pct = json?.total?.lines?.pct
  return typeof pct === 'number' ? pct : null
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {}
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(baseline) {
  const doc = {
    _comment:
      'Coverage ratchet baseline (#648) — total LINE coverage % per suite, ' +
      'MEASURED from a real CI-equivalent run. The coverage-ratchet script ' +
      'compares each run against these and surfaces a drop in the step ' +
      'summary (NON-BLOCKING — coverage is not gated, per #648). ' +
      'Re-baseline on main with `--update` after a deliberate change.',
    ...baseline,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(doc, null, 2) + '\n')
}

function appendStepSummary(md) {
  const out = process.env['GITHUB_STEP_SUMMARY']
  if (out) {
    // eslint-disable-next-line no-sync
    writeFileSync(out, md + '\n', { flag: 'a' })
  } else {
    process.stdout.write(md + '\n')
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.key) {
    console.error('ERROR: --key <vitest|rust> is required.')
    return 0 // still non-blocking
  }

  let pct = null
  if (args.lcov) pct = lineCoverageFromLcov(args.lcov)
  else if (args.summary) pct = lineCoverageFromSummary(args.summary)
  else {
    console.error('ERROR: one of --lcov / --summary is required.')
    return 0
  }

  if (pct === null) {
    appendStepSummary(
      `### Coverage ratchet (${args.key}): no data (artifact missing or empty) — skipped.`,
    )
    return 0
  }

  const rounded = Math.round(pct * 100) / 100
  const baseline = readBaseline()

  if (args.update) {
    const next = { ...baseline }
    delete next._comment
    next[args.key] = rounded
    writeBaseline(next)
    console.log(`Updated coverage baseline: ${args.key} = ${rounded}%`)
    return 0
  }

  const base = baseline[args.key]
  if (typeof base !== 'number') {
    appendStepSummary(
      `### Coverage ratchet (${args.key})\n\n` +
        `Line coverage: **${rounded}%** (no baseline yet — set one with ` +
        `\`node scripts/coverage-ratchet.mjs --${args.lcov ? 'lcov' : 'summary'} <path> ` +
        `--key ${args.key} --update\` on main).`,
    )
    return 0
  }

  const delta = rounded - base
  const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(2)
  const dropped = delta < -NOISE_TOLERANCE_PP
  let verdict
  if (dropped) {
    const tail = args.gate
      ? `**This is a HARD GATE (\`--gate\`) — failing the job.** ` +
        `If the drop is intentional, re-baseline on main with \`--update\`.`
      : `This is non-blocking, but check whether a new module landed without tests. ` +
        `If the drop is intentional, re-baseline on main.`
    verdict =
      `⚠️ **Line coverage dropped ${deltaStr}pp vs baseline** ` +
      `(${rounded}% < ${base}%, tolerance ${NOISE_TOLERANCE_PP}pp). ${tail}`
  } else if (delta > NOISE_TOLERANCE_PP) {
    verdict = `✅ Line coverage up ${deltaStr}pp vs baseline (${rounded}% ≥ ${base}%). Consider re-baselining on main to ratchet the floor.`
  } else {
    verdict = `✅ Line coverage steady (${rounded}% vs ${base}% baseline, ${deltaStr}pp).`
  }

  appendStepSummary(`### Coverage ratchet (${args.key})\n\n${verdict}`)
  // Hard gate only when --gate is set AND coverage dropped beyond tolerance.
  return args.gate && dropped ? 1 : 0
}

process.exit(main())
