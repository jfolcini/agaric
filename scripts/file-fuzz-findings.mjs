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
// call failing).

import { execFileSync } from 'node:child_process'
import {
  existsSync,
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

// Entry-point check (#3373): realpath BOTH sides — `import.meta.filename` is the
// RESOLVED path while `process.argv[1]` is the path AS INVOKED, so a naive
// comparison is false through a symlink and the script exits 0 having run nothing.
const isMainModule =
  !!process.argv[1] && realpathSync(import.meta.filename) === realpathSync(process.argv[1])
if (isMainModule) {
  try {
    main()
  } catch (err) {
    console.error(`file-fuzz-findings: ${err.message}`)
    process.exit(1)
  }
}
