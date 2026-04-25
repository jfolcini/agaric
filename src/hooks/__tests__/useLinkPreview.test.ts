/**
 * Tests for useLinkPreview hook (UX-165).
 *
 * Validates:
 *  - Returns null/empty state when no link is hovered
 *  - Updates state when pointerenter fires on .external-link element
 *  - Clears state on pointerleave
 *  - Calls getLinkMetadata on hover (cache hit path)
 *  - Falls back to fetchLinkMetadata when cache miss
 *  - Handles fetch errors gracefully (no crash)
 *  - Debounces rapid hover changes
 *  - Works with both <a> (editor) and <span data-href> (static) links
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkMetadata } from '@/lib/tauri'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockGetLinkMetadata = vi.fn<(url: string) => Promise<LinkMetadata | null>>()
const mockFetchLinkMetadata = vi.fn<(url: string) => Promise<LinkMetadata>>()

vi.mock('@/lib/tauri', () => ({
  getLinkMetadata: (...args: unknown[]) => mockGetLinkMetadata(...(args as [string])),
  fetchLinkMetadata: (...args: unknown[]) => mockFetchLinkMetadata(...(args as [string])),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

import { useLinkPreview } from '../useLinkPreview'

// ── Helpers ──────────────────────────────────────────────────────────────

const SAMPLE_METADATA: LinkMetadata = {
  url: 'https://example.com',
  title: 'Example Site',
  favicon_url: 'https://example.com/favicon.ico',
  description: 'An example site',
  fetched_at: '2024-01-01T00:00:00Z',
  auth_required: false,
}

/** Create a container DOM element. */
function makeContainer(): HTMLDivElement {
  return document.createElement('div')
}

