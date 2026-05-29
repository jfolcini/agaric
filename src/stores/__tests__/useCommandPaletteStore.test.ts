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

  it('setMode swaps the active mode', () => {
    useCommandPaletteStore.getState().setMode('commands')
    expect(useCommandPaletteStore.getState().mode).toBe('commands')
    useCommandPaletteStore.getState().setMode('search')
    expect(useCommandPaletteStore.getState().mode).toBe('search')
  })
})

describe('useCommandPaletteStore — per-mode persistent query (PEND-67 Phase 6)', () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({
      open: true,
      mode: 'search',
      query: '',
      queryByMode: {
        search: '',
        commands: '',
        tags: '',
        help: '',
        nav: '',
        spaces: '',
        agents: '',
        settings: '',
      },
      pendingViewQuery: null,
      previousFocusedElement: null,
    })
  })

  it('setQuery mirrors into queryByMode[mode]', () => {
    useCommandPaletteStore.getState().setQuery('alpha')
    expect(useCommandPaletteStore.getState().query).toBe('alpha')
    expect(useCommandPaletteStore.getState().queryByMode.search).toBe('alpha')
    expect(useCommandPaletteStore.getState().queryByMode.commands).toBe('')
  })

  it('setMode restores the remembered query for the new mode', () => {
    useCommandPaletteStore.getState().setQuery('alpha')
    useCommandPaletteStore.getState().setMode('commands')
    expect(useCommandPaletteStore.getState().mode).toBe('commands')
    expect(useCommandPaletteStore.getState().query).toBe('')

    useCommandPaletteStore.getState().setQuery('open')
    useCommandPaletteStore.getState().setMode('search')
    expect(useCommandPaletteStore.getState().query).toBe('alpha')

    useCommandPaletteStore.getState().setMode('commands')
    expect(useCommandPaletteStore.getState().query).toBe('open')
  })

  it('enterModeWithQuery clears the previous slot and seeds the new one', () => {
    useCommandPaletteStore.getState().setQuery('>alpha')
    expect(useCommandPaletteStore.getState().queryByMode.search).toBe('>alpha')

    useCommandPaletteStore.getState().enterModeWithQuery('commands', 'alpha')
    expect(useCommandPaletteStore.getState().mode).toBe('commands')
    expect(useCommandPaletteStore.getState().query).toBe('alpha')
    expect(useCommandPaletteStore.getState().queryByMode.search).toBe('')
    expect(useCommandPaletteStore.getState().queryByMode.commands).toBe('alpha')
  })

  it('close() resets queryByMode to all-empty', () => {
    useCommandPaletteStore.getState().setQuery('alpha')
    useCommandPaletteStore.getState().setMode('commands')
    useCommandPaletteStore.getState().setQuery('open')
    useCommandPaletteStore.getState().close()
    const state = useCommandPaletteStore.getState()
    expect(state.queryByMode.search).toBe('')
    expect(state.queryByMode.commands).toBe('')
    expect(state.query).toBe('')
  })
})
