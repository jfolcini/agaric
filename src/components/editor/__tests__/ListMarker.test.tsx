// @vitest-environment jsdom

/**
 * Tests for the #3000 list marker: the presentational `ListMarker`, the
 * `listMarkerText` glyph rule, and the `ListMarkerContext` provider/hook.
 */

import { render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { BULLET_GLYPH, ListMarker, listMarkerText } from '@/components/editor/ListMarker'
import {
  ListMarkerProvider,
  useListMarker,
  type ListMarkerValue,
} from '@/components/editor/ListMarkerContext'

describe('listMarkerText', () => {
  it('renders a bullet glyph, a computed ordinal, or nothing', () => {
    expect(listMarkerText('bullet', undefined)).toBe(BULLET_GLYPH)
    expect(listMarkerText('ordered', 3)).toBe('3.')
    expect(listMarkerText('ordered', undefined)).toBe('1.') // defensive fallback
    expect(listMarkerText('none', undefined)).toBe('')
  })
})

describe('ListMarker', () => {
  it('renders nothing for none', () => {
    const { container } = render(<ListMarker style="none" content="item" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the bullet glyph, aria-hidden and non-editable', () => {
    render(<ListMarker style="bullet" content="item" />)
    const marker = screen.getByTestId('list-marker')
    expect(marker).toHaveTextContent(BULLET_GLYPH)
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker).toHaveAttribute('contenteditable', 'false')
  })

  it('renders the computed ordinal for ordered', () => {
    render(<ListMarker style="ordered" ordinal={4} content="item" />)
    expect(screen.getByTestId('list-marker')).toHaveTextContent('4.')
  })

  // Only a bullet or numbered block shows a marker: a block that opens with
  // anything but a paragraph shows none, whatever style it carries.
  it.each([
    ['a heading', '# Title'],
    ['a code block', '```\ncode\n```'],
    ['a quote', '> quoted'],
    ['a callout', '> [!INFO] note'],
    ['a divider', '---'],
    ['a table', '| a | b |\n| - | - |\n| 1 | 2 |'],
  ])('renders nothing for %s, bullet or ordered', (_kind, content) => {
    const { container } = render(
      <>
        <ListMarker style="bullet" content={content} />
        <ListMarker style="ordered" ordinal={2} content={content} />
      </>,
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('useListMarker', () => {
  const wrapper =
    (value: ListMarkerValue) =>
    ({ children }: { children: ReactNode }) => (
      <ListMarkerProvider value={value}>{children}</ListMarkerProvider>
    )

  it('reports none outside a provider', () => {
    const { result } = renderHook(() => useListMarker('A'))
    expect(result.current).toEqual({ style: 'none', ordinal: undefined })
  })

  it('resolves style + ordinal for a block by id', () => {
    const value: ListMarkerValue = {
      styleOf: (id) => (id === 'A' ? 'ordered' : 'none'),
      ordinalOf: (id) => (id === 'A' ? 2 : undefined),
    }
    const { result } = renderHook(() => useListMarker('A'), { wrapper: wrapper(value) })
    expect(result.current).toEqual({ style: 'ordered', ordinal: 2 })
  })
})
