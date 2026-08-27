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

// #4338 — the palette's `create-new-page` command calls
// `commands.createPageInSpace` from `@/lib/bindings` directly (its
// `@/lib/tauri` wrapper was retired, #4411). Spread the real module so every
// other importer still binds what it expects, and intercept just the create;
// resolve the OK-envelope shape so the real `unwrap` at the call site runs.
const mockedCreatePageInSpace = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      createPageInSpace: (...args: unknown[]) =>
        mockedCreatePageInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { SHOW_SHORTCUTS_EVENT } from '@/lib/overlay-events'
import { getPaletteCommand, PALETTE_COMMANDS } from '@/lib/palette-commands'
import { useSpaceStore } from '@/stores/space'

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

// #4338 — the palette is one of the creation sites #4338 names by hand. It
// runs from module scope with no `useBlockResolve()` in reach, so a page
// created here never touched a warm `pagesListRef` before the bus emission.
describe('PALETTE_COMMANDS — create-new-page publishes to the name-change bus (#4338)', () => {
  beforeEach(() => {
    mockedCreatePageInSpace.mockReset()
    useSpaceStore.setState({
      currentSpaceId: 'SPACE_TEST',
      availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
      isReady: true,
    })
  })

  it("publishes an 'added' event for the page it creates", async () => {
    mockedCreatePageInSpace.mockResolvedValue('P_PALETTE_000000000000000')
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      getPaletteCommand('create-new-page')?.run({ onClose: vi.fn(), onEscalate: vi.fn() })

      // `run` is synchronous; the emission lands in the create promise's
      // `.then`, several microtasks later.
      await vi.waitFor(() =>
        expect(changes).toEqual([
          {
            kind: 'added',
            entity: 'page',
            id: 'P_PALETTE_000000000000000',
            name: 'Untitled',
            spaceId: 'SPACE_TEST',
          },
        ]),
      )
    } finally {
      unsubscribe()
    }
  })

  it('publishes nothing when the space store is not ready — no page was created', () => {
    useSpaceStore.setState({ currentSpaceId: null, isReady: false })
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      getPaletteCommand('create-new-page')?.run({ onClose: vi.fn(), onEscalate: vi.fn() })

      expect(mockedCreatePageInSpace).not.toHaveBeenCalled()
      expect(changes).toEqual([])
    } finally {
      unsubscribe()
    }
  })
})
