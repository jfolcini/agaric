#!/usr/bin/env node
// #3672 — make the overlap between simultaneously-open pull requests a
// computed, posted fact instead of something a maintainer works out by hand.
//
// ─── Why ─────────────────────────────────────────────────────────────────
//
// Two PRs green in isolation can land a red `main`, and nothing in the
// pipeline knows the two exist at the same time. On 2026-08-09 six PRs were
// open at once and the overlap table had to be built by hand with
// `gh pr view --json files` and `comm`:
//
//     #3723 × #3724 × #3725   prek.toml (all three append hooks)
//     #3719 × #3721           materializer/tests/attachments_gc.rs, sync_protocol/tests.rs
//     #3721 × #3725           commands/attachments.rs
//
// and it had already bitten before that table existed: #3724 re-anchored
// `src-tauri/dynamic-sql-baseline.txt` from a base predating #3717's merge.
// Its own branch was self-consistent and every check green; merged, `main`
// would have carried a baseline saying `1` where the code has `2`, and the
// dynamic-SQL guard would have gone red for a change neither PR made
// incorrectly. It was caught only because a human merged `origin/main` into
// the branch and re-ran the guard on the combined tree.
//
// This is step 1 of #3672's own list, and it is deliberately the cheap one:
// it costs no CI time beyond a checkout and a handful of API reads, and it
// makes that table automatic. It does not gate anything.
//
// ─── Why the open-PR table alone would NOT have caught the near-miss ─────
//
// Measured before writing this, not assumed. #3717 merged at 17:59:27Z and
// #3724 was opened at 18:03:41Z — FOUR MINUTES LATER. They were never open at
// the same time, so an overlap table over open pull requests reports #3724 as
// sharing `src-tauri/dynamic-sql-baseline.txt` with nobody, which is true and
// useless. What was actually wrong is that #3724's BASE predated #3717's
// merge while both edited that one file.
//
// So this computes two different things, and they catch different shapes:
//
//   1. overlap against the other OPEN pull requests — the six-PR table;
//   2. divergence against `main` since this branch's merge base, restricted
//      to the files this PR changes — the #3724 shape, and the only one of
//      the two that would have caught the incident that prompted the issue.
//
// Shipping (1) without (2) would have been a signal named after an incident
// it cannot see.
//
// ─── What this signal DOES NOT measure ───────────────────────────────────
//
// Said out loud, because a signal that is narrower than it reads is the
// failure mode this whole issue family is about.
//
// This compares CHANGED FILE PATHS. It catches the #3724 shape — two branches
// editing one whole-tree ratchet file from different bases — and it does NOT
// catch the shape in #3672's own title example: #3666 added a canary to
// `scripts/zizmor-hook.sh` whose sandbox EXECUTES `scripts/setup-hooks.sh`,
// which #3657 changed. Those two share no file, `git` had nothing to report,
// and neither branch's CI could have known. A path intersection reports them
// as disjoint, correctly and uselessly.
//
// So "no overlap" here means "no shared file", never "safe to merge without
// re-running". The rendered comment says exactly that, for the same reason
// #3702 refuses to let "did not run" render as "found nothing".
//
// ─── Ratchet files ───────────────────────────────────────────────────────
//
// A shared file is worth reading; a shared RATCHET file is the near-miss.
// A baseline, an allowlist or a lockfile encodes a fact about the WHOLE tree,
// so a branch that re-anchors one from a stale base is wrong the moment
// anything else lands — and the resulting red is in a guard, not a test,
// which is why #3672 concludes that a merge-result check has to run
// `prek --all-files` and not just the suites.
//
// Usage:
//   node scripts/pr-file-overlap.mjs --pr <n> --prs prs.json \
//     [--diverged-from diverged.txt] [--comment-body out.md]
//
// `--prs` takes the body of
// `gh pr list --state open --json number,title,files` — every open PR
// including this one, which is filtered out by `--pr`.
//
// `--diverged-from` takes newline-separated paths, i.e. the output of
// `git diff --name-only "$(git merge-base HEAD origin/main)" origin/main`.
// Omitted or unreadable, the divergence section reports "not computed" and
// never "nothing diverged".
//
// Output: the analysis as JSON on stdout, the comment as Markdown to
// `--comment-body`, and `overlaps=`/`ratchets=`/`diverged=`/`basechanged=`
// appended to `$GITHUB_OUTPUT`. `basechanged` (#3979) is the gate that
// actually covers the merged tree: every path the base has changed since
// this branch's merge base, unfiltered by whether this branch touches any of
// them — see `baseChangedCount` below for why `diverged` alone is not enough.
//
// Exit: 0 always when the arguments parse — this lane reports, it never
// gates. 2 for bad usage.

