import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  initScratchRepo,
  scrubbedGitEnv,
  withScrubbedProcessEnv,
} from './lib/git-scratch-guard.mjs'
import { resolveDiffBase } from './pr-diff-base.mjs'

const SCRIPT_PATH = join(import.meta.dirname, 'pr-diff-base.mjs')

/**
 * Reproduce #4544's fixture: a PR branch forked from `main`, `main` then
 * advanced with an UNRELATED file (standing in for somebody else's merge
 * landing after the PR opened), and finally a merge commit standing in for
 * GitHub's `refs/pull/N/merge` — main's CURRENT tip merged with the PR
 * branch's head, which is what `pull_request` actually checks out as HEAD.
 *
 * Returns everything a scenario needs:
 *   - `staleBaseSha`   what `github.event.pull_request.base.sha` would have
 *                      captured when the PR was opened, BEFORE main advanced
 *   - `advancedMainSha` main's CURRENT tip — what `origin/main` resolves to
 *   - `mergeRefSha`    the synthetic HEAD, standing in for refs/pull/N/merge
 */
function buildForkedFixture(root) {
  const dir = join(root, 'repo')
  const env = scrubbedGitEnv(root)
  const git = initScratchRepo(dir, env)

  writeFileSync(join(dir, 'README.md'), 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'initial commit on main')
  const staleBaseSha = git('rev-parse', 'HEAD').trim()

  git('checkout', '-qb', 'pr-branch')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'pr-file.txt'), 'from the PR branch\n')
  git('add', '-A')
  git('commit', '-qm', 'PR branch change')
  const prHeadSha = git('rev-parse', 'HEAD').trim()

  git('checkout', '-q', 'main')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'main-file.txt'), 'landed on main after the PR forked\n')
  git('add', '-A')
  git('commit', '-qm', "someone else's merge, landed on main after the fork")
  const advancedMainSha = git('rev-parse', 'HEAD').trim()

  // The stand-in for `refs/pull/N/merge`: GitHub regenerates this against
  // main's CURRENT tip every time it is fetched, merging the PR head into it.
  git('checkout', '-qb', 'pr-merge-ref', 'main')
  git('merge', '--no-ff', '-q', '-m', 'synthetic refs/pull/N/merge', 'pr-branch')
  const mergeRefSha = git('rev-parse', 'HEAD').trim()

  // Stand in for the checkout's remote-tracking ref: after the #4544 fix,
  // `resolveDiffBase` reads `origin/main`, never the workflow's captured
  // `base.sha`.
  git('update-ref', 'refs/remotes/origin/main', advancedMainSha)

  return { dir, env, staleBaseSha, advancedMainSha, prHeadSha, mergeRefSha }
}

