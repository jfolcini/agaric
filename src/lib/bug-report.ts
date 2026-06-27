/**
 * Bug-report URL and Markdown body composition helpers.
 *
 * Pure functions. No side effects. No IPC. No DOM access. Every call site
 * in the React dialog composes its inputs from component state + the
 * metadata returned by `collect_bug_report_metadata`, then hands the
 * result to `openUrl` / clipboard / preview.
 */

import type { BugReport } from './tauri'

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

/** Input to [`formatReportBody`]. */
export interface FormatReportBodyParams {
  metadata: BugReport
  description: string
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
 *    2. Environment block (app version, OS, arch, truncated device ID).
 *    3. Recent errors list (if any) — already redacted by the backend
 *       (#609: `collect_bug_report_metadata` runs the tail through the
 *       same pipeline as the ZIP export before it ever reaches the UI).
 *    4. Attachment reminder (if `zipFileName` supplied).
 */
export function formatReportBody(params: FormatReportBodyParams): string {
  const { metadata, description, zipFileName } = params

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
  const { metadata, title, description, zipFileName } = params

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
