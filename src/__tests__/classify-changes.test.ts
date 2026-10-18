import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs helper.
import { initScratchRepo, scrubbedGitEnv } from '../../scripts/lib/git-scratch-guard.mjs'

// `scripts/classify-changes.sh` decides which CI lanes a PR skips, and
// `validate-all` trusts it to say when a skip is allowed: a wrong `false`
// lets a change merge with its suite never run.
const SCRIPT = join(__dirname, '../../scripts/classify-changes.sh')

function parse(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const eq = line.indexOf('=')
        return [line.slice(0, eq), line.slice(eq + 1)]
      }),
  )
}

function classify(paths: string[], cwd?: string): Record<string, string> {
  const res = spawnSync('bash', [SCRIPT, '--stdin'], {
    input: paths.join('\n'),
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
  })
  expect(res.status, res.stderr).toBe(0)
  return parse(res.stdout)
}

// A changed spec is listed only while it is on disk (a deleted spec cannot
// fail), so these run in a tree holding exactly `onDisk`.
function classifyWith(onDisk: string[], paths: string[]): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'classify-specs-'))
  try {
    for (const file of onDisk) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), '')
    }
    return classify(paths, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function classifyEvent(cwd: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const res = spawnSync('bash', [SCRIPT], { cwd, env, encoding: 'utf8' })
  expect(res.status, res.stderr).toBe(0)
  return parse(res.stdout)
}

const FULL_SET = {
  docs_only: 'false',
  docs: 'true',
  frontend: 'true',
  backend: 'true',
  ci: 'true',
  desktop: 'true',
  android: 'true',
  vitest: 'true',
  vitest_e2e_tauri: 'false',
  playwright: 'true',
  playwright_specs: '',
  real_backend: 'true',
  real_backend_specs: '',
  codeql_languages: '["actions","javascript-typescript","rust"]',
}

const DOCS_ONLY = {
  docs_only: 'true',
  docs: 'true',
  frontend: 'false',
  backend: 'false',
  ci: 'false',
  desktop: 'false',
  android: 'false',
  vitest: 'false',
  vitest_e2e_tauri: 'false',
  playwright: 'false',
  playwright_specs: '',
  real_backend: 'false',
  real_backend_specs: '',
  codeql_languages: '[]',
}

describe('classify-changes.sh', () => {
  it('a docs-only diff runs no suite and no CodeQL language', () => {
    expect(classify(['docs/session-log/session-1.md', 'README.md'])).toEqual(DOCS_ONLY)
  })

  it('a docs path sets only docs, wherever it lives', () => {
    expect(
      classify([
        'src-tauri/tests/AGENTS.md',
        'src-tauri/migrations/AGENTS.md',
        'src/stores/AGENTS.md',
        'e2e-tauri/AGENTS.md',
        '.claude/skills/batch-issues/SKILL.md',
      ]),
    ).toEqual(DOCS_ONLY)
  })

  it('a docs path next to a real change adds nothing to it', () => {
    const out = classify([
      'src-tauri/tests/AGENTS.md',
      'src/stores/AGENTS.md',
      '.claude/skills/batch-issues/SKILL.md',
      '.github/workflows/dco.yml',
    ])
    expect(out).toMatchObject({
      docs_only: 'false',
      docs: 'true',
      frontend: 'false',
      backend: 'false',
      ci: 'true',
      desktop: 'false',
      android: 'false',
      vitest: 'false',
      playwright: 'false',
      real_backend: 'false',
      codeql_languages: '["actions"]',
    })
  })

  it('real-backend specs alone run only those specs, and neither vitest nor Playwright', () => {
    const out = classifyWith(
      ['e2e-tauri/history.e2e.ts', 'e2e-tauri/smoke.e2e.ts'],
      ['docs/session-log/session-2.md', 'e2e-tauri/history.e2e.ts', 'e2e-tauri/smoke.e2e.ts'],
    )
    expect(out).toMatchObject({
      docs_only: 'false',
      frontend: 'true',
      vitest: 'false',
      vitest_e2e_tauri: 'false',
      playwright: 'false',
      real_backend: 'true',
      real_backend_specs: 'e2e-tauri/history.e2e.ts e2e-tauri/smoke.e2e.ts',
      codeql_languages: '["javascript-typescript"]',
    })
  })

  it('a deleted real-backend spec is not passed, and alone runs nothing', () => {
    const paths = ['e2e-tauri/gone.e2e.ts', 'e2e-tauri/smoke.e2e.ts']
    expect(classifyWith(['e2e-tauri/smoke.e2e.ts'], paths)).toMatchObject({
      real_backend: 'true',
      real_backend_specs: 'e2e-tauri/smoke.e2e.ts',
    })
    expect(classifyWith([], ['e2e-tauri/gone.e2e.ts'])).toMatchObject({
      vitest: 'false',
      playwright: 'false',
      real_backend: 'false',
      real_backend_specs: '',
    })
  })

  it('an e2e-tauri helper runs its vitest files alone and every real-backend spec', () => {
    const out = classifyWith(
      ['e2e-tauri/escape-property-line.e2e.ts'],
      ['e2e-tauri/escape-property-line.e2e.ts', 'e2e-tauri/helpers.ts'],
    )
    expect(out).toMatchObject({
      vitest: 'false',
      vitest_e2e_tauri: 'true',
      playwright: 'false',
      real_backend: 'true',
      real_backend_specs: '',
    })
  })

  it('an e2e-tauri vitest file runs those vitest files alone', () => {
    expect(classify(['e2e-tauri/helpers.test.ts'])).toMatchObject({
      vitest: 'false',
      vitest_e2e_tauri: 'true',
      playwright: 'false',
      real_backend: 'false',
    })
  })

  it('e2e-tauri plus any app path runs both browser suites whole', () => {
    const out = classifyWith(
      ['e2e-tauri/history.e2e.ts'],
      ['e2e-tauri/history.e2e.ts', 'e2e-tauri/helpers.test.ts', 'src/lib/date-utils.ts'],
    )
    expect(out).toMatchObject({
      vitest: 'true',
      vitest_e2e_tauri: 'false',
      playwright: 'true',
      playwright_specs: '',
      real_backend: 'true',
      real_backend_specs: '',
    })
  })

  it('a vitest test file runs the whole vitest suite and nothing else', () => {
    const out = classify([
      'src/lib/__tests__/date-utils.test.ts',
      'src/components/__tests__/BlockTree.test.tsx',
      'src/lib/search-query/parse.spec.ts',
      'docs/session-log/session-4.md',
    ])
    expect(out).toMatchObject({
      frontend: 'true',
      vitest: 'true',
      vitest_e2e_tauri: 'false',
      playwright: 'false',
      real_backend: 'false',
      desktop: 'false',
    })
  })

  it.each(['src/test-setup.ts', 'src/lib/tauri-mock/__tests__/conformance-coverage.test.ts'])(
    'shared test infrastructure %s runs every lane, whole',
    (path) => {
      expect(classify([path])).toMatchObject({
        vitest: 'true',
        playwright: 'true',
        playwright_specs: '',
        real_backend: 'true',
        real_backend_specs: '',
      })
    },
  )

  it.each(['vitest.config.ts', 'playwright.config.ts', 'wdio.conf.ts'])(
    'the test runner config %s runs vitest and Playwright whole',
    (path) => {
      expect(classify([path])).toMatchObject({
        vitest: 'true',
        playwright: 'true',
        playwright_specs: '',
      })
    },
  )

  it('Playwright specs alone run only those specs, and no vitest', () => {
    const specs = ['e2e/app-chrome.spec.ts', 'e2e/deep-link.spec.ts']
    expect(classifyWith(specs, [...specs, 'docs/x.md'])).toMatchObject({
      vitest: 'false',
      vitest_e2e_tauri: 'false',
      playwright: 'true',
      playwright_specs: 'e2e/app-chrome.spec.ts e2e/deep-link.spec.ts',
      real_backend: 'false',
    })
  })

  it('a deleted Playwright spec is not passed, and alone runs nothing', () => {
    const paths = ['e2e/gone.spec.ts', 'e2e/app-chrome.spec.ts']
    expect(classifyWith(['e2e/app-chrome.spec.ts'], paths)['playwright_specs']).toBe(
      'e2e/app-chrome.spec.ts',
    )
    expect(classifyWith([], ['e2e/gone.spec.ts'])).toMatchObject({
      vitest: 'false',
      playwright: 'false',
      playwright_specs: '',
    })
  })

  it('a Playwright spec named outside plain path characters runs every shard', () => {
    const spec = 'e2e/foo[1].spec.ts'
    expect(classifyWith([spec], [spec])).toMatchObject({ playwright: 'true', playwright_specs: '' })
  })

  it('a real-backend spec named outside plain path characters runs every spec', () => {
    const spec = 'e2e-tauri/foo bar.e2e.ts'
    expect(classifyWith([spec], [spec])).toMatchObject({
      real_backend: 'true',
      real_backend_specs: '',
    })
  })

  it('tauri.conf.json, which a Playwright spec reads, runs every shard', () => {
    expect(classify(['src-tauri/tauri.conf.json'])).toMatchObject({
      playwright: 'true',
      playwright_specs: '',
    })
  })

  it('a Playwright helper runs every shard, and still no vitest', () => {
    const out = classifyWith(
      ['e2e/app-chrome.spec.ts'],
      ['e2e/app-chrome.spec.ts', 'e2e/helpers.ts'],
    )
    expect(out).toMatchObject({ vitest: 'false', playwright: 'true', playwright_specs: '' })
  })

  it('a Playwright spec next to a vitest test file runs vitest whole and that spec', () => {
    const out = classifyWith(
      ['e2e/app-chrome.spec.ts'],
      ['e2e/app-chrome.spec.ts', 'src/lib/__tests__/date-utils.test.ts'],
    )
    expect(out).toMatchObject({
      vitest: 'true',
      playwright: 'true',
      playwright_specs: 'e2e/app-chrome.spec.ts',
    })
  })

  it('a Playwright spec next to an app path runs every shard', () => {
    const out = classifyWith(['e2e/app-chrome.spec.ts'], ['e2e/app-chrome.spec.ts', 'src/App.tsx'])
    expect(out).toMatchObject({ vitest: 'true', playwright: 'true', playwright_specs: '' })
  })

  it('more than twenty changed specs run every shard', () => {
    const specs = Array.from({ length: 21 }, (_, i) => `e2e/s${i}.spec.ts`)
    expect(classifyWith(specs, specs)).toMatchObject({ playwright: 'true', playwright_specs: '' })
    expect(classifyWith(specs.slice(1), specs.slice(1))['playwright_specs']).toBe(
      specs.slice(1).join(' '),
    )
  })

  it('an unclassifiable path next to specs runs every lane whole', () => {
    const out = classifyWith(
      ['e2e/app-chrome.spec.ts', 'e2e-tauri/smoke.e2e.ts'],
      ['e2e/app-chrome.spec.ts', 'e2e-tauri/smoke.e2e.ts', 'rust-toolchain.toml'],
    )
    expect(out).toMatchObject({
      vitest: 'true',
      vitest_e2e_tauri: 'false',
      playwright: 'true',
      playwright_specs: '',
      real_backend: 'true',
      real_backend_specs: '',
    })
  })

  it('Rust-test-only files skip both bundle builds and the real lane, not the Rust suites', () => {
    const out = classify([
      'docs/session-log/session-3.md',
      'src-tauri/src/mcp/tools_ro/tests.rs',
      'src-tauri/tests/commands/block_cmd_tests.rs',
      'src-tauri/agaric-engine/tests/reverse_tests.rs',
      'src-tauri/agaric-sync/src/dag_tests/mod.rs',
      'src-tauri/agaric-store/src/op_log/tests/append.rs',
      'src-tauri/agaric-sync/src/sync_files_tests.rs',
    ])
    expect(out).toMatchObject({
      backend: 'true',
      desktop: 'false',
      android: 'false',
      real_backend: 'false',
      vitest: 'false',
      vitest_e2e_tauri: 'false',
      playwright: 'false',
      codeql_languages: '["rust"]',
    })
  })

  it('an edit inside the test module of a production file is a production change', () => {
    // #5655's shape: `session_supervisor.rs` is classified by file, not hunk.
    const out = classify([
      'src-tauri/agaric-sync/src/sync_daemon/session_supervisor.rs',
      'src-tauri/src/mcp/tools_ro/tests.rs',
    ])
    expect(out).toMatchObject({ desktop: 'true', android: 'true', real_backend: 'true' })
  })

  it('src/commands/tests/ also builds under the test-util feature, so it is not test-only', () => {
    const out = classify(['src-tauri/src/commands/tests/common.rs'])
    expect(out).toMatchObject({ desktop: 'true', real_backend: 'true' })
  })

  it('an unclassifiable path runs the full set', () => {
    expect(classify(['rust-toolchain.toml'])).toMatchObject({
      frontend: 'true',
      backend: 'true',
      ci: 'true',
      vitest: 'true',
      playwright: 'true',
      real_backend: 'true',
      codeql_languages: '["actions","javascript-typescript","rust"]',
    })
  })

  it('a workflow edit analyzes Actions alone; the CodeQL config analyzes every language', () => {
    expect(classify(['.github/workflows/ci.yml'])['codeql_languages']).toBe('["actions"]')
    expect(classify(['.github/codeql/codeql-config.yml'])['codeql_languages']).toBe(
      '["actions","javascript-typescript","rust"]',
    )
  })

  it('a config no CodeQL language reads selects none, and index.html is JavaScript', () => {
    expect(classify(['prek.toml'])['codeql_languages']).toBe('[]')
    expect(classify(['index.html'])['codeql_languages']).toBe('["javascript-typescript"]')
  })

  it.each([
    'wdio.conf.ts',
    'index.html',
    'vite.config.ts',
    'tsconfig.app.json',
    'package.json',
    'package-lock.json',
    'public/sw.js',
    '.github/workflows/e2e-tauri-weekly.yml',
  ])('%s is built or run by the real lane', (path) => {
    expect(classify([path])['real_backend']).toBe('true')
  })

  it.each([
    'e2e/helpers.ts',
    'scripts/check-bundle-budget.mjs',
    '.github/actions/toolchain/action.yml',
    'vitest.config.ts',
    'prek.toml',
  ])('%s is not, though the lane can break on it', (path) => {
    expect(classify([path])['real_backend']).toBe('false')
  })

  it('an empty diff runs the full set', () => {
    expect(classify([])).toEqual(FULL_SET)
  })

  describe('from a git diff', () => {
    function withRepo(fn: (dir: string, env: NodeJS.ProcessEnv, base: string) => void) {
      const root = mkdtempSync(join(tmpdir(), 'classify-changes-'))
      try {
        const dir = join(root, 'repo')
        const env = scrubbedGitEnv(root)
        const git = initScratchRepo(dir, env)
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
        git('add', '-A')
        git('commit', '-qm', 'base')
        fn(dir, env, git('rev-parse', 'HEAD').trim())
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    it('an unreachable base runs the full set', () => {
      withRepo((dir, env) => {
        const out = classifyEvent(dir, {
          ...env,
          EVENT_NAME: 'pull_request',
          PR_BASE_SHA: 'f'.repeat(40),
          PR_HEAD_SHA: 'HEAD',
        })
        expect(out).toEqual(FULL_SET)
      })
    })

    it('a head the repo cannot resolve runs the full set', () => {
      withRepo((dir, env, base) => {
        const out = classifyEvent(dir, {
          ...env,
          EVENT_NAME: 'pull_request',
          PR_BASE_SHA: base,
          PR_HEAD_SHA: 'e'.repeat(40),
        })
        expect(out).toEqual(FULL_SET)
      })
    })

    it('a missing base (schedule, dispatch, a new branch) runs the full set', () => {
      withRepo((dir, env) => {
        expect(classifyEvent(dir, { ...env, EVENT_NAME: 'schedule' })).toEqual(FULL_SET)
      })
    })

    it('a rename out of src/ into docs/ is not docs-only', () => {
      withRepo((dir, env, base) => {
        const git = (...args: string[]) =>
          spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' }).stdout
        mkdirSync(join(dir, 'docs'), { recursive: true })
        git('mv', 'src/a.ts', 'docs/a.md')
        git('commit', '-qm', 'move')
        const out = classifyEvent(dir, {
          ...env,
          EVENT_NAME: 'pull_request',
          PR_BASE_SHA: base,
          PR_HEAD_SHA: 'HEAD',
        })
        expect(out).toMatchObject({ docs_only: 'false', frontend: 'true', vitest: 'true' })
      })
    })
  })
})
