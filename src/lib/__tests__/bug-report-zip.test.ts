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
    expect(Object.keys(unzipped.files).sort()).toEqual([
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
