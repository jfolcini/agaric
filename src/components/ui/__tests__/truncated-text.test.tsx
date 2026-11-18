/**
 * Tests for TruncatedText (#6895): the full text shows as a hover title only
 * while the line is actually cut.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { TruncatedText } from '@/components/ui/truncated-text'

const FULL = 'Work/Projects/Agaric/Notes'

/** happy-dom lays nothing out, so give the span the widths a browser would. */
function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
}

describe('TruncatedText', () => {
  it('renders the text truncated, with no title before anything measures it', () => {
    render(<TruncatedText>{FULL}</TruncatedText>)
    const el = screen.getByText(FULL)
    expect(el).toHaveClass('truncate')
    expect(el).not.toHaveAttribute('title')
  })

  it('carries the full text as a title once a pointer finds it cut', () => {
    render(<TruncatedText>{FULL}</TruncatedText>)
    const el = screen.getByText(FULL)
    setWidths(el, 300, 120)
    fireEvent.pointerEnter(el)
    expect(el).toHaveAttribute('title', FULL)
  })

  it('carries no title when the text fits', () => {
    render(<TruncatedText>{FULL}</TruncatedText>)
    const el = screen.getByText(FULL)
    setWidths(el, 120, 120)
    fireEvent.pointerEnter(el)
    expect(el).not.toHaveAttribute('title')
  })

  it('measures on keyboard focus too', () => {
    render(<TruncatedText tabIndex={0}>{FULL}</TruncatedText>)
    const el = screen.getByText(FULL)
    setWidths(el, 300, 120)
    fireEvent.focus(el)
    expect(el).toHaveAttribute('title', FULL)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TruncatedText>{FULL}</TruncatedText>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
