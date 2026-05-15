/**
 * Tests for SubmitSection (MAINT-Phase-3b extraction from BugReportDialog).
 *
 * Coverage:
 *  - Cancel + Copy + primary buttons always render; "Download zip" is
 *    gated on includeLogs.
 *  - Each button click forwards to the matching handler.
 *  - The primary button is disabled until confirmed AND bodyLength > 0
 *    AND not submitting / loading metadata.
 *  - The Copy button is disabled while loadingMetadata or bodyLength === 0.
 *  - The Download-zip button is disabled while submitting / loading /
 *    metadataReady=false.
 *  - The primary button's accessible name flips between logs-on/off.
 *  - No a11y violations.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { SubmitSection, type SubmitSectionProps } from '../SubmitSection'

function renderSection(overrides?: Partial<SubmitSectionProps>) {
  const props: SubmitSectionProps = {
    includeLogs: false,
    confirmed: false,
    submitting: false,
    loadingMetadata: false,
    loadingLogs: false,
    metadataReady: true,
    bodyLength: 42,
    onCancel: vi.fn(),
    onCopy: vi.fn(),
    onDownloadZip: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  return { ...render(<SubmitSection {...props} />), props }
}

describe('SubmitSection', () => {
  it('renders Cancel + Copy + primary button when logs are OFF', () => {
    renderSection({ includeLogs: false })
    expect(screen.getByRole('button', { name: t('bugReport.cancel') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('bugReport.copy') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeInTheDocument()
    expect(screen.queryByTestId('bug-report-download-zip')).not.toBeInTheDocument()
  })

  it('renders the Download zip button only when includeLogs is ON', () => {
    renderSection({ includeLogs: true })
    expect(screen.getByTestId('bug-report-download-zip')).toBeInTheDocument()
  })

  it('flips the primary button label between openIssue and openGitHubIssue', () => {
    const { unmount } = renderSection({ includeLogs: false })
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeInTheDocument()
    unmount()

    renderSection({ includeLogs: true })
    expect(screen.getByRole('button', { name: t('bugReport.openGitHubIssue') })).toBeInTheDocument()
  })

  it('invokes onCancel when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const { props } = renderSection()
    await user.click(screen.getByRole('button', { name: t('bugReport.cancel') }))
    expect(props.onCancel).toHaveBeenCalled()
  })

  it('invokes onCopy when Copy is clicked', async () => {
    const user = userEvent.setup()
    const { props } = renderSection()
    await user.click(screen.getByRole('button', { name: t('bugReport.copy') }))
    expect(props.onCopy).toHaveBeenCalled()
  })

  it('invokes onDownloadZip when the Download zip button is clicked', async () => {
    const user = userEvent.setup()
    const { props } = renderSection({ includeLogs: true })
    await user.click(screen.getByTestId('bug-report-download-zip'))
    expect(props.onDownloadZip).toHaveBeenCalled()
  })

  it('invokes onSubmit when the primary button is clicked (enabled state)', async () => {
    const user = userEvent.setup()
    const { props } = renderSection({ confirmed: true })
    await user.click(screen.getByRole('button', { name: t('bugReport.openIssue') }))
    expect(props.onSubmit).toHaveBeenCalled()
  })

  it('disables the primary button until confirmed', () => {
    renderSection({ confirmed: false })
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeDisabled()
  })

  it('disables the primary button while submitting', () => {
    renderSection({ confirmed: true, submitting: true })
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeDisabled()
  })

  it('disables the primary button while metadata is loading', () => {
    renderSection({ confirmed: true, loadingMetadata: true })
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeDisabled()
  })

  it('disables the primary button when the body is empty', () => {
    renderSection({ confirmed: true, bodyLength: 0 })
    expect(screen.getByRole('button', { name: t('bugReport.openIssue') })).toBeDisabled()
  })

  it('disables Copy while metadata is loading or body is empty', () => {
    const { unmount } = renderSection({ loadingMetadata: true })
    expect(screen.getByRole('button', { name: t('bugReport.copy') })).toBeDisabled()
    unmount()

    renderSection({ bodyLength: 0 })
    expect(screen.getByRole('button', { name: t('bugReport.copy') })).toBeDisabled()
  })

  it('disables Download zip while submitting / loading / metadata not ready', () => {
    const { unmount: u1 } = renderSection({ includeLogs: true, submitting: true })
    expect(screen.getByTestId('bug-report-download-zip')).toBeDisabled()
    u1()

    const { unmount: u2 } = renderSection({ includeLogs: true, loadingLogs: true })
    expect(screen.getByTestId('bug-report-download-zip')).toBeDisabled()
    u2()

    renderSection({ includeLogs: true, metadataReady: false })
    expect(screen.getByTestId('bug-report-download-zip')).toBeDisabled()
  })

  it('has no a11y violations', async () => {
    const { container } = renderSection({ includeLogs: true, confirmed: true })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
