#!/usr/bin/env node
// #3169 — push-based triage loop for the weekly `fuzz` lane.
//
// `scheduled-deep-checks.yml`'s `fuzz` job only ever surfaced signal as a red
// job in a weekly workflow — which is easy to miss: the compile break landed
// 2026-07-24 (#3163) and survived five days unnoticed. This script closes the
// same loop `scripts/file-mutation-survivors.mjs` closes for the mutants
// lanes: it reads the fuzz lane's per-target result files, diffs the findings
// against the SINGLE tracking issue's last-known set (encoded in a marked
// block in the issue body), and files/updates that one issue only when a
// genuinely NEW finding appears. A persistent, unchanged failure is a no-op,
// so this never spams a fresh issue (or a fresh comment) every week.
//
// Findings cover all three ways the lane can go wrong — not just a crash
// artifact, which the real-world failure did not produce:
//   [build]   the target failed to COMPILE (carries the first compiler error)
//   [crash]   libFuzzer found a reproducer (carries the target + input hash)
//   [timeout] libFuzzer hit its per-input timeout (carries the reproducer)
//   [failed]  the target exited non-zero for some other reason
//   [not-run] the target never executed (the job was cut short mid-loop)
//   [lane]    the whole job failed without producing a result artifact at all
//             (setup failure, job-level timeout, cancellation) — derived from
//             `--job-status`, i.e. `needs.fuzz.result`, so that a lane that
//             dies before it can write anything is still reported.
//
// State lives in the tracking issue itself (its body), not a committed
// baseline file — the workflow only needs `issues: write`, never
// `contents: write`, and there is nothing to keep in sync with a repo file.
//
// Result-dir layout (written by the `fuzz` job, uploaded as `fuzz-status`):
//   targets.txt          one target name per line, in loop order
//   <target>.status      one word: ok|build_failed|crashed|timed_out|failed|not_run
//   <target>.log         tail of THAT target's own stdout+stderr (never a
//                        shared blob — every error is attributable)
//   <target>.artifacts   `ls` of fuzz/artifacts/<target>/ (reproducer names)
// Every `<target>.status` is pre-seeded to `not_run` before the loop, so a
// target that never executed is distinguishable from one that failed. The loop
// itself is run-all-then-fail (each target in a guarded subshell, aggregate
// non-zero exit at the end), so `not_run` now means the JOB was cut short —
// cancellation, job-level timeout, runner death — not "an earlier target
// aborted the loop".
//
// Every target's status is reported in the issue body, passing ones included,
// so "N of M targets failed" and WHICH ones is visible at a glance and an
// unlisted-because-skipped target is never something a reader has to infer.
//
// Usage (from the repo root or anywhere — paths are resolved as given):
//   node scripts/file-fuzz-findings.mjs \
//     --result-dir <dir the fuzz-status artifact was downloaded to> \
//     [--job-status <needs.fuzz.result>]  (success|failure|cancelled|skipped)
//     [--require-results]           (#3360: FAIL when a lane that did not fail
//                                    produced no per-target results at all)
//     [--require-targets-manifest]  (#3360: FAIL when the result dir has status
//                                    files but no `targets.txt`)
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
//     [--self-test]                 (run the fixture suite and exit)
//
// `--result-dir` is best-effort: a missing/empty directory contributes zero
// per-target findings (the artifact download is `continue-on-error`, so a
// missing artifact must never fail triage). The `[lane]` fallback above is
// what keeps that case from silently reporting nothing when the lane did in
// fact fail.
//
// #3360 — but that fallback only covers a lane that DID fail. Two blind spots
// remained, the same missing-vs-empty ambiguity #3364 closed for the mutation
// filer:
//   * a lane that SUCCEEDED whose `fuzz-status` upload was lost (the upload is
//     `if-no-files-found: ignore`, the download is `continue-on-error`) gives
//     `results = []`, no `[lane]` finding, and a cheerful "no new findings"
//     no-op — indistinguishable from a clean week. `--require-results` makes
//     that a hard error.
//   * a PARTIAL artifact without `targets.txt` falls back to globbing the
//     `.status` files that did arrive, so a target whose files went missing
//     vanishes from the report entirely rather than being reported `not_run`.
//     `--require-targets-manifest` makes that a hard error.
// Both are opt-in flags (the workflow passes them) so the genuinely
// catastrophic case — the lane died before writing anything — still reaches
// the `[lane]` finding instead of erroring out before it can file.
//
// Exit codes: 0 on success (including the no-op case), 1 on a real error
// (bad args, a missing/partial artifact under the `--require-*` flags, a `gh`
// call failing), 2 on a `--self-test` failure.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Stable title: the ONLY thing the find-or-file logic matches on. Never
// rename an existing issue with this title — the script would stop finding
// it and file a duplicate.
export const TRACKING_ISSUE_TITLE = 'Fuzzing: weekly fuzz-lane findings (auto-filed, do not rename)'
export const TRACKING_ISSUE_LABELS = ['testing', 'github-actions']

const MARKER_START = '<!-- fuzz-findings:begin -->'
const MARKER_END = '<!-- fuzz-findings:end -->'

// Excerpt caps. A libFuzzer log can be thousands of lines and a GitHub issue
// body maxes out at 65536 characters, so details are always bounded and the
// whole body is clamped below (never at the expense of the marker block).
const MAX_EXCERPT_LINES = 30
const MAX_EXCERPT_CHARS = 2000
const MAX_BODY_CHARS = 60_000
const MAX_ID_CHARS = 240

// ---------------------------------------------------------------------------
// Reading the fuzz lane's result directory
// ---------------------------------------------------------------------------

function readFileOr(path, fallback = '') {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}

