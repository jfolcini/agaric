/**
 * Tests for BugReportDialog (FEAT-5).
 *
 * - render + axe a11y audit
 * - title/description toggles update state
 * - "Open in GitHub" button gated on confirmation checkbox
 * - IPC rejection path: metadata load failure shows toast and keeps dialog
 *   open (no crash)
 * - logs on + redact toggle refetches
 * - Copy button copies the formatted body to clipboard
 * - Primary click with logs on triggers the ZIP download + openUrl flow
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { writeText } from '@/lib/clipboard'
import { t } from '../../lib/i18n'
import { BugReportDialog } from '../BugReportDialog'

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)
const mockedToastSuccess = vi.mocked(toast.success)

// Mock open-url + download so the primary button path runs without touching
// `@tauri-apps/plugin-shell` or the DOM download machinery.
const openUrlMock = vi.fn<(url: string) => Promise<void>>()
vi.mock('@/lib/open-url', () => ({
  openUrl: (url: string) => openUrlMock(url),
}))

const downloadBlobMock = vi.fn<(blob: Blob, filename: string) => void>()
vi.mock('@/lib/export-graph', () => ({
  downloadBlob: (blob: Blob, name: string) => downloadBlobMock(blob, name),
}))

// Mock the clipboard wrapper so the Copy button path does not depend on
// `@tauri-apps/plugin-clipboard-manager` IPC or jsdom's `navigator.clipboard`.
vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))
const mockedWriteText = vi.mocked(writeText)

const sampleMetadata = {
  app_version: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  device_id: 'DEV-XYZ',
  recent_errors: ['2025-01-01 ERROR [agaric] kaboom'],
}

function setupDefaultIpcMocks() {
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'collect_bug_report_metadata') return sampleMetadata
    if (cmd === 'read_logs_for_report') {
      return [{ name: 'agaric.log', contents: 'today content\n' }]
    }
    return null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  openUrlMock.mockResolvedValue(undefined)
  setupDefaultIpcMocks()
  // Re-arm the wrapper mock — `vi.clearAllMocks()` clears the default
  // resolution installed at module load.
  mockedWriteText.mockResolvedValue(undefined)
})

describe('BugReportDialog', () => {
  it('renders the dialog with title, form fields, preview, and confirmation checkbox', async () => {
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText(t('bugReport.fieldTitleLabel'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('bugReport.fieldDescriptionLabel'))).toBeInTheDocument()
    expect(
      screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: t('bugReport.confirmCheckbox') }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeInTheDocument()
  })

  it('primary button is disabled until the confirmation checkbox is ticked', async () => {
    const user = userEvent.setup()
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    // Wait for metadata to resolve so the preview has content.
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('collect_bug_report_metadata')
    })
    await screen.findByText(/## Description/)

    const openBtn = screen.getByRole('button', { name: t('bugReport.openIssue') })
    expect(openBtn).toBeDisabled()

    const checkbox = screen.getByRole('checkbox', {
      name: t('bugReport.confirmCheckbox'),
    })
    await user.click(checkbox)

    expect(openBtn).not.toBeDisabled()
  })

  it('toggling "Include diagnostic logs" requests logs from the backend', async () => {
    const user = userEvent.setup()
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('collect_bug_report_metadata')
    })

    expect(mockedInvoke.mock.calls.find(([cmd]) => cmd === 'read_logs_for_report')).toBeUndefined()

    const toggle = screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') })
    await user.click(toggle)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'read_logs_for_report',
        expect.objectContaining({ redact: true }),
      )
    })

    // The logs list region must render the filename we seeded.
    expect(await screen.findByText('agaric.log')).toBeInTheDocument()
  })

  it('toggling the redact switch re-reads the logs with redact=false', async () => {
    const user = userEvent.setup()
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('collect_bug_report_metadata')
    })

    await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'read_logs_for_report',
        expect.objectContaining({ redact: true }),
      )
    })

    await user.click(screen.getByRole('switch', { name: t('bugReport.redactLabel') }))
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'read_logs_for_report',
        expect.objectContaining({ redact: false }),
      )
    })
  })

  it('shows a toast and stays open when collect_bug_report_metadata rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'collect_bug_report_metadata') throw new Error('boom')
      return null
    })

    const onOpenChange = vi.fn()
    render(<BugReportDialog open={true} onOpenChange={onOpenChange} />)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('bugReport.loadMetadataFailed'))
    })

    // Dialog must still be open — no onOpenChange(false) call.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows a toast when read_logs_for_report rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'collect_bug_report_metadata') return sampleMetadata
      if (cmd === 'read_logs_for_report') throw new Error('io fail')
      return null
    })

    const user = userEvent.setup()
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('collect_bug_report_metadata')
    })

    await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(t('bugReport.readLogsFailed'))
    })
  })

  it('Copy button writes the report body to the clipboard', async () => {
    const user = userEvent.setup()

    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    await screen.findByText(/## Description/)

    const copyBtn = screen.getByRole('button', { name: t('bugReport.copy') })
    await user.click(copyBtn)

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalled()
    })
    const firstCall = mockedWriteText.mock.calls[0]
    expect(firstCall).toBeDefined()
    expect(firstCall?.[0]).toContain('## Description')
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('bugReport.copied'))
  })

  it('primary click with logs OFF opens the GitHub URL and closes', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<BugReportDialog open={true} onOpenChange={onOpenChange} />)

    await screen.findByText(/## Description/)

    await user.click(screen.getByRole('checkbox', { name: t('bugReport.confirmCheckbox') }))
    await user.click(screen.getByRole('button', { name: t('bugReport.openIssue') }))

    await waitFor(() => {
      expect(openUrlMock).toHaveBeenCalledTimes(1)
    })
    const openCall = openUrlMock.mock.calls[0]
    expect(openCall).toBeDefined()
    expect(openCall?.[0]).toMatch(/^https:\/\/github\.com\/jfolcini\/agaric\/issues\/new\?/)
    expect(downloadBlobMock).not.toHaveBeenCalled()
    expect(mockedToastSuccess).toHaveBeenCalledWith(t('bugReport.submitted'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('renders the design-system Checkbox primitive (data-slot="checkbox") and toggles via onCheckedChange', async () => {
    const user = userEvent.setup()
    render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    const checkbox = await screen.findByRole('checkbox', {
      name: t('bugReport.confirmCheckbox'),
    })
    // Design-system primitive — Radix-based Checkbox renders as a <button>
    // with data-slot="checkbox", not a native <input type="checkbox">.
    expect(checkbox).toHaveAttribute('data-slot', 'checkbox')
    expect(checkbox.tagName).not.toBe('INPUT')
    expect(checkbox).toHaveAttribute('aria-checked', 'false')

    await user.click(checkbox)

    expect(checkbox).toHaveAttribute('aria-checked', 'true')
    // Confirm the primary button becomes enabled (downstream effect of
    // onCheckedChange firing with `true`).
    await screen.findByText(/## Description/)
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).not.toBeDisabled()
  })

  it('primary click with logs ON downloads a ZIP and then opens the GitHub URL', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    render(<BugReportDialog open={true} onOpenChange={onOpenChange} />)

    await screen.findByText(/## Description/)

    await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'read_logs_for_report'),
      ).toHaveLength(1)
    })

    await user.click(screen.getByRole('checkbox', { name: t('bugReport.confirmCheckbox') }))
    await user.click(screen.getByRole('button', { name: t('bugReport.openIssue') }))

    await waitFor(() => {
      expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    })
    const downloadCall = downloadBlobMock.mock.calls[0]
    expect(downloadCall).toBeDefined()
    const [blob, filename] = downloadCall ?? []
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toMatch(/^agaric-bug-report-\d{4}-\d{2}-\d{2}\.zip$/)

    await waitFor(() => {
      expect(openUrlMock).toHaveBeenCalledTimes(1)
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<BugReportDialog open={true} onOpenChange={() => {}} />)

    await screen.findByText(/## Description/)

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  // ── UX-277: per-log preview sub-dialog ───────────────────────────────
  describe('log preview sub-dialog (UX-277)', () => {
    const longContent = `${'a'.repeat(600)}END`
    const shortContent = 'short log line\n'

    function setupTwoLogs() {
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'collect_bug_report_metadata') return sampleMetadata
        if (cmd === 'read_logs_for_report') {
          return [
            { name: 'agaric.log', contents: longContent },
            { name: 'agaric-2025-01-01.log', contents: shortContent },
          ]
        }
        return null
      })
    }

    async function openLogsList(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
      // Wait for both log entries to appear in the list.
      expect(await screen.findByText('agaric.log')).toBeInTheDocument()
      expect(await screen.findByText('agaric-2025-01-01.log')).toBeInTheDocument()
    }

    it('renders a Preview button for each log entry', async () => {
      const user = userEvent.setup()
      setupTwoLogs()

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await openLogsList(user)

      expect(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric-2025-01-01.log' }),
        }),
      ).toBeInTheDocument()
    })

    it('opens the sub-dialog when the Preview button is clicked', async () => {
      const user = userEvent.setup()
      setupTwoLogs()

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await openLogsList(user)

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      )

      const previewDialog = await screen.findByRole('dialog', {
        name: t('bugReport.previewTitle'),
      })
      expect(previewDialog).toBeInTheDocument()
      // Filename is rendered inside the sub-dialog header.
      expect(previewDialog).toHaveTextContent('agaric.log')
    })

    it('truncates content and shows the truncation notice when the file exceeds 500 chars', async () => {
      const user = userEvent.setup()
      setupTwoLogs()

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await openLogsList(user)

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      )

      const pre = await screen.findByTestId('bug-report-log-preview-content')
      // Content is sliced to PREVIEW_MAX_CHARS (500).
      expect(pre.textContent ?? '').toHaveLength(500)
      expect(pre.textContent).not.toContain('END')
      // Truncation notice with the total byte count is rendered.
      const total = longContent.length
      expect(
        screen.getByText(t('bugReport.previewTruncated', { shown: 500, total })),
      ).toBeInTheDocument()
    })

    it('shows the full content (no truncation notice) when the file is ≤ 500 chars', async () => {
      const user = userEvent.setup()
      setupTwoLogs()

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await openLogsList(user)

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric-2025-01-01.log' }),
        }),
      )

      const pre = await screen.findByTestId('bug-report-log-preview-content')
      expect(pre.textContent).toBe(shortContent)
      // No truncation notice for a short file.
      expect(screen.queryByText(/Showing first 500 of/)).not.toBeInTheDocument()
    })

    it('shows the loading spinner while the IPC is in flight', async () => {
      const user = userEvent.setup()

      // First read_logs_for_report call (loading the list) resolves
      // immediately; the second call (preview) hangs so we can observe
      // the loading state.
      let readCallCount = 0
      let resolvePreview!: (entries: { name: string; contents: string }[]) => void
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'collect_bug_report_metadata') return sampleMetadata
        if (cmd === 'read_logs_for_report') {
          readCallCount += 1
          if (readCallCount === 1) {
            return [{ name: 'agaric.log', contents: 'tiny' }]
          }
          return new Promise<{ name: string; contents: string }[]>((resolve) => {
            resolvePreview = resolve
          })
        }
        return null
      })

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
      await screen.findByText('agaric.log')

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      )

      // Loading message visible inside the sub-dialog.
      const loadingMessage = await screen.findByText(t('bugReport.previewLoading'))
      expect(loadingMessage).toBeInTheDocument()
      // Sub-dialog should advertise its busy state for assistive tech.
      expect(screen.getByTestId('bug-report-log-preview')).toHaveAttribute('aria-busy', 'true')

      // Now resolve the preview IPC and the spinner should disappear.
      resolvePreview([{ name: 'agaric.log', contents: 'tiny' }])

      await waitFor(() => {
        expect(screen.queryByText(t('bugReport.previewLoading'))).not.toBeInTheDocument()
      })
      expect(await screen.findByTestId('bug-report-log-preview-content')).toHaveTextContent('tiny')
    })

    it('shows an error message when the IPC fails and logs the error', async () => {
      const user = userEvent.setup()

      let readCallCount = 0
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'collect_bug_report_metadata') return sampleMetadata
        if (cmd === 'read_logs_for_report') {
          readCallCount += 1
          if (readCallCount === 1) {
            return [{ name: 'agaric.log', contents: 'tiny' }]
          }
          throw new Error('disk on fire')
        }
        return null
      })

      render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
      await screen.findByText('agaric.log')

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      )

      const errorMsg = await screen.findByRole('alert')
      expect(errorMsg).toHaveTextContent(t('bugReport.previewError'))
      // The preview content pre block must not be rendered when the
      // IPC failed.
      expect(screen.queryByTestId('bug-report-log-preview-content')).not.toBeInTheDocument()
    })

    it('passes the axe a11y audit with the sub-dialog open', async () => {
      const user = userEvent.setup()
      setupTwoLogs()

      const { container } = render(<BugReportDialog open={true} onOpenChange={() => {}} />)
      await openLogsList(user)

      await user.click(
        screen.getByRole('button', {
          name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
        }),
      )
      await screen.findByTestId('bug-report-log-preview-content')

      await waitFor(
        async () => {
          const results = await axe(container)
          expect(results).toHaveNoViolations()
        },
        { timeout: 5000 },
      )
    })
  })

  it('prefills title and description from props', async () => {
    render(
      <BugReportDialog
        open={true}
        onOpenChange={() => {}}
        initialTitle="crash prefilled"
        initialDescription="stack trace here"
      />,
    )

    const titleInput = (await screen.findByLabelText(
      t('bugReport.fieldTitleLabel'),
    )) as HTMLInputElement
    expect(titleInput.value).toBe('crash prefilled')

    const descInput = screen.getByLabelText(
      t('bugReport.fieldDescriptionLabel'),
    ) as HTMLTextAreaElement
    expect(descInput.value).toBe('stack trace here')
  })
})
