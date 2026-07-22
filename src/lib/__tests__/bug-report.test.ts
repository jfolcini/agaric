import { describe, expect, it } from 'vitest'

import type { BugReport } from '@/lib/bindings'
import {
  _internals,
  BUG_REPORT_TEMPLATE,
  buildGitHubIssueUrl,
  formatReportBody,
  formatReportFields,
  truncateDeviceId,
} from '@/lib/bug-report'

// #609: UUID-shaped, like the real per-device identifier — the issue body
// must never embed it in full (the same value is scrubbed to
// [REDACTED_DEVICE_ID] in the ZIP export; cleartext in a public issue
// would be inconsistent).
const FULL_DEVICE_ID = '12345678-9abc-4def-8123-456789abcdef'

const SAMPLE_METADATA: BugReport = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: FULL_DEVICE_ID,
  recent_errors: ['2025-01-01 ERROR [agaric] kaboom', '2025-01-01 WARN [agaric] slowpoke'],
}

// --------------------------------------------------------------------------
// buildGitHubIssueUrl
// --------------------------------------------------------------------------

describe('buildGitHubIssueUrl', () => {
  it('targets the issue-form template and never emits a body param', () => {
    // The repo disables blank issues; a `body=` param hits the disabled
    // blank-issue route and GitHub 500s. The URL must drive the form.
    const url = buildGitHubIssueUrl({
      owner: 'jfolcini',
      repo: 'agaric',
      template: BUG_REPORT_TEMPLATE,
      title: 'Crash & burn',
      fields: { summary: 'it broke' },
    })
    expect(url.startsWith('https://github.com/jfolcini/agaric/issues/new?')).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('template')).toBe('bug_report.yml')
    expect(params.has('body')).toBe(false)
  })

  it('URL-encodes the title and field values into the query string', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      template: BUG_REPORT_TEMPLATE,
      title: 'Crash & burn',
      fields: { actual: 'Hello #world, how are you?' },
    })
    // URLSearchParams encodes spaces as '+'; ampersands, hashes, commas and
    // question marks are percent-encoded.
    expect(url).toContain('title=Crash+%26+burn')
    expect(url).toContain('actual=Hello+%23world%2C+how+are+you%3F')
  })

  it('maps each field id to its own query param', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      template: BUG_REPORT_TEMPLATE,
      fields: { summary: 's', version: '1.2.3', os: 'linux' },
    })
    const params = new URL(url).searchParams
    expect(params.get('summary')).toBe('s')
    expect(params.get('version')).toBe('1.2.3')
    expect(params.get('os')).toBe('linux')
  })

  it('drops empty field values so no stray `field=` is emitted', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      template: BUG_REPORT_TEMPLATE,
      fields: { summary: 'present', actual: '', logs: '' },
    })
    const params = new URL(url).searchParams
    expect(params.get('summary')).toBe('present')
    expect(params.has('actual')).toBe(false)
    expect(params.has('logs')).toBe(false)
  })

  it('omits the title param when empty so the form default prefix is kept', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      template: BUG_REPORT_TEMPLATE,
      title: '   ',
      fields: { summary: 's' },
    })
    expect(new URL(url).searchParams.has('title')).toBe(false)
  })

  it('encodes owner/repo path segments', () => {
    const url = buildGitHubIssueUrl({
      owner: 'has space',
      repo: 'a/b',
      template: BUG_REPORT_TEMPLATE,
      fields: {},
    })
    expect(url).toContain('/has%20space/')
    expect(url).toContain('/a%2Fb/')
  })
})

// --------------------------------------------------------------------------
// formatReportFields
// --------------------------------------------------------------------------

