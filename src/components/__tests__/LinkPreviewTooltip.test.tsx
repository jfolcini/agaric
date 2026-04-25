/**
 * Tests for LinkPreviewTooltip component (UX-165).
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

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { LinkPreviewState } from '@/hooks/useLinkPreview'
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
import { LinkPreviewTooltip } from '../LinkPreviewTooltip'

// ── Helpers ──────────────────────────────────────────────────────────────

const SAMPLE_METADATA: LinkMetadata = {
  url: 'https://example.com',
  title: 'Example Site',
  favicon_url: 'https://example.com/favicon.ico',
  description: 'An example site',
  fetched_at: '2024-01-01T00:00:00Z',
  auth_required: false,
}

const SAMPLE_RECT = new DOMRect(50, 100, 150, 20)

function makeContainer(): HTMLDivElement {
  return document.createElement('div')
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('LinkPreviewTooltip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('logs a warning and applies fallback position when computePosition rejects (BUG-32)', async () => {
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

  // ── Keyboard / focus support (UX-273) ──────────────────────────────
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
})
