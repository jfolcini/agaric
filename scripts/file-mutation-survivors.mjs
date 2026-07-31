#!/usr/bin/env node
// #2947 — push-based mutation-survivor triage loop.
//
// `scheduled-deep-checks.yml`'s `mutants` (cargo-mutants) and
// `mutants-frontend` (StrykerJS) lanes only ever surface survivors in that
// run's step summary — nobody is notified, so triage is pull-based (someone
// has to remember to open the summary). This script closes the loop: it
// reads both lanes' survivor output, diffs the combined set against the
// SINGLE open tracking issue's last-known set (encoded in a marked block in
// the issue body), and files/updates that one issue only when NEW survivors
// appear. Resolved survivors (previously listed, no longer present) are
// dropped from the tracked set whenever an update fires, but are never
// themselves a reason to touch the issue — a pure "some mutants got killed"
// week stays a no-op, same as a pure "nothing changed" week.
//
// State lives in the tracking issue itself (its body), not a committed
// baseline file — the workflow only needs `issues: write`, never
// `contents: write`, and there is nothing to keep in sync with a repo file.
//
// Usage (from the repo root or anywhere — paths are resolved as given):
//   node scripts/file-mutation-survivors.mjs \
//     --rust-missed <path to cargo-mutants missed.txt> \
//     --frontend-dir <dir to search recursively for Stryker mutation.json> \
//     [--require-rust]              (#3364: FAIL if missed.txt is absent)
//     [--require-frontend]          (#3364: FAIL if the frontend dir holds no
//                                    mutation.json at all)
//     [--repo owner/repo]           (default: $GITHUB_REPOSITORY)
//     [--run-url <url>]             (default: derived from $GITHUB_SERVER_URL
//                                    /$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)
//     [--dry-run]                   (compute + print; never call `gh`)
//     [--known-body-file <path>]    (TEST-ONLY: use this file's content as
//                                    the existing tracking issue's body
//                                    instead of calling `gh issue list`;
//                                    a missing/empty file means "no existing
//                                    issue". Lets the diff+file/update logic
//                                    be exercised without real GitHub state.)
//
// Both `--rust-missed` and `--frontend-dir` are optional: a missing rust
// file or an empty/missing frontend dir simply contributes zero survivors
// from that lane (a lane that crashed before writing output should not be
// misread as "zero survivors", but that failure is already visible via the
// lane's own job status / step summary — this script only tracks the
// survivor *content*, not lane health). #3330 note: that premise was true
// for the `mutants` (Rust) lane, which has a zero-coverage guard outside its
// `|| true`, but was FALSE for `mutants-frontend`, which had no such guard
// and could not go red at all. It now has one
// (`scripts/check-mutation-reports.mjs`, wired as the lane's
// `Lane-liveness guard` step), so the premise holds for both lanes again.
//
// #3364: visibility of a lane failure is NOT the same as integrity of this
// script's state. The lane going red does not stop this job — it runs under
// `if: always()` — so a dead lane still contributes `[]`, and if the other
// lane contributes one new survivor the rewritten body DELETES the dead
// lane's survivors from the marker block (the filer's only cross-run memory)
// and re-reports them as "new" next week. `--require-rust` /
// `--require-frontend`, which the workflow now passes, turn a MISSING lane
// input into a hard error so it stays distinguishable from an EMPTY one. The
// resulting red filer job is itself reported by #3359's
// `report-scheduled-failures`, which `needs:` this job.
//
// Issue-body shape (#3245/#3257): the body carries exactly ONE deduped
// survivor list — the machine-readable marker block. Per-run deltas ("new
// this run") go in the per-run comment, not the persistent body, so no
// survivor is ever listed twice and no stale snapshot masquerades as "new".
// The rendered body is clamped to MAX_BODY_CHARS so a large survivor batch
// cannot 422 `gh issue edit` and wedge this weekly job red indefinitely.
//
// Exit codes: 0 on success (including the no-op case), 1 on a real error
// (bad args, a `gh` call failing).

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stable title: the ONLY thing the find-or-file logic matches on. Never
// rename an existing issue with this title — the script would stop finding
// it and file a duplicate.
export const TRACKING_ISSUE_TITLE = 'Mutation testing: survivor triage (auto-filed, do not rename)'
export const TRACKING_ISSUE_LABELS = ['testing', 'github-actions']

