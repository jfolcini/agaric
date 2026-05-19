/**
 * Tests for `useCommandPaletteStore` (PEND-61 — successor to
 * `useSearchPaletteStore`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCommandPaletteStore } from '../useCommandPaletteStore'

function resetStore(): void {
  useCommandPaletteStore.setState({
    open: false,
    mode: 'search',
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

describe('useCommandPaletteStore — open / close', () => {
  it('captures the element that has focus on open$', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    useCommandPaletteStore.getState().open$()
    expect(useCommandPaletteStore.getState().open).toBe(true)
    expect(useCommandPaletteStore.getState().previousFocusedElement).toBe(input)
    input.remove()
  })

  it('captures null when only the <body> is focused (i.e. cold open)', () => {
    document.body.focus()
    useCommandPaletteStore.getState().open$()
    expect(useCommandPaletteStore.getState().previousFocusedElement).toBeNull()
  })

  it('opens in search mode regardless of prior mode', () => {
    useCommandPaletteStore.setState({ mode: 'commands' })
    useCommandPaletteStore.getState().open$()
    expect(useCommandPaletteStore.getState().mode).toBe('search')
  })

  it('close() clears the query, mode, and captured focus reference', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    useCommandPaletteStore.getState().open$()
    useCommandPaletteStore.getState().setQuery('something')
    useCommandPaletteStore.getState().setMode('commands')
    useCommandPaletteStore.getState().close()
    expect(useCommandPaletteStore.getState().open).toBe(false)
    expect(useCommandPaletteStore.getState().query).toBe('')
    expect(useCommandPaletteStore.getState().mode).toBe('search')
    expect(useCommandPaletteStore.getState().previousFocusedElement).toBeNull()
    input.remove()
  })

  it('setPendingViewQuery writes and clears the handoff slot', () => {
    useCommandPaletteStore.getState().setPendingViewQuery('escalation')
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBe('escalation')
    useCommandPaletteStore.getState().setPendingViewQuery(null)
    expect(useCommandPaletteStore.getState().pendingViewQuery).toBeNull()
  })

  it('setMode swaps mode without affecting other state', () => {
    useCommandPaletteStore.setState({ query: 'keep me' })
    useCommandPaletteStore.getState().setMode('commands')
    expect(useCommandPaletteStore.getState().mode).toBe('commands')
    expect(useCommandPaletteStore.getState().query).toBe('keep me')
  })
})
