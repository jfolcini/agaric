/**
 * Tests for BugReportForm (MAINT-Phase-3b extraction from BugReportDialog).
 *
 * Coverage:
 *  - Renders title + description inputs reflecting controlled props.
 *  - Renders both switches with translated labels.
 *  - Edits to each field surface via the matching `onChange` callback.
 *  - The redact switch is disabled when `includeLogs` is OFF (UX-383).
 *  - No a11y violations under axe.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import { BugReportForm } from '../BugReportForm'

function renderForm(overrides?: Partial<Parameters<typeof BugReportForm>[0]>) {
  const props = {
    title: '',
    description: '',
    includeLogs: false,
    redact: true,
    onTitleChange: vi.fn(),
    onDescriptionChange: vi.fn(),
    onIncludeLogsChange: vi.fn(),
    onRedactChange: vi.fn(),
    ...overrides,
  }
  return { ...render(<BugReportForm {...props} />), props }
}

describe('BugReportForm', () => {
  it('renders title + description inputs with their controlled values', () => {
    renderForm({ title: 'seeded title', description: 'seeded body' })

    const titleInput = screen.getByLabelText(t('bugReport.fieldTitleLabel')) as HTMLInputElement
    expect(titleInput.value).toBe('seeded title')

    const descInput = screen.getByLabelText(
      t('bugReport.fieldDescriptionLabel'),
    ) as HTMLTextAreaElement
    expect(descInput.value).toBe('seeded body')
  })

  it('renders both include-logs and redact switches with translated labels', () => {
    renderForm()
    expect(
      screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: t('bugReport.redactLabel') })).toBeInTheDocument()
  })

  it('propagates title edits via onTitleChange', async () => {
    const user = userEvent.setup()
    const { props } = renderForm()

    const titleInput = screen.getByLabelText(t('bugReport.fieldTitleLabel'))
    await user.type(titleInput, 'x')

    expect(props.onTitleChange).toHaveBeenCalledWith('x')
  })

  it('propagates description edits via onDescriptionChange', async () => {
    const user = userEvent.setup()
    const { props } = renderForm()

    const descInput = screen.getByLabelText(t('bugReport.fieldDescriptionLabel'))
    await user.type(descInput, 'y')

    expect(props.onDescriptionChange).toHaveBeenCalledWith('y')
  })

  it('propagates include-logs toggle via onIncludeLogsChange', async () => {
    const user = userEvent.setup()
    const { props } = renderForm()

    await user.click(screen.getByRole('switch', { name: t('bugReport.includeLogsLabel') }))
    expect(props.onIncludeLogsChange).toHaveBeenCalledWith(true)
  })

  it('propagates redact toggle via onRedactChange when include-logs is ON', async () => {
    const user = userEvent.setup()
    const { props } = renderForm({ includeLogs: true })

    await user.click(screen.getByRole('switch', { name: t('bugReport.redactLabel') }))
    expect(props.onRedactChange).toHaveBeenCalledWith(false)
  })

  it('disables the redact switch when include-logs is OFF (UX-383)', () => {
    renderForm({ includeLogs: false })
    expect(screen.getByRole('switch', { name: t('bugReport.redactLabel') })).toBeDisabled()
  })

  it('enables the redact switch when include-logs is ON (UX-383)', () => {
    renderForm({ includeLogs: true })
    expect(screen.getByRole('switch', { name: t('bugReport.redactLabel') })).not.toBeDisabled()
  })

  it('has no a11y violations', async () => {
    const { container } = renderForm()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