const MARKER_START = '<!-- mutation-survivors:begin -->'
const MARKER_END = '<!-- mutation-survivors:end -->'

// #3257 — a GitHub issue body maxes out at 65536 characters; past that
// `gh issue edit` 422s, node exits non-zero, and this weekly non-gating job
// goes red and STAYS red, because the following week recomputes the same
// oversized body from the same unchanged `known` set. Same cap and same
// "never cut the marker block mid-way" rule as the sibling
// `scripts/file-fuzz-findings.mjs`.
export const MAX_BODY_CHARS = 60_000

// ---------------------------------------------------------------------------
// Parsing survivor sources
// ---------------------------------------------------------------------------

/**
 * cargo-mutants' `missed.txt` is one survivor per line, already a stable,
 * human-readable description (`<file>:<line>:<col>: replace ... with ...
 * in ...`). We treat each non-blank trimmed line as an opaque survivor ID —
 * it's already unique and stable across runs as long as the mutant and its
 * location don't change.
 */
export function parseRustSurvivors(missedTxtPath) {
  if (!existsSync(missedTxtPath)) return []
  const text = readFileSync(missedTxtPath, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `[rust] ${line}`)
}

/**
 * Recursively finds every `mutation.json` under `dir` (Stryker's per-module
 * JSON report, one per module directory — see `stryker.modules.mjs` /
 * `scripts/run-mutation.mjs`) and extracts its `Survived` mutants, in the
 * same `<module>: <file>:<line> [<mutatorName>]` shape the existing
 * `mutants-frontend` step-summary step already builds (continuity with what
 * a maintainer sees in the summary).
 */
export function parseFrontendSurvivors(dir) {
  if (!existsSync(dir)) return []
  const survivors = []
  for (const jsonPath of findMutationJsonFiles(dir)) {
    let report
    try {
      report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    } catch {
      continue // malformed/partial report — skip, don't crash the whole run
    }
    // Module name = the mutation.json's parent directory basename, matching
    // how `scripts/run-mutation.mjs` lays out `reports/mutation/<module>/`.
    const module_ = jsonPath.split('/').at(-2) ?? 'unknown'
    for (const [file, entry] of Object.entries(report.files ?? {})) {
      for (const mutant of entry.mutants ?? []) {
        if (mutant.status !== 'Survived') continue
        const line = mutant.location?.start?.line ?? '?'
        survivors.push(`[frontend] ${module_}: ${file}:${line} [${mutant.mutatorName}]`)
      }
    }
  }
  return survivors
}

/**
 * #3364 — how many Stryker `mutation.json` reports the frontend artifact
 * actually contains. ZERO is the machine-checkable signature of "no data":
 * a `mutants-frontend` lane that ran at all writes one report per module (the
 * lane's own liveness guard, `check-mutation-reports.mjs`, fails on a module
 * that produced none), so zero reports can only mean the artifact was never
 * uploaded or arrived empty — never "the frontend has no survivors".
 */
export function frontendReportCount(dir) {
  if (!existsSync(dir)) return 0
  return findMutationJsonFiles(dir).length
}

function findMutationJsonFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(full)
      } else if (entry === 'mutation.json') {
        out.push(full)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Diffing against the tracking issue's known state
// ---------------------------------------------------------------------------

/** Extracts the tracked survivor set from a tracking-issue body (or `''`/undefined for "no issue yet"). */
export function parseKnownSurvivors(body) {
  if (!body) return new Set()
  const start = body.indexOf(MARKER_START)
  const end = body.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) return new Set()
  const block = body.slice(start + MARKER_START.length, end)
  // The block is a fenced code block; strip the ``` fences and blank lines.
  return new Set(
    block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== '```'),
  )
}

