/**
 * Tests for SettingsForm — render + a11y per Phase 3b
 * (`pending/design-system-maintainability-2026-05-09.md`). The parent
 * suite drives end-to-end debounce/IPC behaviour through this leaf;
 * these tests pin the props-to-DOM contract so a future refactor of
 * the orchestrator can't silently change the input/switch IDs.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { SettingsForm } from '../SettingsForm'

const baseProps = {
  connected: true,
  windowInput: '30',
  windowMin: 7,
  windowMax: 90,
  privacyMode: 'full' as const,
  onWindowChange: vi.fn(),
  onWindowBlur: vi.fn(),
  onPrivacyToggle: vi.fn(),
}

describe('SettingsForm', () => {
  it('renders the window-days input with the current value', () => {
    render(<SettingsForm {...baseProps} windowInput="45" />)
    expect(screen.getByTestId('gcal-window-input')).toHaveValue(45)
  })

  it('renders the privacy toggle as unchecked when mode is full', () => {
    render(<SettingsForm {...baseProps} privacyMode="full" />)
    expect(screen.getByRole('switch', { name: /Hide agenda content/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('renders the privacy toggle as checked when mode is minimal', () => {
    render(<SettingsForm {...baseProps} privacyMode="minimal" />)
    expect(screen.getByRole('switch', { name: /Hide agenda content/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('disables both fields when disconnected', () => {
    render(<SettingsForm {...baseProps} connected={false} />)
    expect(screen.getByTestId('gcal-window-input')).toBeDisabled()
    expect(screen.getByRole('switch', { name: /Hide agenda content/i })).toBeDisabled()
  })

  it('invokes onWindowChange when the user types', async () => {
    const user = userEvent.setup()
    const onWindowChange = vi.fn()
    render(<SettingsForm {...baseProps} windowInput="" onWindowChange={onWindowChange} />)

    await user.type(screen.getByTestId('gcal-window-input'), '4')
    expect(onWindowChange).toHaveBeenCalled()
  })

  it('invokes onPrivacyToggle when the switch is clicked', async () => {
    const user = userEvent.setup()
    const onPrivacyToggle = vi.fn()
    render(<SettingsForm {...baseProps} onPrivacyToggle={onPrivacyToggle} />)

    await user.click(screen.getByRole('switch', { name: /Hide agenda content/i }))
    expect(onPrivacyToggle).toHaveBeenCalledWith(true)
  })

  it('has no axe violations', async () => {
    const { container } = render(<SettingsForm {...baseProps} />)
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
