import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { initScratchRepo, scrubbedGitEnv, withScrubbedProcessEnv } from './git-scratch-guard.mjs'
import { CRATE_ROOTS } from './rust-scan.mjs'

// `check-dynamic-sql.mjs --self-test` covers the scanner and the baseline
// arithmetic. These run the guard's `main()` end to end in a scratch repo:
// which copy it judges, its baseline and orphan sweep, and how it fails.

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

const SCRIPTS = join(import.meta.dirname, '..')
const GUARD_FILES = ['check-dynamic-sql.mjs', 'lib/rust-scan.mjs', 'lib/guard-file-source.mjs']
const RS = 'src-tauri/src/a.rs'
const BASELINE = 'src-tauri/dynamic-sql-baseline.txt'
const BAD = 'async fn f() {\n    let rows = sqlx::query("SELECT 1").fetch_all(&pool).await?;\n}\n'
const MARKED =
  'async fn f() {\n    // dynamic-sql: runtime-built\n' +
  '    let rows = sqlx::query("SELECT 1").fetch_all(&pool).await?;\n}\n'
const GOOD = 'async fn f() {\n    let rows = sqlx::query!("SELECT 1").fetch_all(&pool).await?;\n}\n'
const SITE = /src-tauri\/src\/a\.rs:2: let rows = sqlx::query\("SELECT 1"\)/

const baseline = (...entries) =>
  ['# Format: <count> <path-relative-to-repo-root>', ...entries, ''].join('\n')

// The guard judges the tree that contains it, so each fixture gets its own
// copy of the guard and the crate roots it checks for.
function withGuardRepo(setup, fn) {
  const root = mkdtempSync(join(tmpdir(), 'dynamic-sql-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'repo')
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      for (const file of GUARD_FILES) {
        mkdirSync(dirname(join(dir, 'scripts', file)), { recursive: true })
        copyFileSync(join(SCRIPTS, file), join(dir, 'scripts', file))
      }
      for (const crate of CRATE_ROOTS) mkdirSync(join(dir, crate), { recursive: true })
      const write = (rel, body) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), body)
      }
      const commit = () => {
        git('add', '-A')
        git('commit', '-qm', 'base')
      }
      setup({ dir, git, write, commit })
      const run = (args, extraEnv = {}) =>
        spawnSync(process.execPath, ['scripts/check-dynamic-sql.mjs', ...args], {
          cwd: dir,
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
        })
      fn({ dir, git, run, root })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Deletes the loose object behind `rel`'s staged blob; a fresh fixture never
// packs. Returns the sha.
function damageStagedBlob(dir, git, rel) {
  const sha = git('rev-parse', `:${rel}`).trim()
  rmSync(join(dir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)))
  return sha
}

void test('a runtime site above its baseline exits 1 naming the line', () => {
  withGuardRepo(
    ({ write }) => write(RS, BAD),
    ({ run }) => {
      const r = run(['--worktree', RS])
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, SITE)
    },
  )
})

void test('the same site carrying a // dynamic-sql: marker exits 0', () => {
  withGuardRepo(
    ({ write }) => write(RS, MARKED),
    ({ run }) => {
      const r = run(['--worktree', RS])
      assert.equal(r.status, 0, r.stderr)
    },
  )
})

void test('a staged violation behind a clean working tree is judged by the index only', () => {
  withGuardRepo(
    ({ write, git, commit }) => {
      write(RS, GOOD)
      commit()
      write(RS, BAD)
      git('add', '-A')
      write(RS, GOOD)
    },
    ({ run }) => {
      const cached = run(['--cached', RS])
      assert.equal(cached.status, 1, cached.stderr)
      assert.match(cached.stderr, /judged the staged index — explicit --cached/)
      assert.equal(run(['--worktree', RS]).status, 0)
      // AUTO: the relative index a real `git commit` exports, and none.
      assert.equal(run([RS], { GIT_INDEX_FILE: '.git/index' }).status, 1)
      assert.equal(run([RS]).status, 0)
    },
  )
})

void test('a staged fix behind a dirty working tree passes under --cached', () => {
  withGuardRepo(
    ({ write, git, commit }) => {
      write(RS, BAD)
      write(BASELINE, baseline('1 src-tauri/src/a.rs'))
      commit()
      write(RS, GOOD)
      write(BASELINE, baseline())
      git('add', '-A')
      write(RS, BAD)
    },
    ({ run }) => {
      assert.equal(run(['--cached', RS]).status, 0)
      assert.equal(run(['--worktree', RS]).status, 1)
    },
  )
})