export function diffSurvivors(current, known) {
  const currentSet = new Set(current)
  const newOnes = [...currentSet].filter((s) => !known.has(s)).toSorted()
  const resolvedOnes = [...known].filter((s) => !currentSet.has(s)).toSorted()
  return { newOnes, resolvedOnes, all: [...currentSet].toSorted() }
}

// ---------------------------------------------------------------------------
// Issue body / comment rendering
// ---------------------------------------------------------------------------

/**
 * Renders the tracking issue's body.
 *
 * #3245 — there used to be a `### New this run (N)` section here as well.
 * It listed exactly the same survivor lines as the machine-readable "all
 * currently-known" block below, so on the run that first populates the issue
 * (and on any run where most survivors are new) EVERY survivor appeared
 * twice and every per-module count a triager grepped out of the body read
 * 2x the truth — the reported 114 `glob-validate` survivors were 57. Worse,
 * the section is a per-RUN snapshot baked into a PERSISTENT body: a week
 * later it no longer means "new", so a survivor that was triaged and removed
 * became indistinguishable from one nobody had ever looked at, which is
 * precisely the distinction the issue's triage convention depends on.
 *
 * The body is now ONE deduped list — the state block — and cannot drift.
 * "New this run" lives where a per-run snapshot belongs: in the per-run
 * comment (`buildNewSurvivorComment`), which is timestamped by its own
 * position in the thread and carries the run URL.
 *
 * `resolvedOnes` is NOT part of `all` (it is the complement), so it
 * duplicates nothing; it stays as the one presentational section, and is the
 * section dropped first when the #3257 length clamp bites.
 */
export function buildIssueBody({ all, resolvedOnes, runUrl }) {
  const head = []
  head.push(
    'This issue tracks mutation-testing survivors (cargo-mutants + StrykerJS) surfaced by the weekly `scheduled-deep-checks.yml` run (#2947). It is filed and updated automatically by `scripts/file-mutation-survivors.mjs` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.',
  )
  head.push('')
  head.push(
    'Triage each survivor below: either (a) add/strengthen a test that kills it and remove its line here, or (b) leave a comment explaining why it is an accepted gap and remove its line here anyway — once a line is gone, the next run that sees that survivor again will re-add it as "new".',
  )
  head.push('')
  head.push(
    "The list below is the single deduped source of truth (#3245): survivors that are NEW in a given run are reported in that run's comment on this issue, never re-listed here.",
  )
  head.push('')

  const resolvedSection = []
  if (resolvedOnes.length > 0) {
    resolvedSection.push(`### Resolved since last run (${resolvedOnes.length})`)
    resolvedSection.push('```')
    resolvedSection.push(...resolvedOnes)
    resolvedSection.push('```')
    resolvedSection.push('')
  }

  const state = []
  state.push('### All currently-known survivors')
  state.push(
    '_Machine-readable — do not hand-edit the marker lines below. Remove a survivor line once it is triaged; leave the rest untouched._',
  )
  state.push(MARKER_START)
  state.push('```')
  state.push(...all)
  state.push('```')
  state.push(MARKER_END)

  const tail = []
  if (runUrl) {
    tail.push('')
    tail.push(`_Last updated by [this run](${runUrl})._`)
  }

  const render = (middle) => [...head, ...middle, ...state, ...tail].join('\n')

  const full = render(resolvedSection)
  if (full.length <= MAX_BODY_CHARS) return full

  // #3257 — clamp by dropping the presentational section WHOLESALE rather
  // than truncating: the marker block is state and must never be cut
  // mid-way (a half-written block would silently shrink the known set and
  // re-report the dropped survivors as "new" forever after).
  const omitted = [
    `_${resolvedOnes.length} resolved-since-last-run entr${resolvedOnes.length === 1 ? 'y was' : 'ies were'} omitted to keep this body under GitHub's ${MAX_BODY_CHARS}-character working limit — see ${runUrl ? `[this run](${runUrl})` : 'the workflow run'}._`,
    '',
  ]
  const clamped = render(omitted)
  if (clamped.length <= MAX_BODY_CHARS) return clamped

  // The state block alone does not fit. Fail with a diagnosis rather than
  // letting `gh issue edit` return a bare 422 nobody can act on.
  throw new Error(
    `the survivor set outgrew a single issue body: ${all.length} survivor(s) render to ${clamped.length} chars, over the ${MAX_BODY_CHARS}-char cap (GitHub's hard limit is 65536). The machine-readable state block cannot be truncated without corrupting the tracked set. Triage the tracking issue down, or split the lanes into separate tracking issues.`,
  )
}

