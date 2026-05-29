/**
 * Tests for DiagnosticsCollector (MAINT-Phase-3b extraction from
 * BugReportDialog).
 *
 * Coverage:
 *  - Logs list is hidden when includeLogs=false (and the sub-dialog still
 *    mounts because Radix portals it; verified open=false→no markup).
 *  - Logs list renders one row per entry with filename + size + preview
 *    button when includeLogs=true.
 *  - Clicking a row preview button surfaces the filename via onOpenPreview.
 *  - The zip-download hint renders under the list when logs are ON.
 *  - The nested preview Dialog renders header + filename + content when
 *    `previewOpen=true` with content provided.
 *  - The preview shows a truncation notice when content > 500 chars; the
 *    "view full" toggle propagates via onToggleShowFullLog.
 *  - Loading / error states render their respective regions.
 *  - No a11y violations.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { DiagnosticsCollector, type DiagnosticsCollectorProps } from '../DiagnosticsCollector'

function renderCollector(overrides?: Partial<DiagnosticsCollectorProps>) {
  const props: DiagnosticsCollectorProps = {
    includeLogs: true,
    logs: [{ name: 'agaric.log', contents: 'today content\n' }],
    loadingLogs: false,
    zipFileName: 'agaric-bug-report.zip',
    onOpenPreview: vi.fn(),
    previewOpen: false,
    previewFilename: null,
    previewContents: null,
    previewLoading: false,
    previewError: null,
    showFullLog: false,
    onPreviewOpenChange: vi.fn(),
    onToggleShowFullLog: vi.fn(),
    ...overrides,
  }
  return { ...render(<DiagnosticsCollector {...props} />), props }
}

describe('DiagnosticsCollector', () => {
  it('hides the logs list when includeLogs=false', () => {
    renderCollector({ includeLogs: false })
    expect(screen.queryByTestId('bug-report-logs-list')).not.toBeInTheDocument()
    expect(screen.queryByText('agaric.log')).not.toBeInTheDocument()
    // Zip hint is part of the list region, so also hidden.
    expect(screen.queryByTestId('bug-report-zip-hint')).not.toBeInTheDocument()
  })

  it('renders the logs list with filename, size, and per-row preview button', () => {
    renderCollector({
      logs: [
        { name: 'agaric.log', contents: 'abc' },
        { name: 'agaric-2025-01-01.log', contents: 'de' },
      ],
    })

    expect(screen.getByText('agaric.log')).toBeInTheDocument()
    expect(screen.getByText('agaric-2025-01-01.log')).toBeInTheDocument()

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

  it('surfaces the filename via onOpenPreview when a row button is clicked', async () => {
    const user = userEvent.setup()
    const { props } = renderCollector()

    await user.click(
      screen.getByRole('button', {
        name: t('bugReport.previewLabel', { filename: 'agaric.log' }),
      }),
    )

    expect(props.onOpenPreview).toHaveBeenCalledWith('agaric.log')
  })

  it('renders the zip-download hint under the list when logs are ON', () => {
    renderCollector({ zipFileName: 'agaric-bug-report-2026-05-15.zip' })
    expect(screen.getByTestId('bug-report-zip-hint')).toHaveTextContent(
      'agaric-bug-report-2026-05-15.zip',
    )
  })

  it('renders an "empty" placeholder when logs are ON but the list is empty', () => {
    renderCollector({ logs: [] })
    expect(screen.getByText(t('bugReport.logsListEmpty'))).toBeInTheDocument()
  })

  it('opens the preview sub-dialog with filename + content when previewOpen=true', () => {
    renderCollector({
      previewOpen: true,
      previewFilename: 'agaric.log',
      previewContents: 'log line one',
    })

    const previewDialog = screen.getByRole('dialog', { name: t('bugReport.previewTitle') })
    expect(previewDialog).toHaveTextContent('agaric.log')
    expect(screen.getByTestId('bug-report-log-preview-content')).toHaveTextContent('log line one')
  })

  it('shows the truncation notice when content > 500 chars', () => {
    const long = `${'a'.repeat(600)}END`
    renderCollector({
      previewOpen: true,
      previewFilename: 'agaric.log',
      previewContents: long,
    })

    const pre = screen.getByTestId('bug-report-log-preview-content')
    expect(pre.textContent ?? '').toHaveLength(500)
    expect(
      screen.getByText(t('bugReport.previewTruncated', { shown: 500, total: long.length })),
    ).toBeInTheDocument()
  })

  it('invokes onToggleShowFullLog when the "view full" link is clicked', async () => {
    const user = userEvent.setup()
    const long = `${'a'.repeat(600)}END`
    const { props } = renderCollector({
      previewOpen: true,
      previewFilename: 'agaric.log',
      previewContents: long,
    })

    await user.click(screen.getByTestId('bug-report-log-preview-toggle'))
    expect(props.onToggleShowFullLog).toHaveBeenCalled()
  })

  it('shows the loading region with aria-busy when previewLoading=true', () => {
    renderCollector({
      previewOpen: true,
      previewFilename: 'agaric.log',
      previewLoading: true,
    })

    expect(screen.getByTestId('bug-report-log-preview')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(t('bugReport.previewLoading'))).toBeInTheDocument()
  })

  it('renders the error region when previewError is non-null', () => {
    renderCollector({
      previewOpen: true,
      previewFilename: 'agaric.log',
      previewError: 'boom',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.queryByTestId('bug-report-log-preview-content')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = renderCollector()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
