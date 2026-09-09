/**
 * Bug-report URL and Markdown body composition helpers.
 *
 * Pure functions. No side effects. No IPC. No DOM access. Every call site
 * in the React dialog composes its inputs from component state + the
 * metadata returned by `collect_bug_report_metadata`, then hands the
 * result to `openUrl` / clipboard / preview.
 */

import type { BugReport, ReconciliationReport } from '@/lib/bindings'

/** Cap the URL-encoded body at this many characters. GitHub silently drops
 *  prefill bodies past ~8 KB in the wild; 7000 keeps us well below even the
 *  most conservative browser-side URL ceilings while leaving headroom for
 *  the title + query-string plumbing. */
const MAX_BODY_CHARS = 7000

/** Ellipsis marker appended to truncated bodies. Users reading the issue
 *  should see this and know to check the attached ZIP for full context. */
const TRUNCATION_MARKER = '\n\n…[truncated — full log available in the attached ZIP if enabled]'

/** GitHub-owner/repo pair. Kept minimal on purpose — any concrete call site
 *  should source this from `src/lib/config.ts` so the tracker URL moves in
 *  lockstep with `tauri.conf.json`'s updater endpoint. */
export interface TrackerTarget {
  owner: string
  repo: string
}

/** Filename of the repo's bug-report issue *form*
 *  (`.github/ISSUE_TEMPLATE/bug_report.yml`). The repo sets
 *  `blank_issues_enabled: false`, so the prefill URL MUST target a template:
 *  a bare `issues/new?body=…` hits the now-disabled blank-issue route and
 *  GitHub responds with HTTP 500 (most visibly after the logged-out
 *  login → `return_to` redirect, where the user reported the failure). */
export const BUG_REPORT_TEMPLATE = 'bug_report.yml'

/** Input to [`buildGitHubIssueUrl`].
 *
 *  `fields` maps issue-form field *ids* (as declared in the target template's
 *  YAML) to prefill values. GitHub issue forms ONLY honor query params whose
 *  names match a field id — a `body` param is not recognised — so we emit one
 *  query param per field. Empty values are dropped. */
export interface BuildIssueUrlParams extends TrackerTarget {
  /** Issue-form template filename, e.g. [`BUG_REPORT_TEMPLATE`]. */
  template: string
  /** Optional issue title. When empty/omitted, the template's own default
   *  title prefix is kept instead of being overridden. */
  title?: string
  /** Issue-form field id → prefill value. */
  fields: Readonly<Record<string, string>>
}

/** Compose a `https://github.com/:owner/:repo/issues/new` URL that targets an
 *  issue-form `template` and prefills its fields via per-field query params.
 *
 *  Field values are emitted verbatim — callers cap any large field (see
 *  [`formatReportFields`], which bounds `logs` with [`TRUNCATION_MARKER`]) so
 *  the URL stays within GitHub's prefill / login-`return_to` limits. The title
 *  is not capped — reasonable titles are short. */
