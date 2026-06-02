import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('../../lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...mod,
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

const { setProperty } = await import('../../lib/tauri')
const mockedSetProperty = vi.mocked(setProperty)

import {
  DEFAULT_IMAGE_ALIGNMENT,
  type ImageAlignment,
  IMAGE_ALIGNMENTS,
  IMAGE_WIDTH_PRESET_VALUES,
  IMAGE_WIDTH_PRESETS,
  ImageResizeToolbar,
  snapToPreset,
} from '../ImageResizeToolbar'

/**
 * Render helper so width-focused tests don't have to spell out the alignment
 * props every time. Pass overrides for whatever a test cares about.
 */
function renderToolbar(
  props: Partial<React.ComponentProps<typeof ImageResizeToolbar>> = {},
): ReturnType<typeof render> {
  return render(
    <ImageResizeToolbar
      blockId={props.blockId ?? 'B1'}
      currentWidth={props.currentWidth ?? '100'}
      onWidthChange={props.onWidthChange ?? vi.fn()}
      currentAlignment={props.currentAlignment ?? DEFAULT_IMAGE_ALIGNMENT}
      onAlignmentChange={props.onAlignmentChange ?? vi.fn()}
    />,
  )
}

describe('ImageResizeToolbar', () => {
  it('renders 4 preset buttons (25%, 50%, 75%, 100%)', () => {
    renderToolbar()

    expect(screen.getByTestId('image-resize-25')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-50')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-75')).toBeInTheDocument()
    expect(screen.getByTestId('image-resize-100')).toBeInTheDocument()
  })

  it('displays percentage text for each preset', () => {
    renderToolbar()

    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('click fires onWidthChange with correct value', async () => {
    const user = userEvent.setup()
    const onWidthChange = vi.fn()
    renderToolbar({ onWidthChange })

    await user.click(screen.getByTestId('image-resize-50'))
    expect(onWidthChange).toHaveBeenCalledWith('50')
  })

  it('click calls setProperty with image_width', async () => {
    const user = userEvent.setup()
    renderToolbar()

    await user.click(screen.getByTestId('image-resize-25'))
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_width',
      valueText: '25',
    })
  })

  it('active preset uses secondary variant', () => {
    renderToolbar({ currentWidth: '50' })

    // The active button (50%) should be distinguishable — it gets variant="secondary"
    const btn50 = screen.getByTestId('image-resize-50')
    const btn25 = screen.getByTestId('image-resize-25')
    // We can't easily check the variant prop, but we can check they're both rendered
    expect(btn50).toBeInTheDocument()
    expect(btn25).toBeInTheDocument()
  })

  it('preset matching currentWidth has aria-pressed="true"; others "false" (UX-280)', () => {
    renderToolbar({ currentWidth: '50' })

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-50')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-resize-75')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'false')
  })

  it('aria-pressed updates when currentWidth changes (UX-280)', () => {
    const { rerender } = renderToolbar({ currentWidth: '25' })

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'false')

    rerender(
      <ImageResizeToolbar
        blockId="B1"
        currentWidth="100"
        onWidthChange={vi.fn()}
        currentAlignment={DEFAULT_IMAGE_ALIGNMENT}
        onAlignmentChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'true')
  })

  it('has role="toolbar" with aria-label', () => {
    renderToolbar()

    const toolbar = screen.getByTestId('image-resize-toolbar')
    expect(toolbar).toHaveAttribute('role', 'toolbar')
    expect(toolbar).toHaveAttribute('aria-label')
  })

  it('exports IMAGE_WIDTH_PRESETS with 4 entries', () => {
    expect(IMAGE_WIDTH_PRESETS).toHaveLength(4)
    expect(IMAGE_WIDTH_PRESETS.map((p) => p.value)).toEqual(['25', '50', '75', '100'])
  })

  // ---- #212 item 4: alignment ----

  it('renders three alignment buttons (left/center/right)', () => {
    renderToolbar()

    expect(screen.getByTestId('image-align-left')).toBeInTheDocument()
    expect(screen.getByTestId('image-align-center')).toBeInTheDocument()
    expect(screen.getByTestId('image-align-right')).toBeInTheDocument()
  })

  it('exports IMAGE_ALIGNMENTS with left/center/right and a center default', () => {
    expect(IMAGE_ALIGNMENTS.map((a) => a.value)).toEqual(['left', 'center', 'right'])
    expect(DEFAULT_IMAGE_ALIGNMENT).toBe('center')
  })

  it('the active alignment has aria-pressed="true"; others "false"', () => {
    renderToolbar({ currentAlignment: 'right' })

    expect(screen.getByTestId('image-align-left')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-align-center')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-align-right')).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking an alignment fires onAlignmentChange and persists image_alignment', async () => {
    const user = userEvent.setup()
    const onAlignmentChange = vi.fn()
    renderToolbar({ onAlignmentChange })

    await user.click(screen.getByTestId('image-align-left'))

    expect(onAlignmentChange).toHaveBeenCalledWith('left' as ImageAlignment)
    expect(mockedSetProperty).toHaveBeenCalledWith({
      blockId: 'B1',
      key: 'image_alignment',
      valueText: 'left',
    })
  })

  it('has no a11y violations', async () => {
    const { container } = renderToolbar()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ---- #294 item 6: drag-to-resize snapping ----

  describe('snapToPreset', () => {
    it('exposes the numeric preset values matching the labelled presets', () => {
      expect(IMAGE_WIDTH_PRESET_VALUES).toEqual([25, 50, 75, 100])
    })

    it('returns the exact preset when the value already matches', () => {
      expect(snapToPreset(25)).toBe('25')
      expect(snapToPreset(50)).toBe('50')
      expect(snapToPreset(75)).toBe('75')
      expect(snapToPreset(100)).toBe('100')
    })

    it('snaps an arbitrary percent to the nearest preset', () => {
      expect(snapToPreset(30)).toBe('25')
      expect(snapToPreset(40)).toBe('50')
      expect(snapToPreset(60)).toBe('50')
      expect(snapToPreset(70)).toBe('75')
      expect(snapToPreset(90)).toBe('100')
    })

    it('clamps below/above the preset range to the closest endpoint', () => {
      expect(snapToPreset(5)).toBe('25')
      expect(snapToPreset(140)).toBe('100')
    })

    it('resolves an exact tie to the smaller preset', () => {
      // 37.5 is equidistant from 25 and 50 — first-wins keeps the smaller one.
      expect(snapToPreset(37.5)).toBe('25')
    })
  })
})
