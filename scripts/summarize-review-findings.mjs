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
//     --head-sha <sha> [--check-payload payload.json] [--summary-file out.md] \
//     [--reviewer-login <app-slug>]
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
// in a follow-up:**". Trailing `**` allowed because the header is usually
// bold. Since #3728 this is consulted only to OVERRIDE the verification rule
// below, for the header that names both ("Verified, with three notes:").
const FINDINGS_HEADER_RE =
  /^[^\n]*\b(?:non-?blocking|findings?|observations?|notes?|nits?|concerns?|suggestions?|follow-?ups?)\b[^\n]*:\**\s*$/im

// The header above the bullets that say what the reviewer CHECKED rather than
// what it found. #3639's review listed eight verifications and three findings;
// counting all eleven is a false yellow, and a check that cries wolf gets
// ignored just as reliably as an always-green one.
const VERIFICATION_HEADER_RE = /\b(?:verified|verification|confirmed|checked|validated|sanity)\b/i

/** A line that opens a section: prose ending in a colon, optionally bolded. */
const SECTION_HEADER_RE = /:\**\s*$/

/** A top-level enumeration marker, at column 0. */
const LIST_ITEM_RE = /^(?:\d{1,2}[.)]|[-*+])\s+\S/

/**
 * Top-level list items — the shape the reviewer enumerates findings in.
 * Indented continuation lines are NOT items (a sub-bullet of one finding is
 * not a second finding).
 *
 * ─── #3728: why this is a DENYLIST rather than a scope ────────────────────
 *
 * This used to slice the body from the FIRST line matching
 * `FINDINGS_HEADER_RE` and count only what followed. Everything enumerated
 * ABOVE that line was dropped, and `issues` is not in that keyword
 * alternation, so the entirely ordinary shape
 *
 *     Blocking issues:
 *     1. …
 *     2. …
 *
 *     Non-blocking notes:
 *     (nothing further)
 *
 * scoped past the blocking list, counted the empty one, and reported
 * **0 findings → `success`** on a review that named two blocking defects.
 * "Found nothing" rendering identically to "did not look there" is the exact
 * conflation this file exists to remove — it cannot be committed by the
 * counter itself.
 *
 * `max(header-scoped, whole-body)` fixes the degenerate case and re-breaks
 * #3639 (eleven again); scoping from the LAST header does not help at all
 * here, because `Blocking issues:` never matched in the first place.
 *
 * So the rule is inverted: count every top-level item EXCEPT those under a
 * header that says they are verifications. The suppression lasts only to the
 * end of that section — any later unindented, non-list line ends it — so a
 * findings list further down is counted whether or not its own header matches
 * a keyword. An unrecognised section header counts, which is the safe
 * direction: an over-count costs a `neutral` whose whole meaning is "go read
 * the review", an under-count costs a green check on a real defect.
 */
