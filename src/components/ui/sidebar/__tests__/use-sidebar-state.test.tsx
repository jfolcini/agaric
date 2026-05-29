/**
 * Tests for useSidebarState hook.
 *
 * Validates:
 *  - Returns the initial state shape exposed by SidebarContext.
 *  - Controlled / uncontrolled `open` handoff via openProp / onOpenChange.
 *  - `setOpen` writes the `sidebar_state` cookie.
 *  - `sidebarWidth` reads / clamps / writes via localStorage.
 *  - `toggleSidebar` flips desktop (`open`) state — mobile path is tested
 *    indirectly via the sidebar component tests.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SIDEBAR_WIDTH_DEFAULT, useSidebarState } from '../use-sidebar-state'

beforeEach(() => {
  // Default to desktop viewport so isMobile is false.
  Object.defineProperty(window, 'innerWidth', {
    value: 1024,
    configurable: true,
    writable: true,
  })
  localStorage.removeItem('sidebar_width')
  // Clear cookies set by previous tests.
  // oxlint-disable-next-line unicorn/no-document-cookie -- test cleanup
  document.cookie = 'sidebar_state=; path=/; max-age=0'
})

afterEach(() => {
  localStorage.removeItem('sidebar_width')
})

describe('useSidebarState', () => {
  it('returns expanded state with defaultOpen=true', () => {
    const { result } = renderHook(() => useSidebarState({ defaultOpen: true }))
    expect(result.current.open).toBe(true)
    expect(result.current.state).toBe('expanded')
    expect(result.current.openMobile).toBe(false)
    expect(result.current.isResizing).toBe(false)
  })

  it('returns collapsed state with defaultOpen=false', () => {
    const { result } = renderHook(() => useSidebarState({ defaultOpen: false }))
    expect(result.current.open).toBe(false)
    expect(result.current.state).toBe('collapsed')
  })

  it('setOpen toggles state and writes cookie (uncontrolled mode)', () => {
    const { result } = renderHook(() => useSidebarState({ defaultOpen: true }))

    act(() => {
      result.current.setOpen(false)
    })

    expect(result.current.open).toBe(false)
    expect(result.current.state).toBe('collapsed')
    expect(document.cookie).toContain('sidebar_state=false')
  })

  it('controlled mode delegates to onOpenChange and does not write internal state', () => {
    const onOpenChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSidebarState({ defaultOpen: true, open, onOpenChange }),
      { initialProps: { open: true } },
    )

    expect(result.current.open).toBe(true)

    act(() => {
      result.current.setOpen(false)
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    // External "open" prop still true → hook stays open until parent re-renders.
    expect(result.current.open).toBe(true)

    rerender({ open: false })
    expect(result.current.open).toBe(false)
  })

  it('sidebarWidth seeds from localStorage when valid', () => {
    localStorage.setItem('sidebar_width', '200')
    const { result } = renderHook(() => useSidebarState({}))
    expect(result.current.sidebarWidth).toBe(200)
  })

  it('sidebarWidth falls back to default when localStorage missing', () => {
    const { result } = renderHook(() => useSidebarState({}))
    expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('sidebarWidth clamps below SIDEBAR_WIDTH_MIN to default', () => {
    localStorage.setItem('sidebar_width', '50') // below min
    const { result } = renderHook(() => useSidebarState({}))
    expect(result.current.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('setSidebarWidth clamps and persists to localStorage', () => {
    const { result } = renderHook(() => useSidebarState({}))

    act(() => {
      result.current.setSidebarWidth(180)
    })
    expect(result.current.sidebarWidth).toBe(180)
    expect(localStorage.getItem('sidebar_width')).toBe('180')

    // Too small → clamps to min (120).
    act(() => {
      result.current.setSidebarWidth(10)
    })
    expect(result.current.sidebarWidth).toBe(120)
    expect(localStorage.getItem('sidebar_width')).toBe('120')

    // Too big → clamps to 50% of innerWidth (1024 * 0.5 = 512).
    act(() => {
      result.current.setSidebarWidth(9999)
    })
    expect(result.current.sidebarWidth).toBe(512)
    expect(localStorage.getItem('sidebar_width')).toBe('512')
  })

  it('toggleSidebar flips desktop open state via functional update', () => {
    const { result } = renderHook(() => useSidebarState({ defaultOpen: true }))

    act(() => {
      result.current.toggleSidebar()
    })
    expect(result.current.open).toBe(false)

    act(() => {
      result.current.toggleSidebar()
    })
    expect(result.current.open).toBe(true)
  })
})
