#!/usr/bin/env node
// #3702 — make `claude-review`'s findings reachable from its check status.
//
// ─── Why ─────────────────────────────────────────────────────────────────
//
// `claude-review`'s check conclusion answers "did the review RUN", not "did
// the review FIND anything". Only the second question is interesting at merge
// time, and a `SUCCESS` is indistinguishable between them. #3694 was merged on
// a fully green rollup while the reviewer's approving review body carried
// SEVEN observations, two of which were correctness defects (a disclosure
// button unmounted mid-interaction, dropping focus to `<body>`; batch-trash
// Retry re-firing a stale id list). Both shipped to `main` and were fixed
// afterwards in #3701. The maintainer read the rollup, saw one green check
// among twenty, and merged — the findings were on the PR the whole time.
//
// That is worse than a review that fails loudly and worse than no review at
// all, because the green check actively signals "reviewed and fine".
//
// The reviewer's notes are deliberately NON-BLOCKING and that is right: most
// are observations, and a reviewer that hard-fails on style gets switched off
// within a week. But non-blocking was implemented as INVISIBLE TO THE MERGE
// PATH, and those are not the same thing. A finding can be non-blocking and
// still need to be seen before the merge button.
//
// So: this script reads the review the bot actually posted and emits a
// `check_run` payload whose conclusion is `neutral` when there are findings
// and `success` when there are none, with the count in the title. `neutral`
// does not fail a required check — the blocking policy is unchanged — but it
// is no longer green, so a rollup, a merge queue or an agent working a batch
// can see that something was said.
//
// ─── The second failure, which is worse (#3702's follow-up) ──────────────
//
// On #3701 the same reviewer approved with "six non-blocking notes filed
// separately". Nothing was filed: no issues, no inline comments, and only
// THREE of the six were named in the prose, so the other three are
// unrecoverable. That sentence is exactly what a merger would rely on to
// conclude nothing will be lost, and it is unfalsifiable at the moment of
// decision — verifying it means going to look for issues that may not exist,
// which is more work than reading the notes would have been.
//
// So a filing claim with no issue number cited, and a claimed count larger
// than the body enumerates, are BOTH findings in their own right here. Prose
// asserting that an action was taken is worse than no claim at all, because
// it suppresses the reader's own follow-up.
//
// ─── Which way this errs ─────────────────────────────────────────────────
//
// Deliberately toward over-counting. A list item that is really a
// verification rather than a finding costs a `neutral` check, whose whole
// meaning is "go read the review" — the reader loses a few seconds. An
// under-count costs a `SUCCESS` on a review that found a correctness defect,
// which is the exact failure this exists to remove. For the same reason a
// MISSING review is `neutral`, never `success`: "the reviewer did not run" and
// "the reviewer found nothing" must not render identically, which is the
// original defect one level up.
//
// Usage:
//   node scripts/summarize-review-findings.mjs \
//     --reviews reviews.json [--comments comments.json] \
//     --head-sha <sha> [--check-payload payload.json] [--summary-file out.md]
//   node scripts/summarize-review-findings.mjs --self-test
//
// `--reviews` / `--comments` take the raw bodies of
// `GET /repos/{o}/{r}/pulls/{n}/reviews` and `GET …/issues/{n}/comments`.
//
// Output: the analysis as JSON on stdout; `conclusion=`, `title=` and
// `findings=` appended to `$GITHUB_OUTPUT` when set.
//
// Exit: 0 always when the arguments parse — this script must never be the
// thing that fails the review job. 2 for bad usage / self-test failure.

import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import process from 'node:process'

export const CHECK_NAME = 'claude-review findings'

// Cardinals the reviewer actually writes. Digits are handled separately.
const WORD_NUMBERS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
}

// "six non-blocking notes", "7 observations", "three findings". Up to three
// intervening words so the hedge the reviewer always writes ("non-blocking",
// "minor", "further") does not break the match.
const CLAIM_RE = new RegExp(
  `\\b(\\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')})\\b(?:\\s+[a-z-]+){0,3}\\s+` +
    `(?:notes?|observations?|findings?|nits?|remarks?|concerns?|suggestions?)\\b`,
  'gi',
)

