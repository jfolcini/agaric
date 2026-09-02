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
//
// `--reviews` / `--comments` take the raw bodies of
// `GET /repos/{o}/{r}/pulls/{n}/reviews` and `GET …/issues/{n}/comments`.
//
// Output: the analysis as JSON on stdout; `conclusion=`, `title=` and
// `findings=` appended to `$GITHUB_OUTPUT` when set.
//
// Exit: 0 always when the arguments parse — this script must never be the
// thing that fails the review job. 2 for bad usage.

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
//
// `blocking|issues|problems|defects|bugs` added on #3736's review. The absence
// of `issues` is what caused the bug this file was just rewritten to fix, and
// while the denylist rule no longer depends on this alternation to COUNT, it
// still depends on it to override: without those words a header naming both a
// verification verb and a finding word — "Blocking issues I checked:",
// "Checked the retry path; the problems are:" — matches
// `VERIFICATION_HEADER_RE`, fails this override, and silently suppresses every
// item below it. Errs loud on purpose: a header this matches is COUNTED.
const FINDINGS_HEADER_RE =
  /^[^\n]*\b(?:non-?blocking|blocking|findings?|issues?|problems?|defects?|bugs?|observations?|notes?|nits?|concerns?|suggestions?|follow-?ups?)\b[^\n]*:\**\s*$/im

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
 * Distinct `#NNNN` references from the filing claim onward.
 *
 * The "as many refs as findings claimed" fallback has to read forward only.
 * A reference written BEFORE the claim was written for some other purpose —
 * citing a contract, naming a sibling PR — and cannot be where these findings
 * went. See `analyzeBody`.
 *
 * @param {string} text already fence-stripped
 */
export function issueRefsFromClaimOnward(text) {
  const m = FILING_RE.exec(text)
  if (m === null) return []
  const tail = text.slice(m.index)
  return [...new Set([...tail.matchAll(ISSUE_REF_RE)].map((x) => `#${x[1]}`))]
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
  //
  // #3736's review: that second arm counted references from ANYWHERE in the
  // body, which reopens a narrower version of the hole the first arm closes.
  // This repo's review bodies routinely cite six or more unrelated issues —
  // #3702, #3728, #3672, #3639, #3701 and #3694 all appear in this very PR's
  // text — so "six non-blocking notes filed separately" with nothing filed
  // would have been read as backed. Only references AT OR AFTER the filing
  // clause can back it: a number written before the claim was written for
  // something else.
  const refsAfterClaim = claimsFiling ? issueRefsFromClaimOnward(stripped) : []
  const backed =
    refsWithClaim.length > 0 ||
    (claimed !== null && claimed > 0 && refsAfterClaim.length >= claimed)
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
    // Quoted from the ONE body that is short, not as maxima across bodies
    // (#3736's review). `findings` above is a SUM, so a per-body `claimed` max
    // and a per-body `enumerated` max need not reconcile with it or with each
    // other, and the sentence would then cite a pair that appears in no single
    // review.
    const worst = parts.reduce((a, b) => (b.shortfall > a.shortfall ? b : a))
    lines.push(
      '',
      `> **The review claims more findings than it names** — one body claims ${worst.claimed} and enumerates ${worst.enumerated}, so ${worst.shortfall} of them exist nowhere a reader can get to. On #3701 exactly three of six were recoverable.`,
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

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is a
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run
// nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  main(process.argv.slice(2))
}