void test('a staged re-anchor is the ceiling --cached judges against', () => {
  withGuardRepo(
    ({ write, git, commit }) => {
      write(RS, BAD)
      write(BASELINE, baseline('0 src-tauri/src/a.rs'))
      commit()
      write(BASELINE, baseline('1 src-tauri/src/a.rs'))
      git('add', '-A')
      write(BASELINE, baseline('0 src-tauri/src/a.rs'))
    },
    ({ run }) => {
      assert.equal(run(['--cached', RS]).status, 0)
      assert.equal(run(['--worktree', RS]).status, 1)
    },
  )
})

void test('a staged deletion of a baselined file is an orphan under --cached', () => {
  withGuardRepo(
    ({ write, git, commit }) => {
      write(RS, BAD)
      write(BASELINE, baseline('1 src-tauri/src/a.rs'))
      commit()
      git('rm', '-q', '--cached', RS)
    },
    ({ run }) => {
      const cached = run(['--cached', RS])
      assert.equal(cached.status, 1, cached.stderr)
      assert.match(cached.stderr, /src-tauri\/src\/a\.rs: no such file \(deleted or renamed\)/)
      assert.equal(run(['--worktree', RS]).status, 0)
    },
  )
})

void test('a staged deletion of the baseline leaves its sites unjustified under --cached', () => {
  withGuardRepo(
    ({ write, git, commit }) => {
      write(RS, BAD)
      write(BASELINE, baseline('1 src-tauri/src/a.rs'))
      commit()
      git('rm', '-q', '--cached', BASELINE)
    },
    ({ run }) => {
      const cached = run(['--cached', RS])
      assert.equal(cached.status, 1, cached.stderr)
      assert.match(cached.stderr, SITE)
      assert.equal(run(['--worktree', RS]).status, 0)
    },
  )
})

void test('a file staged then deleted from disk is still judged under --cached', () => {
  withGuardRepo(
    ({ dir, write, git }) => {
      write(RS, BAD)
      git('add', '-A')
      unlinkSync(join(dir, RS))
    },
    ({ run }) => {
      const r = run(['--cached', RS])
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, SITE)
    },
  )
})

void test('an unreadable index exits 2 instead of reading nothing', () => {
  withGuardRepo(
    ({ write, git }) => {
      write(RS, BAD)
      git('add', '-A')
    },
    ({ run }) => {
      // Under this repository's git dir, so it is taken as this tree's index.
      const r = run([RS], { GIT_INDEX_FILE: '.git/index/nope' })
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, /check-dynamic-sql: invocation error: .*ls-files/)
    },
  )
})

void test('a staged blob the object store cannot produce exits 2 naming its sha', () => {
  let sha = ''
  withGuardRepo(
    ({ dir, write, git }) => {
      write(RS, BAD)
      git('add', '-A')
      write(RS, GOOD)
      sha = damageStagedBlob(dir, git, RS)
    },
    ({ run }) => {
      const r = run(['--cached', RS])
      assert.equal(r.status, 2, r.stderr)
      assert.ok(r.stderr.includes(sha), r.stderr)
      assert.equal(run(['--worktree', RS]).status, 0)
    },
  )
})

void test('the orphan sweep reports every kind of uncovered entry', () => {
  withGuardRepo(
    ({ write, commit }) => {
      write(RS, GOOD)
      write('src-tauri/src/bin/tool.rs', BAD)
      write('src-tauri/src/oracle.rs', `#![cfg(test)]\n${BAD}`)
      write(
        BASELINE,
        baseline(
          '1 src-tauri/src/bin/tool.rs',
          '1 src-tauri/src/gone.rs',
          '1 src-tauri/src/oracle.rs',
        ),
      )
      commit()
    },
    ({ run }) => {
      const r = run(['--cached', RS])
      assert.equal(r.status, 1, r.stderr)
      const lines = r.stderr.split('\n').filter((line) => line.startsWith('  src-tauri/'))
      assert.deepEqual(lines, [
        '  src-tauri/src/bin/tool.rs: now a test/fixture path, outside the scan',
        '  src-tauri/src/gone.rs: no such file (deleted or renamed)',
        '  src-tauri/src/oracle.rs: now a whole-file `#![cfg(test)]` module',
      ])
    },
  )
})

