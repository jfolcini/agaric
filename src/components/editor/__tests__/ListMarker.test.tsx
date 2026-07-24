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
    const { container } = render(<ListMarker style="none" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the bullet glyph, aria-hidden and non-editable', () => {
    render(<ListMarker style="bullet" />)
    const marker = screen.getByTestId('list-marker')
    expect(marker).toHaveTextContent(BULLET_GLYPH)
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker).toHaveAttribute('contenteditable', 'false')
  })

  it('renders the computed ordinal for ordered', () => {
    render(<ListMarker style="ordered" ordinal={4} />)
    expect(screen.getByTestId('list-marker')).toHaveTextContent('4.')
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
