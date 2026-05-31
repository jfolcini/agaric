import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { EMOJI_PICKER_ENABLED_KEY } from '@/lib/editor-preferences'

import { EditorTab } from '../EditorTab'

describe('EditorTab', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('emoji-picker toggle defaults to on', () => {
    render(<EditorTab />)
    expect(screen.getByTestId('emoji-picker-toggle')).toBeChecked()
  })

  it('toggling off persists `false` to localStorage and unchecks', async () => {
    const user = userEvent.setup()
    render(<EditorTab />)
    const toggle = screen.getByTestId('emoji-picker-toggle')
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(localStorage.getItem(EMOJI_PICKER_ENABLED_KEY)).toBe('false')
  })

  it('reflects a stored `false` preference on mount', () => {
    localStorage.setItem(EMOJI_PICKER_ENABLED_KEY, 'false')
    render(<EditorTab />)
    expect(screen.getByTestId('emoji-picker-toggle')).not.toBeChecked()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<EditorTab />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