/** The changed-file paths a three-dot diff reports, sorted for comparison. */
function changedFiles(dir, env, base, head) {
  const out = execFileSync('git', ['diff', '--numstat', `${base}...${head}`], {
    cwd: dir,
    env,
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t').at(-1))
    .toSorted()
}

test('#4544: the resolved base is main’s CURRENT tip, not the stale base.sha the triggering event captured', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const fx = buildForkedFixture(root)
      const resolved = resolveDiffBase({
        baseRef: 'main',
        cwd: fx.dir,
        head: fx.mergeRefSha,
        env: fx.env,
      })
      assert.equal(
        resolved,
        fx.advancedMainSha,
        `expected the CURRENT main tip (${fx.advancedMainSha}), got ${resolved} ` +
          `(the stale base.sha would have named ${fx.staleBaseSha})`,
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#4544: the diff from the resolved base names ONLY the PR branch’s own file, never the one main gained', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const fx = buildForkedFixture(root)
      const resolved = resolveDiffBase({
        baseRef: 'main',
        cwd: fx.dir,
        head: fx.mergeRefSha,
        env: fx.env,
      })
      const files = changedFiles(fx.dir, fx.env, resolved, fx.mergeRefSha)
      assert.deepEqual(files, ['src/pr-file.txt'])
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#4544 control: the OLD stale base.sha attributes main’s own file to the PR too (proves the fixture reproduces the report)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const fx = buildForkedFixture(root)
      const files = changedFiles(fx.dir, fx.env, fx.staleBaseSha, fx.mergeRefSha)
      assert.deepEqual(files, ['src/main-file.txt', 'src/pr-file.txt'])
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveDiffBase throws a clear error when baseRef is missing, rather than resolving nothing', () => {
  assert.throws(() => resolveDiffBase({ cwd: process.cwd() }), /baseRef is required/)
})

test('resolveDiffBase fails loudly — never an empty base — when the ref cannot be found or fetched', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-nofetch-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'lonely')
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      writeFileSync(join(dir, 'f.txt'), 'x\n')
      git('add', '-A')
      git('commit', '-qm', 'only commit, no origin remote configured')
      // Matching `/resolveDiffBase:/` would pass on ANY of this function's
      // five throw sites, so it would not pin the fetch-failure path this
      // test is named for. Assert on wording only that path produces.
      assert.throws(
        () => resolveDiffBase({ baseRef: 'main', cwd: dir, env }),
        /is not present locally and .* failed/,
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: prints the resolved base SHA to stdout and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-cli-ok-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const fx = buildForkedFixture(root)
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--base-ref', 'main'], {
        cwd: fx.dir,
        env: fx.env,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), fx.advancedMainSha)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: --cwd and --head are honoured, not silently defaulted (#4559 review note 1)', () => {
  // These two flags had NO caller and NO test: the suite reached `head` only
  // through the library API. So the `value()` guard added to stop `--cwd` as a
  // trailing argument from silently falling back to process.cwd() was itself
  // unexercised — a fix on a path nothing runs, in a PR about exactly that.
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-cli-flags-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const fx = buildForkedFixture(root)
      // --cwd must be USED: run from a directory that is not the fixture, so a
      // silent fallback to process.cwd() could not produce the fixture's base.
      const result = spawnSync(
        process.execPath,
        [SCRIPT_PATH, '--base-ref', 'main', '--cwd', fx.dir, '--head', fx.mergeRefSha],
        { cwd: root, env: fx.env, encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), fx.advancedMainSha)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: bad usage exits 2, an unresolvable base exits 1 (#4559 review note 2)', () => {
  // The 2-vs-1 split was asserted only by reading. Both paths emit `::error::`,
  // so the exit CODE is the only thing distinguishing "you called it wrong"
  // from "the repo could not answer".
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-cli-usage-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const env = scrubbedGitEnv(root)
      const run = (...args) =>
        spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: root, env, encoding: 'utf8' })

      const unknown = run('--bogus')
      assert.equal(unknown.status, 2, unknown.stderr)
      assert.match(unknown.stderr, /::error::unknown argument: --bogus/)

      const missingValue = run('--base-ref')
      assert.equal(missingValue.status, 2, missingValue.stderr)
      assert.match(missingValue.stderr, /::error::missing required value for --base-ref/)

      const missingFlag = run()
      assert.equal(missingFlag.status, 2, missingFlag.stderr)
      assert.match(missingFlag.stderr, /::error::missing required --base-ref/)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: a base that cannot be resolved fails loudly — non-zero exit with an ::error:: line', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-diff-base-cli-fail-'))
  try {
    withScrubbedProcessEnv(root, () => {
      const dir = join(root, 'lonely')
      const env = scrubbedGitEnv(root)
      const git = initScratchRepo(dir, env)
      writeFileSync(join(dir, 'f.txt'), 'x\n')
      git('add', '-A')
      git('commit', '-qm', 'only commit, no origin remote configured')
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--base-ref', 'main'], {
        cwd: dir,
        env,
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /::error::/)
      assert.equal(result.stdout.trim(), '')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
