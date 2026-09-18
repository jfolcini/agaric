// #5110 — a cancelled fuzz lane is not a fuzz finding.
//
// The lane pre-seeds every target's status to `not_run` before it fuzzes
// anything, so a run stopped by hand leaves all of them `not_run`. Turning
// those into per-target findings filed seven unfixable lines into the tracking
// issue for one click on Cancel, each of which that issue's own instructions
// tell a reader to "fix and remove". These pin both arms: what a cancellation
// suppresses, and what it must still report.

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { allTargetsClean, buildFindings, isRunShapeFinding, main } from './file-fuzz-findings.mjs'

/** A `parseTargetResults` row. */
const row = (target, status, extra = {}) => ({
  target,
  status,
  log: '',
  artifacts: [],
  ...extra,
})

const ids = (findings) => findings.map((f) => f.id)

void test('a cancelled lane files nothing for the targets it cut short', () => {
  const results = ['deeplink_parse', 'fts_strip', 'html_parse'].map((t) => row(t, 'not_run'))
  assert.deepEqual(buildFindings(results, 'cancelled'), [])
})

void test('a lane that FAILED still files the targets it cut short', () => {
  // The other arm: `not_run` under any non-cancelled result (a job-level
  // timeout reports `failure`) is still lost coverage worth naming.
  const findings = buildFindings([row('fts_strip', 'not_run')], 'failure')
  assert.deepEqual(ids(findings), ['[not-run] fts_strip: target never executed'])
})

void test('a cancellation does not unmake a finding from a target that ran', () => {
  const results = [
    row('html_parse', 'crashed', { artifacts: ['crash-abc123'] }),
    row('import_parse', 'not_run'),
  ]
  assert.deepEqual(ids(buildFindings(results, 'cancelled')), ['[crash] html_parse: crash-abc123'])
})

void test('a cancelled lane that wrote no results at all files no [lane] finding', () => {
  assert.deepEqual(buildFindings([], 'cancelled'), [])
})

void test('a failed lane that wrote no results at all still files the [lane] finding', () => {
  // The symmetric arm of the case above: the catastrophic shape the `[lane]`
  // fallback exists for is unchanged.
  assert.deepEqual(ids(buildFindings([], 'failure')), [
    '[lane] fuzz job ended as "failure" and produced no result artifact',
  ])
})

// #5110, second half — a tracked set that resolves itself must clear. The
// filer only ever wrote on a NEW finding, so 44 minutes after the seven
// `[not-run]` lines were filed for a cancelled run, the next run fuzzed all
// seven clean and logged that it was leaving the issue exactly as it found it.

void test('every target passing is the only shape that counts as clean', () => {
  assert.equal(allTargetsClean([row('a', 'ok'), row('b', 'ok')]), true)
  assert.equal(allTargetsClean([row('a', 'ok'), row('b', 'not_run')]), false)
  assert.equal(allTargetsClean([row('a', 'crashed')]), false)
  // A lost artifact reads as zero results, never as a clean week (#3360).
  assert.equal(allTargetsClean([]), false)
})

/** Drives `main` in dry-run against a temp result dir, returning its stdout lines. */
function runMain({ statuses, jobStatus, knownIds }) {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-findings-test-'))
  writeFileSync(join(dir, 'targets.txt'), `${Object.keys(statuses).join('\n')}\n`)
  for (const [target, status] of Object.entries(statuses)) {
    writeFileSync(join(dir, `${target}.status`), `${status}\n`)
  }
  // An EMPTY `knownIds` writes no file at all: `--known-body-file` reads a
  // missing path as "no tracking issue yet", which is the shape that decides
  // whether `closeResolvedIssue` can ever see a null issue.
  const knownFile = join(dir, 'known.md')
  if (knownIds.length > 0) {
    writeFileSync(
      knownFile,
      [
        '<!-- fuzz-findings:begin -->',
        '```',
        ...knownIds,
        '```',
        '<!-- fuzz-findings:end -->',
      ].join('\n'),
    )
  }
  const lines = []
  const original = console.log
  console.log = (...args) => lines.push(args.join(' '))
  try {
    main([
      '--result-dir',
      dir,
      '--job-status',
      jobStatus,
      '--require-results',
      '--require-targets-manifest',
      '--dry-run',
      '--known-body-file',
      knownFile,
    ])
  } finally {
    console.log = original
  }
  return lines
}

const NOT_RUN_IDS = ['fts_strip', 'html_parse'].map((t) => `[not-run] ${t}: target never executed`)

void test('a clean run closes a tracking issue whose findings have all resolved', () => {
  const lines = runMain({
    statuses: { fts_strip: 'ok', html_parse: 'ok' },
    jobStatus: 'success',
    knownIds: NOT_RUN_IDS,
  })
  assert.ok(
    lines.some((l) => l.startsWith('[dry-run] would CLOSE issue #0')),
    `expected a close, got:\n${lines.join('\n')}`,
  )
})

void test('a clean run whose issue still tracks a live finding does not close it', () => {
  // The other arm: `html_parse` passed, but the crash line is still tracked and
  // this run says nothing about it, so the issue stays open and untouched.
  const lines = runMain({
    statuses: { fts_strip: 'ok', html_parse: 'ok' },
    jobStatus: 'success',
    knownIds: [...NOT_RUN_IDS, '[crash] deeplink_parse: crash-deadbeef'],
  })
  assert.ok(
    lines.some((l) => l.startsWith('no new fuzz findings')),
    `expected a no-op, got:\n${lines.join('\n')}`,
  )
  assert.ok(!lines.some((l) => l.includes('would CLOSE')))
})

void test('only findings about the run are ones a clean run disproves', () => {
  assert.equal(isRunShapeFinding('[not-run] fts_strip: target never executed'), true)
  assert.equal(
    isRunShapeFinding('[lane] fuzz job ended as "failure" and produced no result artifact'),
    true,
  )
  // A reproducer lives in `artifacts/` and is never re-executed, so a quiet
  // run is not evidence the bug is gone.
  assert.equal(isRunShapeFinding('[crash] html_parse: crash-abc123'), false)
  assert.equal(isRunShapeFinding("[build] fts_strip: error[E0463]: can't find crate"), false)
  assert.equal(isRunShapeFinding('[timeout] import_parse: timeout-abc123'), false)
  assert.equal(isRunShapeFinding('[failed] deeplink_parse: exited non-zero'), false)
})

void test('a clean run with no tracking issue at all never reaches the close', () => {
  // `closeResolvedIssue` dereferences `existingIssue.state`, which is safe only
  // because the caller cannot reach it with a null issue: `known` is parsed from
  // `existingIssue?.body`, so no issue means no `resolvedOnes`. Loosening that
  // guard throws here rather than in a weekly job nobody is watching.
  const lines = runMain({ statuses: { fts_strip: 'ok' }, jobStatus: 'success', knownIds: [] })
  assert.ok(
    lines.some((l) => l.startsWith('no new fuzz findings')),
    `expected a no-op, got:\n${lines.join('\n')}`,
  )
})