// A claim that the findings were routed somewhere durable. Unbacked by an
// issue number this is the #3701 shape.
const FILING_RE =
  /\bfiled\s+separately\b|\bfiled\s+as\b|\btracked\s+separately\b|\bfiled\s+under\b|\b(?:will\s+)?(?:file|open)(?:d|ing)?\s+(?:an?\s+)?(?:issues?|tickets?)\b/i

const ISSUE_REF_RE = /(?<![\w/])#(\d{2,6})\b/g

/** Blank fenced code blocks so a diff or a log inside the body cannot be counted. */
function stripFences(body) {
  return body.replace(/^```[\s\S]*?^```/gm, '').replace(/^ {4,}\S.*$/gm, '')
}

// The header the reviewer writes above its findings — "Non-blocking notes,
// none of which need to hold up the merge:", "**Non-blocking, please address
// in a follow-up:**". It matters because these reviews also enumerate what
// they VERIFIED, and counting a verification as a finding is a false yellow:
// #3639's review listed eight verifications and three findings, and without
// the header the check would have said eleven. Trailing `**` allowed because
// the header is usually bold.
const FINDINGS_HEADER_RE =
  /^[^\n]*\b(?:non-?blocking|findings?|observations?|notes?|nits?|concerns?|suggestions?|follow-?ups?)\b[^\n]*:\**\s*$/im

/**
 * Top-level list items — the shape the reviewer enumerates findings in.
 * Indented continuation lines are NOT items (a sub-bullet of one finding is
 * not a second finding).
 *
 * Scoped to what follows the findings header when the body has one; the whole
 * body when it does not, which errs toward over-counting. That is the safe
 * direction: an over-count costs a `neutral` whose whole meaning is "go read
 * the review", an under-count costs a green check on a real defect.
 */
export function enumeratedItems(body) {
  const stripped = stripFences(body)
  const header = FINDINGS_HEADER_RE.exec(stripped)
  const scope = header ? stripped.slice(header.index + header[0].length) : stripped
  return scope.split('\n').filter((line) => /^(?:\d{1,2}[.)]|[-*+])\s+\S/.test(line))
}

/**
 * The largest count the body CLAIMS, or null. Used against the enumerated
 * count: "six notes filed separately" with three named and none filed is a
 * shortfall the merger cannot see at decision time.
 */
export function claimedCount(body) {
  let max = null
  for (const m of stripFences(body).matchAll(CLAIM_RE)) {
    const token = m[1].toLowerCase()
    const n = WORD_NUMBERS[token] ?? Number(token)
    if (Number.isFinite(n) && (max === null || n > max)) max = n
  }
  return max
}

/**
 * Analyse one review/comment body.
 *
 * @param {string} body
 */
export function analyzeBody(body) {
  const text = body ?? ''
  const enumerated = enumeratedItems(text).length
  const claimed = claimedCount(text)
  const citedIssues = [...text.matchAll(ISSUE_REF_RE)].map((m) => `#${m[1]}`)
  const claimsFiling = FILING_RE.test(stripFences(text))
  return {
    enumerated,
    claimed,
    citedIssues: [...new Set(citedIssues)],
    claimsFiling,
    // The claim is only backed if the body says WHERE. `filed separately` with
    // no number is a promise the reader cannot check without more work than
    // reading the findings would have been.
    unbackedFilingClaim: claimsFiling && citedIssues.length === 0,
    shortfall: claimed !== null && enumerated < claimed ? claimed - enumerated : 0,
  }
}

/** A bot-authored review/comment; `[bot]` is how GitHub suffixes App logins. */
function isBotAuthor(entry) {
  const login = entry?.user?.login ?? ''
  return entry?.user?.type === 'Bot' || login.endsWith('[bot]')
}

/**
 * The whole verdict, from the raw API payloads.
 *
 * @param {{reviews?: object[], comments?: object[], headSha?: string}} opts
 */
