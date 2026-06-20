import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { bugReportZipFilename, buildReportZip } from '../bug-report-zip'
import type { BugReport, LogFileEntry } from '../tauri'

const METADATA: BugReport = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: 'DEV-001',
  recent_errors: [],
}

describe('buildReportZip', () => {
  it('creates a ZIP with metadata.json + logs/<name> for each entry', async () => {
    const entries: LogFileEntry[] = [
      { name: 'agaric.log', contents: 'today content\n' },
      { name: 'agaric.log.2025-01-01', contents: 'yesterday content\n' },
    ]

    const blob = await buildReportZip(entries, METADATA)

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)

    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files).toSorted()).toEqual([
      'logs/',
      'logs/agaric.log',
      'logs/agaric.log.2025-01-01',
      'metadata.json',
    ])

    const metaFile = unzipped.file('metadata.json')
    expect(metaFile).not.toBeNull()
    const metaRaw = await (metaFile as JSZip.JSZipObject).async('string')
    expect(JSON.parse(metaRaw)).toEqual(METADATA)

    const todayFile = unzipped.file('logs/agaric.log')
    expect(todayFile).not.toBeNull()
    const todayContents = await (todayFile as JSZip.JSZipObject).async('string')
    expect(todayContents).toBe('today content\n')
  })

  // #840: with the redact toggle ON, metadata.json's device_id must be
  // scrubbed to the SAME sentinel the backend writes into logs/*.
  it('scrubs device_id in metadata.json when redact is ON', async () => {
    // The exact token the backend redaction pipeline writes for logs/*
    // (src-tauri/src/commands/bug_report.rs). Pinned here so a drift in
    // either side surfaces as a test failure.
    const REDACTED_DEVICE_ID = '[REDACTED_DEVICE_ID]'

    const entries: LogFileEntry[] = [
      { name: 'agaric.log', contents: `device=${REDACTED_DEVICE_ID} ok\n` },
    ]

    const blob = await buildReportZip(entries, METADATA, true)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())

    const metaFile = unzipped.file('metadata.json')
    expect(metaFile).not.toBeNull()
    const meta = JSON.parse(await (metaFile as JSZip.JSZipObject).async('string')) as BugReport
    expect(meta.device_id).toBe(REDACTED_DEVICE_ID)
    // The cleartext id must not survive anywhere in the metadata.
    expect(meta.device_id).not.toBe(METADATA.device_id)

    // Consistency: metadata.json uses the very token logs/* carry.
    const logFile = unzipped.file('logs/agaric.log')
    const logContents = await (logFile as JSZip.JSZipObject).async('string')
    expect(logContents).toContain(meta.device_id)

    // The rest of the metadata shape is otherwise identical.
    expect(meta).toEqual({ ...METADATA, device_id: REDACTED_DEVICE_ID })
  })

  // #840: with redact OFF (the default), device_id stays cleartext.
  it('keeps the real device_id in metadata.json when redact is OFF', async () => {
    const blobDefault = await buildReportZip([], METADATA)
    const blobExplicit = await buildReportZip([], METADATA, false)

    for (const blob of [blobDefault, blobExplicit]) {
      const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
      const metaRaw = await (unzipped.file('metadata.json') as JSZip.JSZipObject).async('string')
      expect(JSON.parse(metaRaw)).toEqual(METADATA)
    }
  })

  it('produces a valid ZIP with only metadata.json when entries is empty', async () => {
    const blob = await buildReportZip([], METADATA)

    expect(blob).toBeInstanceOf(Blob)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const files = Object.keys(unzipped.files)
    expect(files).toContain('metadata.json')
    // Should still include the logs folder entry (JSZip creates it) but no
    // files inside — assert no concrete log files are present.
    const logFiles = files.filter((f) => f.startsWith('logs/') && f !== 'logs/')
    expect(logFiles).toHaveLength(0)
  })
})

describe('bugReportZipFilename', () => {
  it('formats the filename as agaric-bug-report-YYYY-MM-DD.zip', () => {
    const fixed = new Date('2025-01-15T12:34:56Z')
    // Use local components since the implementation relies on local time.
    const year = fixed.getFullYear().toString().padStart(4, '0')
    const month = (fixed.getMonth() + 1).toString().padStart(2, '0')
    const day = fixed.getDate().toString().padStart(2, '0')
    expect(bugReportZipFilename(fixed)).toBe(`agaric-bug-report-${year}-${month}-${day}.zip`)
  })

  it('pads single-digit months and days to two characters', () => {
    // Year/month/day all single-digit when expressed numerically.
    const d = new Date(2025, 0, 1) // January 1st
    expect(bugReportZipFilename(d)).toBe('agaric-bug-report-2025-01-01.zip')
  })
})