describe('formatReportFields', () => {
  it('maps the report onto the issue-form field ids', () => {
    const fields = formatReportFields({
      metadata: SAMPLE_METADATA,
      title: 'Editor crashes on undo',
      description: 'It crashes when I press Ctrl+Z.',
      zipFileName: 'agaric-bug-report-2025-01-15.zip',
    })
    expect(fields.summary).toBe('Editor crashes on undo')
    expect(fields.actual).toBe('It crashes when I press Ctrl+Z.')
    expect(fields.version).toBe('0.1.0')
    expect(fields.os).toBe('linux')
    expect(fields.logs).toBe('2025-01-01 ERROR [agaric] kaboom\n2025-01-01 WARN [agaric] slowpoke')
    expect(fields.notes).toContain('Arch: x86_64')
    expect(fields.notes).toContain('Diagnostic ZIP to attach: agaric-bug-report-2025-01-15.zip')
  })

  it('trims the title and description', () => {
    const fields = formatReportFields({
      metadata: SAMPLE_METADATA,
      title: '  spaced title  ',
      description: '  spaced body  ',
    })
    expect(fields.summary).toBe('spaced title')
    expect(fields.actual).toBe('spaced body')
  })

  it('caps the logs field at MAX_BODY_CHARS and appends the marker', () => {
    const huge = 'x'.repeat(_internals.MAX_BODY_CHARS + 500)
    const fields = formatReportFields({
      metadata: { ...SAMPLE_METADATA, recent_errors: [huge] },
      title: 't',
      description: 'd',
    })
    expect(fields.logs.length).toBeLessThanOrEqual(_internals.MAX_BODY_CHARS)
    expect(fields.logs.endsWith(_internals.TRUNCATION_MARKER)).toBe(true)
  })

  it('leaves logs empty when there are no recent errors', () => {
    const fields = formatReportFields({
      metadata: { ...SAMPLE_METADATA, recent_errors: [] },
      title: 't',
      description: 'd',
    })
    expect(fields.logs).toBe('')
  })

  it('omits the ZIP reminder when no zipFileName is given', () => {
    const fields = formatReportFields({
      metadata: SAMPLE_METADATA,
      title: 't',
      description: 'd',
    })
    expect(fields.notes).not.toContain('Diagnostic ZIP')
  })

  // #609: the full device ID must never reach a public issue — only the
  // truncated prefix, surfaced in the notes field.
  it('never embeds the full device ID (#609)', () => {
    const fields = formatReportFields({
      metadata: SAMPLE_METADATA,
      title: 't',
      description: 'd',
    })
    const all = Object.values(fields).join('\n')
    expect(all).not.toContain(FULL_DEVICE_ID)
    expect(fields.notes).toContain('Device ID: 12345678… (truncated)')
  })
})

// --------------------------------------------------------------------------
// formatReportBody
// --------------------------------------------------------------------------

describe('formatReportBody', () => {
  it('produces a deterministic body for the happy path (snapshot)', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: 'The app crashes when I press Enter twice.',
      zipFileName: 'agaric-bug-report-2025-01-15.zip',
    })
    expect(body).toMatchInlineSnapshot(`
      "## Description

      The app crashes when I press Enter twice.

      ## Environment

      - **App version:** \`0.1.0\`
      - **OS:** \`linux\`
      - **Arch:** \`x86_64\`
      - **Device ID:** \`12345678…\` _(truncated)_

      ## Recent errors

      \`\`\`
      2025-01-01 ERROR [agaric] kaboom
      2025-01-01 WARN [agaric] slowpoke
      \`\`\`

      ## Attachments

      Please attach the saved \`agaric-bug-report-2025-01-15.zip\` to this issue before submitting."
    `)
  })

  it('renders a placeholder when description is empty', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: '',
    })
    expect(body).toContain('_(no description)_')
  })

  it('renders a placeholder when description is whitespace-only', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: '   \n   ',
    })
    expect(body).toContain('_(no description)_')
  })

  it('omits the attachments section when zipFileName is not provided', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: 'hi',
    })
    expect(body).not.toContain('## Attachments')
  })

  it('omits the attachments section when zipFileName is an empty string', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: 'hi',
      zipFileName: '',
    })
    expect(body).not.toContain('## Attachments')
  })

  it('handles an empty recent_errors list gracefully', () => {
    const body = formatReportBody({
      metadata: { ...SAMPLE_METADATA, recent_errors: [] },
      description: 'hi',
    })
    expect(body).toContain('_(no recent errors)_')
    expect(body).not.toContain('```')
  })

  // #609: the full device ID is a stable identifier the redaction pipeline
  // scrubs from the ZIP export — it must never appear in cleartext in the
  // prefilled public GitHub issue body.
  it('never embeds the full device ID in the body (#609)', () => {
    const body = formatReportBody({
      metadata: SAMPLE_METADATA,
      description: 'hi',
    })
    expect(body).not.toContain(FULL_DEVICE_ID)
    expect(body).toContain('`12345678…` _(truncated)_')
  })
})

// --------------------------------------------------------------------------
// truncateDeviceId (#609)
// --------------------------------------------------------------------------

describe('truncateDeviceId', () => {
  it('keeps only the first 8 characters of a UUID-shaped ID', () => {
    expect(truncateDeviceId(FULL_DEVICE_ID)).toBe('12345678…')
  })

  it('passes short IDs through unchanged', () => {
    expect(truncateDeviceId('DEV-123')).toBe('DEV-123')
    expect(truncateDeviceId('12345678')).toBe('12345678')
  })

  it('handles the empty string', () => {
    expect(truncateDeviceId('')).toBe('')
  })
})
