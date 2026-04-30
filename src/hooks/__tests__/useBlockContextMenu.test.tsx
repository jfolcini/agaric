/**
 * Tests for useBlockContextMenu — owns the context-menu position and
 * the editing-prop / editing-key state slots.
 */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useBlockContextMenu } from '../useBlockContextMenu'

describe('useBlockContextMenu', () => {
  it('initial state has null contextMenu, editingProp, and editingKey', () => {
    const { result } = renderHook(() => useBlockContextMenu())
    expect(result.current.contextMenu).toBeNull()
    expect(result.current.editingProp).toBeNull()
    expect(result.current.editingKey).toBeNull()
  })

  it('openContextMenu(x, y) sets the menu position without linkUrl', () => {
    const { result } = renderHook(() => useBlockContextMenu())

    act(() => {
      result.current.openContextMenu(100, 200)
    })

    expect(result.current.contextMenu).toEqual({ x: 100, y: 200 })
    expect(result.current.contextMenu?.linkUrl).toBeUndefined()
  })

  it('openContextMenu(x, y, linkUrl) records the link URL alongside coords', () => {
    const { result } = renderHook(() => useBlockContextMenu())

    act(() => {
      result.current.openContextMenu(50, 75, 'https://example.com')
    })

    expect(result.current.contextMenu).toEqual({
      x: 50,
      y: 75,
      linkUrl: 'https://example.com',
    })
  })

  it('closeContextMenu clears the menu position', () => {
    const { result } = renderHook(() => useBlockContextMenu())

    act(() => {
      result.current.openContextMenu(10, 20, 'https://x.test')
    })
    expect(result.current.contextMenu).not.toBeNull()

    act(() => {
      result.current.closeContextMenu()
    })
    expect(result.current.contextMenu).toBeNull()
  })

  it('setEditingProp and setEditingKey update their respective state slots', () => {
    const { result } = renderHook(() => useBlockContextMenu())

    act(() => {
      result.current.setEditingProp({ key: 'status', value: 'open' })
    })
    expect(result.current.editingProp).toEqual({ key: 'status', value: 'open' })
    expect(result.current.editingKey).toBeNull()

    act(() => {
      result.current.setEditingKey({ oldKey: 'status', value: 'open' })
    })
    expect(result.current.editingKey).toEqual({ oldKey: 'status', value: 'open' })

    act(() => {
      result.current.setEditingProp(null)
      result.current.setEditingKey(null)
    })
    expect(result.current.editingProp).toBeNull()
    expect(result.current.editingKey).toBeNull()
  })
})
