/**
 * Tests for `useSearchPaletteStore` (PEND-51).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSearchPaletteStore } from '../useSearchPaletteStore'

function resetStore(): void {
  useSearchPaletteStore.setState({
    open: false,
    query: '',
    pendingViewQuery: null,
    previousFocusedElement: null,
  })
}

beforeEach(() => {
  resetStore()
})

afterEach(() => {
  resetStore()
})

describe('useSearchPaletteStore — open / close', () => {
  it('captures the element that has focus on open$', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    useSearchPaletteStore.getState().open$()
    expect(useSearchPaletteStore.getState().open).toBe(true)
    expect(useSearchPaletteStore.getState().previousFocusedElement).toBe(input)
    input.remove()
  })

  it('captures null when only the <body> is focused (i.e. cold open)', () => {
    document.body.focus()
    useSearchPaletteStore.getState().open$()
    expect(useSearchPaletteStore.getState().previousFocusedElement).toBeNull()
  })

  it('close() clears the query and the captured focus reference', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    useSearchPaletteStore.getState().open$()
    useSearchPaletteStore.getState().setQuery('something')
    useSearchPaletteStore.getState().close()
    expect(useSearchPaletteStore.getState().open).toBe(false)
    expect(useSearchPaletteStore.getState().query).toBe('')
    expect(useSearchPaletteStore.getState().previousFocusedElement).toBeNull()
    input.remove()
  })

  it('setPendingViewQuery writes and clears the handoff slot', () => {
    useSearchPaletteStore.getState().setPendingViewQuery('escalation')
    expect(useSearchPaletteStore.getState().pendingViewQuery).toBe('escalation')
    useSearchPaletteStore.getState().setPendingViewQuery(null)
    expect(useSearchPaletteStore.getState().pendingViewQuery).toBeNull()
  })
})