import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export const COMMENT_MARKER = '<!-- pr-file-overlap -->'

/**
 * Files that encode a property of the WHOLE tree rather than of the diff that
 * touches them. Two branches can each hold a self-consistent version and the
 * merge of the two be wrong — which is the #3724 near-miss exactly, and the
 * reason this script separates them from ordinary shared files instead of
 * printing one undifferentiated list.
 */
const RATCHET_PATTERNS = [
  /(^|\/)[^/]*baseline[^/]*\.(?:txt|json|toml)$/i,
  /(^|\/)[^/]*allowlist[^/]*\.(?:txt|json|toml)$/i,
  /(^|\/)prek\.toml$/,
  /(^|\/)nextest\.toml$/,
  /(^|\/)\.typos\.toml$/,
  /(^|\/)(?:Cargo|package|package-lock|pnpm-lock|bun)\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)\.sqlx\//,
]

/**
 * Whether `path` is a whole-tree ratchet file.
 *
 * @param {string} path
 */
export function isRatchetFile(path) {
  return RATCHET_PATTERNS.some((re) => re.test(path))
}

/** The changed paths of one `gh pr list --json files` entry. */
function pathsOf(pr) {
  return (pr?.files ?? []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean)
}

/**
 * This PR's overlap against every OTHER open pull request, and its divergence
 * from `main` on the files it touches.
 *
 * `divergedPaths` is what `main` has changed since this branch's merge base —
 * `git diff --name-only $(git merge-base HEAD origin/main) origin/main`. Pass
 * `null` when it could not be computed, which renders as "not computed"
 * rather than as "nothing diverged".
 *
 * @param {{pr: number, prs: object[], divergedPaths?: string[] | null}} opts
 */
export function computeOverlap({ pr, prs = [], divergedPaths = null }) {
  const self = prs.find((p) => Number(p?.number) === Number(pr)) ?? null
  const mine = new Set(pathsOf(self))
  const others = prs.filter((p) => Number(p?.number) !== Number(pr))
  const overlaps = []
  for (const other of others) {
    const shared = pathsOf(other)
      .filter((p) => mine.has(p))
      .toSorted()
    if (shared.length === 0) continue
    overlaps.push({
      number: Number(other.number),
      title: String(other.title ?? ''),
      shared,
      ratchets: shared.filter(isRatchetFile),
    })
  }
  overlaps.sort((a, b) => b.ratchets.length - a.ratchets.length || a.number - b.number)

  // The #3724 shape: this branch edits a file that `main` has ALSO changed
  // since the branch's base. Both trees are self-consistent; the merge of the
  // two need not be.
  const divergedFiles =
    divergedPaths === null ? null : divergedPaths.filter((p) => mine.has(p)).toSorted()

  // #3979: `divergedFiles` above is filtered to paths THIS PR ALSO touches,
  // which is exactly the wrong set for deciding whether the merge-result gate
  // has anything to do. A ratchet is a whole-tree invariant — a `.rs` file the
  // base adds under a crate root can break `check-dynamic-sql` (say) without
  // this branch sharing a single path with it, so `divergedFiles` is empty,
  // `overlaps` is empty, and a gate keyed on either NEVER RUNS for the exact
  // case it exists for. `baseChangedCount` is deliberately unfiltered — every
  // path `main` has changed since this branch's merge base, independent of
  // what this branch touches — because the hazard is a property of the
  // MERGED TREE, not of the intersection of two changed-path sets. `null`
  // means "not computed", same distinction as `divergedFiles`.
  const baseChangedCount = divergedPaths === null ? null : divergedPaths.length

  return {
    pr: Number(pr),
    // `null` when this PR is not in the payload at all — which is NOT the same
    // fact as "it changed no files", and must not render as "disjoint".
    changedFiles: self === null ? null : mine.size,
    otherOpenPrs: others.map((p) => Number(p.number)).toSorted((a, b) => a - b),
    overlaps,
    ratchetCount: overlaps.reduce((n, o) => n + o.ratchets.length, 0),
    divergedFiles,
    divergedRatchets: divergedFiles === null ? null : divergedFiles.filter(isRatchetFile),
    baseChangedCount,
  }
}

