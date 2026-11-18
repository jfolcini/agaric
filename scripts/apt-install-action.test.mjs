import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ACTION_PATH = join(
  import.meta.dirname,
  '..',
  '.github',
  'actions',
  'apt-install',
  'action.yml',
)

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails — the runner owns the failure report and the exit code.

/**
 * The `install` step's `run: |` script, as the runner executes it. Read line by
 * line because scripts/ carries no YAML dependency (the reason is in
 * `check-mutants-scope.mjs`).
 */
function actionScript() {
  const lines = readFileSync(ACTION_PATH, 'utf8').split('\n')
  const id = lines.findIndex((line) => /^\s*id: install$/.test(line))
  assert.ok(id >= 0, 'apt-install has a step with id: install')
  const start = lines.findIndex((line, i) => i > id && /^\s*run: \|$/.test(line))
  const indentOf = (line) => line.search(/\S/)
  const keyIndent = indentOf(lines[start])
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    body.push(line)
  }
  const blockIndent = Math.min(...body.filter((line) => line.trim()).map(indentOf))
  return body.map((line) => line.slice(blockIndent)).join('\n')
}

const FETCH_ERRORS = [
  "E: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/pool/main/b/brotli/libbrotli-dev_1.1.0-2ubuntu0.1_amd64.deb  Temporary failure resolving 'azure.archive.ubuntu.com'",
  'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?',
]
const MISSING_PACKAGE_ERRORS = ['E: Unable to locate package libdoesnotexist']

/**
 * Run the action's script against stubbed `sudo`, `apt-get`, `sleep` and the
 * lock tools, all first on PATH. `apt-get update` exits `updateStatus`; `apt-get
 * install` fails `failures` times with `errors` on stderr and exit 100 (what
 * apt exits when a download or a lookup fails), then succeeds. `cacheHit` is
 * the restore step's output.
 */
function runAction({ failures, errors, updateStatus = 0, cacheHit = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'apt-install-action-'))
  try {
    const installs = join(dir, 'installs')
    const sleeps = join(dir, 'sleeps')
    const updates = join(dir, 'updates')
    const output = join(dir, 'output')
    for (const file of [installs, sleeps, updates, output]) writeFileSync(file, '')
    const stub = (name, body) => {
      const path = join(dir, name)
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub('sudo', 'exec "$@"')
    stub(
      'apt-get',
      [
        `if [ "$1" = update ]; then echo update >> ${JSON.stringify(updates)}; exit ${updateStatus}; fi`,
        `echo "$@" >> ${JSON.stringify(installs)}`,
        `if [ "$(wc -l < ${JSON.stringify(installs)})" -le ${failures === Infinity ? 999 : failures} ]; then`,
        ...errors.map((line) => `  echo ${JSON.stringify(line)} >&2`),
        '  exit 100',
        'fi',
        'echo "Setting up libfoo (1.0) ..."',
      ].join('\n'),
    )
    stub('sleep', `echo "$1" >> ${JSON.stringify(sleeps)}`)
    stub('pkill', 'exit 1')
    stub('fuser', 'exit 1')
    stub('dpkg', 'exit 0')

    const script = join(dir, 'run.sh')
    writeFileSync(script, actionScript())
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        APT_PACKAGES: 'libfoo libbar',
        APT_UPDATE_TIMEOUT: '300',
        APT_INSTALL_TIMEOUT: '300',
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_OUTPUT: output,
        APT_CACHE_HIT: cacheHit,
      },
    })
    const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      installs: lines(installs).length,
      sleeps: lines(sleeps).length,
      updates: lines(updates).length,
      output: readFileSync(output, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('a download the mirror cannot serve twice is an infra failure, exit 75', () => {
  const run = runAction({ failures: Infinity, errors: FETCH_ERRORS })
  assert.equal(run.status, 75, run.stdout + run.stderr)
  assert.match(run.stdout, /AGARIC_APT_INFRA/)
  assert.equal(run.installs, 2)
  assert.equal(run.updates, 1)
  assert.equal(run.sleeps, 1)
})

void test('a download that fails once is retried and the step passes', () => {
  const run = runAction({ failures: 1, errors: FETCH_ERRORS })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 2)
  assert.equal(run.updates, 1)
})

void test('a package apt cannot find fails at once with apt’s own status', () => {
  const run = runAction({ failures: Infinity, errors: MISSING_PACKAGE_ERRORS })
  assert.equal(run.status, 100, run.stdout + run.stderr)
  assert.doesNotMatch(run.stdout, /AGARIC_APT_INFRA/)
  assert.equal(run.installs, 1)
  assert.equal(run.sleeps, 0)
})

void test('a refresh that never completes before a failed install is an infra failure, exit 75', () => {
  const run = runAction({ failures: Infinity, errors: MISSING_PACKAGE_ERRORS, updateStatus: 124 })
  assert.equal(run.status, 75, run.stdout + run.stderr)
  assert.match(run.stdout, /AGARIC_APT_INFRA/)
  assert.equal(run.updates, 2)
})

void test('without a cache hit the index is refreshed first, and the install is cacheable', () => {
  const run = runAction({ failures: 0, errors: [] })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 1)
  assert.equal(run.updates, 1)
  assert.equal(run.output, 'cacheable=true\n')
})

void test('on a cache hit the install touches no index', () => {
  const run = runAction({ failures: 0, errors: [], cacheHit: 'true' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 1)
  assert.equal(run.updates, 0)
})

void test('on a cache hit a failed install refreshes the index once before its retry', () => {
  const run = runAction({ failures: 1, errors: MISSING_PACKAGE_ERRORS, cacheHit: 'true' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 2)
  assert.equal(run.updates, 1)
})
