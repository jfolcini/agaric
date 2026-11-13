import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error — no type declarations for the .mjs helper.
import * as scratchGit from '../../scripts/lib/git-scratch-guard.mjs'

// `scripts/release.sh` writes the release's vault before it bumps (#6567).
// These run the real script in a scratch repository whose `origin` is a bare
// repository beside it, with the multi-minute steps (the vault build, the
// upgrade test, the bump) replaced by stubs that record their call.
const SCRIPTS = join(__dirname, '../../scripts')
const VAULTS = 'src-tauri/tests/fixtures/release-vault'
const UPGRADE_TEST =
  'cargo nextest run -p agaric --lib --no-tests=fail -E test(head_boots_the_vault_the_last_release_wrote_6567)'

const STUBS: Record<string, string> = {
  'scripts/require-npm.sh': '',
  'scripts/verify-release-build.sh': 'echo "verify-release-build" >>"$CALLS"',
  // As the real one: the new version's vault replaces the old one.
  'scripts/gen-release-vault.sh': `echo "gen-release-vault $*" >>"$CALLS"
[ -z "\${VAULT_FAILS:-}" ] || exit 1
rm -rf ${VAULTS}/1.0.0
mkdir -p "${VAULTS}/$1"
echo vault >"${VAULTS}/$1/notes.db.gz"`,
  'scripts/bump-version.sh': `[ "$1" != --check-identity ] || exit 0
echo "bump-version $*" >>"$CALLS"
git diff --cached --name-status >>"$CALLS"`,
  'bin/cargo': `echo "cargo $*" >>"$CALLS"
[ -z "\${TEST_FAILS:-}" ] || exit 1`,
  'bin/cargo-nextest': '',
  'bin/gh': '',
}

interface Run {
  status: number | null
  stderr: string
  calls: string[]
  tags: string
  porcelain: string
}

function release(
  extraEnv: Record<string, string>,
  setup?: (repo: string, git: (...args: string[]) => string) => void,
  script: [string, ...string[]] = ['scripts/release.sh', '1.0.1', '-y', '--skip-verify-build'],
): Run {
  const root = mkdtempSync(join(tmpdir(), 'release-vault-'))
  try {
    const repo = join(root, 'repo')
    const calls = join(root, 'calls')
    writeFileSync(calls, '')
    const env = scratchGit.scrubbedGitEnv(root, {
      // No signing setup of the machine's own reaches the identity gate.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      CALLS: calls,
      PATH: `${join(repo, 'bin')}${delimiter}${process.env['PATH'] ?? ''}`,
      ...extraEnv,
    })
    return scratchGit.withScrubbedProcessEnv(root, () => {
      const git = scratchGit.initScratchRepo(repo, env) as (...args: string[]) => string
      for (const [path, body] of Object.entries(STUBS)) {
        mkdirSync(join(repo, path, '..'), { recursive: true })
        writeFileSync(join(repo, path), `#!/usr/bin/env bash\n${body}\n`)
        chmodSync(join(repo, path), 0o755)
      }
      copyFileSync(join(SCRIPTS, 'release.sh'), join(repo, 'scripts/release.sh'))
      chmodSync(join(repo, 'scripts/release.sh'), 0o755)
      writeFileSync(join(repo, 'package.json'), '{"version":"1.0.0"}\n')
      mkdirSync(join(repo, VAULTS, '1.0.0'), { recursive: true })
      writeFileSync(join(repo, VAULTS, '1.0.0/notes.db.gz'), 'old vault\n')
      setup?.(repo, git)
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('init', '-q', '--bare', '-b', 'main', join(root, 'origin.git'))
      git('remote', 'add', 'origin', join(root, 'origin.git'))
      git('push', '-q', 'origin', 'main')
      const res = spawnSync('bash', script, { cwd: repo, env, encoding: 'utf8' })
      return {
        status: res.status,
        stderr: res.stderr,
        calls: spawnSync('cat', [calls], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean),
        tags: git('tag', '-l'),
        porcelain: git('status', '--porcelain'),
      }
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('scripts/release.sh writes the release vault before it bumps', () => {
  it('writes the vault from HEAD, runs the upgrade test over it, and hands it staged to the bump', () => {
    const run = release({})
    expect(run.status, run.stderr).toBe(0)
    expect(run.calls).toEqual([
      'gen-release-vault 1.0.1 HEAD',
      UPGRADE_TEST,
      'bump-version 1.0.1 --commit --tag --push',
      `D\t${VAULTS}/1.0.0/notes.db.gz`,
      `A\t${VAULTS}/1.0.1/notes.db.gz`,
    ])
  })

  it('stops before the bump when the vault cannot be written', () => {
    const run = release({ VAULT_FAILS: '1' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('could not write the release vault for 1.0.1')
    expect(run.stderr).toContain('Nothing was bumped, tagged or pushed.')
    expect(run.calls).toEqual(['gen-release-vault 1.0.1 HEAD'])
    expect(run.tags).toBe('')
  })

  it('stops before the bump when the upgrade test fails on the new vault', () => {
    const run = release({ TEST_FAILS: '1' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('the upgrade test fails on the vault 1.0.1 wrote')
    expect(run.stderr).toContain('Nothing was bumped, tagged or pushed.')
    expect(run.calls).toEqual(['gen-release-vault 1.0.1 HEAD', UPGRADE_TEST])
    expect(run.tags).toBe('')
  })
})

// The real `bump-version.sh`, as far as its identity gate, which a scratch
// repository with no signing key cannot pass: reaching that gate is having
// passed the dirty-tree check before it.
describe('scripts/bump-version.sh --commit over the vault release.sh staged', () => {
  function bump(dirty: string): Run {
    return release(
      {},
      (repo) => {
        copyFileSync(join(SCRIPTS, 'bump-version.sh'), join(repo, 'scripts/real-bump-version.sh'))
        // Dirties the tree after the base commit, as the vault step does.
        writeFileSync(
          join(repo, 'scripts/dirty-then-bump.sh'),
          `#!/usr/bin/env bash\nset -e\nmkdir -p "$(dirname ${dirty})"\necho new >${dirty}\ngit add -A\nexec bash scripts/real-bump-version.sh 1.0.1 --commit\n`,
        )
      },
      ['scripts/dirty-then-bump.sh'],
    )
  }

  it('accepts a staged vault', () => {
    const run = bump(`${VAULTS}/1.0.1/notes.db.gz`)
    expect(run.stderr).not.toContain('uncommitted changes')
    expect(run.stderr).toContain('refusing to cut a release with an identity that cannot verify')
    expect(run.porcelain).toBe(`A  ${VAULTS}/1.0.1/notes.db.gz\n`)
  })

  it('still refuses any other uncommitted change', () => {
    const run = bump('src/unrelated.ts')
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('working tree has uncommitted changes')
  })
})
