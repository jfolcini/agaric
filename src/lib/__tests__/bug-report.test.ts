import { describe, expect, it } from 'vitest'
import { _internals, buildGitHubIssueUrl, formatReportBody } from '../bug-report'
import type { BugReport } from '../tauri'

const SAMPLE_METADATA: BugReport = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: 'DEV-123',
  recent_errors: ['2025-01-01 ERROR [agaric] kaboom', '2025-01-01 WARN [agaric] slowpoke'],
}

// --------------------------------------------------------------------------
// buildGitHubIssueUrl
// --------------------------------------------------------------------------

describe('buildGitHubIssueUrl', () => {
  it('URL-encodes title and body into the query string', () => {
    const url = buildGitHubIssueUrl({
      owner: 'jfolcini',
      repo: 'agaric',
      title: 'Crash & burn',
      body: 'Hello #world, how are you?',
    })
    expect(url.startsWith('https://github.com/jfolcini/agaric/issues/new?')).toBe(true)
    // URLSearchParams encodes spaces as '+'. Ampersands, hashes, and slashes
    // all get percent-encoded.
    expect(url).toContain('title=Crash+%26+burn')
    expect(url).toContain('body=Hello+%23world%2C+how+are+you%3F')
  })

  it('omits the labels param when none are given', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
    })
    expect(url).not.toContain('labels=')
  })

  it('joins labels with a comma', () => {
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: 'b',
      labels: ['bug', 'triage'],
    })
    expect(url).toContain('labels=bug%2Ctriage')
  })

  it('truncates a body exceeding MAX_BODY_CHARS and appends the marker', () => {
    const huge = 'x'.repeat(_internals.MAX_BODY_CHARS + 500)
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      title: 't',
      body: huge,
    })
    const params = new URL(url).searchParams
    const body = params.get('body') ?? ''
    expect(body.length).toBeLessThanOrEqual(_internals.MAX_BODY_CHARS)
    expect(body.endsWith(_internals.TRUNCATION_MARKER)).toBe(true)
  })

  it('does not truncate a body at exactly MAX_BODY_CHARS', () => {
    const body = 'x'.repeat(_internals.MAX_BODY_CHARS)
    const url = buildGitHubIssueUrl({
      owner: 'o',
      repo: 'r',
      title: 't',
      body,
    })
    const params = new URL(url).searchParams
    const got = params.get('body') ?? ''
    expect(got.length).toBe(_internals.MAX_BODY_CHARS)
    expect(got.endsWith(_internals.TRUNCATION_MARKER)).toBe(false)
  })

  it('encodes owner/repo path segments', () => {
    const url = buildGitHubIssueUrl({
      owner: 'has space',
      repo: 'a/b',
      title: 't',
      body: 'b',
    })
    expect(url).toContain('/has%20space/')
    expect(url).toContain('/a%2Fb/')
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
      - **Device ID:** \`DEV-123\`

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
})
