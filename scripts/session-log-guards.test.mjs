// The session-log guards' one allowed suffix: a merged duplicate number split
// by renaming `session-N-<slug>.md` to `session-N<letter>-<slug>.md`
// (docs/session-log/README.md). Each case drives the real shell guard against
// a staged scratch repo whose `origin/main` holds two logs numbered 101.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { analyze, sessionNumberOf } from './check-session-log-pr-collision.mjs'
import { initScratchRepo, scrubbedGitEnv } from './lib/git-scratch-guard.mjs'

const IMMUTABLE = join(import.meta.dirname, 'check-session-log-immutable.sh')
const NUMBERING = join(import.meta.dirname, 'check-session-log-numbering.sh')
const LOG = 'docs/session-log'

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'session-log-guards-'))
  try {
    const dir = join(root, 'repo')
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    mkdirSync(join(dir, LOG), { recursive: true })
    const write = (name, body) => writeFileSync(join(dir, LOG, name), body)
    // Bodies long enough that a one-line edit stays above git's rename
    // similarity threshold (a rename staged as D+A is rejected whatever its
    // content), and distinct per log, or git pairs the two renames crosswise.
    const body = (title) => `# Session ${title}\n\n${`A paragraph of ${title}.\n`.repeat(12)}`
    write('session-100-base.md', body('100 — base'))
    write('session-101-first.md', body('101 — first'))
    write('session-101-second.md', body('101 — second'))
    write('session-102-solo.md', body('102 — solo'))
    git('add', '-A')
    git('commit', '-qm', 'merged logs')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')

    /** Rename a log, rewriting its heading line by `heading` (null keeps it). */
    const rename = (from, to, heading) => {
      git('mv', `${LOG}/${from}`, `${LOG}/${to}`)
      if (heading !== null) {
        const path = join(dir, LOG, to)
        const [, ...rest] = readFileSync(path, 'utf8').split('\n')
        writeFileSync(path, [heading, ...rest].join('\n'))
        git('add', `${LOG}/${to}`)
      }
    }
    const run = (script) => {
      const r = spawnSync('bash', [script], { cwd: dir, env, encoding: 'utf8' })
      return { code: r.status, out: `${r.stdout}${r.stderr}` }
    }
    return fn({ dir, git, write, rename, run })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const splitBoth = ({ rename }) => {
  rename('session-101-first.md', 'session-101a-first.md', '# Session 101a — first')
  rename('session-101-second.md', 'session-101b-second.md', '# Session 101b — second')
}

void test('splitting a merged duplicate passes both guards', () =>
  withFixture((fx) => {
    splitBoth(fx)
    const immutable = fx.run(IMMUTABLE)
    assert.equal(immutable.code, 0, immutable.out)
    assert.match(immutable.out, /session-101-first\.md -> .*session-101a-first\.md splits/)
    const numbering = fx.run(NUMBERING)
    assert.equal(numbering.code, 0, numbering.out)
  }))

void test('a split that also changes the body fails the immutability guard', () =>
  withFixture((fx) => {
    splitBoth(fx)
    const path = join(fx.dir, LOG, 'session-101a-first.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('paragraph', 'edited paragraph'))
    fx.git('add', '-A')
    const r = fx.run(IMMUTABLE)
    assert.equal(r.code, 1, r.out)
    assert.match(
      r.out,
      /ERROR: .*session-101-first\.md -> .*session-101a-first\.md — already merged/,
    )
  }))

void test('a split whose heading keeps the bare number fails both guards', () =>
  withFixture((fx) => {
    fx.rename('session-101-first.md', 'session-101a-first.md', null)
    const immutable = fx.run(IMMUTABLE)
    assert.equal(immutable.code, 1, immutable.out)
    assert.match(immutable.out, /ERROR: .*session-101a-first\.md — already merged/)
    const numbering = fx.run(NUMBERING)
    assert.equal(numbering.code, 1, numbering.out)
    assert.match(numbering.out, /filename says session 101a, heading inside says 101\b/)
  }))

void test('a new log may not take a suffix', () =>
  withFixture((fx) => {
    fx.write('session-103a-new.md', '# Session 103a — new\n')
    fx.git('add', '-A')
    const r = fx.run(NUMBERING)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /session-103a-new\.md — a letter after the session number only splits/)
  }))

void test('suffixing a number only one log holds fails both guards', () =>
  withFixture((fx) => {
    fx.rename('session-102-solo.md', 'session-102a-solo.md', '# Session 102a — solo')
    const immutable = fx.run(IMMUTABLE)
    assert.equal(immutable.code, 1, immutable.out)
    assert.match(immutable.out, /ERROR: .*session-102a-solo\.md — already merged/)
    const numbering = fx.run(NUMBERING)
    assert.equal(numbering.code, 1, numbering.out)
    assert.match(numbering.out, /session-102a-solo\.md — a letter after the session number/)
  }))

void test('the PR-collision check reads a suffixed log as its number', () => {
  assert.equal(sessionNumberOf(`${LOG}/session-2569b-fe-loop-quick-wins.md`), 2569)
  const merged = [`${LOG}/session-101-first.md`, `${LOG}/session-101-second.md`]
  const split = analyze({
    prs: [
      {
        number: 7,
        changedFiles: 2,
        files: [
          { path: `${LOG}/session-101a-first.md`, previousPath: merged[0] },
          { path: `${LOG}/session-101b-second.md`, previousPath: merged[1] },
        ],
      },
    ],
    selfPr: 7,
    mergedPaths: merged,
  })
  assert.equal(split.verified, true)
  assert.deepEqual([split.collisions, split.staleClaims], [[], []])
  // After the split merges, a new log on that number is still a stale claim.
  const reuse = analyze({
    prs: [{ number: 8, changedFiles: 1, files: [`${LOG}/session-101-new.md`] }],
    selfPr: 8,
    mergedPaths: [`${LOG}/session-101a-first.md`, `${LOG}/session-101b-second.md`],
  })
  assert.deepEqual(
    reuse.staleClaims.map((s) => s.number),
    [101],
  )
})
