#!/usr/bin/env node
// #4544 — resolve the correct base commit for a PR-scoped mutation diff.
//
// ─── The trap this replaces ────────────────────────────────────────────
//
// `.github/workflows/mutation-pr.yml` used to seed the base from
// `github.event.pull_request.base.sha` — the base branch's tip AS OF THE
// TRIGGERING EVENT. The workflow runs on `pull_request`, so `HEAD` there is
// `refs/pull/N/merge`, a synthetic commit GitHub REGENERATES against the
// base branch's CURRENT tip every time it is fetched. Once the base branch
// advances past the event's `base.sha`, `HEAD` carries those later commits
// while `base` still names the older tip — so `git diff base...HEAD` (even
// with the correct three-dot form) reports everything that landed on the
// base branch in between, attributed to this PR. Observed on PR #4541: with
// no change to the branch itself, main advancing turned "1 of 1 changed
// source file(s)" into "1 of 3", naming two files the PR never touched.
//
// The fix is to stop trusting a value captured at event time and resolve
// the base LOCALLY instead: `git merge-base origin/<base-ref> HEAD` finds
// HEAD's own base parent, in the checkout as it exists right now. It cannot
// go stale, because it isn't a snapshot — every call re-derives it from
// the objects on disk. `fetch-depth: 0` on the workflow's checkout means
// those objects are normally already present; when they are not (a base
// branch checked out via a narrower fetch), this falls back to fetching it
// by name.
//
// A base that fails to resolve throws rather than falling through to an
// empty diff — a silent "this PR touches no module" is indistinguishable
// from the truthful one, and the caller (the workflow step) turns that
// throw into a `::error::`-annotated, non-zero exit.
//
// Usage (library):
//   import { resolveDiffBase } from './pr-diff-base.mjs'
//   const base = resolveDiffBase({ baseRef: 'main', cwd })
//
// Usage (CLI): prints the resolved SHA to stdout, nothing else.
//   node scripts/pr-diff-base.mjs --base-ref <ref> [--cwd <dir>] [--head <head>]
//
// Exit: 0 with the SHA on stdout, 1 (with a `::error::` line on stderr) when
//       the base cannot be resolved, 2 on bad usage.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'

const SHA_RE = /^[0-9a-f]{40}$/i

/**
 * Resolve the merge base between `head` and `origin/<baseRef>`, fetching the
 * base branch first when it is not already present locally.
 *
 * Throws a descriptive `Error` — never returns an empty/undefined result —
 * when the ref cannot be found, cannot be fetched, or shares no common
 * ancestor with `head`.
 */
export function resolveDiffBase({
  baseRef,
  cwd = process.cwd(),
  head = 'HEAD',
  env = process.env,
} = {}) {
  if (!baseRef) {
    throw new Error('resolveDiffBase: baseRef is required (the PR base branch name, e.g. "main")')
  }

  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const remoteRef = `origin/${baseRef}`

  const remoteRefExists = () => {
    try {
      git('rev-parse', '--verify', '-q', `${remoteRef}^{commit}`)
      return true
    } catch {
      return false
    }
  }

  // `fetch-depth: 0` on the workflow's checkout means this is normally
  // already true. Fall back to fetching by name rather than diffing against
  // nothing — see the header note on why a silent empty diff is unacceptable.
  if (!remoteRefExists()) {
    try {
      git('fetch', '--no-tags', 'origin', baseRef)
    } catch (err) {
      throw new Error(
        `resolveDiffBase: '${remoteRef}' is not present locally and ` +
          `\`git fetch --no-tags origin ${baseRef}\` failed: ${err.message}`,
      )
    }
    if (!remoteRefExists()) {
      throw new Error(
        `resolveDiffBase: fetched 'origin/${baseRef}' but '${remoteRef}' still does not resolve ` +
          'to a commit — check that the base ref name is correct.',
      )
    }
  }

  let mergeBase
  try {
    mergeBase = git('merge-base', remoteRef, head).trim()
  } catch (err) {
    throw new Error(
      `resolveDiffBase: \`git merge-base ${remoteRef} ${head}\` failed — '${head}' and ` +
        `'${remoteRef}' share no common ancestor in this checkout (a shallow fetch, or genuinely ` +
        `unrelated histories): ${err.message}`,
    )
  }
  if (!SHA_RE.test(mergeBase)) {
    throw new Error(
      `resolveDiffBase: \`git merge-base\` produced an unexpected value: ${JSON.stringify(mergeBase)}`,
    )
  }
  return mergeBase
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { baseRef: undefined, cwd: process.cwd(), head: 'HEAD' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--base-ref') out.baseRef = argv[++i]
    else if (arg === '--cwd') out.cwd = argv[++i]
    else if (arg === '--head') out.head = argv[++i]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!out.baseRef) throw new Error('missing required --base-ref <ref>')
  return out
}

function main(argv) {
  const { baseRef, cwd, head } = parseArgs(argv)
  console.log(resolveDiffBase({ baseRef, cwd, head }))
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is
// the RESOLVED path while `process.argv[1]` is the path AS INVOKED — so a
// naive comparison is false through a symlink and the script exits 0 having
// run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`::error::${err.message}`)
    process.exit(
      err instanceof Error && /^unknown argument|^missing required/.test(err.message) ? 2 : 1,
    )
  }
}
