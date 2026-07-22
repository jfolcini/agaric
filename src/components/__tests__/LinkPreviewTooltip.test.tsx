/**
 * Tests for LinkPreviewTooltip component.
 *
 * Validates:
 *  - Returns null when no link is hovered
 *  - Renders tooltip with title and favicon when metadata is available
 *  - Shows URL fallback when no title
 *  - Shows loading spinner when isLoading
 *  - Shows Globe icon when no favicon_url
 *  - Handles image load error (favicon fallback)
 *  - axe accessibility audit
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { LinkPreviewState } from '@/hooks/useLinkPreview'
import {
  EXTERNAL_IMAGE_ALLOWLIST_KEY,
  EXTERNAL_IMAGE_POLICY_KEY,
} from '@/lib/external-image-policy'
import { logger } from '@/lib/logger'
import type { LinkMetadata } from '@/lib/tauri'

// ── Mocks ────────────────────────────────────────────────────────────────

const mockUseLinkPreview = vi.fn<(container: unknown) => LinkPreviewState>()

vi.mock('@/hooks/useLinkPreview', () => ({
  useLinkPreview: (container: unknown) => mockUseLinkPreview(container),
}))

// Mock @floating-ui/dom to avoid layout-dependent calculations in jsdom
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 50, y: 120 }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
}))

import { computePosition } from '@floating-ui/dom'

import { LinkPreviewTooltip } from '@/components/LinkPreviewTooltip'

// ── Helpers ──────────────────────────────────────────────────────────────

const SAMPLE_METADATA: LinkMetadata = {
  url: 'https://example.com',
  title: 'Example Site',
  favicon_url: 'https://example.com/favicon.ico',
  description: 'An example site',
  fetched_at: 1704067200000, // 2024-01-01T00:00:00Z
  auth_required: false,
  not_found: false,
}

const SAMPLE_RECT = new DOMRect(50, 100, 150, 20)

function makeContainer(): HTMLDivElement {
  return document.createElement('div')
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('LinkPreviewTooltip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // #2959 — the favicon <img> is now gated behind the external-image
    // policy/allowlist (`shouldLoadExternalImage`). Default to the
    // permissive `always` policy so the pre-existing favicon-rendering
    // assertions below (which predate the privacy gate and are not testing
    // it) keep exercising the "favicon loads" path unchanged. The dedicated
    // "external-image policy gating (#2959)" describe block below overrides
    // this per test to exercise `click` / `never` / allowlist behaviour.
    localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'always')
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns null when no link is hovered', () => {
    mockUseLinkPreview.mockReturnValue({
      url: null,
      metadata: null,
      anchorRect: null,
      isLoading: false,
    })

    const { container } = render(<LinkPreviewTooltip container={makeContainer()} />)
    expect(container.innerHTML).toBe('')
  })

  it('returns null when url is set but anchorRect is null', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: null,
      anchorRect: null,
      isLoading: false,
    })

    const { container } = render(<LinkPreviewTooltip container={makeContainer()} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders tooltip with title and favicon when metadata is available', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    expect(tooltip).toBeInTheDocument()

    // Favicon image
    const img = tooltip.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img?.src).toBe('https://example.com/favicon.ico')
    expect(img?.width).toBe(16)
    expect(img?.height).toBe(16)

    // Title text
    expect(tooltip).toHaveTextContent('Example Site')
  })

  it('shows URL fallback when no title', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: { ...SAMPLE_METADATA, title: null },
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    expect(tooltip).toHaveTextContent('https://example.com')
    // Should not show the title class
    expect(tooltip.querySelector('.font-medium')).toBeNull()
  })

  it('shows loading spinner when isLoading', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: null,
      anchorRect: SAMPLE_RECT,
      isLoading: true,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    // Should have a spinner
    const spinner = tooltip.querySelector('[data-slot="spinner"]')
    expect(spinner).toBeInTheDocument()
    // Should show the URL
    expect(tooltip).toHaveTextContent('https://example.com')
  })

  it('shows Globe icon when no favicon_url', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: { ...SAMPLE_METADATA, favicon_url: null },
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    // Should not have an img
    expect(tooltip.querySelector('img')).toBeNull()
    // Should have Globe SVG icon
    const svg = tooltip.querySelector('svg')
    expect(svg).toBeInTheDocument()
  })

  it('handles image load error (favicon fallback to Globe)', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    const img = tooltip.querySelector('img')
    expect(img).toBeInTheDocument()

    // Simulate image load error
    fireEvent.error(img as Element)

    // After error, should show Globe instead of img
    expect(tooltip.querySelector('img')).toBeNull()
    expect(tooltip.querySelector('svg')).toBeInTheDocument()
  })

  it('shows URL only when auth_required is true', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://private.example.com',
      metadata: {
        ...SAMPLE_METADATA,
        url: 'https://private.example.com',
        title: 'Private Page',
        auth_required: true,
      },
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    // Should show URL, not the title
    expect(tooltip).toHaveTextContent('https://private.example.com')
    // Should have Globe icon (no favicon for auth_required)
    expect(tooltip.querySelector('img')).toBeNull()
    expect(tooltip.querySelector('svg')).toBeInTheDocument()
    // auth_required must NOT trigger the not-found tag (those two
    // States are visually distinct).
    expect(screen.queryByTestId('link-preview-not-found-tag')).toBeNull()
  })

  // 404/410 must produce a visually distinct presentation
  // from auth_required (sign-in) and from transient 5xx. The tooltip
  // shows the same Globe icon + URL but appends a muted "(not found)"
  // tag so the user knows the page is terminally gone.
  it('renders distinct (not found) tag when metadata.not_found is true', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://gone.example.com',
      metadata: {
        ...SAMPLE_METADATA,
        url: 'https://gone.example.com',
        // Even if a title leaked through (e.g. cached from before the
        // M4 short-circuit), the not_found flag must take precedence
        // and the title must NOT be rendered.
        title: 'Stale Cached Title',
        favicon_url: 'https://gone.example.com/favicon.ico',
        not_found: true,
      },
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')

    // The "(not found)" tag is the distinguishing UX.
    const notFoundTag = screen.getByTestId('link-preview-not-found-tag')
    expect(notFoundTag).toBeInTheDocument()
    expect(notFoundTag).toHaveTextContent('(not found)')

    // URL is shown (in lieu of the title).
    expect(tooltip).toHaveTextContent('https://gone.example.com')
    // Stale cached title must NOT leak through.
    expect(tooltip).not.toHaveTextContent('Stale Cached Title')
    // Favicon must NOT be loaded for a 404'd page — Globe icon only.
    expect(tooltip.querySelector('img')).toBeNull()
    expect(tooltip.querySelector('svg')).toBeInTheDocument()
  })

  it('has role="tooltip" for accessibility', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)
    const tooltip = screen.getByTestId('link-preview-tooltip')
    expect(tooltip).toHaveAttribute('role', 'tooltip')
  })

  it('logs a warning and applies fallback position when computePosition rejects', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const computePositionErr = new Error('computePosition boom')
    vi.mocked(computePosition).mockRejectedValueOnce(computePositionErr)

    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })
    expect(warnSpy).toHaveBeenCalledWith(
      'LinkPreviewTooltip',
      'computePosition failed, using fallback',
      { anchorRect: SAMPLE_RECT },
      computePositionErr,
    )

    // Fallback position: directly below the link
    const tooltip = screen.getByTestId('link-preview-tooltip')
    await waitFor(() => {
      expect(tooltip.style.left).toBe(`${SAMPLE_RECT.left}px`)
      expect(tooltip.style.top).toBe(`${SAMPLE_RECT.bottom + 4}px`)
    })
    warnSpy.mockRestore()
  })

  // ── Keyboard / focus support ──────────────────────────────
  // The hook is mocked in this file, so these tests verify that the tooltip
  // renders the same presentational output regardless of whether the hook
  // state was triggered by hover (pointerenter) or focus (focusin). The
  // event-handling itself is exercised in src/hooks/__tests__/useLinkPreview.test.ts.

  it('renders the tooltip the same way when state was driven by focus rather than hover', () => {
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    render(<LinkPreviewTooltip container={makeContainer()} />)

    const tooltip = screen.getByTestId('link-preview-tooltip')
    expect(tooltip).toBeInTheDocument()
    expect(tooltip).toHaveAttribute('role', 'tooltip')
    expect(tooltip).toHaveTextContent('Example Site')
  })

  it('returns null after focus state has been cleared (focus then blur regression)', () => {
    // First render: focused
    mockUseLinkPreview.mockReturnValue({
      url: 'https://example.com',
      metadata: SAMPLE_METADATA,
      anchorRect: SAMPLE_RECT,
      isLoading: false,
    })

    const { rerender, container } = render(<LinkPreviewTooltip container={makeContainer()} />)
    expect(screen.getByTestId('link-preview-tooltip')).toBeInTheDocument()

    // Re-render after focusout / Escape clears the hook state
    mockUseLinkPreview.mockReturnValue({
      url: null,
      metadata: null,
      anchorRect: null,
      isLoading: false,
    })

    rerender(<LinkPreviewTooltip container={makeContainer()} />)

    expect(container.innerHTML).toBe('')
  })

  describe('a11y', () => {
    it('passes axe audit with metadata', async () => {
      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      const { container } = render(<LinkPreviewTooltip container={makeContainer()} />)
      expect(await axe(container)).toHaveNoViolations()
    })

    it('passes axe audit while loading', async () => {
      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: null,
        anchorRect: SAMPLE_RECT,
        isLoading: true,
      })

      const { container } = render(<LinkPreviewTooltip container={makeContainer()} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  describe('external-image policy gating (#2959)', () => {
    it('does not load the favicon <img> under the default click policy with no allowlisted host', () => {
      // No localStorage.setItem here — falls through to the real
      // (privacy-first) default: policy 'click', empty allowlist.
      localStorage.removeItem(EXTERNAL_IMAGE_POLICY_KEY)

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      render(<LinkPreviewTooltip container={makeContainer()} />)

      const tooltip = screen.getByTestId('link-preview-tooltip')
      // No uncontrolled request to the attacker-controlled favicon host.
      expect(tooltip.querySelector('img')).toBeNull()
      // Neutral placeholder — the same Globe fallback used for "no favicon".
      expect(tooltip.querySelector('svg')).toBeInTheDocument()
    })

    it('does not load the favicon <img> when policy is "never", even with a title present', () => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'never')

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      render(<LinkPreviewTooltip container={makeContainer()} />)

      const tooltip = screen.getByTestId('link-preview-tooltip')
      expect(tooltip.querySelector('img')).toBeNull()
      expect(tooltip.querySelector('svg')).toBeInTheDocument()
      expect(tooltip).toHaveTextContent('Example Site')
    })

    it('loads the favicon <img> under click policy once its exact host is allowlisted', () => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'click')
      localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['example.com']))

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      render(<LinkPreviewTooltip container={makeContainer()} />)

      const tooltip = screen.getByTestId('link-preview-tooltip')
      const img = tooltip.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img?.src).toBe('https://example.com/favicon.ico')
    })

    it('does not load the favicon <img> under click policy when a DIFFERENT host is allowlisted', () => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'click')
      localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, JSON.stringify(['trusted.example.com']))

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      render(<LinkPreviewTooltip container={makeContainer()} />)

      const tooltip = screen.getByTestId('link-preview-tooltip')
      expect(tooltip.querySelector('img')).toBeNull()
      expect(tooltip.querySelector('svg')).toBeInTheDocument()
    })

    it('loads the favicon <img> unconditionally when policy is "always"', () => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'always')

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      render(<LinkPreviewTooltip container={makeContainer()} />)

      const tooltip = screen.getByTestId('link-preview-tooltip')
      const img = tooltip.querySelector('img')
      expect(img).toBeInTheDocument()
      expect(img?.src).toBe('https://example.com/favicon.ico')
    })

    it('passes axe audit while the favicon is gated (placeholder path)', async () => {
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, 'never')

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: SAMPLE_RECT,
        isLoading: false,
      })

      const { container } = render(<LinkPreviewTooltip container={makeContainer()} />)
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  describe('async placement cancellation (#2275)', () => {
    it('ignores a stale computePosition resolution after the anchor changes', async () => {
      // Capture every computePosition resolver so we can settle them out of
      // order: the effect re-runs when anchorRect changes, leaving the first
      // (now-superseded) promise in flight.
      const resolvers: Array<(v: { x: number; y: number }) => void> = []
      vi.mocked(computePosition).mockImplementation(
        () => new Promise<{ x: number; y: number }>((r) => resolvers.push(r)) as never,
      )

      const rectA = new DOMRect(10, 10, 100, 20)
      const rectB = new DOMRect(400, 400, 100, 20)

      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: rectA,
        isLoading: false,
      })
      const { rerender } = render(<LinkPreviewTooltip container={makeContainer()} />)

      // Hover jumps to an adjacent link → anchorRect changes → the effect
      // re-runs (cancelling the first placement) and starts a second one.
      mockUseLinkPreview.mockReturnValue({
        url: 'https://example.com',
        metadata: SAMPLE_METADATA,
        anchorRect: rectB,
        isLoading: false,
      })
      rerender(<LinkPreviewTooltip container={makeContainer()} />)

      expect(resolvers.length).toBeGreaterThanOrEqual(2)

      // The CURRENT (last) placement settles first.
      await act(async () => {
        resolvers.at(-1)?.({ x: 200, y: 200 })
      })
      const tooltip = screen.getByTestId('link-preview-tooltip')
      await waitFor(() => expect(tooltip.style.left).toBe('200px'))

      // A STALE placement settles late — the cancellation guard must drop it
      // (without the guard this would clobber the position to 999px).
      await act(async () => {
        resolvers[0]?.({ x: 999, y: 999 })
      })
      expect(tooltip.style.left).toBe('200px')
      expect(tooltip.style.top).toBe('200px')
    })
  })
})