/** Create an anchor element with the external-link class. */
function createExternalLink(href = 'https://example.com'): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = 'external-link'
  a.href = href
  a.setAttribute('href', href)
  a.textContent = 'Example'
  // Mock getBoundingClientRect for the anchor
  a.getBoundingClientRect = () =>
    ({
      top: 100,
      bottom: 120,
      left: 50,
      right: 200,
      width: 150,
      height: 20,
      x: 50,
      y: 100,
      toJSON: () => ({}),
    }) as DOMRect
  return a
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('useLinkPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockGetLinkMetadata.mockResolvedValue(null)
    mockFetchLinkMetadata.mockResolvedValue(SAMPLE_METADATA)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null state when no link is hovered', () => {
    const { result } = renderHook(() => useLinkPreview(makeContainer()))
    expect(result.current.url).toBeNull()
    expect(result.current.metadata).toBeNull()
    expect(result.current.anchorRect).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('returns null state when container is null', () => {
    const { result } = renderHook(() => useLinkPreview(null))
    expect(result.current.url).toBeNull()
    expect(result.current.anchorRect).toBeNull()
  })

  it('updates state when pointerenter fires on .external-link element', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    expect(result.current.url).toBe('https://example.com')
    expect(result.current.anchorRect).not.toBeNull()
    expect(result.current.isLoading).toBe(true)
  })

  it('clears state on pointerleave', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    expect(result.current.url).toBe('https://example.com')

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    })

    expect(result.current.url).toBeNull()
    expect(result.current.metadata).toBeNull()
    expect(result.current.anchorRect).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('calls getLinkMetadata on hover (cache hit)', async () => {
    mockGetLinkMetadata.mockResolvedValue(SAMPLE_METADATA)

    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    // Advance past debounce (uses fake timers + async to flush promises)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(mockGetLinkMetadata).toHaveBeenCalledWith('https://example.com')
    expect(result.current.metadata).toEqual(SAMPLE_METADATA)
    expect(result.current.isLoading).toBe(false)
  })

  it('falls back to fetchLinkMetadata when cache miss', async () => {
    mockGetLinkMetadata.mockResolvedValue(null)
    mockFetchLinkMetadata.mockResolvedValue(SAMPLE_METADATA)

    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(mockGetLinkMetadata).toHaveBeenCalledWith('https://example.com')
    expect(mockFetchLinkMetadata).toHaveBeenCalledWith('https://example.com')
    expect(result.current.metadata).toEqual(SAMPLE_METADATA)
    expect(result.current.isLoading).toBe(false)
  })

  it('handles fetch errors gracefully (no crash)', async () => {
    mockGetLinkMetadata.mockRejectedValue(new Error('network error'))

    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    // Should not crash, loading should be false
    expect(result.current.isLoading).toBe(false)
    expect(result.current.metadata).toBeNull()
  })

  it('debounces rapid hover changes', async () => {
    const dom = makeContainer()
    const link1 = createExternalLink('https://example.com/1')
    const link2 = createExternalLink('https://example.com/2')
    dom.appendChild(link1)
    dom.appendChild(link2)

    renderHook(() => useLinkPreview(dom))

    // Hover over first link
    act(() => {
      link1.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    // Advance 50ms (not enough for debounce)
    act(() => {
      vi.advanceTimersByTime(50)
    })

    // Move away from first link
    act(() => {
      link1.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    })

    // Hover over second link
    act(() => {
      link2.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    // Advance past debounce and flush promises
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    // Only the second link's metadata should have been fetched
    expect(mockGetLinkMetadata).toHaveBeenCalledTimes(1)
    expect(mockGetLinkMetadata).toHaveBeenCalledWith('https://example.com/2')
  })

  it('does not fire fetch for non-link elements', () => {
    const dom = makeContainer()
    const span = document.createElement('span')
    span.textContent = 'not a link'
    dom.appendChild(span)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      span.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    expect(result.current.url).toBeNull()
    expect(mockGetLinkMetadata).not.toHaveBeenCalled()
  })

  it('stops responding to events after unmount', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { unmount } = renderHook(() => useLinkPreview(dom))

    unmount()

    // After unmount, dispatching an event should not cause errors
    // (the listeners should have been removed)
    expect(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    }).not.toThrow()
  })

  it('works with static span.external-link[data-href] elements', () => {
    const dom = makeContainer()
    const span = document.createElement('span')
    span.className = 'external-link'
    span.setAttribute('data-href', 'https://static.example.com')
    span.textContent = 'Static link'
    span.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 120,
        left: 50,
        right: 200,
        width: 150,
        height: 20,
        x: 50,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect
    dom.appendChild(span)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      span.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })

    expect(result.current.url).toBe('https://static.example.com')
    expect(result.current.anchorRect).not.toBeNull()
    expect(result.current.isLoading).toBe(true)
  })

  // ── Keyboard / focus support (UX-273) ──────────────────────────────

  it('updates state when focusin fires on .external-link element', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    expect(result.current.url).toBe('https://example.com')
    expect(result.current.anchorRect).not.toBeNull()
    expect(result.current.isLoading).toBe(true)
  })

  it('clears state on focusout', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(result.current.url).toBe('https://example.com')

    act(() => {
      link.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(result.current.url).toBeNull()
    expect(result.current.metadata).toBeNull()
    expect(result.current.anchorRect).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('does not fire focusin handler for non-link elements', () => {
    const dom = makeContainer()
    const span = document.createElement('span')
    span.textContent = 'not a link'
    dom.appendChild(span)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      span.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    expect(result.current.url).toBeNull()
    expect(mockGetLinkMetadata).not.toHaveBeenCalled()
  })

  it('focus then blur runs the same metadata-fetch path as hover', async () => {
    mockGetLinkMetadata.mockResolvedValue(SAMPLE_METADATA)

    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })

    expect(mockGetLinkMetadata).toHaveBeenCalledWith('https://example.com')
    expect(result.current.metadata).toEqual(SAMPLE_METADATA)
    expect(result.current.isLoading).toBe(false)
  })

  it('Escape dismisses the preview when one is shown', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(result.current.url).toBe('https://example.com')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(result.current.url).toBeNull()
    expect(result.current.anchorRect).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it('Escape with defaultPrevented=true does NOT dismiss the preview (additive behavior)', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    act(() => {
      link.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(result.current.url).toBe('https://example.com')

    // Simulate another handler consuming the Escape first
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      ev.preventDefault()
      window.dispatchEvent(ev)
    })

    // Preview should still be visible
    expect(result.current.url).toBe('https://example.com')
  })

  it('Escape is a no-op when no preview is currently shown', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    // No preview shown — pressing Escape should not throw or change state
    expect(() => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    }).not.toThrow()

    expect(result.current.url).toBeNull()
  })

  it('keeps mouse hover behavior intact alongside focus support', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const { result } = renderHook(() => useLinkPreview(dom))

    // Hover still works
    act(() => {
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
    })
    expect(result.current.url).toBe('https://example.com')

    act(() => {
      link.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    })
    expect(result.current.url).toBeNull()
  })

  it('removes focus and keydown listeners on unmount', () => {
    const dom = makeContainer()
    const link = createExternalLink()
    dom.appendChild(link)

    const removeContainerSpy = vi.spyOn(dom, 'removeEventListener')
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener')

    const { unmount } = renderHook(() => useLinkPreview(dom))
    unmount()

    expect(removeContainerSpy).toHaveBeenCalledWith('focusin', expect.any(Function))
    expect(removeContainerSpy).toHaveBeenCalledWith('focusout', expect.any(Function))
    expect(removeWindowSpy).toHaveBeenCalledWith('keydown', expect.any(Function))

    removeContainerSpy.mockRestore()
    removeWindowSpy.mockRestore()
  })
})
