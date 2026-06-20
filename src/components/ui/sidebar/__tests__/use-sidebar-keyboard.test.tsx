/**
 * Tests for useSidebarKeyboard hook.
 *
 * Validates:
 *  - Cmd/Ctrl+B fires the toggle callback.
 *  - Toggle is NOT fired when the active target is an input, textarea,
 *    or contenteditable element (TipTap maps Ctrl+B to Bold).
 *  - Removes its window listener on unmount.
 */

import { fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setCustomShortcut } from '@/lib/keyboard-config'

import { useSidebarKeyboard } from '../use-sidebar-keyboard'

describe('useSidebarKeyboard', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('fires toggle on Ctrl+B', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('fires toggle on Cmd+B (metaKey)', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    fireEvent.keyDown(window, { key: 'b', metaKey: true })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('ignores plain "b" without a modifier', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    fireEvent.keyDown(window, { key: 'b' })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('skips toggle when target is an <input>', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    document.body.removeChild(input)
  })

  it('skips toggle when target is a <textarea>', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    const ta = document.createElement('textarea')
    document.body.append(ta)
    ta.focus()
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    document.body.removeChild(ta)
  })

  it('skips toggle when target is contenteditable', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.append(editor)
    editor.focus()
    fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    document.body.removeChild(editor)
  })

  it('#724: honours a Settings rebind — new chord fires, default Ctrl+B is dead', () => {
    setCustomShortcut('toggleSidebar', 'Ctrl + Shift + L')
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    // Old default no longer fires once rebound.
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    // The new chord does.
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true, shiftKey: true })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('removes the window listener on unmount', () => {
    const toggle = vi.fn()
    const { unmount } = renderHook(() => useSidebarKeyboard(toggle))

    unmount()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()
  })
})
