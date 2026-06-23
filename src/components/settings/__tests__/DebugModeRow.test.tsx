/**
 * Tests for DebugModeRow (#1987) — the General-tab toggle that flips the
 * app-wide debug flag in `useDebugStore`. Off by default; flipping it
 * updates the store (and, by extension, every error surface that reads it).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { DebugModeRow } from '@/components/settings/DebugModeRow'
import { useDebugStore } from '@/stores/useDebugStore'

afterEach(() => {
  useDebugStore.setState({ debugMode: false })
  localStorage.clear()
})

describe('DebugModeRow', () => {
  it('renders unchecked by default (debug off)', () => {
    render(<DebugModeRow />)
    expect(screen.getByTestId('debug-mode-toggle')).not.toBeChecked()
  })

  it('reflects an already-on store value', () => {
    useDebugStore.setState({ debugMode: true })
    render(<DebugModeRow />)
    expect(screen.getByTestId('debug-mode-toggle')).toBeChecked()
  })

  it('flips the store flag when toggled', async () => {
    const user = userEvent.setup()
    render(<DebugModeRow />)

    await user.click(screen.getByTestId('debug-mode-toggle'))
    expect(useDebugStore.getState().debugMode).toBe(true)

    await user.click(screen.getByTestId('debug-mode-toggle'))
    expect(useDebugStore.getState().debugMode).toBe(false)
  })
})