/**
 * Replace a line break with a visible placeholder so a table row — and the
 * code span wrapped around it — cannot be split across more than one
 * physical line.
 *
 * GFM tables are parsed one physical line per row, and a code span's fence
 * matching (`codeSpan` below) only holds within a single line: a `\n`
 * embedded in an interpolated path ends the row (and the code span with it)
 * right there, and everything after the break is parsed as ordinary
 * markdown — no longer pipe-escaped by `escapeTablePipe`, no longer
 * fenced by `codeSpan` — in a fresh table row of its own. Unlike a stray
 * backtick or pipe, a real line break cannot be represented literally
 * inside a table cell at all, so this runs first, before either of the
 * other two escapes, which both assume single-line input. See #4141.
 *
 * @param {string} text
 */
function escapeTableNewline(text) {
  return String(text).replace(/\r\n|\r|\n/g, '␤')
}

/**
 * Escape a `|` so GFM's table-cell splitter does not read it as a column
 * delimiter. Table rows are split on unescaped pipes BEFORE any inline
 * markdown (code spans included) is parsed, so this has to run regardless of
 * what ends up wrapping the text — a pipe inside a code span still breaks
 * the table.
 *
 * @param {string} text
 */
function escapeTablePipe(text) {
  // Backslashes FIRST, then pipes. Escaping `|` while leaving `\` alone is
  // incomplete escaping (CodeQL js/incomplete-sanitization): a path already
  // containing `\` would have that backslash absorbed as the escape for the
  // pipe we just added, so the pipe re-emerges unescaped one nesting level
  // down. GFM's cell scanner happens to absorb `\\|` as `\` + `\|` today, so
  // this was cosmetic rather than a live column break — but the ordering is
  // what makes it true rather than incidental, and it also stops a
  // pre-escaped pipe losing a backslash in the rendered text.
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/**
 * Wrap `text` in an inline code span that a backtick inside `text` cannot
 * close early. `path` values interpolated here are attacker-controlled (a
 * PR's own changed-file list, or what `main` diverged since this branch's
 * base — #4141), so a single-backtick fence cannot assume the content holds
 * no backtick: doing so lets a path close the span and render the remainder
 * as live markdown in a comment posted by `github-actions[bot]`. Per
 * CommonMark, a code span's closing fence must match its opening fence's
 * exact backtick-run length, so choosing a fence one longer than the
 * longest backtick run already in `text` makes early closure impossible; a
 * single space of padding is added when the content starts or ends with a
 * backtick (or is empty), which is what stops that edge backtick from
 * fusing with the fence.
 *
 * @param {string} text
 */
function codeSpan(text) {
  const s = String(text)
  const runs = s.match(/`+/g) ?? []
  const fenceLen = Math.max(0, ...runs.map((r) => r.length)) + 1
  const fence = '`'.repeat(fenceLen)
  const pad = s.startsWith('`') || s.endsWith('`') || s.length === 0
  return pad ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`
}

/**
 * A file path rendered as a safe table-cell code span: newlines collapsed
 * first (so the result is guaranteed to be one physical line, which the
 * other two escapes both assume), then pipe-escaped (so the table structure
 * holds regardless of what wraps the text), then wrapped in a self-widening
 * code span (so an embedded backtick cannot escape into live markdown). See
 * #4141.
 *
 * @param {string} path
 */
function safePathCell(path) {
  return codeSpan(escapeTablePipe(escapeTableNewline(path)))
}

/** The sticky comment body. */
export function renderComment(result) {
  const { pr, changedFiles, otherOpenPrs, overlaps, ratchetCount } = result
  const lines = ['### Open-PR file overlap (#3672)', '']

  if (changedFiles === null) {
    lines.push(
      `The changed-file list for #${pr} could not be read, so **no overlap was computed**.`,
      'This is reported rather than omitted: a missing table and an empty table are',
      'different facts, and only one of them means anything.',
      '',
    )
  } else if (otherOpenPrs.length === 0) {
    lines.push(`No other pull request is open, so there is nothing to overlap with.`, '')
  } else if (overlaps.length === 0) {
    lines.push(
      `This PR shares **no changed file** with the ${otherOpenPrs.length} other open pull request(s) ` +
        `(${otherOpenPrs.map((n) => `#${n}`).join(', ')}).`,
      '',
    )
  } else {
    if (ratchetCount > 0) {
      lines.push(
        `> **A shared file here is a whole-tree ratchet.** Both branches can hold a`,
        `> self-consistent version and the merge of the two still be wrong — that is`,
        `> the #3724 near-miss, where a baseline re-anchored from a stale base was`,
        `> green on its own branch and would have made \`main\` red for a change`,
        `> neither PR made incorrectly. Merge \`origin/main\` in and re-run`,
        `> \`prek --all-files\` on the combined tree before merging this.`,
        '',
      )
    }
    lines.push('| other PR | shared files |', '| --- | --- |')
    for (const o of overlaps) {
      const files = o.shared
        .map((f) => (isRatchetFile(f) ? `**${safePathCell(f)}** ⚠️ ratchet` : safePathCell(f)))
        .join('<br>')
      lines.push(`| #${o.number} | ${files} |`)
    }
    lines.push('')
  }

  // Section two, and the one that would actually have caught #3724. Kept
  // separate from the open-PR table because it answers a different question:
  // #3717 merged FOUR MINUTES before #3724 opened, so no table over open pull
  // requests could ever have paired them.
  lines.push("#### Changed on `main` since this branch's base", '')
  if (result.divergedFiles === null) {
    lines.push(
      'Not computed (the merge base could not be resolved). This is stated rather',
      'than left blank: an unanswered question and a negative answer are different',
      'facts.',
      '',
    )
  } else if (result.divergedFiles.length === 0) {
    lines.push('None of the files this PR changes have changed on `main` since its base.', '')
  } else {
    if (result.divergedRatchets.length > 0) {
      lines.push(
        '> **This is the #3724 shape.** A whole-tree ratchet file below was',
        "> re-anchored from a base that `main` has since moved past. The branch's own",
        '> checks are green because the branch is self-consistent; the MERGE need not',
        '> be. #3724 was one merge from leaving `main` red on the dynamic-SQL guard',
        '> for a change neither PR made incorrectly, and it was caught only because a',
        '> human merged `origin/main` in and re-ran the guard on the combined tree.',
        '> Do that here before merging: the check that catches it is',
        '> `prek --all-files`, not a test suite.',
        '',
      )
    }
    // A TABLE, not a bullet list. This comment is posted by
    // `github-actions[bot]`, and `summarize-review-findings.mjs` counts
    // top-level `- ` items in a bot comment as review findings. That is scoped
    // to the reviewer today, but it falls back to "any bot" when no reviewer
    // app is configured — so a bullet list here would turn every PR carrying a
    // divergence into a yellow review check, for a reason invisible from the
    // check output. That is precisely the defect #3728 finding 1 removed from
    // the mutation lane's comment, and this lane must not reintroduce it.
    lines.push('| file | |', '| --- | --- |')
    for (const f of result.divergedFiles) {
      lines.push(`| ${safePathCell(f)} | ${isRatchetFile(f) ? '⚠️ **ratchet**' : ''} |`)
    }
    lines.push('')
  }

  lines.push(
    '<details><summary>What this does and does not measure</summary>',
    '',
    'This compares **changed file paths only**. It catches two branches editing one',
    'file from different bases. It does **not** catch a semantic interaction between',
    'branches that share no file — #3666 added a canary whose sandbox executes',
    '`scripts/setup-hooks.sh`, which #3657 changed; the two share nothing, `git` had',
    'nothing to report, and both were green right up until `main` went red.',
    '',
    'So an empty table means *no shared file*, never *safe to merge without',
    're-running*. Computed when this PR last changed, against the pull requests open',
    'at that moment — a PR opened since is not in it.',
    '',
    '</details>',
    '',
    COMMENT_MARKER,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { pr: 0, prs: null, commentBody: null, divergedFrom: null }
  for (let i = 0; i < argv.length; i++) {
    const take = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return v
    }
    switch (argv[i]) {
      case '--pr': {
        args.pr = Number(take())
        if (!Number.isInteger(args.pr) || args.pr <= 0) throw new Error('--pr needs a PR number')
        break
      }
      case '--prs': {
        args.prs = take()
        break
      }
      case '--comment-body': {
        args.commentBody = take()
        break
      }
      case '--diverged-from': {
        args.divergedFrom = take()
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${argv[i]}`)
      }
    }
  }
  if (args.pr === 0) throw new Error('--pr is required')
  return args
}

/**
 * Read the PR list. A missing or malformed file becomes `[]`, which renders as
 * "could not be read" rather than as "no overlap" — the distinction this whole
 * issue is about.
 */
function readPrs(file) {
  if (file === null) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`pr-file-overlap: ${err.message}`)
    process.exit(2)
  }

  // A missing/unreadable divergence list stays `null` — "not computed" — and
  // is NEVER coerced to `[]`, which would render as "nothing diverged" and be
  // the exact conflation this file argues against.
  let divergedPaths = null
  if (args.divergedFrom !== null) {
    try {
      divergedPaths = readFileSync(args.divergedFrom, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    } catch {
      divergedPaths = null
    }
  }

  const result = computeOverlap({ pr: args.pr, prs: readPrs(args.prs), divergedPaths })
  console.log(JSON.stringify(result, null, 2))
  if (args.commentBody) writeFileSync(args.commentBody, `${renderComment(result)}\n`, 'utf8')

  const out = process.env.GITHUB_OUTPUT
  if (out) appendFileSync(out, renderGithubOutput(result), 'utf8')
}

/**
 * The `$GITHUB_OUTPUT` lines for one result. Pulled out of `main` so the
 * exact keys `merge-result`'s `if:` reads live in one named place, rather
 * than only the `computeOverlap` fields those keys are derived from — the
 * #3979 gap was in exactly this translation (a field existed, `main` never
 * exported it).
 *
 * @param {ReturnType<typeof computeOverlap>} result
 */
export function renderGithubOutput(result) {
  return (
    `overlaps=${result.overlaps.length}\n` +
    `ratchets=${result.ratchetCount}\n` +
    `diverged=${result.divergedFiles === null ? 'unknown' : result.divergedFiles.length}\n` +
    // #3979: unfiltered — see `baseChangedCount`'s own comment in
    // `computeOverlap`. This is the key `merge-result`'s `if:` now gates on
    // instead of (well, in addition to) `diverged`.
    `basechanged=${result.baseChangedCount === null ? 'unknown' : result.baseChangedCount}\n`
  )
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