export function summarize({ reviews = [], comments = [], headSha = '' }) {
  // The reviewer re-reviews on every push (`dismiss_stale_reviews_on_push`),
  // so only the LAST bot review describes the code being merged. An older
  // review's findings may already be fixed; counting them would train the
  // reader to ignore the check.
  const botReviews = reviews.filter((r) => isBotAuthor(r) && (r.body ?? '').trim().length > 0)
  const review = botReviews.at(-1) ?? null
  const botComments = comments.filter((c) => isBotAuthor(c) && (c.body ?? '').trim().length > 0)

  if (review === null && botComments.length === 0) {
    // NOT success. "The reviewer never posted" and "the reviewer found
    // nothing" are different facts and must not render identically — that
    // equivalence is #3702 itself, one level up.
    return {
      conclusion: 'neutral',
      findings: 0,
      title: 'No review found — the reviewer posted nothing on this commit',
      summary: [
        `### ${CHECK_NAME}`,
        '',
        'No review body from the reviewer app was found on this pull request.',
        '',
        'This is reported as **neutral**, not success: a review that did not run',
        'and a review that found nothing are different facts, and a green check',
        'would make them indistinguishable (#3702).',
      ].join('\n'),
      headSha,
      details: null,
    }
  }

  const bodies = [review?.body ?? '', ...botComments.map((c) => c.body)].filter(
    (b) => b.trim().length > 0,
  )
  const parts = bodies.map(analyzeBody)
  const findings = Math.max(...parts.map((p) => Math.max(p.enumerated, p.claimed ?? 0)))
  const unbacked = parts.some((p) => p.unbackedFilingClaim)
  const shortfall = Math.max(...parts.map((p) => p.shortfall))
  const state = review?.state ?? 'COMMENTED'

  const lines = [`### ${CHECK_NAME}`, '']
  if (findings > 0) {
    lines.push(
      `The reviewer's verdict is **${state}**, and its body carries **${findings} finding(s)**.`,
      '',
      'This check is `neutral`, never `failure`: the findings are non-blocking by',
      'design and this lane gates nothing. It is not `success` either, because a',
      'green check is what let #3694 merge with two correctness defects sitting',
      'unread in the review body (#3702).',
      '',
      '**Read the review before merging.**',
    )
  } else {
    lines.push(`The reviewer's verdict is **${state}** and its body enumerates no findings.`)
  }
  if (shortfall > 0) {
    const claimedMax = Math.max(...parts.map((p) => p.claimed ?? 0))
    const namedMax = Math.max(...parts.map((p) => p.enumerated))
    lines.push(
      '',
      `> **The review claims more findings than it names** — a count of ${claimedMax} against ${namedMax} enumerated, so ${shortfall} of them exist nowhere a reader can get to. On #3701 exactly three of six were recoverable.`,
    )
  }
  if (unbacked) {
    lines.push(
      '',
      '> **The review says findings were filed elsewhere but cites no issue number.** That claim is what a merger would rely on to conclude nothing is lost, and it cannot be checked at the moment of decision. Either cite the issues or keep the findings inline (#3702).',
    )
  }

  const flagged = findings > 0 || unbacked || shortfall > 0
  const title = flagged
    ? `${findings} finding(s) in the review body${unbacked ? ' — plus an uncited "filed separately" claim' : ''}`
    : 'No findings in the review body'
  return {
    conclusion: flagged ? 'neutral' : 'success',
    findings,
    title,
    summary: lines.join('\n'),
    headSha,
    details: { state, unbacked, shortfall, parts },
  }
}

/** The `POST /repos/{o}/{r}/check-runs` body. */
export function checkPayload(result) {
  return {
    name: CHECK_NAME,
    head_sha: result.headSha,
    status: 'completed',
    conclusion: result.conclusion,
    output: {
      // GitHub truncates a check output title at 255 chars.
      title: result.title.slice(0, 255),
      summary: result.summary,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    reviews: null,
    comments: null,
    headSha: '',
    checkPayload: null,
    summaryFile: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const take = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`)
      return v
    }
    switch (argv[i]) {
      case '--reviews': {
        args.reviews = take()
        break
      }
      case '--comments': {
        args.comments = take()
        break
      }
      case '--head-sha': {
        args.headSha = take()
        break
      }
      case '--check-payload': {
        args.checkPayload = take()
        break
      }
      case '--summary-file': {
        args.summaryFile = take()
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${argv[i]}`)
      }
    }
  }
  return args
}

