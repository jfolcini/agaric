#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// Tracked-file markdown link integrity check.
//
// For every tracked .md file in the repo, find every relative-path
// link of the form `[text](relative/path[#anchor])` and verify the
// target path is ALSO tracked by git. Catches the failure mode where
// a file is removed from history (e.g. via filter-repo, then
// .gitignore'd) but references to it remain in committed docs.
//
// Why this is separate from lychee: lychee resolves relative file
// links against the working tree, so an UNTRACKED on-disk copy of
// the target shadows the gap and the local pre-commit run passes.
// CI's checkout doesn't have the untracked copy, so lychee fails
// there. This script asks `git ls-files` instead, matching CI.
//
// Originally added after a stale doc was filter-repo'd out of
// history but two committed Markdown links to it (in ARCHITECTURE.md
// §19 and CONTRIBUTING.md "Before you start") remained — caught
// only by the 0.1.0 release-time lychee run.
//
// Skipped link types: URL schemes (`http://`, `mailto:`, …),
// pure anchors (`#section`), and anything whose path resolves to a
// `.gitignore`-d directory (`node_modules/`, `dist/`, `target/`, …)
// — those are owned by tooling, not by us.
//
// ─── Which COPY of each doc is judged (#3962, swept here by #4017) ───
//
// The corpus and the existence table were ALWAYS index-based —
// `git ls-files` reads the index, which is the whole point of this
// guard versus lychee — but the link bodies were read with
// `fs.readFileSync`, i.e. from the working tree. Mixing the two is how
// a pre-commit verdict comes to describe content that is not being
// committed:
//
//   * FALSE GREEN — a doc whose staged copy links to a path that was
//     deleted commits cleanly, because the author already fixed the
//     link on disk without `git add`. That is the exact failure this
//     guard exists to prevent, arriving silently.
//   * FALSE RED — the fix is staged and a later working-tree edit
//     reintroduces the broken link; the commit is blocked over a doc
//     the author already fixed.
//
// `--cached` / `--worktree` force the source; with neither,
// `GIT_INDEX_FILE` (git naming the index it is about to commit)
// decides. Rationale, the measurements behind that auto rule, and the
// deletion / unmerged / symlink decisions: scripts/lib/guard-file-source.mjs.
//
// Usage:
//   node scripts/check-md-link-targets.mjs              # auto source
//   node scripts/check-md-link-targets.mjs --cached     # staged index
//   node scripts/check-md-link-targets.mjs --worktree   # working tree
//   node scripts/check-md-link-targets.mjs --print-source
//
// Any OTHER argument is a usage error, not a silently ignored one: a
// mistyped `--cache` that resolved to AUTO would judge a copy the
// caller did not ask for, and say nothing about it.
//
// Exit: 0 = clean, 1 = at least one untracked target, 2 = invocation error.
// ─────────────────────────────────────────────────────────────────────

import path from 'node:path'

import {
  describeSource,
  gitEnv,
  listTrackedEntries,
  readContents,
  repoRootFromCwd,
  resolveSource,
} from './lib/guard-file-source.mjs'

// The repository the CALLER is standing in, not the one this script was
// checked out into — the documented EXCEPTION to "a guard judges the tree
// that contains it", taken through the SHARED `repoRootFromCwd` rather than a
// private `show-toplevel` (#4192: a private copy asked git under the ambient
// environment, where a leaked git context redirects the root itself). The
// rule, the exception, the five guards that take it and what to do instead are
// stated once, in `scripts/lib/guard-file-source.mjs` ("Which TREE is judged,
// and the one documented exception"). Not restated here: a rule written down
// twice is a rule that will be true in one place.
const ROOT = repoRootFromCwd()

// The environment this guard's OWN `git` calls run under. An ambient
// `GIT_INDEX_FILE` outranks `cwd` for the INDEX and an ambient `GIT_DIR`
// outranks it for the REPOSITORY (#4191), so without this a leaked git
// context would enumerate somebody else's tree — under `--worktree` as
// readily as `--cached` — while `cwd=ROOT` made it look otherwise. See
// `gitEnv`.
const GIT_ENV = gitEnv(ROOT, process.env)

// Match `](href)` where href is non-empty and contains no whitespace
// inside the parens. We strip surrounding `<>` (for autolinks) and an
// optional title after the URL (`](href "title")`). The title syntax
// is rare in this repo but the tolerant parse keeps us out of trouble.
const LINK_RE = /\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g

