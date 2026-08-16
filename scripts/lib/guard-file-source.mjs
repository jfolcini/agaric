// #3962 — which COPY of a tracked file is a guard judging?
//
// A corpus-scanning guard has two different files to choose from for every
// path, and they disagree whenever the working tree is dirty relative to the
// index (during an agent-driven session, most of the time):
//
//   * the STAGED INDEX — what `git commit` is about to write;
//   * the WORKING TREE — what is on disk right now.
//
// Both citation guards enumerated paths with `git ls-files` (the index) and
// then read their bodies with `readFileSync` (the working tree). Mixing the
// two sources is how a pre-commit verdict comes to describe content that is
// not being committed, in both directions:
//
//   * FALSE GREEN — the violation is staged, the author then fixes it on
//     disk without `git add`. The guard reads the fixed copy, exits 0, and
//     the broken content is committed. This is the exact failure the guard
//     exists to prevent, and it fails silently.
//   * FALSE RED — the fix is staged and a later working-tree edit
//     reintroduces the violation. The commit is blocked over a file the
//     author already fixed.
//
// ─── How the source is chosen ─────────────────────────────────────────────
//
// Explicitly, via the flags below, following the convention already
// established by `scripts/test-related-ts.sh` / `test-related-rust.sh`:
// `--cached` (the index) versus an explicit alternative, named at the call
// site rather than sniffed.
//
//   --cached     read the staged index (`git cat-file` on the index blob)
//   --worktree   read the working tree (`readFileSync`)
//   neither      AUTO — see below
//
// AUTO exists because the two prek invocations that must behave differently
// share ONE `entry` line in prek.toml: the hooks are registered at
// `stages = ["pre-commit"]`, and `prek run --all-files` (CI, `push.sh`
// Phase A) runs that same stage with that same entry. A flag baked into the
// entry cannot separate them, so exactly one bit has to come from the
// runtime — and the issue is right that picking the WRONG bit is how this
// gets subtly wrong again. Measured, in a throwaway repo, on prek 0.3.8:
//
//   real `git commit`      PRE_COMMIT=1   GIT_INDEX_FILE=.git/index
//   prek run --all-files   PRE_COMMIT=1   (no GIT_INDEX_FILE)
//   prek run               PRE_COMMIT=1   (no GIT_INDEX_FILE)
//
// So `PRE_COMMIT` — the variable one would reach for first — is set in all
// three modes and cannot discriminate. `GIT_INDEX_FILE` is not a correlate
// of "probably a commit": it is git NAMING THE INDEX IT IS ABOUT TO COMMIT,
// exported per githooks(5) to a hook it is running. Reading that index is
// therefore reading the object git just pointed at, not a guess about
// intent. When it is absent there is no commit in flight, nothing is "about
// to be committed", and the tree in front of the caller is the subject —
// which is what a manual run and CI's `--all-files` both want.
//
// Whichever way it resolves, the guard PRINTS the source it used with any
// non-clean verdict, so a surprising red is one line away from explaining
// itself. `--print-source` reports it without scanning.
//
// ─── Deletions and absent files ───────────────────────────────────────────
//
// Enumeration was ALREADY index-based (`git ls-files` reads the index), so
// the two cases that look like they need special handling mostly resolve
// themselves — but they resolve DIFFERENTLY, and the difference is the
// reason this helper enumerates with `ls-files -s` rather than plain
// `ls-files`:
//
//   * STAGED DELETION — a `git rm`'d path is gone from the index, so
//     `ls-files` never lists it and no source ever tries to read it. There
//     is nothing to crash on. (Note this is the OPPOSITE of prek's own
//     changed-file set, which also omits deletions but by dropping them
//     from a list the guard would otherwise have had to read. This helper
//     does not depend on prek's file list at all — it depends on the index,
//     which is why `pass_filenames = false` on both hooks is load-bearing.)
//   * STAGED, ABSENT FROM THE WORKING TREE — `git add`ed and then deleted
//     from disk, or added inside a directory the author has since moved.
//     `ls-files` lists it and `readFileSync` throws ENOENT, which the old
//     code swallowed with `continue` — a silent skip of a file that IS
//     being committed, i.e. another false green. Under `--cached` it is
//     read from the index and judged.
//   * UNMERGED (a conflict in progress) — the path has stages 1/2/3 and no
//     stage 0, so `git show :<path>` fails with "path ... is unmerged".
//     Rather than let that surface as an opaque crash that blocks a
//     legitimate commit, such a path falls back to the working tree, which
//     is where the conflict markers the author is resolving actually live.
//     git refuses to commit with unmerged paths anyway, so this verdict is
//     advisory either way.
//   * GITLINK (mode 160000, a submodule) — has no blob to read. Skipped,
//     as the working tree would effectively skip it too (it is a directory).
//   * SYMLINK (mode 120000) — the index blob is the LINK TARGET PATH; the
//     working tree read follows the link and returns the target's content.
//     The index answer is the one that matches "what is being committed",
//     and is what `--cached` returns. No tracked `*.md`/`*.rs`/`*.ts`/
//     `*.tsx` symlink exists today; this is stated so the divergence is a
//     decision rather than a surprise.
//
// ─── Cost ─────────────────────────────────────────────────────────────────
//
// One `git show` per path would be ~2,900 process spawns for the citation
// guards' corpus. Instead the blob SHAs come out of the single `ls-files -s`
// call and the bodies stream through `git cat-file --batch` in chunks, so
// the index path costs a handful of processes rather than thousands.
// Measured on this repo: the scanned corpus is 2,938 files / ~45 MB, and one
// unchunked `cat-file --batch` over all of it takes ~0.6 s — the same order
// as the guard's existing ~0.55 s working-tree run.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SOURCE_INDEX = 'index'
export const SOURCE_WORKTREE = 'worktree'

