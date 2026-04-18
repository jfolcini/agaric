import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createElement, createRef, useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import {
  PrimaryFocusProvider,
  usePrimaryFocusRegistry,
  useRegisterPrimaryFocus,
} from '../usePrimaryFocus'

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(PrimaryFocusProvider, null, children)
}

describe('usePrimaryFocus', () => {
  it('focus() returns false when nothing is registered', () => {
    const { result } = renderHook(() => usePrimaryFocusRegistry(), {
      wrapper: Wrapper,
    })

    expect(result.current).not.toBeNull()
    expect(result.current?.focus()).toBe(false)
  })

  it('focus() returns true and focuses registered element when attached to DOM', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)

    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input

    const { result } = renderHook(
      () => {
        const registry = usePrimaryFocusRegistry()
        useEffect(() => {
          registry?.register(ref)
          return () => registry?.unregister(ref)
        }, [registry])
        return registry
      },
      { wrapper: Wrapper },
    )

    let focused = false
    act(() => {
      focused = result.current?.focus() ?? false
    })

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(input)

    input.remove()
  })

  it('focus() returns false when element is detached from DOM', () => {
    const input = document.createElement('input')
    // intentionally NOT attached to document.body
    const ref = createRef<HTMLInputElement>()
    ;(ref as { current: HTMLInputElement | null }).current = input

    const { result } = renderHook(
      () => {
        const registry = usePrimaryFocusRegistry()
        useEffect(() => {
          registry?.register(ref)
          return () => registry?.unregister(ref)
        }, [registry])
        return registry
      },
      { wrapper: Wrapper },
    )

    expect(result.current?.focus()).toBe(false)
  })

  it('register replaces any previously-registered ref', () => {
    const firstInput = document.createElement('input')
    const secondInput = document.createElement('input')
    firstInput.setAttribute('data-id', 'first')
    secondInput.setAttribute('data-id', 'second')
    document.body.append(firstInput, secondInput)

    const firstRef = { current: firstInput }
    const secondRef = { current: secondInput }

    const { result } = renderHook(() => usePrimaryFocusRegistry(), {
      wrapper: Wrapper,
    })

    act(() => {
      result.current?.register(firstRef)
      result.current?.register(secondRef)
    })

    act(() => {
      result.current?.focus()
    })

    expect(document.activeElement).toBe(secondInput)

    firstInput.remove()
    secondInput.remove()
  })

  it('unregister clears only if the provided ref is the current one', () => {
    const a = document.createElement('input')
    const b = document.createElement('input')
    document.body.append(a, b)

    const aRef = { current: a }
    const bRef = { current: b }

    const { result } = renderHook(() => usePrimaryFocusRegistry(), {
      wrapper: Wrapper,
    })

    // Register A
    act(() => {
      result.current?.register(aRef)
    })
    // Then register B (replaces A)
    act(() => {
      result.current?.register(bRef)
    })
    // Unregistering A should NOT clear B
    act(() => {
      result.current?.unregister(aRef)
    })
    // focus() should still focus B
    act(() => {
      result.current?.focus()
    })
    expect(document.activeElement).toBe(b)

    a.remove()
    b.remove()
  })

  it('unregister clears when the ref being unregistered is the current one', () => {
    const el = document.createElement('input')
    document.body.append(el)
    const ref = { current: el }

    const { result } = renderHook(() => usePrimaryFocusRegistry(), {
      wrapper: Wrapper,
    })

    act(() => {
      result.current?.register(ref)
    })
    act(() => {
      result.current?.unregister(ref)
    })

    expect(result.current?.focus()).toBe(false)

    el.remove()
  })

  it('useRegisterPrimaryFocus registers on mount and unregisters on unmount', () => {
    const el = document.createElement('button')
    document.body.append(el)
    const ref = { current: el }

    let registryCapture: ReturnType<typeof usePrimaryFocusRegistry> = null as ReturnType<
      typeof usePrimaryFocusRegistry
    >

    const { unmount } = renderHook(
      () => {
        registryCapture = usePrimaryFocusRegistry()
        useRegisterPrimaryFocus(ref)
      },
      { wrapper: Wrapper },
    )

    // After mount, focus() should succeed (registered)
    let focused = false
    act(() => {
      focused = registryCapture?.focus() ?? false
    })
    expect(focused).toBe(true)
    expect(document.activeElement).toBe(el)

    // After unmount, focus() should return false (unregistered)
    el.blur() // reset focus state
    unmount()
    expect(registryCapture?.focus()).toBe(false)

    el.remove()
  })

  it('usePrimaryFocusRegistry returns null outside the provider', () => {
    const { result } = renderHook(() => usePrimaryFocusRegistry())
    expect(result.current).toBeNull()
  })

  it('useRegisterPrimaryFocus is a no-op outside the provider (does not throw)', () => {
    const el = document.createElement('input')
    const ref = { current: el }
    expect(() => {
      renderHook(() => useRegisterPrimaryFocus(ref))
    }).not.toThrow()
  })

  it('focus() uses preventScroll: true to avoid jumping to the top', () => {
    const el = document.createElement('input')
    document.body.append(el)
    const ref = { current: el }

    const focusSpy = el.focus.bind(el)
    let lastArgs: FocusOptions | undefined
    el.focus = ((options?: FocusOptions) => {
      lastArgs = options
      focusSpy(options)
    }) as typeof el.focus

    const { result } = renderHook(() => usePrimaryFocusRegistry(), {
      wrapper: Wrapper,
    })

    act(() => {
      result.current?.register(ref)
      result.current?.focus()
    })

    expect(lastArgs).toEqual({ preventScroll: true })

    el.remove()
  })
})
