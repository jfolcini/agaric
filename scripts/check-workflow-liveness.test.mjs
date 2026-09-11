import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyWorkflow, newestCompletedRunId } from './check-workflow-liveness.mjs'

const NOW = Date.parse('2026-09-11T10:00:00Z')

// `gh run list --json databaseId,status,conclusion,createdAt,url` rows;
// `orderedRuns` sorts by `createdAt` newest-first regardless of input order.
function run(databaseId, minutesAgo, status, conclusion = null) {
  return {
    databaseId,
    status,
    conclusion,
    createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    url: `https://example.test/runs/${databaseId}`,
  }
}
const lane = { nowMs: NOW, workflow: 'ci.yml', maxAgeHours: 0, event: 'push' }

// #3388 — a queued `main` run cancelled by the next merge's run is GitHub's
// concurrency rule, not a red merge. The tick that filed #3388's ci.yml row
// saw exactly this shape: the next merge's run queued, the cancelled one it
// superseded, an older run still in progress, and the last real verdict
// behind them all.
void test('a superseded cancelled run is skipped in favour of the last real verdict', () => {
  const runs = [
    run(4, 1, 'in_progress'),
    run(3, 9, 'completed', 'cancelled'),
    run(2, 30, 'in_progress'),
    run(1, 38, 'completed', 'success'),
  ]
  assert.equal(classifyWorkflow({ ...lane, runs }), 'success')
  assert.equal(newestCompletedRunId({ runs, workflow: 'ci.yml' }), 1)
})

void test('skipping a superseded cancelled run still surfaces an older real failure', () => {
  const runs = [
    run(4, 1, 'in_progress'),
    run(3, 9, 'completed', 'cancelled'),
    run(1, 38, 'completed', 'failure'),
  ]
  assert.match(
    classifyWorkflow({ ...lane, runs }),
    /^failure \(newest completed push run concluded `failure`\)/,
  )
  assert.equal(newestCompletedRunId({ runs, workflow: 'ci.yml' }), 1)
})

void test('a superseded cancelled run with nothing else completed waits for the newer run', () => {
  const runs = [run(3, 1, 'in_progress'), run(2, 5, 'completed', 'cancelled')]
  assert.match(classifyWorkflow({ ...lane, runs }), /^no-completed-run /)
  assert.equal(newestCompletedRunId({ runs, workflow: 'ci.yml' }), null)
})

void test('the newest run being cancelled with nothing after it is still a failure', () => {
  const runs = [run(2, 5, 'completed', 'cancelled'), run(1, 60, 'completed', 'success')]
  assert.match(classifyWorkflow({ ...lane, runs }), /concluded `cancelled`/)
  assert.equal(newestCompletedRunId({ runs, workflow: 'ci.yml' }), 2)
})

void test('two superseded cancelled runs are both skipped', () => {
  const runs = [
    run(4, 1, 'in_progress'),
    run(3, 2, 'completed', 'cancelled'),
    run(2, 30, 'completed', 'cancelled'),
    run(1, 45, 'completed', 'success'),
  ]
  assert.equal(classifyWorkflow({ ...lane, runs }), 'success')
  assert.equal(newestCompletedRunId({ runs, workflow: 'ci.yml' }), 1)
})
