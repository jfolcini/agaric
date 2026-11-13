import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { initScratchRepo, scrubbedGitEnv } from './lib/git-scratch-guard.mjs'
import { nextFree } from './next-session-log.mjs'

const SCRIPT = join(import.meta.dirname, 'next-session-log.mjs')
const NUMBERING = join(import.meta.dirname, 'check-session-log-numbering.sh')
const LOG = 'docs/session-log'

// Every `test()` below is `void`-ed: node:test's returned promise fulfils even
// when the test fails, so there is nothing for a caller to await or catch.

void test('the next number is numeric, not lexicographic', () => {
  assert.equal(nextFree([`${LOG}/session-999-a.md`, `${LOG}/session-1000-b.md`]), 1001)
})

void test('a split log counts as its number, and other files do not count', () => {
  const paths = [`${LOG}/session-2569b-x.md`, `${LOG}/sessions-2601-2700.md`, `${LOG}/README.md`]
  assert.equal(nextFree(paths), 2570)
})

// `origin/main` holds logs 100 to 102. `gh` is a stub with one open PR, #7,
// whose files are `prLogs`, or that fails when `prLogs` is null.
function withRepo(prLogs, fn) {
  const root = mkdtempSync(join(tmpdir(), 'next-session-log-'))
  try {
    const dir = join(root, 'repo')
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const stub =
      prLogs === null
        ? '*) echo "gh: offline" >&2; exit 1 ;;'
        : `*"pulls?state=open"*) echo 7 ;; *"pulls/7/files"*) printf '%s\\n' ${prLogs.join(' ')} ;;`
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in ${stub} *) exit 3 ;; esac\n`)
    chmodSync(join(bin, 'gh'), 0o755)
    const env = scrubbedGitEnv(root, { PATH: `${bin}:${process.env.PATH}` })
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, LOG), { recursive: true })
    const write = (n, slug) =>
      writeFileSync(
        join(dir, LOG, `session-${n}-${slug}.md`),
        `# Session ${n} — ${slug}\n\nBody.\n`,
      )
    for (const n of [100, 101, 102]) write(n, `merged-${n}`)
    git('add', '-A')
    git('commit', '-qm', 'merged logs')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const run = (...args) => {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' })
      return { code: r.status, out: r.stdout.trim(), err: r.stderr }
    }
    const read = (rel) => readFileSync(join(dir, rel), 'utf8')
    return fn({ dir, git, write, run, read, env })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void test('a log only origin/main holds counts', () =>
  withRepo([], ({ git, write, run }) => {
    write(103, 'merged-later')
    git('add', '-A')
    git('commit', '-qm', 'merged after the branch was cut')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    git('reset', '-q', '--hard', 'HEAD~1')
    assert.deepEqual(run(), { code: 0, out: '104', err: '' })
  }))

void test('a log only this branch holds counts', () =>
  withRepo([], ({ git, write, run }) => {
    write(103, 'branch')
    git('add', '-A')
    git('commit', '-qm', 'branch log')
    assert.deepEqual(run(), { code: 0, out: '104', err: '' })
  }))

void test('a log only an open PR holds counts', () =>
  withRepo([`${LOG}/session-105-pr.md`, 'src/main.ts'], ({ run }) => {
    assert.deepEqual(run(), { code: 0, out: '106', err: '' })
  }))

void test('without gh it says so and counts the local refs', () =>
  withRepo(null, ({ run }) => {
    const r = run()
    assert.equal(r.code, 0)
    assert.equal(r.out, '103')
    assert.match(r.err, /open PRs not counted \(gh api failed: gh: offline\)/)
  }))

void test('--rename moves a stale log and its heading to the next number', () =>
  withRepo([`${LOG}/session-103-pr.md`], ({ dir, git, write, run, read, env }) => {
    write(101, 'mine')
    const r = run('--rename', `${LOG}/session-101-mine.md`)
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, `${LOG}/session-104-mine.md`)
    assert.equal(existsSync(join(dir, LOG, 'session-101-mine.md')), false)
    assert.equal(read(r.out), '# Session 104 — mine\n\nBody.\n')
    git('add', '-A')
    const guard = spawnSync('bash', [NUMBERING], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(guard.status, 0, `${guard.stdout}${guard.stderr}`)
  }))

void test('--rename does not count the log against its own number', () =>
  withRepo([], ({ git, write, run }) => {
    write(110, 'mine')
    git('add', '-A')
    git('commit', '-qm', 'branch log')
    assert.equal(run('--rename', `${LOG}/session-110-mine.md`).out, `${LOG}/session-103-mine.md`)
  }))

void test('--rename refuses a merged log', () =>
  withRepo([], ({ run, read }) => {
    const r = run('--rename', `${LOG}/session-100-merged-100.md`)
    assert.equal(r.code, 1)
    assert.match(r.err, /is on refs\/remotes\/origin\/main: a merged log is never renamed/)
    assert.equal(read(`${LOG}/session-100-merged-100.md`), '# Session 100 — merged-100\n\nBody.\n')
  }))
