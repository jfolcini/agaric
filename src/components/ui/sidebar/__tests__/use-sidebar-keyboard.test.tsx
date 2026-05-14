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
import { describe, expect, it, vi } from 'vitest'
import { useSidebarKeyboard } from '../use-sidebar-keyboard'

describe('useSidebarKeyboard', () => {
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
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    document.body.removeChild(input)
  })

  it('skips toggle when target is a <textarea>', () => {
    const toggle = vi.fn()
    renderHook(() => useSidebarKeyboard(toggle))

    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
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
    document.body.appendChild(editor)
    editor.focus()
    fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    document.body.removeChild(editor)
  })

  it('removes the window listener on unmount', () => {
    const toggle = vi.fn()
    const { unmount } = renderHook(() => useSidebarKeyboard(toggle))

    unmount()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()
  })
})