export function buildNewSurvivorComment({ newOnes, runUrl }) {
  const lines = []
  lines.push(`${newOnes.length} new mutation survivor${newOnes.length === 1 ? '' : 's'} this run:`)
  lines.push('```')
  lines.push(...newOnes)
  lines.push('```')
  if (runUrl) lines.push('', `Run: ${runUrl}`)
  const text = lines.join('\n')
  // #3257 — a comment body hits the same 65536 limit as an issue body, and
  // this is the call the SAME large-batch run makes right after the edit, so
  // capping only the body would just move the 422 one line down. A comment
  // carries no state, so a plain truncation is safe here.
  if (text.length <= MAX_BODY_CHARS) return text
  const footer = runUrl
    ? `\n…(truncated — see the full list in the issue body, and [this run](${runUrl}))`
    : '\n…(truncated — see the full list in the issue body)'
  return text.slice(0, MAX_BODY_CHARS - footer.length) + footer
}

// ---------------------------------------------------------------------------
// `gh` plumbing
// ---------------------------------------------------------------------------

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8' })
  return JSON.parse(out)
}

/** Finds the single tracking issue by exact title, preferring an OPEN match over a CLOSED one (so a triaged-and-closed issue gets reopened rather than duplicated). */
function findTrackingIssue(repo) {
  const results = ghJson([
    'issue',
    'list',
    '--repo',
    repo,
    '--search',
    `in:title "${TRACKING_ISSUE_TITLE}"`,
    '--state',
    'all',
    '--json',
    'number,title,body,state',
    '--limit',
    '20',
  ])
  const exact = results.filter((i) => i.title === TRACKING_ISSUE_TITLE)
  if (exact.length === 0) return null
  const open = exact.find((i) => i.state === 'OPEN')
  if (open) return open
  // No open match — most recently numbered closed match (gh lists newest-ish
  // first already via search relevance, but sort explicitly to be sure).
  return exact.toSorted((a, b) => b.number - a.number)[0]
}

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-survivors-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, content, 'utf8')
  return fn(file)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, requireRust: false, requireFrontend: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--rust-missed': {
        args.rustMissed = argv[++i]
        break
      }
      case '--frontend-dir': {
        args.frontendDir = argv[++i]
        break
      }
      case '--require-rust': {
        args.requireRust = true
        break
      }
      case '--require-frontend': {
        args.requireFrontend = true
        break
      }
      case '--repo': {
        args.repo = argv[++i]
        break
      }
      case '--run-url': {
        args.runUrl = argv[++i]
        break
      }
      case '--dry-run': {
        args.dryRun = true
        break
      }
      case '--known-body-file': {
        args.knownBodyFile = argv[++i]
        break
      }
      default: {
        throw new Error(`unrecognized argument: ${a}`)
      }
    }
  }
  return args
}

function defaultRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
  }
  return undefined
}

/**
 * #3364 — a MISSING lane input must be distinguishable from an EMPTY one.
 *
 * Without these gates a dead lane contributes `[]`, which is identical to
 * "that lane has no survivors": if the other lane then contributes even one
 * NEW survivor, `main()` rewrites the issue body from `all`, and every
 * survivor belonging to the dead lane is DELETED from the marker block — i.e.
 * from the filer's only cross-run memory — then re-reported as "new" the
 * following week. That is state corruption, not a display bug, and #3330's
 * liveness guard does not prevent it: the guard makes the LANE go red, while
 * this job keeps running under `if: always()` regardless.
 *
 * Throwing (rather than gating the whole job on `needs.<lane>.result`) is
 * deliberate: a skipped job reports `skipped`, which #3359's
 * `report-scheduled-failures` would then have to special-case away; a thrown
 * filer reports `failure`, which is the truth and rides the ordinary path.
 *
 * An EMPTY-but-present `missed.txt` is real data (cargo-mutants writes one
 * when nothing survived); only an ABSENT one is "no data". For the frontend,
 * ZERO `mutation.json` files is the machine-checkable "no data" signature — a
 * lane that ran writes one report per module, and its own liveness guard
 * (`check-mutation-reports.mjs`) fails on a module that produced none.
 */
