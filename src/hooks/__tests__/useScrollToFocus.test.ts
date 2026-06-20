/**
 * Tests for useScrollToFocus — the rAF + scrollIntoView pattern shared
 * between JournalPage (date/panel scroll) and DailyView (selectedBlockId
 * Scroll).
 *
 * Validates:
 *  - noop when `targetId == null` (no scroll, no onComplete)
 *  - calls `scrollIntoView` with the provided block/inline options
 *  - omits `behavior` when caller did not provide one
 *  - downgrades `behavior: 'smooth'` to `'auto'` under
 *    `prefers-reduced-motion: reduce`
 *  - honours a custom `resolveElement` resolver
 *  - invokes `onComplete` after the scroll attempt (even when the element
 *    is not found in the DOM)
 *  - cancels the pending rAF on unmount
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useScrollToFocus } from '../useScrollToFocus'

let scrollSpy: ReturnType<typeof vi.spyOn>
const seededElements: HTMLElement[] = []

function seedElementById(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  document.body.append(el)
  seededElements.push(el)
  return el
}

function seedElementByAttr(attr: string, value: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute(attr, value)
  document.body.append(el)
  seededElements.push(el)
  return el
}

async function flushRaf(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  scrollSpy.mockRestore()
  while (seededElements.length > 0) {
    const el = seededElements.pop()
    el?.parentNode?.removeChild(el)
  }
})

describe('useScrollToFocus', () => {
  it('is a no-op when targetId is null', async () => {
    const onComplete = vi.fn()
    renderHook(() => useScrollToFocus(null, { onComplete }))

    await flushRaf()

    expect(scrollSpy).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('is a no-op when targetId is undefined', async () => {
    const onComplete = vi.fn()
    renderHook(() => useScrollToFocus(undefined, { onComplete }))

    await flushRaf()

    expect(scrollSpy).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('scrolls the element looked up by id and forwards block/inline', async () => {
    seedElementById('journal-2026-04-20')

    renderHook(() => useScrollToFocus('journal-2026-04-20', { block: 'start', inline: 'nearest' }))

    await flushRaf()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.calls[0]?.[0]).toEqual({ block: 'start', inline: 'nearest' })
  })

  it('omits the behavior option when the caller does not provide one', async () => {
    seedElementByAttr('data-block-id', 'BLOCK_X')

    renderHook(() =>
      useScrollToFocus('BLOCK_X', {
        block: 'nearest',
        resolveElement: (id) => document.querySelector(`[data-block-id="${id}"]`),
      }),
    )

    await flushRaf()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    const call = scrollSpy.mock.calls[0]?.[0] as ScrollIntoViewOptions
    expect(call).toEqual({ block: 'nearest' })
    expect(call).not.toHaveProperty('behavior')
  })

  it('forwards behavior when provided', async () => {
    seedElementById('panel-due')

    renderHook(() => useScrollToFocus('panel-due', { behavior: 'smooth', block: 'start' }))

    await flushRaf()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({ behavior: 'smooth', block: 'start' })
  })

  it('downgrades smooth → auto under prefers-reduced-motion', async () => {
    seedElementById('panel-due')

    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia

    renderHook(() => useScrollToFocus('panel-due', { behavior: 'smooth', block: 'start' }))

    await flushRaf()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({ behavior: 'auto', block: 'start' })

    window.matchMedia = originalMatchMedia
  })

  it('uses a custom resolveElement resolver when provided', async () => {
    const block = seedElementByAttr('data-block-id', 'BLOCK_Y')
    const resolveElement = vi.fn((id: string) => document.querySelector(`[data-block-id="${id}"]`))

    renderHook(() => useScrollToFocus('BLOCK_Y', { block: 'nearest', resolveElement }))

    await flushRaf()

    expect(resolveElement).toHaveBeenCalledWith('BLOCK_Y')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    // Confirm the spy was called on the resolved element specifically.
    expect(scrollSpy.mock.contexts[0]).toBe(block)
  })

  it('invokes onComplete after a successful scroll', async () => {
    seedElementById('panel-done')
    const onComplete = vi.fn()

    renderHook(() => useScrollToFocus('panel-done', { block: 'start', onComplete }))

    await flushRaf()

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith('panel-done')
  })

  it('invokes onComplete even when the element is not found', async () => {
    const onComplete = vi.fn()

    renderHook(() => useScrollToFocus('missing-id', { onComplete }))

    await flushRaf()

    expect(scrollSpy).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith('missing-id')
  })

  it('cancels the pending requestAnimationFrame on unmount', async () => {
    seedElementById('panel-due')
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    const onComplete = vi.fn()

    const { unmount } = renderHook(() => useScrollToFocus('panel-due', { onComplete }))
    unmount()

    expect(cancelSpy).toHaveBeenCalled()

    // Drain the rAF tick to confirm the cancelled callback never fired.
    await flushRaf()
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()

    cancelSpy.mockRestore()
  })
})