export function enumeratedItems(body) {
  const items = []
  let inVerificationSection = false
  for (const line of stripFences(body).split('\n')) {
    if (LIST_ITEM_RE.test(line)) {
      if (!inVerificationSection) items.push(line)
      continue
    }
    // Blank lines and indented continuations belong to whatever section is in
    // force; they neither open a section nor close one.
    if (line.trim().length === 0 || /^\s+\S/.test(line)) continue
    inVerificationSection =
      SECTION_HEADER_RE.test(line) &&
      VERIFICATION_HEADER_RE.test(line) &&
      !FINDINGS_HEADER_RE.test(line)
  }
  return items
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
 * The sentence (or clause, or line) that makes the filing claim, or null.
 *
 * #3728: the backing test used to be "does the body contain `#NNNN`
 * ANYWHERE", which any incidental reference defeats —
 *
 *     …six non-blocking notes filed separately. Verified against the
 *     contract added in #3350.
 *
 * is the #3701 shape exactly, and read as backed. #3723 made this worse by
 * instructing the reviewer to cite issue numbers, so bodies now routinely
 * carry refs for unrelated reasons. The reference has to be attached to the
 * claim to back it.
 *
 * @param {string} text already fence-stripped
 */
export function filingSentence(text) {
  return text.split(/(?<=[.!?;])\s+|\n/).find((s) => FILING_RE.test(s)) ?? null
}

/**
 * Analyse one review/comment body.
 *
 * @param {string} body
 */
export function analyzeBody(body) {
  const text = body ?? ''
  const stripped = stripFences(text)
  const enumerated = enumeratedItems(text).length
  const claimed = claimedCount(text)
  const citedIssues = [...new Set([...text.matchAll(ISSUE_REF_RE)].map((m) => `#${m[1]}`))]
  const claimsFiling = FILING_RE.test(stripped)
  const sentence = claimsFiling ? filingSentence(stripped) : null
  const refsWithClaim = sentence === null ? [] : [...sentence.matchAll(ISSUE_REF_RE)]
  // The claim is only backed if the body says WHERE, in the clause that makes
  // the claim — or cites at least as many distinct issues as it claims
  // findings, which is the other shape that leaves nothing unrecoverable.
  const backed =
    refsWithClaim.length > 0 || (claimed !== null && claimed > 0 && citedIssues.length >= claimed)
  return {
    enumerated,
    claimed,
    citedIssues,
    claimsFiling,
    unbackedFilingClaim: claimsFiling && !backed,
    shortfall: claimed !== null && enumerated < claimed ? claimed - enumerated : 0,
  }
}

/** A bot-authored review/comment; `[bot]` is how GitHub suffixes App logins. */
function isBotAuthor(entry) {
  const login = entry?.user?.login ?? ''
  return entry?.user?.type === 'Bot' || login.endsWith('[bot]')
}

/**
 * An author predicate for THE REVIEWER, not for bots in general.
 *
 * #3728: "any bot" is too wide on the comment path. This repo's own
 * `mutation-pr.yml` posts a sticky `github-actions[bot]` comment on every PR
 * touching `src/**` — the same PRs this check runs on — and that comment was
 * being read as review findings. It does not flip the verdict today only by
 * coincidence: the comment's body is a table, a fenced block and prose, with
 * no top-level list item and no matching cardinal. One `- ` bullet added to
 * that template (a survivor summary, a caveat list) turns every
 * mutation-touching PR's review check yellow for a reason invisible from the
 * check output — a false finding count is the same defect as a missing one.
 *
 * Falls back to "any bot" when no reviewer identity is available, which is the
 * pre-#3728 behaviour and still the loud direction.
 *
 * @param {string} login the reviewer's login, with or without the `[bot]` suffix
 */
export function authoredByReviewer(login) {
  const want = (login ?? '').trim().toLowerCase()
  if (want.length === 0) return isBotAuthor
  const bare = want.endsWith('[bot]') ? want.slice(0, -'[bot]'.length) : want
  return (entry) => {
    const actual = (entry?.user?.login ?? '').toLowerCase()
    return actual === bare || actual === `${bare}[bot]`
  }
}

/**
 * The bot reviews OF ONE COMMIT.
 *
 * The commit is the whole point. `GET /pulls/{n}/reviews` returns every review
 * the PR ever received, across every push, and a review dismissed by
 * `dismiss_stale_reviews_on_push` stays in that list. So "the last bot review"
 * is the review of THIS push only when the reviewer actually produced one for
 * this push. When it does not — a model error, a denied tool, a cancelled run,
 * a fork PR — the previous push's review is attributed to the new head, and if
 * that older review was clean the check reports SUCCESS on a commit nobody
 * reviewed.
 *
 * That is precisely the conflation this file exists to remove ("did not run"
 * rendering identically to "found nothing"), reintroduced one level up. So the
 * filter is on `commit_id`, never on recency. A review with no `commit_id`, or
 * a run with no `headSha` to compare against, matches nothing and therefore
 * reports `neutral`: unattributable evidence is not evidence.
 *
 * @param {object[]} reviews
 * @param {string} headSha
 * @param {(entry: object) => boolean} isAuthor
 */
export function reviewsForCommit(reviews, headSha, isAuthor = isBotAuthor) {
  if (typeof headSha !== 'string' || headSha.length === 0) return []
  return reviews.filter(
    (r) => isAuthor(r) && r.commit_id === headSha && (r.body ?? '').trim().length > 0,
  )
}

/**
 * The bot comments that belong to THIS push.
 *
 * Issue comments carry no commit id — GitHub does not stamp one — so the only
 * available key is time. A comment written after the PREVIOUS review was
 * submitted was written for this push; anything older described code that has
 * since been replaced.
 *
 * Without this, a 7-finding comment from push 1 holds the count at 7 forever:
 * the check stays neutral on every later push, including the one that fixed all
 * seven. A check that cannot go back to green is a check that gets ignored,
 * which is the same end state as the always-green one it replaces — the
 * argument this file already makes for reviews, left open on the comment path.
 *
 * The anchor is the PREVIOUS review, not the current one, because the
 * code-review plugin posts its comment before casting its verdict, so this
 * push's comment predates this push's review by seconds.
 *
 * @param {object[]} comments
 * @param {object[]} reviews every reviewer review, any commit
 * @param {object|null} review the review of the head commit
 * @param {(entry: object) => boolean} isAuthor
 */
export function commentsForPush(comments, reviews, review, isAuthor = isBotAuthor) {
  const bots = comments.filter((c) => isAuthor(c) && (c.body ?? '').trim().length > 0)
  const at = (x) => Date.parse(x?.submitted_at ?? x?.created_at ?? '')
  const current = at(review)
  if (!Number.isFinite(current)) return bots
  const anchor = reviews
    .filter(isAuthor)
    .map(at)
    .filter((t) => Number.isFinite(t) && t < current)
    .toSorted((a, b) => a - b)
    .at(-1)
  if (anchor === undefined) return bots
  return bots.filter((c) => {
    const t = at(c)
    // An undated comment cannot be excluded on evidence, and the loud direction
    // is to keep it: a spurious `neutral` costs a read, a dropped finding costs
    // the thing this check exists for.
    return !Number.isFinite(t) || t > anchor
  })
}

/**
 * The prose body of the check output, below the heading.
 *
 * @param {{state: string, findings: number, parts: object[], perBody: number[], shortfall: number, unbacked: boolean}} v
 */
function renderVerdict({ state, findings, parts, perBody, shortfall, unbacked }) {
  const lines = []
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
  // Where the count came from, whenever more than one body contributed. The
  // total is a sum, so a reader who sees a number larger than the review body
  // alone can tell whether the comment added findings or restated them.
  if (parts.length > 1 && findings > 0) {
    const [inReview, ...inComments] = perBody
    lines.push(
      '',
      `> Counted across **${parts.length} bodies**: ${inReview} in the review itself, ${inComments.reduce((n, c) => n + c, 0)} across ${inComments.length} reviewer comment(s). These are summed — a comment that restates the review inflates the total, and that is the deliberate direction (#3728).`,
    )
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
  return lines
}

/**
 * The whole verdict, from the raw API payloads.
 *
 * @param {{reviews?: object[], comments?: object[], headSha?: string, reviewerLogin?: string}} opts
 */
export function summarize({ reviews = [], comments = [], headSha = '', reviewerLogin = '' }) {
  // The reviewer re-reviews on every push, so the review that describes the
  // code being merged is the one submitted AGAINST THIS COMMIT — not merely the
  // most recent one on the PR. See `reviewsForCommit`.
  const configured = authoredByReviewer(reviewerLogin)
  const forCommit = reviewsForCommit(reviews, headSha, configured)
  const review = forCommit.at(-1) ?? null
  // #3728: scope the COMMENT path to the reviewer, not to bots at large. When
  // no login is configured the reviewer identifies itself — it is the author of
  // the review of this commit — so the narrowing needs no configuration to
  // work, and only falls back to "any bot" when there is no review to learn
  // from (in which case nothing is counted anyway).
  const isReviewer = authoredByReviewer(reviewerLogin || (review?.user?.login ?? ''))
  const botComments = commentsForPush(comments, reviews.filter(isReviewer), review, isReviewer)

  if (review === null) {
    // NOT success, and NOT a count taken from whatever else is lying around on
    // the PR. "The reviewer never posted for this commit" and "the reviewer
    // found nothing" are different facts and must not render identically —
    // that equivalence is #3702 itself, one level up.
    const stale = reviews.filter(configured).length > 0
    // Bot comments carry no commit id, and with no review of this commit there
    // is no anchor to date them against — so they are NOT counted here. Said
    // out loud rather than dropped: an uncounted comment that the reader is
    // told about is a pointer, an uncounted comment they are not told about is
    // this issue again.
    const orphanComments = comments.filter(isReviewer).length
    return {
      conclusion: 'neutral',
      findings: 0,
      title: stale
        ? 'No review of this commit — the newest review is of an earlier push'
        : 'No review found — the reviewer posted nothing on this commit',
      summary: [
        `### ${CHECK_NAME}`,
        '',
        stale
          ? `No review submitted against \`${headSha.slice(0, 8)}\` was found. The reviews on this pull request belong to earlier pushes and describe code that has since changed, so none of them can vouch for this commit.`
          : 'No review body from the reviewer app was found on this pull request.',
        '',
        'This is reported as **neutral**, not success: a review that did not run',
        'and a review that found nothing are different facts, and a green check',
        'would make them indistinguishable (#3702).',
        ...(orphanComments > 0
          ? [
              '',
              `> ${orphanComments} bot comment(s) exist on this pull request but carry no commit id, and with no review of this commit there is nothing to date them against — they are **not** counted above. Read them before merging.`,
            ]
          : []),
      ].join('\n'),
      headSha,
      details: null,
    }
  }

  const bodies = [review?.body ?? '', ...botComments.map((c) => c.body)].filter(
    (b) => b.trim().length > 0,
  )
  const parts = bodies.map(analyzeBody)
  const perBody = parts.map((p) => Math.max(p.enumerated, p.claimed ?? 0))
  // #3728: SUM across bodies, not `Math.max`. The review body and the
  // reviewer's separate comment carry DIFFERENT findings — that is why both
  // are read — so 2 in one plus 5 in the other is not 5. The max under-stated
  // the count in the check title, which is the one place a merger reads it
  // without opening the PR. Summing can double-count when the comment restates
  // the review, and that is the direction this file has always taken: the
  // breakdown is printed below so the reader can tell the two apart.
  const findings = perBody.reduce((n, c) => n + c, 0)
  const unbacked = parts.some((p) => p.unbackedFilingClaim)
  const shortfall = Math.max(...parts.map((p) => p.shortfall))
  const state = review?.state ?? 'COMMENTED'

  const lines = [
    `### ${CHECK_NAME}`,
    '',
    ...renderVerdict({ state, findings, parts, perBody, shortfall, unbacked }),
  ]

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
    reviewerLogin: '',
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
      case '--reviewer-login': {
        args.reviewerLogin = take()
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

/**
 * What to publish when the analysis itself blew up.
 *
 * NOT nothing, and not `success`. An unhandled throw used to leave the payload
 * file unwritten, so the `gh api --input` that follows failed and NO check run
 * was created at all — green by omission, with nothing on the PR marking that
 * the signal was supposed to be there. That is the same defect as the one this
 * script exists to fix, wearing "the tooling broke" instead of "the review was
 * clean".
 *
 * @param {string} headSha
 * @param {unknown} err
 */
export function failureResult(headSha, err) {
  const message = err instanceof Error ? err.message : String(err)
  return {
    conclusion: 'neutral',
    findings: 0,
    title: 'Findings summariser failed — the review was NOT checked',
    summary: [
      `### ${CHECK_NAME}`,
      '',
      'This check could not be computed: the summariser threw before it could read',
      'the review.',
      '',
      '```',
      message.slice(0, 2000),
      '```',
      '',
      '**Read the review manually before merging.** This is reported as `neutral`',
      'rather than omitted, because a missing check is indistinguishable from a',
      'passing one in the rollup — which is the failure #3702 is about.',
    ].join('\n'),
    headSha,
    details: null,
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

  // Every path below this point must still produce a payload. The caller
  // POSTs `--check-payload` unconditionally; a throw that skipped writing it
  // published no check at all.
  let result
  try {
    result = summarize({
      reviews: readList(args.reviews),
      comments: readList(args.comments),
      headSha: args.headSha,
      reviewerLogin: args.reviewerLogin,
    })
  } catch (err) {
    console.error(`summarize-review-findings: ${err instanceof Error ? err.stack : err}`)
    result = failureResult(args.headSha, err)
  }
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

// #3728's shape. `Blocking issues:` does NOT match `FINDINGS_HEADER_RE`
// (`issues` is not in the alternation), so the old first-header scope started
// at `Non-blocking notes:` — below every item — and counted the empty tail.
// Two blocking defects, reported as 0 findings and `success`.
const ITEMS_ABOVE_HEADER_BODY = `Reviewed the whole diff.

Blocking issues:

1. **The retry path re-fires the captured id list.** It trashes a stale set.
2. **The cursor rewinds on an empty replay.** Data loss on restart.

Non-blocking notes:

Nothing further.`

// The same defect without the empty tail: the blocking list above the header
// vanished from the count while the notes below it were reported, so the check
// under-stated by exactly the items that mattered most.
const BLOCKING_AND_NOTES_BODY = `Blocking issues:

1. **The retry path re-fires the captured id list.**
2. **The cursor rewinds on an empty replay.**

Non-blocking notes:

- The cast is unnecessary.`

// The mutation lane's own sticky comment (#3350), authored by
// `github-actions[bot]` on every PR touching \`src/**\` — including the PRs
// this check runs on. It is not a review finding and must not be counted.
const MUTATION_COMMENT_BODY = `## Mutation testing — diff-scoped (#3350)

_Informational. This lane never gates a merge._

Mutated 1 module: \`blockTree\`.

- 3 mutants survived, listed in the run summary.
- 2 files in this diff belong to no enrolled module.

<!-- mutation-pr-report -->`

const CLEAN_BODY = `Read the whole diff against the store contracts it touches. The migration is additive, the new index matches the query's leading columns, and every new branch has a test. No blocking correctness or security issues, and nothing worth noting otherwise.`

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }
  const expect = (name, cond, detail) => (cond ? ok(name) : fail(name, detail))

  // Every fixture review carries a `commit_id` and a `submitted_at`, because
  // both are load-bearing: the first decides whether the review describes the
  // commit under test at all, the second dates the comments against it. A
  // fixture without them would pass while the live payload (which always has
  // them) took a different path.
  const HEAD = 'abc'
  const review = (body, state = 'APPROVED', commit = HEAD, submitted = '2026-08-09T12:00:00Z') => ({
    user: { login: 'agaric-reviewer[bot]', type: 'Bot' },
    state,
    body,
    commit_id: commit,
    submitted_at: submitted,
  })
  const comment = (body, created = '2026-08-09T12:00:00Z') => ({
    user: { login: 'agaric-reviewer[bot]', type: 'Bot' },
    body,
    created_at: created,
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
      reviews: [
        {
          user: { login: 'jfolcini', type: 'User' },
          state: 'APPROVED',
          body: 'lgtm',
          commit_id: 'abc',
        },
      ],
      headSha: 'abc',
    })
    expect(
      "a human's approval is not mistaken for the bot's review",
      humanOnly.conclusion === 'neutral' && /No review found/.test(humanOnly.title),
      JSON.stringify(humanOnly),
    )
  }

  // 4b. THE SAME CONFLATION ONE LEVEL UP (found reviewing this PR). A review
  //     exists, but it is a PREVIOUS push's — the reviewer produced nothing for
  //     this head, so `.at(-1)` handed a clean older review to a commit nobody
  //     looked at and the check went GREEN. Attribution is by `commit_id`, not
  //     by recency, and a head with no review of its own is neutral.
  {
    const older = review(CLEAN_BODY, 'APPROVED', 'push1', '2026-08-09T10:00:00Z')
    const r = summarize({ reviews: [older], comments: [], headSha: 'push2' })
    expect(
      'a clean review of an EARLIER push does not go green on this commit',
      r.conclusion === 'neutral' && /No review of this commit/.test(r.title),
      JSON.stringify({ conclusion: r.conclusion, title: r.title }),
    )
    // …and the findings of an earlier push are not attributed to this one
    // either: the count would be a fact about code that no longer exists.
    const noisyOlder = review(PR_3694_BODY, 'APPROVED', 'push1', '2026-08-09T10:00:00Z')
    const r2 = summarize({ reviews: [noisyOlder], comments: [], headSha: 'push2' })
    expect(
      'the findings of an earlier push are not attributed to this commit',
      r2.conclusion === 'neutral' && r2.findings === 0,
      JSON.stringify({ conclusion: r2.conclusion, findings: r2.findings, title: r2.title }),
    )
    // A dismissed review stays in the API payload; the commit filter is what
    // keeps it out, so the rule holds without a state allowlist.
    const dismissed = review(CLEAN_BODY, 'DISMISSED', 'push1', '2026-08-09T10:00:00Z')
    expect(
      'a DISMISSED review of an earlier push cannot vouch for this commit',
      summarize({ reviews: [dismissed], headSha: 'push2' }).conclusion === 'neutral',
      'a dismissed review went green',
    )
    // Missing head sha = nothing to attribute against. Green here would mean
    // "the workflow forgot to pass the sha" renders as "the code is fine".
    expect(
      'an empty head sha attributes nothing and reports neutral',
      summarize({ reviews: [review(CLEAN_BODY)], headSha: '' }).conclusion === 'neutral',
      'an unattributable run went green',
    )
    // Uncounted comments are named rather than dropped.
    const withOrphan = summarize({
      reviews: [older],
      comments: [comment(PR_3694_BODY)],
      headSha: 'push2',
    })
    expect(
      'bot comments that cannot be dated to this commit are reported, not silently dropped',
      withOrphan.conclusion === 'neutral' && /not\*\* counted/.test(withOrphan.summary),
      withOrphan.summary,
    )
  }

  // 5. A re-review of the SAME commit supersedes the earlier attempt: the
  //    reviewer can post twice for one head (a retried run), and the later
  //    verdict is the one that describes it.
  {
    const r = summarize({
      reviews: [
        review(PR_3694_BODY, 'APPROVED', HEAD, '2026-08-09T11:00:00Z'),
        review(CLEAN_BODY, 'APPROVED', HEAD, '2026-08-09T12:00:00Z'),
      ],
      headSha: HEAD,
    })
    expect(
      'the latest review OF THIS COMMIT supersedes an earlier one of the same commit',
      r.conclusion === 'success',
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 6. Findings posted as a separate BOT COMMENT (the code-review plugin's
  //    own output path) count too — that is where #3702 says they live.
  {
    const r = summarize({
      reviews: [review(CLEAN_BODY)],
      comments: [comment(PR_3694_BODY, '2026-08-09T11:59:00Z')],
      headSha: HEAD,
    })
    expect(
      'findings in a bot comment are counted, not just those in the review body',
      r.conclusion === 'neutral' && r.findings === 7,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings }),
    )
  }

  // 6a. …but only this push's comment (found reviewing this PR). Reviews were
  //     narrowed and comments were not, so a 7-finding comment from push 1 held
  //     the count at 7 for the whole life of the PR — the check could never go
  //     back to green, including on the push that fixed all seven. A check that
  //     cries wolf gets ignored, which is where the always-green one already
  //     was.
  {
    const push1 = review(PR_3694_BODY, 'CHANGES_REQUESTED', 'push1', '2026-08-09T10:00:00Z')
    const push1Comment = comment(PR_3694_BODY, '2026-08-09T09:59:00Z')
    const push2 = review(CLEAN_BODY, 'APPROVED', 'push2', '2026-08-09T12:00:00Z')
    const r = summarize({ reviews: [push1, push2], comments: [push1Comment], headSha: 'push2' })
    expect(
      "an earlier push's findings comment does not hold this push's check yellow",
      r.conclusion === 'success' && r.findings === 0,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings, title: r.title }),
    )
    // The sibling acceptance: a comment written FOR this push still counts, so
    // the rule is "date it", not "ignore comments".
    const fresh = comment(PR_3694_BODY, '2026-08-09T11:58:00Z')
    const r2 = summarize({
      reviews: [push1, push2],
      comments: [push1Comment, fresh],
      headSha: 'push2',
    })
    expect(
      "this push's own findings comment is still counted",
      r2.conclusion === 'neutral' && r2.findings === 7,
      JSON.stringify({ conclusion: r2.conclusion, findings: r2.findings }),
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

  // 6c. THE DEGENERATE CASE (#3728). Items enumerated ABOVE the first matching
  //     header used to be sliced off entirely, and with an empty section below
  //     the count reached 0 — so a review naming two BLOCKING defects reported
  //     `success`. "Found nothing" is not "did not look there", and that is the
  //     one equivalence this whole file exists to refuse.
  {
    const r = summarize({ reviews: [review(ITEMS_ABOVE_HEADER_BODY)], headSha: 'abc' })
    expect(
      'a blocking list ABOVE the notes header, with an empty section below, is NOT success',
      r.conclusion === 'neutral' && r.findings === 2,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings, title: r.title }),
    )
    const both = summarize({ reviews: [review(BLOCKING_AND_NOTES_BODY)], headSha: 'abc' })
    expect(
      'both the blocking list and the notes list are counted, not just the second one',
      both.findings === 3,
      JSON.stringify({ findings: both.findings }),
    )
    // The sibling acceptance, restated at unit level so the two rules cannot
    // drift apart: suppressing verification bullets must survive the rewrite.
    expect(
      'the #3639 verification/findings split is unchanged by the denylist rule',
      enumeratedItems(PR_3639_BODY).length === 3,
      JSON.stringify(enumeratedItems(PR_3639_BODY)),
    )
    // A header naming BOTH resolves to "findings", so a reviewer cannot lose a
    // list by putting the word "verified" in the header above it.
    expect(
      'a header that says both "verified" and "notes" counts its items',
      enumeratedItems('Verified, with two notes:\n- a\n- b').length === 2,
      JSON.stringify(enumeratedItems('Verified, with two notes:\n- a\n- b')),
    )
    // Suppression ends with the section, so an unheaded list after a
    // verification block is still counted.
    expect(
      'a list after the verification section ends is counted again',
      enumeratedItems('**Verified:**\n- x\n\nStill worth flagging.\n\n- a real one').length === 1,
      JSON.stringify(
        enumeratedItems('**Verified:**\n- x\n\nStill worth flagging.\n\n- a real one'),
      ),
    )
  }

  // 6d. THE COMMENT AUTHOR (#3728). `github-actions[bot]` posts this repo's own
  //     mutation comment on every PR touching `src/**` — the same PRs this
  //     check runs on. Counting it as a review finding attributes another
  //     lane's output to the reviewer, and the count would be wrong for a
  //     reason invisible from the check output.
  {
    const other = {
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `${MUTATION_COMMENT_BODY}\n- one more survivor worth a look`,
      created_at: '2026-08-09T11:59:00Z',
    }
    const r = summarize({ reviews: [review(CLEAN_BODY)], comments: [other], headSha: HEAD })
    expect(
      "another lane's bot comment is not counted as a review finding",
      r.conclusion === 'success' && r.findings === 0,
      JSON.stringify({ conclusion: r.conclusion, findings: r.findings, title: r.title }),
    )
    // The sibling acceptance: the REVIEWER's own comment still counts, so the
    // narrowing is "identify the reviewer", not "stop reading comments".
    const mine = summarize({
      reviews: [review(CLEAN_BODY)],
      comments: [comment(PR_3694_BODY, '2026-08-09T11:59:00Z'), other],
      headSha: HEAD,
    })
    expect(
      "the reviewer's own comment is still counted alongside another bot's",
      mine.conclusion === 'neutral' && mine.findings === 7,
      JSON.stringify({ conclusion: mine.conclusion, findings: mine.findings }),
    )
    // An explicitly configured login wins over the inferred one, and a review
    // by anyone else is then not the reviewer's review at all.
    expect(
      'an explicit --reviewer-login that matches nothing reports neutral, not success',
      summarize({ reviews: [review(CLEAN_BODY)], headSha: HEAD, reviewerLogin: 'someone-else' })
        .conclusion === 'neutral',
      'a review by another identity was accepted as the reviewer',
    )
    expect(
      'an explicit --reviewer-login matches with or without the [bot] suffix',
      summarize({ reviews: [review(CLEAN_BODY)], headSha: HEAD, reviewerLogin: 'agaric-reviewer' })
        .conclusion === 'success',
      'the bare app slug did not match its [bot] login',
    )
  }

  // 6e. TWO BODIES, DIFFERENT FINDINGS (#3728). `Math.max` reported the larger
  //     of the two, so 2 in the review plus 5 in the comment read as 5 — the
  //     count in the title is the one number a merger reads without opening
  //     the PR, and it understated by the whole review body.
  {
    const twoInReview = review('Two things:\n\n- first\n- second', 'APPROVED', HEAD)
    const fiveInComment = comment('Notes:\n\n- a\n- b\n- c\n- d\n- e', '2026-08-09T11:59:00Z')
    const r = summarize({ reviews: [twoInReview], comments: [fiveInComment], headSha: HEAD })
    expect(
      'findings across the review and its comment are summed, not maxed',
      r.findings === 7,
      JSON.stringify({ findings: r.findings, title: r.title }),
    )
    expect(
      'the summary says where the total came from, so a restated comment is legible',
      /Counted across \*\*2 bodies\*\*: 2 in the review itself, 5 across 1/.test(r.summary),
      r.summary,
    )
  }

  // 6f. THE FILING CLAIM'S BACKING (#3728). The claim used to be backed by ANY
  //     `#NNNN` anywhere in the body, which the #3723 prompt change actively
  //     encourages the reviewer to emit for unrelated reasons. The reference
  //     has to be attached to the claim.
  {
    const incidental = PR_3701_BODY.replace(
      'Note vitest/playwright were still pending at review time.',
      'Verified against the contract added in #3350.',
    )
    const r = summarize({ reviews: [review(incidental)], headSha: 'abc' })
    expect(
      'an incidental issue reference elsewhere in the body does not back a filing claim',
      r.details.unbacked === true,
      JSON.stringify({ unbacked: r.details.unbacked, parts: r.details.parts }),
    )
    // …and citing as many issues as the claim names IS backing, even when the
    // numbers sit in a later sentence: nothing is unrecoverable then.
    const enumerated = `Two notes filed separately. They are #3801 and #3802.`
    expect(
      'as many distinct references as claimed findings backs the claim',
      analyzeBody(enumerated).unbackedFilingClaim === false,
      JSON.stringify(analyzeBody(enumerated)),
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
    const p = checkPayload(
      summarize({
        reviews: [review(PR_3694_BODY, 'APPROVED', 'deadbeef')],
        headSha: 'deadbeef',
      }),
    )
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

  // 8b. A THROW must still publish something. The step that calls this runs
  //     without `set -e` and with `continue-on-error`, so an unwritten payload
  //     meant the POST failed and NO check run was created — green by
  //     omission, which is this issue committed by its own fix.
  {
    const p = checkPayload(failureResult('deadbeef', new Error('boom')))
    expect(
      'a summariser failure still yields a neutral payload, never nothing and never success',
      p.conclusion === 'neutral' &&
        p.head_sha === 'deadbeef' &&
        /NOT checked/.test(p.output.title) &&
        /boom/.test(p.output.summary),
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
