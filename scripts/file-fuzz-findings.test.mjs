// #5110 — a cancelled fuzz lane is not a fuzz finding.
//
// The lane pre-seeds every target's status to `not_run` before it fuzzes
// anything, so a run stopped by hand leaves all of them `not_run`. Turning
// those into per-target findings filed seven unfixable lines into the tracking
// issue for one click on Cancel, each of which that issue's own instructions
// tell a reader to "fix and remove". These pin both arms: what a cancellation
// suppresses, and what it must still report.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFindings } from './file-fuzz-findings.mjs'

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
