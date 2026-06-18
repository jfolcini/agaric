import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { EMOJI_PICKER_ENABLED_KEY } from '@/lib/editor-preferences'
import { EXTERNAL_IMAGE_ALLOWLIST_KEY } from '@/lib/external-image-policy'

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

  describe('external-image allowlist', () => {
    it('is hidden when the allowlist is empty', () => {
      render(<EditorTab />)
      expect(screen.queryByTestId('external-image-allowlist')).not.toBeInTheDocument()
    })

    it('renders each allowed host as a design-system FilterPill chip', () => {
      localStorage.setItem(
        EXTERNAL_IMAGE_ALLOWLIST_KEY,
        JSON.stringify(['example.com', 'cdn.test']),
      )
      render(<EditorTab />)

      // Sorted, design-system pill (role="group") per host with a lucide-X
      // remove button addressable by its accessible label.
      expect(screen.getByTestId('external-image-host-example.com')).toBeInTheDocument()
      expect(screen.getByTestId('external-image-host-cdn.test')).toBeInTheDocument()
      expect(screen.getByText('example.com')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Remove example.com' })).toBeInTheDocument()
    })

    it('removing a host updates the persisted allowlist and the rendered chips', async () => {
      const user = userEvent.setup()
      localStorage.setItem(
        EXTERNAL_IMAGE_ALLOWLIST_KEY,
        JSON.stringify(['example.com', 'cdn.test']),
      )
      render(<EditorTab />)

      await user.click(screen.getByRole('button', { name: 'Remove example.com' }))

      expect(screen.queryByTestId('external-image-host-example.com')).not.toBeInTheDocument()
      expect(screen.getByTestId('external-image-host-cdn.test')).toBeInTheDocument()
      expect(JSON.parse(localStorage.getItem(EXTERNAL_IMAGE_ALLOWLIST_KEY) ?? '[]')).toEqual([
        'cdn.test',
      ])
    })

    it('has no a11y violations with a populated allowlist', async () => {
      localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['example.com']))
      const { container } = render(<EditorTab />)
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
