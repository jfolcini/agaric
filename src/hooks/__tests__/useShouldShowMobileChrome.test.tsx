/**
 * PEND-68 — tests for useShouldShowMobileChrome.
 */

import { fireEvent, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetHardwareKeyboardLatchForTests } from '../useHasHardwareKeyboard'
import { useShouldShowMobileChrome } from '../useShouldShowMobileChrome'

interface MqlMock {
  matches: boolean
  addEventListener: (ev: string, l: () => void) => void
  removeEventListener: (ev: string, l: () => void) => void
  fire: () => void
}

function installMatchMedia(initialMatches: (q: string) => boolean): MqlMock[] {
  const created: MqlMock[] = []
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string): MediaQueryList => {
      const listeners = new Set<() => void>()
      const mock: MqlMock = {
        matches: initialMatches(query),
        addEventListener: (_ev, l) => listeners.add(l),
        removeEventListener: (_ev, l) => listeners.delete(l),
        fire: () => {
          for (const l of listeners) l()
        },
      }
      created.push(mock)
      return mock as unknown as MediaQueryList
    }),
  )
  return created
}

function setInnerWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true })
}

beforeEach(() => {
  _resetHardwareKeyboardLatchForTests()
})

afterEach(() => {
  _resetHardwareKeyboardLatchForTests()
  vi.unstubAllGlobals()
})

function Probe(): React.ReactElement {
  const v = useShouldShowMobileChrome()
  return <div data-testid="probe">{v ? 'mobile' : 'desktop'}</div>
}

describe('useShouldShowMobileChrome', () => {
  it('phone (< 768) always shows mobile chrome regardless of keyboard signal', () => {
    setInnerWidth(390)
    installMatchMedia((q) => q.includes('max-width: 767px') || q.includes('max-width: 1023px'))
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('mobile')
    // Even after a keydown, phone stays mobile (the isMobile branch is
    // load-bearing on its own).
    fireEvent.keyDown(document, { key: 'a' })
    expect(getByTestId('probe').textContent).toBe('mobile')
  })

  it('iPad portrait (768) with NO keyboard shows mobile chrome', () => {
    setInnerWidth(768)
    installMatchMedia((q) => q.includes('max-width: 1023px'))
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('mobile')
  })

  it('iPad portrait (768) with hardware keyboard shows desktop chrome', () => {
    setInnerWidth(768)
    installMatchMedia((q) => q.includes('max-width: 1023px'))
    const { getByTestId } = render(<Probe />)
    // Initially mobile (no keydown yet).
    expect(getByTestId('probe').textContent).toBe('mobile')
    // Hardware keyboard signal arrives.
    fireEvent.keyDown(document, { key: 'a' })
    expect(getByTestId('probe').textContent).toBe('desktop')
  })

  it('iPad landscape (1023) with NO keyboard shows mobile chrome', () => {
    setInnerWidth(1023)
    installMatchMedia((q) => q.includes('max-width: 1023px'))
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('mobile')
  })

  it('desktop (1280) never shows mobile chrome', () => {
    setInnerWidth(1280)
    installMatchMedia(() => false)
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('desktop')
    // Even with no keyboard signal, ≥ 1024 is desktop-shaped.
    expect(getByTestId('probe').textContent).toBe('desktop')
  })

  it('viewport resize from desktop to tablet flips back to mobile chrome', () => {
    setInnerWidth(1280)
    const mqls = installMatchMedia((q) => {
      if (q.includes('max-width: 767px')) return false
      if (q.includes('max-width: 1023px')) return false
      return false
    })
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('probe').textContent).toBe('desktop')

    // Shrink to tablet width and fire the matchMedia change for the
    // 1024 breakpoint. matches flips to true; component re-reads
    // window.innerWidth.
    act(() => {
      setInnerWidth(900)
      for (const mql of mqls) {
        mql.matches = true
        mql.fire()
      }
    })
    expect(getByTestId('probe').textContent).toBe('mobile')
  })
})
