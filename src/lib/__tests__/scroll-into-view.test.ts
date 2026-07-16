/**
 * Tests for scrollElementIntoView (#2664) — the shared imperative-scroll
 * helper that downgrades `behavior: 'smooth'` → `'auto'` when the user prefers
 * reduced motion, so raw smooth calls no longer bypass the OS/CSS preference.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scrollElementIntoView } from '@/lib/scroll-into-view'

/** Point `window.matchMedia` at a fixed reduced-motion answer. */
function mockReducedMotion(matches: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

function makeElement(): { el: Element; spy: ReturnType<typeof vi.fn> } {
  const el = document.createElement('div')
  const spy = vi.fn()
  el.scrollIntoView = spy
  return { el, spy }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scrollElementIntoView', () => {
  it('keeps smooth behavior when reduced motion is NOT preferred', () => {
    mockReducedMotion(false)
    const { el, spy } = makeElement()
    scrollElementIntoView(el, { behavior: 'smooth', block: 'center' })
    expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })

  it('downgrades smooth → auto when reduced motion IS preferred', () => {
    mockReducedMotion(true)
    const { el, spy } = makeElement()
    scrollElementIntoView(el, { behavior: 'smooth', block: 'center' })
    expect(spy).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
  })

  it('leaves a non-smooth behavior untouched under reduced motion', () => {
    mockReducedMotion(true)
    const { el, spy } = makeElement()
    scrollElementIntoView(el, { behavior: 'auto', block: 'nearest' })
    expect(spy).toHaveBeenCalledWith({ behavior: 'auto', block: 'nearest' })
  })

  it('does not add a behavior when none was requested (reduced motion on)', () => {
    mockReducedMotion(true)
    const { el, spy } = makeElement()
    scrollElementIntoView(el, { block: 'nearest' })
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('defaults to empty options', () => {
    mockReducedMotion(false)
    const { el, spy } = makeElement()
    scrollElementIntoView(el)
    expect(spy).toHaveBeenCalledWith({})
  })

  it('does not mutate the caller-provided options object', () => {
    mockReducedMotion(true)
    const { el } = makeElement()
    const options: ScrollIntoViewOptions = { behavior: 'smooth', block: 'center' }
    scrollElementIntoView(el, options)
    expect(options.behavior).toBe('smooth')
  })
})
