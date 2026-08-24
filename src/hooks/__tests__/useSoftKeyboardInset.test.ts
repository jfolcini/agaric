/**
 * Tests for useSoftKeyboardInset (#4313) — extracted from `ui/sheet.tsx`
 * (#760) so `Popover` could share the same soft-keyboard math.
 *
 * Validates:
 *  - the ordinary case: a `resize` that shrinks the visual viewport produces
 *    the expected non-zero inset.
 *  - `enabled === false` resets the inset to 0 and wires no listeners.
 *  - listener cleanup on unmount (both `resize` and `scroll`).
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSoftKeyboardInset } from '@/hooks/useSoftKeyboardInset'

/**
 * Minimal visualViewport stand-in extending EventTarget so the hook's
 * `addEventListener('resize' | 'scroll', …)` wiring is exercised for real.
 * Mirrors the FakeVisualViewport in sheet.test.tsx / useScrollCaretAboveKeyboard.test.ts.
 */
class FakeVisualViewport extends EventTarget {
  height: number
  offsetTop = 0
  width = 1024
  scale = 1
  constructor(height: number) {
    super()
    this.height = height
  }
}

function installVisualViewport(height: number): FakeVisualViewport {
  const vv = new FakeVisualViewport(height)
  Object.defineProperty(window, 'visualViewport', {
    value: vv,
    writable: true,
    configurable: true,
  })
  return vv
}

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

function setInnerHeight(value: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value,
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  setInnerHeight(768)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalInnerHeight) {
    Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  }
})

describe('useSoftKeyboardInset', () => {
  it('reports a non-zero inset when the visual viewport shrinks under a resize', () => {
    const vv = installVisualViewport(768) // no keyboard at mount
    const { result } = renderHook(() => useSoftKeyboardInset())
    expect(result.current).toBe(0)

    act(() => {
      vv.height = 468 // 768 - 468 = 300px keyboard overlap
      vv.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toBe(300)
  })

  it('resets to 0 and wires no listeners when disabled', () => {
    const vv = installVisualViewport(468) // keyboard already up
    const addSpy = vi.spyOn(vv, 'addEventListener')
    const { result } = renderHook(() => useSoftKeyboardInset(false))
    expect(result.current).toBe(0)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('removes both resize and scroll listeners on unmount', () => {
    const vv = installVisualViewport(768)
    const added: string[] = []
    const removed: string[] = []
    vi.spyOn(vv, 'addEventListener').mockImplementation((type) => added.push(type as string))
    vi.spyOn(vv, 'removeEventListener').mockImplementation((type) => removed.push(type as string))

    const { unmount } = renderHook(() => useSoftKeyboardInset())
    expect(added.toSorted()).toEqual(['resize', 'scroll'])

    unmount()
    expect(removed.toSorted()).toEqual(['resize', 'scroll'])
  })
})
