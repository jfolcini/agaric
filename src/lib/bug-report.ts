/**
 * Bug-report URL and Markdown body composition helpers (FEAT-5).
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

/** Input to [`buildGitHubIssueUrl`]. `labels` may be empty; if it is, no
 *  `labels=` query parameter is emitted. */
export interface BuildIssueUrlParams extends TrackerTarget {
  title: string
  body: string
  labels?: readonly string[]
}

/** Compose a `https://github.com/:owner/:repo/issues/new` URL with the
 *  title/body (and optional labels) URL-encoded into the query string.
 *
 *  Bodies exceeding [`MAX_BODY_CHARS`] are truncated with
 *  [`TRUNCATION_MARKER`] so the resulting URL is guaranteed to stay within
 *  GitHub's prefill limits. The title is NOT capped — reasonable titles are
 *  short, and cutting a user-typed title would be jarring. */
export function buildGitHubIssueUrl(params: BuildIssueUrlParams): string {
  const { owner, repo, title, body, labels } = params

  const effectiveBody =
    body.length > MAX_BODY_CHARS
      ? body.slice(0, MAX_BODY_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
      : body

  const query = new URLSearchParams()
  query.set('title', title)
  query.set('body', effectiveBody)
  if (labels && labels.length > 0) {
    query.set('labels', labels.join(','))
  }

  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new?${query.toString()}`
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
 *    2. Environment block (app version, OS, arch, device ID).
 *    3. Recent errors list (if any).
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
    `- **Device ID:** \`${metadata.device_id}\``,
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

/** Re-exported for tests so the cap stays in one place. */
export const _internals = {
  MAX_BODY_CHARS,
  TRUNCATION_MARKER,
}
