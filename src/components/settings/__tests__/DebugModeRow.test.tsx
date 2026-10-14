/**
 * Tests for DebugModeRow (#1987) — the General-tab toggle that flips the
 * app-wide `PREFERENCES.debugMode` flag. Off by default; flipping it
 * persists the flag (and, by extension, every error surface reads it).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { DebugModeRow } from '@/components/settings/DebugModeRow'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'

afterEach(() => {
  localStorage.clear()
})

describe('DebugModeRow', () => {
  it('renders unchecked by default (debug off)', () => {
    render(<DebugModeRow />)
    expect(screen.getByTestId('debug-mode-toggle')).not.toBeChecked()
  })

  it('reflects an already-on stored value', () => {
    writePreference(PREFERENCES.debugMode, true)
    render(<DebugModeRow />)
    expect(screen.getByTestId('debug-mode-toggle')).toBeChecked()
  })

  it('flips the stored flag when toggled', async () => {
    const user = userEvent.setup()
    render(<DebugModeRow />)

    await user.click(screen.getByTestId('debug-mode-toggle'))
    expect(readPreference(PREFERENCES.debugMode)).toBe(true)

    await user.click(screen.getByTestId('debug-mode-toggle'))
    expect(readPreference(PREFERENCES.debugMode)).toBe(false)
  })
})
