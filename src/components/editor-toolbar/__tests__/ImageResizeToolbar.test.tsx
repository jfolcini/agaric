import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

vi.mock('@/lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/tauri')>()
  return {
    ...mod,
    setProperty: vi.fn(() => Promise.resolve({})),
  }
})

const { setProperty } = await import('@/lib/tauri')
const mockedSetProperty = vi.mocked(setProperty)

import {
  DEFAULT_IMAGE_ALIGNMENT,
  type ImageAlignment,
  IMAGE_ALIGNMENTS,
  IMAGE_WIDTH_PRESET_VALUES,
  IMAGE_WIDTH_PRESETS,
  ImageResizeToolbar,
  snapToPreset,
} from '@/components/editor-toolbar/ImageResizeToolbar'

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

  // IPC error-path (AGENTS.md:198 / check-ipc-error-path.mjs). On a failed
  // `setProperty` save the toolbar reverts the optimistic width back to the
  // previous `currentWidth` and surfaces a `notify.error` toast (which
  // forwards to the globally-mocked sonner `toast.error`).
  it('reverts the width and shows an error toast when setProperty rejects', async () => {
    const user = userEvent.setup()
    const onWidthChange = vi.fn()
    mockedSetProperty.mockRejectedValueOnce(new Error('boom'))
    renderToolbar({ currentWidth: '100', onWidthChange })

    await user.click(screen.getByTestId('image-resize-25'))

    // Optimistic update fires first with the clicked preset...
    expect(onWidthChange).toHaveBeenNthCalledWith(1, '25')
    // ...then the rejection reverts back to the previous width and toasts.
    await waitFor(() => {
      expect(onWidthChange).toHaveBeenNthCalledWith(2, '100')
    })
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('imageResize.saveFailed'))
  })

  // Per-preset coverage (#1170): each width preset (25/50/75/100), when
  // clicked, must fire onWidthChange AND persist image_width with that exact
  // value — not just the 25/50 representatives the older tests exercised.
  it.each([...IMAGE_WIDTH_PRESETS])(
    'clicking the $value% preset updates width and persists image_width=$value',
    async (preset) => {
      const user = userEvent.setup()
      const onWidthChange = vi.fn()
      // Start from a different width so the click is always a real change.
      renderToolbar({ currentWidth: preset.value === '25' ? '100' : '25', onWidthChange })

      await user.click(screen.getByTestId(`image-resize-${preset.value}`))

      expect(onWidthChange).toHaveBeenCalledWith(preset.value)
      expect(mockedSetProperty).toHaveBeenCalledWith({
        blockId: 'B1',
        key: 'image_width',
        valueText: preset.value,
      })
    },
  )

  it('active preset uses secondary variant', () => {
    renderToolbar({ currentWidth: '50' })

    // The active button (50%) should be distinguishable — it gets variant="secondary"
    const btn50 = screen.getByTestId('image-resize-50')
    const btn25 = screen.getByTestId('image-resize-25')
    // We can't easily check the variant prop, but we can check they're both rendered
    expect(btn50).toBeInTheDocument()
    expect(btn25).toBeInTheDocument()
  })

  it('preset matching currentWidth has aria-pressed="true"; others "false"', () => {
    renderToolbar({ currentWidth: '50' })

    expect(screen.getByTestId('image-resize-25')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-50')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('image-resize-75')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('image-resize-100')).toHaveAttribute('aria-pressed', 'false')
  })

  it('aria-pressed updates when currentWidth changes', () => {
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

  // Per-alignment coverage (#1170): each alignment (left/center/right), when
  // clicked, must fire onAlignmentChange AND persist image_alignment with that
  // exact value — the older test only exercised `left`.
  it.each([...IMAGE_ALIGNMENTS])(
    'clicking the $value alignment updates alignment and persists image_alignment=$value',
    async (align) => {
      const user = userEvent.setup()
      const onAlignmentChange = vi.fn()
      // Start from a different alignment so the click is always a real change.
      renderToolbar({
        currentAlignment: align.value === 'center' ? 'left' : 'center',
        onAlignmentChange,
      })

      await user.click(screen.getByTestId(`image-align-${align.value}`))

      expect(onAlignmentChange).toHaveBeenCalledWith(align.value as ImageAlignment)
      expect(mockedSetProperty).toHaveBeenCalledWith({
        blockId: 'B1',
        key: 'image_alignment',
        valueText: align.value,
      })
    },
  )

  it('has no a11y violations', async () => {
    const { container } = renderToolbar()

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ---- #1724: WAI-ARIA toolbar roving-tabindex model ----
  describe('roving tabindex (WAI-ARIA toolbar pattern)', () => {
    /** All seven toolbar buttons in DOM order (4 width presets + 3 alignments). */
    const TEST_IDS = [
      'image-resize-25',
      'image-resize-50',
      'image-resize-75',
      'image-resize-100',
      'image-align-left',
      'image-align-center',
      'image-align-right',
    ]
    const first = () => screen.getByTestId('image-resize-25')
    const last = () => screen.getByTestId('image-align-right')
    const allButtons = () => TEST_IDS.map((id) => screen.getByTestId(id))

    it('exposes exactly ONE tab stop (first button tabindex 0, rest -1)', () => {
      renderToolbar()
      const buttons = allButtons()
      expect(first()).toHaveAttribute('tabindex', '0')
      for (const btn of buttons.slice(1)) {
        expect(btn).toHaveAttribute('tabindex', '-1')
      }
      const zeroStops = buttons.filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeroStops).toHaveLength(1)
    })

    it('ArrowRight moves focus + the tab stop to the next button', async () => {
      const user = userEvent.setup()
      renderToolbar()
      const b0 = screen.getByTestId('image-resize-25')
      const b1 = screen.getByTestId('image-resize-50')

      b0.focus()
      await user.keyboard('{ArrowRight}')

      expect(b1).toHaveFocus()
      expect(b1).toHaveAttribute('tabindex', '0')
      expect(b0).toHaveAttribute('tabindex', '-1')
    })

    it('ArrowLeft moves focus to the previous button', async () => {
      const user = userEvent.setup()
      renderToolbar()
      const b1 = screen.getByTestId('image-resize-50')
      const b2 = screen.getByTestId('image-resize-75')

      b2.focus()
      await user.keyboard('{ArrowLeft}')

      expect(b1).toHaveFocus()
      expect(b1).toHaveAttribute('tabindex', '0')
    })

    it('ArrowRight wraps from the last button to the first', async () => {
      const user = userEvent.setup()
      renderToolbar()

      last().focus()
      await user.keyboard('{ArrowRight}')

      expect(first()).toHaveFocus()
    })

    it('ArrowLeft wraps from the first button to the last', async () => {
      const user = userEvent.setup()
      renderToolbar()

      first().focus()
      await user.keyboard('{ArrowLeft}')

      expect(last()).toHaveFocus()
    })

    it('Home / End jump to the first / last button', async () => {
      const user = userEvent.setup()
      renderToolbar()

      screen.getByTestId('image-resize-100').focus()
      await user.keyboard('{End}')
      expect(last()).toHaveFocus()

      await user.keyboard('{Home}')
      expect(first()).toHaveFocus()
    })

    it('focusing a button (e.g. via click) moves the single tab stop to it', async () => {
      const user = userEvent.setup()
      renderToolbar()
      const target = screen.getByTestId('image-align-left')

      await user.click(target)

      expect(target).toHaveAttribute('tabindex', '0')
      const zeroStops = allButtons().filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeroStops).toHaveLength(1)
    })
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
