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
// survivor *content*, not lane health).
//
// Exit codes: 0 on success (including the no-op case), 1 on a real error
// (bad args, a `gh` call failing).

import { execFileSync } from 'node:child_process'
import {
  existsSync,
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

export function buildIssueBody({ all, newOnes, resolvedOnes, runUrl }) {
  const lines = []
  lines.push(
    'This issue tracks mutation-testing survivors (cargo-mutants + StrykerJS) surfaced by the weekly `scheduled-deep-checks.yml` run (#2947). It is filed and updated automatically by `scripts/file-mutation-survivors.mjs` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.',
  )
  lines.push('')
  lines.push(
    'Triage each survivor below: either (a) add/strengthen a test that kills it and remove its line here, or (b) leave a comment explaining why it is an accepted gap and remove its line here anyway — once a line is gone, the next run that sees that survivor again will re-add it as "new".',
  )
  lines.push('')
  if (newOnes.length > 0) {
    lines.push(`### New this run (${newOnes.length})`)
    lines.push('```')
    lines.push(...newOnes)
    lines.push('```')
    lines.push('')
  }
  if (resolvedOnes.length > 0) {
    lines.push(`### Resolved since last run (${resolvedOnes.length})`)
    lines.push('```')
    lines.push(...resolvedOnes)
    lines.push('```')
    lines.push('')
  }
  lines.push('### All currently-known survivors')
  lines.push(
    '_Machine-readable — do not hand-edit the marker lines below. Remove a survivor line once it is triaged; leave the rest untouched._',
  )
  lines.push(MARKER_START)
  lines.push('```')
  lines.push(...all)
  lines.push('```')
  lines.push(MARKER_END)
  if (runUrl) {
    lines.push('')
    lines.push(`_Last updated by [this run](${runUrl})._`)
  }
  return lines.join('\n')
}

export function buildNewSurvivorComment({ newOnes, runUrl }) {
  const lines = []
  lines.push(`${newOnes.length} new mutation survivor${newOnes.length === 1 ? '' : 's'} this run:`)
  lines.push('```')
  lines.push(...newOnes)
  lines.push('```')
  if (runUrl) lines.push('', `Run: ${runUrl}`)
  return lines.join('\n')
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
  const args = { dryRun: false }
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

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  const runUrl = args.runUrl ?? defaultRunUrl()

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

  const body = buildIssueBody({ all, newOnes, resolvedOnes, runUrl })
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

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`file-mutation-survivors: ${err.message}`)
    process.exit(1)
  }
}