/** Human-readable name for a source, for the line guards print on failure. */
export function describeSource(source) {
  return source === SOURCE_INDEX ? 'staged index' : 'working tree'
}

// Raised from Node's 1 MB default: `git ls-files -s -z` emits ~500 KB over
// 4,606 tracked paths today. An ENOBUFS overflow does not match
// /not a git repository/i, so it would be re-thrown and surface as an
// exit-2 invocation error that fails every commit, rather than silently
// disabling the guard — loud, but still a self-inflicted outage. 64 MB is
// ~130x the current output.
export const GIT_LS_FILES_MAX_BUFFER = 64 * 1024 * 1024

// `cat-file --batch` is chunked so peak memory is bounded by the chunk, not
// by the corpus: 500 paths at this repo's ~15 KB mean is ~7.5 MB per call,
// and the 64 MB ceiling tolerates a chunk of unusually large files. Measured
// on this repo's 2,938-file corpus the largest chunk is 14 MB, ~4.5x under
// the ceiling.
//
// Exported and overridable per call ONLY so a self-test can drive the
// chunk-boundary path without building a 500-file fixture: the multi-record
// framing below is the one place in this file where a one-character slip
// (`off += size` instead of `size + 1`) silently under-reports every file
// after the first, and a fixture that holds a single file cannot see it.
export const CAT_FILE_CHUNK = 500
const CAT_FILE_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Resolve which copy of each file the caller wants read.
 *
 * @returns {{source: string, why: string}} `why` is quoted verbatim in the
 *   guard's failure output — the mechanism has to be legible from the
 *   verdict, not only from this file.
 * @throws {Error & {isUsageError: true}} if both flags are given.
 */
export function resolveSource(argv = process.argv, env = process.env) {
  const cached = argv.includes('--cached')
  const worktree = argv.includes('--worktree')
  if (cached && worktree) {
    const err = new Error('--cached and --worktree are mutually exclusive')
    err.isUsageError = true
    throw err
  }
  if (cached) return { source: SOURCE_INDEX, why: 'explicit --cached' }
  if (worktree) return { source: SOURCE_WORKTREE, why: 'explicit --worktree' }
  const indexFile = env.GIT_INDEX_FILE
  if (indexFile) {
    return {
      source: SOURCE_INDEX,
      why: `auto: git is running a commit hook, GIT_INDEX_FILE=${indexFile}`,
    }
  }
  return {
    source: SOURCE_WORKTREE,
    why: 'auto: no commit in flight (GIT_INDEX_FILE unset)',
  }
}

/**
 * Enumerate the index. Returns `{paths, byPath}` where `paths` preserves
 * `git ls-files` order and `byPath` maps each path to `{mode, sha,
 * unmerged}` (`sha` is null for an unmerged path, which has no stage 0).
 *
 * Returns `null` for the deliberate fail-open case — "not a git repository",
 * e.g. running from an extracted tarball. Every OTHER failure (git missing,
 * permission denied, ENOBUFS, ...) is a genuine invocation error and is
 * re-thrown, so a caller can exit 2 with the cause named rather than
 * swallowing it into a silent "clean".
 *
 * `env` exists for ONE caller: a self-test enumerating a throwaway fixture.
 * `cwd` does NOT determine which index git reads — an ambient
 * `GIT_INDEX_FILE` (which is exactly what git exports to a pre-commit hook)
 * outranks it, so `listTrackedEntries(fixtureDir)` under a real commit
 * enumerates the REAL repository while looking like it enumerates the
 * fixture. That is the #3722 hazard, and it is invisible to
 * `git rev-parse --show-toplevel`, which stays pinned to the fixture. Pass a
 * scrubbed env (`scrubbedGitEnv` in ./git-scratch-guard.mjs) to close it.
 * Omitted, git's ambient context applies — which is what the guards want.
 */