// Replace fenced code blocks and inline code spans with whitespace
// of the same length so absolute character offsets stay stable but
// markdown-syntax-as-documentation (e.g. `[text](url)` inside a
// table cell explaining link syntax) doesn't trip the link regex.
export function stripCode(src) {
  return src
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
}

/** Every broken intra-repo link in `bodies`, judged against `tracked`. */
export function findBrokenLinks(mdFiles, bodies, tracked) {
  const failures = []
  for (const md of mdFiles) {
    // `=== undefined`, never a truthiness test: a zero-byte doc reads as
    // `''` and must count as READ, not as skipped. See `readContents`.
    const fileSrc = bodies.get(md)
    if (fileSrc === undefined) continue
    const stripped = stripCode(fileSrc)
    const dir = path.dirname(md)

    for (const match of stripped.matchAll(LINK_RE)) {
      const href = match[1]

      // External URL? Skip — lychee covers those.
      if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) continue
      // Pure anchor inside the same file? Skip.
      if (href.startsWith('#')) continue
      // Strip fragment / query (lychee handles fragments separately).
      const pathOnly = href.replace(/[#?].*$/, '')
      if (!pathOnly) continue

      // Resolve relative to the markdown file's directory.
      const resolved = path.posix.normalize(path.posix.join(dir, pathOnly))

      // Out-of-tree (`../` past the repo root) — not our problem.
      if (resolved.startsWith('..')) continue
      // Already known not to be a file (link points at a directory) —
      // git ls-files won't list directories, so verify either the
      // exact path OR an `index.md` / README inside it.
      if (
        tracked.has(resolved) ||
        tracked.has(`${resolved}/index.md`) ||
        tracked.has(`${resolved}/README.md`)
      ) {
        continue
      }

      // The target may be a directory implicitly listed via its files;
      // check if any tracked file lives under that prefix.
      const dirPrefix = `${resolved}/`
      let isDirHit = false
      for (const t of tracked) {
        if (t.startsWith(dirPrefix)) {
          isDirHit = true
          break
        }
      }
      if (isDirHit) continue

      failures.push({ source: md, link: href, resolved })
    }
  }
  return failures
}

function check() {
  let chosen
  try {
    chosen = resolveSource(process.argv, process.env, {
      extraFlags: ['--print-source'],
      // AUTO must know whose index `GIT_INDEX_FILE` names, not merely that it
      // is set — see `resolveSource`.
      repoRoot: ROOT,
    })
  } catch (err) {
    console.error(`check-md-link-targets: invocation error: ${err.message}`)
    return 2
  }
  if (process.argv.includes('--print-source')) {
    console.log(`check-md-link-targets: ${describeSource(chosen.source)} (${chosen.why})`)
    return 0
  }
  let entries
  try {
    entries = listTrackedEntries(ROOT, { env: GIT_ENV })
  } catch (err) {
    console.error(`check-md-link-targets: invocation error: ${err.message}`)
    return 2
  }
  if (entries === null) {
    console.warn('check-md-link-targets: not a git repo; skipping.')
    return 0
  }
  const tracked = new Set(entries.paths)
  const mdFiles = entries.paths.filter((p) => p.endsWith('.md'))
  let bodies
  try {
    bodies = readContents(mdFiles, {
      repoRoot: ROOT,
      source: chosen.source,
      entries,
      env: GIT_ENV,
    })
  } catch (err) {
    console.error(`check-md-link-targets: invocation error: ${err.message}`)
    return 2
  }

  const failures = findBrokenLinks(mdFiles, bodies, tracked)
  if (failures.length > 0) {
    console.error('ERROR: tracked Markdown files link to paths not tracked by git:')
    // Name the source with the verdict. A red the author cannot reproduce by
    // opening the file is otherwise indistinguishable from a broken guard.
    console.error(`  (judged the ${describeSource(chosen.source)} — ${chosen.why})`)
    for (const f of failures) {
      console.error(`  ${f.source} → ${f.link}  (resolves to ${f.resolved})`)
    }
    console.error('')
    console.error(
      'Either restore the target file (git restore / re-add to tracking), update the link to point',
    )
    console.error(
      'at the new home, or remove the broken reference. Lychee in CI catches these eventually,',
    )
    console.error(
      'but only after a fresh checkout — local lychee runs see untracked working-tree copies and pass.',
    )
    return 1
  }

  console.log(
    `OK: ${mdFiles.length} tracked .md files have no broken intra-repo links ` +
      `(judged the ${describeSource(chosen.source)}).`,
  )
  return 0
}

process.exit(check())
