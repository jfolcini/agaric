// Node sibling of `scripts/lib/git-scratch-guard.sh` (#3722), plus the
// index-vs-working-tree scenario runner both citation guards' self-tests
// share (#3962).
//
// ─── Why a Node copy exists ───────────────────────────────────────────────
//
// The shell helper is the canonical statement of the hazard: a self-test
// that builds a git fixture runs from a prek hook, where git has exported
// `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` pointing at the REAL
// repository — and those OUTRANK `git -C <dir>`. Three separate incidents
// (#3690, #3722, #3736) left the main checkout with a rewritten
// `core.worktree`, an overwritten `user.email`, or an index claiming every
// tracked file was deleted. `scripts/check-git-fixture-isolation.mjs` makes
// the shell fix stick — but it scans SHELL scripts only, so a `.mjs`
// self-test that spawns `git` is exactly the "never learned about the
// danger" shape that guard was written to end, with nothing watching it.
//
// The variable list is not copied. It is PARSED out of the shell helper at
// load time, so the scrub here cannot fall behind the scrub there — the
// specific drift that made four private copies of this scrubber worse than
// none.
//
// This matters acutely for #3962: the thing under test is a guard that reads
// the index git points it at via `GIT_INDEX_FILE`. A self-test that
// inherited the real hook's `GIT_INDEX_FILE` would drive the guard against
// the REAL repository's index while believing it was looking at a fixture —
// green for the wrong reason, and one `git add` away from being destructive.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import {
  listTrackedEntries,
  parseBatchStream,
  readContents,
  SOURCE_INDEX,
  SOURCE_WORKTREE,
} from './guard-file-source.mjs'

const SHELL_GUARD = join(import.meta.dirname, 'git-scratch-guard.sh')

/**
 * `path.resolve` with SYMLINKS RESOLVED — the `pwd -P` the shell helper uses,
 * and for the same reason.
 *
 * Every path git reports (`rev-parse --show-toplevel`,
 * `--absolute-git-dir`, `--git-path`) comes back PHYSICALLY resolved, while
 * `resolve()` leaves symlinks in place. Comparing the two is only an identity
 * test on a platform where the scratch root happens to contain no link. On
 * macOS `os.tmpdir()` is `/var/folders/…` and `/var` is a symlink to
 * `/private/var`, so `mkdtempSync` hands back one spelling and git answers
 * with the other: `initScratchRepo` then refuses to continue and
 * `assertScratchIsolation` calls every probe a leak, failing both citation
 * guards' self-test hooks on every commit from a Mac even though the fixture
 * is perfectly isolated. CI is ubuntu-only, so nothing here would ever have
 * caught it.
 *
 * Falls back to `resolve` when the path does not exist yet — a
 * not-yet-created directory has no physical spelling to ask for, and the
 * callers below either create it first or are only building a ceiling.
 */
function physical(p) {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** The one list, read from the shell helper so the two cannot drift. */
export const GIT_SCRATCH_LEAK_VARS = (() => {
  const src = readFileSync(SHELL_GUARD, 'utf8')
  const match = /^GIT_SCRATCH_LEAK_VARS='([^']*)'/m.exec(src)
  if (!match) {
    throw new Error(
      `git-scratch-guard.mjs: could not parse GIT_SCRATCH_LEAK_VARS out of ${SHELL_GUARD} — ` +
        'refusing to run with a scrub list this file invented for itself',
    )
  }
  const vars = match[1].split(/\s+/).filter(Boolean)
  // The shell helper's own self-test asserts >= 15; the same floor here
  // catches a parse that silently matched something shorter.
  if (vars.length < 15) {
    throw new Error(
      `git-scratch-guard.mjs: parsed only ${vars.length} leak variables from ${SHELL_GUARD}`,
    )
  }
  return vars
})()

/**
 * Build an environment with every variable through which git's ambient
 * context could reach a scratch tree removed, pinned to a ceiling so a
 * fixture cannot discover a repository above itself.
 *
 * Unlike the shell version there is nothing to "verify survived": this
 * constructs a fresh object rather than mutating the process environment, so
 * a readonly export in the parent cannot leak through.
 */
