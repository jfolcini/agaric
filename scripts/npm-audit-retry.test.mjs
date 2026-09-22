import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SCRIPT_PATH = join(import.meta.dirname, 'npm-audit-retry.sh')

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails — the runner owns the failure report and the exit code.

/**
 * Run the wrapper against a stubbed `npx` and a stubbed `sleep`, both placed
 * first on PATH. Stubbing rather than seaming keeps the production script free
 * of a test-only knob; stubbing `sleep` as well is what keeps these tests
 * instant while still recording the backoff the script asked for.
 *
 * `failuresBeforeSuccess` is how many `npx` invocations exit non-zero before
 * one exits 0; `Infinity` never succeeds.
 */
function runWrapper(failuresBeforeSuccess) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-audit-retry-'))
  try {
    const callLog = join(dir, 'npx-calls')
    const sleepLog = join(dir, 'sleep-calls')
    writeFileSync(callLog, '')
    writeFileSync(sleepLog, '')

    const stub = (name, body) => {
      const path = join(dir, name)
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(path, 0o755)
    }
    // Counts its own invocations, so "fail the first N" needs no shared state
    // beyond the log the assertions read back.
    stub(
      'npx',
      [
        `echo "$@" >> ${JSON.stringify(callLog)}`,
        `calls=$(wc -l < ${JSON.stringify(callLog)})`,
        `if [ "$calls" -le ${failuresBeforeSuccess === Infinity ? 999 : failuresBeforeSuccess} ]; then`,
        '  echo "npm error audit endpoint returned an error" >&2',
        '  exit 1',
        'fi',
        'echo "🤝  All good!"',
      ].join('\n'),
    )
    stub('sleep', `echo "$1" >> ${JSON.stringify(sleepLog)}`)

    const result = spawnSync('bash', [SCRIPT_PATH], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    })
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      npxCalls: readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length,
      sleeps: readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const retryLines = (stderr) => stderr.split('\n').filter((line) => line.includes('retrying in'))

// #5089's failure: one `read ECONNRESET`, gone by the next attempt.
void test('a failure that clears on the next attempt is absorbed, with one logged retry', () => {
  const run = runWrapper(1)
  assert.equal(run.status, 0)
  assert.equal(run.npxCalls, 2)
  assert.equal(retryLines(run.stderr).length, 1)
  assert.match(run.stderr, /attempt 1 of 3 failed \(exit 1\); retrying in 5s\./)
  assert.deepEqual(run.sleeps, ['5'])
})

// The property that makes retrying safe: exhausting the budget still reds the
// gate, so a genuine advisory is not retried away.
void test('a failure that never clears fails closed, inside the attempt budget', () => {
  const run = runWrapper(Infinity)
  assert.notEqual(run.status, 0)
  assert.equal(run.npxCalls, 3)
  assert.deepEqual(run.sleeps, ['5', '15'])
  // The underlying command's own output still reaches the reader.
  assert.match(run.stderr, /npm error audit endpoint returned an error/)
  assert.match(run.stderr, /attempt 3 of 3 failed \(exit 1\); no attempts left\./)
})
