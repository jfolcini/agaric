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

import { SHOW_SHORTCUTS_EVENT } from '../overlay-events'
import { getPaletteCommand, PALETTE_COMMANDS } from '../palette-commands'

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
