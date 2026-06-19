import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { setProperty } from '@/lib/tauri'

/** Width presets for image resize controls. */
export const IMAGE_WIDTH_PRESETS = [
  { label: 'imageResize.small', value: '25' },
  { label: 'imageResize.medium', value: '50' },
  { label: 'imageResize.large', value: '75' },
  { label: 'imageResize.full', value: '100' },
] as const

/** Numeric preset widths, the shared source of truth for resize snapping. */
export const IMAGE_WIDTH_PRESET_VALUES = IMAGE_WIDTH_PRESETS.map((p) => Number(p.value))

/**
 * Snap a free-form width percentage (e.g. from inline drag-to-resize, #294
 * item 6) to the nearest configured preset, returned as the same string form
 * stored in the `image_width` property. Ties resolve to the smaller preset.
 */
export function snapToPreset(pct: number): string {
  let best = IMAGE_WIDTH_PRESET_VALUES[0]
  let bestDist = Number.POSITIVE_INFINITY
  for (const preset of IMAGE_WIDTH_PRESET_VALUES) {
    const dist = Math.abs(preset - pct)
    if (dist < bestDist) {
      bestDist = dist
      best = preset
    }
  }
  return String(best)
}

/** Alignment options (#212 item 4). Default is `center`. */
export type ImageAlignment = 'left' | 'center' | 'right'

export const IMAGE_ALIGNMENTS = [
  { label: 'imageAlign.left', value: 'left', Icon: AlignLeft },
  { label: 'imageAlign.center', value: 'center', Icon: AlignCenter },
  { label: 'imageAlign.right', value: 'right', Icon: AlignRight },
] as const

/** Default image alignment when no `image_alignment` property is set. */
export const DEFAULT_IMAGE_ALIGNMENT: ImageAlignment = 'center'

/** Floating toolbar for resizing and aligning images via presets. */
export function ImageResizeToolbar({
  blockId,
  currentWidth,
  onWidthChange,
  currentAlignment,
  onAlignmentChange,
}: {
  blockId: string
  currentWidth: string
  onWidthChange: (width: string) => void
  currentAlignment: ImageAlignment
  onAlignmentChange: (alignment: ImageAlignment) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const roving = useRovingTabindex()

  const handleClick = useCallback(
    (value: string) => {
      onWidthChange(value)
      setProperty({
        blockId,
        key: 'image_width',
        valueText: value,
      }).catch((err) => {
        logger.warn('ImageResizeToolbar', 'property save failed', { blockId, value }, err)
        // Revert on failure — restore previous width
        onWidthChange(currentWidth)
        notify.error(t('imageResize.saveFailed'))
      })
    },
    [blockId, currentWidth, onWidthChange, t],
  )

  const handleAlign = useCallback(
    (value: ImageAlignment) => {
      onAlignmentChange(value)
      setProperty({
        blockId,
        key: 'image_alignment',
        valueText: value,
      }).catch((err) => {
        logger.warn('ImageResizeToolbar', 'alignment save failed', { blockId, value }, err)
        // Revert on failure — restore previous alignment
        onAlignmentChange(currentAlignment)
        notify.error(t('imageAlign.saveFailed'))
      })
    },
    [blockId, currentAlignment, onAlignmentChange, t],
  )

  return (
    <div
      tabIndex={-1}
      ref={roving.containerRef}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-10 flex items-center gap-1 rounded-full bg-popover border border-border shadow-(--shadow-floating) px-2 py-1"
      role="toolbar"
      aria-label={t('imageResize.toolbar')}
      data-testid="image-resize-toolbar"
    >
      {IMAGE_WIDTH_PRESETS.map((preset) => (
        <Button
          key={preset.value}
          variant={currentWidth === preset.value ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={t(preset.label)}
          aria-pressed={currentWidth === preset.value}
          onClick={(e) => {
            e.stopPropagation()
            handleClick(preset.value)
          }}
          data-testid={`image-resize-${preset.value}`}
        >
          {`${preset.value}%`}
        </Button>
      ))}

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />

      {IMAGE_ALIGNMENTS.map(({ label, value, Icon }) => (
        <Button
          key={value}
          variant={currentAlignment === value ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={t(label)}
          aria-pressed={currentAlignment === value}
          onClick={(e) => {
            e.stopPropagation()
            handleAlign(value)
          }}
          data-testid={`image-align-${value}`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </Button>
      ))}
    </div>
  )
}
