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

import {
  allTargetsClean,
  buildFindings,
  buildIssueBody,
  isRetestedEachRun,
  main,
  parseKnownDetails,
  parseKnownFindings,
} from './file-fuzz-findings.mjs'

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
function runMain({ statuses, jobStatus, knownIds = [], knownBody, logs = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-findings-test-'))
  writeFileSync(join(dir, 'targets.txt'), `${Object.keys(statuses).join('\n')}\n`)
  for (const [target, status] of Object.entries(statuses)) {
    writeFileSync(join(dir, `${target}.status`), `${status}\n`)
  }
  for (const [target, log] of Object.entries(logs)) {
    writeFileSync(join(dir, `${target}.log`), log)
  }
  // An EMPTY `knownIds` writes no file at all: `--known-body-file` reads a
  // missing path as "no tracking issue yet", which is the shape that decides
  // whether `closeResolvedIssue` can ever see a null issue.
  const knownFile = join(dir, 'known.md')
  const body =
    knownBody ??
    (knownIds.length > 0
      ? [
          '<!-- fuzz-findings:begin -->',
          '```',
          ...knownIds,
          '```',
          '<!-- fuzz-findings:end -->',
        ].join('\n')
      : '')
  if (body) writeFileSync(knownFile, body)
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

void test('a clean run whose issue tracks only a live finding leaves it untouched', () => {
  // The other arm: `html_parse` passed, but the crash line is still tracked and
  // this run says nothing about it — nothing to close, nothing to clear.
  const lines = runMain({
    statuses: { fts_strip: 'ok', html_parse: 'ok' },
    jobStatus: 'success',
    knownIds: ['[crash] deeplink_parse: crash-deadbeef'],
  })
  assert.ok(
    lines.some((l) => l.startsWith('no new fuzz findings')),
    `expected a no-op, got:\n${lines.join('\n')}`,
  )
  assert.ok(!lines.some((l) => l.includes('would CLOSE') || l.includes('would CLEAR')))
})

void test('a run re-tests the run-shape and build claims, and no other kind', () => {
  assert.equal(isRetestedEachRun('[not-run] fts_strip: target never executed'), true)
  assert.equal(
    isRetestedEachRun('[lane] fuzz job ended as "failure" and produced no result artifact'),
    true,
  )
  // Compiled from scratch every week, so a run that reported any status for the
  // target has re-answered this.
  assert.equal(isRetestedEachRun("[build] fts_strip: error[E0463]: can't find crate"), true)
  // A reproducer lives in `artifacts/` and is never re-executed, so a quiet
  // run is not evidence the bug is gone.
  assert.equal(isRetestedEachRun('[crash] html_parse: crash-abc123'), false)
  assert.equal(isRetestedEachRun('[timeout] import_parse: timeout-abc123'), false)
  // An unrecognised status says nothing either way; retained conservatively.
  assert.equal(isRetestedEachRun('[failed] deeplink_parse: exited non-zero'), false)
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

// #5112 — a clean run disproves the run-shape lines in a MIXED set too. Leaving
// them in the block was not inert: a finding id is the dedup key, so the stale
// line swallowed the identical id from the next run that genuinely lost that
// target, which reported nothing at all.

const CRASH_ID = '[crash] html_parse: crash-abc123'
const LOST_ID = '[not-run] fts_strip: target never executed'

/** The body `main` printed under its dry-run header (one `console.log` arg). */
const dryRunBody = (lines) => lines[lines.indexOf('[dry-run] --- issue body ---') + 1]

void test('a clean run clears a disproved line from a mixed set, leaving the rest tracked', () => {
  const cleared = runMain({
    statuses: { fts_strip: 'ok', html_parse: 'ok' },
    jobStatus: 'success',
    knownIds: [LOST_ID, CRASH_ID],
  })
  assert.ok(
    !cleared.some((l) => l.includes('would CLOSE')),
    `a tracked crash must keep the issue open, got:\n${cleared.join('\n')}`,
  )
  const body = dryRunBody(cleared)
  assert.deepEqual([...parseKnownFindings(body)], [CRASH_ID])

  // The run #5112 is about: `fts_strip` is genuinely lost to a job-level timeout
  // and regenerates the identical id. Cleared, it is new again; left in the
  // block, this run reported nothing.
  const lost = runMain({
    statuses: { fts_strip: 'not_run', html_parse: 'ok' },
    jobStatus: 'failure',
    knownBody: body,
  })
  assert.ok(
    lost.some((l) => l.startsWith('[dry-run] new findings: 1,')),
    `expected the lost target to be reported as new, got:\n${lost.join('\n')}`,
  )
  assert.ok(lost[lost.indexOf('[dry-run] --- new-finding comment ---') + 1].includes(LOST_ID))
})

void test('a retained finding keeps its reproduce command across the clear', () => {
  const detail =
    'Reproducer `src-tauri/fuzz/artifacts/html_parse/crash-abc123` (…then `cargo +nightly fuzz run html_parse artifacts/html_parse/crash-abc123`).\n\n==1== ERROR: libFuzzer: deadly signal'
  const known = buildIssueBody({
    all: [CRASH_ID, LOST_ID].toSorted(),
    newOnes: [],
    resolvedOnes: [],
    byId: new Map([[CRASH_ID, { id: CRASH_ID, detail }]]),
  })
  const body = dryRunBody(
    runMain({
      statuses: { fts_strip: 'ok', html_parse: 'ok' },
      jobStatus: 'success',
      knownBody: known,
    }),
  )
  assert.deepEqual([...parseKnownFindings(body)], [CRASH_ID])
  // This run found nothing, so the old body is the only copy of the one part of
  // the issue a human needs.
  assert.ok(body.includes(`<code>${CRASH_ID}</code>`), `details header lost:\n${body}`)
  assert.ok(body.includes(detail), `details lost from the rewritten body:\n${body}`)
})

void test('parseKnownDetails round-trips the details buildIssueBody rendered', () => {
  const angled = '[failed] fts_strip: panicked at <unknown>'
  const entries = [
    [angled, { id: angled, detail: 'first\nsecond' }],
    [CRASH_ID, { id: CRASH_ID, detail: 'repro line\n\nlog tail' }],
  ]
  const body = buildIssueBody({
    all: [angled, CRASH_ID, LOST_ID].toSorted(),
    newOnes: [],
    resolvedOnes: [],
    byId: new Map(entries),
  })
  const parsed = parseKnownDetails(body)
  for (const [id, finding] of entries) assert.deepEqual(parsed.get(id), finding)
  // LOST_ID had no detail to render, so it has none to read back.
  assert.equal(parsed.size, 2)
})

void test('parseKnownDetails reads a body without details as empty rather than throwing', () => {
  const rendered = buildIssueBody({ all: [CRASH_ID], newOnes: [], resolvedOnes: [] })
  assert.equal(parseKnownDetails(rendered).size, 0)
  // What the two body clamps leave behind, and the no-issue-yet case.
  assert.equal(parseKnownDetails('### Details\n\n_Details omitted (too long)._').size, 0)
  assert.equal(parseKnownDetails('').size, 0)
  assert.equal(parseKnownDetails(undefined).size, 0)
})

// The update path is the tracked set's other write, and it used to rewrite the
// block with this run's findings alone — so any week with a new finding dropped
// every earlier `[crash]`, its reproduce command and its excerpt, silently.

void test('a new finding does not drop the crash this run said nothing about', () => {
  const detail =
    'Reproducer `src-tauri/fuzz/artifacts/html_parse/crash-abc123`.\n\n==1== ERROR: libFuzzer: deadly signal'
  const known = buildIssueBody({
    all: [CRASH_ID],
    newOnes: [],
    resolvedOnes: [],
    byId: new Map([[CRASH_ID, { id: CRASH_ID, detail }]]),
  })
  const body = dryRunBody(
    runMain({
      statuses: { fts_strip: 'not_run', html_parse: 'ok' },
      jobStatus: 'failure',
      knownBody: known,
    }),
  )
  assert.deepEqual([...parseKnownFindings(body)], [CRASH_ID, LOST_ID].toSorted())
  assert.ok(body.includes(detail), `the retained crash lost its reproducer:\n${body}`)
  // "Resolved since last run" names what left the block, so a retained line is
  // not one of them.
  assert.ok(!body.includes('### Resolved since last run'), `crash reported resolved:\n${body}`)
})

void test('a [not-run] line the run disproved leaves the block as a new finding lands', () => {
  // The other arm: `fts_strip` ran, so its line is the one claim this run did
  // settle, and it must go — a stale id is a dedup key that swallows its own
  // recurrence (#5112).
  const body = dryRunBody(
    runMain({
      statuses: { fts_strip: 'ok', html_parse: 'crashed' },
      jobStatus: 'failure',
      knownIds: [LOST_ID],
    }),
  )
  assert.deepEqual([...parseKnownFindings(body)], ['[crash] html_parse: reproducer not captured'])
  assert.ok(
    body.includes('### Resolved since last run (1)') && body.includes(LOST_ID),
    `the dropped line must be reported as resolved:\n${body}`,
  )
})

void test('a build error the next run did not reproduce leaves the block', () => {
  // Week 1 files E0432. Week 2 the import is fixed and a different error lands,
  // so the target re-answered its own build claim: E0432 must go, or week 3's
  // recurrence hits it as a dedup key and reports nothing (#5112's shape, in
  // the one category the reproducer argument does not cover).
  const E0432 = '[build] html_parse: error[E0432]: unresolved import `foo`'
  const week2 = dryRunBody(
    runMain({
      statuses: { fts_strip: 'ok', html_parse: 'build_failed' },
      jobStatus: 'failure',
      logs: { html_parse: 'error[E0599]: no method named `bar`\n' },
      knownIds: [E0432],
    }),
  )
  assert.deepEqual(
    [...parseKnownFindings(week2)],
    ['[build] html_parse: error[E0599]: no method named `bar`'],
    `E0432 should have left the block:\n${week2}`,
  )

  // Week 3: E0432 recurs against a block that no longer holds it, so it is new.
  const week3 = runMain({
    statuses: { fts_strip: 'ok', html_parse: 'build_failed' },
    jobStatus: 'failure',
    logs: { html_parse: 'error[E0432]: unresolved import `foo`\n' },
    knownIds: [...parseKnownFindings(week2)],
  })
  assert.ok(
    week3.some((l) => l.startsWith('[dry-run] new findings: 1,')),
    `the recurrence must be reported, got:\n${week3.join('\n')}`,
  )
  assert.ok(week3[week3.indexOf('[dry-run] --- new-finding comment ---') + 1].includes(E0432))
})
