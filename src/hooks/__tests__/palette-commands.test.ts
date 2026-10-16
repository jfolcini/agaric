/**
 * Tests for the palette command registry (#922 focus: the "Keyboard
 * shortcuts" entry).
 *
 * The `?` chord is suppressed while an editor is focused (so a literal `?`
 * types during outlining), so the command palette is the editor-agnostic path
 * to the cheatsheet. The command must dispatch `SHOW_SHORTCUTS_EVENT` (which
 * `useAppDialogs` listens for to open the sheet) and close the palette.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      // Opening a page stamps it for the Pages view's "Last opened" sort (#5371).
      recordPageOpen: () => Promise.resolve({ status: 'ok', data: null }),
    },
  }
})

import { getPaletteCommand, PALETTE_COMMANDS } from '@/hooks/palette-commands'
import { OPEN_NEW_PAGE_DIALOG_EVENT, SHOW_SHORTCUTS_EVENT } from '@/lib/overlay-events'
import {
  type LocalGraphPreference,
  PREFERENCES,
  readPreference,
  writePreference,
} from '@/lib/preferences'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

describe('PALETTE_COMMANDS — keyboard-shortcuts entry (#922)', () => {
  const listener = vi.fn()
  const handler: EventListener = (e) => listener(e)

  beforeEach(() => {
    listener.mockClear()
    window.addEventListener(SHOW_SHORTCUTS_EVENT, handler)
  })
  afterEach(() => {
    window.removeEventListener(SHOW_SHORTCUTS_EVENT, handler)
  })

  it('registers a "keyboard-shortcuts" command surfacing the showShortcuts chord', () => {
    const cmd = getPaletteCommand('keyboard-shortcuts')
    expect(cmd).toBeDefined()
    expect(cmd?.category).toBe('action')
    // The inline chord chip advertises the `?` binding for the non-editing case.
    expect(cmd?.shortcutId).toBe('showShortcuts')
  })

  it('dispatches SHOW_SHORTCUTS_EVENT and closes the palette when run', () => {
    const cmd = getPaletteCommand('keyboard-shortcuts')
    const onClose = vi.fn()
    const onEscalate = vi.fn()

    cmd?.run({ onClose, onEscalate })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    // It opens the sheet via the event — not by escalating to the search view.
    expect(onEscalate).not.toHaveBeenCalled()
  })

  it('every command id is unique', () => {
    const ids = PALETTE_COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// #5637 — "New page" opens the New page dialog; the page is made there.
describe('PALETTE_COMMANDS — create-new-page opens the New page dialog', () => {
  it('closes the palette and opens the dialog with no title', () => {
    const onClose = vi.fn()
    const opened: string[] = []
    const listener = (e: Event) => opened.push((e as CustomEvent<string>).detail)
    window.addEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, listener)
    try {
      getPaletteCommand('create-new-page')?.run({ onClose, onEscalate: vi.fn() })
    } finally {
      window.removeEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, listener)
    }
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(opened).toEqual([''])
  })
})

// #5269 — the sidebar's theme row and Status view are gone; these two
// commands are their keyboard paths.
describe('PALETTE_COMMANDS — toggle-theme and go-status (#5269)', () => {
  beforeEach(() => {
    localStorage.removeItem('theme-preference')
    useNavigationStore.setState({ currentView: 'journal', pendingSettingsTab: null })
  })

  it('toggle-theme advances the stored theme preference and closes the palette', () => {
    const onClose = vi.fn()

    getPaletteCommand('toggle-theme')?.run({ onClose, onEscalate: vi.fn() })

    // auto (light system) → dark, the next step that changes what is shown.
    expect(localStorage.getItem('theme-preference')).toBe('dark')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('go-status opens Settings with the Status tab requested', () => {
    const onClose = vi.fn()

    getPaletteCommand('go-status')?.run({ onClose, onEscalate: vi.fn() })

    const navigation = useNavigationStore.getState()
    expect(navigation.currentView).toBe('settings')
    expect(navigation.pendingSettingsTab).toBe('status')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// #5433 — one action from the open page lands on its local graph. GraphView
// seeds local mode from the active tab's top page and reads the per-space mode
// on mount, so the persisted mode plus the view are the whole observable effect.
describe('PALETTE_COMMANDS — show-page-in-graph (#5433)', () => {
  const run = () =>
    getPaletteCommand('show-page-in-graph')?.run({ onClose: vi.fn(), onEscalate: vi.fn() })
  const graphLocalKeys = () =>
    Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k) =>
      k?.startsWith('agaric:graph-local'),
    )

  beforeEach(() => {
    localStorage.clear()
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_TEST',
      availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
      isReady: true,
    })
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'Page one' }], label: '' }],
      activeTabIndex: 0,
    })
    useNavigationStore.setState({ currentView: 'page-editor' })
  })

  it('turns local mode on for the active space, keeps the depth, and opens the graph', () => {
    writePreference<LocalGraphPreference>(
      PREFERENCES.graphLocal,
      { active: false, hops: 1 },
      'SPACE_TEST',
    )
    const onClose = vi.fn()

    getPaletteCommand('show-page-in-graph')?.run({ onClose, onEscalate: vi.fn() })

    expect(useNavigationStore.getState().currentView).toBe('graph')
    expect(readPreference(PREFERENCES.graphLocal, 'SPACE_TEST')).toEqual({ active: true, hops: 1 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers its shortcut chip through the keyboard config', () => {
    expect(getPaletteCommand('show-page-in-graph')?.shortcutId).toBe('showPageInGraph')
  })

  it('changes nothing when the editor shows no page', () => {
    useNavigationStore.setState({ currentView: 'journal' })
    run()
    expect(useNavigationStore.getState().currentView).toBe('journal')

    useNavigationStore.setState({ currentView: 'page-editor' })
    useTabsStore.setState({ tabs: [{ id: '0', pageStack: [], label: '' }], activeTabIndex: 0 })
    run()
    expect(useNavigationStore.getState().currentView).toBe('page-editor')

    expect(graphLocalKeys()).toEqual([])
  })

  it('fails closed without an active space: no mode written under any key', () => {
    useSpaceStore.setState({ currentSpaceId: null, isReady: false })
    // The space switch swaps in that space's view and tabs; put the page back
    // so only the missing space can stop the command.
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'Page one' }], label: '' }],
      activeTabIndex: 0,
    })
    useNavigationStore.setState({ currentView: 'page-editor' })

    run()

    expect(useNavigationStore.getState().currentView).toBe('page-editor')
    expect(graphLocalKeys()).toEqual([])
  })
})
