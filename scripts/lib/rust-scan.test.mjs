import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { initScratchRepo, scrubbedGitEnv, withScrubbedProcessEnv } from './git-scratch-guard.mjs'
import { CRATE_ROOTS, openFileSource, stripRustComments } from './rust-scan.mjs'

// `check-raw-tx.mjs --self-test` covers the scanner. These cover what it
// cannot reach: which copy of a file is read, and the guard's own `main()`
// run end to end. A source that wrongly answers "absent" or reads the other
// copy passes the guard silently (#4017).

const FILE = 'src/a.rs'
const ON_DISK = 'on disk\n'

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

function withFixture(setup, fn) {
  const root = mkdtempSync(join(tmpdir(), 'rust-scan-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'repo')
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      mkdirSync(join(dir, 'src'))
      setup({ dir, git, write: (body) => writeFileSync(join(dir, FILE), body) })
      const open = (flag) => openFileSource([flag, FILE], env, { repoRoot: dir })
      fn({ cached: open('--cached'), worktree: open('--worktree') })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('stripRustComments blanks strings by default and keeps them with keepStrings', () => {
  assert.equal(stripRustComments('a "x" // y'), `a${' '.repeat(9)}`)
  assert.equal(stripRustComments('a "x" // y', { keepStrings: true }), `a "x"${' '.repeat(5)}`)
})

void test('a staged deletion still on disk is absent from the index only', () => {
  withFixture(
    ({ git, write }) => {
      write(ON_DISK)
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('rm', '-q', '--cached', FILE)
    },
    ({ cached, worktree }) => {
      assert.equal(cached.exists(FILE), false)
      assert.equal(cached.read(FILE), null)
      assert.equal(worktree.exists(FILE), true)
      assert.equal(worktree.read(FILE), ON_DISK)
    },
  )
})

void test('readMany caches each staged body under its own path', () => {
  const files = ['src/b.rs', 'src/c.rs', 'src/d.rs']
  withFixture(
    ({ dir, git }) => {
      for (const rel of files) writeFileSync(join(dir, rel), `staged ${rel}\n`)
      git('add', '-A')
      for (const rel of files) writeFileSync(join(dir, rel), ON_DISK)
    },
    ({ cached }) => {
      cached.readMany(files)
      assert.deepEqual(
        files.map((rel) => cached.read(rel)),
        files.map((rel) => `staged ${rel}\n`),
      )
    },
  )
})

void test('--cached outside a git repository fails closed instead of answering "absent"', () => {
  const root = mkdtempSync(join(tmpdir(), 'rust-scan-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const src = openFileSource(['--cached'], scrubbedGitEnv(root), { repoRoot: root })
      assert.throws(() => src.exists(FILE), /not a git repository/)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- check-raw-tx.mjs end to end --------------------------------------------

const SCRIPTS = join(import.meta.dirname, '..')
const GUARD_FILES = ['check-raw-tx.mjs', 'lib/rust-scan.mjs', 'lib/guard-file-source.mjs']
const RS = 'src-tauri/src/a.rs'
const VIOLATION = 'fn f(pool: &Pool) { let _ = pool.begin_with("BEGIN IMMEDIATE"); }\n'
const CLEAN = 'fn f() {}\n'

// The guard judges the tree that contains it, so each fixture gets its own
// copy of the guard and the crate roots it checks for.
function withGuardRepo(setup, fn) {
  const root = mkdtempSync(join(tmpdir(), 'raw-tx-'))
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
      const write = (body) => writeFileSync(join(dir, RS), body)
      setup({ dir, git, write })
      const run = (args, extraEnv = {}) =>
        spawnSync(process.execPath, ['scripts/check-raw-tx.mjs', ...args, RS], {
          cwd: dir,
          env: { ...env, ...extraEnv },
          encoding: 'utf8',
        })
      fn({ dir, run })
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('check-raw-tx: a raw begin_with( in production code exits 1 naming the site', () => {
  withGuardRepo(
    ({ write }) => write(VIOLATION),
    ({ run }) => {
      const r = run(['--worktree'])
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /src-tauri\/src\/a\.rs:1: /)
    },
  )
})

void test('check-raw-tx: the begin_immediate_logged definition line alone exits 0', () => {
  withGuardRepo(
    ({ write }) => write('pub async fn begin_immediate_logged(pool: &Pool) {}\n'),
    ({ run }) => {
      const r = run(['--worktree'])
      assert.equal(r.status, 0, r.stderr)
    },
  )
})

void test('check-raw-tx: a staged violation behind a clean working tree is judged by --cached only', () => {
  withGuardRepo(
    ({ git, write }) => {
      write(VIOLATION)
      git('add', '-A')
      write(CLEAN)
    },
    ({ run }) => {
      const cached = run(['--cached'])
      assert.equal(cached.status, 1, cached.stderr)
      assert.match(cached.stderr, /judged the staged index/)
      const worktree = run(['--worktree'])
      assert.equal(worktree.status, 0, worktree.stderr)
    },
  )
})

void test('check-raw-tx: a file staged then deleted from disk is still judged under --cached', () => {
  withGuardRepo(
    ({ dir, git, write }) => {
      write(VIOLATION)
      git('add', '-A')
      unlinkSync(join(dir, RS))
    },
    ({ run }) => {
      const r = run(['--cached'])
      assert.equal(r.status, 1, r.stderr)
      assert.match(r.stderr, /src-tauri\/src\/a\.rs:1: /)
    },
  )
})

void test('check-raw-tx: an unreadable GIT_INDEX_FILE exits 2 instead of reading nothing', () => {
  withGuardRepo(
    ({ dir, write }) => {
      write(VIOLATION)
      writeFileSync(join(dir, '.git', 'broken-index'), 'not an index\n')
    },
    ({ dir, run }) => {
      // Inside this repository's git dir, so it is taken as this tree's index.
      const index = join(realpathSync(dir), '.git', 'broken-index')
      const r = run([], { GIT_INDEX_FILE: index })
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, /check-raw-tx: invocation error: .*ls-files/)
    },
  )
})
