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

  it('carries the full text when it shows a shortened form, cut or not', () => {
    render(<TruncatedText text="Work/Notes">Notes</TruncatedText>)
    expect(screen.getByText('Notes')).toHaveAttribute('title', 'Work/Notes')
  })

  it('carries no title when its text is the full text and fits', () => {
    render(<TruncatedText text="Notes">Notes</TruncatedText>)
    const el = screen.getByText('Notes')
    setWidths(el, 50, 120)
    fireEvent.pointerEnter(el)
    expect(el).not.toHaveAttribute('title')
  })

  it('takes rich content, with its full text for the hover', () => {
    render(
      <TruncatedText text={FULL}>
        Work/<mark>Projects</mark>/Agaric/Notes
      </TruncatedText>,
    )
    const el = screen.getByText('Projects').parentElement as HTMLElement
    setWidths(el, 300, 120)
    fireEvent.pointerEnter(el)
    expect(el).toHaveAttribute('title', FULL)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<TruncatedText>{FULL}</TruncatedText>)
    expect(await axe(container)).toHaveNoViolations()
  })
})
