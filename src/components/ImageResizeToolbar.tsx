import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { logger } from '../lib/logger'
import { setProperty } from '../lib/tauri'
import { Button } from './ui/button'

/** Width presets for image resize controls. */
export const IMAGE_WIDTH_PRESETS = [
  { label: 'imageResize.small', value: '25' },
  { label: 'imageResize.medium', value: '50' },
  { label: 'imageResize.large', value: '75' },
  { label: 'imageResize.full', value: '100' },
] as const

/** Floating toolbar for resizing images via width presets. */
export function ImageResizeToolbar({
  blockId,
  currentWidth,
  onWidthChange,
}: {
  blockId: string
  currentWidth: string
  onWidthChange: (width: string) => void
}): React.ReactElement {
  const { t } = useTranslation()

  const handleClick = useCallback(
    (value: string) => {
      onWidthChange(value)
      setProperty({
        blockId,
        key: 'image_width',
        valueText: value,
      }).catch((err) => {
        logger.warn('ImageResizeToolbar', 'property save failed', undefined, err)
        // Revert on failure — restore previous width
        onWidthChange(currentWidth)
      })
    },
    [blockId, currentWidth, onWidthChange],
  )

  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-10 flex items-center gap-1 rounded-full bg-popover border border-border shadow-md px-2 py-1"
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
          onClick={(e) => {
            e.stopPropagation()
            handleClick(preset.value)
          }}
          data-testid={`image-resize-${preset.value}`}
        >
          {`${preset.value}%`}
        </Button>
      ))}
    </div>
  )
}