/**
 * Read a JSON array. A missing or malformed file becomes `[]` rather than a
 * throw: this script runs in the review job's tail and must never be what
 * fails it — and an empty list is reported as `neutral`, so a read failure
 * cannot manufacture a green check.
 */
function readList(file) {
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
    console.error(`summarize-review-findings: ${err.message}`)
    process.exit(2)
  }

  const result = summarize({
    reviews: readList(args.reviews),
    comments: readList(args.comments),
    headSha: args.headSha,
  })
  console.log(JSON.stringify({ ...result, details: undefined }, null, 2))

  if (args.checkPayload) {
    writeFileSync(args.checkPayload, `${JSON.stringify(checkPayload(result), null, 2)}\n`, 'utf8')
  }
  if (args.summaryFile) writeFileSync(args.summaryFile, `${result.summary}\n`, 'utf8')

  const out = process.env.GITHUB_OUTPUT
  if (out) {
    appendFileSync(
      out,
      `conclusion=${result.conclusion}\nfindings=${result.findings}\ntitle=${result.title}\n`,
      'utf8',
    )
  }
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

// The two REAL review bodies this issue is about, trimmed to the structure
// that matters. Fixtures copied from a live `GET /pulls/{n}/reviews`, so the
// rules are exercised against prose a model actually wrote rather than
// against prose written to satisfy them.
const PR_3694_BODY = `Verified the six fixes against the backend contracts they depend on — \`prepare_globs\`/\`compile_path_glob\`, \`list_pages_with_metadata\` scoping, \`list_unfinished_tasks\` keyset pagination, and \`markVisible\`'s identity stability. No blocking correctness or security issues.

Non-blocking notes, none of which need to hold up the merge:

1. **Expanding \`UnfinishedTasks\` unmounts the panel into a skeleton.** \`draining\` is now gated on \`!collapsed\`, so collapsed→expanded flips \`loading\` true and the \`if (loading)\` early return replaces the whole section — including the disclosure button the user just activated, so focus drops to \`<body>\`.
2. **The \`N+\` badge's \`aria-label\` probably is not announced.** \`Badge\` renders a plain \`<span>\`, which does not support \`aria-label\`.
3. **\`PagesTreeSection\`: the cast is unnecessary** — \`{ spaceId, filters }\` already satisfies \`ListPagesWithMetadataFilter\`.
4. **\`descendantGlob\`'s "can only ever widen" invariant has two holes.**
5. **\`MAX_DESCENDANT_PAGES\` truncates silently.**
6. **Batch-trash Retry re-fires the captured id list and skips the confirm.** If the user changes the selection while the error toast is up, Retry trashes the old set with no second confirmation.
7. **Saved-view Undo reorders.**

Caveat: \`validate / vitest\` and the playwright shards were still pending at review time.`

const PR_3701_BODY = `Verified the substantive claims: the glob whitespace neutralisation is a strict widening, the removed cast is safe under contextual typing, and the \`loading && blocks.length === 0\` gate correctly keeps the disclosure button mounted across an expand-triggered drain. No blocking correctness or security issues; six non-blocking notes filed separately (the sr-only "expand to load the rest" copy is announced even when already expanded, the in-body skeleton lacks \`role=status\`, and batch-trash Retry is a silent no-op once the selection is cleared). Note vitest/playwright were still pending at review time.`