/** One-line, length-bounded rendition of `text` — finding IDs must be single lines. */
function oneLine(text, max = MAX_ID_CHARS) {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * Reads `<dir>/targets.txt` plus each target's `.status` / `.log` /
 * `.artifacts` sidecar. A missing directory (artifact download failed, or the
 * lane died before writing anything) yields `[]` — deliberately NOT an error,
 * see the `[lane]` fallback in `buildFindings`.
 */
export function parseTargetResults(dir) {
  if (!dir || !existsSync(dir)) return []
  const targetsFile = join(dir, 'targets.txt')
  let targets = readFileOr(targetsFile)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (targets.length === 0) {
    // No manifest (older artifact shape, or a partial upload): fall back to
    // whatever `.status` files are present.
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    targets = entries.filter((e) => e.endsWith('.status')).map((e) => basename(e, '.status'))
  }
  return targets.toSorted().map((target) => ({
    target,
    status: readFileOr(join(dir, `${target}.status`)).trim() || 'not_run',
    log: readFileOr(join(dir, `${target}.log`)),
    artifacts: readFileOr(join(dir, `${target}.artifacts`))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  }))
}

/**
 * Why `parseTargetResults` returned what it returned (#3360). `parseTargetResults`
 * is deliberately forgiving — every degraded shape yields *some* array — which
 * is exactly why the degraded shapes are invisible without this.
 *
 *   'ok'               `targets.txt` present and non-empty: the target list is
 *                      the one the lane intended to run.
 *   'missing-manifest' status files but no usable `targets.txt`: the list is
 *                      INFERRED from whichever files arrived, so a target whose
 *                      files went missing is not reported `not_run` — it is not
 *                      reported at all.
 *   'empty-dir'        the directory exists but holds nothing recognisable.
 *   'missing-dir'      no directory (artifact absent, download skipped).
 *   'unreadable-dir'   present but not listable.
 */
export function resultDirDiagnosis(dir) {
  if (!dir || !existsSync(dir)) return 'missing-dir'
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return 'unreadable-dir'
  }
  const manifest = readFileOr(join(dir, 'targets.txt'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (manifest.length > 0) return 'ok'
  if (entries.some((e) => e.endsWith('.status'))) return 'missing-manifest'
  return 'empty-dir'
}

/** Last few meaningful lines of a target's log, bounded — the human-readable half of a finding. */
export function excerptFromLog(log) {
  const lines = log
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  const tail = lines.slice(-MAX_EXCERPT_LINES).join('\n')
  return tail.length > MAX_EXCERPT_CHARS ? `…${tail.slice(-MAX_EXCERPT_CHARS)}` : tail
}

/** First rustc/cargo error line in a build log, which is what makes a `[build]` finding identifiable week to week. */
export function firstCompilerError(log) {
  for (const line of log.split('\n')) {
    const trimmed = line.trim()
    if (/^error(\[E\d+\])?:/.test(trimmed)) return oneLine(trimmed)
    if (trimmed.startsWith('Error:')) return oneLine(trimmed)
  }
  return ''
}

/**
 * Reproducer names for a target: prefer the `artifacts/<target>/` listing
 * (authoritative), fall back to libFuzzer's "Test unit written to
 * ./artifacts/<target>/<name>" log line when the artifacts dir did not make it
 * into the upload. `prefix` is `crash`/`timeout`/`leak`/`oom`.
 */
export function reproducersFor({ artifacts, log }, prefixes) {
  const matches = artifacts.filter((a) => prefixes.some((p) => basename(a).startsWith(`${p}-`)))
  if (matches.length > 0) return matches.map((m) => basename(m)).toSorted()
  const fromLog = new Set()
  for (const line of log.split('\n')) {
    const m = /(?:Test unit|artifact_prefix).*?([\w-]*(?:crash|timeout|leak|oom)-[0-9a-f]+)/i.exec(
      line,
    )
    if (m) fromLog.add(m[1])
  }
  return [...fromLog].toSorted()
}

// ---------------------------------------------------------------------------
// Turning results into findings
// ---------------------------------------------------------------------------

/**
 * Maps per-target results (+ the overall job result) to findings. Each finding
 * is `{ id, detail }`: `id` is the single, stable line stored in the tracking
 * issue's machine-readable block (and therefore what dedup keys on), `detail`
 * is the unbounded-ish human context rendered outside that block.
 *
 * `jobStatus` is `needs.fuzz.result`. When the lane produced NO result files
 * at all and did not succeed, a single `[lane]` finding is synthesised — a
 * setup failure or a job-level timeout kills the upload step too, so without
 * this the most catastrophic failure mode would report nothing.
 */
export function buildFindings(results, jobStatus) {
  const findings = []
  for (const r of results) {
    switch (r.status) {
      case 'ok': {
        break
      }
      case 'build_failed': {
        const err = firstCompilerError(r.log) || 'no compiler error line captured'
        findings.push({
          id: `[build] ${r.target}: ${err}`,
          detail: excerptFromLog(r.log),
        })
        break
      }
      case 'crashed': {
        const repros = reproducersFor(r, ['crash', 'leak', 'oom'])
        if (repros.length === 0) {
          findings.push({
            id: `[crash] ${r.target}: reproducer not captured`,
            detail: excerptFromLog(r.log),
          })
        } else {
          for (const repro of repros) {
            findings.push({
              id: `[crash] ${r.target}: ${repro}`,
              detail: `Reproducer \`src-tauri/fuzz/artifacts/${r.target}/${repro}\` (download the \`fuzz-artifacts\` artifact from the run, then \`cargo +nightly fuzz run ${r.target} artifacts/${r.target}/${repro}\`).\n\n${excerptFromLog(r.log)}`,
            })
          }
        }
        break
      }
      case 'timed_out': {
        const repros = reproducersFor(r, ['timeout', 'oom'])
        const suffix = repros.length > 0 ? repros.join(', ') : 'no reproducer captured'
        findings.push({
          id: `[timeout] ${r.target}: ${suffix}`,
          detail: excerptFromLog(r.log),
        })
        break
      }
      case 'not_run': {
        findings.push({
          id: `[not-run] ${r.target}: target never executed`,
          detail:
            "The lane pre-seeded this target's status and never overwrote it. The loop itself runs every target independently (#3169), so this means the JOB was cut short — job-level timeout, cancellation, or a runner failure — before this target ran. Its coverage was lost for this run.",
        })
        break
      }
      default: {
        const err = firstCompilerError(r.log) || `exited non-zero (status "${r.status}")`
        findings.push({
          id: `[failed] ${r.target}: ${err}`,
          detail: excerptFromLog(r.log),
        })
      }
    }
  }

  if (results.length === 0 && jobStatus && jobStatus !== 'success' && jobStatus !== 'skipped') {
    findings.push({
      id: `[lane] fuzz job ended as "${jobStatus}" and produced no result artifact`,
      detail:
        'No per-target status files were available (the `fuzz-status` artifact is missing or empty), so the failure happened before or around the fuzz step itself — setup, toolchain install, or a job-level timeout. Open the run log for the cause.',
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Diffing against the tracking issue's known state
// ---------------------------------------------------------------------------

/** Extracts the tracked finding IDs from a tracking-issue body (or `''`/undefined for "no issue yet"). */
export function parseKnownFindings(body) {
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

export function diffFindings(current, known) {
  const byId = new Map(current.map((f) => [f.id, f]))
  const newOnes = [...byId.keys()].filter((id) => !known.has(id)).toSorted()
  const resolvedOnes = [...known].filter((id) => !byId.has(id)).toSorted()
  return { newOnes, resolvedOnes, all: [...byId.keys()].toSorted(), byId }
}

// ---------------------------------------------------------------------------
// Issue body / comment rendering
// ---------------------------------------------------------------------------

function renderDetails(ids, byId) {
  const lines = []
  for (const id of ids) {
    const detail = byId.get(id)?.detail
    if (!detail) continue
    lines.push(`<details><summary><code>${id.replaceAll('<', '&lt;')}</code></summary>`, '')
    lines.push('```')
    lines.push(detail)
    lines.push('```')
    lines.push('</details>', '')
  }
  return lines
}

const STATUS_LABEL = {
  ok: '✅ ok',
  build_failed: '❌ build failed',
  crashed: '💥 crashed',
  timed_out: '⏱ timed out',
  failed: '❌ failed',
  not_run: '⚠️ NEVER RAN',
}

/**
 * "N of M targets failed, and here is exactly which" — rendered for EVERY
 * target including the passing ones, so a reader never has to infer that an
 * unlisted target was skipped (#3169). Derived from this run's statuses; it
 * sits outside the machine-readable block and so never affects dedup.
 */
export function buildStatusSummary(results) {
  if (results.length === 0) return []
  const bad = results.filter((r) => r.status !== 'ok')
  const headline =
    bad.length === 0
      ? `All ${results.length} fuzz targets ran clean this run.`
      : `**${bad.length} of ${results.length} fuzz targets did not pass this run: ${bad.map((r) => `\`${r.target}\``).join(', ')}.**`
  const lines = [`### Target status this run (${results.length} targets)`, '', headline, '']
  lines.push('| target | status |', '| --- | --- |')
  for (const r of results) {
    lines.push(`| \`${r.target}\` | ${STATUS_LABEL[r.status] ?? r.status} |`)
  }
  lines.push('')
  return lines
}

export function buildIssueBody({ all, newOnes, resolvedOnes, byId, results = [], runUrl }) {
  const intro = [
    'This issue tracks findings from the weekly `fuzz` lane in `scheduled-deep-checks.yml` (#3169) — build failures, crash reproducers, per-input timeouts, and targets that never ran. It is filed and updated automatically by `scripts/file-fuzz-findings.mjs` — **do not rename the title**, the filing script matches on it verbatim to find this issue instead of opening a new one.',
    '',
    'A red weekly workflow is easy to miss (a compile break in this very lane survived five days, #3163), so the lane pushes here instead. Triage each finding below: fix it and remove its line from the machine-readable block — once a line is gone, the next run that still sees it will re-add it as "new". Only genuinely new findings update this issue; an unchanged failure is a silent no-op.',
    '',
  ]

  // Presentational: nice to have, first thing dropped when the body overflows.
  const presentational = [...buildStatusSummary(results)]
  if (newOnes.length > 0) {
    presentational.push(`### New this run (${newOnes.length})`)
    presentational.push('```')
    presentational.push(...newOnes)
    presentational.push('```')
    presentational.push('')
  }
  if (resolvedOnes.length > 0) {
    presentational.push(`### Resolved since last run (${resolvedOnes.length})`)
    presentational.push('```')
    presentational.push(...resolvedOnes)
    presentational.push('```')
    presentational.push('')
  }

  // State: the script's ONLY cross-run memory. Never truncated, never dropped.
  const state = [
    '### All currently-known findings',
    '_Machine-readable — do not hand-edit the marker lines below. Remove a finding line once it is fixed; leave the rest untouched._',
    MARKER_START,
    '```',
    ...all,
    '```',
    MARKER_END,
  ]

  const footerLines = []
  if (runUrl) {
    footerLines.push('')
    footerLines.push(`_Last updated by [this run](${runUrl})._`)
  }

  const details = renderDetails(all, byId)
  const detailsSection = details.length > 0 ? ['', '### Details', ...details] : []
  const seeRun = runUrl ? `[this run](${runUrl})` : 'the workflow run'

  const render = (mid, det) => [...intro, ...mid, ...state, ...det, ...footerLines].join('\n')

  const full = render(presentational, detailsSection)
  if (full.length <= MAX_BODY_CHARS) return full

  // Clamp 1: drop the DETAILS section wholesale rather than truncating — the
  // marker block is state and must never be cut mid-way.
  const noDetails = render(presentational, ['', `_Details omitted (too long) — see ${seeRun}._`])
  if (noDetails.length <= MAX_BODY_CHARS) return noDetails

  // Clamp 2 (#3360): the details are not the only unbounded section. A run
  // with hundreds of findings blows the cap on the new/resolved lists alone,
  // and the old code returned that oversized body anyway — `gh issue edit`
  // then 422s, and because the same body is recomputed from the same unchanged
  // state next week, the job wedges red forever (#3257, in the sibling filer).
  const bare = render(
    [`_Per-run breakdown omitted to keep this body under the working limit — see ${seeRun}._`, ''],
    [],
  )
  if (bare.length <= MAX_BODY_CHARS) return bare

  // The state block alone does not fit. Fail with a diagnosis rather than
  // letting `gh issue edit` return a bare 422 nobody can act on.
  throw new Error(
    `the fuzz finding set outgrew a single issue body: ${all.length} finding(s) render to ${bare.length} chars, over the ${MAX_BODY_CHARS}-char cap (GitHub's hard limit is 65536). The machine-readable state block cannot be truncated without corrupting the tracked set. Triage the tracking issue down, or lower MAX_ID_CHARS (currently ${MAX_ID_CHARS}).`,
  )
}

export function buildNewFindingComment({ newOnes, byId, results = [], runUrl }) {
  const lines = []
  lines.push(...buildStatusSummary(results))
  lines.push(`${newOnes.length} new fuzz finding${newOnes.length === 1 ? '' : 's'} this run:`)
  lines.push('```')
  lines.push(...newOnes)
  lines.push('```')
  lines.push(...renderDetails(newOnes, byId))
  if (runUrl) lines.push('', `Run: ${runUrl}`)
  const text = lines.join('\n')
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : text
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
  return exact.toSorted((a, b) => b.number - a.number)[0]
}

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-findings-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, content, 'utf8')
  return fn(file)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, requireResults: false, requireTargetsManifest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--result-dir': {
        args.resultDir = argv[++i]
        break
      }
      case '--job-status': {
        args.jobStatus = argv[++i]
        break
      }
      case '--require-results': {
        args.requireResults = true
        break
      }
      case '--require-targets-manifest': {
        args.requireTargetsManifest = true
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
 * #3360 — the missing-vs-empty guards. Split out of `main` to keep its
 * cyclomatic complexity under the repo lint budget.
 *
 * Called AFTER `buildFindings` so the `[lane]` fallback still gets to describe
 * a lane that died outright. They fire only where that fallback does NOT: a
 * `failure`/`cancelled` lane is the `[lane]` finding's job, and a `skipped` one
 * never ran and legitimately wrote nothing — firing on either would replace a
 * filed report with a red filer. What is left is `success` (the lane ran to
 * completion, so it MUST have written results) and an unknown status (nothing
 * else would report the blindness at all).
 */
function assertLaneInputs(args, results) {
  const laneShouldHaveWritten = !args.jobStatus || args.jobStatus === 'success'
  if (args.requireResults && results.length === 0 && laneShouldHaveWritten) {
    throw new Error(
      `--require-results: no per-target results under ${args.resultDir ?? '(unset)'} (${resultDirDiagnosis(args.resultDir)}) for a fuzz lane reported as "${args.jobStatus || 'unknown'}". The lane writes targets.txt and pre-seeds every status BEFORE it fuzzes anything, so a lane that got that far always produces results — none means the fuzz-status artifact was lost, which is NOT the same as "no findings". Refusing to report a clean week from no data (#3360).`,
    )
  }
  if (args.requireTargetsManifest && resultDirDiagnosis(args.resultDir) === 'missing-manifest') {
    throw new Error(
      `--require-targets-manifest: ${args.resultDir} has per-target status files but no targets.txt, so the target list was inferred from whichever files arrived. A target whose files went missing then vanishes from the report entirely instead of being reported as not_run — a partial artifact reads as a shorter, healthier run (#3360).`,
    )
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY
  const runUrl = args.runUrl ?? defaultRunUrl()

  const results = parseTargetResults(args.resultDir)
  const current = buildFindings(results, args.jobStatus)

  const statusSummary =
    results.length > 0 ? results.map((r) => `${r.target}=${r.status}`).join(' ') : '(none)'
  console.log(`fuzz target statuses: ${statusSummary}`)
  console.log(`fuzz findings this run: ${current.length}`)

  assertLaneInputs(args, results)

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

  const known = parseKnownFindings(existingIssue?.body)
  const { newOnes, resolvedOnes, all, byId } = diffFindings(current, known)

  if (newOnes.length === 0) {
    console.log('no new fuzz findings — no-op (tracking issue left untouched)')
    if (resolvedOnes.length > 0) {
      console.log(
        `(${resolvedOnes.length} previously-known finding(s) no longer present — not a reason to touch the issue on their own: ${resolvedOnes.join(', ')})`,
      )
    }
    return
  }

  const body = buildIssueBody({ all, newOnes, resolvedOnes, byId, results, runUrl })
  const comment = buildNewFindingComment({ newOnes, byId, results, runUrl })

  if (args.dryRun) {
    // Compare to null explicitly — issue #0 is not a real GitHub issue
    // number, but the `--known-body-file` test stub uses 0 as a placeholder
    // and 0 is falsy, so a `existingIssue.number` truthiness check here
    // would misreport an existing issue as "not found".
    if (existingIssue === null) {
      console.log(`[dry-run] would CREATE a new issue titled "${TRACKING_ISSUE_TITLE}"`)
    } else {
      console.log(
        `[dry-run] would ${existingIssue.state === 'CLOSED' ? 'REOPEN + ' : ''}edit issue #${existingIssue.number}`,
      )
    }
    console.log(
      `[dry-run] new findings: ${newOnes.length}, resolved: ${resolvedOnes.length}, total known: ${all.length}`,
    )
    console.log('[dry-run] --- issue body ---')
    console.log(body)
    console.log('[dry-run] --- new-finding comment ---')
    console.log(comment)
    return
  }

  if (!repo) throw new Error('--repo (or $GITHUB_REPOSITORY) is required to file/update an issue')

  if (existingIssue === null) {
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
    console.log(`filed a new tracking issue (${newOnes.length} finding(s))`)
  } else {
    if (existingIssue.state === 'CLOSED') {
      execFileSync('gh', ['issue', 'reopen', String(existingIssue.number), '--repo', repo], {
        stdio: 'inherit',
      })
    }
    withTempFile(body, (bodyFile) => {
      execFileSync(
        'gh',
        ['issue', 'edit', String(existingIssue.number), '--repo', repo, '--body-file', bodyFile],
        { stdio: 'inherit' },
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
      `updated tracking issue #${existingIssue.number} (${newOnes.length} new finding(s))`,
    )
  }
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
//
// #3360 — this is the more complex of the two filers (libFuzzer log
// excerpting, MAX_EXCERPT_LINES/CHARS, marker-block state, the same unguarded
// `execFileSync('gh', ...)` write path) and was the less tested: it had no
// fixture suite at all while `file-mutation-survivors.mjs` did. It USED to
// run as the `fuzz-findings-filer-selftest` prek hook; #4556 Phase 1
// unwired that hook, so this suite runs only when invoked by hand until
// Phase 2 restages it.
//
// Every assertion is paired with its negative where one exists — a clamp that
// never clamps and a guard that never fires are the two ways this file could
// have looked tested without being tested.

/** Writes a fuzz-status result dir; `targets` may omit files to simulate a partial artifact. */
function fixtureResultDir({ manifest, files }) {
  const dir = mkdtempSync(join(tmpdir(), 'fuzz-selftest-'))
  if (manifest !== undefined) writeFileSync(join(dir, 'targets.txt'), manifest.join('\n'), 'utf8')
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}

function selfTestParsing({ ok, fail }) {
  // 1. The manifest is authoritative: a target listed in targets.txt but with
  //    no `.status` file reads as `not_run`, not as absent. That is the whole
  //    point of pre-seeding, and the reason a partial artifact is dangerous.
  {
    const dir = fixtureResultDir({
      manifest: ['alpha', 'beta'],
      files: { 'alpha.status': 'ok\n' },
    })
    const results = parseTargetResults(dir)
    if (
      results.length === 2 &&
      results[0].target === 'alpha' &&
      results[0].status === 'ok' &&
      results[1].target === 'beta' &&
      results[1].status === 'not_run'
    )
      ok('targets.txt is authoritative — a missing status file reads as not_run')
    else fail('targets.txt is authoritative', JSON.stringify(results.map((r) => r.status)))
  }

  // 2. …and without the manifest the same missing target simply DISAPPEARS.
  //    This is the damage `--require-targets-manifest` prevents, demonstrated
  //    rather than asserted about (#3360).
  {
    const dir = fixtureResultDir({ files: { 'alpha.status': 'ok\n' } })
    const results = parseTargetResults(dir)
    if (results.length === 1 && resultDirDiagnosis(dir) === 'missing-manifest')
      ok('without targets.txt a missing target vanishes rather than reporting not_run (#3360)')
    else
      fail(
        'without targets.txt a missing target vanishes',
        `${results.length} result(s), diagnosis=${resultDirDiagnosis(dir)}`,
      )
  }

  // 3. Diagnosis distinguishes the degraded shapes `parseTargetResults` flattens.
  {
    const okDir = fixtureResultDir({ manifest: ['alpha'], files: { 'alpha.status': 'ok' } })
    const emptyDir = fixtureResultDir({ files: {} })
    const cases = [
      ['ok', resultDirDiagnosis(okDir)],
      ['empty-dir', resultDirDiagnosis(emptyDir)],
      ['missing-dir', resultDirDiagnosis(join(emptyDir, 'nope'))],
      ['missing-dir', resultDirDiagnosis(undefined)],
    ]
    const bad = cases.filter(([want, got]) => want !== got)
    if (bad.length === 0) ok('resultDirDiagnosis separates ok / empty / missing')
    else fail('resultDirDiagnosis separates ok / empty / missing', JSON.stringify(cases))
  }

  // 4. Excerpt bounds. A libFuzzer log is thousands of lines; the excerpt must
  //    keep the TAIL (where the failure is) and stay under both caps.
  {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const excerpt = excerptFromLog(log)
    const excerptLines = excerpt.split('\n')
    if (
      excerptLines.length <= MAX_EXCERPT_LINES &&
      excerpt.length <= MAX_EXCERPT_CHARS + 1 &&
      excerpt.includes('line 499') &&
      !excerpt.includes('line 0\n')
    )
      ok('excerptFromLog keeps the bounded tail')
    else fail('excerptFromLog keeps the bounded tail', `${excerptLines.length} lines`)

    // The char cap bites independently of the line cap: 10 very long lines.
    const wide = Array.from({ length: 10 }, () => 'x'.repeat(1000)).join('\n')
    const wideExcerpt = excerptFromLog(wide)
    if (wideExcerpt.length <= MAX_EXCERPT_CHARS + 1 && wideExcerpt.startsWith('…'))
      ok('excerptFromLog enforces the char cap independently of the line cap')
    else fail('excerptFromLog enforces the char cap', `len=${wideExcerpt.length}`)

    // …and a short log is left completely alone (the negative case).
    if (excerptFromLog('a\nb') === 'a\nb') ok('a short log is not clamped')
    else fail('a short log is not clamped', excerptFromLog('a\nb'))
  }

  // 5. The `[build]` finding ID is only stable week-to-week if the compiler
  //    error line is extracted, not the whole log.
  {
    const log = ['warning: unused', '   error[E0432]: unresolved import `foo`', 'more'].join('\n')
    const got = firstCompilerError(log)
    if (got === 'error[E0432]: unresolved import `foo`')
      ok('firstCompilerError picks the rustc line')
    else fail('firstCompilerError picks the rustc line', got)
    if (firstCompilerError('all fine here') === '')
      ok('firstCompilerError returns empty on no error')
    else fail('firstCompilerError returns empty on no error', firstCompilerError('all fine here'))
    // Bounded: a 10K-char error line must not blow up a single-line finding ID.
    const huge = firstCompilerError(`error: ${'x'.repeat(10_000)}`)
    if (huge.length <= MAX_ID_CHARS && !huge.includes('\n')) ok('a huge compiler error is bounded')
    else fail('a huge compiler error is bounded', `len=${huge.length}`)
  }

  // 6. Reproducer extraction: the artifacts listing wins, the log is the
  //    fallback for when the artifacts dir did not survive the upload.
  {
    const fromArtifacts = reproducersFor({ artifacts: ['crash-abc123', 'README'], log: '' }, [
      'crash',
      'leak',
      'oom',
    ])
    const fromLog = reproducersFor(
      { artifacts: [], log: 'Test unit written to ./artifacts/x/crash-deadbeef' },
      ['crash', 'leak', 'oom'],
    )
    if (
      fromArtifacts.length === 1 &&
      fromArtifacts[0] === 'crash-abc123' &&
      fromLog.length === 1 &&
      fromLog[0] === 'crash-deadbeef'
    )
      ok('reproducersFor prefers artifacts and falls back to the log line')
    else
      fail(
        'reproducersFor prefers artifacts and falls back to the log line',
        `${JSON.stringify(fromArtifacts)} / ${JSON.stringify(fromLog)}`,
      )
  }
}

function selfTestFindings({ ok, fail }) {
  const r = (target, status, extra = {}) => ({
    target,
    status,
    log: '',
    artifacts: [],
    ...extra,
  })

  // 7. Every documented status maps to a finding except `ok`, which maps to
  //    none. A status that produced no finding at all would be a silently
  //    unreported failure.
  {
    const results = [
      r('a', 'ok'),
      r('b', 'build_failed', { log: 'error[E0433]: boom' }),
      r('c', 'crashed', { artifacts: ['crash-1'] }),
      r('d', 'timed_out'),
      r('e', 'not_run'),
      r('f', 'weird_new_status'),
    ]
    const ids = buildFindings(results, 'failure').map((f) => f.id)
    const wanted = ['[build] b:', '[crash] c:', '[timeout] d:', '[not-run] e:', '[failed] f:']
    const missing = wanted.filter((w) => !ids.some((id) => id.startsWith(w)))
    if (missing.length === 0 && ids.length === 5 && !ids.some((id) => id.includes(' a:')))
      ok('every non-ok status produces exactly one finding and `ok` produces none')
    else fail('every non-ok status produces a finding', `missing=${missing} ids=${ids.join(' | ')}`)
  }

  // 8. The `[lane]` fallback: no results + a failed lane must still report.
  //    And its negative — no results + a SUCCESSFUL lane reports nothing,
  //    which is exactly the hole `--require-results` covers.
  {
    const failed = buildFindings([], 'failure')
    const cancelled = buildFindings([], 'cancelled')
    const succeeded = buildFindings([], 'success')
    const skipped = buildFindings([], 'skipped')
    if (
      failed.length === 1 &&
      failed[0].id.startsWith('[lane]') &&
      cancelled.length === 1 &&
      succeeded.length === 0 &&
      skipped.length === 0
    )
      ok('the [lane] fallback fires for failure/cancelled only')
    else
      fail(
        'the [lane] fallback fires for failure/cancelled only',
        `${failed.length}/${cancelled.length}/${succeeded.length}/${skipped.length}`,
      )
  }
}

function selfTestBodyAndState({ ok, fail }) {
  const finding = (i) => ({
    id: `[crash] target_${i}: crash-${'a'.repeat(40)}${i}`,
    detail: `detail for ${i}\n`.repeat(20),
  })

  // 9. Round-trip: what `buildIssueBody` writes into the marker block is
  //    exactly what `parseKnownFindings` reads back. This is the script's only
  //    cross-run memory — a lossy round-trip re-reports every finding as new,
  //    forever.
  {
    const current = [finding(1), finding(2), finding(3)]
    const { newOnes, resolvedOnes, all, byId } = diffFindings(current, new Set())
    const body = buildIssueBody({ all, newOnes, resolvedOnes, byId, runUrl: 'https://example/run' })
    const reparsed = parseKnownFindings(body)
    if (reparsed.size === 3 && current.every((f) => reparsed.has(f.id)))
      ok('the marker block round-trips through parseKnownFindings')
    else fail('the marker block round-trips', `size=${reparsed.size}`)

    // A body with no marker block at all means "no issue yet", not "empty set
    // of findings" — both parse to an empty set, but the difference matters
    // for the caller, so pin the shapes that must NOT throw.
    if (parseKnownFindings('').size === 0 && parseKnownFindings(undefined).size === 0)
      ok('an absent body parses to an empty known set')
    else fail('an absent body parses to an empty known set', 'threw or non-empty')
  }

  // 10. Diff semantics: unchanged findings are not "new" (the no-spam
  //     property), and a disappeared one is "resolved".
  {
    const known = new Set([finding(1).id, finding(2).id])
    const { newOnes, resolvedOnes } = diffFindings([finding(1), finding(3)], known)
    if (
      newOnes.length === 1 &&
      newOnes[0] === finding(3).id &&
      resolvedOnes.length === 1 &&
      resolvedOnes[0] === finding(2).id
    )
      ok('diffFindings reports only genuinely new and genuinely gone findings')
    else fail('diffFindings reports new/resolved', JSON.stringify({ newOnes, resolvedOnes }))
  }

  selfTestClampLadder({ ok, fail, finding })
}

/**
 * The body clamp ladder (#3257-class, extended by #3360). Split out of
 * `selfTestBodyAndState` to keep its cyclomatic complexity under the repo lint
 * budget.
 */
/**
 * Assertion 12 alone — split out to keep `selfTestClampLadder` under the repo's
 * cyclomatic-complexity lint budget once the rung classification was added.
 */
function selfTestClampRung2({ ok, fail, finding }) {
  const current = Array.from({ length: 650 }, (_, i) => finding(i))
  const { newOnes, resolvedOnes, all, byId } = diffFindings(current, new Set())
  // Caught, not propagated: with clamp 2 removed this fixture falls through to
  // clamp 3's throw, and an unhandled exception here would abort the whole
  // suite before the remaining assertions ran.
  let body = null
  let threw = null
  try {
    body = buildIssueBody({ all, newOnes, resolvedOnes, byId, runUrl: 'https://example/run' })
  } catch (err) {
    threw = err
  }
  const rung =
    body === null
      ? `threw (${threw.message.slice(0, 60)}…)`
      : body.includes('Per-run breakdown omitted')
        ? 'clamp2'
        : body.includes('Details omitted')
          ? 'clamp1 (NOT the rung under test)'
          : 'full (NOT the rung under test)'
  if (rung === 'clamp2' && body.length <= MAX_BODY_CHARS && parseKnownFindings(body).size === 650)
    ok('a body oversized by its per-run lists alone is clamped, not returned oversized (#3360)')
  else
    fail(
      'a body oversized by its per-run lists alone is clamped',
      `rung=${rung} len=${body?.length ?? 0} cap=${MAX_BODY_CHARS}`,
    )
}

function selfTestClampLadder({ ok, fail, finding }) {
  // 11. Clamp ladder step 1 (details dropped, state intact). ~250 findings
  //     with 20-line details render well past the 60K cap on details alone.
  {
    const current = Array.from({ length: 250 }, (_, i) => finding(i))
    const { newOnes, resolvedOnes, all, byId } = diffFindings(
      current,
      new Set(current.map((f) => f.id)),
    )
    const body = buildIssueBody({ all, newOnes, resolvedOnes, byId, runUrl: 'https://example/run' })
    const reparsed = parseKnownFindings(body)
    if (body.length <= MAX_BODY_CHARS && body.includes('Details omitted') && reparsed.size === 250)
      ok('an oversized body drops Details and keeps the state block whole (#3257-class)')
    else
      fail(
        'an oversized body drops Details and keeps the state block whole',
        `len=${body.length} reparsed=${reparsed.size}`,
      )
  }

  // 12. Clamp ladder step 2: the presentational new/resolved lists are
  //     themselves unbounded. Before #3360 the function returned an oversized
  //     body regardless — `gh issue edit` 422s and, because the same body is
  //     recomputed from the same state next week, the job wedges red forever.
  //
  //     The fixture size and the marker assertion are BOTH load-bearing, and
  //     both were added in review. With this `finding()` shape the rungs
  //     switch at n=108 (full → clamp 1), n=424 (clamp 1 → clamp 2) and n=844
  //     (clamp 2 → throw). The original fixture used n=400, which lands on
  //     CLAMP 1 — so this assertion was a duplicate of #11 and stayed green
  //     with clamp 2 deleted outright, i.e. the one rung #3360 added was the
  //     one rung untested. n=650 is the midpoint of the clamp-2 window, and
  //     asserting clamp 2's own marker text binds the assertion to the rung it
  //     names instead of to "some clamp happened".
  selfTestClampRung2({ ok, fail, finding })

  // 13. Clamp ladder step 3: when the STATE BLOCK alone cannot fit, throwing
  //     an actionable error beats a raw 422.
  {
    const current = Array.from({ length: 3000 }, (_, i) => finding(i))
    const { newOnes, resolvedOnes, all, byId } = diffFindings(current, new Set())
    let threw = null
    let len = 0
    try {
      len = buildIssueBody({ all, newOnes, resolvedOnes, byId, runUrl: undefined }).length
    } catch (err) {
      threw = err
    }
    if (threw && /outgrew a single issue body/.test(threw.message))
      ok('an unclampable state block fails with a diagnosis, not a raw 422 (#3360)')
    else fail('an unclampable state block fails with a diagnosis', threw?.message ?? `len=${len}`)
  }

  // 14. The negative for 11–13: a small body is left completely alone.
  {
    const current = [finding(1)]
    const { newOnes, resolvedOnes, all, byId } = diffFindings(current, new Set())
    const body = buildIssueBody({
      all,
      newOnes,
      resolvedOnes,
      byId,
      results: [{ target: 'alpha', status: 'crashed' }],
      runUrl: 'https://example/run',
    })
    if (!body.includes('omitted') && body.includes('### Details') && body.includes('alpha'))
      ok('a small body keeps its details, status table and per-run sections')
    else fail('a small body is not clamped', body.slice(0, 200))
  }

  // 15. The per-run COMMENT hits the same 65536 limit as the body — capping
  //     only the body would move the 422 one `gh` call down.
  {
    const current = Array.from({ length: 3000 }, (_, i) => finding(i))
    const { newOnes, byId } = diffFindings(current, new Set())
    const comment = buildNewFindingComment({ newOnes, byId, runUrl: 'https://example/run' })
    if (comment.length <= MAX_BODY_CHARS + 20 && comment.includes('truncated'))
      ok('an oversized per-run comment is truncated')
    else fail('an oversized per-run comment is truncated', `len=${comment.length}`)
  }

  // 16. The status table names every target, passing ones included — the
  //     property that keeps a skipped target from being invisible (#3169).
  {
    const results = [
      { target: 'alpha', status: 'ok' },
      { target: 'beta', status: 'not_run' },
    ]
    const summary = buildStatusSummary(results).join('\n')
    if (summary.includes('alpha') && summary.includes('beta') && summary.includes('1 of 2'))
      ok('the status table lists passing targets too')
    else fail('the status table lists passing targets too', summary)
  }
}

function selfTestCliGuards({ ok, fail }) {
  const root = mkdtempSync(join(tmpdir(), 'fuzz-selftest-cli-'))
  const emptyDir = join(root, 'empty')
  mkdirSync(emptyDir)
  const partialDir = join(root, 'partial')
  mkdirSync(partialDir)
  writeFileSync(join(partialDir, 'alpha.status'), 'ok\n')
  const fullDir = join(root, 'full')
  mkdirSync(fullDir)
  writeFileSync(join(fullDir, 'targets.txt'), 'alpha\nbeta\n')
  writeFileSync(join(fullDir, 'alpha.status'), 'ok\n')
  writeFileSync(join(fullDir, 'beta.status'), 'ok\n')
  const absent = join(root, 'nope')

  // `main()` runs in --dry-run + --known-body-file mode throughout, so no `gh`
  // process is ever spawned. Belt and braces: PATH is emptied for the duration,
  // so an accidental `execFileSync('gh', …)` would ENOENT rather than reach
  // the network — an assertion the dry-run flag alone cannot make.
  const runQuiet = (argv) => {
    const realLog = console.log
    const realPath = process.env.PATH
    console.log = () => {}
    process.env.PATH = ''
    try {
      main(argv)
      return null
    } catch (err) {
      return err
    } finally {
      console.log = realLog
      process.env.PATH = realPath
    }
  }
  const base = ['--dry-run', '--known-body-file', join(root, 'no-such-body.md')]

  // 17. The guards fire on exactly the shapes they were added for.
  const badCases = [
    [
      'a lost artifact on a SUCCESSFUL lane fails --require-results (#3360)',
      [...base, '--result-dir', absent, '--job-status', 'success', '--require-results'],
      /no per-target results/,
    ],
    [
      'an EMPTY artifact fails --require-results too — empty is still no data',
      [...base, '--result-dir', emptyDir, '--job-status', 'success', '--require-results'],
      /no per-target results/,
    ],
    [
      'an unknown job status fails --require-results (nothing else would report it)',
      [...base, '--result-dir', absent, '--require-results'],
      /no per-target results/,
    ],
    [
      'a manifest-less partial artifact fails --require-targets-manifest (#3360)',
      [
        ...base,
        '--result-dir',
        partialDir,
        '--job-status',
        'success',
        '--require-targets-manifest',
      ],
      /no targets\.txt/,
    ],
  ]
  for (const [name, argv, pattern] of badCases) {
    const err = runQuiet(argv)
    if (err && pattern.test(err.message)) ok(name)
    else fail(name, err ? err.message : 'did not throw')
  }

  // 18. …and stay silent on everything else, or they are just a permanently
  //     red weekly job. Note the FAILED-lane case: the `[lane]` finding is the
  //     report there, so --require-results must NOT pre-empt it.
  const okCases = [
    [
      'a complete artifact passes both guards',
      [
        ...base,
        '--result-dir',
        fullDir,
        '--job-status',
        'success',
        '--require-results',
        '--require-targets-manifest',
      ],
    ],
    [
      'a lane that FAILED with no artifact still files the [lane] finding rather than erroring',
      [...base, '--result-dir', absent, '--job-status', 'failure', '--require-results'],
    ],
    [
      'a SKIPPED lane with no artifact is not an error',
      [...base, '--result-dir', absent, '--job-status', 'skipped', '--require-results'],
    ],
    [
      'the guards are opt-in: without the flags a missing artifact is still tolerated',
      [...base, '--result-dir', absent, '--job-status', 'success'],
    ],
    [
      'a manifest-less artifact is tolerated without --require-targets-manifest',
      [...base, '--result-dir', partialDir, '--job-status', 'success'],
    ],
  ]
  for (const [name, argv] of okCases) {
    const err = runQuiet(argv)
    if (err === null) ok(name)
    else fail(name, err.message)
  }

  // 19. An unknown flag is a hard error, not a silently ignored typo — a
  //     mistyped `--require-results` would otherwise disarm the guard.
  {
    const err = runQuiet([...base, '--require-reslts'])
    if (err && /unrecognized argument/.test(err.message)) ok('an unrecognized flag is rejected')
    else fail('an unrecognized flag is rejected', err ? err.message : 'did not throw')
  }
}

function runSelfTest() {
  const failures = []
  const ok = (name) => console.log(`  ok   - ${name}`)
  const fail = (name, detail) => {
    failures.push(name)
    console.error(`  FAIL - ${name}: ${detail}`)
  }

  selfTestParsing({ ok, fail })
  selfTestFindings({ ok, fail })
  selfTestBodyAndState({ ok, fail })
  selfTestCliGuards({ ok, fail })

  if (failures.length > 0) {
    console.error(`\nself-test: ${failures.length} assertion(s) failed`)
    process.exit(2)
  }
  console.log('self-test: all assertions passed')
}

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  if (process.argv.slice(2).includes('--self-test')) {
    runSelfTest()
  } else {
    try {
      main()
    } catch (err) {
      console.error(`file-fuzz-findings: ${err.message}`)
      process.exit(1)
    }
  }
}
