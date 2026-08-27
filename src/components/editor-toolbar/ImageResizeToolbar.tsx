import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import type React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

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
  // #4406 — destructure before use: reading `containerRef` off the hook
  // result during render (`roving.containerRef`) is a ref access as far as
  // `react(refs)` is concerned, and once `roving` is tainted every later read
  // of it is flagged too — which is why the handler props drew findings here
  // as well. Destructuring at the hook call is not an access. The rule is
  // property-aware, not a blanket ban on member expressions: a component that
  // reads only `roving.onKeyDown` draws no finding at all.
  //
  // Binding to local identifiers is the fix, and it is NOT inert: it
  // also un-bails the React Compiler, which then memoises this component
  // (#4469 — `react/refs` ports the compiler's own validation, so the
  // violation was keeping this function unoptimised). Verified by compiling
  // the file: the fixed form emits a `_c(...)` cache the pre-fix form did
  // not. Safe here because nothing the cache is keyed on can go
  // stale: the key set reduces to `blockId`, `currentWidth`,
  // `currentAlignment`, the two change callbacks and the i18n `t` — strings
  // and functions, with no object whose state mutates behind a stable
  // identity. Contrast SelectionBubbleMenu, where a TipTap `Editor` in the
  // key set froze the subtree and the identical edit had to be reverted.
  const { containerRef, onKeyDown: rovingOnKeyDown, onFocus: rovingOnFocus } = useRovingTabindex()

  const handleClick = useCallback(
    (value: string) => {
      onWidthChange(value)
      commands
        .setProperty(blockId, 'image_width', {
          value_text: value,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
        .then(unwrap)
        .catch((err) => {
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
      commands
        .setProperty(blockId, 'image_alignment', {
          value_text: value,
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        })
        .then(unwrap)
        .catch((err) => {
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
      ref={containerRef}
      onKeyDown={rovingOnKeyDown}
      onFocus={rovingOnFocus}
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
