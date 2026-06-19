/**
 * Tests for useScrollCaretAboveKeyboard (#917) — keep the focused block's
 * caret above the on-screen soft keyboard.
 *
 * Validates:
 *  - computeKeyboardInset: keyboard-up overlap math, offsetTop accounting,
 *    clamp at 0, and pinch-zoom (scale > 1) treated as "no keyboard".
 *  - scrollCaretAboveKeyboard: falls back to plain scrollIntoView when there
 *    is no visualViewport or no inset; nudges the window up when the element
 *    is covered by the keyboard; no-ops when the element is already clear.
 *  - useScrollCaretAboveKeyboard: wires/cleans up visualViewport listeners,
 *    no-ops when disabled, and is inert when visualViewport is absent.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeKeyboardInset } from '@/lib/keyboard-inset'

import {
  scrollCaretAboveKeyboard,
  useScrollCaretAboveKeyboard,
} from '../useScrollCaretAboveKeyboard'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal visualViewport stand-in extending EventTarget so listener wiring
 * is exercised for real. Mirrors the FakeVisualViewport in sheet.test.tsx.
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

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

function setInnerHeight(value: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value,
    writable: true,
    configurable: true,
  })
}

function installVisualViewport(vv: FakeVisualViewport): void {
  Object.defineProperty(window, 'visualViewport', {
    value: vv,
    writable: true,
    configurable: true,
  })
}

/** Build an element whose getBoundingClientRect returns a fixed bottom. */
function elementWithBottom(bottom: number): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = vi.fn(
    () => ({ bottom, top: bottom - 24, left: 0, right: 100, width: 100, height: 24 }) as DOMRect,
  )
  return el
}

let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>
let scrollBySpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setInnerHeight(768)
  scrollIntoViewSpy = vi
    .spyOn(Element.prototype, 'scrollIntoView')
    .mockImplementation(() => undefined)
  scrollBySpy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  // @ts-expect-error — clear the per-test visualViewport stand-in.
  delete window.visualViewport
  if (originalInnerHeight) {
    Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  }
})

// ---------------------------------------------------------------------------
// computeKeyboardInset
// ---------------------------------------------------------------------------

describe('computeKeyboardInset', () => {
  it('returns the overlap when the keyboard is up', () => {
    const vv = new FakeVisualViewport(468) // 768 - 468 = 300
    expect(computeKeyboardInset(vv as unknown as VisualViewport)).toBe(300)
  })

  it('accounts for visualViewport.offsetTop', () => {
    const vv = new FakeVisualViewport(468)
    vv.offsetTop = 100 // 768 - (468 + 100) = 200
    expect(computeKeyboardInset(vv as unknown as VisualViewport)).toBe(200)
  })

  it('clamps to 0 when the keyboard is down', () => {
    const vv = new FakeVisualViewport(768)
    expect(computeKeyboardInset(vv as unknown as VisualViewport)).toBe(0)
  })

  it('treats a pinch-zoomed viewport (scale > 1) as no keyboard', () => {
    const vv = new FakeVisualViewport(384) // looks like a 384px keyboard
    vv.scale = 2
    expect(computeKeyboardInset(vv as unknown as VisualViewport)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// scrollCaretAboveKeyboard
// ---------------------------------------------------------------------------

describe('scrollCaretAboveKeyboard', () => {
  it('falls back to plain scrollIntoView({block:"nearest"}) when visualViewport is absent', () => {
    const el = elementWithBottom(700)
    scrollCaretAboveKeyboard(el, null)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })

  it('falls back to plain scrollIntoView when the keyboard is down (inset 0)', () => {
    const vv = new FakeVisualViewport(768) // no keyboard
    const el = elementWithBottom(700)
    scrollCaretAboveKeyboard(el, vv as unknown as VisualViewport)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })

  it('nudges the window up so a covered element clears the keyboard', () => {
    const vv = new FakeVisualViewport(468) // keyboard top at 468
    // Element bottom at 600 sits 132px BELOW the keyboard top → covered.
    // After the native nearest scroll (mocked, no real movement) the residual
    // overshoot = 600 - (468 - 8 margin) = 140 → window.scrollBy(top:140).
    const el = elementWithBottom(600)
    scrollCaretAboveKeyboard(el, vv as unknown as VisualViewport)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 140, left: 0 })
  })

  it('does NOT nudge when the element is already comfortably above the keyboard', () => {
    const vv = new FakeVisualViewport(468) // keyboard top at 468
    const el = elementWithBottom(200) // well above the keyboard
    scrollCaretAboveKeyboard(el, vv as unknown as VisualViewport)
    // Element clear of the covered region: no scroll at all.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    expect(scrollBySpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// useScrollCaretAboveKeyboard — hook wiring
// ---------------------------------------------------------------------------

describe('useScrollCaretAboveKeyboard', () => {
  function refTo(el: HTMLElement | null): React.RefObject<HTMLElement | null> {
    return { current: el }
  }

  it('no-ops when disabled (no listeners, no scroll)', () => {
    const vv = new FakeVisualViewport(468)
    installVisualViewport(vv)
    const addSpy = vi.spyOn(vv, 'addEventListener')
    const el = elementWithBottom(600)
    renderHook(() => useScrollCaretAboveKeyboard(refTo(el), false))
    expect(addSpy).not.toHaveBeenCalled()
    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
  })

  it('adds resize+scroll listeners on focus and removes them on unmount', () => {
    const vv = new FakeVisualViewport(768)
    installVisualViewport(vv)
    const added: string[] = []
    const removed: string[] = []
    vi.spyOn(vv, 'addEventListener').mockImplementation((t) => added.push(t as string))
    vi.spyOn(vv, 'removeEventListener').mockImplementation((t) => removed.push(t as string))
    const el = elementWithBottom(600)
    const { unmount } = renderHook(() => useScrollCaretAboveKeyboard(refTo(el), true))
    expect(added.sort()).toEqual(['resize', 'scroll'])
    unmount()
    expect(removed.sort()).toEqual(['resize', 'scroll'])
  })

  it('re-applies the scroll when the visualViewport resizes (keyboard opens)', () => {
    const vv = new FakeVisualViewport(768) // keyboard down at mount
    installVisualViewport(vv)
    const el = elementWithBottom(600)
    renderHook(() => useScrollCaretAboveKeyboard(refTo(el), true))
    scrollBySpy.mockClear()

    // Keyboard opens: vv.height shrinks so the element is now covered.
    vv.height = 468
    vv.dispatchEvent(new Event('resize'))
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 140, left: 0 })
  })

  it('is inert (does a one-shot nearest scroll, no throw) when visualViewport is absent', async () => {
    // window.visualViewport is undefined (jsdom default).
    const el = elementWithBottom(600)
    expect(() => renderHook(() => useScrollCaretAboveKeyboard(refTo(el), true))).not.toThrow()
    // The initial scroll is deferred via requestAnimationFrame; flush it.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // The rAF-deferred one-shot used the no-vv fallback path.
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })
})