// #3639's real shape: a long "**Verified independently:**" bullet list, then
// three numbered findings. Counting the whole body says eleven.
const PR_3639_BODY = `Approving: the test change is correct and well-verified.

**Verified independently:**
- \`heal_orphaned_apply_cursor\` takes the early return with the seeded row, so Step 1.4 does not rewind.
- \`replay_unmaterialized_ops\` returns \`ReplayReport::default()\` on \`total == 0\`.
- The global \`MAX(seq)\` bind lines up with the heal's \`WHERE is_replicated = 0\` filter.
- \`materializer_apply_cursor\` id=1 exists, so the \`UPDATE\` cannot be a silent 0-row no-op.
- Offline build is safe: the query is already in \`src-tauri/.sqlx\`.
- \`nextest.toml\`: removing the filter term is the only semantic change.
- No coverage lost by no longer replaying 10K ops at boot.
- The guarded property is untouched.

**Non-blocking, please address in a follow-up:**

1. **\`docs/session-log/2026-sessions-401-800.md\` is explicitly off-limits.** Suggest reverting that file.
2. \`insert_elapsed\` now also spans the two materialization-marking statements. Cosmetic.
3. The \`max_seq\` \`query_scalar!\` runs before the sanity assert, so a zero-row seed panics with a decode error.

No security concerns.`

