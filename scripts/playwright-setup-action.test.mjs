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
  'playwright-setup',
  'action.yml',
)

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails — the runner owns the failure report and the exit code.

/**
 * The retry script the "Install Playwright system deps" step writes to
 * `pw-install-deps.sh`: the `DEPS` heredoc inside its `run: |` block. Read line
 * by line because scripts/ carries no YAML dependency (the reason is in
 * `check-mutants-scope.mjs`).
 */
function actionScript() {
  const lines = readFileSync(ACTION_PATH, 'utf8').split('\n')
  const step = lines.findIndex((line) => /^\s*- name: Install Playwright system deps$/.test(line))
  assert.ok(step >= 0, 'playwright-setup has an "Install Playwright system deps" step')
  const start = lines.findIndex((line, i) => i > step && /^\s*run: \|$/.test(line))
  const indentOf = (line) => line.search(/\S/)
  const keyIndent = indentOf(lines[start])
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    body.push(line)
  }
  const blockIndent = Math.min(...body.filter((line) => line.trim()).map(indentOf))
  const run = body.map((line) => line.slice(blockIndent))
  const open = run.findIndex((line) => line.endsWith("<<'DEPS'"))
  const close = run.indexOf('DEPS')
  assert.ok(open >= 0 && close > open, 'the step writes its script through a DEPS heredoc')
  return run.slice(open + 1, close).join('\n')
}

const MISSING_PACKAGE_ERRORS = [
  'E: Unable to locate package fonts-unifont',
  "E: Package 'fonts-liberation' has no installation candidate",
]

/**
 * Run the heredoc script against stubbed `sudo`, `npx`, `apt-get`, `sleep` and
 * the lock tools, all first on PATH. `npx playwright install-deps` writes
 * `errors` to stderr and exits 1 (as apt's `E:` lines reach it, `stdio:
 * inherit`) unless `succeeds`. `indexes` maps a component to the release-pocket
 * Packages index files `apt-get indextargets` lists for it.
 * @param {{ errors?: string[], succeeds?: boolean, indexes?: Record<string, string[]> }} opts
 */
function runScript({
  errors = [],
  succeeds = false,
  indexes = { main: ['noble_main_Packages'], universe: ['noble_universe_Packages'] },
}) {
  const dir = mkdtempSync(join(tmpdir(), 'playwright-setup-action-'))
  try {
    const installs = join(dir, 'installs')
    writeFileSync(installs, '')
    const indexLines = []
    for (const [component, files] of Object.entries(indexes)) {
      indexLines.push(
        `if [ "$5" = ${JSON.stringify(`Component: ${component}`)} ]; then`,
        ...files.map((name) => `  echo ${JSON.stringify(join(dir, name))}`),
        '  exit 0',
        'fi',
      )
    }
    const stub = (name, body) => {
      const path = join(dir, name)
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub('sudo', 'exec "$@"')
    stub(
      'npx',
      [
        `echo "$@" >> ${JSON.stringify(installs)}`,
        'echo "Installing dependencies..."',
        ...(succeeds
          ? ['exit 0']
          : [...errors.map((line) => `echo ${JSON.stringify(line)} >&2`), 'exit 1']),
      ].join('\n'),
    )
    stub(
      'apt-get',
      ['if [ "$1" = indextargets ]; then', ...indexLines.map((l) => `  ${l}`), 'fi', 'exit 0'].join(
        '\n',
      ),
    )
    stub('sleep', 'exit 0')
    stub('pkill', 'exit 1')
    stub('fuser', 'exit 1')
    stub('dpkg', 'exit 0')

    const script = join(dir, 'run.sh')
    writeFileSync(script, actionScript())
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        APT_CACHE_HIT: '',
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      },
    })
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      installs: readFileSync(installs, 'utf8').split('\n').filter(Boolean).length,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const error of MISSING_PACKAGE_ERRORS) {
  void test(`"${error}" with no universe index is infra, exit 75`, () => {
    const run = runScript({
      errors: [error],
      indexes: { main: ['noble_main_Packages'] },
    })
    assert.equal(run.status, 75, run.stdout + run.stderr)
    assert.match(run.stdout, /AGARIC_APT_INFRA/)
    assert.match(run.stdout, /universe: none/)
    assert.equal(run.installs, 2)
  })
}

void test('packages that cannot resolve against a full set of indexes fail with the plain exit 1', () => {
  const run = runScript({ errors: MISSING_PACKAGE_ERRORS })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.doesNotMatch(run.stdout, /AGARIC_APT_INFRA/)
  assert.match(run.stdout, /playwright install-deps failed after 2 attempts \(exit 1\)/)
  assert.match(run.stdout, /main: .*noble_main_Packages/)
})

void test('a failure that is not about resolving packages stays an ordinary failure, even with no index', () => {
  const run = runScript({
    errors: ['E: Sub-process /usr/bin/dpkg returned an error code (1)'],
    indexes: {},
  })
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.doesNotMatch(run.stdout, /AGARIC_APT_INFRA/)
})

void test('install-deps that succeeds exits 0 after one attempt', () => {
  const run = runScript({ succeeds: true })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(run.installs, 1)
})
