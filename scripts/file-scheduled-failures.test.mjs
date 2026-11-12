import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SCRIPT = join(import.meta.dirname, 'file-scheduled-failures.mjs')
const NIGHTLY_SCOPE = 'select-lanes,full-suite,android-launch'
const WEEKLY_ONLY = [
  'clippy-clean',
  'bench-smoke',
  'bench-slo',
  'bench-perf-gates',
  'mutants',
  'mutants-merge',
  'mutants-frontend',
  'mutants-frontend-merge',
  'file-mutation-survivors',
  'fuzz',
  'file-fuzz-findings',
  'type-aware-lint',
]

/** `toJSON(needs)` of a nightly run: its lanes ran, every weekly-only one skipped. */
function nightlyNeeds({ fullSuite = 'success', androidLaunch = 'success' } = {}) {
  const needs = {
    'select-lanes': { result: 'success' },
    'full-suite': { result: fullSuite },
    'android-launch': { result: androidLaunch },
  }
  for (const job of WEEKLY_ONLY) needs[job] = { result: 'skipped' }
  return needs
}

function issueBody(tracked) {
  const lines = tracked.map((j) => `${j}|1|https://github.com/o/r/actions/runs/1`)
  return [
    '### Tracked failing lanes',
    '<!-- scheduled-failures:begin -->',
    '```',
    ...lines,
    '```',
    '<!-- scheduled-failures:end -->',
  ].join('\n')
}

/** Runs the reporter in --dry-run against a stubbed issue; returns its stdout. */
function report(t, { needs, tracked, scope }) {
  const dir = mkdtempSync(join(tmpdir(), 'file-scheduled-failures-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'needs.json'), JSON.stringify(needs))
  writeFileSync(join(dir, 'body.md'), tracked ? issueBody(tracked) : '')
  const args = [
    SCRIPT,
    '--needs-json-file',
    join(dir, 'needs.json'),
    '--known-body-file',
    join(dir, 'body.md'),
    '--run-url',
    'https://github.com/o/r/actions/runs/2',
    '--dry-run',
  ]
  if (scope) args.push('--scope', scope)
  return execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' })
}

const action = (out) => /\[dry-run\] action=(\w+)/.exec(out)?.[1]
const trackedIn = (out) => {
  const block = out
    .split('<!-- scheduled-failures:begin -->')[1]
    ?.split('<!-- scheduled-failures:end -->')[0]
  return (block ?? '')
    .split('\n')
    .map((l) => l.trim().split('|')[0])
    .filter((l) => l && l !== '```')
}

void test('a green nightly run leaves a weekly lane the issue tracks alone', (t) => {
  const out = report(t, { needs: nightlyNeeds(), tracked: ['mutants'], scope: NIGHTLY_SCOPE })
  assert.match(out, /no newly-failing lane — no-op \(still failing: mutants;/)
})

void test('a nightly run that recovers its own lane keeps the weekly one tracked', (t) => {
  const out = report(t, {
    needs: nightlyNeeds(),
    tracked: ['full-suite', 'mutants'],
    scope: NIGHTLY_SCOPE,
  })
  assert.equal(action(out), 'sync')
  assert.deepEqual(trackedIn(out), ['mutants'])
  assert.match(out, /^\| `mutants` \| ➖ not in this run \|$/m)
})

void test('a nightly run that recovers the only tracked lane closes the issue', (t) => {
  const out = report(t, { needs: nightlyNeeds(), tracked: ['full-suite'], scope: NIGHTLY_SCOPE })
  assert.equal(action(out), 'close')
  assert.deepEqual(trackedIn(out), [])
})

void test('a nightly failure is reported by its lane name, and only that lane', (t) => {
  const out = report(t, {
    needs: nightlyNeeds({ fullSuite: 'failure' }),
    tracked: ['mutants'],
    scope: NIGHTLY_SCOPE,
  })
  assert.equal(action(out), 'notify')
  assert.match(out, /\*\*1 scheduled-deep-checks lane newly failing this run:\*\* `full-suite`/)
  assert.deepEqual(trackedIn(out), ['full-suite', 'mutants'])
})

void test('without a scope every lane is judged, as on the weekly run', (t) => {
  const out = report(t, { needs: nightlyNeeds(), tracked: ['full-suite'] })
  assert.equal(action(out), 'notify')
  assert.deepEqual(trackedIn(out), WEEKLY_ONLY.toSorted())
})

void test('a scope naming a job the run does not carry is an error', (t) => {
  assert.throws(
    () => report(t, { needs: nightlyNeeds(), tracked: [], scope: 'select-lanes,full-sweet' }),
    (err) => err.status === 1 && /--scope names full-sweet/.test(String(err.stderr)),
  )
})
