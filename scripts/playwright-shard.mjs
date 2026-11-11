#!/usr/bin/env node
// The Playwright spec files one CI shard runs, dealt by measured time.
//
//   node scripts/playwright-shard.mjs 3/4                prints shard 3's files
//   node scripts/playwright-shard.mjs --update <report>  rewrites the times
//
// Playwright's own `--shard` cuts the test list into contiguous runs of equal
// count, so the files with the slowest tests, which sort together, made one
// shard the long pole of `validate-all`. Each file's time is the sum of its
// tests' durations in a JSON-reporter run
// (`npx playwright test --reporter=json > report.json`), kept in
// e2e/spec-durations.json. A file the times do not know counts as their median.
import { globSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const DURATIONS = 'e2e/spec-durations.json'
// Playwright's default `testMatch`, under the config's `testDir`.
const SPEC_GLOB = 'e2e/**/*.{spec,test}.{js,jsx,cjs,mjs,ts,tsx,cts,mts}'

/** Deal `files` over `total` shards, longest first into the shard with the least time so far. */
export function dealSpecFiles(files, total, seconds) {
  const known = files.flatMap((file) => seconds[file] ?? []).toSorted((a, b) => a - b)
  const fallback = known[Math.floor(known.length / 2)] ?? 1
  const cost = (file) => seconds[file] ?? fallback
  const shards = Array.from({ length: total }, () => ({ files: [], time: 0 }))
  for (const file of files.toSorted((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
    const target = shards.reduce((least, shard) => (shard.time < least.time ? shard : least))
    target.files.push(file)
    target.time += cost(file)
  }
  return shards.map((shard) => shard.files.toSorted((a, b) => a.localeCompare(b)))
}

/** Each spec file's total test seconds in a Playwright JSON report, keyed by its repo path. */
export function secondsFromReport(report) {
  const seconds = {}
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = `e2e/${spec.file}`
      for (const test of spec.tests) {
        // A failed run's time says nothing about a green one, and a file
        // with no passed run counts as the median.
        for (const result of test.results.filter((r) => r.status === 'passed')) {
          seconds[file] = (seconds[file] ?? 0) + result.duration / 1000
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  for (const suite of report.suites) walk(suite)
  return Object.fromEntries(
    Object.entries(seconds)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([file, total]) => [file, Math.max(1, Math.round(total))]),
  )
}

function main([arg, reportPath]) {
  if (arg === '--update') {
    const seconds = secondsFromReport(JSON.parse(readFileSync(reportPath, 'utf8')))
    if (Object.keys(seconds).length === 0) throw new Error(`${reportPath} times no spec file`)
    writeFileSync(path.join(ROOT, DURATIONS), `${JSON.stringify(seconds, null, 2)}\n`)
    return
  }
  const match = /^(\d+)\/(\d+)$/.exec(arg ?? '')
  const [shard, total] = match ? [Number(match[1]), Number(match[2])] : [0, 0]
  if (shard < 1 || shard > total)
    throw new Error('usage: playwright-shard.mjs <k>/<n> | --update <report.json>')
  const files = globSync(SPEC_GLOB, { cwd: ROOT }).toSorted()
  const seconds = JSON.parse(readFileSync(path.join(ROOT, DURATIONS), 'utf8'))
  const mine = dealSpecFiles(files, total, seconds)[shard - 1]
  // An empty list would make `npx playwright test` run every spec.
  if (mine.length === 0) throw new Error(`shard ${arg} has no spec files`)
  console.log(mine.join(' '))
}

// Entry-point check (#3373): realpath both sides, so a test can import the helpers.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