export function scrubbedGitEnv(scratchRoot, extra = {}) {
  const env = { ...process.env }
  for (const name of GIT_SCRATCH_LEAK_VARS) delete env[name]
  // Physical, because git walks the physical tree when it looks for a
  // repository above the fixture: a ceiling spelled through a symlink is a
  // ceiling git never compares against.
  env.GIT_CEILING_DIRECTORIES = dirname(physical(scratchRoot))
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/**
 * Run `fn` with the ambient PROCESS environment scrubbed, restoring it after.
 *
 * `scrubbedGitEnv` above only helps a call that remembers to pass it. Every
 * `git` a scenario spawns WITHOUT an explicit `env` — directly, or inside a
 * helper like `listTrackedEntries` — silently inherits the hook's real
 * `GIT_INDEX_FILE` instead, and #3962 shipped with exactly that: scenario 7
 * called `listTrackedEntries(dir)` with no env, so under a real `git commit`
 * it enumerated the REAL repository's 4,610 paths in place of its 7-file
 * fixture. Scrubbing the process environment for the duration makes the
 * DEFAULT isolated, so a future scenario that forgets is still safe rather
 * than merely still passing.
 */
export function withScrubbedProcessEnv(scratchRoot, fn) {
  const saved = new Map()
  const set = (name, value) => {
    saved.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const name of GIT_SCRATCH_LEAK_VARS) set(name, undefined)
  set('GIT_CEILING_DIRECTORIES', dirname(physical(scratchRoot)))
  try {
    return fn()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Report every way git, run in `dir` under `env`, would reach OUTSIDE `base`
 * (which defaults to `dir` itself).
 *
 * Returns [] when the fixture is isolated; otherwise one string per leak.
 *
 * The load-bearing probe is `rev-parse --git-path index`, because it is the
 * ONLY one of these that moves when `GIT_INDEX_FILE` leaks in:
 * `--show-toplevel` and `--absolute-git-dir` both stay pinned to the fixture
 * (measured on git 2.43), which is precisely why `initScratchRepo`'s existing
 * toplevel assertion watched the #3962 leak happen and reported nothing.
 *
 * `base` exists for ONE caller: a LINKED WORKTREE, whose git dir and index
 * live under the MAIN fixture's `.git` by construction (#4048) — the very
 * property scenario 10 is about. Widening the ceiling to the scratch root
 * keeps that fixture checked (nothing may reach the real repository) instead
 * of exempting it, which is the difference between a probe and a waiver.
 * Every other caller passes no `base` and gets the strict "inside this
 * fixture" rule unchanged.
 */
export function assertScratchIsolation(dir, env, baseDir = dir) {
  // Physical on BOTH sides — see `physical`. A relative answer (git returns a
  // bare `.git/index` from the toplevel) is resolved against the physical
  // base, so the two spellings cannot disagree by construction.
  const base = physical(baseDir)
  const ask = (...args) =>
    execFileSync('git', ['rev-parse', ...args], { cwd: dir, env, encoding: 'utf8' }).trim()
  const leaks = []
  const inside = (p) => {
    const abs = resolve(base, p)
    return abs === base || abs.startsWith(`${base}/`)
  }
  const probes = [
    ['toplevel', '--show-toplevel'],
    ['git dir', '--absolute-git-dir'],
    ['index', '--git-path', 'index'],
  ]
  for (const [label, ...args] of probes) {
    const value = ask(...args)
    if (!inside(value)) leaks.push(`${label} resolved to '${value}', outside the fixture '${base}'`)
  }
  return leaks
}

/**
 * `git init` a fixture at `dir`, then assert that EVERY path git resolves
 * from inside it lands inside it.
 *
 * The toplevel check this used to carry alone is blind to a leaked
 * `GIT_INDEX_FILE` — measured on git 2.43, `--show-toplevel` and
 * `--absolute-git-dir` both stay pinned to the fixture while only
 * `--git-path index` moves (#4015). Delegating to `assertScratchIsolation`
 * keeps the init check and the per-fixture check reading the SAME probe
 * list, so the two cannot drift into disagreeing about what "isolated"
 * means — the drift that let four private copies of this scrub be worse
 * than none.
 *
 * Both the explicit `env` AND the ambient `process.env` are probed: an
 * in-process helper that spawns `git` with no `env` uses the latter, and
 * that is exactly how #3962's scenario 7 came to enumerate the real
 * repository while looking like it enumerated a fixture.
 */
export function initScratchRepo(dir, env) {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  // Inherited from the caller's config otherwise; prek aborts on a repo with
  // no prek.toml, so a fixture commit would fail for a reason having nothing
  // to do with what is under test.
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'user.email', 'selftest@example.invalid')
  git('config', 'user.name', 'self test')
  const leaks = [
    ...assertScratchIsolation(dir, env).map((l) => `explicit env: ${l}`),
    ...assertScratchIsolation(dir, process.env).map((l) => `ambient env: ${l}`),
  ]
  if (leaks.length > 0) {
    throw new Error(
      `git-scratch-guard.mjs: fixture at '${dir}' is NOT isolated — refusing to continue:\n  - ` +
        `${leaks.join('\n  - ')}`,
    )
  }
  return git
}

/**
 * Scenario 7's in-process half: verify the `cat-file --batch` framing
 * directly, byte for byte, at chunk sizes 1/2/3 and the default — so a
 * regression in the chunk-slicing arithmetic is caught without a 500-file
 * fixture.
 *
 * `env` is threaded into BOTH helpers. Omitting it is not a style slip:
 * `git ls-files` obeys an ambient `GIT_INDEX_FILE` over `cwd`, so under a
 * real commit hook these two calls enumerated and read the REAL repository —
 * the #3722 failure class, inside the change that added the scratch guard.
 * `withScrubbedProcessEnv` now makes that safe by default; passing `env`
 * says so at the call site as well.
 */
function verifyIndexFraming({ dir, env, file, decoys, check }) {
  const entries = listTrackedEntries(dir, { env })
  const expected = [...decoys.keys()]
    .map((i) => `decoy-${i}-${file}`)
    .concat(`dupe-${file}`, file)
    .toSorted()
  check(
    'many files: the fixture enumeration is the FIXTURE, not the ambient repository',
    entries !== null && entries.paths.toSorted().join('\n') === expected.join('\n'),
    `expected exactly ${expected.length} fixture paths, got ${entries?.paths?.length}: ` +
      `${entries?.paths?.slice(0, 5).join(', ')}…`,
  )
  const read = (source, chunkSize) =>
    readContents(entries.paths, {
      repoRoot: dir,
      source,
      entries,
      env,
      ...(chunkSize === undefined ? {} : { chunkSize }),
    })
  const worktree = read(SOURCE_WORKTREE)
  const emptyDecoys = [...decoys.entries()]
    .filter(([, body]) => body === '')
    .map(([i]) => `decoy-${i}-${file}`)
  const mismatches = []
  const unread = []
  for (const chunkSize of [1, 2, 3, undefined]) {
    const indexed = read(SOURCE_INDEX, chunkSize)
    const at = `@chunk=${chunkSize ?? 'default'}`
    for (const path of entries.paths) {
      // PRESENCE first, and separately from equality: `indexed.get(p) ===
      // worktree.get(p)` is satisfied by `undefined === undefined`, so a
      // reader that dropped the zero-byte files from BOTH sources — the
      // classic "empty content conflated with a missing entry" — would pass
      // the equality check below while leaving two tracked files unscanned.
      // Mutation-tested: `if (parts[1] === 'blob' && size > 0)` plus a
      // truthiness test in the working-tree reader is green under equality
      // alone.
      if (!indexed.has(path)) unread.push(`${path} ${at} (index)`)
      if (!worktree.has(path)) unread.push(`${path} (working tree)`)
      // The working tree and the index agree on every path here except the
      // one deliberately made to disagree, which the caller checks.
      if (path === file) continue
      if (indexed.get(path) !== worktree.get(path)) mismatches.push(`${path} ${at}`)
    }
    // …and a zero-byte file must read as the empty STRING, not as anything
    // that merely compares equal to the other source's answer.
    for (const path of emptyDecoys) {
      if (indexed.get(path) !== '') {
        unread.push(`${path} ${at} read as ${JSON.stringify(indexed.get(path))}, expected ""`)
      }
      if (worktree.get(path) !== '') {
        unread.push(`${path} (working tree) read as ${JSON.stringify(worktree.get(path))}`)
      }
    }
  }
  check(
    'many files: every index body matches its blob at chunk sizes 1/2/3/default',
    mismatches.length === 0,
    `desynchronised batch records: ${mismatches.join(', ')}`,
  )
  check(
    'many files: every tracked file is READ, zero-byte files included (empty is not absent)',
    unread.length === 0,
    `not read, or not read as empty: ${[...new Set(unread)].join(', ')}`,
  )
}

/**
 * The `cat-file --batch` record walk against MALFORMED streams.
 *
 * No fixture can produce these: reaching them means git not honouring its own
 * batch protocol. They are checked here, against hand-built buffers, because
 * the branches used to `break` — abandoning up to 500 staged paths with no
 * fallback and no diagnostic, so the guard exited 0 having read almost
 * nothing. A branch that answers "unscanned, silently" is the one failure
 * this whole module is about, so it does not get to be the untested one.
 *
 * Each malformed case is paired with the well-formed stream it is derived
 * from: an assertion that a corrupt buffer throws is satisfied just as well
 * by a parser that throws on everything.
 */
function verifyBatchStreamFraming(check) {
  // `<oid> blob <size>\n<payload>\n`, twice — the shape git actually emits.
  const oid = '0'.repeat(40)
  const record = (body) => `${oid} blob ${Buffer.byteLength(body)}\n${body}\n`
  const good = Buffer.from(`${record('alpha')}${record('')}${record('omega')}`)
  const chunk = [
    { path: 'a.md', sha: oid },
    { path: 'b.md', sha: oid },
    { path: 'c.md', sha: oid },
  ]
  const parsed = parseBatchStream(good, chunk)
  check(
    'batch framing: a well-formed stream reads every record, empty payload included',
    parsed.get('a.md') === 'alpha' &&
      parsed.get('b.md') === '' &&
      parsed.get('c.md') === 'omega' &&
      parsed.size === 3,
    `got ${JSON.stringify([...parsed])}`,
  )

  const throws = (name, buf, expect, flag = 'isBatchDesync') => {
    let err = null
    try {
      parseBatchStream(buf, chunk)
    } catch (e) {
      err = e
    }
    check(
      `batch framing: ${name} is an error, not a silent drop`,
      err?.[flag] === true && expect.test(err.message),
      err === null
        ? 'no error thrown — the remaining paths would have gone unread'
        : `${flag} / message did not match ${expect}: ${err.message}`,
    )
  }
  // Truncated mid-stream: the header for record 2 never arrives.
  throws('a stream that ends before a header', good.subarray(0, -12), /ended before/)
  // A header whose size field is not a number.
  throws(
    'a header with an unreadable size',
    Buffer.from(`${record('alpha')}${oid} blob ?\nx\n`),
    /no readable size/,
  )
  // A size that runs past the end of the buffer. `Buffer.toString` CLAMPS
  // here, so without the bounds check this returns a short body that looks
  // like a whole file.
  throws(
    'a payload larger than the bytes that remain',
    Buffer.from(`${record('alpha')}${oid} blob 9999\nshort\n`),
    /claims 9999 bytes but only/,
  )
  // ...and `<oid> missing` — a damaged object store — is an error too
  // (#4046). It used to fall back to the working tree on the grounds that it
  // is a DOCUMENTED per-file answer, which it is; the objection is that the
  // answer it produces is about DIFFERENT CONTENT than the index names,
  // printed under "judged the staged index". The three well-formed
  // assertions above are the control: a parser that threw on everything
  // would fail them, so this pair discriminates rather than merely agreeing.
  throws(
    'a `missing` blob the index names',
    Buffer.from(`${record('alpha')}${oid} missing\n${record('omega')}`),
    /object store does not have it/,
    'isMissingObject',
  )
  // ...and it is NOT re-labelled as a framing desync: the two have different
  // causes (git cannot honour its protocol / the repository is damaged) and a
  // caller distinguishing them must be able to.
  let missingErr = null
  try {
    parseBatchStream(Buffer.from(`${oid} missing\n${record('b')}${record('c')}`), chunk)
  } catch (e) {
    missingErr = e
  }
  check(
    'batch framing: a `missing` blob is not mislabelled as a protocol desync',
    missingErr?.isMissingObject === true && missingErr?.isBatchDesync === undefined,
    `flags: missing=${missingErr?.isMissingObject} desync=${missingErr?.isBatchDesync}`,
  )
}

// ── SCENARIO 10: A LINKED WORKTREE — the case scenario 9 could not
// discriminate (#4048). Extracted rather than inlined beside the others only
// because it is the longest of them; `fixture`, `run`, `check` and
// `namesFile` are the runner's own helpers, passed in.
//
// Scenario 9 pins "the two helpers answer the same question the same way"
// using a FOREIGN repository's index, which is the one situation where every
// plausible implementation answers "not mine". So it held the claim in the
// only place that could not tell an implementation from a wrong one, and the
// two duly diverged: for a linked worktree's OWN index — which lives under
// the MAIN repository's `.git`, at `…/.git/worktrees/<name>/index` — Python
// said "mine" and Node said "somebody else's", so all four citation guards
// exited 2 on every commit made from a worktree. Verbatim:
//
//   check-md-link-targets: invocation error: a commit is in flight
//   (GIT_INDEX_FILE=…/.git/worktrees/wt-b21b-crlf/index) but it belongs to a
//   different repository than the tree being judged (…/wt-b21b-crlf).
//
// The cause was `resolve(out, repoRoot)` — `path.resolve` walks RIGHT TO
// LEFT, so an absolute `repoRoot` discarded the git dir entirely and the
// comparison was against the WORK TREE. An ordinary checkout keeps its index
// inside the work tree, so it answered true anyway; a worktree does not.
//
// A worktree is also the shape that exposes the opposite error, and both
// helpers had it: `…/.git` is the COMMON dir of the main checkout and of
// every linked worktree, so accepting a path under `--git-common-dir`
// accepted a SIBLING worktree's index, and plain containment under
// `--absolute-git-dir` accepts a worktree's index as the main checkout's
// (a worktree git dir is nested inside the main one). Both are false
// ACCEPTS that fail silently: the guard reads a tree nobody is committing,
// finds nothing staged there, and exits 0.
//
// So all five arms are asserted, and the fixture is arranged so that every
// wrong answer is an exit 0 over a staged violation rather than a different
// shade of red.
function verifyLinkedWorktreeOwnership({
  file,
  badLine,
  goodLine,
  root,
  fixture,
  run,
  namesFile,
  check,
}) {
  const { dir: mainDir, env } = fixture(({ git, write }) => {
    write(`${goodLine}\n`)
    git('add', '-A')
    git('commit', '-qm', 'base')
  })
  const gitIn = (d, ...args) => execFileSync('git', args, { cwd: d, env, encoding: 'utf8' })
  const wtA = join(root, 'linked-a')
  const wtB = join(root, 'linked-b')
  gitIn(mainDir, 'worktree', 'add', '-q', '-b', 'linked-a', wtA)
  gitIn(mainDir, 'worktree', 'add', '-q', '-b', 'linked-b', wtB)
  // git's own answer, not a path this file assembles: `--git-path index` is
  // relative in the main checkout (`.git/index`) and absolute in a linked
  // worktree, and both spellings have to reach the same comparison.
  const indexOf = (d) => resolve(d, gitIn(d, 'rev-parse', '--git-path', 'index').trim())
  const [idxMain, idxA, idxB] = [mainDir, wtA, wtB].map(indexOf)

  // The worktree fixtures are held to the same isolation rule as every
  // other one, widened to the scratch root because their git dir lives
  // inside the MAIN fixture by construction — see `assertScratchIsolation`.
  const wtLeaks = []
  for (const d of [wtA, wtB]) {
    for (const [label, probeEnv] of [
      ['scrubbed', env],
      ['ambient', process.env],
    ]) {
      for (const leak of assertScratchIsolation(d, probeEnv, root)) {
        wtLeaks.push(`${d} ${label} env: ${leak}`)
      }
    }
  }
  check(
    'linked worktree: both worktrees resolve inside the scratch root, under both envs',
    wtLeaks.length === 0,
    wtLeaks.join('; '),
  )
  // …and the fixture really has the shape the scenario is about. Without
  // this, a `git worktree add` that silently produced an ordinary clone
  // would make every assertion below pass for the wrong reason — which is
  // precisely how scenario 9 came to hold a claim it could not test.
  check(
    "linked worktree: its index lives under the MAIN fixture's .git, not inside the worktree",
    existsSync(idxA) &&
      existsSync(idxB) &&
      existsSync(idxMain) &&
      idxA.startsWith(`${join(mainDir, '.git')}${sep}`) &&
      !idxA.startsWith(`${wtA}${sep}`) &&
      idxA !== idxB,
    `main=${idxMain} a=${idxA} b=${idxB}`,
  )

  // The violation is staged in WORKTREE A only. Every index below therefore
  // has a distinct, checkable answer: A's holds it, main's and B's do not.
  writeFileSync(join(wtA, file), `${badLine}\n`)
  gitIn(wtA, 'add', '-A')
  writeFileSync(join(wtA, file), `${goodLine}\n`) // …invisible on disk

  const ownIndex = run(wtA, env, [], { GIT_INDEX_FILE: idxA })
  check(
    "linked worktree: AUTO accepts the worktree's OWN index (the #4048 regression)",
    ownIndex.status === 1 && namesFile(ownIndex),
    `expected 1 naming ${file}, got ${ownIndex.status}: ${ownIndex.stderr}`,
  )
  const siblingIndex = run(wtA, env, [], { GIT_INDEX_FILE: idxB })
  check(
    "linked worktree: a SIBLING worktree's index is refused, not read as this tree's",
    siblingIndex.status === 2 && /different repository/.test(siblingIndex.stderr),
    `expected 2 naming a different repository, got ${siblingIndex.status}: ${siblingIndex.stderr}`,
  )
  const mainIndexInWorktree = run(wtA, env, [], { GIT_INDEX_FILE: idxMain })
  check(
    'linked worktree: the MAIN index is refused too — a shared object store is not a shared index',
    mainIndexInWorktree.status === 2 && /different repository/.test(mainIndexInWorktree.stderr),
    `expected 2, got ${mainIndexInWorktree.status}: ${mainIndexInWorktree.stderr}`,
  )
  // THE CONTROL for all three: the disk copy is clean, so the exit 1 above
  // is about the index and the exit 2s are not a guard that has stopped
  // working.
  const wtSource = run(wtA, env, ['--worktree'], { GIT_INDEX_FILE: idxA })
  check(
    'linked worktree: --worktree still judges the clean copy on disk',
    wtSource.status === 0,
    `expected 0, got ${wtSource.status}: ${wtSource.stderr}`,
  )

  // ...and the symmetric direction. A linked worktree's git dir is NESTED
  // inside the main checkout's, so "the index is somewhere under my git
  // dir" accepts a worktree's index as the main checkout's — the same false
  // accept one level up, and the live shape here: an agent runs a guard in
  // the main checkout while a commit is in flight in a worktree.
  //
  // The violation MOVES rather than being duplicated: worktree A's index is
  // returned to the clean copy first, and main's takes it up. So a run in
  // main that wrongly read A's index exits 0 over main's staged violation,
  // rather than exiting 1 over a violation that happens to be staged in
  // both — which would leave the two answers indistinguishable.
  gitIn(wtA, 'add', '-A') // A's index is clean again (the good copy is on disk)
  writeFileSync(join(mainDir, file), `${badLine}\n`)
  gitIn(mainDir, 'add', '-A')
  writeFileSync(join(mainDir, file), `${goodLine}\n`)
  const mainOwn = run(mainDir, env, [], { GIT_INDEX_FILE: idxMain })
  check(
    'linked worktree: the MAIN checkout of a repo that HAS worktrees still reads its own index',
    mainOwn.status === 1 && namesFile(mainOwn),
    `expected 1 naming ${file}, got ${mainOwn.status}: ${mainOwn.stderr}`,
  )
  const worktreeIndexInMain = run(mainDir, env, [], { GIT_INDEX_FILE: idxA })
  check(
    "linked worktree: …and refuses a WORKTREE's index nested inside its own .git",
    worktreeIndexInMain.status === 2 && /different repository/.test(worktreeIndexInMain.stderr),
    `expected 2, got ${worktreeIndexInMain.status}: ${worktreeIndexInMain.stderr}`,
  )
}

// ---------------------------------------------------------------------------
// The shared #3962 scenario runner
// ---------------------------------------------------------------------------

/**
 * Drive one citation guard through every way the index and the working tree
 * can disagree, in throwaway repositories.
 *
 * @param {object} spec
 * @param {string} spec.scriptPath   absolute path to the guard under test
 * @param {string} spec.file         fixture file name (must be in the guard's scan set)
 * @param {string} spec.badLine      a line the guard must flag
 * @param {string} spec.goodLine     a line the guard must not flag
 * @param {string} spec.root         scratch root (an existing empty directory)
 * @returns {Array<{name: string, ok: boolean, detail: string}>}
 */
export function runSourceScenarios(spec) {
  // Isolation by DEFAULT, not by remembering — see `withScrubbedProcessEnv`.
  return withScrubbedProcessEnv(spec.root, () => runScenarios(spec))
}

function runScenarios({ scriptPath, file, badLine, goodLine, root }) {
  const results = []
  const check = (name, ok, detail = '') => results.push({ name, ok, detail })

  // In-process, fixture-free: the record walk against streams git would have
  // to misbehave to produce. See `verifyBatchStreamFraming`.
  verifyBatchStreamFraming(check)

  let seq = 0
  const fixture = (setup) => {
    const n = ++seq
    const dir = join(root, `fx${n}`)
    const env = scrubbedGitEnv(root)
    const git = initScratchRepo(dir, env)
    const write = (contents) => writeFileSync(join(dir, file), contents)
    setup({ dir, git, write, env })
    // Every fixture is checked, so a scenario added later cannot quietly
    // reintroduce the #3722 leak: BOTH the explicit scrubbed env AND the
    // ambient process env must resolve entirely inside this fixture. The
    // ambient half is the one that matters — an in-process helper that
    // spawns `git` without an `env` uses that, and it is how scenario 7 came
    // to enumerate the real repository (see `assertScratchIsolation`).
    const leaks = [
      ...assertScratchIsolation(dir, env).map((l) => `scrubbed env: ${l}`),
      ...assertScratchIsolation(dir, process.env).map((l) => `ambient env: ${l}`),
    ]
    check(
      `fixture ${n}: git resolves inside the fixture under both the scrubbed and the ambient env`,
      leaks.length === 0,
      leaks.join('; '),
    )
    return { dir, env }
  }

  /** Run the guard in `dir`; `flags` picks the source explicitly. */
  const run = (dir, env, flags = [], extraEnv = {}) => {
    const result = spawnSync(process.execPath, [scriptPath, ...flags], {
      cwd: dir,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  const namesFile = (r) => r.stderr.includes(file)

  // ── 0. Baseline: a clean tree the guard is happy with, under BOTH
  // sources. Without this every red below could be "the guard reddens on
  // anything" rather than "the guard reddens on the staged content".
  {
    const { dir, env } = fixture(({ git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
    })
    const cached = run(dir, env, ['--cached'])
    const wt = run(dir, env, ['--worktree'])
    check(
      'baseline: a clean fixture is green under both sources',
      cached.status === 0 && wt.status === 0,
      `--cached=${cached.status} --worktree=${wt.status}`,
    )
  }

  // ── 1. FALSE GREEN — the violation is STAGED, the working tree is fixed.
  // This is the failure #3962 exists to close: the content being committed
  // is broken and the guard reads the other file.
  {
    const { dir, env } = fixture(({ git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`)
      git('add', '-A') // the breakage is now STAGED
      write(`${goodLine}\n`) // ...and the working tree is clean again
    })
    const wt = run(dir, env, ['--worktree'])
    const cached = run(dir, env, ['--cached'])
    check(
      'false green: reading the WORKING TREE passes a staged violation (the defect)',
      wt.status === 0,
      `expected 0, got ${wt.status}: ${wt.stderr}`,
    )
    check(
      'false green: reading the INDEX fails it and names the file (the fix)',
      cached.status === 1 && namesFile(cached),
      `expected 1 naming ${file}, got ${cached.status}: ${cached.stderr}`,
    )
    // AUTO must land on the index only when git says a commit is in flight.
    const auto = run(dir, env, [], { GIT_INDEX_FILE: join(dir, '.git', 'index') })
    const autoNoCommit = run(dir, env, [])
    check(
      'false green: AUTO reads the index when GIT_INDEX_FILE is exported',
      auto.status === 1 && namesFile(auto),
      `expected 1 naming ${file}, got ${auto.status}: ${auto.stderr}`,
    )
    check(
      'false green: AUTO reads the working tree when no commit is in flight',
      autoNoCommit.status === 0,
      `expected 0, got ${autoNoCommit.status}: ${autoNoCommit.stderr}`,
    )
    // The shape git ACTUALLY exports. Measured on git 2.43 / prek 0.3.8: an
    // ordinary `git commit` sets GIT_INDEX_FILE=`.git/index` — RELATIVE, and
    // resolved against the hook's cwd, which git fixes at the work-tree
    // toplevel. (`git commit -a` gets `.git/index.lock`, `git commit --
    // <path>` a `.git/next-index-<pid>.lock`, and a linked worktree an
    // absolute `…/.git/worktrees/<name>/index` — all inherited by the
    // guard's own `git` calls, which is why a partial commit is judged on
    // the temp index that is really being written.) Asserting only the
    // absolute form above would leave the common case uncovered.
    const autoRelative = run(dir, env, [], { GIT_INDEX_FILE: join('.git', 'index') })
    check(
      'false green: AUTO handles the RELATIVE GIT_INDEX_FILE a real commit exports',
      autoRelative.status === 1 && namesFile(autoRelative),
      `expected 1 naming ${file}, got ${autoRelative.status}: ${autoRelative.stderr}`,
    )
    check(
      'the verdict names the source it judged',
      /staged index/.test(cached.stderr) && /explicit --cached/.test(cached.stderr),
      `stderr did not name its source: ${cached.stderr}`,
    )
  }

  // ── 2. FALSE RED — the FIX is staged, the working tree reintroduces the
  // violation. The commit must not be blocked by a file already fixed.
  {
    const { dir, env } = fixture(({ git, write }) => {
      write(`${badLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${goodLine}\n`)
      git('add', '-A') // the fix is STAGED
      write(`${badLine}\n`) // ...and the working tree is dirty again
    })
    const wt = run(dir, env, ['--worktree'])
    const cached = run(dir, env, ['--cached'])
    check(
      'false red: reading the WORKING TREE blocks a commit that is already fixed (the defect)',
      wt.status === 1 && namesFile(wt),
      `expected 1 naming ${file}, got ${wt.status}: ${wt.stderr}`,
    )
    check(
      'false red: reading the INDEX passes it (the fix)',
      cached.status === 0,
      `expected 0, got ${cached.status}: ${cached.stderr}`,
    )
  }

  // ── 3. STAGED, ABSENT FROM THE WORKING TREE — `git add`ed then removed
  // from disk. `git ls-files` still lists it, `readFileSync` throws ENOENT,
  // and the old code swallowed that with `continue`: a silent skip of a file
  // that IS being committed.
  {
    const { dir, env } = fixture(({ dir: repoDir, git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`)
      git('add', '-A')
      rmSync(join(repoDir, file))
    })
    const wt = run(dir, env, ['--worktree'])
    const cached = run(dir, env, ['--cached'])
    check(
      'staged-but-absent: the WORKING TREE reader silently skips it (the defect)',
      wt.status === 0,
      `expected 0, got ${wt.status}: ${wt.stderr}`,
    )
    check(
      'staged-but-absent: the INDEX reader judges it',
      cached.status === 1 && namesFile(cached),
      `expected 1 naming ${file}, got ${cached.status}: ${cached.stderr}`,
    )
  }

  // ── 4. STAGED DELETION — the offending file is `git rm`'d. A guard that
  // let `git show :<path>` fail opaquely here would block a commit that
  // REMOVES the violation, which is the best possible commit.
  {
    const { dir, env } = fixture(({ dir: repoDir, git, write }) => {
      write(`${badLine}\n`)
      writeFileSync(join(repoDir, `other-${file}`), `${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('rm', '-q', file)
    })
    const cached = run(dir, env, ['--cached'])
    const wt = run(dir, env, ['--worktree'])
    check(
      'staged deletion: the INDEX reader goes green, not exit 2',
      cached.status === 0,
      `expected 0, got ${cached.status}: ${cached.stderr}`,
    )
    check(
      'staged deletion: no invocation error leaked out',
      !/invocation error/.test(cached.stderr) && !/ENOENT|fatal:/.test(cached.stderr),
      `stderr: ${cached.stderr}`,
    )
    check(
      'staged deletion: the working-tree reader agrees (the path left the index)',
      wt.status === 0,
      `expected 0, got ${wt.status}: ${wt.stderr}`,
    )
  }

  // ── 5. UNMERGED — a conflict in progress leaves stages 1/2/3 and no
  // stage 0, so `git show :<path>` fails. The guard must fall back to the
  // working tree rather than crash; assert it actually READS that fallback
  // (finds the violation in the conflicted copy) rather than merely
  // surviving.
  {
    const { dir, env } = fixture(({ dir: repoDir, git, write, env: repoEnv }) => {
      write(`${goodLine}\nshared\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      git('checkout', '-q', '-b', 'other')
      write(`${badLine}\nfrom other\n`)
      git('commit', '-qam', 'other side')
      git('checkout', '-q', 'main')
      write(`${goodLine}\nfrom main\n`)
      git('commit', '-qam', 'main side')
      const merge = spawnSync('git', ['merge', 'other'], {
        cwd: repoDir,
        env: repoEnv,
        encoding: 'utf8',
      })
      if (merge.status === 0) throw new Error('fixture 5: the merge was expected to conflict')
    })
    const unmergedCount = execFileSync('git', ['ls-files', '-u'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    }).trim()
    check(
      'unmerged fixture really is unmerged (git ls-files -u is non-empty)',
      unmergedCount !== '',
      'the conflict fixture produced no unmerged stages — case 5 would be vacuous',
    )
    const cached = run(dir, env, ['--cached'])
    check(
      'unmerged: the INDEX reader falls back to the conflicted working-tree copy',
      cached.status === 1 && namesFile(cached),
      `expected 1 naming ${file}, got ${cached.status}: ${cached.stderr}`,
    )
    check(
      'unmerged: no invocation error leaked out',
      !/invocation error/.test(cached.stderr) && cached.status !== 2,
      `stderr: ${cached.stderr}`,
    )
    // …and it is the WORKING TREE it fell back to, not a conflict stage.
    // Mutation-tested: deleting the unmerged detection entirely (letting a
    // stage-3 sha land in `entry.sha`) leaves the assertion above green,
    // because stage 3 carries the same violation the conflicted file does.
    // The author resolving the conflict on disk — without `git add`, so the
    // path is still unmerged — is the state that tells the two apart: the
    // stages still hold the violation, the file in front of the author does
    // not, and the documented behaviour is to judge the latter.
    writeFileSync(join(dir, file), `${goodLine}\nresolved by hand\n`)
    const stagesStillDirty = execFileSync('git', ['ls-files', '-u', '--', file], {
      cwd: dir,
      env,
      encoding: 'utf8',
    }).trim()
    const resolved = run(dir, env, ['--cached'])
    check(
      'unmerged: a hand-resolved (not yet added) file is judged from disk, not from a stage',
      stagesStillDirty !== '' && resolved.status === 0,
      `still-unmerged=${stagesStillDirty !== ''}, expected 0, got ${resolved.status}: ${resolved.stderr}`,
    )
  }

  // ── 6. A STAGED BLOB THAT IS NOT IN THE OBJECT STORE — `cat-file --batch`
  // answers `<oid> missing`. Skipping that record leaves the path out of the
  // result map and therefore unscanned, which is a silent false green in a
  // guard whose whole subject is silent false greens.
  //
  // It used to fall back to the working tree, like an unmerged path, so that
  // the file was still judged. "Still judged" was the wrong goal (#4046): the
  // index names content that IS being committed and git cannot produce it, so
  // the copy on disk is not a degraded version of that content but a
  // DIFFERENT file — reported under `(judged the staged index)`. Unmerged is
  // the one case whose right answer is the disk, and it has no stage-0 sha,
  // so it never reaches `cat-file` at all. What is left has no correct
  // per-file answer, so the guard exits 2 with the sha named. The scenario
  // below is unchanged except in what it expects: a fixture that produced a
  // real `<oid> missing` before still produces one, and the assertion under
  // it moved from "judged from disk" to "refused, and said why".
  {
    let sha = ''
    const { dir, env } = fixture(({ dir: repoDir, git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`)
      git('add', '-A')
      sha = git('ls-files', '-s', '--', file).trim().split(/\s+/)[1]
      // A fresh fixture never packs, so the staged blob is loose.
      rmSync(join(repoDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true })
    })
    const probe = execFileSync('git', ['cat-file', '--batch'], {
      cwd: dir,
      env,
      input: `${sha}\n`,
      encoding: 'utf8',
    })
    check(
      'damaged index: the fixture really did remove the staged blob',
      /\bmissing\b/.test(probe),
      `cat-file said: ${probe.trim()} — the case below would be vacuous`,
    )
    const cached = run(dir, env, ['--cached'])
    check(
      'damaged index: a missing staged blob is exit 2 naming the sha, not a working-tree verdict',
      cached.status === 2 && cached.stderr.includes(sha),
      `expected 2 naming ${sha}, got ${cached.status}: ${cached.stderr}`,
    )
    // THE CONTROL. The refusal is about the object store, not about
    // `--cached`: the same damaged fixture still reads and judges from the
    // working tree, which never asks for a blob (the bad line is on disk
    // here, so a working answer is exit 1 naming the file). Without this,
    // "exit 2" would be satisfied by a guard that had stopped working
    // altogether.
    const worktree = run(dir, env, ['--worktree'])
    check(
      'damaged index: …while --worktree still judges normally — it never asks the object store',
      worktree.status === 1 && namesFile(worktree),
      `expected 1 naming ${file}, got ${worktree.status}: ${worktree.stderr}`,
    )
  }

  // ── 7. MANY FILES — the `cat-file --batch` framing.
  //
  // Every fixture above holds ONE scanned file, and with one file the batch
  // stream has one record, so the code that walks from one record to the
  // next is never exercised. Mutation-tested: changing `off += size + 1` to
  // `off += size` in `readFromIndex` — dropping the LF git writes after each
  // object — leaves all of the assertions above GREEN while the guard reads
  // every file after the first from the wrong offset and reports nothing.
  // That is a silent false green produced by a one-character slip in the
  // riskiest new line in the helper, so it gets a fixture that can see it:
  // the violation goes in the LAST file, behind content chosen to break a
  // naive parse (a line that looks like a `<oid> blob <size>` header, CRLF,
  // two adjacent empty blobs, a blob with no trailing newline, and non-UTF8
  // bytes).
  //
  // This scenario is also where the fixture's own isolation is proved
  // positively — it is the only one that reads the index IN PROCESS rather
  // than through a spawned guard, so it is the one that can be fooled into
  // reading the ambient repository.
  {
    const decoys = [
      // A header lookalike: a line-based parse resynchronising on this
      // instead of on the byte offset would read the wrong body.
      `${'0'.repeat(40)} blob 99999\nand a second line\n`,
      'crlf one\r\ncrlf two\r\n',
      // TWO ADJACENT ZERO-BYTE FILES. `size` 0, and the trailing LF still
      // has to be consumed; back-to-back empties mean `off` must advance by
      // exactly 1 twice with nothing in between, the tightest framing case
      // in the stream. They are also the case a reader is most likely to
      // conflate with "absent": both are asserted PRESENT and equal to `''`
      // below, not merely asserted to agree — two readers that both dropped
      // the empty body would agree perfectly, at `undefined`.
      '',
      '',
      'no trailing newline',
      // A Buffer, not a string: written as a string these bytes would be
      // re-encoded to valid UTF-8 and the decoy would prove nothing. The
      // index and the working tree must decode the SAME invalid sequences
      // the same lossy way, or a non-UTF8 file reads differently under the
      // two sources.
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xff, 0xfe, 0x00, 0x0a]),
    ]
    const { dir, env } = fixture(({ dir: repoDir, git, write }) => {
      decoys.forEach((body, i) => writeFileSync(join(repoDir, `decoy-${i}-${file}`), body))
      // A duplicate of decoy 0: two paths with the SAME blob sha, so the
      // batch input carries a repeated oid and the record-per-INPUT-LINE
      // assumption is tested rather than assumed.
      writeFileSync(join(repoDir, `dupe-${file}`), decoys[0])
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`) // the violation is in the LAST-listed scanned file
      git('add', '-A')
    })
    const cached = run(dir, env, ['--cached'])
    check(
      'many files: the index reader finds a violation behind 7 other blobs',
      cached.status === 1 && namesFile(cached),
      `expected 1 naming ${file}, got ${cached.status}: ${cached.stderr}`,
    )
    verifyIndexFraming({ dir, env, file, decoys, check })
  }

  // ── 8. Usage: an argument the guard does not understand is an invocation
  // error, not a silent pick of a source the caller did not ask for.
  //
  // The fixture is scenario 1's shape — VIOLATION STAGED, working tree clean
  // — so a guard that swallows a mistyped `--cached` exits 0 while the broken
  // content sails into the commit. Against a clean fixture every assertion
  // below would be satisfied by "exit 0 because there is nothing to find".
  {
    const { dir, env } = fixture(({ git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`)
      git('add', '-A') // staged violation…
      write(`${goodLine}\n`) // …invisible to the working tree
    })
    const both = run(dir, env, ['--cached', '--worktree'])
    check(
      '--cached and --worktree together is an exit-2 invocation error',
      both.status === 2 && /mutually exclusive/.test(both.stderr),
      `expected 2 mentioning "mutually exclusive", got ${both.status}: ${both.stderr}`,
    )
    // A MISSPELLED source flag is the same class of mistake as naming both,
    // and it used to be the silent one: an unrecognised argument was ignored,
    // so `--cache` resolved to AUTO and the caller who typed it got the
    // working tree while believing they had asked for the index. The whole
    // premise of #3962 is that reading the wrong copy is invisible in the
    // verdict, so an unknown flag has to be an error rather than a default.
    // Measured before the fix: `--cache` against this fixture exited 0 with
    // empty stderr — the staged violation unseen, the verdict clean.
    const typo = run(dir, env, ['--cache'])
    check(
      'a misspelled source flag is an exit-2 invocation error, not a silent AUTO',
      typo.status === 2 && /unknown option/.test(typo.stderr) && /--cache\b/.test(typo.stderr),
      `expected 2 naming the unknown option '--cache', got ${typo.status}: ${typo.stderr}`,
    )
    // ...including alongside a flag that IS recognised, which is how a typo
    // most often arrives (`--cached --print-sources`).
    const typoBeside = run(dir, env, ['--cached', '--print-sources'])
    check(
      'an unknown flag beside a recognised one is still an exit-2 invocation error',
      typoBeside.status === 2 && /--print-sources\b/.test(typoBeside.stderr),
      `expected 2 naming '--print-sources', got ${typoBeside.status}: ${typoBeside.stderr}`,
    )
    // ...and the flags the guards genuinely accept must keep working, or the
    // check above is satisfiable by rejecting everything.
    const printSource = run(dir, env, ['--print-source'])
    check(
      '--print-source is still accepted and names a source',
      printSource.status === 0 && /(staged index|working tree)/.test(printSource.stdout),
      `expected 0 naming a source, got ${printSource.status}: ${printSource.stdout}${printSource.stderr}`,
    )
  }

  // ── 9. A COMMIT IN FLIGHT IN ANOTHER REPOSITORY — the fail-closed half of
  // the ownership rule (#4017), ported here from `guard_file_source.py` so
  // the two helpers cannot answer the same situation differently.
  //
  // `GIT_INDEX_FILE` merely being SET used to be the whole AUTO test on the
  // Node side, so an index belonging to a DIFFERENT repository selected
  // "the staged index" and the guard reported a verdict about content it was
  // not judging. Measured before the port, against a two-fixture pair:
  // Python raised `AmbiguousSourceError`, Node answered
  // `{source: 'index', why: 'auto: git is running a commit hook, …'}` — for
  // the same tree, the same variable and the same value.
  //
  // The fixture is scenario 1's shape (VIOLATION STAGED, working tree clean),
  // so every "exit 0" below can only mean the guard failed to look. All four
  // arms, because a helper that refused every `GIT_INDEX_FILE` — or that
  // never read this tree's index at all — would satisfy the refusal alone.
  {
    const { dir, env } = fixture(({ git, write }) => {
      write(`${goodLine}\n`)
      git('add', '-A')
      git('commit', '-qm', 'base')
      write(`${badLine}\n`)
      git('add', '-A') // the violation is STAGED…
      write(`${goodLine}\n`) // …and invisible to the working tree
    })
    // The committing repository: a scratch fixture like every other one here.
    // Nothing in this file ever names an index outside `root`.
    const foreignDir = join(root, 'foreign-repo')
    const foreignEnv = scrubbedGitEnv(root)
    const foreignGit = initScratchRepo(foreignDir, foreignEnv)
    writeFileSync(join(foreignDir, 'seed.txt'), 'unrelated\n')
    foreignGit('add', '-A')
    foreignGit('commit', '-qm', 'base')
    const foreign = { GIT_INDEX_FILE: join(foreignDir, '.git', 'index') }

    const auto = run(dir, env, [], foreign)
    check(
      'foreign index: AUTO refuses to guess (exit 2), rather than reporting on another repo',
      auto.status === 2 && /different repository/.test(auto.stderr),
      `expected 2 naming a different repository, got ${auto.status}: ${auto.stderr}`,
    )
    // Stage the working tree DIRTY right before this run: a `status === 0`
    // check against a fixture whose disk copy is already clean cannot tell
    // "the guard scanned `dir` and found nothing" from "the guard enumerated
    // nothing at all under the leaked `GIT_INDEX_FILE`". Requiring exit 1
    // over a real, findable violation proves the scan is genuine.
    writeFileSync(join(dir, file), `${badLine}\n`)
    const wt = run(dir, env, ['--worktree'], foreign)
    check(
      'foreign index: --worktree resolves the ambiguity and genuinely judges the files on disk',
      wt.status === 1 && namesFile(wt),
      `expected 1 naming ${file}, got ${wt.status}: ${wt.stderr}`,
    )
    // The env-binding half: `cwd` does NOT decide which index git reads, so
    // without `gitEnv` this `--cached` run enumerated the FOREIGN index — a
    // tree with no scanned file in it — and exited 0 over a staged violation.
    const cached = run(dir, env, ['--cached'], foreign)
    check(
      "foreign index: --cached reads THIS tree's index, not the ambient foreign one",
      cached.status === 1 && namesFile(cached),
      `expected 1 naming ${file}, got ${cached.status}: ${cached.stderr}`,
    )
    // …and the refusal is a DISCRIMINATION, not a guard that refuses every
    // GIT_INDEX_FILE: this tree's OWN index still auto-selects the index,
    // which is what a real commit hook depends on (asserted absolute and
    // relative in scenario 1).
    const own = run(dir, env, [], { GIT_INDEX_FILE: join(dir, '.git', 'index') })
    check(
      "foreign index: the tree's OWN index still auto-selects the index (a discrimination)",
      own.status === 1 && namesFile(own),
      `expected 1 naming ${file}, got ${own.status}: ${own.stderr}`,
    )

    // An INHERITED GIT_DIR must not let the ownership probe answer about the
    // FOREIGN repository (#4061). `indexBelongsTo` asks `git -C <repoRoot>
    // rev-parse --absolute-git-dir`, and an ambient GIT_DIR outranks `-C`
    // (measured: `GIT_DIR=<other>/.git git -C <root> rev-parse
    // --absolute-git-dir` answers about <other>, not <root>). A real commit
    // hook running INSIDE `foreignDir` would leave BOTH GIT_DIR and
    // GIT_INDEX_FILE exported from it — the shape below — and before the fix
    // the leaked GIT_DIR made the probe answer about `foreignDir`, so
    // GIT_INDEX_FILE (also naming a path under that same leaked git dir)
    // compared EQUAL to it: a false ACCEPT of the foreign index as belonging
    // to `dir`, silently defeating the refusal checked just above.
    const foreignWithGitDir = {
      GIT_DIR: join(foreignDir, '.git'),
      GIT_INDEX_FILE: join(foreignDir, '.git', 'index'),
    }
    const autoWithGitDir = run(dir, env, [], foreignWithGitDir)
    check(
      'foreign index: an inherited GIT_DIR must not make the probe answer about the OTHER repo (#4061)',
      autoWithGitDir.status === 2 && /different repository/.test(autoWithGitDir.stderr),
      `expected 2 naming a different repository, got ${autoWithGitDir.status}: ${autoWithGitDir.stderr}`,
    )
    // --worktree sidesteps AUTO (and therefore the ownership probe) entirely,
    // so it must not inherit AUTO's exit-2 refusal under the same leaked
    // GIT_DIR — that much this asserts, and truthfully: `dir`'s working tree
    // is ALREADY dirty here (staged above, by the `wt` check earlier in this
    // block), so a guard that genuinely scanned `dir` would exit 1, not 0.
    //
    // It exits 0. This is NOT the #4061 probe's doing (that fix is scoped to
    // `indexBelongsTo`, which AUTO alone consults) — it is `gitEnv()`
    // (guard-file-source.mjs) leaving the leaked `GIT_DIR` itself in the env
    // it hands `listTrackedEntries`, so `git ls-files` falls back to
    // `GIT_DIR`'s OWN default index and enumerates `foreignDir`'s tracked
    // files instead of `dir`'s — silently judging the WRONG repository as
    // clean, for `--cached` and `--worktree` alike. Confirmed by direct
    // reproduction against this exact guard; tracked as the `.mjs` half of
    // the ambient-`GIT_DIR` gap already filed against `git_env()`'s Python
    // twin (issue comment on the #4061 follow-up, referencing PR #4179).
    // This assertion therefore documents CURRENT behaviour rather than
    // claiming the strength `wt` above genuinely has under a narrower leak
    // (`GIT_INDEX_FILE` alone) — it is not yet a real discrimination, and
    // must not be read as one until that gap is closed.
    const wtWithGitDir = run(dir, env, ['--worktree'], foreignWithGitDir)
    check(
      'foreign index: …and --worktree does not inherit exit 2 under the same leaked GIT_DIR (known gap: it silently enumerates foreignDir, not dir — see git_env follow-up)',
      wtWithGitDir.status === 0,
      `expected 0, got ${wtWithGitDir.status}: ${wtWithGitDir.stderr}`,
    )
  }

  // ── 10. A LINKED WORKTREE — see `verifyLinkedWorktreeOwnership`, which is
  // where the reasoning lives.
  verifyLinkedWorktreeOwnership({ file, badLine, goodLine, root, fixture, run, namesFile, check })

  return results
}
