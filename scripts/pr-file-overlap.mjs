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
//   node scripts/pr-file-overlap.mjs --self-test
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
// gates. 2 for bad usage / self-test failure.

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  return String(text).replace(/\|/g, '\\|')
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
    // Pinned by an assertion in the self-test.
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
 * self-test can pin the exact keys `merge-result`'s `if:` reads, rather than
 * only the `computeOverlap` fields those keys are derived from — the #3979
 * gap was in exactly this translation (a field existed, `main` never
 * exported it), and a test that stops at `computeOverlap` cannot see that
 * shape of bug.
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

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

// The real six-PR situation from #3672's comment, with the file lists that
// produced the hand-built table. Using the live shape rather than a minimal
// invention is the point: the table below is the one a human had to compute.
const LIVE_PRS = [
  {
    number: 3723,
    title: 'ci(review-findings): make the findings reachable',
    files: [
      { path: 'prek.toml' },
      { path: 'scripts/summarize-review-findings.mjs' },
      { path: '.github/workflows/claude-code-review.yml' },
    ],
  },
  {
    number: 3724,
    title: 'refactor(sql): split the dynamic-SQL surface',
    files: [
      { path: 'prek.toml' },
      { path: 'src-tauri/dynamic-sql-baseline.txt' },
      { path: 'src-tauri/src/sync_protocol/operations.rs' },
    ],
  },
  {
    number: 3725,
    title: 'fix(attachments): confine the peer path',
    files: [{ path: 'prek.toml' }, { path: 'src-tauri/src/commands/attachments.rs' }],
  },
  {
    number: 3719,
    title: 'fix(sync): the op-log frontier must not step over a record',
    files: [
      { path: 'src-tauri/src/materializer/tests/attachments_gc.rs' },
      { path: 'src-tauri/src/sync_protocol/tests.rs' },
    ],
  },
  {
    number: 3721,
    title: "fix(attachments): a peer's fs_path is parsed into a confined path",
    files: [
      { path: 'src-tauri/src/materializer/tests/attachments_gc.rs' },
      { path: 'src-tauri/src/sync_protocol/tests.rs' },
      { path: 'src-tauri/src/commands/attachments.rs' },
    ],
  },
  {
    number: 3730,
    title: 'fix(search,backlinks): surface bounded result sets',
    files: [{ path: 'src/lib/search.ts' }, { path: 'src/components/Backlinks.tsx' }],
  },
]

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  // 1. THE HAND-BUILT TABLE, reproduced. This is the assertion the script
  //    exists for: the maintainer computed exactly this with `gh pr view` and
  //    `comm`, and had to know to go looking in the first place.
  {
    const r = computeOverlap({ pr: 3723, prs: LIVE_PRS })
    expect(
      '#3723 overlaps #3724 and #3725 on prek.toml, and nothing else',
      JSON.stringify(r.overlaps.map((o) => [o.number, o.shared])) ===
        JSON.stringify([
          [3724, ['prek.toml']],
          [3725, ['prek.toml']],
        ]),
      JSON.stringify(r.overlaps),
    )
    const r21 = computeOverlap({ pr: 3721, prs: LIVE_PRS })
    expect(
      '#3721 overlaps #3719 on the two test files and #3725 on attachments.rs',
      JSON.stringify(r21.overlaps.map((o) => [o.number, o.shared.length])) ===
        JSON.stringify([
          [3719, 2],
          [3725, 1],
        ]),
      JSON.stringify(r21.overlaps),
    )
  }

  // 2. THE DISJOINT PR still gets a comment. Silence would be the #3702
  //    defect one lane over: "nothing was computed" and "nothing overlaps"
  //    must not render identically.
  {
    const r = computeOverlap({ pr: 3730, prs: LIVE_PRS })
    expect(
      '#3730 is genuinely disjoint from all five others',
      r.overlaps.length === 0 && r.otherOpenPrs.length === 5,
      JSON.stringify(r),
    )
    const body = renderComment(r)
    expect(
      'a disjoint PR is told so explicitly, with the count of what it was compared against',
      /shares \*\*no changed file\*\* with the 5 other open pull request\(s\)/.test(body),
      body,
    )
    expect(
      'and the comment refuses to let that read as "safe to merge"',
      /never \*safe to merge without/.test(body) && /#3666/.test(body),
      body,
    )
  }

  // 3. THE #3724 NEAR-MISS. A shared baseline is not just another shared file:
  //    both branches are self-consistent and the MERGE is wrong. If this ever
  //    stopped being called out, the table would report the one case it was
  //    built for as an ordinary row.
  {
    const r = computeOverlap({
      pr: 3724,
      prs: [
        ...LIVE_PRS,
        {
          number: 3717,
          title: 'refactor(sync): another dynamic-SQL move',
          files: [
            { path: 'src-tauri/dynamic-sql-baseline.txt' },
            { path: 'src-tauri/src/sync_protocol/operations.rs' },
          ],
        },
      ],
    })
    const withBaseline = r.overlaps.find((o) => o.number === 3717)
    expect(
      'a shared baseline file is classified as a ratchet, not as an ordinary shared file',
      withBaseline?.ratchets.includes('src-tauri/dynamic-sql-baseline.txt') === true,
      JSON.stringify(r.overlaps),
    )
    expect(
      'the ratchet row sorts to the top, above a merely-shared row',
      r.overlaps[0].number === 3717,
      JSON.stringify(r.overlaps.map((o) => o.number)),
    )
    const body = renderComment(r)
    expect(
      'the comment names the remedy that actually caught it: merge main and re-run prek --all-files',
      /prek --all-files/.test(body) && /#3724/.test(body),
      body,
    )
  }

  // 4. Ratchet classification, at unit level. Each accepted pattern carries a
  //    rejected sibling, so the rule cannot be satisfied by flagging
  //    everything — a table where every row is a warning is a table nobody
  //    reads, which is where the always-green check already was.
  {
    const yes = [
      'src-tauri/dynamic-sql-baseline.txt',
      'src-tauri/raw-tx-allowlist.txt',
      'prek.toml',
      'nextest.toml',
      '.typos.toml',
      'Cargo.lock',
      'package-lock.json',
      'src-tauri/.sqlx/query-abc.json',
    ]
    const no = [
      'src-tauri/src/materializer/metrics.rs',
      'src/lib/search.ts',
      'scripts/check-metric-provable.mjs',
      'docs/baseline-design.md',
      '.github/workflows/ci.yml',
    ]
    expect(
      'every ratchet shape is recognised',
      yes.every(isRatchetFile),
      JSON.stringify(yes.filter((p) => !isRatchetFile(p))),
    )
    expect(
      'ordinary sources, docs and workflows are NOT flagged as ratchets',
      no.every((p) => !isRatchetFile(p)),
      JSON.stringify(no.filter(isRatchetFile)),
    )
  }

  // 5. A PR missing from the payload must not render as disjoint. "We could
  //    not read the file list" and "there is no overlap" are different facts;
  //    collapsing them is the failure this repo keeps re-finding.
  {
    const r = computeOverlap({ pr: 9999, prs: LIVE_PRS })
    expect(
      'a PR absent from the payload reports null changed files, not zero overlap',
      r.changedFiles === null && r.overlaps.length === 0,
      JSON.stringify(r),
    )
    const body = renderComment(r)
    expect(
      'and its comment says the overlap was NOT computed rather than showing an empty table',
      /no overlap was computed/.test(body) && !/shares \*\*no changed file\*\*/.test(body),
      body,
    )
  }

  // 5b. THE INCIDENT ITSELF, and the reason the open-PR table is not enough.
  //     Measured: #3717 merged at 17:59:27Z, #3724 was opened at 18:03:41Z.
  //     They were NEVER open together, so no table over open pull requests can
  //     pair them — and #3724's own overlap row for the baseline is empty.
  //     What was wrong is that #3724's BASE predated #3717's merge. If this
  //     assertion ever goes away, the signal is named after an incident it
  //     cannot see.
  {
    const openOnly = computeOverlap({ pr: 3724, prs: LIVE_PRS })
    expect(
      'the open-PR table alone does NOT pair #3724 with the already-merged #3717',
      openOnly.overlaps.every((o) => !o.shared.includes('src-tauri/dynamic-sql-baseline.txt')),
      JSON.stringify(openOnly.overlaps),
    )
    const withBase = computeOverlap({
      pr: 3724,
      prs: LIVE_PRS,
      // what #3717 landed on main after #3724's base was taken
      divergedPaths: ['src-tauri/dynamic-sql-baseline.txt', 'docs/session-log/session-1279.md'],
    })
    expect(
      'the divergence half DOES catch it: the baseline moved on main under this branch',
      JSON.stringify(withBase.divergedFiles) ===
        JSON.stringify(['src-tauri/dynamic-sql-baseline.txt']) &&
        withBase.divergedRatchets.length === 1,
      JSON.stringify({ f: withBase.divergedFiles, r: withBase.divergedRatchets }),
    )
    const body = renderComment(withBase)
    expect(
      'and its comment names the shape, the guard that catches it and the remedy',
      /#3724 shape/.test(body) &&
        /prek --all-files/.test(body) &&
        /dynamic-sql-baseline/.test(body),
      body,
    )
    // The sibling acceptance: a file main changed that this PR does NOT touch
    // is not a divergence worth reporting, or every PR carries a warning and
    // nobody reads any of them.
    const unrelated = computeOverlap({
      pr: 3724,
      prs: LIVE_PRS,
      divergedPaths: ['src/lib/search.ts', 'README.md'],
    })
    expect(
      'files main changed that this PR does not touch are not reported',
      unrelated.divergedFiles.length === 0 &&
        /None of the files this PR changes/.test(renderComment(unrelated)),
      JSON.stringify(unrelated.divergedFiles),
    )
    // #3979: THE FALSIFICATION DEMO ITSELF. `unrelated` above is already the
    // exact shape the issue describes — the base changed two files this PR
    // shares no path with — and `divergedFiles` (rightly, for the human-facing
    // table) reports zero of them. If `baseChangedCount` collapsed to that
    // same filtered view, the merge-result gate would have nothing left to key
    // on for the case it exists for: a base-only ratchet-relevant change with
    // no shared path at all.
    expect(
      "#3979: baseChangedCount counts what main changed even when this PR shares none of it — the case 'diverged' alone cannot see",
      unrelated.baseChangedCount === 2 && unrelated.divergedFiles.length === 0,
      JSON.stringify({
        baseChangedCount: unrelated.baseChangedCount,
        diverged: unrelated.divergedFiles,
      }),
    )
    // …and the sibling: when the base changes MORE than this branch touches,
    // baseChangedCount counts all of it, not just the overlapping subset —
    // pinning the "unfiltered" half, not just the "nonzero on a disjoint set"
    // half above.
    expect(
      'baseChangedCount is the FULL base-changed set, not the mine-filtered subset (withBase touches 1 of 2)',
      withBase.baseChangedCount === 2 && withBase.divergedFiles.length === 1,
      JSON.stringify({
        baseChangedCount: withBase.baseChangedCount,
        diverged: withBase.divergedFiles,
      }),
    )
    // …and an unresolvable merge base says so rather than saying "none",
    // for baseChangedCount too — "not computed" must not collapse to 0.
    const notComputed = computeOverlap({ pr: 3724, prs: LIVE_PRS })
    expect(
      'an uncomputed divergence leaves baseChangedCount null, never 0',
      notComputed.baseChangedCount === null,
      JSON.stringify(notComputed.baseChangedCount),
    )
    const unknown = renderComment(notComputed)
    expect(
      'an uncomputed divergence renders as "not computed", never as "none"',
      /Not computed/.test(unknown) && !/None of the files/.test(unknown),
      unknown,
    )
  }

  // 6b. #3979: the `$GITHUB_OUTPUT` translation itself — the exact spot the
  //     original gap lived in. A `computeOverlap` field existing is not the
  //     same fact as `main` exporting it; the gate reads the exported key.
  //     Recomputed rather than reusing 5b's locals, which are out of scope
  //     across the block boundary.
  {
    const disjoint = computeOverlap({
      pr: 3724,
      prs: LIVE_PRS,
      divergedPaths: ['src/lib/search.ts', 'README.md'],
    })
    const disjointOut = renderGithubOutput(disjoint)
    expect(
      'basechanged is exported nonzero for a PR sharing NO path with what the base changed',
      /^basechanged=2$/m.test(disjointOut) && /^diverged=0$/m.test(disjointOut),
      disjointOut,
    )
    const uncomputedOut = renderGithubOutput(computeOverlap({ pr: 3724, prs: LIVE_PRS }))
    expect(
      'an uncomputed divergence exports basechanged=unknown, matching diverged=unknown',
      /^basechanged=unknown$/m.test(uncomputedOut) && /^diverged=unknown$/m.test(uncomputedOut),
      uncomputedOut,
    )
  }

  // 6c. #3979: `main` itself, end to end, through a REAL `$GITHUB_OUTPUT`
  //     file — not `renderGithubOutput` called directly. 6b pins that the
  //     translation function is correct; this pins that `main` still calls
  //     it. Those are different facts: `renderGithubOutput` existing and
  //     being right does not mean `main`'s `if (out) appendFileSync(...)`
  //     line still passes it a `result` and still uses it at all, and a
  //     regression right there (reverting to an inline literal that drops
  //     `basechanged`, say) is invisible to every assertion above it.
  {
    const dir = mkdtempSync(join(tmpdir(), 'pr-file-overlap-selftest-'))
    const prsPath = join(dir, 'prs.json')
    const divergedPath = join(dir, 'diverged.txt')
    const outputPath = join(dir, 'github_output')
    writeFileSync(prsPath, JSON.stringify(LIVE_PRS), 'utf8')
    writeFileSync(divergedPath, 'src/lib/search.ts\nREADME.md\n', 'utf8')
    writeFileSync(outputPath, '', 'utf8')
    const prevOutput = process.env.GITHUB_OUTPUT
    const prevLog = console.log
    console.log = () => {} // silence main's own JSON dump for this block only
    try {
      process.env.GITHUB_OUTPUT = outputPath
      main(['--pr', '3724', '--prs', prsPath, '--diverged-from', divergedPath])
    } finally {
      console.log = prevLog
      if (prevOutput === undefined) delete process.env.GITHUB_OUTPUT
      else process.env.GITHUB_OUTPUT = prevOutput
    }
    const written = readFileSync(outputPath, 'utf8')
    expect(
      "main's actual $GITHUB_OUTPUT write includes basechanged, not just renderGithubOutput's return value",
      /^basechanged=2$/m.test(written) &&
        /^diverged=0$/m.test(written) &&
        /^ratchets=\d+$/m.test(written),
      written,
    )
    rmSync(dir, { recursive: true, force: true })
  }

  // 6. The sticky marker is in every rendering, or the comment step posts a
  //    new comment on every push instead of editing one.
  {
    const bodies = [3723, 3730, 9999].map((n) =>
      renderComment(computeOverlap({ pr: n, prs: LIVE_PRS })),
    )
    expect(
      'every comment body carries the sticky marker',
      bodies.every((b) => b.includes(COMMENT_MARKER)),
      'a rendering dropped the marker',
    )
    // No rendering may emit a TOP-LEVEL list item. This comment is authored by
    // `github-actions[bot]`, and the review-findings summariser counts exactly
    // those as findings whenever it falls back to "any bot" — which it does
    // when no reviewer app is configured. Stated over every branch, including
    // the divergence table, because that is the one that grew a bullet list.
    const withDivergence = renderComment(
      computeOverlap({
        pr: 3724,
        prs: LIVE_PRS,
        divergedPaths: ['src-tauri/dynamic-sql-baseline.txt', 'prek.toml'],
      }),
    )
    const topLevelItems = (body) =>
      body.split('\n').filter((l) => /^(?:\d{1,2}[.)]|[-*+])\s+\S/.test(l))
    expect(
      'no comment body emits a top-level list item the review check would count as a finding',
      [...bodies, withDivergence].every((b) => topLevelItems(b).length === 0),
      JSON.stringify(topLevelItems(withDivergence)),
    )
    expect(
      'the divergence section still names its files and marks the ratchet',
      /\| `src-tauri\/dynamic-sql-baseline\.txt` \| ⚠️ \*\*ratchet\*\* \|/.test(withDivergence),
      withDivergence,
    )
  }

  // 7. #4141: a diverged-file PATH is attacker-controlled — the `compute` job
  //    checks out PR-authored code and runs `scripts/pr-overlap-diverged.sh`
  //    from it — and lands interpolated straight into a markdown code span in
  //    the sticky comment. A backtick in the path closes the span early and
  //    the remainder renders as LIVE markdown in a comment posted by
  //    `github-actions[bot]`; a pipe breaks the table. Falsification, not
  //    just an assertion: this must be demonstrably RED against the
  //    unescaped renderer before the fix lands, and green after.
  {
    const evilPath = 'evil`**INJECTED**`|also/evil.md'
    const r = computeOverlap({
      pr: 4141,
      prs: [{ number: 4141, title: 'evil pr', files: [{ path: evilPath }] }],
      divergedPaths: [evilPath],
    })
    const body = renderComment(r)
    const row = body.split('\n').find((l) => l.includes('also/evil.md'))
    expect('the diverged-file row exists', typeof row === 'string', body)
    if (typeof row === 'string') {
      // Table cells are split on unescaped `|` before any inline markdown
      // (including code spans) is parsed, so a stray pipe from the path adds
      // a phantom column regardless of what surrounds it. A well-formed
      // `| path | annotation |` row carries exactly 3 raw (non-`\|`) pipes.
      const unescapedPipes = row.replace(/\\\|/g, '').split('|').length - 1
      expect(
        'the injected pipe does not add a table column (exactly 3 raw pipes: | path | annotation |)',
        unescapedPipes === 3,
        row,
      )
      // Approximate CommonMark code-span stripping: repeatedly remove a
      // backtick-delimited span (open fence, content, matching-length close
      // fence). What survives is what would render as ordinary markdown text
      // outside any code span — if the injected bold marker is still in
      // there, it renders live.
      const stripped = stripCodeSpansForTest(row)
      expect(
        'the injected backtick-bold payload is fully contained inside a code span, not left as live text',
        !stripped.includes('INJECTED'),
        JSON.stringify({ row, stripped }),
      )
    }
  }

  // 8. #4141: a newline embedded in a path is the sharpest version of the
  //    same hazard. A GFM table row — and the code span wrapped around it —
  //    is parsed one physical line at a time, so a literal `\n` in the path
  //    ends the row right there; the remainder becomes a FRESH table row of
  //    its own, no longer inside any code span and no longer pipe-escaped
  //    by anything on THIS row. Falsification: this must be demonstrably
  //    RED (the injected text lands on its own physical line, outside any
  //    code span) against a renderer that skips `escapeTableNewline`, and
  //    green with it.
  {
    const evilPath = 'evil\n**NEWLINE-INJECTED**|also/evil.md'
    const r = computeOverlap({
      pr: 4141,
      prs: [{ number: 4141, title: 'evil pr', files: [{ path: evilPath }] }],
      divergedPaths: [evilPath],
    })
    const body = renderComment(r)
    const row = body.split('\n').find((l) => l.includes('also/evil.md'))
    expect('the diverged-file row exists', typeof row === 'string', body)
    if (typeof row === 'string') {
      expect(
        'the embedded newline did not split the row: the injected text stays on the SAME physical line as the rest of the path',
        row.includes('NEWLINE-INJECTED'),
        JSON.stringify({ bodyLines: body.split('\n') }),
      )
      const unescapedPipes = row.replace(/\\\|/g, '').split('|').length - 1
      expect(
        'the injected pipe does not add a table column (exactly 3 raw pipes: | path | annotation |)',
        unescapedPipes === 3,
        row,
      )
      const stripped = stripCodeSpansForTest(row)
      expect(
        'the injected bold payload is fully contained inside a code span, not left as live text',
        !stripped.includes('NEWLINE-INJECTED'),
        JSON.stringify({ row, stripped }),
      )
    }
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

/**
 * Test-only approximation of CommonMark code-span stripping: repeatedly
 * removes an opening run of backticks, its content, and the next run of
 * backticks of the SAME length (the closing fence), leaving unmatched
 * backticks (which CommonMark renders as literal, inert characters) in
 * place. Used only to falsify #4141 — real rendering is left to GitHub.
 *
 * @param {string} text
 */
function stripCodeSpansForTest(text) {
  let s = text
  for (;;) {
    const open = /`+/.exec(s)
    if (!open) return s
    const fence = open[0]
    const afterOpen = open.index + fence.length
    const closeRe = new RegExp(`\`{${fence.length}}(?!\`)`)
    const closeMatch = closeRe.exec(s.slice(afterOpen))
    if (!closeMatch) return s // unmatched backticks: literal, inert, leave as-is
    const end = afterOpen + closeMatch.index + closeMatch[0].length
    s = s.slice(0, open.index) + s.slice(end)
  }
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) runSelfTest()
  else main(argv)
}
