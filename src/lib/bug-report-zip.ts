/**
 * ZIP composition for the bug-report export (FEAT-5).
 *
 * Mirrors `src/lib/export-graph.ts`: JSZip-based, no new Rust dep, no new
 * Tauri plugin. The returned `Blob` is handed to `downloadBlob` (same
 * module) which routes through the browser's `a[download]` machinery — on
 * desktop this opens the platform save-as dialog; on Android the webview's
 * download manager drops the file in the system Downloads directory.
 */

import JSZip from 'jszip'

import type { BugReport, LogFileEntry } from './tauri'

/**
 * #840: the exact sentinel the backend redaction pipeline writes in place of
 * the device ID inside `logs/*` (see `bug_report.rs` —
 * `replacements.push("[REDACTED_DEVICE_ID]")`). Reused here verbatim so the
 * ZIP gets consistent treatment: when the redact toggle is ON, `metadata.json`
 * scrubs `device_id` to the SAME token the logs use.
 */
const REDACTED_DEVICE_ID = '[REDACTED_DEVICE_ID]'

/**
 * Build the ZIP bundle shipped alongside a GitHub bug report.
 *
 * Layout:
 *  - `metadata.json` — the serialised [`BugReport`] object.
 *  - `logs/<name>` — every entry from `entries`, one file per log.
 *
 * Empty entries are valid; the resulting ZIP will still include
 * `metadata.json` so triage can see the app version (and, when redaction is
 * off, the device ID) even when the user chose not to include logs.
 *
 * #840: when `redact` is ON the `device_id` field of `metadata.json` is
 * scrubbed to [`REDACTED_DEVICE_ID`] — the same sentinel the backend uses for
 * `logs/*` — so the whole archive is treated consistently. Previously this
 * field was left in cleartext "so triage can see the device ID", which leaked
 * the identifier into ZIPs users attach to public issues. When `redact` is OFF
 * (the default for the existing two-argument call sites) behaviour is
 * unchanged.
 */
export function buildReportZip(
  entries: readonly LogFileEntry[],
  metadata: BugReport,
  redact = false,
): Promise<Blob> {
  const zip = new JSZip()
  const metadataForZip: BugReport = redact
    ? { ...metadata, device_id: REDACTED_DEVICE_ID }
    : metadata
  zip.file('metadata.json', JSON.stringify(metadataForZip, null, 2))
  const logsDir = zip.folder('logs')
  if (logsDir) {
    for (const entry of entries) {
      logsDir.file(entry.name, entry.contents)
    }
  }
  return zip.generateAsync({ type: 'blob' })
}

/**
 * Return a deterministic `agaric-bug-report-YYYY-MM-DD.zip` filename for
 * today. Pure; takes an explicit `now` so tests can pin the value.
 */
export function bugReportZipFilename(now: Date = new Date()): string {
  const year = now.getFullYear().toString().padStart(4, '0')
  const month = (now.getMonth() + 1).toString().padStart(2, '0')
  const day = now.getDate().toString().padStart(2, '0')
  return `agaric-bug-report-${year}-${month}-${day}.zip`
}
