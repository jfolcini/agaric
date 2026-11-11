import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import yaml from 'js-yaml'

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

/** The composite action's one `run:` script, as the runner executes it. */
function actionScript() {
  const action = yaml.load(readFileSync(ACTION_PATH, 'utf8'))
  const steps = action.runs.steps.filter((step) => typeof step.run === 'string')
  assert.equal(steps.length, 1, 'apt-install has exactly one run step')
  return steps[0].run
}

const MISSING_PACKAGE_ERRORS = ['E: Unable to locate package libdoesnotexist']

const AZURE = 'azure.archive.ubuntu.com'
const AZURE_LINE = `http://${AZURE}/ubuntu/\tpriority:1`
const ARCHIVE_LINE = 'https://archive.ubuntu.com/ubuntu/\tpriority:2'
const SECURITY_LINE = 'https://security.ubuntu.com/ubuntu/\tpriority:3'
/** `lines` as the mirror list holds them, one per line. */
const mirrorList = (...lines) => lines.map((line) => `${line}\n`).join('')
const IMAGE_MIRRORS = mirrorList(AZURE_LINE, ARCHIVE_LINE, SECURITY_LINE)
/** What `apt-get install` prints when `host` does not resolve. */
const unresolvableErrors = (host) => [
  `E: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/pool/main/b/brotli/libbrotli-dev_1.1.0-2ubuntu0.1_amd64.deb  Temporary failure resolving '${host}'`,
  'E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?',
]
const UNRESOLVABLE_AZURE = unresolvableErrors(AZURE)

/**
 * Run the action's script against stubbed `sudo`, `apt-get`, `sleep` and the
 * lock tools, all first on PATH. `apt-get update` always succeeds; `apt-get
 * install` fails `failures` times with `errors` on stderr and exit 100 (what
 * apt exits when a download or a lookup fails), then succeeds.
 *
 * With `mirrors`, the image's `/etc/apt/apt-mirrors.txt` holds that text (the
 * `sudo` stub points every use of that path at a temp copy), and the install
 * instead fails with a resolve error for `unresolvable` (Azure unless given)
 * for as long as the list still names that host: the outage the image's own
 * mirror failover does not ride out.
 *
 * @param {{ failures?: number, errors?: string[], mirrors?: string | null, unresolvable?: string }} options
 */
function runAction({ failures = 0, errors = [], mirrors = null, unresolvable = AZURE }) {
  const dir = mkdtempSync(join(tmpdir(), 'apt-install-action-'))
  try {
    const installs = join(dir, 'installs')
    const updates = join(dir, 'updates')
    const sleeps = join(dir, 'sleeps')
    const mirrorFile = join(dir, 'apt-mirrors.txt')
    writeFileSync(installs, '')
    writeFileSync(updates, '')
    writeFileSync(sleeps, '')
    if (mirrors !== null) writeFileSync(mirrorFile, mirrors)
    const stub = (name, body) => {
      const path = join(dir, name)
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub(
      'sudo',
      [
        "from='/etc/apt/apt-mirrors.txt'",
        `to=${JSON.stringify(mirrorFile)}`,
        'exec "${@//"$from"/"$to"}"',
      ].join('\n'),
    )
    const failing =
      mirrors === null
        ? `[ "$(wc -l < ${JSON.stringify(installs)})" -le ${failures === Infinity ? 999 : failures} ]`
        : `grep -qF ${JSON.stringify(`//${unresolvable}/`)} ${JSON.stringify(mirrorFile)}`
    const failingErrors = mirrors === null ? errors : unresolvableErrors(unresolvable)
    stub(
      'apt-get',
      [
        `[ "$1" = update ] && { echo update >> ${JSON.stringify(updates)}; exit 0; }`,
        `echo "$@" >> ${JSON.stringify(installs)}`,
        `if ${failing}; then`,
        ...failingErrors.map((line) => `  echo ${JSON.stringify(line)} >&2`),
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
      },
    })
    const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      installs: lines(installs).length,
      updates: lines(updates).length,
      sleeps: lines(sleeps).length,
      mirrors: mirrors === null ? null : readFileSync(mirrorFile, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void test('a download the mirror cannot serve twice is an infra failure, exit 75', () => {
  const run = runAction({ failures: Infinity, errors: UNRESOLVABLE_AZURE })
  assert.equal(run.status, 75, run.stdout + run.stderr)
  assert.match(run.stdout, /AGARIC_APT_INFRA/)
  assert.equal(run.installs, 2)
  assert.equal(run.sleeps, 1)
})

void test('a download that fails once is retried and the step passes', () => {
  const run = runAction({ failures: 1, errors: UNRESOLVABLE_AZURE })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 2)
})

void test('a package apt cannot find fails at once with apt’s own status', () => {
  const run = runAction({ failures: Infinity, errors: MISSING_PACKAGE_ERRORS })
  assert.equal(run.status, 100, run.stdout + run.stderr)
  assert.doesNotMatch(run.stdout, /AGARIC_APT_INFRA/)
  assert.equal(run.installs, 1)
  assert.equal(run.sleeps, 0)
})

void test('an install that works the first time passes with no retry', () => {
  const run = runAction({ failures: 0, errors: [] })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 1)
  assert.equal(run.sleeps, 0)
})

void test('a mirror that does not resolve is dropped and the retry installs from the next one', () => {
  const run = runAction({ mirrors: IMAGE_MIRRORS })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 2)
  assert.equal(run.updates, 2, 'the package lists are refreshed from the mirrors left')
  assert.equal(run.sleeps, 0)
  assert.equal(run.mirrors, mirrorList(ARCHIVE_LINE, SECURITY_LINE))
})

void test('the last mirror in the list is never dropped', () => {
  const run = runAction({ mirrors: mirrorList(AZURE_LINE) })
  assert.equal(run.status, 75, run.stdout + run.stderr)
  assert.equal(run.mirrors, mirrorList(AZURE_LINE))
  assert.equal(run.installs, 2)
  assert.equal(run.updates, 1)
  assert.equal(run.sleeps, 1)
})

void test('only the mirror named as unresolvable is dropped, not one whose name contains it', () => {
  const run = runAction({ mirrors: IMAGE_MIRRORS, unresolvable: 'archive.ubuntu.com' })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.mirrors, mirrorList(AZURE_LINE, SECURITY_LINE))
})