void test('a baseline recording more sites than the tree exits 1 naming the drift', () => {
  withGuardRepo(
    ({ write }) => {
      write(RS, BAD)
      write(BASELINE, baseline(`2 ${RS}`))
    },
    ({ run }) => {
      const r = run(['--worktree', RS])
      assert.equal(r.status, 1, r.stderr)
      assert.ok(r.stderr.includes(`${RS}: baseline records 2 site(s), the tree has 1`), r.stderr)
    },
  )
})

void test('the orphan sweep reads only what it judges, so damage behind a skipped entry is exit 1', () => {
  withGuardRepo(
    ({ dir, write, git, commit }) => {
      write(RS, GOOD)
      // Distinct bodies: blobs are shared by content.
      write('src-tauri/src/bin/tool.rs', `// tool\n${GOOD}`)
      write('src-tauri/src/kept.rs', `// kept\n${GOOD}`)
      write(BASELINE, baseline('1 src-tauri/src/bin/tool.rs', '1 src-tauri/src/gone.rs'))
      commit()
      damageStagedBlob(dir, git, 'src-tauri/src/bin/tool.rs')
    },
    ({ run, dir, git }) => {
      const discarded = run(['--cached', RS])
      assert.equal(discarded.status, 1, discarded.stderr)
      assert.match(discarded.stderr, /src-tauri\/src\/gone\.rs: no such file/)
      // The control: the same damage behind an entry the sweep reads.
      writeFileSync(join(dir, BASELINE), baseline('1 src-tauri/src/kept.rs'))
      git('add', '-A')
      damageStagedBlob(dir, git, 'src-tauri/src/kept.rs')
      assert.equal(run(['--cached', RS]).status, 2)
    },
  )
})

void test('the orphan sweep reads the baseline in one cat-file call, not one per entry', () => {
  const entries = [1, 2, 3, 4, 5, 6].map((i) => `src-tauri/src/orphan_${i}.rs`)
  withGuardRepo(
    ({ write, commit }) => {
      write(RS, GOOD)
      for (const [i, rel] of entries.entries()) write(rel, `fn f_${i}() {}\n`)
      write(BASELINE, baseline(...entries.map((rel) => `1 ${rel}`)))
      commit()
    },
    ({ run, root }) => {
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
      const shimDir = join(root, 'shim')
      const log = join(root, 'git-calls')
      mkdirSync(shimDir)
      writeFileSync(log, '')
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\necho "$1" >> '${log}'\nexec '${realGit}' "$@"\n`,
      )
      chmodSync(join(shimDir, 'git'), 0o755)
      const r = run(['--cached', RS], { PATH: `${shimDir}:${process.env.PATH}` })
      // The entries are present and in scope, so only the sweep reads them.
      assert.equal(r.status, 0, r.stderr)
      const catFiles = readFileSync(log, 'utf8')
        .split('\n')
        .filter((call) => call === 'cat-file')
      // The target, the baseline file, and one batch for all six entries.
      assert.equal(catFiles.length, 3)
    },
  )
})

void test('--update-baseline --all re-anchors from the working tree, not the index', () => {
  const diskOnly = 'src-tauri/src/disk_only.rs'
  withGuardRepo(
    ({ dir, write, git, commit }) => {
      write(BASELINE, baseline())
      commit()
      write(RS, BAD)
      git('add', '-A')
      unlinkSync(join(dir, RS))
      write(diskOnly, BAD)
    },
    ({ run, dir }) => {
      const r = run(['--update-baseline', '--all'], { GIT_INDEX_FILE: '.git/index' })
      assert.equal(r.status, 0, r.stderr)
      const entries = readFileSync(join(dir, BASELINE), 'utf8')
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
      assert.deepEqual(entries, [`1 ${diskOnly}`])
    },
  )
})

void test('a scoped --update-baseline rewrites only the named entry', () => {
  const other = 'src-tauri/src/other.rs'
  withGuardRepo(
    ({ write, commit }) => {
      write(RS, BAD + BAD.replace('f()', 'g()'))
      write(other, BAD)
      write(BASELINE, baseline(`1 ${RS}`, `7 ${other}`))
      commit()
    },
    ({ run, dir }) => {
      const r = run(['--update-baseline', RS])
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /src-tauri\/src\/a\.rs: 1 -> 2/)
      const entries = readFileSync(join(dir, BASELINE), 'utf8')
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
      assert.deepEqual(entries, [`2 ${RS}`, `7 ${other}`])
    },
  )
})