export function buildGitHubIssueUrl(params: BuildIssueUrlParams): string {
  const { owner, repo, template, title, fields } = params

  const query = new URLSearchParams()
  query.set('template', template)
  // Only override the template's default title when the user supplied one.
  if (title !== undefined && title.trim().length > 0) {
    query.set('title', title.trim())
  }
  // One query param per non-empty field id. Params that don't match a field
  // id are ignored by GitHub, so emitting only populated ids keeps it clean.
  for (const [id, value] of Object.entries(fields)) {
    if (value.length > 0) {
      query.set(id, value)
    }
  }

  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new?${query.toString()}`
}

/** #609: number of leading device-ID characters kept in the issue body.
 *  The full device ID is a stable per-device identifier that the backend's
 *  redaction pipeline scrubs to `[REDACTED_DEVICE_ID]` in the ZIP export —
 *  printing it in cleartext in a PUBLIC GitHub issue was internally
 *  inconsistent. Eight characters (the first UUID segment) are enough to
 *  disambiguate the reporter's devices within one issue thread without
 *  exposing the full identifier. */
const DEVICE_ID_PREFIX_CHARS = 8

/** #609: truncate a device ID for inclusion in a public issue body. IDs at
 *  or under [`DEVICE_ID_PREFIX_CHARS`] chars pass through unchanged (they
 *  already reveal no more than the truncated form would). */
export function truncateDeviceId(deviceId: string): string {
  return deviceId.length <= DEVICE_ID_PREFIX_CHARS
    ? deviceId
    : `${deviceId.slice(0, DEVICE_ID_PREFIX_CHARS)}…`
}

/** #4854: age buckets for the retry-queue line, coarsest unit that is not zero.
 *  A local formatter rather than `formatRelativeTime`, which resolves through
 *  `t()` — this body is a deterministic English GitHub issue, and a
 *  locale-dependent one would make the snapshot test and the issue itself
 *  disagree with each other depending on who filed it. */
const AGE_UNITS: ReadonlyArray<readonly [ms: number, suffix: string]> = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
]

function formatQueueAge(ms: number): string {
  const unit = AGE_UNITS.find(([size]) => ms >= size)
  return unit === undefined ? '<1m' : `${Math.floor(ms / unit[0])}${unit[1]}`
}

/** #4854: one Environment line describing `materializer_retry_queue`.
 *
 *  Derived views are rebuilt by background tasks, and a task that failed or
 *  that a saturated queue shed waits here. A deep or old queue is a vault
 *  whose derived state is behind — which is what "my page count is wrong"
 *  looks like from the inside. Always rendered, including when the queue is
 *  empty: an absent line has to mean "reported by a build older than #4854",
 *  not "healthy", or the line proves nothing when it is missing. */
export function formatRetryQueue(summary: BugReport['retry_queue']): string {
  if (summary === null) return '_(unavailable)_'
  if (summary.depth === 0) return 'empty'

  const parts = [`${summary.depth} task${summary.depth === 1 ? '' : 's'}`]
  if (summary.oldest_age_ms !== null) {
    parts.push(`oldest ${formatQueueAge(summary.oldest_age_ms)}`)
  }
  parts.push(`max ${summary.max_attempts} attempt${summary.max_attempts === 1 ? '' : 's'}`)
  return `${parts.join(', ')} (${summary.task_kinds.join(', ')})`
}

/** #4886: the `## Integrity check` section — the reconciliation oracle's
 *  report, rendered for a human reading a GitHub issue.
 *
 *  English and deterministic for the same reason `formatRetryQueue` is: the
 *  issue body must read the same whoever filed it. `blocks_scanned` leads the
 *  clean line because zero divergences over zero blocks describes an empty
 *  vault rather than a healthy one, and `today` is recorded because the
 *  projected-agenda rebuild is the one artefact pinned to a calendar date.
 *
 *  Sample keys are the backend's — at most ten per artefact, ids and dates
 *  only, never the diverging values (#609: this body is public). */
export function formatIntegrityReport(report: ReconciliationReport): string {
  const scanned = `${report.blocks_scanned} block${report.blocks_scanned === 1 ? '' : 's'} scanned`
  if (report.total_divergences === 0) {
    return `## Integrity check\n\nNo divergences — ${scanned}, ${report.today}.`
  }
  const lines = report.artefacts.map((a) => {
    const rows = `${a.count} row${a.count === 1 ? '' : 's'}`
    const keys = a.sample_keys.length > 0 ? `: ${a.sample_keys.join(', ')}` : ''
    return `- \`${a.artefact}\` — ${rows}${keys}`
  })
  return [
    '## Integrity check',
    `${report.total_divergences} divergence${report.total_divergences === 1 ? '' : 's'} over ${scanned}, ${report.today}.`,
    lines.join('\n'),
  ].join('\n\n')
}

/** Input to [`formatReportBody`]. */
export interface FormatReportBodyParams {
  metadata: BugReport
  description: string
  /** #4886: the reconciliation-oracle report, when the user has the integrity
   *  check turned on. Absent means the check is off — it is opt-in by
   *  construction, so an absent section has exactly one meaning and needs no
   *  "unavailable" placeholder the way the always-rendered retry-queue line
   *  does. */
  reconciliation?: ReconciliationReport | undefined
  /** Filename the user will attach to the issue after the dialog saves the
   *  ZIP to disk. When present, the body includes a one-line reminder to
   *  attach it. */
  zipFileName?: string | undefined
}

/** Produce the deterministic Markdown body embedded in the prefilled issue
 *  URL and — redundantly — rendered in the dialog's preview pane so the
 *  user can see exactly what will be shared before clicking "Open in
 *  GitHub".
 *
 *  Output layout (stable, snapshot-tested):
 *    1. User description (or a placeholder line).
 *    2. Environment block (app version, OS, arch, truncated device ID, and
 *       the retry-queue line #4854 adds — see `formatRetryQueue`).
 *    3. Recent errors list (if any) — already redacted by the backend
 *       (#609: `collect_bug_report_metadata` runs the tail through the
 *       same pipeline as the ZIP export before it ever reaches the UI).
 *    4. Integrity check (#4886, only when `reconciliation` is supplied).
 *    5. Attachment reminder (if `zipFileName` supplied).
 */
export function formatReportBody(params: FormatReportBodyParams): string {
  const { metadata, description, zipFileName, reconciliation } = params

  const sections: string[] = []

  sections.push('## Description')
  sections.push(description.trim().length > 0 ? description.trim() : '_(no description)_')

  sections.push('## Environment')
  const envLines = [
    `- **App version:** \`${metadata.app_version}\``,
    `- **OS:** \`${metadata.os}\``,
    `- **Arch:** \`${metadata.arch}\``,
    // #609: never embed the full device ID in a public issue — the same
    // identifier is scrubbed to [REDACTED_DEVICE_ID] in the ZIP export.
    `- **Device ID:** \`${truncateDeviceId(metadata.device_id)}\` _(truncated)_`,
    `- **Retry queue:** ${formatRetryQueue(metadata.retry_queue)}`,
  ]
  sections.push(envLines.join('\n'))

  sections.push('## Recent errors')
  if (metadata.recent_errors.length === 0) {
    sections.push('_(no recent errors)_')
  } else {
    // Keep the fence + body + fence as a single section so `join('\n\n')`
    // does not insert blank lines inside the code block.
    sections.push(`\`\`\`\n${metadata.recent_errors.join('\n')}\n\`\`\``)
  }

  if (reconciliation !== undefined) {
    sections.push(formatIntegrityReport(reconciliation))
  }

  if (zipFileName !== undefined && zipFileName.length > 0) {
    sections.push('## Attachments')
    sections.push(`Please attach the saved \`${zipFileName}\` to this issue before submitting.`)
  }

  return sections.join('\n\n')
}

/** Input to [`formatReportFields`]. */
export interface FormatReportFieldsParams {
  metadata: BugReport
  /** Short issue title (the dialog's "Short title" field) → the form's
   *  required `summary` field. */
  title: string
  /** Free-text "what went wrong" (the dialog's description) → the form's
   *  `actual` field. */
  description: string
  /** When the user opted to attach diagnostics, the ZIP filename to remind
   *  them to attach (surfaced in the `notes` field). */
  zipFileName?: string | undefined
  /** #4886: see [`FormatReportBodyParams.reconciliation`]. Rendered into the
   *  form's `notes` field so the FILED issue carries the section, not only
   *  the clipboard copy. */
  reconciliation?: ReconciliationReport | undefined
}

/** Map a bug report onto the `bug_report.yml` issue-form field ids.
 *
 *  The return type is left inferred — an anonymous object type with named,
 *  always-present `string` properties. That keeps callers index-signature-free
 *  (so `fields.summary` is legal under `noPropertyAccessFromIndexSignature`
 *  and never `string | undefined`) while staying assignable to
 *  [`BuildIssueUrlParams.fields`]'s `Record<string, string>`.
 *
 *  Only fields the app can populate are returned; the form's other required
 *  fields (reproduction steps, expected behaviour, platform, the "Before you
 *  file" checkboxes) are left for the user to complete in GitHub. The `logs`
 *  field is capped at [`MAX_BODY_CHARS`] (with [`TRUNCATION_MARKER`]) — it is
 *  the one unbounded input, and the full log is available in the diagnostic
 *  ZIP. The device ID is truncated (#609) before it can reach a public issue. */
export function formatReportFields(params: FormatReportFieldsParams) {
  const { metadata, title, description, zipFileName, reconciliation } = params

  const rawLogs = metadata.recent_errors.join('\n')
  const logs =
    rawLogs.length > MAX_BODY_CHARS
      ? rawLogs.slice(0, MAX_BODY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
      : rawLogs

  const notesLines = [
    `Arch: ${metadata.arch}`,
    // #609: never embed the full device ID in a public issue — the same
    // identifier is scrubbed to [REDACTED_DEVICE_ID] in the ZIP export.
    `Device ID: ${truncateDeviceId(metadata.device_id)} (truncated)`,
  ]
  if (zipFileName !== undefined && zipFileName.length > 0) {
    notesLines.push(`Diagnostic ZIP to attach: ${zipFileName}`)
  }
  if (reconciliation !== undefined) {
    notesLines.push(formatIntegrityReport(reconciliation))
  }

  return {
    summary: title.trim(),
    actual: description.trim(),
    version: metadata.app_version,
    os: metadata.os,
    logs,
    notes: notesLines.join('\n'),
  }
}

/** Re-exported for tests so the cap stays in one place. */
export const _internals = {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
}