export function listTrackedEntries(repoRoot, { env } = {}) {
  let raw
  try {
    raw = execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: GIT_LS_FILES_MAX_BUFFER,
    })
  } catch (err) {
    const stderr = String(err?.stderr ?? '')
    if (/not a git repository/i.test(stderr)) return null
    throw err
  }
  const paths = []
  const byPath = new Map()
  // `-z` rather than plain `ls-files -s`: NUL-separated records mean a path
  // containing a quote, a backslash or a newline arrives intact instead of
  // C-quoted, and a path that cannot be parsed is a path that cannot be
  // scanned.
  for (const record of raw.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const [mode, sha, stage] = record.slice(0, tab).split(' ')
    const path = record.slice(tab + 1)
    let entry = byPath.get(path)
    if (!entry) {
      entry = { mode: null, sha: null, unmerged: false }
      byPath.set(path, entry)
      paths.push(path)
    }
    if (stage === '0') {
      entry.mode = mode
      entry.sha = sha
    } else {
      entry.unmerged = true
    }
  }
  return { paths, byPath }
}

/**
 * Read the bodies of `paths` from the chosen source.
 *
 * @returns {Map<string, string>} path -> contents. A path absent from the
 *   map could not be read from either source and is simply not scanned —
 *   the same tolerance the working-tree reader has always had, except that
 *   under `--cached` an on-disk absence no longer causes it.
 *
 *   PRESENT-WITH-EMPTY-CONTENT IS NOT ABSENT. A zero-byte tracked file
 *   (`<oid> blob 0`) maps to `''`, and callers must test `=== undefined`
 *   rather than truthiness: `if (!body) continue` would silently drop an
 *   empty file out of the scan, which is the "unscanned file" failure this
 *   whole module exists to prevent. An empty file trivially holds no
 *   violation, so the miss is invisible until the day it is not empty.
 *
 * `env` is threaded to `git` for the same reason as in `listTrackedEntries`
 * above — see that note.
 */
export function readContents(
  paths,
  { repoRoot, source, entries, chunkSize = CAT_FILE_CHUNK, env },
) {
  return source === SOURCE_INDEX
    ? readFromIndex(paths, repoRoot, entries, chunkSize, env)
    : readFromWorktree(paths, repoRoot)
}

function readFromWorktree(paths, repoRoot) {
  const bodies = new Map()
  for (const path of paths) {
    try {
      // Unconditional `set`, so a zero-byte file lands as `''` rather than
      // being filtered out by a truthiness test — see `readContents`.
      bodies.set(path, readFileSync(join(repoRoot, path), 'utf8'))
    } catch {
      // Unreadable on disk (staged-but-deleted, permissions, a directory).
      // Skipped, as before.
    }
  }
  return bodies
}

function readFromIndex(paths, repoRoot, entries, chunkSize = CAT_FILE_CHUNK, env) {
  const bodies = new Map()
  const wanted = []
  const fallToWorktree = []
  for (const path of paths) {
    const entry = entries?.byPath?.get(path)
    if (!entry || entry.sha === null) {
      // No stage-0 blob: an unmerged path (conflict in progress), or a path
      // the caller passed that the index does not contain at all. Neither
      // may crash the guard — see the header.
      fallToWorktree.push(path)
      continue
    }
    if (entry.mode === '160000') continue // submodule: no blob to read
    wanted.push({ path, sha: entry.sha })
  }
  for (let i = 0; i < wanted.length; i += chunkSize) {
    const chunk = wanted.slice(i, i + chunkSize)
    // No `encoding`, so this is a Buffer: `cat-file --batch` sizes are in
    // BYTES, and slicing a decoded string would desynchronise the stream on
    // the first multi-byte character.
    const out = execFileSync('git', ['cat-file', '--batch'], {
      cwd: repoRoot,
      env,
      input: `${chunk.map((e) => e.sha).join('\n')}\n`,
      maxBuffer: CAT_FILE_MAX_BUFFER,
    })
    let off = 0
    for (const { path } of chunk) {
      const nl = out.indexOf(0x0a, off)
      if (nl === -1) break
      const header = out.toString('utf8', off, nl)
      off = nl + 1
      const parts = header.split(' ')
      // `<oid> missing` is the only header with no payload behind it; every
      // other type IS followed by <size> bytes and must be consumed even
      // when it is not a blob, or the next record is read from the middle
      // of this one.
      //
      // A staged entry whose blob is not in the object store means a damaged
      // repository, but "damaged" must not mean "unscanned": dropping the
      // path here would be a silent false green of exactly the kind #3962
      // is about. It takes the unmerged path's treatment — read the copy on
      // disk instead — so the file is still judged, by the only source left.
      if (parts[1] === 'missing') {
        fallToWorktree.push(path)
        continue
      }
      const size = Number(parts[2])
      if (!Number.isFinite(size)) break
      // `size === 0` (a zero-byte tracked file) sets `''` DELIBERATELY, and
      // must not be guarded behind `if (size)`: an empty file is a file that
      // was read and judged, and dropping it here would make it indexed as
      // "unreadable" — an unscanned path. `off` still advances by 1 past the
      // LF git writes after a zero-length payload.
      if (parts[1] === 'blob') bodies.set(path, out.toString('utf8', off, off + size))
      off += size + 1
    }
  }
  for (const [path, body] of readFromWorktree(fallToWorktree, repoRoot)) {
    bodies.set(path, body)
  }
  return bodies
}