const CLEAN_BODY = `Read the whole diff against the store contracts it touches. The migration is additive, the new index matches the query's leading columns, and every new branch has a test. No blocking correctness or security issues, and nothing worth noting otherwise.`

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  const review = (body, state = 'APPROVED') => ({
    user: { login: 'agaric-reviewer[bot]', type: 'Bot' },
    state,
    body,
  })

  // 1. THE #3694 CASE. Seven observations, two of them correctness defects,
  //    on a review that APPROVED and whose check went green. This is the
  //    assertion the whole file exists for.
  {
    const r = summarize({ reviews: [review(PR_3694_BODY)], headSha: 'abc' })
    expect(
      "the #3694 review's seven observations produce a neutral check, not success",
      r.conclusion === 'neutral' && r.findings === 7,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
    expect(
      'the count is in the check title, so the rollup shows it without opening the PR',
      /7 finding\(s\)/.test(r.title),
      r.title,
    )
  }

  // 2. THE #3701 CASE, which is worse: the review ASSERTS the findings were
  //    routed somewhere durable, names half of them, and files nothing. The
  //    claim is the sentence a merger relies on, and it is unfalsifiable at
  //    the moment of decision.
  {
    const r = summarize({ reviews: [review(PR_3701_BODY)], headSha: 'abc' })
    expect(
      'a "six notes filed separately" review with no issue cited is neutral',
      r.conclusion === 'neutral' && r.findings === 6,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
    expect(
      'the uncited filing claim is called out by name',
      r.details.unbacked && /filed separately/.test(r.title),
      `${r.title} / ${JSON.stringify(r.details)}`,
    )
    expect(
      'the shortfall between claimed and enumerated is reported',
      r.details.shortfall === 6 && /claims more findings than it names/.test(r.summary),
      JSON.stringify(r.details),
    )
  }

  // 2b. …and the same claim WITH issue numbers is backed, so the rule pushes
  //     toward citing rather than toward silence.
  {
    const backed = PR_3701_BODY.replace('filed separately', 'filed separately as #3703 and #3704')
    const r = summarize({ reviews: [review(backed)], headSha: 'abc' })
    expect(
      'a filing claim that cites its issues is not flagged as unbacked',
      !r.details.unbacked && r.conclusion === 'neutral',
      JSON.stringify(r.details),
    )
  }

  // 3. THE SIBLING ACCEPTANCE. A genuinely clean review must still go green,
  //    or the check is a constant and carries no information at all — which
  //    is the same defect wearing the opposite colour.
  {
    const r = summarize({ reviews: [review(CLEAN_BODY)], headSha: 'abc' })
    expect(
      'a review with no findings still reports success',
      r.conclusion === 'success' && r.findings === 0,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings, title: r.title }),
    )
  }

  // 4. NO REVIEW ≠ CLEAN REVIEW. If this ever returned success, the check
  //    would be green on a PR the reviewer never looked at.
  {
    const r = summarize({ reviews: [], comments: [], headSha: 'abc' })
    expect(
      'a PR with no review at all is neutral, never success',
      r.conclusion === 'neutral' && /No review found/.test(r.title),
      JSON.stringify(r),
    )
    const humanOnly = summarize({
      reviews: [{ user: { login: 'jfolcini', type: 'User' }, state: 'APPROVED', body: 'lgtm' }],
      headSha: 'abc',
    })
    expect(
      "a human's approval is not mistaken for the bot's review",
      humanOnly.conclusion === 'neutral' && /No review found/.test(humanOnly.title),
      JSON.stringify(humanOnly),
    )
  }

  // 5. Only the LATEST bot review counts: the ruleset dismisses stale reviews
  //    on push, so an older review's findings may already be fixed. Counting
  //    them would keep the check yellow forever and train the reader to
  //    ignore it.
  {
    const r = summarize({
      reviews: [review(PR_3694_BODY), review(CLEAN_BODY)],
      headSha: 'abc',
    })
    expect(
      'the latest bot review supersedes the earlier one',
      r.conclusion === 'success',
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 6. Findings posted as a separate BOT COMMENT (the code-review plugin's
  //    own output path) count too — that is where #3702 says they live.
  {
    const r = summarize({
      reviews: [review(CLEAN_BODY)],
      comments: [{ user: { login: 'agaric-reviewer[bot]', type: 'Bot' }, body: PR_3694_BODY }],
      headSha: 'abc',
    })
    expect(
      'findings in a bot comment are counted, not just those in the review body',
      r.conclusion === 'neutral' && r.findings === 7,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 6b. A review that also enumerates what it VERIFIED must not have those
  //     counted as findings. Eleven-when-it-is-three is not a lie the reader
  //     can act on, and a check that cries wolf gets ignored — which is the
  //     same end state as the green one this replaces.
  {
    const r = summarize({ reviews: [review(PR_3639_BODY)], headSha: 'abc' })
    expect(
      'verification bullets above the findings header are not counted as findings',
      r.conclusion === 'neutral' && r.findings === 3,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 7. A fenced code block is not a finding list. Without this, any review
  //    quoting a diff or a shell transcript is permanently yellow, which is
  //    how a signal gets ignored.
  {
    const withFence = `Looks good.\n\n\`\`\`diff\n- old line\n+ new line\n- another\n\`\`\`\n\nNothing further.`
    const r = summarize({ reviews: [review(withFence)], headSha: 'abc' })
    expect(
      'diff lines inside a fenced block are not counted as findings',
      r.conclusion === 'success' && r.findings === 0,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 8. The payload is what the API is actually POSTed. A wrong `conclusion`
  //    or a missing `head_sha` would silently leave the check uncreated and
  //    restore the original green-by-omission state.
  {
    const p = checkPayload(summarize({ reviews: [review(PR_3694_BODY)], headSha: 'deadbeef' }))
    expect(
      'the check payload carries the name, head sha, neutral conclusion and title',
      p.name === CHECK_NAME &&
        p.head_sha === 'deadbeef' &&
        p.status === 'completed' &&
        p.conclusion === 'neutral' &&
        /7 finding\(s\)/.test(p.output.title) &&
        p.output.title.length <= 255,
      JSON.stringify(p),
    )
  }

  // 9. Counting rules, at unit level, on the shapes a reviewer actually uses.
  {
    expect(
      'both `1.` and `- ` enumerations are recognised, sub-bullets are not',
      enumeratedItems('1. one\n2. two\n   - a sub point\n- three').length === 3,
      JSON.stringify(enumeratedItems('1. one\n2. two\n   - a sub point\n- three')),
    )
    expect(
      'word and digit cardinals are both read as claims',
      claimedCount('six non-blocking notes follow') === 6 &&
        claimedCount('7 observations') === 7 &&
        claimedCount('no issues here') === null,
      `${claimedCount('six non-blocking notes follow')} / ${claimedCount('7 observations')}`,
    )
    expect(
      'the largest claim wins when a body states several',
      claimedCount('two minor notes, and three further observations') === 3,
      String(claimedCount('two minor notes, and three further observations')),
    )
  }

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
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