function assertLaneInputsPresent(args) {
  if (args.requireRust && !existsSync(args.rustMissed ?? '')) {
    throw new Error(
      `--require-rust: no cargo-mutants missed.txt at ${args.rustMissed ?? '(unset)'} — the mutants lane produced no data, which is NOT the same as "no rust survivors". Refusing to rewrite the tracking issue, which would delete every rust survivor from its tracked set (#3364).`,
    )
  }
  if (args.requireFrontend && frontendReportCount(args.frontendDir ?? '') === 0) {
    throw new Error(
      `--require-frontend: no Stryker mutation.json under ${args.frontendDir ?? '(unset)'} — the mutants-frontend lane produced no data, which is NOT the same as "no frontend survivors". Refusing to rewrite the tracking issue, which would delete every frontend survivor from its tracked set (#3364).`,
    )
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  const runUrl = args.runUrl ?? defaultRunUrl()

  // #3364 — a MISSING lane input is a hard error, not an empty one; see
  // `assertLaneInputsPresent` above for why the alternative silently corrupts
  // the tracking issue's state.
  assertLaneInputsPresent(args)

  const rustSurvivors = args.rustMissed ? parseRustSurvivors(args.rustMissed) : []
  const frontendSurvivors = args.frontendDir ? parseFrontendSurvivors(args.frontendDir) : []
  const current = [...rustSurvivors, ...frontendSurvivors]

  console.log(
    `mutation survivors this run: ${current.length} (rust: ${rustSurvivors.length}, frontend: ${frontendSurvivors.length})`,
  )

  // --known-body-file is a TEST-ONLY escape hatch: it substitutes for the
  // `gh issue list` lookup so the diff/file/update logic can be exercised
  // against sample data without touching real GitHub state. The real
  // (non-test) path always goes through `gh issue list`.
  let existingIssue = null
  if (args.knownBodyFile !== undefined) {
    const body = existsSync(args.knownBodyFile) ? readFileSync(args.knownBodyFile, 'utf8') : ''
    existingIssue = body ? { number: 0, state: 'OPEN', body } : null
  } else {
    if (!repo)
      throw new Error(
        '--repo (or $GITHUB_REPOSITORY) is required outside of --known-body-file test mode',
      )
    existingIssue = findTrackingIssue(repo)
  }

  const known = parseKnownSurvivors(existingIssue?.body)
  const { newOnes, resolvedOnes, all } = diffSurvivors(current, known)

  if (newOnes.length === 0) {
    console.log('no new mutation survivors — no-op (tracking issue left untouched)')
    if (resolvedOnes.length > 0) {
      console.log(
        `(${resolvedOnes.length} previously-known survivor(s) no longer present — not a reason to touch the issue on their own: ${resolvedOnes.join(', ')})`,
      )
    }
    return
  }

  const body = buildIssueBody({ all, resolvedOnes, runUrl })
  const comment = buildNewSurvivorComment({ newOnes, runUrl })

  if (args.dryRun) {
    // Compare to null explicitly — issue #0 is not a real GitHub issue
    // number, but the `--known-body-file` test stub uses 0 as a placeholder
    // and 0 is falsy, so a `existingIssue.number` truthiness check here
    // would misreport an existing issue as "not found".
    if (existingIssue !== null) {
      console.log(
        `[dry-run] would ${existingIssue.state === 'CLOSED' ? 'REOPEN + ' : ''}edit issue #${existingIssue.number}`,
      )
    } else {
      console.log(`[dry-run] would CREATE a new issue titled "${TRACKING_ISSUE_TITLE}"`)
    }
    console.log(
      `[dry-run] new survivors: ${newOnes.length}, resolved: ${resolvedOnes.length}, total known: ${all.length}`,
    )
    console.log('[dry-run] --- issue body ---')
    console.log(body)
    console.log('[dry-run] --- new-survivor comment ---')
    console.log(comment)
    return
  }

  if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required to file/update an issue')

  if (existingIssue !== null) {
    if (existingIssue.state === 'CLOSED') {
      execFileSync('gh', ['issue', 'reopen', String(existingIssue.number), '--repo', repo], {
        stdio: 'inherit',
      })
    }
    withTempFile(body, (bodyFile) => {
      execFileSync(
        'gh',
        ['issue', 'edit', String(existingIssue.number), '--repo', repo, '--body-file', bodyFile],
        {
          stdio: 'inherit',
        },
      )
    })
    withTempFile(comment, (commentFile) => {
      execFileSync(
        'gh',
        [
          'issue',
          'comment',
          String(existingIssue.number),
          '--repo',
          repo,
          '--body-file',
          commentFile,
        ],
        { stdio: 'inherit' },
      )
    })
    console.log(
      `updated tracking issue #${existingIssue.number} (${newOnes.length} new survivor(s))`,
    )
  } else {
    withTempFile(body, (bodyFile) => {
      const labelArgs = TRACKING_ISSUE_LABELS.flatMap((l) => ['--label', l])
      execFileSync(
        'gh',
        [
          'issue',
          'create',
          '--repo',
          repo,
          '--title',
          TRACKING_ISSUE_TITLE,
          '--body-file',
          bodyFile,
          ...labelArgs,
        ],
        { stdio: 'inherit' },
      )
    })
    console.log(`filed a new tracking issue (${newOnes.length} survivor(s))`)
  }
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// Fixture suite for the two rendering invariants this script has already
// broken once:
//   #3245 — no survivor may appear twice in the issue body (the old
//           `### New this run` section re-listed the whole known set, so
//           every count a triager grepped out of the body read 2x).
//   #3257 — the rendered body must never exceed MAX_BODY_CHARS, and the
//           machine-readable marker block must never be cut mid-way (a
//           truncated block silently shrinks the tracked set).
// Wired as the `mutation-survivors-filer-selftest` prek hook.
// #3364 fixtures, split out of `runSelfTest` to keep its cyclomatic
// complexity under the repo lint budget.
function selfTestLaneInputGuards({ ok, fail, survivor }) {
  // 8. #3364 — a MISSING lane input must be distinguishable from an EMPTY
  //    one. First, the damage the guards prevent, demonstrated on the pure
  //    functions: a dead frontend lane contributes `[]`, and one new rust
  //    survivor is enough to rewrite the body WITHOUT the frontend entries.
  {
    const frontendSurvivor = survivor(1)
    const rustOld = '[rust] src/op.rs:10:5: replace foo with bar'
    const rustNew = '[rust] src/op.rs:99:1: replace baz with qux'
    const known = new Set([frontendSurvivor, rustOld])
    // frontend lane dead -> contributes nothing; rust lane contributes a new one
    const { newOnes, resolvedOnes, all } = diffSurvivors([rustOld, rustNew], known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    if (newOnes.length === 1 && !parseKnownSurvivors(body).has(frontendSurvivor))
      ok('an unguarded dead lane really would delete its survivors from the tracked set (#3364)')
    else
      fail(
        'an unguarded dead lane really would delete its survivors from the tracked set (#3364)',
        `newOnes=${newOnes.length} stillTracked=${parseKnownSurvivors(body).has(frontendSurvivor)}`,
      )
  }

  // …and the guards themselves. `main()` runs in dry-run + --known-body-file
  // mode throughout, so no `gh` call is ever made.
  {
    const root = mkdtempSync(join(tmpdir(), 'survivor-require-'))
    const emptyDir = join(root, 'empty')
    mkdirSync(emptyDir)
    const fullDir = join(root, 'full')
    mkdirSync(join(fullDir, 'glob-validate'), { recursive: true })
    writeFileSync(join(fullDir, 'glob-validate', 'mutation.json'), JSON.stringify({ files: {} }))
    const missed = join(root, 'missed.txt')
    writeFileSync(missed, '')
    const absent = join(root, 'nope')

    const runQuiet = (argv) => {
      const realLog = console.log
      console.log = () => {}
      try {
        main(argv)
        return null
      } catch (err) {
        return err
      } finally {
        console.log = realLog
      }
    }
    const base = ['--dry-run', '--known-body-file', join(root, 'no-such-body.md')]

    const cases = [
      [
        'an ABSENT frontend dir fails --require-frontend (#3364)',
        [...base, '--frontend-dir', absent, '--require-frontend'],
        /no Stryker mutation\.json/,
      ],
      [
        'an EMPTY frontend dir fails --require-frontend too — empty artifact is still no data (#3364)',
        [...base, '--frontend-dir', emptyDir, '--require-frontend'],
        /no Stryker mutation\.json/,
      ],
      [
        'an absent missed.txt fails --require-rust (#3364)',
        [...base, '--rust-missed', absent, '--require-rust'],
        /no cargo-mutants missed\.txt/,
      ],
    ]
    for (const [name, argv, pattern] of cases) {
      const err = runQuiet(argv)
      if (err && pattern.test(err.message)) ok(name)
      else fail(name, err ? err.message : 'did not throw')
    }

    // The complement: real data must still pass, or the guard is just a
    // permanent red lane. An EMPTY missed.txt is real data (cargo-mutants
    // writes one when nothing survived) — only an ABSENT one is "no data".
    const okCases = [
      [
        'a populated frontend dir passes --require-frontend',
        [...base, '--frontend-dir', fullDir, '--require-frontend'],
      ],
      [
        'an empty-but-present missed.txt passes --require-rust',
        [...base, '--rust-missed', missed, '--require-rust'],
      ],
      [
        'the guards are opt-in: an absent dir is still tolerated without the flag',
        [...base, '--frontend-dir', absent, '--rust-missed', absent],
      ],
    ]
    for (const [name, argv] of okCases) {
      const err = runQuiet(argv)
      if (err === null) ok(name)
      else fail(name, err.message)
    }
  }
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  const survivor = (i) =>
    `[frontend] glob-validate: src/lib/search-query/glob-validate.ts:${i} [ConditionalExpression]`

  // 1. #3245 — the first-fill case: an empty `known` set means EVERY
  //    survivor is "new". The old body listed them under `New this run` AND
  //    under the marker block; the deduped body must list each exactly once.
  {
    const current = [survivor(1), survivor(2), survivor(3)]
    const { newOnes, resolvedOnes, all } = diffSurvivors(current, new Set())
    const body = buildIssueBody({ all, resolvedOnes, runUrl: 'https://example/run' })
    const counts = current.map((s) => body.split(s).length - 1)
    if (newOnes.length === 3 && counts.every((c) => c === 1))
      ok('first fill lists each survivor exactly once (#3245)')
    else
      fail(
        'first fill lists each survivor exactly once (#3245)',
        `newOnes=${newOnes.length} per-survivor occurrences=${JSON.stringify(counts)}`,
      )

    // …and the marker block round-trips to exactly the same set, so the
    // dedupe did not cost the script its state.
    const reparsed = parseKnownSurvivors(body)
    if (reparsed.size === 3 && current.every((s) => reparsed.has(s)))
      ok('deduped body round-trips through parseKnownSurvivors')
    else fail('deduped body round-trips through parseKnownSurvivors', `size=${reparsed.size}`)

    // The per-run comment is where "new this run" lives now.
    const comment = buildNewSurvivorComment({ newOnes, runUrl: 'https://example/run' })
    if (current.every((s) => comment.includes(s)))
      ok('per-run comment still carries the new survivors')
    else fail('per-run comment still carries the new survivors', comment)
  }

  // 2. #3245 — the incremental case: a genuinely new survivor must not
  //    duplicate the already-known ones either.
  {
    const known = new Set([survivor(1), survivor(2)])
    const current = [survivor(1), survivor(2), survivor(9)]
    const { resolvedOnes, all } = diffSurvivors(current, known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    const counts = current.map((s) => body.split(s).length - 1)
    if (counts.every((c) => c === 1)) ok('incremental run lists each survivor exactly once (#3245)')
    else fail('incremental run lists each survivor exactly once (#3245)', JSON.stringify(counts))
  }

  // 3. Resolved entries are the complement of `all`, so they duplicate
  //    nothing and stay visible.
  {
    const known = new Set([survivor(1), survivor(2)])
    const { resolvedOnes, all } = diffSurvivors([survivor(1)], known)
    const body = buildIssueBody({ all, resolvedOnes, runUrl: undefined })
    if (
      resolvedOnes.length === 1 &&
      body.includes('Resolved since last run (1)') &&
      body.split(survivor(1)).length - 1 === 1
    )
      ok('resolved section renders and duplicates nothing')
    else fail('resolved section renders and duplicates nothing', JSON.stringify(resolvedOnes))
  }

  // 4. #3257 — a large batch must not exceed MAX_BODY_CHARS. These fixture
  //    lines are ~90 chars, so 800 survivors render to ~72K: past both the
  //    60K working cap and GitHub's 65536 hard limit. That is the batch
  //    which used to 422 `gh issue edit` and wedge the weekly job red
  //    forever (the same body is recomputed from the same unchanged `known`
  //    set the following week, so it never self-heals).
  {
    const all = Array.from({ length: 800 }, (_, i) => survivor(i))
    let threw = null
    let body = null
    try {
      body = buildIssueBody({ all, resolvedOnes: [], runUrl: 'https://example/run' })
    } catch (err) {
      threw = err
    }
    if (threw && /outgrew a single issue body/.test(threw.message))
      ok('oversized state block fails with an actionable error, not a raw 422 (#3257)')
    else
      fail(
        'oversized state block fails with an actionable error, not a raw 422 (#3257)',
        threw ? threw.message : `no throw; body=${body.length} chars`,
      )
  }

  // 5. #3257 — a body that only overflows because of the presentational
  //    `Resolved` section must CLAMP (drop that section) rather than throw,
  //    and the marker block must survive intact.
  {
    const all = Array.from({ length: 200 }, (_, i) => survivor(i))
    const resolvedOnes = Array.from({ length: 600 }, (_, i) => survivor(10_000 + i))
    const body = buildIssueBody({ all, resolvedOnes, runUrl: 'https://example/run' })
    const reparsed = parseKnownSurvivors(body)
    if (
      body.length <= MAX_BODY_CHARS &&
      body.includes(MARKER_START) &&
      body.includes(MARKER_END) &&
      reparsed.size === 200 &&
      !body.includes(resolvedOnes[0])
    )
      ok('clamp drops the presentational section and keeps the state block whole (#3257)')
    else
      fail(
        'clamp drops the presentational section and keeps the state block whole (#3257)',
        `len=${body.length} markers=${body.includes(MARKER_START)}/${body.includes(MARKER_END)} reparsed=${reparsed.size}`,
      )
  }

  // 6. #3257 — the comment is the very next `gh` call the same oversized run
  //    makes, so capping only the body would move the 422 one line down.
  {
    const newOnes = Array.from({ length: 800 }, (_, i) => survivor(i))
    const comment = buildNewSurvivorComment({ newOnes, runUrl: 'https://example/run' })
    if (comment.length <= MAX_BODY_CHARS && comment.includes('truncated'))
      ok('oversized new-survivor comment is truncated (#3257)')
    else fail('oversized new-survivor comment is truncated (#3257)', `len=${comment.length}`)
  }

  // 7. A body that comfortably fits is left completely alone.
  {
    const all = [survivor(1), survivor(2)]
    const body = buildIssueBody({ all, resolvedOnes: [], runUrl: 'https://example/run' })
    if (!body.includes('omitted') && !body.includes('truncated')) ok('a small body is not clamped')
    else fail('a small body is not clamped', body)
  }

  // 8. #3364 — a MISSING lane input must be distinguishable from an EMPTY
  //    one. Fixtures live in `selfTestLaneInputGuards` above.
  selfTestLaneInputGuards({ ok, fail, survivor })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`file-mutation-survivors: ${err.message}`)
      process.exit(1)
    }
  }
}
