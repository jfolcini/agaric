/**
 * Tests for HeadingLevelSelector component.
 *
 * Validates:
 *  - Renders all 7 buttons (H1-H6 + Paragraph)
 *  - Heading buttons call toggleHeading with the correct level
 *  - Heading buttons call onClose after toggling
 *  - Heading buttons call preventDefault on pointerDown
 *  - Paragraph button toggles heading off when heading is active
 *  - Paragraph button does NOT call toggleHeading when no heading active
 *  - Paragraph button always calls onClose
 *  - Active heading shows bg-accent class
 *  - Inactive headings do not show bg-accent class
 *  - Buttons have correct aria-labels
 *  - a11y: passes axe audit
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HeadingLevelSelector } from '../HeadingLevelSelector'

// ── Editor mock helpers ──────────────────────────────────────────────────

const mockRun = vi.fn()
const mockToggleHeading = vi.fn(() => ({ run: mockRun }))
const mockFocus = vi.fn(() => ({
  toggleHeading: mockToggleHeading,
}))
const mockChain = vi.fn(() => ({
  focus: mockFocus,
}))

function makeEditor() {
  return {
    chain: mockChain,
  } as never
}

function resetMocks() {
  mockRun.mockClear()
  mockToggleHeading.mockClear()
  mockFocus.mockClear()
  mockChain.mockClear()
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('HeadingLevelSelector', () => {
  describe('rendering', () => {
    it('renders all 7 buttons (H1-H6 + Paragraph)', () => {
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      for (let level = 1; level <= 6; level++) {
        expect(screen.getByRole('button', { name: `H${level}` })).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: 'Paragraph' })).toBeInTheDocument()
    })
  })

  describe('heading buttons', () => {
    it.each([1, 2, 3, 4, 5, 6])('H%i calls toggleHeading with correct level', (level) => {
      resetMocks()
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      const btn = screen.getByRole('button', { name: `H${level}` })
      fireEvent.pointerDown(btn)

      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockToggleHeading).toHaveBeenCalledWith({ level })
      expect(mockRun).toHaveBeenCalled()
    })

    it('calls onClose after toggling heading', () => {
      resetMocks()
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      fireEvent.pointerDown(screen.getByRole('button', { name: 'H3' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('calls preventDefault on pointerDown', () => {
      resetMocks()
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      const btn = screen.getByRole('button', { name: 'H2' })
      const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

      btn.dispatchEvent(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
    })
  })

  describe('paragraph button', () => {
    it('calls toggleHeading when heading is active', () => {
      resetMocks()
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={3} onClose={onClose} />)

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Paragraph' }))

      expect(mockChain).toHaveBeenCalled()
      expect(mockFocus).toHaveBeenCalled()
      expect(mockToggleHeading).toHaveBeenCalledWith({ level: 3 })
      expect(mockRun).toHaveBeenCalled()
    })

    it('does NOT call toggleHeading when no heading is active', () => {
      resetMocks()
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Paragraph' }))

      expect(mockChain).not.toHaveBeenCalled()
      expect(mockToggleHeading).not.toHaveBeenCalled()
    })

    it('always calls onClose regardless of heading state', () => {
      resetMocks()
      const onClose = vi.fn()

      // Case 1: no heading active
      const { unmount } = render(
        <HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />,
      )
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Paragraph' }))
      expect(onClose).toHaveBeenCalledTimes(1)
      unmount()

      // Case 2: heading active
      onClose.mockClear()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={4} onClose={onClose} />)
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Paragraph' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('active state styling', () => {
    it('active heading shows bg-accent class', () => {
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={3} onClose={onClose} />)

      const btn = screen.getByRole('button', { name: 'H3' })
      expect(btn.className).toContain('bg-accent')
    })

    it('inactive headings do not show bg-accent class', () => {
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={3} onClose={onClose} />)

      for (const level of [1, 2, 4, 5, 6]) {
        const btn = screen.getByRole('button', { name: `H${level}` })
        const classes = btn.className.split(/\s+/)
        expect(classes).not.toContain('bg-accent')
      }
    })

    it('paragraph button shows bg-accent when no heading active', () => {
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      const btn = screen.getByRole('button', { name: 'Paragraph' })
      expect(btn.className).toContain('bg-accent')
    })
  })

  describe('accessible names', () => {
    it('buttons have correct aria-labels', () => {
      const onClose = vi.fn()
      render(<HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />)

      for (let level = 1; level <= 6; level++) {
        expect(screen.getByRole('button', { name: `H${level}` })).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: 'Paragraph' })).toBeInTheDocument()
    })
  })

  describe('a11y', () => {
    it('passes axe audit', async () => {
      const onClose = vi.fn()
      const { container } = render(
        <HeadingLevelSelector editor={makeEditor()} headingLevel={0} onClose={onClose} />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit with active heading', async () => {
      const onClose = vi.fn()
      const { container } = render(
        <HeadingLevelSelector editor={makeEditor()} headingLevel={2} onClose={onClose} />,
      )
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
